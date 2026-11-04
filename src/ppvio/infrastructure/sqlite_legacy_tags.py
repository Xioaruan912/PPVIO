"""Transactional migration of manual groups, retaining recoverable copy cleanup."""
from __future__ import annotations

from contextlib import asynccontextmanager
from datetime import datetime, timezone
import hashlib
import json
import time

from ppvio.application.experience_snapshot import remap_legacy_tag_rules
from ppvio.domain.library_experience import validate_paging
from ppvio.domain.tags import MAX_NAME_LENGTH, MAX_TAGS, InvalidTag, clean_tag_name
from ppvio.infrastructure.sqlite_collections import MAX_RULES_LENGTH


_MAPPING = "_ppvio_legacy_tag"
_CLEANUP = "_ppvio_legacy_tag_cleanup:"


def _rules(value):
    try:
        result = json.loads(value) if value is not None else {}
    except (TypeError, ValueError):
        raise InvalidTag("legacy group rules must be an object") from None
    if not isinstance(result, dict):
        raise InvalidTag("legacy group rules must be an object")
    return result


def _timestamp(value: str) -> int:
    try:
        parsed = datetime.fromisoformat(value)
        return int((parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)).timestamp())
    except (ValueError, TypeError, OverflowError):
        return int(time.time())


def _settings(conn):
    row = conn.execute("""SELECT endpoint_url,player_root,favorites_dir,revision
        FROM player_storage_settings WHERE singleton=1""").fetchone()
    return None if row is None else dict(row)


def _snapshot(conn):
    groups = [dict(row) for row in conn.execute("""SELECT * FROM collections
        WHERE kind='manual' ORDER BY created_at,collection_id""")]
    members = [dict(row) for row in conn.execute("""SELECT ci.*,m.kind,m.active,m.size_bytes,
        EXISTS(SELECT 1 FROM player_media_deletions d WHERE d.media_id=ci.media_id) AS deleted,
        EXISTS(SELECT 1 FROM media_variants v WHERE v.variant_media_id=ci.media_id) AS variant
        FROM collection_items ci JOIN collections c USING(collection_id)
        JOIN media m USING(media_id) WHERE c.kind='manual'
        ORDER BY ci.collection_id,ci.media_id""")]
    filings = [dict(row) for row in conn.execute("""SELECT f.* FROM player_tag_filing f
        WHERE EXISTS(SELECT 1 FROM collection_items ci JOIN collections c USING(collection_id)
            WHERE ci.media_id=f.media_id AND c.kind='manual') ORDER BY f.media_id""")]
    bindings = [tuple(row) for row in conn.execute("""SELECT mt.media_id,mt.tag_id FROM player_media_tags mt
        WHERE EXISTS(SELECT 1 FROM collection_items ci JOIN collections c USING(collection_id)
            WHERE ci.media_id=mt.media_id AND c.kind='manual') ORDER BY mt.media_id,mt.tag_id""")]
    tags = [int(row[0]) for row in conn.execute("SELECT tag_id FROM player_tags ORDER BY tag_id")]
    backups = [dict(row) for row in conn.execute("""SELECT b.* FROM collection_backups b
        JOIN collections c USING(collection_id) WHERE c.kind='manual'
        ORDER BY b.collection_id,b.media_id""")]
    return {"groups": groups, "members": members, "filings": filings,
            "bindings": bindings, "tags": tags, "backups": backups, "settings": _settings(conn)}


def _protected_paths(conn, root):
    paths = set()
    for row in conn.execute("SELECT current_path,origin_path,plan_source,plan_target FROM player_tag_filing"):
        paths.update(value for value in row if value)
    for row in conn.execute("""SELECT cp.remote_path,ml.remote_relpath FROM media_locations ml
        JOIN catalog_packages cp USING(package_id)"""):
        paths.add(f"{row[0]}/{row[1]}")
    paths.update(f"{root}/{row[0]}" for row in conn.execute("SELECT relpath FROM favorite_locations"))
    return paths


def remap_legacy_group_tags_in(conn, mapping: dict[int, int]) -> None:
    for row in conn.execute("SELECT collection_id,rules_json FROM collections WHERE kind='manual'").fetchall():
        rules = remap_legacy_tag_rules(row["rules_json"], mapping)
        if rules != row["rules_json"]:
            if len(rules) > MAX_RULES_LENGTH:
                raise InvalidTag("legacy group rules have no room for tag mapping")
            conn.execute("UPDATE collections SET rules_json=? WHERE collection_id=?", (rules, row["collection_id"]))


class PlayerLegacyTagRepositoryMixin:
    async def tag_collection_ids(self, *, tag_id=None, offset=0, limit=20) -> tuple[str, ...]:
        validate_paging(offset, limit)
        if tag_id is not None and (type(tag_id) is not int or not 0 < tag_id < 2**63):
            raise InvalidTag("invalid tag identifier")
        tag_clause = " AND mt.tag_id=?" if tag_id is not None else ""
        parameters = (() if tag_id is None else (tag_id,)) + (limit, offset)
        rows = self._require().execute("""SELECT m.media_id FROM media m
            WHERE m.active=1 AND m.kind='video'
            AND NOT EXISTS(SELECT 1 FROM media_variants v WHERE v.variant_media_id=m.media_id)
            AND NOT EXISTS(SELECT 1 FROM player_media_deletions d WHERE d.media_id=m.media_id)
            AND EXISTS(SELECT 1 FROM player_media_tags mt WHERE mt.media_id=m.media_id""" + tag_clause + ")"
            " ORDER BY m.first_seen_at DESC,m.media_id LIMIT ? OFFSET ?", parameters).fetchall()
        return tuple(str(row[0]) for row in rows)

    async def import_legacy_groups_to_tags(self) -> dict:
        mapping, memberships = {}, 0
        async with self._write_transaction() as conn:
            groups = conn.execute("""SELECT collection_id,name,rules_json,created_at FROM collections
                WHERE kind='manual' ORDER BY created_at,collection_id""").fetchall()
            for group in groups:
                rules = _rules(group["rules_json"])
                saved = rules.get(_MAPPING)
                tag_id = saved.get("tag_id") if isinstance(saved, dict) else None
                if type(tag_id) is not int or conn.execute(
                    "SELECT 1 FROM player_tags WHERE tag_id=?", (tag_id,)
                ).fetchone() is None:
                    if saved is not None:
                        # Deleted/merged tags need an explicit operator decision, never resurrection.
                        raise InvalidTag("legacy group mapped tag no longer exists")
                    name = " ".join(group["name"].split())
                    if len(name) > MAX_NAME_LENGTH:
                        suffix = hashlib.sha256(name.encode()).hexdigest()[:8]
                        name = f"{name[:MAX_NAME_LENGTH - 9]}~{suffix}"
                    name = clean_tag_name(name)
                    existing = conn.execute("SELECT tag_id FROM player_tags WHERE name=? COLLATE NOCASE", (name,)).fetchone()
                    if existing is None:
                        if conn.execute("SELECT 1 FROM player_tag_aliases WHERE alias=? COLLATE NOCASE", (name,)).fetchone():
                            raise InvalidTag("a tag alias already has that name")
                        if conn.execute("SELECT COUNT(*) FROM player_tags").fetchone()[0] >= MAX_TAGS:
                            raise InvalidTag(f"at most {MAX_TAGS} tags")
                        tag_id = int(conn.execute("INSERT INTO player_tags(name,created_at) VALUES(?,?)",
                            (name, _timestamp(group["created_at"]))).lastrowid)
                    else:
                        tag_id = int(existing[0])
                    rules[_MAPPING] = {"tag_id": tag_id}
                    encoded = json.dumps(rules, ensure_ascii=False, separators=(",", ":"))
                    if len(encoded) > MAX_RULES_LENGTH:
                        raise InvalidTag("legacy group rules have no room for tag mapping")
                    conn.execute("UPDATE collections SET rules_json=? WHERE collection_id=?",
                                 (encoded, group["collection_id"]))
                mapping[group["collection_id"]] = tag_id
                for member in conn.execute("SELECT media_id,added_at FROM collection_items WHERE collection_id=?",
                                           (group["collection_id"],)).fetchall():
                    memberships += conn.execute("""INSERT OR IGNORE INTO player_media_tags(media_id,tag_id,tagged_at)
                        VALUES(?,?,?)""", (member["media_id"], tag_id, _timestamp(member["added_at"]))).rowcount
        return {"mapping": mapping, "memberships_added": memberships, "imported_groups": len(mapping)}

    async def legacy_group_snapshot(self) -> dict:
        return _snapshot(self._require())

    async def retire_verified_legacy_groups(self, snapshot: dict, folders: dict[str, str]) -> int | None:
        async with self._write_transaction() as conn:
            if _snapshot(conn) != snapshot:
                return None
            settings = snapshot["settings"]
            for group in snapshot["groups"]:
                # Cleanup authority survives the group in its existing copy retry row.
                marker = _CLEANUP + json.dumps({"folder": folders[group["collection_id"]],
                    "player_root": settings["player_root"], "endpoint_url": settings["endpoint_url"]},
                    ensure_ascii=False, separators=(",", ":"))
                conn.execute("UPDATE collection_backups SET last_error=? WHERE collection_id=?",
                             (marker, group["collection_id"]))
            return self._delete_legacy_groups(conn, [group["collection_id"] for group in snapshot["groups"]])

    @staticmethod
    def _delete_legacy_groups(conn, collection_ids) -> int:
        removed = sum(conn.execute("DELETE FROM collections WHERE collection_id=? AND kind='manual'", (identity,)).rowcount
                      for identity in dict.fromkeys(collection_ids))
        if removed:
            conn.execute("UPDATE player_bookmark_snapshot SET revision=revision+1 WHERE singleton=1")
        return removed

    async def delete_legacy_groups(self, collection_ids) -> int:
        """Metadata only; callers needing verification must use the retirement service."""
        async with self._write_transaction() as conn:
            return self._delete_legacy_groups(conn, collection_ids)

    async def legacy_cleanup_rows(self, *, limit: int | None = None) -> list[dict]:
        rows = self._require().execute("""SELECT b.* FROM collection_backups b
            WHERE substr(last_error,1,?)=? AND NOT EXISTS(
                SELECT 1 FROM collections c WHERE c.collection_id=b.collection_id)
            ORDER BY b.collection_id,b.media_id""", (len(_CLEANUP), _CLEANUP)).fetchall()
        result = []
        for row in rows if limit is None else rows[:limit]:
            item = dict(row)
            try:
                item["authority"] = json.loads(item["last_error"][len(_CLEANUP):])
            except ValueError:
                item["authority"] = {}
            result.append(item)
        return result

    @asynccontextmanager
    async def legacy_cleanup_guard(self, expected):
        """Serialize the final path checks and single DELETE with catalog mutations."""
        async with self._write_transaction() as conn:
            row = conn.execute("SELECT * FROM collection_backups WHERE collection_id=? AND media_id=?",
                               (expected["collection_id"], expected["media_id"])).fetchone()
            unchanged = row is not None and dict(row) == {key: value for key, value in expected.items() if key != "authority"}
            orphan = conn.execute("SELECT 1 FROM collections WHERE collection_id=?", (expected["collection_id"],)).fetchone() is None
            if not unchanged or not orphan:
                yield None
                return
            settings = _settings(conn)
            if settings is None:
                yield None
                return
            def complete():
                conn.execute("DELETE FROM collection_backups WHERE collection_id=? AND media_id=?",
                             (expected["collection_id"], expected["media_id"]))
            yield {"settings": settings, "protected_paths": _protected_paths(conn, settings["player_root"]),
                   "complete": complete}
