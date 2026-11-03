from __future__ import annotations

from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from aiohttp.test_utils import TestClient, TestServer

from ppvio.adapters.http import PlayerHttpServer
from ppvio.application.auth import SessionService
from ppvio.application.feed import ShuffleDeckService
from ppvio.infrastructure.sqlite import PlayerCatalogRepositorySQLite


class DummyReader:
    async def open_range(self, *args):
        raise AssertionError("unexpected streaming")


class FeedPreferenceHttpTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = TemporaryDirectory()
        self.repo = PlayerCatalogRepositorySQLite(Path(self.tmp.name) / "player.sqlite3")
        await self.repo.open()
        self.tag = (await self.repo.create_tag("preferred")).tag_id
        server = PlayerHttpServer(self.repo, SessionService(self.repo, access_secret="s" * 32),
                                  ShuffleDeckService(self.repo), DummyReader())
        self.client = TestClient(TestServer(server.application()))
        await self.client.start_server()
        response = await self.client.post("/api/v1/auth/login", json={"secret": "s" * 32})
        self.cookies = {"ppvio_session": response.cookies["ppvio_session"].value}

    async def asyncTearDown(self):
        await self.client.close()
        await self.repo.close()
        self.tmp.cleanup()

    async def test_preferences_require_login_and_mutations_require_same_origin(self):
        response = await self.client.get("/api/v1/feed/preferences")
        self.assertEqual(response.status, 401)
        response = await self.client.put("/api/v1/feed/preferences", cookies=self.cookies,
                                         headers={"Origin": "https://other.invalid"},
                                         json={"preferred_tags": [], "excluded_tags": [], "mode": "mixed"})
        self.assertEqual(response.status, 403)

    async def test_get_put_round_trip_and_invalid_updates_are_atomic(self):
        response = await self.client.get("/api/v1/feed/preferences", cookies=self.cookies)
        self.assertEqual(response.status, 200)
        self.assertEqual(await response.json(), {"preferred_tags": [], "excluded_tags": [], "mode": "mixed"})
        value = {"preferred_tags": [self.tag], "excluded_tags": [], "mode": "only"}
        response = await self.client.put("/api/v1/feed/preferences", cookies=self.cookies, json=value)
        self.assertEqual(response.status, 200)
        self.assertEqual(await response.json(), value)
        for bad in ({"preferred_tags": [99999], "excluded_tags": [], "mode": "mixed"},
                    {"preferred_tags": [], "excluded_tags": [], "mode": "only"},
                    {"preferred_tags": [True], "excluded_tags": [], "mode": "mixed"},
                    {"preferred_tags": [self.tag], "excluded_tags": [self.tag], "mode": "mixed"},
                    {"preferred_tags": [], "excluded_tags": [], "mode": "unexpected"}):
            response = await self.client.put("/api/v1/feed/preferences", cookies=self.cookies, json=bad)
            self.assertEqual(response.status, 400, bad)
        response = await self.client.get("/api/v1/feed/preferences", cookies=self.cookies)
        self.assertEqual(await response.json(), value)

    async def test_non_object_and_invalid_json_are_bad_requests(self):
        for kwargs in ({"json": []}, {"data": "{broken", "headers": {"Content-Type": "application/json"}}):
            response = await self.client.put("/api/v1/feed/preferences", cookies=self.cookies, **kwargs)
            self.assertEqual(response.status, 400)


if __name__ == "__main__":
    unittest.main()
