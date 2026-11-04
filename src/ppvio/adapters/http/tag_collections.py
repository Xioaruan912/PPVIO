from __future__ import annotations

from aiohttp import web

from ppvio.domain.library_experience import InvalidExperience, validate_paging
from ppvio.domain.tags import InvalidTag


class PlayerTagCollectionHttpMixin:
    """Authenticated label wall plus explicit, guarded legacy migration actions."""

    def _register_tag_collection_routes(self, app: web.Application) -> None:
        app.router.add_get('/api/v1/tag-collections', self._tag_collections_get)
        app.router.add_post('/api/v1/tag-collections/import-legacy', self._legacy_tag_groups_import)
        app.router.add_post('/api/v1/tag-collections/retire-legacy', self._legacy_tag_groups_retire)

    async def _tag_collections_get(self, request):
        digest = await self._authenticate(request)
        if any(key not in {'tag_id', 'offset', 'limit'} or len(request.query.getall(key)) != 1 for key in request.query):
            raise web.HTTPBadRequest(text='invalid tag collection query')
        try:
            offset = int(request.query.get('offset', '0'))
            limit = int(request.query.get('limit', '20'))
            tag_id = int(request.query['tag_id']) if 'tag_id' in request.query else None
            validate_paging(offset, limit)
            if limit > 100:
                raise ValueError('invalid paging')
            ids = await self._repository.tag_collection_ids(tag_id=tag_id, offset=offset, limit=limit + 1)
        except (ValueError, InvalidExperience, InvalidTag):
            raise web.HTTPBadRequest(text='invalid tag collection query') from None
        items = []
        for identity in ids[:limit]:
            details = await self._repository.active_media_details(identity)
            if details is not None:
                items.append(await self._media_dto(details, digest, prefetch=False))
        return web.json_response({'items': items, 'has_more': len(ids) > limit})

    async def _legacy_tag_group_action(self, request, *, retire):
        await self._authenticate(request)
        self._require_same_origin(request)
        service = getattr(self, '_legacy_tag_groups', None)
        if service is None:
            raise web.HTTPServiceUnavailable(text='legacy group migration unavailable')
        value = await self._json_object(request)
        if set(value) - ({'cleanup_limit'} if retire else set()):
            raise web.HTTPBadRequest(text='invalid request fields')
        try:
            if retire:
                result = await service.retire_legacy(cleanup_limit=value.get('cleanup_limit', 100))
            else:
                result = await service.import_legacy()
        except (ValueError, InvalidTag) as exc:
            raise web.HTTPBadRequest(text=str(exc)) from None
        wake = getattr(self, '_bookmark_snapshot_wake', None)
        if wake is not None:
            wake.set()
        return web.json_response(result)

    async def _legacy_tag_groups_import(self, request):
        return await self._legacy_tag_group_action(request, retire=False)

    async def _legacy_tag_groups_retire(self, request):
        return await self._legacy_tag_group_action(request, retire=True)
