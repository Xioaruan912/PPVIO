from __future__ import annotations

import time


class PlayerFeedSessionRepositoryMixin:
    async def has_unconsumed_feed_items(self, token_digest: str) -> bool:
        row = self._require().execute(
            """
            SELECT 1 FROM feed_session_items
            WHERE token_digest=? AND consumed_at IS NULL LIMIT 1
            """,
            (token_digest,),
        ).fetchone()
        return row is not None

    async def next_feed_cycle(self, token_digest: str) -> int:
        row = self._require().execute(
            "SELECT current_cycle FROM feed_sessions WHERE token_digest=?", (token_digest,)
        ).fetchone()
        if row is None:
            raise RuntimeError("unknown player session")
        return int(row["current_cycle"]) + 1

    async def recent_feed_media(self, token_digest: str, *, limit: int) -> list[str]:
        if limit < 1:
            return []
        rows = self._require().execute(
            """
            SELECT media_id FROM feed_recent_media
            WHERE token_digest=? ORDER BY id DESC LIMIT ?
            """,
            (token_digest, limit),
        ).fetchall()
        return [str(row["media_id"]) for row in rows]

    async def write_feed_cycle(
        self, token_digest: str, *, cycle: int, media_ids: list[str]
    ) -> None:
        now = int(time.time())
        async with self._write_transaction() as conn:
            exists = conn.execute(
                "SELECT 1 FROM player_sessions WHERE token_digest=?", (token_digest,)
            ).fetchone()
            if exists is None:
                raise RuntimeError("unknown player session")
            conn.execute(
                "UPDATE feed_sessions SET current_cycle=?, last_active_at=? WHERE token_digest=?",
                (cycle, now, token_digest),
            )
            conn.executemany(
                """
                INSERT INTO feed_session_items(token_digest, cycle, ordinal, media_id)
                VALUES(?,?,?,?)
                """,
                [(token_digest, cycle, ordinal, media_id) for ordinal, media_id in enumerate(media_ids)],
            )

    async def consume_feed_items(self, token_digest: str, *, limit: int) -> list[str]:
        if limit < 1:
            return []
        now = int(time.time())
        async with self._write_transaction() as conn:
            # Recheck current catalog activity at consumption time: a package can
            # disappear after a cycle was created.
            rows = conn.execute(
                """
                SELECT item.cycle, item.ordinal, item.media_id
                FROM feed_session_items item
                JOIN media ON media.media_id=item.media_id
                WHERE item.token_digest=? AND item.consumed_at IS NULL AND media.active=1
                ORDER BY item.cycle, item.ordinal LIMIT ?
                """,
                (token_digest, limit),
            ).fetchall()
            result = [str(row["media_id"]) for row in rows]
            for row in rows:
                conn.execute(
                    """
                    UPDATE feed_session_items SET consumed_at=?
                    WHERE token_digest=? AND cycle=? AND ordinal=? AND consumed_at IS NULL
                    """,
                    (now, token_digest, row["cycle"], row["ordinal"]),
                )
                conn.execute(
                    "INSERT INTO feed_recent_media(token_digest, media_id, consumed_at) VALUES(?,?,?)",
                    (token_digest, row["media_id"], now),
                )
            # Inactive deck entries are terminally skipped so a later cycle can
            # start once all remaining active entries have been consumed.
            conn.execute(
                """
                UPDATE feed_session_items SET consumed_at=?
                WHERE token_digest=? AND consumed_at IS NULL
                  AND media_id IN (SELECT media_id FROM media WHERE active=0)
                """,
                (now, token_digest),
            )
            conn.execute(
                "UPDATE feed_sessions SET last_active_at=? WHERE token_digest=?",
                (now, token_digest),
            )
            return result

