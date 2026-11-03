from __future__ import annotations

from collections import deque
from dataclasses import dataclass
import random
from collections.abc import Sequence

from ppvio.domain.feed import shuffled_cycle


class InvalidFeedPreferences(ValueError):
    pass


@dataclass(frozen=True)
class FeedPreferences:
    preferred_tags: tuple[int, ...] = ()
    excluded_tags: tuple[int, ...] = ()
    mode: str = "mixed"

    @classmethod
    def from_json(cls, payload: object, *, allow_empty_only: bool = False) -> FeedPreferences:
        if not isinstance(payload, dict):
            raise InvalidFeedPreferences("preferences must be an object")
        lists = []
        for key in ("preferred_tags", "excluded_tags"):
            values = payload.get(key)
            if not isinstance(values, list) or len(values) > 20:
                raise InvalidFeedPreferences(f"{key} must contain at most 20 tag IDs")
            if any(type(value) is not int or value <= 0 or value > 2**63 - 1 for value in values):
                raise InvalidFeedPreferences("tag IDs must be positive integers")
            if len(values) != len(set(values)):
                raise InvalidFeedPreferences("tag IDs must be unique")
            lists.append(tuple(values))
        mode = payload.get("mode")
        if mode not in ("mixed", "only"):
            raise InvalidFeedPreferences("mode must be mixed or only")
        if set(lists[0]) & set(lists[1]):
            raise InvalidFeedPreferences("preferred and excluded tags must be disjoint")
        if mode == "only" and not lists[0] and not allow_empty_only:
            raise InvalidFeedPreferences("only mode requires a preferred tag")
        return cls(lists[0], lists[1], mode)

    def to_json(self) -> dict[str, object]:
        return {"preferred_tags": list(self.preferred_tags),
                "excluded_tags": list(self.excluded_tags), "mode": self.mode}


@dataclass(frozen=True)
class FeedCandidates:
    preferences: FeedPreferences
    media_ids: tuple[str, ...]
    preferred_ids: frozenset[str]
    revision: int


def preferred_cycle(media_ids: Sequence[str], *, preferred: set[str] | frozenset[str],
                    watched: set[str], recent: Sequence[str], recent_target: int,
                    rng: random.Random) -> list[str]:
    """Mix each unwatched/watched tier 3:1, falling back when a pool runs out."""
    result = []
    blocked = set(recent) if recent_target > 0 else set()
    for seen in (False, True):
        tier = [media_id for media_id in media_ids if (media_id in watched) == seen]
        pools = []
        for match in (True, False):
            pool = shuffled_cycle([m for m in tier if (m in preferred) == match], rng=rng)
            pools.append(deque([m for m in pool if m not in blocked] + [m for m in pool if m in blocked]))
        while pools[0] or pools[1]:
            for index in (0, 0, 0, 1):
                pool = pools[index] or pools[1 - index]
                if pool:
                    result.append(pool.popleft())
    return result
