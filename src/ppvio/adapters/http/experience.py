from __future__ import annotations

from aiohttp import web

from ppvio.domain.bookmarks import valid_bookmark_id
from ppvio.domain.library_experience import (
    MAX_HISTORY, InvalidExperience, channel_identifier, validate_paging,
)
from ppvio.domain.tags import InvalidTag
from ppvio.adapters.http.tags import _tag_id


def _page(request: web.Request, *, maximum: int = 100000) -> tuple[int, int]:
    if any(key not in {'offset', 'limit'} or len(request.query.getall(key)) != 1 for key in request.query):
        raise web.HTTPBadRequest(text='invalid paging')
    try:
        offset, limit = int(request.query.get('offset', '0')), int(request.query.get('limit', '20'))
        validate_paging(offset, limit, maximum=maximum)
        if limit > 100:
            raise InvalidExperience('invalid paging')
    except (ValueError, InvalidExperience):
        raise web.HTTPBadRequest(text='invalid paging') from None
    return offset, limit


def _channel_id(request: web.Request) -> str:
    try:
        return channel_identifier(request.match_info['channel_id'])
    except InvalidExperience:
        raise web.HTTPNotFound(text='channel not found') from None


class PlayerExperienceHttpMixin:
    def _register_experience_routes(self, app: web.Application) -> None:
        app.router.add_get('/api/v1/history/settings', self._history_settings_get)
        app.router.add_put('/api/v1/history/settings', self._history_settings_put)
        app.router.add_get('/api/v1/history', self._history_get)
        app.router.add_post('/api/v1/history', self._history_record)
        app.router.add_delete('/api/v1/history', self._history_clear)
        app.router.add_delete('/api/v1/history/{media_id}', self._history_clear)
        app.router.add_get('/api/v1/channels', self._channels_get)
        app.router.add_post('/api/v1/channels', self._channel_create)
        app.router.add_post('/api/v1/channels/query', self._channel_query)
        app.router.add_patch('/api/v1/channels/{channel_id}', self._channel_update)
        app.router.add_delete('/api/v1/channels/{channel_id}', self._channel_delete)
        app.router.add_get('/api/v1/channels/{channel_id}/items', self._channel_items)
        app.router.add_put('/api/v1/media/{media_id}/premium', self._premium_put)
        app.router.add_get('/api/v1/tag-catalog', self._tag_catalog_get)
        app.router.add_patch('/api/v1/tag-catalog/{tag_id}', self._tag_catalog_update)
        app.router.add_post('/api/v1/tag-catalog/merge', self._tag_catalog_merge)
        path = '/api/v1/media/{media_id}/bookmarks/{bookmark_id}/tags'
        app.router.add_get(path, self._bookmark_tags_get)
        app.router.add_put(path, self._bookmark_tags_put)

    async def _experience_payload(self, request, allowed, required=()) -> dict:
        value = await self._json_object(request)
        if set(value) - set(allowed) or not set(required) <= set(value):
            raise web.HTTPBadRequest(text='invalid request fields')
        return value

    def _experience_wake(self) -> None:
        event = getattr(self, '_bookmark_snapshot_wake', None)
        if event is not None:
            event.set()

    async def _history_settings_get(self, request):
        await self._authenticate(request)
        return web.json_response(await self._repository.get_history_settings())

    async def _history_settings_put(self, request):
        await self._authenticate(request)
        self._require_same_origin(request)
        value = await self._experience_payload(request, {'enabled'}, {'enabled'})
        try:
            state = await self._repository.set_history_enabled(value['enabled'])
        except InvalidExperience as exc:
            raise web.HTTPBadRequest(text=str(exc)) from None
        return web.json_response(state)

    async def _history_record(self, request):
        await self._authenticate(request)
        self._require_same_origin(request)
        value = await self._experience_payload(request, {'media_id', 'position_seconds', 'epoch'},
                                                {'media_id', 'position_seconds', 'epoch'})
        if not isinstance(value['media_id'], str):
            raise web.HTTPBadRequest(text='invalid media identifier')
        await self._media_details(value['media_id'])
        try:
            recorded = await self._repository.record_history(value['media_id'], value['position_seconds'], epoch=value['epoch'])
        except InvalidExperience as exc:
            raise web.HTTPBadRequest(text=str(exc)) from None
        return web.json_response({'recorded': recorded})

    async def _history_get(self, request):
        digest = await self._authenticate(request)
        offset, limit = _page(request, maximum=MAX_HISTORY)
        rows = await self._repository.list_history(offset=offset, limit=limit+1)
        items = []
        for row in rows[:limit]:
            details = await self._repository.active_media_details(row['media_id'])
            if details is not None:
                dto = await self._media_dto(details, digest, prefetch=False)
                items.append({**dto, 'seen_at': row['seen_at'], 'position_seconds': row['position_seconds']})
        return web.json_response({'items': items, 'has_more': len(rows) > limit})

    async def _history_clear(self, request):
        await self._authenticate(request)
        self._require_same_origin(request)
        media_id = request.match_info.get('media_id')
        try:
            state = await self._repository.clear_history(media_id)
        except InvalidExperience:
            raise web.HTTPNotFound(text='media not found') from None
        return web.json_response(state)

    async def _channels_get(self, request):
        await self._authenticate(request)
        return web.json_response({'items': await self._repository.list_channels()})

    async def _channel_create(self, request):
        await self._authenticate(request)
        self._require_same_origin(request)
        value = await self._experience_payload(request, {'name', 'filters'}, {'name'})
        try:
            channel = await self._repository.create_channel(value['name'], value.get('filters', {}))
        except InvalidExperience as exc:
            raise web.HTTPBadRequest(text=str(exc)) from None
        self._experience_wake()
        return web.json_response(channel, status=201)

    async def _channel_update(self, request):
        await self._authenticate(request)
        self._require_same_origin(request)
        value = await self._experience_payload(request, {'name', 'filters'})
        try:
            channel = await self._repository.update_channel(_channel_id(request), value)
        except InvalidExperience as exc:
            raise web.HTTPBadRequest(text=str(exc)) from None
        if channel is None:
            raise web.HTTPNotFound(text='channel not found')
        self._experience_wake()
        return web.json_response(channel)

    async def _channel_delete(self, request):
        await self._authenticate(request)
        self._require_same_origin(request)
        if not await self._repository.delete_channel(_channel_id(request)):
            raise web.HTTPNotFound(text='channel not found')
        self._experience_wake()
        return web.json_response({'deleted': True})

    async def _channel_page(self, filters, digest, offset, limit):
        try:
            ids = await self._repository.query_channel_ids(filters, offset=offset, limit=limit+1,
                                                           large_video_seconds=self._large_video_seconds)
        except InvalidExperience as exc:
            raise web.HTTPBadRequest(text=str(exc)) from None
        items = []
        for media_id in ids[:limit]:
            details = await self._repository.active_media_details(media_id)
            if details is not None:
                items.append(await self._media_dto(details, digest, prefetch=False))
        return web.json_response({'items': items, 'has_more': len(ids) > limit})

    async def _channel_items(self, request):
        digest = await self._authenticate(request)
        offset, limit = _page(request)
        channel = await self._repository.get_channel(_channel_id(request))
        if channel is None:
            raise web.HTTPNotFound(text='channel not found')
        return await self._channel_page(channel['filters'], digest, offset, limit)

    async def _channel_query(self, request):
        digest = await self._authenticate(request)
        self._require_same_origin(request)
        value = await self._experience_payload(request, {'filters', 'offset', 'limit'}, {'filters'})
        offset, limit = value.get('offset', 0), value.get('limit', 20)
        try:
            validate_paging(offset, limit)
            if limit > 100:
                raise InvalidExperience('invalid paging')
        except InvalidExperience as exc:
            raise web.HTTPBadRequest(text=str(exc)) from None
        return await self._channel_page(value['filters'], digest, offset, limit)

    async def _premium_put(self, request):
        digest = await self._authenticate(request)
        self._require_same_origin(request)
        details = await self._media_details(request.match_info['media_id'])
        value = await self._experience_payload(request, {'premium'}, {'premium'})
        try:
            updated = await self._repository.set_premium(str(details['media_id']), value['premium'])
        except InvalidExperience as exc:
            raise web.HTTPBadRequest(text=str(exc)) from None
        if not updated:
            raise web.HTTPNotFound(text='media not found')
        self._experience_wake()
        return web.json_response({**await self._media_dto(details, digest, prefetch=False), 'premium': value['premium']})

    async def _tag_catalog_get(self, request):
        await self._authenticate(request)
        return web.json_response({'items': await self._repository.list_tag_catalog()})

    async def _tag_catalog_update(self, request):
        await self._authenticate(request)
        self._require_same_origin(request)
        value = await self._experience_payload(request, {'name', 'aliases', 'parent_id'})
        try:
            tag = await self._repository.update_tag_details(_tag_id(request), value)
        except (InvalidTag, InvalidExperience) as exc:
            raise web.HTTPBadRequest(text=str(exc)) from None
        if tag is None:
            raise web.HTTPNotFound(text='tag not found')
        self._experience_wake()
        return web.json_response(tag)

    async def _tag_catalog_merge(self, request):
        await self._authenticate(request)
        self._require_same_origin(request)
        value = await self._experience_payload(request, {'source_ids', 'target_id'}, {'source_ids', 'target_id'})
        try:
            async with self._repository.recovery_transaction():
                items = await self._repository.merge_tags(value['source_ids'], value['target_id'])
                await self._repository.remap_tag_filing_tag_ids({source: value['target_id'] for source in value['source_ids']})
        except (InvalidTag, InvalidExperience) as exc:
            raise web.HTTPBadRequest(text=str(exc)) from None
        self._experience_wake()
        return web.json_response({'items': items})

    async def _bookmark_tags(self, request, *, save: bool):
        await self._authenticate(request)
        if save:
            self._require_same_origin(request)
        details = await self._media_details(request.match_info['media_id'])
        bookmark_id = request.match_info['bookmark_id']
        if not valid_bookmark_id(bookmark_id):
            raise web.HTTPNotFound(text='bookmark not found')
        try:
            if save:
                value = await self._experience_payload(request, {'tag_ids'}, {'tag_ids'})
                tags = await self._repository.set_bookmark_tags(str(details['media_id']), bookmark_id, value['tag_ids'])
            else:
                tags = await self._repository.bookmark_tag_ids(str(details['media_id']), bookmark_id)
        except InvalidExperience as exc:
            raise web.HTTPBadRequest(text=str(exc)) from None
        if tags is None:
            raise web.HTTPNotFound(text='bookmark not found')
        if save:
            self._experience_wake()
        return web.json_response({'tag_ids': tags})

    async def _bookmark_tags_get(self, request):
        return await self._bookmark_tags(request, save=False)

    async def _bookmark_tags_put(self, request):
        return await self._bookmark_tags(request, save=True)
