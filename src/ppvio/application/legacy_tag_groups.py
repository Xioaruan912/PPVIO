"""Import group labels first; retire metadata only after all originals are verified."""
from __future__ import annotations

import asyncio
import json

from ppvio.application.collection_backup import folder_names
from ppvio.domain.storage_settings import safe_storage_relpath


class LegacyTagGroupService:
    def __init__(self, repository, *, writer) -> None:
        self._repository = repository
        self._writer = writer
        self._lock = asyncio.Lock()

    async def import_legacy(self) -> dict:
        async with self._lock:
            return await self._repository.import_legacy_groups_to_tags()

    async def retire_legacy(self, *, cleanup_limit: int = 100) -> dict:
        if type(cleanup_limit) is not int or not 0 <= cleanup_limit <= 1000:
            raise ValueError("cleanup limit must be 0..1000")
        async with self._lock:
            result = {"retired_groups": 0, "blocked_media": 0, "blocked": {},
                      "cleanup_removed": 0, "cleanup_missing": 0,
                      "cleanup_blocked": 0, "cleanup_remaining": 0}
            snapshot = await self._repository.legacy_group_snapshot()
            writer = self._writer()
            if snapshot["groups"]:
                await self._verify_members(snapshot, writer, result)
                if not result["blocked"]:
                    folders = folder_names([(g["collection_id"], g["name"], g["created_at"])
                        for g in snapshot["groups"]], {snapshot["settings"]["favorites_dir"]})
                    count = await self._repository.retire_verified_legacy_groups(snapshot, folders)
                    if count is None:
                        self._block(result, "legacy_groups_changed")
                    else:
                        result["retired_groups"] = count
            # A blocked verification never authorizes deleting even a previous orphan copy.
            if not result["blocked"] and writer is not None:
                await self._cleanup(writer, cleanup_limit, result)
            result["cleanup_remaining"] = len(await self._repository.legacy_cleanup_rows())
            return result

    @staticmethod
    def _block(result, code, count=1):
        result["blocked"][code] = result["blocked"].get(code, 0) + count

    async def _verify_members(self, snapshot, writer, result):
        settings = snapshot["settings"]
        if settings is None or writer is None:
            self._block(result, "storage_unavailable")
            result["blocked_media"] = len({m["media_id"] for m in snapshot["members"]})
            return
        mappings = {}
        for group in snapshot["groups"]:
            try:
                value = json.loads(group["rules_json"] or "{}").get("_ppvio_legacy_tag", {})
                tag = value.get("tag_id")
            except (ValueError, AttributeError):
                tag = None
            if type(tag) is not int or tag not in snapshot["tags"]:
                self._block(result, "group_not_imported")
            else:
                mappings[group["collection_id"]] = tag
        filings = {row["media_id"]: row for row in snapshot["filings"]}
        bindings = set(snapshot["bindings"])
        failures, verified = {}, set()
        for member in snapshot["members"]:
            identity = member["media_id"]
            tag = mappings.get(member["collection_id"])
            if tag is None or (identity, tag) not in bindings:
                failures[identity] = "membership_not_imported"
                continue
            if identity in verified or identity in failures:
                continue
            filing = filings.get(identity)
            if not member["active"] or member["kind"] != "video" or member["deleted"] or member["variant"] or member["size_bytes"] <= 0:
                failures[identity] = "media_unavailable"
            elif filing is None or filing["status"] != "synced" or filing["plan_source"] is not None or (
                filing["primary_tag_id"] is None or filing["primary_tag_id"] != filing["desired_tag_id"] or
                (identity, filing["primary_tag_id"]) not in bindings
            ):
                failures[identity] = "filing_not_synced"
            elif filing["source_endpoint"] != settings["endpoint_url"]:
                failures[identity] = "storage_changed"
            else:
                try:
                    path = safe_storage_relpath(filing["current_path"])
                    remote = await writer.stat(path)
                except Exception:
                    failures[identity] = "target_unavailable"
                    continue
                if remote is None:
                    failures[identity] = "target_missing"
                elif remote.size_bytes != member["size_bytes"]:
                    failures[identity] = "target_size_mismatch"
                else:
                    verified.add(identity)
        for reason in failures.values():
            self._block(result, reason)
        result["blocked_media"] = len(failures)

    @staticmethod
    def _cleanup_path(row, settings):
        authority = row.get("authority")
        if not isinstance(authority, dict) or settings is None:
            return None
        if authority.get("player_root") != settings["player_root"] or authority.get("endpoint_url") != settings["endpoint_url"]:
            return None
        folder = authority.get("folder")
        try:
            root = safe_storage_relpath(settings["player_root"])
            relpath = safe_storage_relpath(row["relpath"])
            if not isinstance(folder, str) or "/" in folder or folder.casefold() == settings["favorites_dir"].casefold():
                return None
            safe_storage_relpath(folder)
            if not relpath.startswith(folder + "/"):
                return None
            return safe_storage_relpath(f"{root}/{relpath}")
        except (ValueError, TypeError):
            return None

    async def _cleanup(self, writer, limit, result):
        settings = await self._repository.get_storage_settings()
        setting_values = {"player_root": settings.player_root, "endpoint_url": settings.endpoint_url,
                          "favorites_dir": settings.favorites_dir}
        for row in await self._repository.legacy_cleanup_rows(limit=limit):
            path = self._cleanup_path(row, setting_values)
            if row["relpath"] is None:
                # A never-created copy has no remote object to delete.
                async with self._repository.legacy_cleanup_guard(row) as guard:
                    if guard is not None:
                        guard["complete"]()
                continue
            if path is None or type(row["size_bytes"]) is not int or row["size_bytes"] <= 0:
                result["cleanup_blocked"] += 1
                continue
            try:
                remote = await writer.stat(path)
                async with self._repository.legacy_cleanup_guard(row) as guard:
                    if guard is None or self._cleanup_path(row, guard["settings"]) != path or any(
                        protected == path or protected.startswith(path + "/") or path.startswith(protected + "/")
                        for protected in guard["protected_paths"]
                    ):
                        result["cleanup_blocked"] += 1
                        continue
                    if remote is None:
                        guard["complete"]()
                        result["cleanup_missing"] += 1
                    elif remote.size_bytes != row["size_bytes"]:
                        result["cleanup_blocked"] += 1
                    else:
                        # Only this checked file is deleted; no directory DELETE is issued.
                        receipt = await writer.delete(path)
                        if receipt.deleted:
                            guard["complete"]()
                            result["cleanup_removed"] += 1
                        else:
                            result["cleanup_blocked"] += 1
            except Exception:
                result["cleanup_blocked"] += 1
