"""Paths and persisted state for one physical primary tag per original video."""
from __future__ import annotations

import hashlib
from pathlib import PurePosixPath
import re

from ppvio.domain.storage_settings import safe_storage_relpath, validate_webdav_endpoint

MEDIA_ID = re.compile(r"^[0-9a-f]{64}$")
FILING_DIRECTORY = "标签收藏"
STATUSES = frozenset({"pending", "moving", "retry", "synced", "unsupported", "paused"})
STATE_FIELDS = (
    "media_id", "origin_path", "origin_package_id", "origin_relpath", "current_path", "current_package_id", "current_relpath",
    "library_root", "source_endpoint", "primary_tag_id", "desired_tag_id", "generation", "status",
    "plan_source", "plan_target", "plan_tag_id", "plan_generation", "plan_package_id",
    "plan_relpath", "plan_size", "plan_etag", "attempts", "next_attempt_at", "last_error", "updated_at",
)


class TagFilingError(ValueError):
    pass


def media_identifier(value: object) -> str:
    if not isinstance(value, str) or not MEDIA_ID.fullmatch(value):
        raise TagFilingError("invalid media identifier")
    return value


def filing_path(value: object) -> str:
    if not isinstance(value, str) or len(value) > 4096:
        raise TagFilingError("invalid filing path")
    try:
        return safe_storage_relpath(value)
    except ValueError:
        raise TagFilingError("invalid filing path") from None


def folder_package_id(path: str) -> str:
    return hashlib.sha256(f"tgvio-folder-v1\n{path}".encode()).hexdigest()


def tag_directory(name: str, tag_id: int) -> str:
    # The numeric suffix keeps aliases, case-insensitive drives and sanitization distinct.
    safe = re.sub(r'[\\/<>:"|?*\x00-\x1f\x7f]', "_", name).strip(" ._")[:80]
    return f"{safe or '标签'}--{tag_id}"


def destination(root: str, name: str, tag_id: int, origin: str) -> str:
    basename = PurePosixPath(filing_path(origin)).name.lstrip("._")
    # Preserve the original basename, and therefore plain-file identity, where feasible.
    return filing_path(f"{filing_path(root)}/{FILING_DIRECTORY}/{tag_directory(name, tag_id)}/{basename}")


def public_state(row: dict) -> dict:
    return {key: row[key] for key in (
        "media_id", "primary_tag_id", "desired_tag_id", "generation", "status", "attempts", "last_error",
    )}


def validate_snapshot(value: object) -> list[dict]:
    if not isinstance(value, list) or len(value) > 100000:
        raise TagFilingError("invalid tag filing snapshot")
    result, seen = [], set()
    for raw in value:
        if not isinstance(raw, dict) or set(raw) != set(STATE_FIELDS):
            raise TagFilingError("invalid tag filing state")
        row = dict(raw)
        identity = media_identifier(row["media_id"])
        if identity in seen or not isinstance(row["status"], str) or row["status"] not in STATUSES:
            raise TagFilingError("invalid tag filing state")
        seen.add(identity)
        try:
            if not isinstance(row["source_endpoint"], str) or validate_webdav_endpoint(row["source_endpoint"]) != row["source_endpoint"]:
                raise TagFilingError("invalid filing endpoint")
        except ValueError:
            raise TagFilingError("invalid filing endpoint") from None
        for field in ("origin_path", "origin_relpath", "current_path", "current_relpath", "library_root"):
            filing_path(row[field])
        for field in ("plan_source", "plan_target", "plan_relpath"):
            if row[field] is not None:
                filing_path(row[field])
        for field in ("origin_package_id", "current_package_id"):
            if not isinstance(row[field], str) or not row[field] or len(row[field]) > 4096:
                raise TagFilingError("invalid tag filing state")
        if not row["origin_path"].endswith('/' + row["origin_relpath"]) or not row["current_path"].endswith('/' + row["current_relpath"]):
            raise TagFilingError("inconsistent tag filing location")
        for field in ("plan_package_id", "plan_etag", "last_error"):
            if row[field] is not None and (not isinstance(row[field], str) or len(row[field]) > 4096):
                raise TagFilingError("invalid tag filing state")
        if row["last_error"] is not None and not re.fullmatch(r"[a-z_]{1,64}", row["last_error"]):
            raise TagFilingError("invalid tag filing error")
        for field in ("generation", "attempts", "next_attempt_at", "updated_at"):
            if type(row[field]) is not int or row[field] < 0:
                raise TagFilingError("invalid tag filing state")
        for field in ("primary_tag_id", "desired_tag_id", "plan_tag_id", "plan_generation", "plan_size"):
            if row[field] is not None and (type(row[field]) is not int or row[field] < (1 if field.endswith("tag_id") else 0)):
                raise TagFilingError("invalid tag filing state")
        planned = row["plan_source"] is not None
        if planned != (row["plan_target"] is not None) or planned != (row["plan_generation"] is not None):
            raise TagFilingError("incomplete tag filing plan")
        if planned and any(row[key] is None for key in ("plan_package_id", "plan_relpath", "plan_size")):
            raise TagFilingError("incomplete tag filing plan")
        if planned and (row["plan_source"] != row["current_path"] or
                        row["plan_package_id"] != row["current_package_id"] or
                        row["plan_relpath"] != row["current_relpath"]):
            raise TagFilingError("inconsistent tag filing plan")
        if planned and row["plan_target"] != row["origin_path"] and not row["plan_target"].startswith(
            row["library_root"] + "/" + FILING_DIRECTORY + "/"
        ):
            raise TagFilingError("invalid tag filing destination")
        if row["status"] == "moving" and not planned:
            raise TagFilingError("missing tag filing plan")
        if planned and row["status"] not in {"moving", "retry", "unsupported", "paused"}:
            raise TagFilingError("invalid tag filing plan status")
        result.append(row)
    return result
