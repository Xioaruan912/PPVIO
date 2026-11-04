from __future__ import annotations

import asyncio
from copy import deepcopy
from dataclasses import replace
from pathlib import Path
import unittest

from ppvio.application.player_recovery import (
    CONFIG_CONTEXT, EncryptedManifestStore, PlayerRecoveryService, RecoveryError, WebDavBootstrap,
)
from ppvio.domain.catalog import CatalogLocation, CatalogMedia, CatalogPackage
from ppvio.domain.feed_preferences import FeedPreferences
from ppvio.infrastructure.sqlite import PlayerCatalogRepositorySQLite
import test_recovery


class CurationRecoveryTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = test_recovery.PlayerRecoveryTests.asyncSetUp
    asyncTearDown = test_recovery.PlayerRecoveryTests.asyncTearDown

    async def manifest(self):
        return await EncryptedManifestStore(self.factory.clients[self.settings.endpoint_url], self.cipher, "player").load()

    async def rewrite(self, mutate):
        remote = self.factory.clients[self.settings.endpoint_url]
        config_store = EncryptedManifestStore(remote, self.cipher, "player", context=CONFIG_CONTEXT, name="player-config")
        config = await config_store.load()
        config["revision"] += 1
        await config_store.save_atomic(config)
        manifest = await self.manifest()
        manifest["revision"] = config["revision"]
        mutate(manifest)
        await EncryptedManifestStore(remote, self.cipher, "player", schema_version=manifest["schema_version"]).save_atomic(manifest)

    async def target(self, name):
        repo = PlayerCatalogRepositorySQLite(self.path / name)
        await repo.open()
        self.addAsyncCleanup(repo.close)
        return repo

    async def restore(self, repo):
        return await PlayerRecoveryService(repo, self.cipher, self.factory).restore(
            WebDavBootstrap(self.settings.endpoint_url, "player", "alice", "old-password"))

    async def prepare(self):
        tag = await self.repo.create_tag("favorite label")
        await self.repo.batch_curate([self.pending_id], add_tags=[tag.tag_id], remove_tags=[], organized=True)
        await self.repo.save_feed_preferences(FeedPreferences((tag.tag_id,), (), "only"))
        return tag

    async def test_manifest_v4_exports_tags_bindings_organized_preferences_and_ranges(self):
        tag = await self.prepare()
        await self.service.export_state()
        manifest = await self.manifest()
        self.assertEqual(manifest["schema_version"], 5)
        self.assertEqual(manifest["curation"]["tags"][0]["name"], "favorite label")
        self.assertEqual(manifest["curation"]["media_tags"][0]["media_id"], self.pending_id)
        self.assertEqual(manifest["curation"]["organized"][0]["organized"], True)
        self.assertEqual(manifest["curation"]["preferences"], {"preferred_tags": [tag.tag_id], "excluded_tags": [], "mode": "only"})

    async def test_restored_favorite_tags_are_available_before_any_catalog_scan(self):
        tag = await self.repo.create_tag("favorite label")
        await self.repo.batch_curate([self.media_id], add_tags=[tag.tag_id], remove_tags=[], organized=True)
        await self.repo.save_feed_preferences(FeedPreferences((tag.tag_id,), (), "only"))
        await self.service.export_state()
        target = await self.target("favorite-tags.sqlite3")
        await self.restore(target)
        self.assertEqual(await target.media_tag_ids(self.media_id), [tag.tag_id])
        self.assertIn(self.media_id, (await target.get_feed_candidates()).media_ids)

    async def test_unicode_names_follow_existing_sqlite_nocase_rules_through_backup(self):
        first = await self.repo.create_tag("Straße")
        second = await self.repo.create_tag("STRASSE")
        await self.repo.batch_curate([self.media_id], add_tags=[first.tag_id, second.tag_id], remove_tags=[])
        await self.service.export_state()
        target = await self.target("unicode.sqlite3")
        await self.restore(target)
        self.assertEqual({tag.name for tag in await target.list_tags()}, {"Straße", "STRASSE"})
        self.assertEqual(len(await target.media_tag_ids(self.media_id)), 2)

    async def test_restore_merges_names_remaps_conflicting_ids_and_keeps_pending_assignments(self):
        tag = await self.prepare()
        other = await self.repo.create_tag("same name")
        await self.repo.batch_curate([self.media_id], add_tags=[other.tag_id], remove_tags=[], organized=None)
        await self.service.export_state()
        target = await self.target("restored.sqlite3")
        local = await target.create_tag("local conflicting id")
        matching = await target.create_tag("SAME NAME")
        self.assertEqual(local.tag_id, tag.tag_id)
        await self.restore(target)
        restored_tags = {item.name: item.tag_id for item in await target.list_tags()}
        remapped = restored_tags["favorite label"]
        self.assertNotEqual(remapped, tag.tag_id)
        self.assertEqual(len(restored_tags), 3)
        exported = await target.export_curation()
        self.assertEqual({(item["media_id"], item["tag_id"]) for item in exported["media_tags"]},
                         {(self.pending_id, remapped), (self.media_id, matching.tag_id)})
        self.assertEqual((await target.get_feed_preferences()).preferred_tags, (remapped,))
        self.assertTrue(await target.is_organized(self.pending_id))
        await target.apply_package(CatalogPackage(
            "later", "videos", "f" * 64, None, None,
            (CatalogMedia(self.pending_id, "video", 7, "video/mp4"),),
            (CatalogLocation(self.pending_id, "later", "later.mp4"),)))
        await target.apply_pending_curation_tags()
        self.assertEqual(await target.media_tag_ids(self.pending_id), [remapped])
        self.assertEqual(target._require().execute("SELECT COUNT(*) FROM player_pending_media_tags WHERE media_id=?", (self.pending_id,)).fetchone()[0], 0)

    async def test_versions_one_to_three_do_not_clear_local_curation(self):
        await self.service.export_state()
        for version in (1, 2, 3):
            def legacy(manifest):
                manifest["schema_version"] = version
                manifest.pop("curation", None)
                if version < 3:
                    manifest.pop("bookmarks", None)
                else:
                    manifest.setdefault("bookmarks", [])
            await self.rewrite(legacy)
            target = await self.target(f"legacy-{version}.sqlite3")
            tag = await target.create_tag("local")
            target._require().execute("INSERT INTO player_media_curation VALUES(?,1,1)", (self.pending_id,))
            target._require().commit()
            await target.save_feed_preferences(FeedPreferences((tag.tag_id,), (), "only"))
            before = await target.export_curation()
            await self.restore(target)
            self.assertEqual(await target.export_curation(), before)

    async def test_invalid_curation_is_rejected_before_any_local_restore_write(self):
        await self.prepare()
        await self.repo.add_bookmark(self.pending_id, 12)
        await self.service.export_state()
        await self.rewrite(lambda manifest: manifest.update(curation={"tags": [], "media_tags": [{"media_id": self.pending_id, "tag_id": 4, "tagged_at": 1}], "organized": [], "preferences": {"preferred_tags": [], "excluded_tags": [], "mode": "mixed"}}))
        target = await self.target("invalid.sqlite3")
        before = await target.get_storage_settings()
        with self.assertRaises(RecoveryError):
            await self.restore(target)
        self.assertEqual(await target.get_storage_settings(), before)
        self.assertEqual(await target.export_bookmarks(), [])
        self.assertFalse(await target.is_global_favorite(self.media_id))

    async def test_merged_tag_quota_failure_rolls_back_bookmarks_settings_and_favorites(self):
        await self.prepare()
        await self.repo.add_bookmark(self.pending_id, 12)
        await self.service.export_state()
        target = await self.target("quota.sqlite3")
        for n in range(200):
            await target.create_tag(f"local-{n}")
        before = await target.get_storage_settings()
        with self.assertRaises(RecoveryError):
            await self.restore(target)
        self.assertEqual(await target.get_storage_settings(), before)
        self.assertEqual(await target.export_bookmarks(), [])
        self.assertFalse(await target.is_global_favorite(self.media_id))
        self.assertEqual(len(await target.list_tags()), 200)

    async def test_export_acknowledges_only_captured_curation_revision(self):
        await self.prepare()
        remote = self.factory.clients[self.settings.endpoint_url]
        put = remote.put_stream
        started, resume = asyncio.Event(), asyncio.Event()
        async def delay(path, chunks, **kwargs):
            if path == "player/player-config.2.enc":
                started.set()
                await resume.wait()
            return await put(path, chunks, **kwargs)
        remote.put_stream = delay
        task = asyncio.create_task(self.service.export_state())
        try:
            await asyncio.wait_for(started.wait(), 1)
            await self.repo.create_tag("during export")
        finally:
            resume.set()
            await task
        self.assertIsNotNone(await self.repo.pending_bookmark_snapshot_revision())
        self.assertEqual(len((await self.manifest())["curation"]["tags"]), 1)
        await self.service.export_state()
        self.assertIsNone(await self.repo.pending_bookmark_snapshot_revision())
        self.assertEqual(len((await self.manifest())["curation"]["tags"]), 2)


if __name__ == "__main__":
    unittest.main()
