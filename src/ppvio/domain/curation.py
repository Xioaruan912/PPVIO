"""Bounded, atomic edits to the viewer's organization metadata."""
from __future__ import annotations

import re

from ppvio.domain.feed_preferences import FeedPreferences
from ppvio.domain.tags import MAX_TAGS, clean_tag_name, tag_name_key

MAX_BATCH_MEDIA = 100
MAX_BATCH_TAGS = 20
MAX_ORGANIZED = 100_000
_MEDIA_ID = re.compile(r"^[0-9a-f]{64}$")


class InvalidCuration(ValueError):
    pass


def valid_media_id(value: object) -> bool:
    return isinstance(value, str) and _MEDIA_ID.fullmatch(value) is not None


def validate_batch(media_ids: object, add_tags: object, remove_tags: object,
                   organized: object) -> tuple[list[str], list[int], list[int], bool | None]:
    if (not isinstance(media_ids, (list, tuple)) or not 1 <= len(media_ids) <= MAX_BATCH_MEDIA
            or any(not valid_media_id(mid) for mid in media_ids)
            or len(set(media_ids)) != len(media_ids)):
        raise InvalidCuration(f"choose 1 to {MAX_BATCH_MEDIA} distinct videos")
    for values in (add_tags, remove_tags):
        if (not isinstance(values, (list, tuple)) or len(values) > MAX_BATCH_TAGS
                or any(type(tag) is not int or not 0 < tag < 2**63 for tag in values)
                or len(set(values)) != len(values)):
            raise InvalidCuration(f"choose at most {MAX_BATCH_TAGS} distinct tags")
    if set(add_tags) & set(remove_tags):
        raise InvalidCuration("a tag cannot be added and removed together")
    if organized is not None and type(organized) is not bool:
        raise InvalidCuration("organized must be true or false")
    if not add_tags and not remove_tags and organized is None:
        raise InvalidCuration("choose a change")
    return list(media_ids), list(add_tags), list(remove_tags), organized


def _timestamp(value: object) -> bool:
    return type(value) is int and 0 <= value < 2**63


def validate_curation_snapshot(payload: object) -> dict:
    """Validate the entire untrusted snapshot before storage can merge any row."""
    if not isinstance(payload, dict) or set(payload) != {"tags", "media_tags", "organized", "preferences"}:
        raise InvalidCuration("invalid curation snapshot")
    tags, bindings, organized = payload["tags"], payload["media_tags"], payload["organized"]
    if (not isinstance(tags, list) or len(tags) > MAX_TAGS
            or not isinstance(bindings, list)
            or not isinstance(organized, list) or len(organized) > MAX_ORGANIZED):
        raise InvalidCuration("curation snapshot exceeds its limits")
    normalized_tags, tag_ids, names = [], set(), set()
    for row in tags:
        if (not isinstance(row, dict) or set(row) != {"id", "name", "created_at"}
                or type(row["id"]) is not int or not 0 < row["id"] < 2**63
                or row["id"] in tag_ids or not _timestamp(row["created_at"])):
            raise InvalidCuration("invalid curation tag")
        name = clean_tag_name(row["name"])
        if tag_name_key(name) in names:
            raise InvalidCuration("duplicate curation tag name")
        tag_ids.add(row["id"])
        names.add(tag_name_key(name))
        normalized_tags.append({**row, "name": name})
    seen = set()
    for row in bindings:
        if (not isinstance(row, dict) or set(row) != {"media_id", "tag_id", "tagged_at"}
                or not valid_media_id(row["media_id"]) or type(row["tag_id"]) is not int
                or row["tag_id"] not in tag_ids or not _timestamp(row["tagged_at"])):
            raise InvalidCuration("invalid curation tag assignment")
        key = row["media_id"], row["tag_id"]
        if key in seen:
            raise InvalidCuration("duplicate curation tag assignment")
        seen.add(key)
    seen = set()
    for row in organized:
        if (not isinstance(row, dict) or set(row) != {"media_id", "organized", "updated_at"}
                or not valid_media_id(row["media_id"]) or type(row["organized"]) is not bool
                or not _timestamp(row["updated_at"]) or row["media_id"] in seen):
            raise InvalidCuration("invalid organized video record")
        seen.add(row["media_id"])
    preferences = FeedPreferences.from_json(payload["preferences"], allow_empty_only=True).to_json()
    if set(preferences["preferred_tags"] + preferences["excluded_tags"]) - tag_ids:
        raise InvalidCuration("curation preferences reference an unknown tag")
    return {"tags": normalized_tags, "media_tags": bindings, "organized": organized, "preferences": preferences}
