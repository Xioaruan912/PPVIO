from __future__ import annotations

import base64
import hashlib
import importlib.util
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from aiohttp.test_utils import TestClient, TestServer

from ppvio.adapters.http import PlayerHttpServer
from ppvio.application.auth import SessionService
from ppvio.application.feed import ShuffleDeckService
from ppvio.domain.catalog import CatalogLocation, CatalogMedia, CatalogPackage
from ppvio.infrastructure.sqlite import PlayerCatalogRepositorySQLite
from test_seek_previews import JPEG

A, B, C = "a" * 64, "b" * 64, "c" * 64


class ManualCoverTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.assertIsNotNone(importlib.util.find_spec("ppvio.domain.manual_covers"), "manual-cover validation is missing")
        from ppvio.domain import manual_covers
        from ppvio.infrastructure.sqlite_manual_covers import PlayerManualCoverRepositoryMixin
        from ppvio.adapters.http.manual_covers import PlayerManualCoverHttpMixin
        self.domain = manual_covers
        repository = (PlayerCatalogRepositorySQLite if issubclass(PlayerCatalogRepositorySQLite, PlayerManualCoverRepositoryMixin)
                      else type("CoverRepository", (PlayerManualCoverRepositoryMixin, PlayerCatalogRepositorySQLite), {}))
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.repo = repository(Path(self.tmp.name) / "covers.sqlite3")
        await self.repo.open()
        self.addAsyncCleanup(self.repo.close)
        # Parent owns the real migration; the standalone mixin can be tested before assembly.
        self.repo._require().execute("""CREATE TABLE IF NOT EXISTS player_manual_covers(
            media_id TEXT PRIMARY KEY,jpeg BLOB NOT NULL,at_seconds REAL NOT NULL,
            version TEXT NOT NULL,updated_at INTEGER NOT NULL)""")
        self.repo._require().commit()
        await self.repo.apply_package(CatalogPackage(
            "cover-package", "archive/covers", "d" * 64, None, None,
            tuple(CatalogMedia(m, "video", 1000, "video/mp4", 1920, 1080, 100.0) for m in (A, B, C)),
            tuple(CatalogLocation(m, "cover-package", f"{i}.mp4") for i, m in enumerate((A, B, C))),
        ))
        await self.repo.refresh_media_activity()
        server_class = (PlayerHttpServer if issubclass(PlayerHttpServer, PlayerManualCoverHttpMixin)
                        else type("CoverServer", (PlayerManualCoverHttpMixin, PlayerHttpServer), {}))
        server = server_class(self.repo, SessionService(self.repo, access_secret="s" * 32),
                              ShuffleDeckService(self.repo), object(), large_video_seconds=300)
        app = server.application()
        if not any(route.resource.canonical.endswith("/manual-cover") for route in app.router.routes()):
            server._register_manual_cover_routes(app)
        self.client = TestClient(TestServer(app))
        await self.client.start_server()
        self.addAsyncCleanup(self.client.close)
        response = await self.client.post("/api/v1/auth/login", json={"secret": "s" * 32})
        self.cookies = {"ppvio_session": response.cookies["ppvio_session"].value}
        self.url = f"/api/v1/media/{A}/manual-cover"

    async def call(self, method, path, **kwargs):
        return await self.client.request(method, path, cookies=self.cookies, **kwargs)

    async def test_jpeg_rejects_bad_structure_dimension_and_bytes(self):
        validate = self.domain.validate_manual_cover_jpeg
        self.assertEqual(validate(JPEG), (320, 180))
        padding = 65536 - len(JPEG) - 4
        large = JPEG[:2] + b"\xff\xfe" + (padding + 2).to_bytes(2, "big") + b"x" * padding + JPEG[2:]
        self.assertEqual(validate(large), (320, 180))
        with self.assertRaises(self.domain.InvalidManualCover):
            validate(large[:6] + b"x" + large[6:])
        for data in (b"", b"not jpeg", JPEG[:-2], JPEG + b"trailing", b"\xff\xd8\xff\xd9",
                     JPEG[:30] + b"\xff" * 65536 + JPEG[30:]):
            with self.subTest(length=len(data)), self.assertRaises(self.domain.InvalidManualCover):
                validate(data)
        sof = JPEG.index(b"\xff\xc0")
        for width, height in ((0, 1), (1, 0), (481, 100), (100, 481), (65535, 65535)):
            data = bytearray(JPEG)
            data[sof + 5:sof + 9] = height.to_bytes(2, "big") + width.to_bytes(2, "big")
            with self.subTest(width=width, height=height), self.assertRaises(self.domain.InvalidManualCover):
                validate(bytes(data))

    async def test_durable_bytes_content_version_replacement_and_default_reset(self):
        await self.repo.save_manual_cover(A, JPEG, 12.5)
        await self.repo.close()
        await self.repo.open()
        cover = await self.repo.get_manual_cover(A)
        self.assertEqual((cover["jpeg"], cover["version"], cover["at_seconds"]),
                         (JPEG, hashlib.sha256(JPEG).hexdigest(), 12.5))
        await self.repo.save_manual_cover(A, JPEG, 13)
        self.assertEqual((await self.repo.get_manual_cover(A))["at_seconds"], 13)
        await self.repo.delete_manual_cover(A)
        self.assertIsNone(await self.repo.get_manual_cover(A))

    async def test_save_requires_active_primary_video_known_duration_and_valid_position(self):
        for position in (-1, 100.01, float("nan"), float("inf"), True, "1", 10**1000):
            with self.subTest(position=position), self.assertRaises(self.domain.InvalidManualCover):
                await self.repo.save_manual_cover(A, JPEG, position)
        for media_id in ("archive-path", "f" * 64):
            with self.assertRaises(self.domain.InvalidManualCover):
                await self.repo.save_manual_cover(media_id, JPEG, 1)
        conn = self.repo._require()
        for duration in (None, 0):
            conn.execute("UPDATE media SET duration_seconds=? WHERE media_id=?", (duration, A)); conn.commit()
            with self.assertRaises(self.domain.InvalidManualCover):
                await self.repo.save_manual_cover(A, JPEG, 0)
        conn.execute("UPDATE media SET duration_seconds=100,active=0 WHERE media_id=?", (A,)); conn.commit()
        with self.assertRaises(self.domain.InvalidManualCover):
            await self.repo.save_manual_cover(A, JPEG, 1)
        conn.execute("UPDATE media SET active=1 WHERE media_id=?", (A,))
        conn.execute("INSERT INTO media_variants(parent_media_id,variant_media_id,height,width,bitrate_bps,label,rank) VALUES(?,?,?,?,?,?,?)",
                     (B, A, 180, 320, 1000, "copy", 0)); conn.commit()
        with self.assertRaises(self.domain.InvalidManualCover):
            await self.repo.save_manual_cover(A, JPEG, 1)

    async def test_replacement_quota_uses_delta_and_failure_preserves_old_bytes(self):
        with patch("ppvio.infrastructure.sqlite_manual_covers.MAX_MANUAL_COVERS_BYTES", len(JPEG) * 2):
            await self.repo.save_manual_cover(A, JPEG, 1)
            await self.repo.save_manual_cover(B, JPEG, 1)
            await self.repo.save_manual_cover(A, JPEG, 2)
            with self.assertRaises(self.domain.ManualCoverQuotaExceeded):
                await self.repo.save_manual_cover(C, JPEG, 1)
            self.assertEqual((await self.repo.get_manual_cover(A))["at_seconds"], 2)
            self.assertIsNone(await self.repo.get_manual_cover(C))

    async def test_export_restore_preserves_unscanned_state_and_is_atomic(self):
        await self.repo.save_manual_cover(A, JPEG, 2)
        exported = await self.repo.export_manual_covers()
        self.assertEqual(base64.b64decode(exported[0]["jpeg_base64"]), JPEG)
        unknown = {**exported[0], "media_id": "f" * 64}
        await self.repo.restore_manual_covers([unknown])
        self.assertEqual((await self.repo.get_manual_cover(unknown["media_id"]))["jpeg"], JPEG)
        before = await self.repo.export_manual_covers()
        for changes in ({"jpeg_base64": "!!"}, {"jpeg_base64": base64.b64encode(b"bad").decode()},
                        {"version": "0" * 64}, {"at_seconds": -1}, {"updated_at": True},
                        {"media_id": "path"}, {"unexpected": 1}):
            with self.subTest(changes=changes), self.assertRaises(self.domain.InvalidManualCover):
                await self.repo.restore_manual_covers([{**exported[0], "media_id": B}, {**exported[0], **changes}])
            self.assertEqual(await self.repo.export_manual_covers(), before)
        with self.assertRaises(self.domain.InvalidManualCover):
            await self.repo.restore_manual_covers([exported[0], exported[0]])
        with patch("ppvio.infrastructure.sqlite_manual_covers.MAX_MANUAL_COVERS_BYTES", len(JPEG) * 2):
            with self.assertRaises(self.domain.ManualCoverQuotaExceeded):
                await self.repo.restore_manual_covers([{**exported[0], "media_id": B}])
        self.assertEqual(await self.repo.export_manual_covers(), before)

    async def test_restore_checks_known_duration_before_writes_and_joins_full_recovery_rollback(self):
        await self.repo.save_manual_cover(A, JPEG, 100)
        item = (await self.repo.export_manual_covers())[0]
        with self.assertRaises(self.domain.InvalidManualCover):
            await self.repo.restore_manual_covers([{**item, "media_id": B}, {**item, "at_seconds": 100.1}])
        self.assertIsNone(await self.repo.get_manual_cover(B))
        with self.assertRaisesRegex(RuntimeError, "later recovery failure"):
            async with self.repo.recovery_transaction():
                await self.repo.restore_manual_covers([{**item, "media_id": B}])
                raise RuntimeError("later recovery failure")
        self.assertIsNone(await self.repo.get_manual_cover(B))

    async def test_actual_total_quota_accepts_16_mib_and_rejects_one_more_cover(self):
        padding = 65536 - len(JPEG) - 4
        large = JPEG[:2] + b"\xff\xfe" + (padding + 2).to_bytes(2, "big") + b"x" * padding + JPEG[2:]
        item = {"jpeg_base64": base64.b64encode(large).decode(), "at_seconds": 1,
                "version": hashlib.sha256(large).hexdigest(), "updated_at": 1}
        await self.repo.restore_manual_covers([{**item, "media_id": f"{index:064x}"} for index in range(256)])
        with self.assertRaises(self.domain.ManualCoverQuotaExceeded):
            await self.repo.save_manual_cover(A, JPEG, 1)
        self.assertIsNone(await self.repo.get_manual_cover(A))

    async def test_http_binary_put_get_delete_with_auth_origin_and_bounds(self):
        self.assertEqual((await self.call("PUT", self.url + "?at_seconds=1", data=JPEG,
                                               headers={"Content-Type": "image/jpeg"})).status, 200)
        cover = await self.repo.get_manual_cover(A)
        response = await self.call("GET", self.url + "?v=" + cover["version"])
        self.assertEqual((response.status, response.content_type, response.headers["Cache-Control"]),
                         (200, "image/jpeg", "private, no-store"))
        self.assertEqual(await response.read(), JPEG)
        self.assertEqual((await self.call("GET", self.url + "?v=" + "0" * 64)).status, 404)
        for query in ("", "?at_seconds=NaN", "?at_seconds=101", "?at_seconds=1&at_seconds=2", "?at_seconds=1&path=x"):
            self.assertEqual((await self.call("PUT", self.url + query, data=JPEG,
                                                    headers={"Content-Type": "image/jpeg"})).status, 400)
        self.assertEqual((await self.call("PUT", self.url + "?at_seconds=1", data=JPEG)).status, 415)
        self.assertEqual((await self.call("PUT", self.url + "?at_seconds=1", data=b"x" * 65537,
                                                headers={"Content-Type": "image/jpeg"})).status, 413)
        self.assertEqual((await self.call("PUT", self.url + "?at_seconds=1", data=JPEG,
            headers={"Content-Type": "image/jpeg", "Origin": "https://other.test"})).status, 403)
        self.assertEqual((await self.call("DELETE", self.url, headers={"Origin": "https://other.test"})).status, 403)
        response = await self.call("DELETE", self.url)
        self.assertEqual(response.status, 200)
        self.assertEqual((await response.json())["id"], A)
        self.assertIsNone(await self.repo.get_manual_cover(A))
        self.assertEqual((await self.call("GET", self.url)).status, 404)
        self.assertEqual((await self.call("PUT", "/api/v1/media/archive-path/manual-cover?at_seconds=1",
            data=JPEG, headers={"Content-Type": "image/jpeg"})).status, 404)
        self.client.session.cookie_jar.clear()
        for method in ("GET", "PUT", "DELETE"):
            self.assertEqual((await self.client.request(method, self.url)).status, 401)

    async def test_http_accepts_the_64_kib_cover_limit_and_bounds_chunked_uploads(self):
        padding = 65536 - len(JPEG) - 4
        image = JPEG[:2] + b"\xff\xfe" + (padding + 2).to_bytes(2, "big") + b"x" * padding + JPEG[2:]
        response = await self.call("PUT", self.url + "?at_seconds=2", data=image,
                                   headers={"Content-Type": "image/jpeg"})
        self.assertEqual(response.status, 200)
        self.assertEqual((await self.repo.get_manual_cover(A))["jpeg"], image)
        async def oversized():
            yield image
            yield b"x"
        response = await self.call("PUT", self.url + "?at_seconds=3", data=oversized(),
                                   headers={"Content-Type": "image/jpeg"})
        self.assertEqual(response.status, 413)
        self.assertEqual((await self.repo.get_manual_cover(A))["at_seconds"], 2)
        response = await self.call("POST", "/api/v1/history", data=b"x" * 5000,
                                   headers={"Content-Type": "application/json"})
        self.assertEqual(response.status, 413)

    async def test_http_hides_a_restored_cover_if_its_media_becomes_a_variant(self):
        await self.repo.save_manual_cover(A, JPEG, 1)
        conn = self.repo._require()
        conn.execute("INSERT INTO media_variants(parent_media_id,variant_media_id,height,width,bitrate_bps,label,rank) VALUES(?,?,?,?,?,?,?)",
                     (B, A, 180, 320, 1000, "copy", 0)); conn.commit()
        for method in ("GET", "DELETE", "PUT"):
            response = await self.call(method, self.url + ("?at_seconds=1" if method == "PUT" else ""),
                                       data=JPEG if method == "PUT" else None, headers={"Content-Type": "image/jpeg"})
            self.assertEqual(response.status, 404)
        self.assertIsNotNone(await self.repo.get_manual_cover(A), "raw recovery state remains exportable")
