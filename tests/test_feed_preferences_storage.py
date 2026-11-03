from __future__ import annotations

import asyncio
from pathlib import Path
import random
from tempfile import TemporaryDirectory
import unittest

from ppvio.application.feed import ShuffleDeckService
from ppvio.domain.catalog import CatalogLocation, CatalogMedia, CatalogPackage
from ppvio.domain.feed_preferences import FeedPreferences, InvalidFeedPreferences
from ppvio.infrastructure.sqlite import PlayerCatalogRepositorySQLite


class PreferenceValidationTests(unittest.TestCase):
    def test_invalid_filters_are_rejected_without_coercing_ids(self):
        for payload in (None, {}, {"preferred_tags": [], "excluded_tags": [], "mode": "only"},
                        {"preferred_tags": [1], "excluded_tags": [1], "mode": "mixed"}):
            with self.subTest(payload=payload), self.assertRaises(InvalidFeedPreferences):
                FeedPreferences.from_json(payload)
        for values in ([True], ["1"], [0], [-1], [2**64], [1, 1], list(range(1, 22)), "1"):
            with self.subTest(values=values), self.assertRaises(InvalidFeedPreferences):
                FeedPreferences.from_json({"preferred_tags": values, "excluded_tags": [], "mode": "mixed"})


class PreferenceStorageTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = TemporaryDirectory()
        self.repo = PlayerCatalogRepositorySQLite(Path(self.tmp.name) / "player.sqlite3")
        await self.repo.open()
        self.ids = [f"{n:064x}" for n in range(1, 41)]
        await self.repo.apply_package(CatalogPackage(
            "package", "test/2026-11-03/1", "a" * 64, None, None,
            tuple(CatalogMedia(m, "video", 100, duration_seconds=10) for m in self.ids),
            tuple(CatalogLocation(m, "package", f"{i}.mp4") for i, m in enumerate(self.ids)),
        ))
        await self.repo.refresh_media_activity()
        self.a = (await self.repo.create_tag("a")).tag_id
        self.b = (await self.repo.create_tag("b")).tag_id
        self.x = (await self.repo.create_tag("excluded")).tag_id
        await self.repo.create_player_session("s", expires_at=9_999_999_999)

    async def asyncTearDown(self):
        await self.repo.close()
        self.tmp.cleanup()

    async def test_save_validates_existing_tags_and_deleted_tags_are_pruned(self):
        self.assertEqual(await self.repo.get_feed_preferences(), FeedPreferences())
        value = FeedPreferences((self.a,), (self.x,), "only")
        self.assertEqual(await self.repo.save_feed_preferences(value), value)
        with self.assertRaises(InvalidFeedPreferences):
            await self.repo.save_feed_preferences(FeedPreferences((99999,), (), "mixed"))
        self.assertEqual(await self.repo.get_feed_preferences(), value)
        await self.repo.delete_tag(self.a)
        pruned = await self.repo.get_feed_preferences()
        self.assertEqual(pruned, FeedPreferences((), (self.x,), "only"))
        self.assertEqual(await ShuffleDeckService(self.repo).next_items("s", limit=5), [])

    async def test_sparse_preferred_candidates_are_selected_before_any_page_limit(self):
        for m in self.ids[-3:]:
            await self.repo.set_media_tag(m, self.a, enabled=True)
        await self.repo.set_media_tag(self.ids[-2], self.b, enabled=True)
        await self.repo.set_media_tag(self.ids[-3], self.x, enabled=True)
        await self.repo.save_feed_preferences(FeedPreferences((self.a, self.b), (self.x,), "only"))
        items = await ShuffleDeckService(self.repo, rng=random.Random(2)).next_items("s", limit=5)
        self.assertEqual(set(items), set(self.ids[-2:]))
        self.assertEqual(len(items), 2)

    async def test_preference_and_tag_updates_discard_pending_but_keep_recent_history(self):
        service = ShuffleDeckService(self.repo, rng=random.Random(2))
        first = await service.next_items("s", limit=1)
        await self.repo.set_media_tag(self.ids[-1], self.a, enabled=True)
        await self.repo.save_feed_preferences(FeedPreferences((self.a,), (), "only"))
        self.assertEqual(await service.next_items("s", limit=5), [self.ids[-1]])
        self.assertIn(first[0], await self.repo.recent_feed_media("s", limit=10))
        await self.repo.set_media_tag(self.ids[-1], self.a, enabled=False)
        self.assertEqual(await service.next_items("s", limit=5), [])

    async def test_stale_candidate_snapshot_cannot_write_after_assignment_changes(self):
        candidates = await self.repo.get_feed_candidates()
        await self.repo.set_media_tag(self.ids[0], self.x, enabled=True)
        wrote = await self.repo.write_preferred_feed_cycle(
            "s", cycle=1, media_ids=list(candidates.media_ids), revision=candidates.revision)
        self.assertFalse(wrote)
        self.assertFalse(await self.repo.has_unconsumed_feed_items("s"))

    async def test_consumption_rechecks_excluded_tags_deletion_duration_and_renditions(self):
        await self.repo.set_media_tag(self.ids[0], self.x, enabled=True)
        await self.repo.save_feed_preferences(FeedPreferences((), (self.x,), "mixed"))
        await self.repo.write_feed_cycle("s", cycle=1, media_ids=self.ids[:5])
        async with self.repo._write_transaction() as conn:
            conn.execute("UPDATE media SET duration_seconds=500 WHERE media_id=?", (self.ids[1],))
            conn.execute("UPDATE media SET active=0 WHERE media_id=?", (self.ids[2],))
            conn.execute("INSERT INTO player_media_deletions(media_id,requested_at,undo_until,next_attempt_at) VALUES(?,1,2,2)", (self.ids[3],))
        self.assertEqual(await self.repo.consume_preferred_feed_items("s", limit=10, max_seconds=300), [self.ids[4]])
        self.assertFalse(await self.repo.has_unconsumed_feed_items("s"))

    async def test_two_service_instances_cannot_duplicate_a_pending_cycle(self):
        first = ShuffleDeckService(self.repo, rng=random.Random(1))
        second = ShuffleDeckService(self.repo, rng=random.Random(2))
        a, b = await asyncio.gather(first.next_items("s", limit=5), second.next_items("s", limit=5))
        self.assertEqual(len(a + b), 10)
        self.assertEqual(len(set(a + b)), 10)

    async def test_random_replacement_respects_only_and_excluded_tags(self):
        await self.repo.set_media_tag(self.ids[-1], self.a, enabled=True)
        await self.repo.save_feed_preferences(FeedPreferences((self.a,), (), "only"))
        service = ShuffleDeckService(self.repo)
        self.assertEqual(await service.random_short_ids(limit=6), [self.ids[-1]])
        self.assertEqual(await service.random_short_ids(limit=6, exclude={self.ids[-1]}), [])


if __name__ == "__main__":
    unittest.main()
