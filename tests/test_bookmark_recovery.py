from __future__ import annotations

import asyncio
from dataclasses import asdict, replace
import unittest
from unittest.mock import patch

from aiohttp.test_utils import TestClient, TestServer
from ppvio.adapters.http import PlayerHttpServer
from ppvio.application.auth import SessionService
from ppvio.application.feed import ShuffleDeckService
from test_bookmarks import DummyReader

from ppvio.application.player_recovery import (
    CONFIG_CONTEXT, EncryptedManifestStore, PlayerRecoveryService, RecoveryError, WebDavBootstrap,
)
from ppvio.domain.bookmarks import InvalidBookmark, PlayerBookmark
from ppvio.domain.catalog import CatalogLocation, CatalogMedia, CatalogPackage
from ppvio.infrastructure.sqlite import PlayerCatalogRepositorySQLite
import test_recovery


class BookmarkRecoveryTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = test_recovery.PlayerRecoveryTests.asyncSetUp
    asyncTearDown = test_recovery.PlayerRecoveryTests.asyncTearDown

    async def restore_into(self, repository):
        return await PlayerRecoveryService(repository, self.cipher, self.factory).restore(
            WebDavBootstrap(self.settings.endpoint_url, "player", "alice", "old-password"))

    async def rewritten_manifest(self, update):
        remote = self.factory.clients[self.settings.endpoint_url]
        config_store = EncryptedManifestStore(remote, self.cipher, "player", context=CONFIG_CONTEXT, name="player-config")
        config = await config_store.load()
        config["revision"] += 1
        await config_store.save_atomic(config)
        manifest = await EncryptedManifestStore(remote, self.cipher, "player").load()
        manifest["revision"] = config["revision"]
        update(manifest)
        await EncryptedManifestStore(remote, self.cipher, "player", schema_version=manifest["schema_version"]).save_atomic(manifest)

    async def test_background_snapshot_retries_after_restart_without_blocking_local_bookmarks(self) -> None:
        remote = self.factory.clients[self.settings.endpoint_url]
        remote.fail_put = True
        def client_for(service):
            return TestClient(TestServer(PlayerHttpServer(
                self.repo, SessionService(self.repo, access_secret="s" * 32),
                ShuffleDeckService(self.repo), DummyReader(), large_video_seconds=300,
                recovery_service=service,
            ).application()))
        first = client_for(self.service)
        await first.start_server()
        try:
            response = await first.post("/api/v1/auth/login", json={"secret": "s" * 32})
            cookies = {"ppvio_session": response.cookies["ppvio_session"].value}
            added = await asyncio.wait_for(first.post(f"/api/v1/media/{self.pending_id}/bookmarks",
                cookies=cookies, json={"position_seconds": 4.5}), timeout=0.5)
            self.assertEqual(added.status, 201)
            saved = await added.json()
            await asyncio.sleep(0.02)
            self.assertEqual(len(await self.repo.export_bookmarks()), 1)
        finally:
            await first.close()
        # The worker must discover the outstanding write without another request.
        await self.repo.close()
        await self.repo.open()
        remote.fail_put = False
        restarted_service = PlayerRecoveryService(self.repo, self.cipher, self.factory)
        second = client_for(restarted_service)
        await second.start_server()
        try:
            manifest = None
            for _ in range(100):
                manifest = await EncryptedManifestStore(remote, self.cipher, "player").load()
                if manifest is not None:
                    break
                await asyncio.sleep(0.005)
            self.assertIsNotNone(manifest, "an unsaved bookmark is exported after restart")
            self.assertEqual(manifest["bookmarks"], [saved])
            self.assertIsNone(await self.repo.pending_bookmark_snapshot_revision())
            # Deletion is another state change and must reach the same background exporter.
            response = await second.post("/api/v1/auth/login", json={"secret": "s" * 32})
            cookies = {"ppvio_session": response.cookies["ppvio_session"].value}
            removed = await second.delete(f"/api/v1/media/{self.pending_id}/bookmarks/{saved['id']}", cookies=cookies)
            self.assertEqual(removed.status, 200)
            for _ in range(100):
                manifest = await EncryptedManifestStore(remote, self.cipher, "player").load()
                if manifest["bookmarks"] == []:
                    break
                await asyncio.sleep(0.005)
            self.assertEqual(manifest["bookmarks"], [])
        finally:
            await second.close()

    async def test_failed_background_export_retries_without_another_user_action(self) -> None:
        remote = self.factory.clients[self.settings.endpoint_url]
        remote.fail_put = True
        await self.repo.add_bookmark(self.pending_id, 1)
        with patch("ppvio.application.player_recovery._BOOKMARK_SNAPSHOT_RETRY_SECONDS", 0.01):
            task = asyncio.create_task(self.service.run_bookmark_snapshots(asyncio.Event()))
            try:
                await asyncio.sleep(0.025)
                self.assertIsNotNone(await self.repo.pending_bookmark_snapshot_revision())
                remote.fail_put = False
                for _ in range(100):
                    if await self.repo.pending_bookmark_snapshot_revision() is None:
                        break
                    await asyncio.sleep(0.005)
                self.assertIsNone(await self.repo.pending_bookmark_snapshot_revision())
                manifest = await EncryptedManifestStore(remote, self.cipher, "player").load()
                self.assertEqual(len(manifest["bookmarks"]), 1)
            finally:
                task.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await task

    async def test_storage_put_during_bookmark_export_preserves_new_folder_and_remote_snapshot(self) -> None:
        await self._assert_storage_put_during_export(self.settings.endpoint_url)

    async def test_storage_put_during_bookmark_export_uses_new_destination(self) -> None:
        await self._assert_storage_put_during_export("https://new-settings-destination.example.test")

    async def _assert_storage_put_during_export(self, endpoint_url: str) -> None:
        remote = self.factory.clients[self.settings.endpoint_url]
        original_put = remote.put_stream
        started, resume, checked = asyncio.Event(), asyncio.Event(), asyncio.Event()
        async def delayed_put(path, chunks, **kwargs):
            if path == "player/player-config.2.enc":
                started.set()
                await resume.wait()
            return await original_put(path, chunks, **kwargs)
        async def check_archive(settings):
            checked.set()
        remote.put_stream = delayed_put
        await self.repo.add_bookmark(self.pending_id, 1)
        client = TestClient(TestServer(PlayerHttpServer(
            self.repo, SessionService(self.repo, access_secret="s" * 32),
            ShuffleDeckService(self.repo), DummyReader(), large_video_seconds=300,
            recovery_service=self.service, storage_client_factory=self.factory,
            archive_check=check_archive,
        ).application()))
        await client.start_server()
        request = None
        try:
            await asyncio.wait_for(started.wait(), 1)
            response = await client.post("/api/v1/auth/login", json={"secret": "s" * 32})
            cookies = {"ppvio_session": response.cookies["ppvio_session"].value}
            request = asyncio.create_task(client.put("/api/v1/settings/storage", cookies=cookies,
                json={"endpoint_url": endpoint_url, "archive_root": "new-video-folder", "player_root": "player", "favorites_dir": "Favorites"}))
            await asyncio.wait_for(checked.wait(), 1)
            resume.set()
            response = await asyncio.wait_for(request, 2)
            self.assertEqual(response.status, 200)
            self.assertEqual((await response.json())["archive_root"], "new-video-folder")
            stored = await self.repo.get_storage_settings()
            self.assertEqual(stored.archive_root, "new-video-folder")
            self.assertEqual(stored.endpoint_url, endpoint_url)
            self.assertEqual(await self.repo.get_libraries(), ("new-video-folder",))
            destination = self.factory.clients[endpoint_url]
            config = await EncryptedManifestStore(destination, self.cipher, "player", context=CONFIG_CONTEXT, name="player-config").load()
            self.assertEqual(config["archive_root"], "new-video-folder")
            self.assertEqual(config["revision"], stored.revision)
            self.assertIsNone(await self.repo.pending_bookmark_snapshot_revision())
        finally:
            resume.set()
            if request is not None and not request.done():
                await request
            await client.close()

    async def test_settings_save_keeps_local_changes_and_dirty_bookmarks_when_remote_export_fails(self) -> None:
        await self.repo.add_bookmark(self.pending_id, 1)
        remote = self.factory.clients[self.settings.endpoint_url]
        remote.fail_put = True
        saved = await self.service.save_settings(
            replace(self.settings, archive_root="changed-folder"), libraries=("changed-folder",),
        )
        self.assertEqual(saved.archive_root, "changed-folder")
        self.assertEqual(await self.repo.get_storage_settings(), saved)
        self.assertEqual(await self.repo.get_libraries(), ("changed-folder",))
        self.assertIsNotNone(await self.repo.pending_bookmark_snapshot_revision())
        remote.fail_put = False
        await self.service.export_state()
        self.assertIsNone(await self.repo.pending_bookmark_snapshot_revision())
        config = await EncryptedManifestStore(remote, self.cipher, "player", context=CONFIG_CONTEXT, name="player-config").load()
        self.assertEqual(config["archive_root"], "changed-folder")

    async def test_export_acknowledges_only_captured_revision_and_keeps_newer_edits_pending(self) -> None:
        remote = self.factory.clients[self.settings.endpoint_url]
        original_put = remote.put_stream
        started, resume = asyncio.Event(), asyncio.Event()
        async def delayed_put(path, chunks, **kwargs):
            if path == "player/player-config.2.enc":
                started.set()
                await resume.wait()
            return await original_put(path, chunks, **kwargs)
        remote.put_stream = delayed_put
        first = await self.repo.add_bookmark(self.pending_id, 1)
        task = asyncio.create_task(self.service.export_state())
        try:
            await asyncio.wait_for(started.wait(), 1)
            second = await self.repo.add_bookmark(self.pending_id, 2)
        finally:
            resume.set()
            await task
        self.assertIsNotNone(await self.repo.pending_bookmark_snapshot_revision())
        manifest = await EncryptedManifestStore(remote, self.cipher, "player").load()
        self.assertEqual(manifest["bookmarks"], [asdict(first)])
        await self.service.export_state()
        self.assertIsNone(await self.repo.pending_bookmark_snapshot_revision())
        manifest = await EncryptedManifestStore(remote, self.cipher, "player").load()
        self.assertEqual({mark["id"] for mark in manifest["bookmarks"]}, {first.id, second.id})

    async def test_background_timeout_and_shutdown_cancel_remote_io_without_losing_dirty_state(self) -> None:
        remote = self.factory.clients[self.settings.endpoint_url]
        started, cancelled = asyncio.Event(), asyncio.Event()
        async def blocked_get(path, **kwargs):
            started.set()
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.set()
        remote.get_bytes = blocked_get
        await self.repo.add_bookmark(self.pending_id, 1)
        with patch("ppvio.application.player_recovery._BOOKMARK_SNAPSHOT_TIMEOUT_SECONDS", 0.02):
            task = asyncio.create_task(self.service.run_bookmark_snapshots(asyncio.Event()))
            try:
                await asyncio.wait_for(started.wait(), 1)
                await asyncio.wait_for(cancelled.wait(), 1)
                self.assertIsNotNone(await self.repo.pending_bookmark_snapshot_revision())
            finally:
                task.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await task
        self.assertEqual(len(await self.repo.export_bookmarks()), 1)

    async def test_nonfavorite_bookmarks_restore_before_catalog_scan_and_export_again(self) -> None:
        saved = await self.repo.add_bookmark(self.pending_id, 42.26, "a scene")
        self.assertFalse(await self.repo.is_global_favorite(self.pending_id))
        await self.service.export_state()
        remote = self.factory.clients[self.settings.endpoint_url]
        manifest = await EncryptedManifestStore(remote, self.cipher, "player").load()
        self.assertEqual(manifest["bookmarks"], [asdict(saved)])
        self.assertEqual(manifest["schema_version"], 4)
        new = PlayerCatalogRepositorySQLite(self.path / "bookmarks.sqlite3")
        await new.open()
        try:
            await self.restore_into(new)
            await self.restore_into(new)
            self.assertEqual(await new.export_bookmarks(), [saved])
            self.assertEqual(await new.list_bookmark_page(), [])
            self.assertIsNone(await new.active_media_details(self.pending_id))
            # A second backup made before scanning must keep the recovered rows.
            await PlayerRecoveryService(new, self.cipher, self.factory).export_state()
            after = await EncryptedManifestStore(remote, self.cipher, "player").load()
            self.assertEqual(after["bookmarks"], [asdict(saved)])
            await new.apply_package(CatalogPackage(
                "rescanned", "archive/rescanned", "f" * 64, None, None,
                (CatalogMedia(self.pending_id, "video", 100, "video/mp4", duration_seconds=90),),
                (CatalogLocation(self.pending_id, "rescanned", "clip.mp4"),),
            ))
            await new.refresh_media_activity()
            self.assertEqual(await new.list_bookmarks(self.pending_id), [saved])
        finally:
            await new.close()

    async def test_offline_rows_are_backed_up_and_target_migration_keeps_bookmarks(self) -> None:
        mark = await self.repo.add_bookmark(self.pending_id, 8)
        await self.repo.deactivate_packages_not_seen(set())
        await self.repo.refresh_media_activity()
        await self.service.export_state()
        remote = self.factory.clients[self.settings.endpoint_url]
        manifest = await EncryptedManifestStore(remote, self.cipher, "player").load()
        self.assertEqual(manifest["bookmarks"], [asdict(mark)])
        destination = replace(self.settings, endpoint_url="https://bookmarks.example.test", revision=3)
        await self.service.migrate_target(destination)
        manifest = await EncryptedManifestStore(self.factory.clients[destination.endpoint_url], self.cipher, "player").load()
        self.assertEqual(manifest["bookmarks"], [asdict(mark)])

    async def test_v1_and_v2_snapshots_with_no_bookmarks_remain_readable(self) -> None:
        await self.service.export_state()
        for version in (1, 2):
            def downgrade(manifest):
                manifest["schema_version"] = version
                manifest.pop("bookmarks", None)
                if version == 1:
                    manifest.pop("collections", None)
            await self.rewritten_manifest(downgrade)
            new = PlayerCatalogRepositorySQLite(self.path / f"old-{version}.sqlite3")
            await new.open()
            try:
                self.assertTrue((await self.restore_into(new)).restored)
                self.assertEqual(await new.export_bookmarks(), [])
            finally:
                await new.close()

    async def test_invalid_snapshot_bookmarks_fail_before_local_state_changes(self) -> None:
        await self.service.export_state()
        valid = {"id": "e" * 32, "media_id": self.pending_id, "position_seconds": 1,
                 "name": None, "created_at": 1}
        malformed = [None, {}, [dict(valid, id="../../secret")], [dict(valid, media_id="path")],
                     [dict(valid, position_seconds=True)], [dict(valid, name="x" * 41)],
                     [dict(valid, created_at=-1)], [valid, valid]]
        for n, value in enumerate(malformed):
            with self.subTest(value=value):
                await self.rewritten_manifest(lambda manifest: manifest.update(bookmarks=value))
                new = PlayerCatalogRepositorySQLite(self.path / f"bad-{n}.sqlite3")
                await new.open()
                before = await new.get_storage_settings()
                try:
                    with self.assertRaises(RecoveryError):
                        await self.restore_into(new)
                    self.assertEqual(await new.get_storage_settings(), before)
                    self.assertEqual(await new.export_bookmarks(), [])
                    self.assertEqual(await new.list_favorite_locations(), [])
                finally:
                    await new.close()

    async def test_snapshot_merge_keeps_existing_names_and_rolls_back_identifier_conflict(self) -> None:
        existing = await self.repo.add_bookmark(self.pending_id, 7, "local")
        await self.repo.restore_bookmarks([replace(existing, name="stale")])
        self.assertEqual(await self.repo.export_bookmarks(), [existing])
        first = PlayerBookmark("0" * 32, "9" * 64, 8, None, 1)
        conflict = replace(existing, media_id="8" * 64)
        with self.assertRaises(InvalidBookmark):
            await self.repo.restore_bookmarks([first, conflict])
        self.assertEqual(await self.repo.export_bookmarks(), [existing])


if __name__ == "__main__":
    unittest.main()
