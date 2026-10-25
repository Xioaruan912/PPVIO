#!/usr/bin/env python3
"""Release PPVIO to HostDZire from the pushed main commit.

The image is built locally by build.sh (front end from web/ of the same commit),
its labels are checked, then the image and the release source travel to the host
with SHA-256 checks on both ends; scripts/remote_release.sh switches there, keeps
a rollback point and rolls back by itself when the new container is not healthy.

usage: python3 scripts/release.py [--key PATH]
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import os
from pathlib import Path
import shlex
import stat
import subprocess
import sys
import tempfile

from guard import GuardError, check_architecture, sha256_file, verify_repository, verify_tree

HOST = "199.47.242.40"
PORT = 22
USER = "root"
HOST_ALIAS = "HostDZire"
EXPECTED_HOST_FINGERPRINT = "SHA256:4jVPtdkmcLxiNRxkpunrZNxiN3WWr4o4gZg7RsnoyAE"
DEFAULT_KEY = Path("/root/.ssh/tgvio_hostdzire_ed25519")
PPVIO_ROOT = "/root/ppvio"


class ReleaseError(RuntimeError):
    pass


def _ssh_options(repo: Path, key: Path) -> list[str]:
    known_hosts = repo / "deploy" / "hostdzire_known_hosts"
    return [
        "-i", str(key),
        "-o", "IdentitiesOnly=yes",
        "-o", "BatchMode=yes",
        "-o", "StrictHostKeyChecking=yes",
        "-o", f"UserKnownHostsFile={known_hosts}",
        "-o", f"HostKeyAlias={HOST_ALIAS}",
    ]


def _verify_ssh_material(repo: Path, key: Path) -> None:
    known_hosts = repo / "deploy" / "hostdzire_known_hosts"
    if not key.is_file() or key.is_symlink():
        raise ReleaseError(f"dedicated deployment key is missing: {key}")
    if stat.S_IMODE(key.stat().st_mode) & 0o077:
        raise ReleaseError("dedicated deployment key permissions are too broad")
    lines = [
        line.strip() for line in known_hosts.read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    ]
    if len(lines) != 1 or not lines[0].startswith(f"{HOST_ALIAS} ssh-ed25519 "):
        raise ReleaseError("HostDZire known_hosts must contain exactly one ED25519 key")
    fingerprint = subprocess.run(
        ["ssh-keygen", "-lf", str(known_hosts)], check=True, capture_output=True, text=True,
    ).stdout
    if EXPECTED_HOST_FINGERPRINT not in fingerprint:
        raise ReleaseError("HostDZire host-key fingerprint is not the audited fingerprint")


def _label(image: str, name: str) -> str:
    return subprocess.run(
        ["docker", "image", "inspect", "--format", f'{{{{index .Config.Labels "{name}"}}}}', image],
        check=True, capture_output=True, text=True,
    ).stdout.strip()


def release(repo: Path, key: Path) -> str:
    _verify_ssh_material(repo, key)
    verify_tree(repo)
    check_architecture(repo)
    facts = verify_repository(repo, require_clean=True, require_pushed=True, verify_remote=True)
    if facts["branch"] != "main" or facts["upstream"] != "origin/main":
        raise ReleaseError("a release must come from local main tracking origin/main")
    head = str(facts["head"])

    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    release_id = f"ppvio-{head[:7]}-{timestamp}"
    tag = f"ppvio:{release_id}"
    subprocess.run(
        ["bash", str(repo / "scripts" / "build.sh"), "--tag", tag, "--commit", head, "--release-id", release_id],
        cwd=repo, check=True,
    )
    if _label(tag, "org.opencontainers.image.revision") != head:
        raise ReleaseError("candidate image revision label does not match HEAD")
    if _label(tag, "io.ppvio.web.revision") != head:
        raise ReleaseError("candidate image front-end label does not match HEAD")

    options = _ssh_options(repo, key)
    ssh = ["ssh", *options, "-p", str(PORT), f"{USER}@{HOST}"]
    scp = ["scp", *options, "-P", str(PORT)]
    remote_dir = f"{PPVIO_ROOT}/releases/{release_id}"
    with tempfile.TemporaryDirectory(prefix="ppvio-release-") as temporary:
        folder = Path(temporary)
        image_archive = folder / "ppvio-image.tar.gz"
        with image_archive.open("wb") as output:
            save = subprocess.Popen(["docker", "save", tag], stdout=subprocess.PIPE)
            assert save.stdout is not None
            subprocess.run(["gzip", "-c"], stdin=save.stdout, stdout=output, check=True)
            save.stdout.close()
            if save.wait() != 0:
                raise ReleaseError("docker save failed")
        source_archive = folder / "source.tar.gz"
        subprocess.run(["git", "archive", "--format=tar.gz", f"--output={source_archive}", head], cwd=repo, check=True)
        image_sha, source_sha = sha256_file(image_archive), sha256_file(source_archive)

        quoted = shlex.quote(remote_dir)
        subprocess.run([*ssh, f"set -eu; umask 077; test ! -e {quoted}; mkdir -p {quoted}/incoming"], check=True)
        subprocess.run([*scp, str(image_archive), str(source_archive), f"{USER}@{HOST}:{remote_dir}/incoming/"], check=True)

    # The switch script comes from the uploaded source itself, so it is exactly the
    # reviewed commit: extract it after checking the archive hash, then run it.
    extract = (
        f"set -eu; umask 077; d={shlex.quote(remote_dir)}; "
        f'test "$(sha256sum "$d/incoming/source.tar.gz" | cut -d" " -f1)" = {shlex.quote(source_sha)}; '
        'mkdir -p "$d/bootstrap"; tar -xzf "$d/incoming/source.tar.gz" -C "$d/bootstrap" scripts/remote_release.sh'
    )
    subprocess.run([*ssh, extract], check=True)
    remote = " ".join(shlex.quote(value) for value in [
        "bash", f"{remote_dir}/bootstrap/scripts/remote_release.sh", release_id, head, head, image_sha, source_sha,
    ])
    subprocess.run([*ssh, remote], check=True)
    return release_id


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--key", type=Path, default=Path(os.getenv("PPVIO_DEPLOY_KEY", DEFAULT_KEY)))
    args = parser.parse_args()
    repo = Path(__file__).resolve().parent.parent
    try:
        print(f"ppvio_release_complete={release(repo, args.key.expanduser().resolve())}", flush=True)
    except (ReleaseError, GuardError, OSError, subprocess.CalledProcessError) as exc:
        print(f"ppvio_release_failed: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
