from __future__ import annotations

from aiohttp import web

from ppvio.domain.recommendations import InvalidRating, parse_stars, score_library
from .client import _prefetch_requested

_MAX_RECOMMEND_LIMIT = 20


class PlayerRatingHttpMixin:
    """HTTP routes for persistent 1-5 star ratings and taste-ranked recommendations."""

    def _register_rating_routes(self, app: web.Application) -> None:
        app.router.add_get("/api/v1/ratings", self._ratings_list)
        app.router.add_post("/api/v1/ratings/sync", self._ratings_sync)
        app.router.add_put("/api/v1/media/{media_id}/rating", self._rating_put)
        app.router.add_delete("/api/v1/media/{media_id}/rating", self._rating_delete)
        app.router.add_post("/api/v1/feed/refresh", self._feed_refresh)
        app.router.add_get("/api/v1/recommendations", self._recommendations)

    async def _ratings_list(self, request: web.Request) -> web.Response:
        await self._authenticate(request)
        ratings = await self._repository.list_star_ratings()
        signals, tag_names = await self._repository.load_recommendation_signals()
        _, _, summary = score_library(signals)
        return web.json_response(
            {
                "ratings": ratings,
                "profile": {
                    "active": summary.active,
                    "rated_count": summary.rated_count,
                    "five_star_count": summary.five_star_count,
                    "disliked_count": summary.disliked_count,
                    "top_tags": [
                        {"id": tid, "name": tag_names.get(tid, f"#{tid}"), "score": score}
                        for tid, score in summary.top_tags
                        if tid in tag_names
                    ],
                },
            }
        )

    async def _ratings_sync(self, request: web.Request) -> web.Response:
        await self._authenticate(request)
        self._require_same_origin(request)
        payload = await self._json_object(request)
        raw = payload.get("ratings")
        if not isinstance(raw, dict) or len(raw) > 500:
            raise web.HTTPBadRequest(text="invalid ratings payload")
        synced = await self._repository.sync_star_ratings(raw)
        return web.json_response({"synced": synced})

    async def _rating_put(self, request: web.Request) -> web.Response:
        await self._authenticate(request)
        self._require_same_origin(request)
        media_id = request.match_info["media_id"]
        await self._media_details(media_id)
        payload = await self._json_object(request)
        try:
            stars = parse_stars(payload.get("stars"))
        except InvalidRating as exc:
            raise web.HTTPBadRequest(text=str(exc)) from None
        saved = await self._repository.set_star_rating(media_id, stars)
        return web.json_response({"id": media_id, "stars": saved})

    async def _rating_delete(self, request: web.Request) -> web.Response:
        await self._authenticate(request)
        self._require_same_origin(request)
        media_id = request.match_info["media_id"]
        await self._media_details(media_id)
        await self._repository.set_star_rating(media_id, 0)
        return web.json_response({"id": media_id, "stars": 0})

    async def _feed_refresh(self, request: web.Request) -> web.Response:
        digest = await self._authenticate(request)
        self._require_same_origin(request)
        await self._repository.reset_unconsumed_feed(digest)
        return web.json_response({"refreshed": True})

    async def _recommendations(self, request: web.Request) -> web.Response:
        digest = await self._authenticate(request)
        category = request.query.get("category", "all")
        if category not in {"all", "short", "long"}:
            raise web.HTTPBadRequest(text="invalid category")
        try:
            limit = int(request.query.get("limit", "20"))
            offset = int(request.query.get("offset", "0"))
        except ValueError:
            raise web.HTTPBadRequest(text="invalid paging") from None
        if not 1 <= limit <= _MAX_RECOMMEND_LIMIT or offset < 0:
            raise web.HTTPBadRequest(text="invalid paging")

        min_seconds = self._large_video_seconds if category == "long" else None
        max_seconds = self._large_video_seconds if category == "short" else None

        # Always learn taste across the ENTIRE library (short + long),
        # then rank candidates in the requested category.
        all_signals, tag_names = await self._repository.load_recommendation_signals()
        scores, disliked, summary = score_library(all_signals)
        watched = await self._repository.watched_media_ids()

        filtered = [
            s for s in all_signals
            if (min_seconds is None or (s.duration_seconds is not None and s.duration_seconds > min_seconds))
            and (max_seconds is None or (s.duration_seconds is not None and s.duration_seconds <= max_seconds))
        ]
        # Unwatched non-disliked ranked by taste score first, then watched loved ones, disliked last.
        ranked = sorted(
            filtered,
            key=lambda s: (
                2 if s.media_id in disliked else (1 if s.media_id in watched else 0),
                -scores.get(s.media_id, 0.0),
                s.media_id,
            ),
        )
        total = len(ranked)
        page_rows = ranked[offset : offset + limit]
        has_more = offset + len(page_rows) < total
        prefetch = _prefetch_requested(request)
        items = []
        for row in page_rows:
            details = await self._repository.active_media_details(row.media_id)
            if details is not None:
                dto = await self._media_dto(details, digest, prefetch=prefetch)
                dto["taste_score"] = scores.get(row.media_id, 0.0)
                items.append(dto)

        return web.json_response(
            {
                "items": items,
                "has_more": has_more,
                "total": total,
                "next_cursor": str(offset + len(page_rows)) if has_more else None,
                "profile": {
                    "active": summary.active,
                    "rated_count": summary.rated_count,
                    "five_star_count": summary.five_star_count,
                    "top_tags": [
                        {"id": tid, "name": tag_names.get(tid, f"#{tid}"), "score": score}
                        for tid, score in summary.top_tags
                        if tid in tag_names
                    ],
                },
            }
        )
