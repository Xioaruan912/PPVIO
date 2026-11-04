from __future__ import annotations

from aiohttp import web

from ppvio.domain.manual_covers import (
    InvalidManualCover, ManualCoverQuotaExceeded, MAX_MANUAL_COVER_BYTES, validate_cover_position,
)


class PlayerManualCoverHttpMixin:
    def _register_manual_cover_routes(self, app: web.Application) -> None:
        path = "/api/v1/media/{media_id}/manual-cover"
        app.router.add_get(path, self._manual_cover)
        app.router.add_put(path, self._save_manual_cover)
        app.router.add_delete(path, self._delete_manual_cover)

    async def _manual_cover(self, request: web.Request) -> web.Response:
        await self._authenticate(request)
        details = await self._media_details(request.match_info["media_id"])
        if not await self._repository.manual_cover_media_is_primary(str(details["media_id"])):
            raise web.HTTPNotFound(text="manual cover not found")
        cover = await self._repository.get_manual_cover(str(details["media_id"]))
        if (cover is None or set(request.query) - {"v"} or len(request.query.getall("v", [])) > 1
                or ("v" in request.query and request.query["v"] != cover["version"])):
            raise web.HTTPNotFound(text="manual cover not found")
        return web.Response(body=cover["jpeg"], content_type="image/jpeg", headers={"Cache-Control": "private, no-store"})

    async def _save_manual_cover(self, request: web.Request) -> web.Response:
        digest = await self._authenticate(request)
        self._require_same_origin(request)
        details = await self._media_details(request.match_info["media_id"])
        if not await self._repository.manual_cover_media_is_primary(str(details["media_id"])):
            raise web.HTTPNotFound(text="manual cover not found")
        if set(request.query) != {"at_seconds"} or len(request.query.getall("at_seconds", [])) != 1:
            raise web.HTTPBadRequest(text="invalid cover position query")
        try:
            position = validate_cover_position(float(request.query["at_seconds"]), details.get("duration_seconds"), require_duration=True)
        except (ValueError, OverflowError):
            raise web.HTTPBadRequest(text="invalid cover position") from None
        if request.content_type != "image/jpeg":
            raise web.HTTPUnsupportedMediaType(text="cover must be image/jpeg")
        if request.content_length is not None and request.content_length > MAX_MANUAL_COVER_BYTES:
            raise web.HTTPRequestEntityTooLarge(max_size=MAX_MANUAL_COVER_BYTES, actual_size=request.content_length)
        jpeg = bytearray()
        async for chunk in request.content.iter_chunked(16 * 1024):
            jpeg.extend(chunk)
            if len(jpeg) > MAX_MANUAL_COVER_BYTES:
                raise web.HTTPRequestEntityTooLarge(max_size=MAX_MANUAL_COVER_BYTES, actual_size=len(jpeg))
        try:
            await self._repository.save_manual_cover(str(details["media_id"]), bytes(jpeg), position)
        except ManualCoverQuotaExceeded:
            raise web.HTTPConflict(text="manual cover storage limit reached") from None
        except InvalidManualCover as exc:
            raise web.HTTPBadRequest(text=str(exc)) from None
        return web.json_response(await self._media_dto(details, digest), headers={"Cache-Control": "private, no-store"})

    async def _delete_manual_cover(self, request: web.Request) -> web.Response:
        digest = await self._authenticate(request)
        self._require_same_origin(request)
        details = await self._media_details(request.match_info["media_id"])
        if not await self._repository.manual_cover_media_is_primary(str(details["media_id"])):
            raise web.HTTPNotFound(text="manual cover not found")
        if request.query:
            raise web.HTTPBadRequest(text="unexpected cover query")
        await self._repository.delete_manual_cover(str(details["media_id"]))
        return web.json_response(await self._media_dto(details, digest), headers={"Cache-Control": "private, no-store"})
