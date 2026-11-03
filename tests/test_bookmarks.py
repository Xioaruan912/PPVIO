from __future__ import annotations

from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from aiohttp.test_utils import TestClient, TestServer

from ppvio.adapters.http import PlayerHttpServer
from ppvio.application.auth import SessionService
from ppvio.application.feed import ShuffleDeckService
from ppvio.domain.catalog import CatalogLocation, CatalogMedia, CatalogPackage
from ppvio.infrastructure.sqlite import PlayerCatalogRepositorySQLite


A, B, C = "a" * 64, "b" * 64, "c" * 64


def package() -> CatalogPackage:
    return CatalogPackage(
        "bookmarks-package", "archive/bookmarks", "d" * 64, None, None,
        tuple(CatalogMedia(m, "video", 1000, "video/mp4", 1920, 1080, 1000.0)
              for m in (A, B, C)),
        tuple(CatalogLocation(m, "bookmarks-package", f"{n}.mp4")
              for n, m in enumerate((A, B, C))),
    )


class DummyReader:
    async def open_range(self, remote_path, byte_range):
        raise AssertionError("bookmark metadata must not read media")


class BookmarkTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.tmp = TemporaryDirectory()
        self.path = Path(self.tmp.name) / "player.sqlite3"
        self.repo = PlayerCatalogRepositorySQLite(self.path)
        await self.repo.open()
        await self.repo.apply_package(package())
        await self.repo.refresh_media_activity()
        server = PlayerHttpServer(
            self.repo, SessionService(self.repo, access_secret="s" * 32),
            ShuffleDeckService(self.repo), DummyReader(), large_video_seconds=300,
        )
        self.client = TestClient(TestServer(server.application()))
        await self.client.start_server()
        response = await self.client.post("/api/v1/auth/login", json={"secret": "s" * 32})
        self.cookies = {"ppvio_session": response.cookies["ppvio_session"].value}

    async def asyncTearDown(self) -> None:
        await self.client.close()
        await self.repo.close()
        self.tmp.cleanup()

    async def call(self, method: str, path: str, **kwargs):
        response = await self.client.request(method, path, cookies=self.cookies, **kwargs)
        body = await response.json() if response.content_type == "application/json" else await response.text()
        return response.status, body

    async def add(self, media_id=A, position=12.34, name=None):
        return await self.call("POST", f"/api/v1/media/{media_id}/bookmarks",
                               json={"position_seconds": position, "name": name})

    async def test_bookmarks_are_durable_idempotent_at_a_tenth_and_ordered_by_position(self) -> None:
        status, saved = await self.add(position=12.34, name="  scene  ")
        self.assertEqual(status, 201)
        self.assertEqual(set(saved), {"id", "media_id", "position_seconds", "name", "created_at"})
        self.assertRegex(saved["id"], r"^[0-9a-f]{32}$")
        self.assertEqual((saved["media_id"], saved["position_seconds"], saved["name"]), (A, 12.3, "scene"))
        self.assertEqual((await self.add(position=12.349, name="replacement"))[1], saved)
        await self.add(position=3, name="earlier")
        await self.repo.close()
        await self.repo.open()
        status, body = await self.call("GET", f"/api/v1/media/{A}/bookmarks")
        self.assertEqual(status, 200)
        self.assertEqual([b["position_seconds"] for b in body["items"]], [3.0, 12.3])
        self.assertEqual((await self.call("DELETE", f"/api/v1/media/{B}/bookmarks/{saved['id']}"))[0], 404)
        self.assertEqual((await self.call("DELETE", f"/api/v1/media/{A}/bookmarks/{saved['id']}"))[0], 200)
        self.assertEqual(len((await self.call("GET", f"/api/v1/media/{A}/bookmarks"))[1]["items"]), 1)

    async def test_auth_same_origin_and_opaque_media_boundaries(self) -> None:
        # A separate client has no login cookie.
        anonymous = TestClient(TestServer(PlayerHttpServer(
            self.repo, SessionService(self.repo, access_secret="s" * 32),
            ShuffleDeckService(self.repo), DummyReader(), large_video_seconds=300,
        ).application()))
        await anonymous.start_server()
        try:
            for method, path in (("GET", "/api/v1/bookmarks"),
                                 ("GET", f"/api/v1/media/{A}/bookmarks"),
                                 ("POST", f"/api/v1/media/{A}/bookmarks"),
                                 ("DELETE", f"/api/v1/media/{A}/bookmarks/{'e' * 32}")):
                response = await anonymous.request(method, path)
                self.assertEqual(response.status, 401)
        finally:
            await anonymous.close()
        self.assertEqual((await self.add(media_id="archive-path"))[0], 404)
        self.assertEqual((await self.add(media_id="f" * 64))[0], 404)
        response = await self.client.post(f"/api/v1/media/{A}/bookmarks", cookies=self.cookies,
            headers={"Origin": "https://other.example.test"}, json={"position_seconds": 1})
        self.assertEqual(response.status, 403)
        saved = (await self.add())[1]
        self.assertEqual((await self.call("DELETE", f"/api/v1/media/{A}/bookmarks/{saved['id']}",
                                         headers={"Origin": "https://other.example.test"}))[0], 403)

    async def test_invalid_positions_names_and_query_bounds_are_rejected(self) -> None:
        for value in (-1, True, "10", None, float("inf"), float("nan"), 10**1000, 1000.01):
            with self.subTest(position=value):
                self.assertEqual((await self.add(position=value))[0], 400)
        for name in ("x" * 41, "line\nline", "nul\0", 4, [], {}):
            with self.subTest(name=name):
                self.assertEqual((await self.add(name=name))[0], 400)
        self.assertEqual((await self.add(name="x" * 40))[0], 201)
        for query in ("offset=-1", "offset=5001", "limit=0", "limit=101", "limit=x",
                      "offset=1&offset=2", "unknown=1"):
            self.assertEqual((await self.call("GET", "/api/v1/bookmarks?" + query))[0], 400)

    async def test_global_page_includes_media_dto_without_deleted_or_offline_media(self) -> None:
        saved_a = (await self.add(A, 1))[1]
        saved_b = (await self.add(B, 2))[1]
        saved_c = (await self.add(C, 3))[1]
        page = (await self.call("GET", "/api/v1/bookmarks?offset=0&limit=2"))[1]
        next_page = (await self.call("GET", "/api/v1/bookmarks?offset=2&limit=2"))[1]
        self.assertTrue(page["has_more"])
        self.assertFalse(next_page["has_more"])
        all_items = page["items"] + next_page["items"]
        self.assertEqual({b["id"] for b in all_items}, {saved_a["id"], saved_b["id"], saved_c["id"]})
        self.assertTrue(all(b["media"]["id"] == b["media_id"] and
                            b["media"]["stream_url"].startswith("/api/v1/media/") for b in all_items))
        await self.repo.deactivate_packages_not_seen(set())
        await self.repo.refresh_media_activity()
        self.assertEqual((await self.call("GET", "/api/v1/bookmarks"))[1]["items"], [])
        self.assertEqual(len(await self.repo.export_bookmarks()), 3, "temporary scan loss preserves marks")
        await self.repo.apply_package(package())
        await self.repo.refresh_media_activity()
        await self.repo.delete_media_bookmarks(A)
        self.assertEqual({b.media_id for b in await self.repo.list_bookmark_page()}, {B, C})

    async def test_deletion_queue_hides_marks_undo_preserves_them_and_final_deletion_cleans_them(self) -> None:
        saved = (await self.add(A, 5))[1]
        await self.repo.request_media_deletion(A, now=1, undo_until=10)
        self.assertEqual((await self.call("GET", "/api/v1/bookmarks"))[1]["items"], [])
        self.assertEqual(len(await self.repo.export_bookmarks()), 1)
        self.assertTrue(await self.repo.cancel_media_deletion(A, now=2))
        self.assertEqual((await self.call("GET", f"/api/v1/media/{A}/bookmarks"))[1]["items"], [saved])
        self.assertFalse(await self.repo.finalize_media_deletion(A), "existing copies prevent final cleanup")
        self.assertEqual(len(await self.repo.export_bookmarks()), 1)
        await self.repo.record_deleted_location(A, "bookmarks-package", "0.mp4")
        self.assertTrue(await self.repo.finalize_media_deletion(A))
        self.assertEqual(await self.repo.export_bookmarks(), [])

    async def test_per_media_and_global_quotas_keep_existing_marks_idempotent(self) -> None:
        for tick in range(200):
            await self.repo.add_bookmark(A, tick / 10)
        self.assertEqual((await self.add(A, 30))[0], 409)
        self.assertEqual((await self.add(A, 0))[0], 201)
        # Fill the remaining bounded store with offline snapshot records, no media placeholders.
        from ppvio.domain.bookmarks import PlayerBookmark
        marks = [PlayerBookmark(f"{n:032x}", f"{100+n//200:064x}", (n % 200) / 10, None, n)
                 for n in range(4800)]
        await self.repo.restore_bookmarks(marks)
        self.assertEqual((await self.add(B, 1))[0], 409)
        self.assertEqual(len(await self.repo.export_bookmarks()), 5000)


if __name__ == "__main__":
    unittest.main()
