"""One-at-a-time server-side MOVEs, recoverable after any interrupted await."""
from __future__ import annotations

import asyncio
from pathlib import PurePosixPath
import re
import time
from typing import Callable

from ppvio.domain.tag_filing import (
    TagFilingError, destination, filing_path, media_identifier, public_state,
)
from ppvio.domain.storage_settings import validate_webdav_endpoint


class TagFilingService:
    def __init__(self, repository: object, *, writer: Callable[[], object | None],
                 on_moved=None, clock: Callable[[], float] = time.time) -> None:
        self._repository = repository
        self._writer = writer
        self._on_moved = on_moved
        self._clock = clock
        self._lock = asyncio.Lock()
        self._wake = asyncio.Event()
        self._active: str | None = None

    def _now(self) -> int:
        return int(self._clock())

    async def request(self, media_id: str) -> dict | None:
        row = await self._repository.request_tag_filing(media_identifier(media_id), now=self._now())
        self._wake.set()
        return None if row is None else public_state(row)

    async def request_existing_tagged(self) -> dict:
        """Explicit organization only; startup and recovery never call this."""
        requested, errors = 0, {}
        for media_id in await self._repository.existing_tagged_media_ids():
            try:
                state = await self.request(media_id)
                requested += int(state is not None)
            except TagFilingError as exc:
                code = str(exc)
                errors[code] = errors.get(code, 0) + 1
        return {"requested": requested, "failed": sum(errors.values()), "errors": errors}

    async def is_busy(self, media_id: str) -> bool:
        if self._active == media_id:
            return True
        row = await self._repository.tag_filing_record(media_id)
        return row is not None and (row["plan_source"] is not None or row["status"] in {"pending", "moving", "retry"})

    async def status(self, media_id: str | None = None) -> dict:
        if media_id is not None:
            media_identifier(media_id)
        return await self._repository.tag_filing_status(media_id)

    async def retry_now(self, media_id: str | None = None) -> int:
        if media_id is not None:
            media_identifier(media_id)
        count = await self._repository.retry_tag_filing_now(now=self._now(), media_id=media_id)
        self._wake.set()
        return count

    async def run_due(self) -> bool:
        # One instance owns all MOVEs; request() may still update desired generations.
        async with self._lock:
            row = await self._repository.next_due_tag_filing(now=self._now())
            if row is None:
                return False
            identity = str(row["media_id"])
            self._active = identity
            try:
                if await self._repository.is_media_deletion_queued(identity):
                    raise TagFilingError("media_deletion_queued")
                writer = self._writer()
                if writer is None:
                    raise TagFilingError("storage_unavailable")
                if row["plan_source"] is None:
                    row = await self._prepare(row, writer)
                    if row is None:
                        return True
                await self._reconcile(row, writer)
            except Exception as exc:
                # Never persist exception messages: transports can include paths or credentials.
                code = str(exc) if isinstance(exc, TagFilingError) else getattr(exc, "category", "storage_error")
                if not isinstance(code, str) or not re.fullmatch(r"[a-z_]{1,64}", code):
                    code = "storage_error"
                wait = min(3600, 60 * 2 ** min(6, int(row["attempts"])))
                await self._repository.fail_tag_filing(identity, error=code,
                    due=self._now() + wait, now=self._now(),
                    unsupported=code in {"move_unsupported", "unsupported_filename", "unsupported_source", "storage_changed"})
            finally:
                self._active = None
            return True

    async def _prepare(self, row: dict, writer) -> dict | None:
        await self._check_storage(row)
        identity = str(row["media_id"])
        desired = row["desired_tag_id"]
        # Renaming tags and adding secondary labels preserve the primary's location.
        if desired == row["primary_tag_id"] and (desired is not None or row["current_path"] == row["origin_path"]):
            await self._repository.settle_tag_filing(identity, generation=row["generation"], now=self._now())
            return None
        roots = await self._repository.get_libraries()
        if row["library_root"] not in roots:
            raise TagFilingError("library_changed")
        if desired is None:
            target = str(row["origin_path"])
        else:
            name = await self._repository.tag_filing_tag_name(desired)
            if name is None:
                # A tag deletion raced this worker; recalculate membership before planning.
                await self.request(identity)
                return None
            target = destination(row["library_root"], name, desired, row["origin_path"])
            if PurePosixPath(target).suffix.lower() not in {".mp4", ".m4v", ".mov", ".webm", ".mkv"}:
                # A file the plain catalog cannot rediscover must not be relocated.
                raise TagFilingError("unsupported_filename")
        if target == row["current_path"]:
            await self._repository.settle_tag_filing(identity, generation=row["generation"], now=self._now())
            return None
        source = await writer.stat(filing_path(row["current_path"]))
        if source is None:
            raise TagFilingError("source_missing")
        details = await self._repository.active_media_details(identity)
        if details is not None and source.size_bytes != details["size_bytes"]:
            raise TagFilingError("source_changed")
        etag = await self._repository.tag_filing_source_etag(identity)
        if etag is not None and source.etag != etag:
            raise TagFilingError("source_changed")
        if await writer.stat(target) is not None or await self._repository.tag_filing_path_reserved(target, identity):
            if desired is None:
                raise TagFilingError("target_conflict")
            # Archive packages commonly call every original video.mp4. Use a stable
            # disambiguator while keeping the first free original basename intact.
            path = PurePosixPath(target)
            target = filing_path(str(path.with_name(f"{path.stem}--{identity[:16]}{path.suffix}")))
            if await writer.stat(target) is not None or await self._repository.tag_filing_path_reserved(target, identity):
                raise TagFilingError("target_conflict")
        return await self._repository.plan_tag_filing(identity, target=target,
            size=source.size_bytes, etag=source.etag, generation=row["generation"], now=self._now())

    async def _reconcile(self, row: dict, writer) -> None:
        await self._check_storage(row)
        source_path, target_path = row["plan_source"], row["plan_target"]
        source = await writer.stat(source_path)
        target = await writer.stat(target_path)
        if source is None:
            if target is None:
                raise TagFilingError("source_and_target_missing")
            if target.size_bytes != row["plan_size"]:
                raise TagFilingError("target_changed")
            await self._complete(row, target.etag)
            return
        if source.size_bytes != row["plan_size"] or (
            row["plan_etag"] is not None and source.etag != row["plan_etag"]
        ):
            raise TagFilingError("source_changed")
        if await self._repository.abandon_superseded_tag_filing_plan(row["media_id"], now=self._now()):
            return
        if target is not None or await self._repository.tag_filing_path_reserved(target_path, row["media_id"]):
            raise TagFilingError("target_conflict")
        await writer.ensure_directory(str(PurePosixPath(target_path).parent))
        # Persisted plan precedes this call. Cancellation/connection loss leaves it
        # intact for source+destination stat on the next worker/restart.
        await writer.move(source_path, target_path, overwrite=False, source_etag=row["plan_etag"])
        source = await writer.stat(source_path)
        target = await writer.stat(target_path)
        if source is not None or target is None or target.size_bytes != row["plan_size"]:
            raise TagFilingError("move_unconfirmed")
        await self._complete(row, target.etag)

    async def _check_storage(self, row: dict) -> None:
        settings = await self._repository.get_storage_settings()
        if validate_webdav_endpoint(settings.endpoint_url) != row["source_endpoint"]:
            raise TagFilingError("storage_changed")

    async def _complete(self, row: dict, etag: str | None) -> None:
        await self._repository.finish_tag_filing(row["media_id"], etag=etag, now=self._now())
        if self._on_moved is not None:
            await self._on_moved(row["media_id"])

    async def run(self, stop: asyncio.Event) -> None:
        while not stop.is_set():
            self._wake.clear()
            try:
                worked = await self.run_due()
            except Exception:
                worked = False
            if worked:
                continue
            stopper = asyncio.create_task(stop.wait())
            waker = asyncio.create_task(self._wake.wait())
            try:
                await asyncio.wait({stopper, waker}, timeout=30, return_when=asyncio.FIRST_COMPLETED)
            finally:
                stopper.cancel()
                waker.cancel()
