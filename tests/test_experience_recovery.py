import json
import unittest

from ppvio.application.player_recovery import RecoveryError
from ppvio.domain.catalog import CatalogMedia, CatalogLocation, CatalogPackage
import test_curation_recovery as recovery_fixture
from test_manual_covers import JPEG


class ExperienceRecoveryTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = recovery_fixture.CurationRecoveryTests.asyncSetUp
    asyncTearDown = recovery_fixture.CurationRecoveryTests.asyncTearDown
    manifest = recovery_fixture.CurationRecoveryTests.manifest
    rewrite = recovery_fixture.CurationRecoveryTests.rewrite
    target = recovery_fixture.CurationRecoveryTests.target
    restore = recovery_fixture.CurationRecoveryTests.restore

    async def prepare(self):
        async with self.repo._write_transaction() as conn:
            conn.execute("UPDATE media SET duration_seconds=60 WHERE media_id=?", (self.media_id,))
        tag = await self.repo.create_tag("category")
        await self.repo.set_media_tag(self.media_id, tag.tag_id, enabled=True)
        await self.repo.update_tag_details(tag.tag_id, {"aliases": ["alias"]})
        b = await self.repo.add_bookmark(self.media_id, 2, "clip", 4)
        await self.repo.set_bookmark_tags(self.media_id, b.id, [tag.tag_id])
        await self.repo.set_premium(self.media_id, True)
        await self.repo.create_channel("channel", {"include_tags": [tag.tag_id], "premium_only": True})
        await self.repo.save_manual_cover(self.media_id, JPEG, 2)
        return tag, b

    async def test_v5_round_trip_maps_tag_and_bookmark_conflicts_and_keeps_cover_bytes(self):
        tag, bookmark = await self.prepare()
        await self.service.export_state()
        manifest = await self.manifest()
        self.assertEqual(manifest["schema_version"], 5)
        self.assertIn("experience", manifest); self.assertIn("manual_covers", manifest)
        self.assertNotIn("history", manifest)
        target = await self.target("experience.sqlite3")
        await target.create_tag("local conflict")
        await target.apply_package(CatalogPackage("local", "local", "f" * 64, None, None,
            (CatalogMedia(self.media_id, "video", 6),), (CatalogLocation(self.media_id, "local", "a.mp4"),)))
        await target.refresh_media_activity()
        local_bookmark = await target.add_bookmark(self.media_id, 2, "local")
        await self.restore(target)
        mapped = next(row["id"] for row in await target.list_tag_catalog() if row["name"] == "category")
        self.assertNotEqual(mapped, tag.tag_id)
        self.assertEqual(await target.bookmark_tag_ids(self.media_id, local_bookmark.id), [mapped])
        self.assertTrue(await target.is_premium(self.media_id))
        self.assertEqual((await target.get_manual_cover(self.media_id))["jpeg"], JPEG)
        self.assertEqual((await target.list_channels())[0]["filters"]["include_tags"], [mapped])

    async def test_invalid_v5_cover_or_tag_reference_leaves_all_local_state_untouched(self):
        await self.prepare(); await self.service.export_state()
        await self.rewrite(lambda manifest: manifest["experience"]["bookmark_tags"][0].update(tag_ids=[999]))
        target = await self.target("invalid-v5.sqlite3")
        before = await target.get_storage_settings()
        with self.assertRaises(RecoveryError): await self.restore(target)
        self.assertEqual(await target.get_storage_settings(), before)
        self.assertEqual(await target.list_tags(), [])
        self.assertEqual(await target.export_bookmarks(), [])

    async def test_restore_maps_only_source_group_markers_once_and_preserves_local_markers(self):
        for name in ("First", "Second"):
            await self.repo.create_tag(name)
            group = await self.repo.create(name, "manual", '{"keep":true}')
            await self.repo.add_item(group.collection_id, self.media_id)
        await self.repo.import_legacy_groups_to_tags()
        await self.service.export_state()
        target = await self.target("legacy-markers.sqlite3")
        local = await target.create_tag("Local")
        await target.create("Local group", "manual", '{"_ppvio_legacy_tag":{"tag_id":1}}')
        await self.restore(target)
        rules = {group.name: json.loads(group.rules_json) for group in await target.list()}
        self.assertEqual(rules["First"], {"keep": True, "_ppvio_legacy_tag": {"tag_id": 2}})
        self.assertEqual(rules["Second"]["_ppvio_legacy_tag"]["tag_id"], 3)
        self.assertEqual(rules["Local group"]["_ppvio_legacy_tag"]["tag_id"], local.tag_id)
        # Repeated recovery must not apply source 2 -> local 3 to the already mapped first group.
        await self.restore(target)
        imported = await target.import_legacy_groups_to_tags()
        groups = {group.name: group for group in await target.list()}
        self.assertEqual(imported["mapping"][groups["First"].collection_id], 2)
        self.assertEqual(imported["mapping"][groups["Second"].collection_id], 3)
        self.assertEqual(await target.media_tag_ids(self.media_id), [2, 3])

        existing = await self.target("existing-group-marker.sqlite3")
        await existing.create_tag("Local")
        local_group = await existing.create("First", "manual", '{"_ppvio_legacy_tag":{"tag_id":1}}')
        await self.restore(existing)
        self.assertEqual(json.loads((await existing.get(local_group.collection_id)).rules_json),
                         {"_ppvio_legacy_tag": {"tag_id": 1}})

    async def test_restore_clears_group_markers_without_verified_source_tag_mapping(self):
        group = await self.repo.create("Legacy", "manual", '{"keep":true,"_ppvio_legacy_tag":{"tag_id":1}}')
        await self.repo.add_item(group.collection_id, self.media_id)
        await self.service.export_state()
        for version in (1, 2, 3, 4, 5):
            def rewrite(manifest):
                manifest["schema_version"] = version
                if version < 4:
                    manifest.pop("curation", None)
            await self.rewrite(rewrite)
            target = await self.target(f"unverified-marker-{version}.sqlite3")
            await target.create_tag("Local")
            await self.restore(target)
            restored = (await target.list())[0]
            self.assertEqual(json.loads(restored.rules_json), {"keep": True})
            imported = await target.import_legacy_groups_to_tags()
            self.assertEqual(imported["mapping"][restored.collection_id], 2)
            # Restore fixture's curation section for the next schema version.
            await self.service.export_state()
