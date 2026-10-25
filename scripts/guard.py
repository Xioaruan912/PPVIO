#!/usr/bin/env python3
"""Fail-closed source, Git and architecture gates for PPVIO releases."""

from __future__ import annotations

import ast
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
import sys


SOURCE_MANIFEST_ALGORITHM = (
    "find src -type f -name '*.py' -print0 | LC_ALL=C sort -z | "
    "xargs -0 sha256sum | sha256sum | cut -d' ' -f1"
)

_SKIP_DIRS = {".git", ".venv", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", "node_modules"}
_RUNTIME_ROOTS = {"data"}
_PRIVATE_KEY_NAMES = {
    "id_dsa",
    "id_ecdsa",
    "id_ed25519",
    "id_rsa",
}
_SECRET_PATTERNS: tuple[tuple[str, re.Pattern[bytes]], ...] = (
    (
        "private-key-material",
        re.compile(br"-----BEGIN (?:OPENSSH |RSA |EC |DSA )?PRIVATE KEY-----"),
    ),
    ("github-token", re.compile(br"\bgh[pousr]_[A-Za-z0-9]{20,}\b")),
    (
        "telegram-bot-token",
        re.compile(br"(?<![A-Za-z0-9])\d{7,12}:[A-Za-z0-9_-]{30,}(?![A-Za-z0-9])"),
    ),
    (
        "bearer-credential",
        re.compile(br"(?i)\bBearer[ \t]+[A-Za-z0-9._~-]{20,}"),
    ),
)
_MAX_SECRET_SCAN_BYTES = 5 * 1024 * 1024


MAX_SOURCE_FILE_LINES = 1000


class GuardError(RuntimeError):
    pass


def _run(
    args: list[str],
    *,
    cwd: Path | None = None,
    env: dict[str, str] | None = None,
    text: bool = True,
) -> subprocess.CompletedProcess[str] | subprocess.CompletedProcess[bytes]:
    return subprocess.run(
        args,
        cwd=cwd,
        env=env,
        check=True,
        capture_output=True,
        text=text,
    )


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _forbidden_path_reason(relative: PurePosixPath) -> str | None:
    if relative.is_absolute() or not relative.parts:
        return "absolute-or-empty-path"
    if any(part in {"", ".", ".."} for part in relative.parts):
        return "unsafe-path-component"
    if relative.parts[0] in _RUNTIME_ROOTS:
        return "runtime-volume"
    name = relative.name
    lower = name.lower()
    if lower == ".env" or (lower.startswith(".env.") and lower != ".env.example"):
        return "environment-secret-file"
    if lower in {".release.env", ".netrc"}:
        return "credential-or-release-environment"
    if lower in _PRIVATE_KEY_NAMES:
        return "private-key-path"
    if lower.endswith((".pem", ".key", ".p12", ".pfx", ".session", ".session-journal")):
        return "credential-or-session-path"
    if lower.endswith((".sqlite", ".sqlite3", ".sqlite3-shm", ".sqlite3-wal")):
        return "runtime-database"
    return None


def _secret_findings(data: bytes) -> list[str]:
    if len(data) > _MAX_SECRET_SCAN_BYTES or b"\x00" in data:
        return []
    return [name for name, pattern in _SECRET_PATTERNS if pattern.search(data)]


def verify_tree(root: Path) -> dict[str, object]:
    root = root.resolve()
    if not root.is_dir():
        raise GuardError(f"source root is not a directory: {root}")
    files = 0
    scanned = 0
    problems: list[str] = []
    stack = [root]
    while stack:
        directory = stack.pop()
        for entry in os.scandir(directory):
            path = Path(entry.path)
            relative = PurePosixPath(path.relative_to(root).as_posix())
            if relative.parts and relative.parts[0] in _SKIP_DIRS:
                continue
            reason = _forbidden_path_reason(relative)
            if reason:
                problems.append(f"{relative}: {reason}")
                continue
            mode = entry.stat(follow_symlinks=False).st_mode
            if stat.S_ISLNK(mode):
                problems.append(f"{relative}: symbolic-link")
            elif stat.S_ISDIR(mode):
                if entry.name not in _SKIP_DIRS:
                    stack.append(path)
            elif stat.S_ISREG(mode):
                files += 1
                if entry.stat(follow_symlinks=False).st_size <= _MAX_SECRET_SCAN_BYTES:
                    findings = _secret_findings(path.read_bytes())
                    scanned += 1
                    for finding in findings:
                        problems.append(f"{relative}: {finding}")
            else:
                problems.append(f"{relative}: non-regular-file")
    if problems:
        raise GuardError("source tree rejected:\n" + "\n".join(sorted(problems)))
    return {"status": "passed", "files": files, "secret_scanned_files": scanned}


def check_architecture(root: Path) -> dict[str, object]:
    root = root.resolve()
    package_roots = {"ppvio": root / "src" / "ppvio"}
    if not package_roots["ppvio"].is_dir():
        raise GuardError(f"missing package root: {package_roots['ppvio']}")

    problems: list[str] = []
    checked = 0
    for package_name, source in package_roots.items():
        if not source.is_dir():
            continue
        for path in sorted(source.rglob("*.py")):
            relative = path.relative_to(root).as_posix()
            module_parts = path.relative_to(source).parts
            layer = module_parts[0] if len(module_parts) > 1 else "root"
            source_text = path.read_text(encoding="utf-8")
            line_count = source_text.count("\n") + 1
            if line_count > MAX_SOURCE_FILE_LINES:
                problems.append(
                    f"{relative}: {line_count} lines exceeds the "
                    f"{MAX_SOURCE_FILE_LINES}-line source budget"
                )
            tree = ast.parse(source_text, filename=relative)
            imports: list[str] = []
            for node in ast.walk(tree):
                if isinstance(node, ast.Import):
                    imports.extend(alias.name for alias in node.names)
                elif isinstance(node, ast.ImportFrom) and node.module:
                    imports.append(node.module)

            for imported in imports:
                if imported == "tgvio" or imported.startswith(("tgvio.", "tgvio_player")):
                    problems.append(
                        f"{relative}: PPVIO must not depend on the TGVIO bot ({imported})"
                    )
                    continue

                prefix = package_name + "."
                if not imported.startswith(prefix):
                    continue
                imported_layer = imported.split(".", 2)[1]
                if imported == f"{package_name}.main" and path.name != "main.py":
                    problems.append(f"{relative}: imports composition root")
                if layer == "domain" and imported_layer != "domain":
                    problems.append(f"{relative}: domain imports {imported}")
                elif layer == "application" and imported_layer not in {
                    "application",
                    "domain",
                    "observability",
                }:
                    problems.append(f"{relative}: application imports {imported}")
                elif layer == "infrastructure":
                    allowed = {"infrastructure", "domain", "observability"}
                    if package_name == "ppvio":
                        allowed.add("application")
                    if imported_layer not in allowed:
                        problems.append(f"{relative}: infrastructure imports {imported}")
                elif package_name == "ppvio" and layer == "testing":
                    if imported_layer not in {
                        "testing",
                        "application",
                        "domain",
                        "infrastructure",
                    }:
                        problems.append(f"{relative}: testing imports {imported}")
            checked += 1
    if problems:
        raise GuardError("architecture boundary rejected:\n" + "\n".join(problems))
    return {
        "status": "passed",
        "python_files": checked,
        "max_source_file_lines": MAX_SOURCE_FILE_LINES,
    }


def verify_repository(
    root: Path,
    *,
    require_clean: bool,
    require_pushed: bool,
    verify_remote: bool,
) -> dict[str, object]:
    root = root.resolve()
    head = str(_run(["git", "rev-parse", "HEAD"], cwd=root).stdout).strip()
    branch = str(_run(["git", "branch", "--show-current"], cwd=root).stdout).strip()
    if not re.fullmatch(r"[0-9a-f]{40}", head):
        raise GuardError("HEAD did not resolve to a full Git commit")
    if require_clean:
        dirty = str(
            _run(
                ["git", "status", "--porcelain", "--untracked-files=all"],
                cwd=root,
            ).stdout
        ).strip()
        if dirty:
            raise GuardError("working tree is dirty")
    upstream = ""
    upstream_commit = ""
    if require_pushed or verify_remote:
        upstream = str(
            _run(["git", "rev-parse", "--abbrev-ref", "@{upstream}"], cwd=root).stdout
        ).strip()
        upstream_commit = str(_run(["git", "rev-parse", "@{upstream}"], cwd=root).stdout).strip()
        if require_pushed and head != upstream_commit:
            raise GuardError(f"HEAD is not the pushed upstream commit ({upstream})")
    remote_commit = ""
    if verify_remote:
        if not upstream.startswith("origin/"):
            raise GuardError("release upstream must be origin/<branch>")
        remote_ref = "refs/heads/" + upstream.split("/", 1)[1]
        env = dict(os.environ)
        env["GIT_TERMINAL_PROMPT"] = "0"
        output = str(_run(["git", "ls-remote", "origin", remote_ref], cwd=root, env=env).stdout).strip()
        fields = output.split()
        if len(fields) != 2 or fields[1] != remote_ref:
            raise GuardError(f"unable to verify remote ref {remote_ref}")
        remote_commit = fields[0]
        if remote_commit != head:
            raise GuardError("HEAD is not the current remote commit")
    return {
        "status": "passed",
        "head": head,
        "branch": branch,
        "upstream": upstream,
        "upstream_commit": upstream_commit,
        "remote_commit": remote_commit,
    }


def main() -> int:
    root = Path(__file__).resolve().parent.parent
    try:
        report = {"tree": verify_tree(root), "architecture": check_architecture(root)}
    except GuardError as exc:
        print(exc, file=sys.stderr)
        return 1
    print(json.dumps(report, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
