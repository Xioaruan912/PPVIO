from __future__ import annotations

import re

from aiohttp import web

_VERSION = re.compile(r"^[0-9a-f]{64}$")


class PlayerPreviewHttpMixin:
    def _register_preview_routes(self, app: web.Application) -> None:
        path = "/api/v1/media/{media_id}/preview"
        app.router.add_post(path, self._preview_prepare)
        app.router.add_get(path, self._preview_status)
        app.router.add_get(path + "/{index}.jpg", self._preview_frame)

    async def _preview_prepare(self, request: web.Request) -> web.Response:
        await self._authenticate(request)
        self._require_same_origin(request)
        details = await self._media_details(request.match_info["media_id"])
        status = ({"state": "unavailable", "frames": []} if self._previews is None
                  else await self._previews.prepare(details))
        return web.json_response(self._preview_dto(str(details["media_id"]), status))

    async def _preview_status(self, request: web.Request) -> web.Response:
        await self._authenticate(request)
        details = await self._media_details(request.match_info["media_id"])
        status = ({"state": "unavailable", "frames": []} if self._previews is None
                  else await self._previews.status(details))
        return web.json_response(self._preview_dto(str(details["media_id"]), status))

    @staticmethod
    def _preview_dto(media_id: str, status: dict[str, object]) -> dict[str, object]:
        version = status.get("version")
        result: dict[str, object] = {"state": status["state"], "frames": []}
        if isinstance(version, str) and _VERSION.fullmatch(version):
            result["version"] = version
            result["frames"] = [{"index": frame["index"], "at": frame["at"],
                                 "url": f"/api/v1/media/{media_id}/preview/{frame['index']}.jpg?v={version}"}
                                for frame in status["frames"]]
        return result

    async def _preview_frame(self, request: web.Request) -> web.StreamResponse:
        await self._authenticate(request)
        details = await self._media_details(request.match_info["media_id"])
        raw_index = request.match_info["index"]
        version = request.query.get("v", "")
        if self._previews is None or raw_index not in {str(index) for index in range(8)} or not _VERSION.fullmatch(version):
            raise web.HTTPNotFound(text="preview not found")
        path = await self._previews.frame(details, int(raw_index), version)
        if path is None:
            raise web.HTTPNotFound(text="preview not found")
        return web.FileResponse(path, headers={"Content-Type": "image/jpeg", "Cache-Control": "private, no-store"})
