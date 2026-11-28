from __future__ import annotations

from collections import defaultdict
from collections.abc import Mapping, Sequence
import time

from ppvio.domain.library_experience import media_identifier
from ppvio.domain.recommendations import RecommendationSignal, parse_stars
from ppvio.infrastructure.sqlite_curation import _VISIBLE_VIDEO


class PlayerRecommendationRepositoryMixin:
    """SQLite persistence for 1-5 star ratings & recommendation signal loading."""

    async def get_star_rating(self, media_id: str) -> int | None:
        row = self._require().execute(
            "SELECT stars FROM player_star_ratings WHERE media_id=?",
            (media_id,),
        ).fetchone()
        return int(row[0]) if row is not None else None

    async def list_star_ratings(self) -> dict[str, int]:
        rows = self._require().execute(
            "SELECT media_id, stars FROM player_star_ratings"
        ).fetchall()
        return {str(row[0]): int(row[1]) for row in rows}

    async def set_star_rating(self, media_id: str, stars: int) -> int:
        clean_id = media_identifier(media_id)
        clean_stars = parse_stars(stars)
        now = int(time.time())
        async with self._write_transaction() as conn:
            if clean_stars == 0:
                conn.execute("DELETE FROM player_star_ratings WHERE media_id=?", (clean_id,))
            else:
                conn.execute(
                    """INSERT INTO player_star_ratings(media_id, stars, updated_at)
                       VALUES(?, ?, ?)
                       ON CONFLICT(media_id) DO UPDATE
                       SET stars=excluded.stars, updated_at=excluded.updated_at""",
                    (clean_id, clean_stars, now),
                )
            # Invalidate unconsumed future feed items so the very next feed fetch
            # immediately adapts to the user's updated taste.
            conn.execute("DELETE FROM feed_session_items WHERE consumed_at IS NULL")
        return clean_stars

    async def sync_star_ratings(self, mapping: Mapping[str, int]) -> int:
        """Import client-side ratings without overwriting existing server ratings."""
        now = int(time.time())
        inserted = 0
        async with self._write_transaction() as conn:
            for raw_id, raw_stars in list(mapping.items())[:500]:
                try:
                    clean_id = media_identifier(raw_id)
                    clean_stars = parse_stars(raw_stars)
                except ValueError:
                    continue
                if clean_stars == 0:
                    continue
                cur = conn.execute(
                    "INSERT OR IGNORE INTO player_star_ratings(media_id, stars, updated_at) VALUES(?, ?, ?)",
                    (clean_id, clean_stars, now),
                )
                if cur.rowcount:
                    inserted += 1
            if inserted:
                conn.execute("DELETE FROM feed_session_items WHERE consumed_at IS NULL")
        return inserted

    async def reset_unconsumed_feed(self, token_digest: str) -> None:
        async with self._write_transaction() as conn:
            conn.execute(
                "DELETE FROM feed_session_items WHERE token_digest=? AND consumed_at IS NULL",
                (token_digest,),
            )

    async def load_recommendation_signals(
        self,
        *,
        media_ids: Sequence[str] | None = None,
        min_seconds: float | None = None,
        max_seconds: float | None = None,
    ) -> tuple[list[RecommendationSignal], dict[int, str]]:
        """Load compact taste features across active visible videos in one pass."""
        conn = self._require()
        clauses = [_VISIBLE_VIDEO]
        params: list[object] = []
        if min_seconds is not None:
            clauses.append("m.duration_seconds > ?")
            params.append(float(min_seconds))
        if max_seconds is not None:
            clauses.append("m.duration_seconds <= ?")
            params.append(float(max_seconds))

        rows = conn.execute(
            "SELECT m.media_id, m.duration_seconds, m.width, m.height "
            "FROM media m WHERE " + " AND ".join(clauses) + " ORDER BY m.media_id",
            params,
        ).fetchall()

        wanted = set(media_ids) if media_ids is not None else None
        stars_map: dict[str, tuple[int, int]] = {
            str(r[0]): (int(r[1]), int(r[2]))
            for r in conn.execute("SELECT media_id, stars, updated_at FROM player_star_ratings").fetchall()
        }
        premium_set = {
            str(r[0])
            for r in conn.execute("SELECT media_id FROM player_media_ratings WHERE premium=1").fetchall()
        }
        favorite_set = {
            str(r[0])
            for r in conn.execute(
                "SELECT media_id FROM favorites UNION SELECT media_id FROM player_global_favorites"
            ).fetchall()
        }
        bookmarked_set = {
            str(r[0])
            for r in conn.execute("SELECT DISTINCT media_id FROM player_bookmarks").fetchall()
        }
        tag_names = {
            int(r[0]): str(r[1])
            for r in conn.execute("SELECT tag_id, name FROM player_tags").fetchall()
        }
        media_tags: dict[str, list[int]] = defaultdict(list)
        for r in conn.execute("SELECT media_id, tag_id FROM player_media_tags").fetchall():
            media_tags[str(r[0])].append(int(r[1]))

        folder_map: dict[str, str] = {}
        for r in conn.execute(
            """SELECT l.media_id, p.remote_path
               FROM media_locations l
               JOIN catalog_packages p ON p.package_id = l.package_id
               WHERE l.active=1 AND p.active=1"""
        ).fetchall():
            mid = str(r[0])
            if mid not in folder_map:
                path = str(r[1] or "").rstrip("/")
                parent = path.rsplit("/", 1)[0] if "/" in path else path
                if parent:
                    folder_map[mid] = parent

        phash_map: dict[str, str] = {}
        for r in conn.execute(
            "SELECT media_id, phash FROM media_covers WHERE active=1 AND phash IS NOT NULL"
        ).fetchall():
            mid = str(r[0])
            if mid not in phash_map and r[1]:
                phash_map[mid] = str(r[1])

        signals: list[RecommendationSignal] = []
        for row in rows:
            mid = str(row[0])
            if wanted is not None and mid not in wanted:
                continue
            star_entry = stars_map.get(mid)
            signals.append(
                RecommendationSignal(
                    media_id=mid,
                    stars=star_entry[0] if star_entry is not None else None,
                    premium=mid in premium_set,
                    favorite=mid in favorite_set,
                    bookmarked=mid in bookmarked_set,
                    tag_ids=tuple(media_tags.get(mid, ())),
                    folder_key=folder_map.get(mid),
                    duration_seconds=float(row[1]) if row[1] is not None else None,
                    width=int(row[2]) if row[2] is not None else None,
                    height=int(row[3]) if row[3] is not None else None,
                    phash=phash_map.get(mid),
                    updated_at=star_entry[1] if star_entry is not None else 0,
                )
            )
        return signals, tag_names
