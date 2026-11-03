from __future__ import annotations

from dataclasses import dataclass, replace
from decimal import Decimal, ROUND_HALF_UP
import math
import re


MAX_BOOKMARKS = 5000
MAX_MEDIA_BOOKMARKS = 200
_MEDIA_ID = re.compile(r"^[0-9a-f]{64}$")
_BOOKMARK_ID = re.compile(r"^[0-9a-f]{32}$")


class InvalidBookmark(ValueError):
    pass


class BookmarkLimitReached(ValueError):
    pass


@dataclass(frozen=True, slots=True)
class PlayerBookmark:
    id: str
    media_id: str
    position_seconds: float
    name: str | None
    created_at: int
    end_seconds: float | None = None


def clean_bookmark_end(value: object, start_seconds: float) -> float | None:
    if value is None:
        return None
    end = position_ticks(value)
    if end <= position_ticks(start_seconds):
        raise InvalidBookmark("bookmark end must follow its start")
    return end / 10


def position_ticks(value: object) -> int:
    if (isinstance(value, bool) or not isinstance(value, (int, float))
            or value < 0 or value >= 2**63 / 10 or not math.isfinite(value)):
        raise InvalidBookmark("invalid bookmark position")
    return int((Decimal(str(value)) * 10).to_integral_value(rounding=ROUND_HALF_UP))


def clean_bookmark_name(value: object) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or any(ord(c) < 32 or ord(c) == 127 for c in value):
        raise InvalidBookmark("invalid bookmark name")
    name = value.strip()
    if len(name) > 40:
        raise InvalidBookmark("bookmark name must be at most 40 characters")
    return name or None


def valid_bookmark_id(value: object) -> bool:
    return isinstance(value, str) and _BOOKMARK_ID.fullmatch(value) is not None


def validate_bookmarks(bookmarks: list[PlayerBookmark]) -> list[PlayerBookmark]:
    if len(bookmarks) > MAX_BOOKMARKS:
        raise BookmarkLimitReached("bookmark limit reached")
    normalized: list[PlayerBookmark] = []
    ids: set[str] = set()
    positions: set[tuple[str, int]] = set()
    counts: dict[str, int] = {}
    for bookmark in bookmarks:
        if (not valid_bookmark_id(bookmark.id)
                or not isinstance(bookmark.media_id, str) or not _MEDIA_ID.fullmatch(bookmark.media_id)
                or type(bookmark.created_at) is not int or not 0 <= bookmark.created_at < 2**63):
            raise InvalidBookmark("invalid bookmark record")
        ticks = position_ticks(bookmark.position_seconds)
        key = bookmark.media_id, ticks
        if bookmark.id in ids or key in positions:
            raise InvalidBookmark("duplicate bookmark record")
        ids.add(bookmark.id)
        positions.add(key)
        counts[bookmark.media_id] = counts.get(bookmark.media_id, 0) + 1
        if counts[bookmark.media_id] > MAX_MEDIA_BOOKMARKS:
            raise BookmarkLimitReached("per-video bookmark limit reached")
        normalized.append(replace(bookmark, position_seconds=ticks / 10,
                                  name=clean_bookmark_name(bookmark.name),
                                  end_seconds=clean_bookmark_end(bookmark.end_seconds, ticks / 10)))
    return normalized
