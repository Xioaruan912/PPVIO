from __future__ import annotations

import json
import sqlite3
import time

from ppvio.domain.feed_preferences import FeedCandidates, FeedPreferences, InvalidFeedPreferences


def _store_preferences(conn: sqlite3.Connection, value: FeedPreferences) -> None:
    conn.execute(
        "UPDATE player_feed_preferences SET preferred_tags=?,excluded_tags=?,mode=? WHERE singleton=1",
        (json.dumps(value.preferred_tags), json.dumps(value.excluded_tags), value.mode),
    )


def _preferences(conn: sqlite3.Connection) -> FeedPreferences:
    row = conn.execute("SELECT preferred_tags,excluded_tags,mode FROM player_feed_preferences WHERE singleton=1").fetchone()
    value = FeedPreferences.from_json({"preferred_tags": json.loads(row[0]),
                                      "excluded_tags": json.loads(row[1]), "mode": row[2]},
                                     allow_empty_only=True)
    existing = {int(r[0]) for r in conn.execute("SELECT tag_id FROM player_tags")}
    pruned = FeedPreferences(tuple(t for t in value.preferred_tags if t in existing),
                             tuple(t for t in value.excluded_tags if t in existing), value.mode)
    if pruned != value:
        _store_preferences(conn, pruned)
    return pruned


def _candidate_query(value: FeedPreferences, max_seconds: float | None) -> tuple[str, list[object]]:
    preferred = "0"
    params: list[object] = []
    if value.preferred_tags:
        preferred = ("EXISTS (SELECT 1 FROM player_media_tags t WHERE t.media_id=m.media_id "
                     "AND t.tag_id IN (" + ",".join("?" for _ in value.preferred_tags) + "))")
        params.extend(value.preferred_tags)
    clauses = ["m.active=1", "m.kind='video'",
               "NOT EXISTS (SELECT 1 FROM media_variants v WHERE v.variant_media_id=m.media_id)",
               "NOT EXISTS (SELECT 1 FROM player_media_deletions d WHERE d.media_id=m.media_id)"]
    if max_seconds is not None:
        clauses.append("m.duration_seconds<=?")
        params.append(float(max_seconds))
    if value.excluded_tags:
        clauses.append("NOT EXISTS (SELECT 1 FROM player_media_tags t WHERE t.media_id=m.media_id "
                       "AND t.tag_id IN (" + ",".join("?" for _ in value.excluded_tags) + "))")
        params.extend(value.excluded_tags)
    if value.mode == "only":
        clauses.append(preferred)
        params.extend(value.preferred_tags)
    return (f"SELECT m.media_id, {preferred} AS preferred FROM media m WHERE " +
            " AND ".join(clauses)), params


class PlayerFeedPreferencesRepositoryMixin:
    async def get_feed_preferences(self) -> FeedPreferences:
        async with self._write_transaction() as conn:
            return _preferences(conn)

    async def save_feed_preferences(self, value: FeedPreferences) -> FeedPreferences:
        value = FeedPreferences.from_json(value.to_json())
        async with self._write_transaction() as conn:
            existing = {int(row[0]) for row in conn.execute("SELECT tag_id FROM player_tags")}
            if not set(value.preferred_tags + value.excluded_tags) <= existing:
                raise InvalidFeedPreferences("tag not found")
            if value != _preferences(conn):
                _store_preferences(conn, value)
        return value

    async def get_feed_candidates(self, *, max_seconds: float | None = None) -> FeedCandidates:
        # One transaction binds the filter, candidate membership and revision.
        async with self._write_transaction() as conn:
            preferences = _preferences(conn)
            query, params = _candidate_query(preferences, max_seconds)
            rows = conn.execute(query + " ORDER BY m.media_id", params).fetchall()
            revision = conn.execute("SELECT revision FROM player_bookmark_snapshot WHERE singleton=1").fetchone()[0]
            return FeedCandidates(preferences, tuple(str(r[0]) for r in rows),
                                  frozenset(str(r[0]) for r in rows if r[1]), int(revision))

    async def write_preferred_feed_cycle(self, token_digest: str, *, cycle: int,
                                         media_ids: list[str], revision: int) -> bool:
        now = int(time.time())
        async with self._write_transaction() as conn:
            current = conn.execute("SELECT revision FROM player_bookmark_snapshot WHERE singleton=1").fetchone()[0]
            session = conn.execute("SELECT current_cycle FROM feed_sessions WHERE token_digest=?", (token_digest,)).fetchone()
            if session is None:
                raise RuntimeError("unknown player session")
            if int(current) != revision or int(session[0]) + 1 != cycle:
                return False
            if conn.execute("SELECT 1 FROM feed_session_items WHERE token_digest=? AND consumed_at IS NULL LIMIT 1", (token_digest,)).fetchone():
                return False
            conn.execute("UPDATE feed_sessions SET current_cycle=?,last_active_at=? WHERE token_digest=?", (cycle, now, token_digest))
            conn.executemany(
                "INSERT INTO feed_session_items(token_digest,cycle,ordinal,media_id) VALUES(?,?,?,?)",
                [(token_digest, cycle, ordinal, media_id) for ordinal, media_id in enumerate(media_ids)],
            )
            return True

    async def consume_preferred_feed_items(self, token_digest: str, *, limit: int,
                                           max_seconds: float | None = None) -> list[str]:
        if limit < 1:
            return []
        now = int(time.time())
        async with self._write_transaction() as conn:
            query, params = _candidate_query(_preferences(conn), max_seconds)
            eligible = "WITH eligible AS (" + query + ") "
            # Catalog/deletion changes need not have gone through a preference trigger.
            conn.execute(eligible + "DELETE FROM feed_session_items WHERE token_digest=? AND consumed_at IS NULL AND media_id NOT IN (SELECT media_id FROM eligible)", (*params, token_digest))
            rows = conn.execute(
                eligible + "SELECT item.cycle,item.ordinal,item.media_id FROM feed_session_items item JOIN eligible e ON e.media_id=item.media_id WHERE item.token_digest=? AND item.consumed_at IS NULL ORDER BY item.cycle,item.ordinal LIMIT ?",
                (*params, token_digest, limit),
            ).fetchall()
            for row in rows:
                conn.execute("UPDATE feed_session_items SET consumed_at=? WHERE token_digest=? AND cycle=? AND ordinal=? AND consumed_at IS NULL", (now, token_digest, row[0], row[1]))
                conn.execute("INSERT INTO feed_recent_media(token_digest,media_id,consumed_at) VALUES(?,?,?)", (token_digest, row[2], now))
            conn.execute("UPDATE feed_sessions SET last_active_at=? WHERE token_digest=?", (now, token_digest))
            return [str(row[2]) for row in rows]
