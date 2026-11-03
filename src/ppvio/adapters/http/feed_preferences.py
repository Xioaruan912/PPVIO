from __future__ import annotations

from aiohttp import web

from ppvio.domain.feed_preferences import FeedPreferences, InvalidFeedPreferences


class PlayerFeedPreferencesHttpMixin:
    def _register_feed_preference_routes(self, app: web.Application) -> None:
        app.router.add_get("/api/v1/feed/preferences", self._feed_preferences)
        app.router.add_put("/api/v1/feed/preferences", self._feed_preferences_save)

    async def _feed_preferences(self, request: web.Request) -> web.Response:
        await self._authenticate(request)
        return web.json_response((await self._repository.get_feed_preferences()).to_json())

    async def _feed_preferences_save(self, request: web.Request) -> web.Response:
        await self._authenticate(request)
        self._require_same_origin(request)
        try:
            value = FeedPreferences.from_json(await self._json_object(request))
            saved = await self._repository.save_feed_preferences(value)
        except InvalidFeedPreferences as exc:
            raise web.HTTPBadRequest(text=str(exc)) from None
        return web.json_response(saved.to_json())
