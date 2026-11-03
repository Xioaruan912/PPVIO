from __future__ import annotations

import json
import sqlite3
import time

from ppvio.domain.curation import (
    MAX_ORGANIZED, InvalidCuration, validate_batch, validate_curation_snapshot,
)
from ppvio.domain.tags import MAX_TAGS, tag_name_key


_VISIBLE_VIDEO = """m.active=1 AND m.kind='video'
    AND NOT EXISTS (SELECT 1 FROM media_variants v WHERE v.variant_media_id=m.media_id)
    AND NOT EXISTS (SELECT 1 FROM player_media_deletions d WHERE d.media_id=m.media_id)"""


class PlayerCurationRepositoryMixin:
    async def batch_curate(self, media_ids, *, add_tags, remove_tags, organized=None) -> int:
        media_ids, add_tags, remove_tags, organized = validate_batch(media_ids, add_tags, remove_tags, organized)
        async with self._write_transaction() as conn:
            for media_id in media_ids:
                if conn.execute(f"SELECT 1 FROM media m WHERE m.media_id=? AND {_VISIBLE_VIDEO}",
                                (media_id,)).fetchone() is None:
                    raise InvalidCuration("video not found")
            for tag_id in add_tags + remove_tags:
                if conn.execute("SELECT 1 FROM player_tags WHERE tag_id=?", (tag_id,)).fetchone() is None:
                    raise InvalidCuration("tag not found")
            if organized is not None:
                added = sum(conn.execute("SELECT 1 FROM player_media_curation WHERE media_id=?", (mid,))
                            .fetchone() is None for mid in media_ids)
                if conn.execute("SELECT COUNT(*) FROM player_media_curation").fetchone()[0] + added > MAX_ORGANIZED:
                    raise InvalidCuration("too many organized video records")
            changed = 0
            now = int(time.time())
            for media_id in media_ids:
                touched = False
                for tag_id in add_tags:
                    touched |= conn.execute(
                        "INSERT OR IGNORE INTO player_media_tags(media_id,tag_id,tagged_at) VALUES(?,?,?)",
                        (media_id, tag_id, now),
                    ).rowcount > 0
                for tag_id in remove_tags:
                    touched |= conn.execute("DELETE FROM player_media_tags WHERE media_id=? AND tag_id=?",
                                            (media_id, tag_id)).rowcount > 0
                    touched |= conn.execute("DELETE FROM player_pending_media_tags WHERE media_id=? AND tag_id=?",
                                            (media_id, tag_id)).rowcount > 0
                if organized is not None:
                    row = conn.execute("SELECT organized FROM player_media_curation WHERE media_id=?",
                                       (media_id,)).fetchone()
                    if bool(row[0] if row else False) != organized:
                        conn.execute(
                            """INSERT INTO player_media_curation(media_id,organized,updated_at) VALUES(?,?,?)
                            ON CONFLICT(media_id) DO UPDATE SET organized=excluded.organized,updated_at=excluded.updated_at""",
                            (media_id, int(organized), now),
                        )
                        touched = True
                changed += touched
            return changed

    async def list_curation_ids(self, *, organized: bool, offset: int = 0, limit: int = 20) -> list[str]:
        if (type(organized) is not bool or type(offset) is not int or not 0 <= offset <= MAX_ORGANIZED
                or type(limit) is not int or not 1 <= limit <= 101):
            raise InvalidCuration("invalid curation paging")
        rows = self._require().execute(
            f"""SELECT m.media_id FROM media m
            LEFT JOIN player_media_curation c ON c.media_id=m.media_id
            WHERE {_VISIBLE_VIDEO} AND COALESCE(c.organized,0)=?
            ORDER BY m.media_id LIMIT ? OFFSET ?""", (int(organized), limit, offset),
        ).fetchall()
        return [str(row[0]) for row in rows]

    async def is_organized(self, media_id: str) -> bool:
        row = self._require().execute("SELECT organized FROM player_media_curation WHERE media_id=?",
                                      (media_id,)).fetchone()
        return bool(row[0]) if row else False

    async def export_curation(self) -> dict:
        async with self._write_lock:
            conn = self._require()
            tags = [dict(row) for row in conn.execute(
                "SELECT tag_id AS id,name,created_at FROM player_tags ORDER BY tag_id")]
            bindings = [dict(row) for row in conn.execute(
                """SELECT media_id,tag_id,MAX(tagged_at) AS tagged_at FROM (
                    SELECT media_id,tag_id,tagged_at FROM player_media_tags UNION ALL
                    SELECT media_id,tag_id,tagged_at FROM player_pending_media_tags)
                GROUP BY media_id,tag_id ORDER BY media_id,tag_id""")]
            organized = [dict(row) for row in conn.execute(
                "SELECT media_id,organized,updated_at FROM player_media_curation ORDER BY media_id")]
            preferences = conn.execute("SELECT preferred_tags,excluded_tags,mode FROM player_feed_preferences WHERE singleton=1").fetchone()
            payload = {"tags": tags, "media_tags": bindings,
                       "organized": [{**row, "organized": bool(row["organized"])} for row in organized],
                       "preferences": {"preferred_tags": json.loads(preferences[0]),
                                       "excluded_tags": json.loads(preferences[1]), "mode": preferences[2]}}
            # Removed tag IDs can remain in the stored setting until its next read.
            known = {tag["id"] for tag in tags}
            for field in ("preferred_tags", "excluded_tags"):
                payload["preferences"][field] = [tag for tag in payload["preferences"][field] if tag in known]
            return validate_curation_snapshot(payload)

    async def restore_curation(self, payload: object) -> None:
        payload = validate_curation_snapshot(payload)
        async with self._write_transaction() as conn:
            current = conn.execute("SELECT tag_id,name FROM player_tags").fetchall()
            names = {tag_name_key(str(row[1])): int(row[0]) for row in current}
            added = sum(tag_name_key(tag["name"]) not in names for tag in payload["tags"])
            if len(current) + added > MAX_TAGS:
                raise InvalidCuration(f"at most {MAX_TAGS} tags")
            # All writes share the caller's recovery transaction when present.
            mapping = {}
            occupied = {int(row[0]) for row in current}
            for tag in payload["tags"]:
                key = tag_name_key(tag["name"])
                local_id = names.get(key)
                if local_id is None:
                    if tag["id"] not in occupied:
                        conn.execute("INSERT INTO player_tags(tag_id,name,created_at) VALUES(?,?,?)",
                                     (tag["id"], tag["name"], tag["created_at"]))
                        local_id = tag["id"]
                    else:
                        local_id = int(conn.execute("INSERT INTO player_tags(name,created_at) VALUES(?,?)",
                                                    (tag["name"], tag["created_at"])).lastrowid)
                    occupied.add(local_id)
                    names[key] = local_id
                mapping[tag["id"]] = local_id
            organized_ids = {str(row[0]) for row in conn.execute("SELECT media_id FROM player_media_curation")}
            organized_ids.update(row["media_id"] for row in payload["organized"])
            if len(organized_ids) > MAX_ORGANIZED:
                raise InvalidCuration("too many organized video records")
            for row in payload["media_tags"]:
                known = conn.execute("SELECT kind, EXISTS(SELECT 1 FROM media_variants v WHERE v.variant_media_id=m.media_id) FROM media m WHERE media_id=?", (row["media_id"],)).fetchone()
                if known is not None and (known[0] != "video" or known[1]):
                    continue
                table = "player_media_tags" if known else "player_pending_media_tags"
                conn.execute(f"INSERT OR IGNORE INTO {table}(media_id,tag_id,tagged_at) VALUES(?,?,?)",
                             (row["media_id"], mapping[row["tag_id"]], row["tagged_at"]))
            for row in payload["organized"]:
                conn.execute("""INSERT INTO player_media_curation(media_id,organized,updated_at) VALUES(?,?,?)
                    ON CONFLICT(media_id) DO UPDATE SET organized=excluded.organized,updated_at=excluded.updated_at
                    WHERE excluded.updated_at > player_media_curation.updated_at""",
                             (row["media_id"], int(row["organized"]), row["updated_at"]))
            preferences = payload["preferences"]
            conn.execute("UPDATE player_feed_preferences SET preferred_tags=?,excluded_tags=?,mode=? WHERE singleton=1",
                         (json.dumps([mapping[tag] for tag in preferences["preferred_tags"]]),
                          json.dumps([mapping[tag] for tag in preferences["excluded_tags"]]), preferences["mode"]))
            self.apply_pending_curation_tags_in(conn)

    @staticmethod
    def apply_pending_curation_tags_in(conn: sqlite3.Connection) -> None:
        conn.execute("""INSERT OR IGNORE INTO player_media_tags(media_id,tag_id,tagged_at)
            SELECT p.media_id,p.tag_id,p.tagged_at FROM player_pending_media_tags p
            JOIN media m ON m.media_id=p.media_id WHERE m.kind='video'
            AND NOT EXISTS(SELECT 1 FROM media_variants v WHERE v.variant_media_id=m.media_id)""")
        conn.execute("""DELETE FROM player_pending_media_tags WHERE EXISTS(
            SELECT 1 FROM player_media_tags t WHERE t.media_id=player_pending_media_tags.media_id
            AND t.tag_id=player_pending_media_tags.tag_id)""")

    async def apply_pending_curation_tags(self) -> None:
        async with self._write_transaction() as conn:
            self.apply_pending_curation_tags_in(conn)
