"""Compatible v5 user metadata at the encrypted snapshot boundary."""
from __future__ import annotations

import json

from ppvio.domain.library_experience import validate_experience_snapshot
from ppvio.domain.manual_covers import validate_manual_covers
from ppvio.domain.tag_filing import validate_snapshot as validate_filing_snapshot
from ppvio.domain.tags import tag_name_key


def remap_legacy_tag_rules(rules_json: str | None, mapping: dict[int, int], *,
                           clear_unmapped: bool = False) -> str | None:
    if rules_json is None:
        return None
    rules = json.loads(rules_json)
    if not isinstance(rules, dict):
        raise ValueError("legacy group rules must be an object")
    marker = rules.get("_ppvio_legacy_tag")
    if "_ppvio_legacy_tag" not in rules:
        return rules_json
    source = marker.get("tag_id") if isinstance(marker, dict) else None
    if type(source) is int and source in mapping:
        rules["_ppvio_legacy_tag"] = {**marker, "tag_id": mapping[source]}
    elif clear_unmapped:
        del rules["_ppvio_legacy_tag"]
    else:
        return rules_json
    return json.dumps(rules, ensure_ascii=False, separators=(",", ":"))


async def restored_tag_mapping(repository, curation: dict | None) -> dict[int, int]:
    if curation is None:
        return {}
    current = {tag_name_key(tag.name): tag.tag_id for tag in await repository.list_tags()}
    return {tag["id"]: current[tag_name_key(tag["name"])] for tag in curation["tags"]}


def read_experience(manifest: dict, curation: dict | None, bookmarks: list) -> dict | None:
    if manifest["schema_version"] < 5:
        return None
    payload = validate_experience_snapshot(manifest.get("experience"),
        known_bookmark_ids={bookmark.id for bookmark in bookmarks},
        tag_names={tag["id"]: tag["name"] for tag in (curation or {})["tags"]})
    validate_manual_covers(manifest.get("manual_covers"))
    filing = validate_filing_snapshot(manifest.get("tag_filing"))
    known = {tag["id"] for tag in curation["tags"]}
    if any(row[field] is not None and row[field] not in known for row in filing for field in ("primary_tag_id", "desired_tag_id", "plan_tag_id")):
        raise ValueError("tag filing snapshot references an unknown tag")
    return payload


async def restore_experience(repository, manifest: dict, curation: dict, bookmarks: list, payload: dict) -> None:
    tag_mapping = await restored_tag_mapping(repository, curation)
    existing = await repository.export_bookmarks()
    positions = {(bookmark.media_id, bookmark.position_seconds): bookmark.id for bookmark in existing}
    mapping = {bookmark.id: positions[(bookmark.media_id, bookmark.position_seconds)] for bookmark in bookmarks}
    await repository.restore_experience(payload, tag_mapping, mapping)
    await repository.restore_manual_covers(manifest["manual_covers"])
    await repository.import_tag_filing_snapshot(manifest["tag_filing"], tag_mapping=tag_mapping)
