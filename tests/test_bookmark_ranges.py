from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from aiohttp.test_utils import TestClient, TestServer

from ppvio.adapters.http import PlayerHttpServer
from ppvio.application.auth import SessionService
from ppvio.application.feed import ShuffleDeckService
from ppvio.domain.bookmarks import InvalidBookmark
from ppvio.infrastructure.sqlite import PlayerCatalogRepositorySQLite
from test_bookmarks import A, B, DummyReader, package


class BookmarkRangeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.repo = PlayerCatalogRepositorySQLite(Path(self.tmp.name) / "player.sqlite3")
        await self.repo.open(); self.addAsyncCleanup(self.repo.close)
        await self.repo.apply_package(package()); await self.repo.refresh_media_activity()
        self.client = TestClient(TestServer(PlayerHttpServer(self.repo, SessionService(self.repo, access_secret="s" * 32), ShuffleDeckService(self.repo), DummyReader()).application()))
        await self.client.start_server(); self.addAsyncCleanup(self.client.close)
        response = await self.client.post("/api/v1/auth/login", json={"secret": "s" * 32})
        self.client.session.headers["Cookie"] = "ppvio_session=" + response.cookies["ppvio_session"].value

    async def test_range_is_durable_patchable_and_optional_for_old_points(self):
        response = await self.client.post(f"/api/v1/media/{A}/bookmarks", json={"position_seconds": 12.3, "end_seconds": 25.6, "name": "clip"})
        self.assertEqual(response.status, 201); b = await response.json(); self.assertEqual(b["end_seconds"], 25.6)
        response = await self.client.patch(f"/api/v1/media/{A}/bookmarks/{b['id']}", json={"end_seconds": 30, "name": "renamed"})
        self.assertEqual(response.status, 200); self.assertEqual((await response.json())["name"], "renamed")
        records = await self.repo.export_bookmarks(); self.assertEqual(records[0].end_seconds, 30)
        await self.repo.restore_bookmarks(records)
        old = await self.repo.add_bookmark(A, 40); self.assertIsNone(old.end_seconds)
        response = await self.client.patch(f"/api/v1/media/{B}/bookmarks/{b['id']}", json={"end_seconds": 50})
        self.assertEqual(response.status, 404)
        response = await self.client.patch(f"/api/v1/media/{A}/bookmarks/{b['id']}", json={"end_seconds": None})
        self.assertEqual(response.status, 200); self.assertIsNone((await response.json())["end_seconds"])

    async def test_invalid_bounds_do_not_partially_rename_and_writes_check_origin(self):
        b = await self.repo.add_bookmark(A, 12.3, "keep")
        for bad in (12.3, 0, -1, 1000.01, 1001, True, "25", float("inf")):
            response = await self.client.patch(f"/api/v1/media/{A}/bookmarks/{b.id}", json={"end_seconds": bad, "name": "wrong"})
            self.assertEqual(response.status, 400)
        self.assertEqual((await self.repo.list_bookmarks(A))[0].name, "keep")
        response = await self.client.patch(f"/api/v1/media/{A}/bookmarks/{b.id}", json={"end_seconds": 30}, headers={"Origin": "https://foreign.test"})
        self.assertEqual(response.status, 403)
        with self.assertRaises(InvalidBookmark):
            await self.repo.add_bookmark(A, 999, end_seconds=1000.1)
