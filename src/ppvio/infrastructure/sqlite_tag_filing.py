"""Durable tag MOVE intents and catalog identity/location projection."""
from __future__ import annotations

from dataclasses import replace
import hashlib
from pathlib import PurePosixPath

from ppvio.domain.catalog import CatalogPackage
from ppvio.domain.storage_settings import validate_webdav_endpoint
from ppvio.domain.tag_filing import (
    STATE_FIELDS, TagFilingError, filing_path, folder_package_id, media_identifier,
    public_state, validate_snapshot,
)


def _primary(conn, media_id: str, preferred: int | None) -> int | None:
    tags = [int(row[0]) for row in conn.execute(
        "SELECT tag_id FROM player_media_tags WHERE media_id=? ORDER BY tagged_at,tag_id", (media_id,),
    )]
    return preferred if preferred in tags else (tags[0] if tags else None)


def _row(conn, media_id: str) -> dict | None:
    row = conn.execute("SELECT * FROM player_tag_filing WHERE media_id=?", (media_id,)).fetchone()
    return None if row is None else dict(row)


def _path_reserved(conn, path: str, media_id: str) -> bool:
    return conn.execute("""SELECT 1 FROM player_tag_filing
        WHERE (current_path=? OR plan_target=?) AND media_id<>? LIMIT 1""",
        (path, path, media_id)).fetchone() is not None


class PlayerTagFilingRepositoryMixin:
    async def request_tag_filing(self, media_id: str, *, now: int) -> dict | None:
        media_identifier(media_id)
        async with self._write_transaction() as conn:
            if conn.execute("SELECT 1 FROM player_media_deletions WHERE media_id=?", (media_id,)).fetchone():
                raise TagFilingError("media_deletion_queued")
            row = _row(conn, media_id)
            if row is not None:
                desired = _primary(conn, media_id, row["desired_tag_id"])
                changed = desired != row["desired_tag_id"]
                # An uncertain MOVE retains its exact plan until stat reconciliation.
                needs_origin = desired is None and row["current_path"] != row["origin_path"]
                status = "moving" if row["plan_source"] is not None else (
                    "pending" if changed or needs_origin or row["status"] in {"retry", "paused", "unsupported"} else row["status"])
                conn.execute("""UPDATE player_tag_filing SET desired_tag_id=?,generation=generation+?,
                    status=?,next_attempt_at=?,updated_at=? WHERE media_id=?""",
                    (desired, int(changed), status, now, now, media_id))
                return _row(conn, media_id)
            media = conn.execute("""SELECT 1 FROM media WHERE media_id=? AND kind='video' AND active=1
                AND NOT EXISTS(SELECT 1 FROM media_variants WHERE variant_media_id=media.media_id)""",
                (media_id,)).fetchone()
            if media is None:
                return None
            locations = conn.execute("""SELECT ml.package_id,cp.remote_path,ml.remote_relpath
                FROM media_locations ml JOIN catalog_packages cp ON cp.package_id=ml.package_id
                WHERE ml.media_id=? AND ml.active=1 AND cp.active=1
                ORDER BY cp.package_id,ml.remote_relpath""", (media_id,)).fetchall()
            if not locations:
                raise TagFilingError("unsupported_source")
            location = locations[0]
            source = filing_path(f"{location['remote_path']}/{location['remote_relpath']}")
            roots = [filing_path(str(r[0])) for r in conn.execute("SELECT root FROM player_libraries ORDER BY position")]
            if not roots:
                raise TagFilingError("library_not_configured")
            containing = [root for root in roots if source.startswith(root + "/")]
            root = max(containing, key=len) if containing else roots[0]
            settings = conn.execute("SELECT endpoint_url FROM player_storage_settings WHERE singleton=1").fetchone()
            if settings is None:
                raise TagFilingError("storage_unavailable")
            endpoint = validate_webdav_endpoint(str(settings[0]))
            desired = _primary(conn, media_id, None)
            conn.execute("""INSERT INTO player_tag_filing(media_id,origin_path,origin_package_id,origin_relpath,current_path,
                current_package_id,current_relpath,library_root,source_endpoint,desired_tag_id,status,next_attempt_at,updated_at)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (media_id, source, location["package_id"], location["remote_relpath"], source,
                 location["package_id"], location["remote_relpath"], root, endpoint,
                 desired, "pending" if desired is not None else "synced", now, now))
            return _row(conn, media_id)

    async def existing_tagged_media_ids(self) -> list[str]:
        return [str(row[0]) for row in self._require().execute("""SELECT DISTINCT mt.media_id
            FROM player_media_tags mt JOIN media m ON m.media_id=mt.media_id
            WHERE m.active=1 AND m.kind='video'
            AND NOT EXISTS(SELECT 1 FROM media_variants WHERE variant_media_id=m.media_id)
            ORDER BY mt.media_id""")]

    async def filing_media_ids_for_tag(self, tag_id: int) -> list[str]:
        return [str(row[0]) for row in self._require().execute("""SELECT media_id FROM player_tag_filing
            WHERE primary_tag_id=? OR desired_tag_id=? OR plan_tag_id=?
            UNION SELECT media_id FROM player_media_tags WHERE tag_id=? ORDER BY media_id""",
            (tag_id, tag_id, tag_id, tag_id))]

    async def next_due_tag_filing(self, *, now: int) -> dict | None:
        row = self._require().execute("""SELECT * FROM player_tag_filing
            WHERE status IN ('pending','moving','retry') AND next_attempt_at<=?
            ORDER BY next_attempt_at,updated_at,media_id LIMIT 1""", (now,)).fetchone()
        return None if row is None else dict(row)

    async def tag_filing_record(self, media_id: str) -> dict | None:
        return _row(self._require(), media_id)

    async def tag_filing_path_reserved(self, path: str, media_id: str) -> bool:
        return _path_reserved(self._require(), path, media_id)

    async def tag_filing_tag_name(self, tag_id: int) -> str | None:
        row = self._require().execute("SELECT name FROM player_tags WHERE tag_id=?", (tag_id,)).fetchone()
        return None if row is None else str(row[0])

    async def tag_filing_source_etag(self, media_id: str) -> str | None:
        row = self._require().execute("""SELECT ml.remote_etag FROM media_locations ml
            JOIN player_tag_filing f ON f.media_id=ml.media_id
            AND f.current_package_id=ml.package_id AND f.current_relpath=ml.remote_relpath
            WHERE f.media_id=?""", (media_id,)).fetchone()
        return None if row is None else row[0]

    async def plan_tag_filing(self, media_id: str, *, target: str, size: int,
                              etag: str | None, generation: int, now: int) -> dict | None:
        target = filing_path(target)
        async with self._write_transaction() as conn:
            row = _row(conn, media_id)
            if row is None or row["generation"] != generation or row["plan_source"] is not None:
                return None
            if conn.execute("SELECT 1 FROM player_media_deletions WHERE media_id=?", (media_id,)).fetchone():
                raise TagFilingError("media_deletion_queued")
            if _path_reserved(conn, target, media_id):
                raise TagFilingError("target_conflict")
            conn.execute("""UPDATE player_tag_filing SET status='moving',plan_source=current_path,
                plan_target=?,plan_tag_id=desired_tag_id,plan_generation=generation,
                plan_package_id=current_package_id,plan_relpath=current_relpath,plan_size=?,plan_etag=?,
                updated_at=? WHERE media_id=?""", (target, size, etag, now, media_id))
            return _row(conn, media_id)

    async def finish_tag_filing(self, media_id: str, *, etag: str | None, now: int) -> dict:
        """Commit target projection, source tombstone and actual location atomically."""
        async with self._write_transaction() as conn:
            row = _row(conn, media_id)
            if row is None or row["plan_target"] is None:
                raise TagFilingError("missing_move_plan")
            target = str(row["plan_target"])
            # Nested archive relpaths and package identity survive an empty-DB restore.
            returning = target == row["origin_path"]
            relpath = row["origin_relpath"] if returning else target.rsplit("/", 1)[1]
            directory = target[:-len(relpath) - 1]
            package_id = row["origin_package_id"] if returning else folder_package_id(directory)
            existing = conn.execute("SELECT package_id FROM catalog_packages WHERE remote_path=?", (directory,)).fetchone()
            if existing is not None:
                package_id = str(existing[0])
            else:
                conn.execute("""INSERT INTO catalog_packages(package_id,remote_path,manifest_sha256,active)
                    VALUES(?,?,?,1)""", (package_id, directory, hashlib.sha256(target.encode()).hexdigest()))
            conn.execute("UPDATE catalog_packages SET active=1 WHERE package_id=?", (package_id,))
            conn.execute("DELETE FROM player_deleted_locations WHERE package_id=? AND remote_relpath=?", (package_id, relpath))
            conn.execute("""INSERT INTO media_locations(package_id,media_id,remote_relpath,remote_etag,active)
                SELECT ?,media_id,?,?,1 FROM media WHERE media_id=?
                ON CONFLICT(package_id,remote_relpath) DO UPDATE SET media_id=excluded.media_id,
                remote_etag=excluded.remote_etag,active=1,last_seen_at=CURRENT_TIMESTAMP""",
                (package_id, relpath, etag, media_id))
            conn.execute("""INSERT INTO player_deleted_locations(package_id,remote_relpath,media_id,deleted_at)
                VALUES(?,?,?,?) ON CONFLICT(package_id,remote_relpath) DO UPDATE SET
                media_id=excluded.media_id,deleted_at=excluded.deleted_at""",
                (row["plan_package_id"], row["plan_relpath"], media_id, now))
            conn.execute("UPDATE media_locations SET active=0 WHERE package_id=? AND remote_relpath=?",
                         (row["plan_package_id"], row["plan_relpath"]))
            conn.execute("""UPDATE media SET active=CASE WHEN EXISTS(SELECT 1 FROM player_media_deletions
                WHERE media_id=?) THEN 0 ELSE 1 END WHERE media_id=?""", (media_id, media_id))
            # Primary changes made while awaiting the drive start from this confirmed location.
            settled = row["desired_tag_id"] == row["plan_tag_id"] and (
                row["desired_tag_id"] is not None or target == row["origin_path"])
            status = "synced" if settled else "pending"
            conn.execute("""UPDATE player_tag_filing SET current_path=?,current_package_id=?,current_relpath=?,
                primary_tag_id=plan_tag_id,status=?,plan_source=NULL,plan_target=NULL,plan_tag_id=NULL,
                plan_generation=NULL,plan_package_id=NULL,plan_relpath=NULL,plan_size=NULL,plan_etag=NULL,
                attempts=0,next_attempt_at=?,last_error=NULL,updated_at=? WHERE media_id=?""",
                (target, package_id, relpath, status, now, now, media_id))
            return _row(conn, media_id)

    async def settle_tag_filing(self, media_id: str, *, generation: int, now: int) -> None:
        async with self._write_transaction() as conn:
            conn.execute("""UPDATE player_tag_filing SET status='synced',primary_tag_id=desired_tag_id,
                attempts=0,last_error=NULL,updated_at=? WHERE media_id=? AND plan_source IS NULL
                AND generation=?""", (now, media_id, generation))

    async def abandon_superseded_tag_filing_plan(self, media_id: str, *, now: int) -> bool:
        """Only call after stat confirmed the unchanged source still exists."""
        async with self._write_transaction() as conn:
            return conn.execute("""UPDATE player_tag_filing SET status='pending',
                plan_source=NULL,plan_target=NULL,plan_tag_id=NULL,plan_generation=NULL,
                plan_package_id=NULL,plan_relpath=NULL,plan_size=NULL,plan_etag=NULL,
                attempts=0,next_attempt_at=?,last_error=NULL,updated_at=? WHERE media_id=?
                AND plan_source IS NOT NULL AND (desired_tag_id IS NOT plan_tag_id OR
                    (desired_tag_id IS NULL AND plan_target<>origin_path))""",
                (now, now, media_id)).rowcount > 0

    async def fail_tag_filing(self, media_id: str, *, error: str, due: int, now: int,
                              unsupported: bool = False) -> None:
        async with self._write_transaction() as conn:
            conn.execute("""UPDATE player_tag_filing SET status=?,attempts=attempts+1,last_error=?,
                next_attempt_at=?,updated_at=? WHERE media_id=?""",
                ("unsupported" if unsupported else "retry", error[:64], due, now, media_id))

    async def retry_tag_filing_now(self, *, now: int, media_id: str | None = None) -> int:
        async with self._write_transaction() as conn:
            return conn.execute("""UPDATE player_tag_filing SET status=CASE WHEN plan_source IS NULL
                THEN 'pending' ELSE 'moving' END,next_attempt_at=?,updated_at=?
                WHERE status IN ('retry','unsupported','paused')""" +
                (" AND media_id=?" if media_id else ""), (now, now, media_id) if media_id else (now, now)).rowcount

    async def tag_filing_status(self, media_id: str | None = None) -> dict:
        conn = self._require()
        rows = conn.execute("SELECT status,COUNT(*) FROM player_tag_filing GROUP BY status").fetchall()
        counts = {str(row[0]): int(row[1]) for row in rows}
        state = _row(conn, media_id) if media_id else None
        return {"pending": sum(counts.get(key, 0) for key in ("pending", "moving", "retry")),
                "moving": counts.get("moving", 0), "retrying": counts.get("retry", 0),
                "synced": counts.get("synced", 0), "unsupported": counts.get("unsupported", 0),
                "item": public_state(state) if state else None}

    def remap_tag_filing_package(self, package: CatalogPackage) -> CatalogPackage:
        """Call inside apply_package before writing media, including after recovery."""
        conn = self._require()
        settings = conn.execute("SELECT endpoint_url FROM player_storage_settings WHERE singleton=1").fetchone()
        endpoint = validate_webdav_endpoint(str(settings[0])) if settings is not None else None
        if endpoint == "https://webdav.example.invalid/dav":
            endpoint = None  # A fresh restore can remap the catalog before storage setup.
        mapping, removed = {}, set()
        for location in package.locations:
            path = f"{package.remote_path}/{location.remote_relpath}"
            moved_origin = conn.execute("""SELECT 1 FROM player_tag_filing
                WHERE origin_path=? AND current_path<>origin_path
                AND (source_endpoint=? OR ? IS NULL) LIMIT 1""", (path, endpoint, endpoint)).fetchone()
            if moved_origin is not None:
                # Snapshot state also suppresses immutable old manifests when the
                # per-location tombstone has not been rebuilt in this database yet.
                removed.add(location.remote_relpath)
                continue
            row = conn.execute("""SELECT media_id FROM player_tag_filing
                WHERE (current_path=? OR (plan_target=? AND status IN ('moving','retry')))
                AND (source_endpoint=? OR ? IS NULL) LIMIT 1""", (path, path, endpoint, endpoint)).fetchone()
            if row is not None:
                mapping[location.media_id] = str(row[0])
        if not mapping and not removed:
            return package
        return replace(package,
            media=tuple(replace(item, media_id=mapping.get(item.media_id, item.media_id)) for item in package.media),
            locations=tuple(replace(item, media_id=mapping.get(item.media_id, item.media_id))
                            for item in package.locations if item.remote_relpath not in removed),
            covers=tuple(replace(item, media_id=mapping.get(item.media_id, item.media_id)) for item in package.covers))

    async def remap_tag_filing_tag_ids(self, mapping: dict[int, int]) -> None:
        """Metadata-only merge: directory names stay until explicit organization."""
        async with self._write_transaction() as conn:
            for source, target in mapping.items():
                for column in ("primary_tag_id", "desired_tag_id", "plan_tag_id"):
                    conn.execute(f"UPDATE player_tag_filing SET {column}=? WHERE {column}=?", (target, source))

    async def export_tag_filing_snapshot(self) -> list[dict]:
        conn = self._require()
        known = {int(row[0]) for row in conn.execute("SELECT tag_id FROM player_tags")}
        rows = [dict(row) for row in conn.execute("SELECT * FROM player_tag_filing ORDER BY media_id")]
        for row in rows:
            for column in ("primary_tag_id", "desired_tag_id", "plan_tag_id"):
                if row[column] not in known:
                    row[column] = None
        return rows

    async def import_tag_filing_snapshot(self, value: object, *, tag_mapping: dict[int, int] | None = None) -> int:
        rows = validate_snapshot(value)
        async with self._write_transaction() as conn:
            known = {int(row[0]) for row in conn.execute("SELECT tag_id FROM player_tags")}
            for row in rows:
                if row["plan_source"] is not None and conn.execute(
                    "SELECT 1 FROM player_media_deletions WHERE media_id=?", (row["media_id"],)
                ).fetchone():
                    raise TagFilingError("media_deletion_queued")
                local = _row(conn, row["media_id"])
                if local is not None and (local["current_path"] != row["current_path"] or
                    (local["plan_source"] is not None and local["plan_target"] != row["plan_target"])):
                    # Restoring an older snapshot must never roll back an actual MOVE.
                    continue
                for column in ("primary_tag_id", "desired_tag_id", "plan_tag_id"):
                    value = row[column]
                    mapped = tag_mapping.get(value) if tag_mapping is not None else value
                    row[column] = mapped if mapped in known else None
                # Only an already-persisted uncertain MOVE is reconciled automatically.
                if row["plan_source"] is None and row["status"] in {"pending", "retry"}:
                    row["status"] = "paused"
                conn.execute("INSERT INTO player_tag_filing(" + ",".join(STATE_FIELDS) + ") VALUES(" +
                    ",".join("?" for _ in STATE_FIELDS) + ") ON CONFLICT(media_id) DO UPDATE SET " +
                    ",".join(f"{key}=excluded.{key}" for key in STATE_FIELDS if key != "media_id"),
                    tuple(row[key] for key in STATE_FIELDS))
        return len(rows)
