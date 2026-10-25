from __future__ import annotations

from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]


def read(*parts: str) -> str:
    return ROOT.joinpath(*parts).read_text(encoding="utf-8")


class DeploymentArtifactTests(unittest.TestCase):
    def test_compose_is_loopback_only_with_one_data_volume(self) -> None:
        compose = read("docker-compose.yml")
        self.assertIn("container_name: ppvio", compose)
        self.assertIn('"127.0.0.1:${PPVIO_PORT:-8790}:8790"', compose)
        volume_targets = [line.strip() for line in compose.splitlines() if line.strip().startswith("target:")]
        self.assertEqual(volume_targets, ["target: /var/lib/ppvio"])
        environment = compose.split("    environment:\n", 1)[1].split("    extra_hosts:", 1)[0]
        environment_keys = [
            line.strip().split(":", 1)[0] for line in environment.splitlines()
            if line.strip() and not line.strip().startswith("#")
        ]
        self.assertTrue(environment_keys)
        self.assertTrue(all(key.startswith("PPVIO_") for key in environment_keys), environment_keys)

    def test_dockerfile_copies_only_the_server_and_the_front_end(self) -> None:
        copy_lines = [line.strip() for line in read("Dockerfile").splitlines() if line.startswith("COPY ")]
        self.assertEqual(
            copy_lines,
            [
                "COPY web/package.json web/package-lock.json ./",
                "COPY web/index.html web/tsconfig.json web/vite.config.ts ./",
                "COPY web/public ./public",
                "COPY web/src ./src",
                "COPY requirements.lock ./requirements.lock",
                "COPY src/ppvio ./src/ppvio",
                "COPY --from=web-build --chown=65532:65532 /web/dist ./web-dist",
            ],
        )

    def test_image_records_its_front_end_as_the_same_commit(self) -> None:
        dockerfile, build = read("Dockerfile"), read("scripts", "build.sh")
        self.assertIn("io.ppvio.web.revision=${PPVIO_WEB_COMMIT}", dockerfile)
        self.assertIn("web_commit=$commit", build, "the front end is web/ of this commit")
        self.assertIn('--build-arg "PPVIO_WEB_COMMIT=$web_commit"', build)

    def test_lock_has_no_telegram_dependencies(self) -> None:
        lock = read("requirements.lock")
        self.assertIn("aiohttp==", lock)
        for forbidden in ("telethon==", "cryptg==", "yt-dlp=="):
            self.assertNotIn(forbidden, lock)

    def test_scripts_are_shell_valid_and_switch_only_ppvio(self) -> None:
        for name in ("build.sh", "deploy.sh", "rollback.sh", "remote_release.sh", "check.sh"):
            subprocess.run(["bash", "-n", str(ROOT / "scripts" / name)], check=True)
        for name in ("deploy.sh", "rollback.sh"):
            script = read("scripts", name)
            self.assertIn("--no-deps ppvio", script)
            # Another service on the host (the TGVIO bot) must be left exactly as it was.
            self.assertIn('[[ "$(neighbour)" == "$bot_before" ]]', script)

    def test_scripts_only_reference_files_that_exist(self) -> None:
        import re

        for script in sorted((ROOT / "scripts").glob("*.sh")):
            text = script.read_text(encoding="utf-8")
            for name in set(re.findall(r'\$repo_root/([A-Za-z0-9_./-]+\.(?:yml|sh|py|lock))', text)):
                self.assertTrue((ROOT / name).is_file(), f"{script.name} refers to missing {name}")
            for name in set(re.findall(r'source/(scripts/[A-Za-z0-9_.-]+\.sh)', text)):
                self.assertTrue((ROOT / name).is_file(), f"{script.name} refers to missing {name}")

    def test_remote_release_keeps_a_rollback_point_and_rolls_back_when_unhealthy(self) -> None:
        remote = read("scripts", "remote_release.sh")
        self.assertIn("scripts/deploy.sh", remote)
        for marker in ("player-image.id", "ppvio.env", "player.sqlite3.before", ".backup(copy)"):
            self.assertIn(marker, remote)
        self.assertLess(remote.index("rollback-point"), remote.index("stage=switch"))
        self.assertIn("scripts/rollback.sh", remote)
        self.assertLess(remote.index("stage=health"), remote.index('mv -f "$ENV_FILE.next" "$ENV_FILE"'))
        self.assertIn("flock -n 9", remote)
        self.assertIn('"io.ppvio.web.revision"', remote)

    def test_remote_release_rejects_malformed_arguments(self) -> None:
        script = ROOT / "scripts" / "remote_release.sh"
        good = ["ppvio-abcdef0-20261008T000000Z", "a" * 40, "b" * 40, "c" * 64, "d" * 64]
        for index, bad in ((0, "../escape"), (1, "main"), (2, "latest"), (3, "x"), (4, "y")):
            arguments = list(good)
            arguments[index] = bad
            result = subprocess.run(["bash", str(script), *arguments], capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0, bad)
            self.assertIn("ppvio_release_failed", result.stderr)

    def test_release_entry_checks_both_provenance_labels(self) -> None:
        entry = read("scripts", "release.py")
        self.assertIn('"org.opencontainers.image.revision"', entry)
        self.assertIn('"io.ppvio.web.revision"', entry)
        self.assertIn("verify_remote=True", entry)

    def test_cache_template_is_a_fixed_budget(self) -> None:
        template = read("deploy", "ppvio.env.example")
        self.assertIn("PPVIO_CACHE_BYTES=4294967296", template)
        self.assertIn("PPVIO_WARM_HEAD_MB=4", template)

    def test_direct_reads_reach_openlist_through_the_host_gateway(self) -> None:
        compose = read("docker-compose.yml")
        self.assertIn('"host.docker.internal:host-gateway"', compose)
        self.assertIn("PPVIO_OPENLIST_API_URL: ${PPVIO_OPENLIST_API_URL:-}", compose)
        self.assertIn("PPVIO_OPENLIST_API_URL=\n", read("deploy", "ppvio.env.example"))

    def test_env_template_has_no_storage_or_telegram_credentials(self) -> None:
        template = read("deploy", "ppvio.env.example")
        self.assertIn("PPVIO_ACCESS_SECRET=", template)
        self.assertIn("PPVIO_RECOVERY_KEY=", template)
        for moved in ("PPVIO_WEBDAV_URL=", "PPVIO_WEBDAV_USER=", "PPVIO_WEBDAV_PASSWORD=", "PPVIO_REMOTE_ROOT="):
            self.assertNotIn(moved, template, "WebDAV is configured in the web page")
        for forbidden in ("BOT_TOKEN=", "API_HASH=", "API_ID="):
            self.assertNotIn(forbidden, template)

    def test_compose_renders_with_an_isolated_environment(self) -> None:
        if shutil.which("docker") is None:
            self.skipTest("docker is not installed")
        values = {
            "PPVIO_IMAGE": "ppvio:test",
            "PPVIO_ENABLED": "true",
            "PPVIO_PORT": "8790",
            "PPVIO_HOST_DATA_DIR": "/tmp/ppvio-test-data",
            "PPVIO_ACCESS_SECRET": "test-only-access-secret",
            "PPVIO_RECOVERY_KEY": "r" * 43,
        }
        with tempfile.NamedTemporaryFile("w", encoding="utf-8") as handle:
            handle.write("".join(f"{key}={value}\n" for key, value in values.items()))
            handle.flush()
            subprocess.run(
                ["docker", "compose", "--env-file", handle.name, "-f", str(ROOT / "docker-compose.yml"),
                 "--profile", "ppvio", "config", "--quiet"],
                cwd=ROOT, check=True,
            )


if __name__ == "__main__":
    unittest.main()
