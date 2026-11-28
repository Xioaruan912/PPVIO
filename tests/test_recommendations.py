from __future__ import annotations

from pathlib import Path
import random
from tempfile import TemporaryDirectory
import unittest

from aiohttp.test_utils import TestClient, TestServer

from ppvio.adapters.http.server import PlayerHttpServer
from ppvio.application.auth import SessionService
from ppvio.application.feed import ShuffleDeckService
from ppvio.domain.catalog import CatalogCover, CatalogLocation, CatalogMedia, CatalogPackage
from ppvio.domain.recommendations import (
    InvalidRating,
    RecommendationSignal,
    parse_stars,
    recommended_cycle,
    score_library,
)
from ppvio.infrastructure.sqlite import PlayerCatalogRepositorySQLite


class RecommendationDomainTests(unittest.TestCase):
    def test_parse_stars_rejects_non_integer_and_out_of_range(self):
        self.assertEqual(parse_stars(0), 0)
        self.assertEqual(parse_stars(5), 5)
        for bad in (-1, 6, True, False, "5", 4.5, None):
            with self.subTest(bad=bad), self.assertRaises(InvalidRating):
                parse_stars(bad)

    def test_taste_propagates_via_tags_folder_and_visual_phash(self):
        signals = [
            RecommendationSignal(
                media_id=f"{1:064x}",
                stars=5,
                tag_ids=(10, 20),
                folder_key="/vault/creator_a",
                duration_seconds=35.0,
                width=720,
                height=1280,
                phash="0f0f0f0f0f0f0f0f",
                updated_at=100,
            ),
            RecommendationSignal(
                media_id=f"{2:064x}",
                stars=1,
                tag_ids=(99,),
                folder_key="/vault/creator_bad",
                duration_seconds=35.0,
                width=720,
                height=1280,
                phash="f0f0f0f0f0f0f0f0",
                updated_at=100,
            ),
            # Unrated match sharing tag + folder + close pHash
            RecommendationSignal(
                media_id=f"{3:064x}",
                stars=None,
                tag_ids=(10,),
                folder_key="/vault/creator_a",
                duration_seconds=40.0,
                width=720,
                height=1280,
                phash="0f0f0f0f0f0f0f0e",
            ),
            # Unrated video sharing disliked tag & folder
            RecommendationSignal(
                media_id=f"{4:064x}",
                stars=None,
                tag_ids=(99,),
                folder_key="/vault/creator_bad",
                duration_seconds=40.0,
                width=720,
                height=1280,
                phash="f0f0f0f0f0f0f0f1",
            ),
            # Neutral unrated item
            RecommendationSignal(
                media_id=f"{5:064x}",
                stars=None,
                tag_ids=(),
                folder_key="/vault/other",
                duration_seconds=120.0,
                width=1920,
                height=1080,
            ),
        ]
        scores, disliked, summary = score_library(signals)
        self.assertTrue(summary.active)
        self.assertEqual(summary.rated_count, 2)
        self.assertEqual(summary.five_star_count, 1)
        self.assertIn(f"{2:064x}", disliked)
        self.assertGreater(scores[f"{3:064x}"], scores[f"{5:064x}"])
        self.assertGreater(scores[f"{5:064x}"], scores[f"{4:064x}"])

        deck = recommended_cycle(
            [s.media_id for s in signals],
            preferred=frozenset(),
            watched=set(),
            recent=[],
            recent_target=0,
            scores=scores,
            disliked=disliked,
            rng=random.Random(7),
        )
        # Disliked 1-star video is always pushed to the very end.
        self.assertEqual(deck[-1], f"{2:064x}")
        # Top taste-matched unrated video surfaces ahead of disliked-tag video.
        self.assertLess(deck.index(f"{3:064x}"), deck.index(f"{4:064x}"))


class RecommendationHttpAndStorageTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = TemporaryDirectory()
        self.repo = PlayerCatalogRepositorySQLite(Path(self.tmp.name) / "player.sqlite3")
        await self.repo.open()
        self.ids = [f"{n:064x}" for n in range(1, 25)]
        # Split into two folders: creator_fav (1..12) and creator_other (13..24)
        await self.repo.apply_package(
            CatalogPackage(
                "pkg-fav",
                "lib/creator_fav/batch1",
                "a" * 64,
                None,
                None,
                tuple(CatalogMedia(m, "video", 500, width=720, height=1280, duration_seconds=30) for m in self.ids[:12]),
                tuple(CatalogLocation(m, "pkg-fav", f"{i}.mp4") for i, m in enumerate(self.ids[:12])),
                covers=tuple(
                    CatalogCover(m, "pkg-fav", f"{i}.jpg", 100, "image/jpeg", "midpoint", phash="0000ffff0000ffff")
                    for i, m in enumerate(self.ids[:12])
                ),
            )
        )
        await self.repo.apply_package(
            CatalogPackage(
                "pkg-other",
                "lib/creator_other/batch1",
                "b" * 64,
                None,
                None,
                tuple(CatalogMedia(m, "video", 500, width=1280, height=720, duration_seconds=90) for m in self.ids[12:]),
                tuple(CatalogLocation(m, "pkg-other", f"{i}.mp4") for i, m in enumerate(self.ids[12:])),
                covers=tuple(
                    CatalogCover(m, "pkg-other", f"{i}.jpg", 100, "image/jpeg", "midpoint", phash="ffff0000ffff0000")
                    for i, m in enumerate(self.ids[12:])
                ),
            )
        )
        await self.repo.refresh_media_activity()
        self.tag_love = (await self.repo.create_tag("最爱风格")).tag_id
        self.tag_meh = (await self.repo.create_tag("一般")).tag_id
        for m in self.ids[:12]:
            await self.repo.set_media_tag(m, self.tag_love, enabled=True)
        for m in self.ids[12:]:
            await self.repo.set_media_tag(m, self.tag_meh, enabled=True)

        self.sessions = SessionService(self.repo, access_secret="secret")
        self.deck = ShuffleDeckService(self.repo, rng=random.Random(42), recent_exclusion=2)
        self.http = PlayerHttpServer(self.repo, self.sessions, self.deck, reader=object())  # type: ignore[arg-type]
        self.server = TestServer(self.http.application())
        self.client = TestClient(self.server)
        await self.client.start_server()
        login = await self.client.post("/api/v1/auth/login", json={"secret": "secret"})
        self.assertEqual(login.status, 200)
        self.cookies = {"ppvio_session": login.cookies["ppvio_session"].value}
        self.origin = f"http://{self.server.host}:{self.server.port}"

    async def asyncTearDown(self):
        await self.client.close()
        await self.repo.close()
        self.tmp.cleanup()

    async def test_rating_persists_syncs_and_drives_feed_and_recommendations(self):
        headers = {"Origin": self.origin}
        # Rate 3 videos from fav folder as 5-star, and 2 from other folder as 1-star
        for m in self.ids[:3]:
            r = await self.client.put(f"/api/v1/media/{m}/rating", json={"stars": 5}, headers=headers, cookies=self.cookies)
            self.assertEqual(r.status, 200)
            self.assertEqual((await r.json())["stars"], 5)
        for m in self.ids[12:14]:
            r = await self.client.put(f"/api/v1/media/{m}/rating", json={"stars": 1}, headers=headers, cookies=self.cookies)
            self.assertEqual(r.status, 200)

        # Sync ignores already-rated ids and imports missing ones
        sync_resp = await self.client.post(
            "/api/v1/ratings/sync",
            json={"ratings": {self.ids[0]: 2, self.ids[3]: 4}},
            headers=headers,
            cookies=self.cookies,
        )
        self.assertEqual(sync_resp.status, 200)
        self.assertEqual((await sync_resp.json())["synced"], 1)

        ratings_resp = await self.client.get("/api/v1/ratings", cookies=self.cookies)
        self.assertEqual(ratings_resp.status, 200)
        payload = await ratings_resp.json()
        self.assertEqual(payload["ratings"][self.ids[0]], 5)  # server rating preserved
        self.assertEqual(payload["ratings"][self.ids[3]], 4)  # missing imported
        self.assertTrue(payload["profile"]["active"])
        self.assertEqual(payload["profile"]["top_tags"][0]["name"], "最爱风格")

        # Recommendations endpoint ranks unrated fav-cluster videos right at the top
        rec_resp = await self.client.get("/api/v1/recommendations?category=short&limit=10", cookies=self.cookies)
        self.assertEqual(rec_resp.status, 200)
        rec_items = (await rec_resp.json())["items"]
        self.assertEqual(len(rec_items), 10)
        fav_hits = sum(1 for item in rec_items if item["id"] in set(self.ids[:12]))
        self.assertGreaterEqual(fav_hits, 9)
        self.assertNotIn(self.ids[12], [i["id"] for i in rec_items])

        # Feed endpoint also reflects taste profile and includes rating on DTO
        refresh_resp = await self.client.post("/api/v1/feed/refresh", headers=headers, cookies=self.cookies)
        self.assertEqual(refresh_resp.status, 200)
        feed_resp = await self.client.get("/api/v1/feed?limit=8", cookies=self.cookies)
        self.assertEqual(feed_resp.status, 200)
        feed_items = (await feed_resp.json())["items"]
        self.assertEqual(len(feed_items), 8)
        feed_fav_hits = sum(1 for item in feed_items if item["id"] in set(self.ids[:12]))
        self.assertGreaterEqual(feed_fav_hits, 6)
        self.assertNotIn(self.ids[12], [i["id"] for i in feed_items])

        # Delete rating works cleanly
        del_resp = await self.client.delete(f"/api/v1/media/{self.ids[3]}/rating", headers=headers, cookies=self.cookies)
        self.assertEqual(del_resp.status, 200)
        media_resp = await self.client.get(f"/api/v1/media/{self.ids[3]}", cookies=self.cookies)
        self.assertIsNone((await media_resp.json())["rating"])
