from __future__ import annotations

import asyncio
import random
from types import SimpleNamespace
import unittest

from ppvio.application.feed import ShuffleDeckService
from ppvio.domain.feed_preferences import preferred_cycle


class FeedRepository:
    def __init__(self, *, preferred=(), excluded=(), mode="mixed", watched=(), recent=()):
        self.ids = [f"{n:064x}" for n in range(1, 17)]
        self.preferred = set(preferred)
        self.excluded = set(excluded)
        self.mode = mode
        self.watched = set(watched)
        self.recent = list(recent)
        self.pending = []
        self.cycle = 0
        self.revision = 1
        self.before_write = None
        self.before_consume = None

    async def get_feed_candidates(self, *, max_seconds=None):
        ids = [m for m in self.ids if m not in self.excluded and
               (self.mode != "only" or m in self.preferred)]
        return SimpleNamespace(media_ids=ids, preferred_ids=self.preferred, revision=self.revision,
                               preferences=SimpleNamespace(mode=self.mode))

    async def list_active_video_ids(self, *, limit):
        return self.ids[:limit]

    async def has_unconsumed_feed_items(self, session):
        exists = bool(self.pending)
        await asyncio.sleep(0)
        return exists

    async def next_feed_cycle(self, session):
        return self.cycle + 1

    async def recent_feed_media(self, session, *, limit):
        return self.recent[:limit]

    async def watched_media_ids(self):
        return self.watched

    async def write_feed_cycle(self, session, *, cycle, media_ids):
        self.cycle = cycle
        self.pending.extend(media_ids)

    async def write_preferred_feed_cycle(self, session, *, cycle, media_ids, revision):
        if self.before_write:
            action, self.before_write = self.before_write, None
            action()
        if revision != self.revision or self.pending:
            return False
        await self.write_feed_cycle(session, cycle=cycle, media_ids=media_ids)
        return True

    async def consume_feed_items(self, session, *, limit):
        items, self.pending = self.pending[:limit], self.pending[limit:]
        self.recent = list(reversed(items)) + self.recent
        return items

    async def consume_preferred_feed_items(self, session, *, limit, max_seconds=None):
        if self.before_consume:
            action, self.before_consume = self.before_consume, None
            action()
        return await self.consume_feed_items(session, limit=limit)

    def change(self, *, preferred=None, excluded=None, mode=None):
        if preferred is not None:
            self.preferred = set(preferred)
        if excluded is not None:
            self.excluded = set(excluded)
        if mode is not None:
            self.mode = mode
        self.revision += 1
        self.pending = []


class PreferredFeedTests(unittest.IsolatedAsyncioTestCase):
    async def test_recent_avoidance_uses_the_mixed_window_instead_of_the_entire_other_pool(self):
        ids = [str(n) for n in range(1, 101)]
        preferred = set(ids[:80]); recent = ids[:15] + ids[95:]
        result = preferred_cycle(ids, preferred=preferred, watched=set(), recent=recent,
                                 recent_target=20, rng=random.Random(1))
        self.assertFalse(set(result[:20]) & set(recent))
        self.assertEqual([mid in preferred for mid in result[:20]], [True, True, True, False] * 5)
    async def test_mixed_uses_three_preferred_then_one_other_without_repeats(self):
        repo = FeedRepository()
        repo.preferred = set(repo.ids[:12])
        deck = ShuffleDeckService(repo, rng=random.Random(7), recent_exclusion=0)
        items = await deck.next_items("s", limit=16)
        self.assertEqual([m in repo.preferred for m in items], [True, True, True, False] * 4)
        self.assertEqual(set(items), set(repo.ids))

    async def test_only_matches_any_tag_and_exclusions_win_with_sparse_candidates(self):
        repo = FeedRepository(mode="only")
        repo.preferred = {repo.ids[-1], repo.ids[-2]}
        repo.excluded = {repo.ids[-2]}
        items = await ShuffleDeckService(repo).next_items("s", limit=5)
        self.assertEqual(items, [repo.ids[-1]])
        repo.change(preferred=[])
        self.assertEqual(await ShuffleDeckService(repo).next_items("s", limit=5), [])

    async def test_sparse_mixed_falls_back_without_repeating_preferred(self):
        repo = FeedRepository()
        repo.preferred = {repo.ids[-1]}
        repo.excluded = {repo.ids[1]}
        items = await ShuffleDeckService(repo, rng=random.Random(3)).next_items("s", limit=50)
        self.assertEqual(items[0], repo.ids[-1])
        self.assertEqual(set(items), set(repo.ids) - repo.excluded)
        self.assertEqual(len(items), len(set(items)))

    async def test_unwatched_first_and_recent_avoidance_within_each_preference_pool(self):
        repo = FeedRepository()
        repo.preferred = set(repo.ids[:12])
        repo.watched = {repo.ids[0], repo.ids[12]}
        repo.recent = [repo.ids[1], repo.ids[13]]
        items = await ShuffleDeckService(repo, rng=random.Random(3), recent_exclusion=2).next_items("s", limit=16)
        preferred = [m for m in items if m in repo.preferred]
        other = [m for m in items if m not in repo.preferred]
        self.assertEqual(preferred[-1], repo.ids[0])
        self.assertEqual(other[-1], repo.ids[12])
        self.assertNotIn(repo.ids[1], preferred[:2])
        self.assertNotIn(repo.ids[13], other[:2])
        self.assertTrue(all(m not in repo.watched for m in items[:-2]))

    async def test_changed_preferences_during_preparation_cannot_refill_old_queue(self):
        repo = FeedRepository()
        repo.before_write = lambda: repo.change(preferred=[repo.ids[-1]], mode="only")
        items = await ShuffleDeckService(repo).next_items("s", limit=4)
        self.assertEqual(items, [repo.ids[-1]])

    async def test_invalidated_queue_between_preparation_and_consumption_retries_once(self):
        repo = FeedRepository()
        repo.before_consume = lambda: repo.change(preferred=[repo.ids[-1]], mode="only")
        items = await ShuffleDeckService(repo).next_items("s", limit=4)
        self.assertEqual(items, [repo.ids[-1]])

    async def test_parallel_requests_share_one_cycle(self):
        repo = FeedRepository()
        deck = ShuffleDeckService(repo)
        first, second = await asyncio.gather(deck.next_items("s", limit=5), deck.next_items("s", limit=5))
        self.assertEqual(len(set(first + second)), 10)
        self.assertEqual(repo.cycle, 1)


if __name__ == "__main__":
    unittest.main()
