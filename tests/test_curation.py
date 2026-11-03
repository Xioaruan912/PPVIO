from __future__ import annotations

import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from ppvio.domain.catalog import CatalogLocation, CatalogMedia, CatalogPackage
from ppvio.infrastructure.sqlite import PlayerCatalogRepositorySQLite


class CurationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temporary = TemporaryDirectory()
        self.repo = PlayerCatalogRepositorySQLite(Path(self.temporary.name) / "player.sqlite3")
        await self.repo.open()
        self.ids = [f"{n:064x}" for n in range(1, 4)]
        await self.repo.apply_package(CatalogPackage(
            "package", "videos", "a" * 64, None, None,
            tuple(CatalogMedia(mid, "video", 100, "video/mp4", 100, 100, 60) for mid in self.ids),
            tuple(CatalogLocation(mid, "package", f"{n}.mp4") for n, mid in enumerate(self.ids)),
        ))
        await self.repo.refresh_media_activity()

    async def asyncTearDown(self):
        await self.repo.close()
        self.temporary.cleanup()

    async def test_tag_changes_are_durable_dirty_and_do_not_clear_consumed_or_recent_feed(self):
        conn = self.repo._require()
        conn.execute("INSERT INTO player_sessions VALUES('session',1,9999999999)")
        conn.execute("INSERT INTO feed_sessions VALUES('session',1,1)")
        conn.execute("INSERT INTO feed_session_items VALUES('session',1,0,?,1)", (self.ids[0],))
        conn.execute("INSERT INTO feed_session_items VALUES('session',1,1,?,NULL)", (self.ids[1],))
        conn.execute("INSERT INTO feed_recent_media(token_digest,media_id,consumed_at) VALUES('session',?,1)", (self.ids[0],))
        conn.commit()
        tag = await self.repo.create_tag("first")
        self.assertIsNotNone(await self.repo.pending_bookmark_snapshot_revision())
        await self.repo.set_media_tag(self.ids[0], tag.tag_id, enabled=True)
        self.assertEqual(conn.execute("SELECT consumed_at FROM feed_session_items").fetchall()[0][0], 1)
        self.assertEqual(conn.execute("SELECT COUNT(*) FROM feed_session_items").fetchone()[0], 1)
        self.assertEqual(conn.execute("SELECT COUNT(*) FROM feed_recent_media").fetchone()[0], 1)

    async def test_batch_validates_every_record_before_changing_tags_or_organized(self):
        tag = await self.repo.create_tag("first")
        from ppvio.domain.curation import InvalidCuration
        with self.assertRaises(InvalidCuration):
            await self.repo.batch_curate([self.ids[0], "f" * 64], add_tags=[tag.tag_id], remove_tags=[], organized=True)
        self.assertEqual(await self.repo.media_tag_ids(self.ids[0]), [])
        self.assertFalse(await self.repo.is_organized(self.ids[0]))
        with self.assertRaises(InvalidCuration):
            await self.repo.batch_curate(self.ids, add_tags=[tag.tag_id, 999], remove_tags=[], organized=True)
        self.assertEqual(await self.repo.media_tag_ids(self.ids[0]), [])

    async def test_batch_is_idempotent_undoable_and_independent_of_watched(self):
        tag = await self.repo.create_tag("first")
        changed = await self.repo.batch_curate(self.ids[:2], add_tags=[tag.tag_id], remove_tags=[], organized=True)
        self.assertEqual(changed, 2)
        self.assertEqual(await self.repo.list_curation_ids(organized=True, offset=0, limit=20), self.ids[:2])
        self.assertEqual(await self.repo.list_curation_ids(organized=False, offset=0, limit=20), self.ids[2:])
        self.assertEqual(self.repo._require().execute("SELECT COUNT(*) FROM player_watched").fetchone()[0], 0)
        self.assertEqual(await self.repo.batch_curate(self.ids[:2], add_tags=[tag.tag_id], remove_tags=[], organized=True), 0)
        self.assertEqual(await self.repo.batch_curate([self.ids[0]], add_tags=[], remove_tags=[tag.tag_id], organized=False), 1)
        self.assertFalse(await self.repo.is_organized(self.ids[0]))
        self.assertEqual(await self.repo.media_tag_ids(self.ids[0]), [])

    async def test_batch_rejects_opaque_ids_conflicts_and_quotas(self):
        from ppvio.domain.curation import InvalidCuration
        cases = [(["path/video.mp4"], [], []), (self.ids * 34, [], []), (self.ids, list(range(1, 22)), []),
                 (self.ids, [True], []), (self.ids, [1], [1]), ([], [], [])]
        for ids, add, remove in cases:
            with self.subTest(ids=ids[:1], add=add), self.assertRaises(InvalidCuration):
                await self.repo.batch_curate(ids, add_tags=add, remove_tags=remove, organized=True)

    async def test_final_deletion_cleans_tag_bindings_from_future_backups(self):
        tag = await self.repo.create_tag("first")
        mid = self.ids[0]
        await self.repo.batch_curate([mid], add_tags=[tag.tag_id], remove_tags=[], organized=True)
        self.repo._require().execute("UPDATE media_locations SET active=0 WHERE media_id=?", (mid,))
        self.repo._require().commit()
        self.assertTrue(await self.repo.finalize_media_deletion(mid))
        self.assertEqual(await self.repo.media_tag_ids(mid), [])
        self.assertEqual((await self.repo.export_curation())["media_tags"], [])

    async def test_restore_does_not_apply_video_tags_to_known_images(self):
        mid = self.ids[0]
        self.repo._require().execute("UPDATE media SET kind='image',mime_type='image/jpeg' WHERE media_id=?", (mid,))
        self.repo._require().commit()
        payload = {"tags": [{"id": 1, "name": "first", "created_at": 1}],
                   "media_tags": [{"media_id": mid, "tag_id": 1, "tagged_at": 1}], "organized": [],
                   "preferences": {"preferred_tags": [], "excluded_tags": [], "mode": "mixed"}}
        await self.repo.restore_curation(payload)
        self.assertEqual(await self.repo.media_tag_ids(mid), [])

    async def test_existing_tag_libraries_above_one_hundred_thousand_bindings_remain_valid(self):
        from ppvio.domain.curation import validate_curation_snapshot
        payload = {"tags": [{"id": 1, "name": "first", "created_at": 1}],
                   "media_tags": [{"media_id": f"{n:064x}", "tag_id": 1, "tagged_at": 1} for n in range(100_001)],
                   "organized": [], "preferences": {"preferred_tags": [], "excluded_tags": [], "mode": "mixed"}}
        self.assertEqual(len(validate_curation_snapshot(payload)["media_tags"]), 100_001)


if __name__ == "__main__":
    unittest.main()
