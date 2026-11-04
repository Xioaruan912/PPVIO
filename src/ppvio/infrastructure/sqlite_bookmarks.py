from __future__ import annotations

import math
import secrets
import time

from ppvio.domain.bookmarks import (
    BookmarkLimitReached, InvalidBookmark, MAX_BOOKMARKS, MAX_MEDIA_BOOKMARKS,
    PlayerBookmark, clean_bookmark_name, clean_bookmark_end, position_ticks, validate_bookmarks,
)


def _bookmark(row) -> PlayerBookmark:
    return PlayerBookmark(str(row["bookmark_id"]), str(row["media_id"]),
                          int(row["position_ticks"]) / 10, row["name"], int(row["created_at"]),
                          None if row["end_ticks"] is None else int(row["end_ticks"]) / 10)


class PlayerBookmarkRepositoryMixin:
    async def add_bookmark(
        self, media_id: str, position_seconds: float, name: str | None = None, end_seconds: float | None = None,
    ) -> PlayerBookmark:
        ticks, name = position_ticks(position_seconds), clean_bookmark_name(name)
        end = clean_bookmark_end(end_seconds, ticks / 10)
        async with self._write_transaction() as conn:
            media = conn.execute(
                "SELECT duration_seconds FROM media WHERE media_id=? AND kind='video' AND active=1",
                (media_id,),
            ).fetchone()
            if media is None:
                raise InvalidBookmark("video not found")
            duration = media["duration_seconds"]
            if (isinstance(duration, (int, float)) and math.isfinite(duration)
                    and duration > 0 and max(position_seconds, ticks / 10, end_seconds or 0, end or 0) > duration):
                raise InvalidBookmark("bookmark position exceeds video duration")
            existing = conn.execute(
                "SELECT * FROM player_bookmarks WHERE media_id=? AND position_ticks=?",
                (media_id, ticks),
            ).fetchone()
            if existing is not None:
                return _bookmark(existing)
            self._check_bookmark_capacity(conn, media_id)
            bookmark = PlayerBookmark(secrets.token_hex(16), media_id, ticks / 10, name, int(time.time()), end)
            conn.execute(
                "INSERT INTO player_bookmarks(bookmark_id,media_id,position_ticks,name,created_at,end_ticks) VALUES(?,?,?,?,?,?)",
                (bookmark.id, media_id, ticks, name, bookmark.created_at, None if end is None else position_ticks(end)),
            )
            return bookmark

    async def update_bookmark(self, media_id: str, bookmark_id: str, changes: dict) -> PlayerBookmark | None:
        async with self._write_transaction() as conn:
            row = conn.execute("SELECT b.*,m.duration_seconds FROM player_bookmarks b JOIN media m ON m.media_id=b.media_id WHERE b.media_id=? AND b.bookmark_id=? AND m.active=1 AND m.kind='video'", (media_id, bookmark_id)).fetchone()
            if row is None:
                return None
            current = _bookmark(row)
            name = clean_bookmark_name(changes.get("name", current.name))
            raw_end = changes.get("end_seconds", current.end_seconds)
            end = clean_bookmark_end(raw_end, current.position_seconds)
            duration = row["duration_seconds"]
            if end is not None and isinstance(duration, (int, float)) and math.isfinite(duration) and duration > 0 and max(end, raw_end) > duration:
                raise InvalidBookmark("bookmark end exceeds video duration")
            if "tag_ids" in changes:
                tags = changes["tag_ids"]
                if (not isinstance(tags, list) or len(tags) > 20 or any(type(tag) is not int or not 0 < tag < 2**63 for tag in tags)
                        or len(set(tags)) != len(tags) or any(conn.execute("SELECT 1 FROM player_tags WHERE tag_id=?", (tag,)).fetchone() is None for tag in tags)):
                    raise InvalidBookmark("invalid bookmark tags")
                conn.execute("DELETE FROM player_bookmark_tags WHERE bookmark_id=?", (bookmark_id,))
                conn.executemany("INSERT INTO player_bookmark_tags(bookmark_id,tag_id) VALUES(?,?)", [(bookmark_id, tag) for tag in tags])
            conn.execute("UPDATE player_bookmarks SET name=?,end_ticks=? WHERE bookmark_id=? AND media_id=?", (name, None if end is None else position_ticks(end), bookmark_id, media_id))
            return PlayerBookmark(current.id, media_id, current.position_seconds, name, current.created_at, end)

    @staticmethod
    def _check_bookmark_capacity(conn, media_id: str) -> None:
        if conn.execute("SELECT COUNT(*) FROM player_bookmarks").fetchone()[0] >= MAX_BOOKMARKS:
            raise BookmarkLimitReached("bookmark limit reached")
        if conn.execute("SELECT COUNT(*) FROM player_bookmarks WHERE media_id=?", (media_id,)).fetchone()[0] >= MAX_MEDIA_BOOKMARKS:
            raise BookmarkLimitReached("per-video bookmark limit reached")

    async def list_bookmarks(self, media_id: str) -> list[PlayerBookmark]:
        rows = self._require().execute(
            """SELECT bookmark.* FROM player_bookmarks bookmark
               JOIN media ON media.media_id=bookmark.media_id
               WHERE bookmark.media_id=? AND media.active=1 AND media.kind='video'
               ORDER BY bookmark.position_ticks, bookmark.bookmark_id""", (media_id,),
        ).fetchall()
        return [_bookmark(row) for row in rows]

    async def list_bookmark_page(self, *, offset: int = 0, limit: int = 20, tag_id: int | None = None) -> list[PlayerBookmark]:
        if not 0 <= offset <= MAX_BOOKMARKS or not 1 <= limit <= 101:
            raise InvalidBookmark("invalid bookmark paging")
        rows = self._require().execute(
            """SELECT bookmark.* FROM player_bookmarks bookmark
               JOIN media ON media.media_id=bookmark.media_id
               WHERE media.active=1 AND media.kind='video'
               AND (? IS NULL OR EXISTS(SELECT 1 FROM player_bookmark_tags t WHERE t.bookmark_id=bookmark.bookmark_id AND t.tag_id=?))
               ORDER BY bookmark.created_at DESC, bookmark.bookmark_id LIMIT ? OFFSET ?""",
            (tag_id, tag_id, limit, offset),
        ).fetchall()
        return [_bookmark(row) for row in rows]

    async def delete_bookmark(self, media_id: str, bookmark_id: str) -> bool:
        async with self._write_transaction() as conn:
            return conn.execute(
                "DELETE FROM player_bookmarks WHERE bookmark_id=? AND media_id=?",
                (bookmark_id, media_id),
            ).rowcount > 0

    async def delete_media_bookmarks(self, media_id: str) -> None:
        async with self._write_transaction() as conn:
            conn.execute("DELETE FROM player_bookmarks WHERE media_id=?", (media_id,))

    async def export_bookmarks(self) -> list[PlayerBookmark]:
        rows = self._require().execute(
            "SELECT * FROM player_bookmarks ORDER BY created_at DESC, bookmark_id"
        ).fetchall()
        return [_bookmark(row) for row in rows]

    async def restore_bookmarks(self, bookmarks: list[PlayerBookmark]) -> None:
        bookmarks = validate_bookmarks(bookmarks)
        async with self._write_transaction() as conn:
            for bookmark in bookmarks:
                ticks = position_ticks(bookmark.position_seconds)
                existing_id = conn.execute(
                    "SELECT media_id,position_ticks FROM player_bookmarks WHERE bookmark_id=?", (bookmark.id,),
                ).fetchone()
                if existing_id is not None:
                    if (existing_id["media_id"], existing_id["position_ticks"]) != (bookmark.media_id, ticks):
                        raise InvalidBookmark("bookmark identifier conflict")
                    continue
                if conn.execute("SELECT 1 FROM player_bookmarks WHERE media_id=? AND position_ticks=?",
                                (bookmark.media_id, ticks)).fetchone() is not None:
                    continue
                self._check_bookmark_capacity(conn, bookmark.media_id)
                conn.execute("INSERT INTO player_bookmarks(bookmark_id,media_id,position_ticks,name,created_at,end_ticks) VALUES(?,?,?,?,?,?)",
                             (bookmark.id, bookmark.media_id, ticks, bookmark.name, bookmark.created_at,
                              None if bookmark.end_seconds is None else position_ticks(bookmark.end_seconds)))

    async def pending_bookmark_snapshot_revision(self) -> int | None:
        row = self._require().execute(
            "SELECT revision FROM player_bookmark_snapshot WHERE singleton=1 AND revision>saved_revision"
        ).fetchone()
        return None if row is None else int(row["revision"])

    async def acknowledge_bookmark_snapshot(self, revision: int | None) -> None:
        if revision is None:
            return
        async with self._write_transaction() as conn:
            conn.execute(
                "UPDATE player_bookmark_snapshot SET saved_revision=MAX(saved_revision,MIN(revision,?)) WHERE singleton=1",
                (revision,),
            )
