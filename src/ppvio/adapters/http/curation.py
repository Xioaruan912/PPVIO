from __future__ import annotations

from aiohttp import web

from ppvio.domain.curation import MAX_ORGANIZED, InvalidCuration


class PlayerCurationHttpMixin:
    def _register_curation_routes(self, app: web.Application) -> None:
        app.router.add_get("/api/v1/curation", self._curation_list)
        app.router.add_post("/api/v1/curation/batch", self._curation_batch)

    async def _curation_list(self, request: web.Request) -> web.Response:
        digest = await self._authenticate(request)
        if any(key not in {"organized", "offset", "limit"} or len(request.query.getall(key)) != 1
               for key in request.query):
            raise web.HTTPBadRequest(text="invalid curation paging")
        try:
            organized = request.query.get("organized", "false")
            offset, limit = int(request.query.get("offset", "0")), int(request.query.get("limit", "20"))
            if organized not in {"false", "true"} or not 0 <= offset <= MAX_ORGANIZED or not 1 <= limit <= 100:
                raise ValueError
        except ValueError:
            raise web.HTTPBadRequest(text="invalid curation paging") from None
        ids = await self._repository.list_curation_ids(organized=organized == "true", offset=offset, limit=limit + 1)
        items = []
        for media_id in ids[:limit]:
            details = await self._repository.active_media_details(media_id)
            if details is not None:
                items.append(await self._media_dto(details, digest, prefetch=False))
        return web.json_response({"items": items, "has_more": len(ids) > limit})

    async def _curation_batch(self, request: web.Request) -> web.Response:
        await self._authenticate(request)
        self._require_same_origin(request)
        payload = await self._json_object(request)
        if set(payload) - {"media_ids", "add_tags", "remove_tags", "organized"}:
            raise web.HTTPBadRequest(text="invalid curation fields")
        try:
            changed = await self._repository.batch_curate(
                payload.get("media_ids"), add_tags=payload.get("add_tags", []),
                remove_tags=payload.get("remove_tags", []), organized=payload.get("organized"),
            )
        except InvalidCuration as exc:
            raise web.HTTPBadRequest(text=str(exc)) from None
        wake = getattr(self, "_bookmark_snapshot_wake", None)
        if wake is not None:
            wake.set()
        if payload.get("add_tags") or payload.get("remove_tags") or payload.get("organized") is True:
            for media_id in payload["media_ids"]:
                await self._queue_tag_filing(media_id)
        return web.json_response({"changed": changed})
