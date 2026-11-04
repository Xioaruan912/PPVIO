from __future__ import annotations

from aiohttp import web

from ppvio.domain.tag_filing import TagFilingError, media_identifier


class PlayerTagFilingHttpMixin:
    """The host provides _tag_filing, session auth and the existing origin guard."""
    def _register_tag_filing_routes(self, app: web.Application) -> None:
        app.router.add_get('/api/v1/tag-filing', self._tag_filing_status)
        app.router.add_post('/api/v1/tag-filing/retry', self._tag_filing_retry)
        app.router.add_post('/api/v1/tag-filing/organize', self._tag_filing_organize)
        app.router.add_get('/api/v1/media/{media_id}/tag-filing', self._tag_filing_status)
        app.router.add_post('/api/v1/media/{media_id}/tag-filing', self._tag_filing_request)
        app.router.add_post('/api/v1/media/{media_id}/tag-filing/retry', self._tag_filing_retry)

    def _filing_service(self):
        service = getattr(self, '_tag_filing', None)
        if service is None:
            raise web.HTTPServiceUnavailable(text='tag filing unavailable')
        return service

    @staticmethod
    def _filing_media_id(request: web.Request) -> str | None:
        value = request.match_info.get('media_id')
        try:
            return None if value is None else media_identifier(value)
        except TagFilingError:
            raise web.HTTPNotFound(text='media not found') from None

    async def _tag_filing_status(self, request: web.Request) -> web.Response:
        await self._authenticate(request)
        return web.json_response(await self._filing_service().status(self._filing_media_id(request)))

    async def _tag_filing_retry(self, request: web.Request) -> web.Response:
        await self._authenticate(request)
        self._require_same_origin(request)
        count = await self._filing_service().retry_now(self._filing_media_id(request))
        return web.json_response({'retried': count}, status=202)

    async def _tag_filing_request(self, request: web.Request) -> web.Response:
        await self._authenticate(request)
        self._require_same_origin(request)
        try:
            state = await self._filing_service().request(self._filing_media_id(request))
        except TagFilingError as exc:
            raise web.HTTPConflict(text=str(exc)) from None
        if state is None:
            raise web.HTTPNotFound(text='media not found')
        return web.json_response(state, status=202)

    async def _tag_filing_organize(self, request: web.Request) -> web.Response:
        await self._authenticate(request)
        self._require_same_origin(request)
        return web.json_response(await self._filing_service().request_existing_tagged(), status=202)
