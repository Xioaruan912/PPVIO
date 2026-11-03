from __future__ import annotations

import asyncio
from contextlib import suppress
from dataclasses import asdict

from aiohttp import web

from ppvio.domain.bookmarks import (
    BookmarkLimitReached, InvalidBookmark, MAX_BOOKMARKS, valid_bookmark_id,
)


class PlayerBookmarkHttpMixin:
    def _register_bookmark_routes(self, app: web.Application) -> None:
        self._bookmark_snapshot_wake = asyncio.Event()
        if self._recovery_service is not None:
            app.cleanup_ctx.append(self._bookmark_snapshot_context)
        app.router.add_get("/api/v1/bookmarks", self._bookmarks_global)
        app.router.add_get("/api/v1/media/{media_id}/bookmarks", self._bookmarks_media)
        app.router.add_post("/api/v1/media/{media_id}/bookmarks", self._bookmark_add)
        app.router.add_delete("/api/v1/media/{media_id}/bookmarks/{bookmark_id}", self._bookmark_delete)

    async def _bookmark_snapshot_context(self, app: web.Application):
        task = asyncio.create_task(self._recovery_service.run_bookmark_snapshots(self._bookmark_snapshot_wake))
        try:
            yield
        finally:
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task

    async def _bookmarks_media(self, request: web.Request) -> web.Response:
        await self._authenticate(request)
        details = await self._media_details(request.match_info["media_id"])
        return web.json_response({"items": [asdict(b) for b in await self._repository.list_bookmarks(str(details["media_id"]))]})

    async def _bookmark_add(self, request: web.Request) -> web.Response:
        await self._authenticate(request)
        self._require_same_origin(request)
        details = await self._media_details(request.match_info["media_id"])
        payload = await self._json_object(request)
        if set(payload) - {"position_seconds", "name"}:
            raise web.HTTPBadRequest(text="invalid bookmark fields")
        try:
            bookmark = await self._repository.add_bookmark(
                str(details["media_id"]), payload.get("position_seconds"), payload.get("name"),
            )
        except BookmarkLimitReached as exc:
            raise web.HTTPConflict(text=str(exc)) from None
        except InvalidBookmark as exc:
            raise web.HTTPBadRequest(text=str(exc)) from None
        self._bookmark_snapshot_wake.set()
        return web.json_response(asdict(bookmark), status=201)

    async def _bookmark_delete(self, request: web.Request) -> web.Response:
        await self._authenticate(request)
        self._require_same_origin(request)
        details = await self._media_details(request.match_info["media_id"])
        bookmark_id = request.match_info["bookmark_id"]
        if not valid_bookmark_id(bookmark_id) or not await self._repository.delete_bookmark(str(details["media_id"]), bookmark_id):
            raise web.HTTPNotFound(text="bookmark not found")
        self._bookmark_snapshot_wake.set()
        return web.json_response({"deleted": True})

    async def _bookmarks_global(self, request: web.Request) -> web.Response:
        digest = await self._authenticate(request)
        if any(key not in {"offset", "limit"} or len(request.query.getall(key)) != 1 for key in request.query):
            raise web.HTTPBadRequest(text="invalid bookmark paging")
        try:
            offset = int(request.query.get("offset", "0"))
            limit = int(request.query.get("limit", "20"))
            if not 0 <= offset <= MAX_BOOKMARKS or not 1 <= limit <= 100:
                raise ValueError
        except ValueError:
            raise web.HTTPBadRequest(text="invalid bookmark paging") from None
        page = await self._repository.list_bookmark_page(offset=offset, limit=limit + 1)
        items = []
        for bookmark in page[:limit]:
            details = await self._repository.active_media_details(bookmark.media_id)
            if details is not None:
                items.append({**asdict(bookmark), "media": await self._media_dto(details, digest, prefetch=False)})
        return web.json_response({"items": items, "has_more": len(page) > limit})
