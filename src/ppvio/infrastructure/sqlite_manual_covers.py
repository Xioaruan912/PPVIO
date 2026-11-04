from __future__ import annotations

import base64
import hashlib
import time

from ppvio.domain.manual_covers import (
    InvalidManualCover, ManualCoverQuotaExceeded, MAX_MANUAL_COVERS_BYTES,
    validate_cover_position, validate_manual_cover_id, validate_manual_cover_jpeg, validate_manual_covers,
)


class PlayerManualCoverRepositoryMixin:
    async def manual_cover_media_is_primary(self, media_id: str) -> bool:
        return self._require().execute("""SELECT 1 FROM media m WHERE m.media_id=? AND m.active=1 AND m.kind='video'
            AND NOT EXISTS(SELECT 1 FROM media_variants v WHERE v.variant_media_id=m.media_id)
            AND NOT EXISTS(SELECT 1 FROM player_media_deletions d WHERE d.media_id=m.media_id)""", (media_id,)).fetchone() is not None

    async def get_manual_cover(self, media_id: str) -> dict[str, object] | None:
        validate_manual_cover_id(media_id)
        row = self._require().execute("SELECT * FROM player_manual_covers WHERE media_id=?", (media_id,)).fetchone()
        return None if row is None else dict(row)

    async def save_manual_cover(self, media_id: str, jpeg: bytes, at_seconds: float) -> None:
        validate_manual_cover_id(media_id)
        validate_manual_cover_jpeg(jpeg)
        async with self._write_transaction() as conn:
            row = conn.execute("""SELECT duration_seconds FROM media WHERE media_id=? AND kind='video'
                AND active=1 AND media_id NOT IN (SELECT variant_media_id FROM media_variants)""", (media_id,)).fetchone()
            if row is None:
                raise InvalidManualCover("active primary video not found")
            position = validate_cover_position(at_seconds, row["duration_seconds"], require_duration=True)
            self._check_manual_cover_quota(conn, {media_id: len(jpeg)})
            conn.execute("""INSERT INTO player_manual_covers(media_id,jpeg,at_seconds,version,updated_at)
                VALUES(?,?,?,?,?) ON CONFLICT(media_id) DO UPDATE SET jpeg=excluded.jpeg,
                at_seconds=excluded.at_seconds,version=excluded.version,updated_at=excluded.updated_at""",
                (media_id, jpeg, position, hashlib.sha256(jpeg).hexdigest(), int(time.time())))

    @staticmethod
    def _check_manual_cover_quota(conn, replacements: dict[str, int]) -> None:
        sizes = {str(row["media_id"]): int(row["size"]) for row in conn.execute(
            "SELECT media_id,length(jpeg) AS size FROM player_manual_covers")}
        sizes.update(replacements)
        if sum(sizes.values()) > MAX_MANUAL_COVERS_BYTES:
            raise ManualCoverQuotaExceeded("manual covers exceed 16 MiB")

    async def delete_manual_cover(self, media_id: str) -> None:
        validate_manual_cover_id(media_id)
        async with self._write_transaction() as conn:
            conn.execute("DELETE FROM player_manual_covers WHERE media_id=?", (media_id,))

    async def export_manual_covers(self) -> list[dict[str, object]]:
        return [{"media_id": row["media_id"], "jpeg_base64": base64.b64encode(row["jpeg"]).decode("ascii"),
                 "at_seconds": row["at_seconds"], "version": row["version"], "updated_at": row["updated_at"]}
                for row in self._require().execute("SELECT * FROM player_manual_covers ORDER BY media_id")]

    async def restore_manual_covers(self, payload: object) -> None:
        covers = validate_manual_covers(payload)
        async with self._write_transaction() as conn:
            for cover in covers:
                media = conn.execute("""SELECT kind,duration_seconds,EXISTS(
                    SELECT 1 FROM media_variants WHERE variant_media_id=media.media_id) AS variant
                    FROM media WHERE media_id=?""", (cover["media_id"],)).fetchone()
                if media is not None:
                    if media["kind"] != "video" or media["variant"]:
                        raise InvalidManualCover("cover media must be a primary video")
                    validate_cover_position(cover["at_seconds"], media["duration_seconds"])
            self._check_manual_cover_quota(conn, {str(cover["media_id"]): len(cover["jpeg"]) for cover in covers})
            # No media FK: recovery must retain cover choices before the matching media is scanned.
            conn.executemany("""INSERT INTO player_manual_covers(media_id,jpeg,at_seconds,version,updated_at)
                VALUES(:media_id,:jpeg,:at_seconds,:version,:updated_at) ON CONFLICT(media_id) DO UPDATE
                SET jpeg=excluded.jpeg,at_seconds=excluded.at_seconds,version=excluded.version,updated_at=excluded.updated_at""", covers)
