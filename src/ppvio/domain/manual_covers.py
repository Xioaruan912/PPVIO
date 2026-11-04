"""Bounded, portable manual-cover values; no file or image-decoder dependencies."""
from __future__ import annotations

import base64
import binascii
import hashlib
import math
import re

MAX_MANUAL_COVER_BYTES = 64 * 1024
MAX_MANUAL_COVERS_BYTES = 16 * 1024 * 1024
MAX_MANUAL_COVER_EDGE = 480
_ID = re.compile(r"^[0-9a-f]{64}$")


class InvalidManualCover(ValueError):
    pass


class ManualCoverQuotaExceeded(InvalidManualCover):
    pass


def validate_manual_cover_id(value: object) -> str:
    if not isinstance(value, str) or not _ID.fullmatch(value):
        raise InvalidManualCover("invalid cover media identifier")
    return value


def validate_cover_position(value: object, duration: object = None, *, require_duration: bool = False) -> float:
    try:
        valid = (not isinstance(value, bool) and isinstance(value, (int, float))
                 and math.isfinite(value) and value >= 0)
        known_duration = (not isinstance(duration, bool) and isinstance(duration, (int, float))
                          and math.isfinite(duration) and duration > 0)
    except (OverflowError, ValueError):
        valid, known_duration = False, False
    if not valid or (require_duration and not known_duration) or (known_duration and value > duration):
        raise InvalidManualCover("cover position requires a valid video duration and position")
    return float(value)


def validate_manual_cover_jpeg(data: bytes) -> tuple[int, int]:
    """Check complete JPEG marker framing and bounded SOF dimensions before storage."""
    if (not isinstance(data, bytes) or not 4 <= len(data) <= MAX_MANUAL_COVER_BYTES
            or not data.startswith(b"\xff\xd8") or not data.endswith(b"\xff\xd9")):
        raise InvalidManualCover("cover must be a JPEG of at most 64 KiB")
    offset, dimensions, scans = 2, None, 0
    components: set[int] = set()
    while offset < len(data):
        if data[offset] != 255:
            raise InvalidManualCover("invalid JPEG marker")
        while offset < len(data) and data[offset] == 255:
            offset += 1
        if offset >= len(data):
            break
        marker = data[offset]
        offset += 1
        if marker == 0xD9:
            if dimensions is not None and scans and offset == len(data):
                return dimensions
            break
        if marker in {0, 0xD8, 0x01} or 0xD0 <= marker <= 0xD7 or offset + 2 > len(data):
            break
        length = int.from_bytes(data[offset:offset + 2], "big")
        end = offset + length
        if length < 2 or end > len(data):
            break
        payload = data[offset + 2:end]
        if marker in {0xC0, 0xC1, 0xC2}:
            if dimensions is not None or len(payload) < 6 or payload[0] != 8:
                break
            height, width = int.from_bytes(payload[1:3], "big"), int.from_bytes(payload[3:5], "big")
            count = payload[5]
            if (not 0 < width <= MAX_MANUAL_COVER_EDGE or not 0 < height <= MAX_MANUAL_COVER_EDGE
                    or count not in {1, 3} or len(payload) != 6 + 3 * count):
                break
            components = set(payload[6::3])
            if len(components) != count:
                break
            dimensions = (width, height)
        elif 0xC0 <= marker <= 0xCF and marker not in {0xC4, 0xCC}:
            break
        elif marker == 0xDA:
            if (dimensions is None or len(payload) < 6 or not 1 <= payload[0] <= len(components)
                    or len(payload) != 4 + 2 * payload[0]
                    or not set(payload[1:1 + 2 * payload[0]:2]) <= components):
                break
            scans += 1
            offset = end
            scan_start = offset
            # Entropy bytes may contain stuffed FF00 and restart markers, never an unframed marker.
            while offset < len(data):
                if data[offset] != 255:
                    offset += 1
                    continue
                following = offset + 1
                while following < len(data) and data[following] == 255:
                    following += 1
                if following >= len(data):
                    break
                if data[following] == 0 or 0xD0 <= data[following] <= 0xD7:
                    offset = following + 1
                    continue
                break
            if offset == scan_start:
                break
            continue
        offset = end
    raise InvalidManualCover("invalid or unsupported JPEG structure or dimensions")


def validate_manual_covers(payload: object) -> list[dict[str, object]]:
    """Decode and validate a complete snapshot before any persistence occurs."""
    if not isinstance(payload, list):
        raise InvalidManualCover("manual covers must be a list")
    result, seen, total = [], set(), 0
    fields = {"media_id", "jpeg_base64", "at_seconds", "version", "updated_at"}
    for item in payload:
        if not isinstance(item, dict) or set(item) != fields:
            raise InvalidManualCover("invalid manual cover fields")
        media_id = validate_manual_cover_id(item["media_id"])
        if media_id in seen:
            raise InvalidManualCover("duplicate manual cover media identifier")
        seen.add(media_id)
        encoded = item["jpeg_base64"]
        if not isinstance(encoded, str) or len(encoded) > 4 * ((MAX_MANUAL_COVER_BYTES + 2) // 3):
            raise InvalidManualCover("invalid JPEG base64")
        try:
            jpeg = base64.b64decode(encoded, validate=True)
        except (ValueError, binascii.Error):
            raise InvalidManualCover("invalid JPEG base64") from None
        validate_manual_cover_jpeg(jpeg)
        version = hashlib.sha256(jpeg).hexdigest()
        if item["version"] != version:
            raise InvalidManualCover("cover version does not match JPEG")
        updated_at = item["updated_at"]
        if isinstance(updated_at, bool) or not isinstance(updated_at, int) or not 0 <= updated_at < 2**63:
            raise InvalidManualCover("invalid cover update time")
        at_seconds = validate_cover_position(item["at_seconds"])
        total += len(jpeg)
        if total > MAX_MANUAL_COVERS_BYTES:
            raise ManualCoverQuotaExceeded("manual covers exceed 16 MiB")
        result.append({"media_id": media_id, "jpeg": jpeg, "at_seconds": at_seconds,
                       "version": version, "updated_at": updated_at})
    return result
