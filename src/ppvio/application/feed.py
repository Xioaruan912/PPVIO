from __future__ import annotations

import asyncio
import random

from ppvio.domain.feed import apply_recent_exclusion, unseen_first
from ppvio.domain.feed_preferences import preferred_cycle


class ShuffleDeckService:
    """Persistent shuffle cycles that play unseen videos before watched ones."""

    def __init__(
        self,
        repository: object,
        *,
        rng: random.Random | None = None,
        recent_exclusion: int = 20,
        max_duration_seconds: float | None = None,
    ) -> None:
        self._repository = repository
        self._rng = rng or random.Random()
        self._recent_exclusion = max(0, recent_exclusion)
        self._max_duration_seconds = max_duration_seconds
        self._consume_lock = asyncio.Lock()

    async def next_items(self, session_digest: str, *, limit: int) -> list[str]:
        if limit < 1:
            return []
        async with self._consume_lock:
            consume = getattr(self._repository, "consume_preferred_feed_items", None)
            for _attempt in range(2):
                await self._ensure_deck(session_digest)
                if consume is None:
                    return await self._repository.consume_feed_items(session_digest, limit=limit)
                items = await consume(session_digest, limit=limit,
                                      max_seconds=self._max_duration_seconds)
                if items:
                    return items
            return []

    async def random_short_ids(self, *, limit: int, exclude: set[str] | None = None) -> list[str]:
        if limit < 1:
            return []
        short_limit = self._max_duration_seconds or 300.0
        candidate_loader = getattr(self._repository, "get_feed_candidates", None)
        if candidate_loader is not None:
            eligible = (await candidate_loader(max_seconds=short_limit)).media_ids
        else:
            eligible = await self._repository.list_video_ids(
                max_seconds=short_limit, limit=100_000
            )
        candidates = [media_id for media_id in eligible if media_id not in (exclude or set())]
        return self._rng.sample(candidates, min(limit, len(candidates)))

    async def _ensure_deck(self, session_digest: str) -> None:
        if await self._repository.has_unconsumed_feed_items(session_digest):
            return
        candidates = None
        candidate_loader = getattr(self._repository, "get_feed_candidates", None)
        if candidate_loader is not None:
            candidates = await candidate_loader(max_seconds=self._max_duration_seconds)
            eligible = candidates.media_ids
        elif self._max_duration_seconds is not None:
            eligible = await self._repository.list_video_ids(
                max_seconds=self._max_duration_seconds, limit=100_000
            )
        else:
            eligible = await self._repository.list_active_video_ids(limit=100_000)
        if not eligible:
            return
        cycle = await self._repository.next_feed_cycle(session_digest)
        recent = await self._repository.recent_feed_media(
            session_digest, limit=self._recent_exclusion
        )
        watched = await self._repository.watched_media_ids()
        if candidates is not None:
            deck = preferred_cycle(eligible, preferred=candidates.preferred_ids, watched=watched,
                                   recent=recent, recent_target=self._recent_exclusion, rng=self._rng)
            await self._repository.write_preferred_feed_cycle(
                session_digest, cycle=cycle, media_ids=deck, revision=candidates.revision
            )
            return
        deck = apply_recent_exclusion(
            unseen_first(eligible, watched=watched, rng=self._rng),
            recent=recent,
            target=self._recent_exclusion,
        )
        await self._repository.write_feed_cycle(session_digest, cycle=cycle, media_ids=deck)

    async def favorite(self, session_digest: str, media_id: str) -> None:
        await self._repository.set_favorite(session_digest, media_id, enabled=True)

    async def unfavorite(self, session_digest: str, media_id: str) -> None:
        await self._repository.set_favorite(session_digest, media_id, enabled=False)

    async def list_favorites(self, session_digest: str, *, limit: int = 200) -> list[str]:
        return await self._repository.list_favorite_ids(session_digest, limit=limit)

    async def favorite_page(
        self,
        session_digest: str,
        *,
        limit: int,
        cursor: tuple[int, str] | None,
    ) -> list[tuple[str, int]]:
        return await self._repository.list_favorite_page(
            session_digest, limit=limit, before=cursor
        )
