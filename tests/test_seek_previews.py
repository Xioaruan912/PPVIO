from __future__ import annotations

import asyncio
import base64
import importlib
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
from tempfile import TemporaryDirectory
import time
import unittest
from unittest.mock import patch

import aiohttp
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from ppvio.adapters.http import PlayerHttpServer
from ppvio.application.auth import SessionService
from ppvio.application.feed import ShuffleDeckService
from ppvio.domain.catalog import CatalogLocation, CatalogMedia, CatalogPackage
from ppvio.domain.ranges import ByteRange
from ppvio.infrastructure.sqlite import PlayerCatalogRepositorySQLite
from ppvio.infrastructure.webdav_read import WebDavRangeResponse


JPEG = base64.b64decode(
    "/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzU5LjM3LjEwMAD/2wBDAAgEBAQEBAUFBQUFBQYGBgYGBgYGBgYGBgYHBwcICAgHBwcGBgcHCAgICAkJCQgICAgJCQoKCgwMCwsODg4RERT/xABLAAEBAAAAAAAAAAAAAAAAAAAACAEBAAAAAAAAAAAAAAAAAAAAABABAAAAAAAAAAAAAAAAAAAAABEBAAAAAAAAAAAAAAAAAAAAAP/AABEIALQBQAMBIgACEQADEQD/2gAMAwEAAhEDEQA/AJ/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB//9k="
)


def details(index: int = 1) -> dict[str, object]:
    return {"media_id": f"{index:064x}", "kind": "video", "size_bytes": 100000,
            "duration_seconds": 90.0, "width": 1280, "height": 720}


class Repository:
    def __init__(self) -> None:
        self.location = ("private-library", "private-video.mp4", '"v1"')

    async def active_media_location(self, media_id):
        return self.location


class BytesReader:
    def __init__(self, payload: bytes) -> None:
        self.payload = payload
        self.read = 0
        self.requests: list[ByteRange] = []
        self.closed = 0

    async def open_range(self, package, relpath, byte_range):
        self.requests.append(byte_range)

        async def body():
            try:
                for offset in range(byte_range.start, byte_range.end + 1, 4096):
                    data = self.payload[offset:min(offset + 4096, byte_range.end + 1)]
                    self.read += len(data)
                    yield data
            finally:
                self.closed += 1

        return WebDavRangeResponse(206, "video/mp4", byte_range.length, None, None, body())


class PreviewFixture(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        module_name = "ppvio.infrastructure.seek_previews"
        self.assertIsNotNone(importlib.util.find_spec(module_name), "bounded preview service is missing")
        self.module = importlib.import_module(module_name)
        self.tmp = TemporaryDirectory()
        self.root = Path(self.tmp.name) / "previews"
        self.repository = Repository()
        self.reader = BytesReader(b"x" * 100000)
        self.playing = False
        self.service = self.module.SeekPreviewService(
            self.repository, self.reader, work_dir=self.root, is_playing=lambda: self.playing)
        await self.service.start()
        self.addCleanup(self.tmp.cleanup)
        self.addAsyncCleanup(self.service.close)

    async def ready(self, item=None):
        item = details() if item is None else item
        for _ in range(200):
            status = await self.service.status(item)
            if status["state"] != "pending":
                return status
            await asyncio.sleep(0.01)
        self.fail("preview work did not settle")

    async def render(self, url, target, at, deadline):
        target.write_bytes(JPEG)


class PreviewTests(PreviewFixture):
    async def test_queue_deduplicates_and_rejects_ninth_waiting_job(self):
        self.playing = True
        for index in range(1, 9):
            self.assertEqual((await self.service.prepare(details(index)))["state"], "pending")
        self.assertEqual((await self.service.prepare(details(1)))["state"], "pending")
        self.assertEqual((await self.service.prepare(details(9)))["state"], "unavailable")
        self.assertEqual((await self.service.status(details(20)))["state"], "unavailable")
        await self.service.discard(str(details(1)["media_id"]))
        self.assertEqual((await self.service.prepare(details(9)))["state"], "pending")

    async def test_generates_eight_interior_frames_then_reuses_persistent_cache(self):
        with patch.object(self.service, "_render_frame", side_effect=self.render):
            await self.service.prepare(details())
            status = await self.ready()
        self.assertEqual(status["state"], "ready")
        self.assertEqual(status["frames"], [{"index": n, "at": float((n + 1) * 10)} for n in range(8)])
        frame = await self.service.frame(details(), 0, status["version"])
        self.assertEqual(frame.read_bytes(), JPEG)
        self.assertIsNone(await self.service.frame(details(), 8, status["version"]))
        self.assertIsNone(await self.service.frame(details(), 0, "wrong"))
        await self.service.close()
        await self.service.start()
        self.assertEqual((await self.service.status(details()))["state"], "ready")
        self.repository.location = ("private-library", "private-video.mp4", '"v2"')
        self.assertEqual((await self.service.status(details()))["state"], "unavailable")

    async def test_expired_corrupt_and_symlink_cache_files_are_never_served(self):
        with patch.object(self.service, "_render_frame", side_effect=self.render):
            await self.service.prepare(details())
            status = await self.ready()
        frame = await self.service.frame(details(), 0, status["version"])
        manifest = frame.parent / "manifest.json"
        info = json.loads(manifest.read_text())
        info["created_at"] = time.time() - 8 * 86400
        manifest.write_text(json.dumps(info))
        self.assertIsNone(await self.service.frame(details(), 0, status["version"]))
        with patch.object(self.service, "_render_frame", side_effect=self.render):
            await self.service.prepare(details())
            status = await self.ready()
        frame = await self.service.frame(details(), 0, status["version"])
        outside = Path(self.tmp.name) / "outside.jpg"
        outside.write_bytes(JPEG)
        frame.unlink()
        frame.symlink_to(outside)
        self.assertIsNone(await self.service.frame(details(), 0, status["version"]))
        self.assertEqual(outside.read_bytes(), JPEG)

    async def test_discard_cancels_running_work_and_removes_partial_cache(self):
        started = asyncio.Event()

        async def wait_render(url, target, at, deadline):
            target.write_bytes(JPEG)
            started.set()
            await asyncio.Event().wait()

        with patch.object(self.service, "_render_frame", side_effect=wait_render):
            await self.service.prepare(details())
            await asyncio.wait_for(started.wait(), 2)
            await self.service.discard(str(details()["media_id"]))
        self.assertEqual((await self.service.status(details()))["state"], "unavailable")
        self.assertEqual(list(self.root.iterdir()), [])

    async def test_bad_generation_cools_down_and_invalid_duration_never_queues(self):
        async def broken(url, target, at, deadline):
            target.write_bytes(b"not a jpeg")

        with patch.object(self.service, "_render_frame", side_effect=broken):
            await self.service.prepare(details())
            self.assertEqual((await self.ready())["state"], "unavailable")
            self.assertEqual((await self.service.prepare(details()))["state"], "unavailable")
        self.assertEqual((await self.service.prepare({**details(2), "duration_seconds": float("nan")}))["state"], "unavailable")
        self.assertEqual(list(self.root.iterdir()), [])

    async def test_deleted_or_changed_source_is_not_published_after_generation(self):
        rendered = 0

        async def removed(url, target, at, deadline):
            nonlocal rendered
            target.write_bytes(JPEG)
            rendered += 1
            if rendered == 8:
                self.repository.location = None

        with patch.object(self.service, "_render_frame", side_effect=removed):
            await self.service.prepare(details())
            await asyncio.sleep(0.03)
        self.assertEqual((await self.service.status(details()))["state"], "unavailable")
        self.assertEqual(list(self.root.iterdir()), [], "deleted source must not retain freshly generated frames")

    async def test_disk_reserve_and_cache_cap_evict_without_touching_foreign_paths(self):
        foreign = self.root / "notes"
        foreign.write_text("keep")
        with patch.object(self.service, "_render_frame", side_effect=self.render):
            await self.service.prepare(details())
            self.assertEqual((await self.ready())["state"], "ready")
            with patch.object(self.module, "CACHE_BYTES", len(JPEG) * 9):
                await self.service.prepare(details(2))
                self.assertEqual((await self.ready(details(2)))["state"], "unavailable")
            self.assertEqual((await self.service.status(details()))["state"], "unavailable")
            with patch.object(self.module.shutil, "disk_usage", return_value=shutil._ntuple_diskusage(10, 9, 1)):
                await self.service.prepare(details(3))
                self.assertEqual((await self.ready(details(3)))["state"], "unavailable")
        self.assertEqual(foreign.read_text(), "keep")

    async def test_streaming_reader_stops_at_total_budget_and_closes_upstream(self):
        limiter = self.module._BudgetReader(self.reader, lambda: False)
        limiter.begin(self.module._ReadBudget(8192, time.monotonic() + 5))
        response = await limiter.open_range("private-library", "private-video.mp4", ByteRange(0, 20000))
        received = bytearray()
        with self.assertRaises(self.module.PreviewBudgetExceeded):
            async for chunk in response.body:
                received.extend(chunk)
        self.assertEqual(len(received), 8192)
        self.assertEqual(self.reader.read, 8192)
        self.assertTrue(all(request.length <= 1024 * 1024 for request in self.reader.requests))
        self.assertGreater(self.reader.closed, 0)

    async def test_concurrent_ranges_share_the_same_read_cap(self):
        limiter = self.module._BudgetReader(self.reader, lambda: False)
        limiter.begin(self.module._ReadBudget(8192, time.monotonic() + 5))

        async def consume():
            response = await limiter.open_range("private-library", "private-video.mp4", ByteRange(0, 8191))
            result = bytearray()
            try:
                async for chunk in response.body:
                    result.extend(chunk)
            except self.module.PreviewBudgetExceeded:
                pass
            return bytes(result)

        first, second = await asyncio.gather(consume(), consume())
        self.assertEqual(len(first) + len(second), 8192)
        self.assertEqual(self.reader.read, 8192)

    async def test_pausing_preview_cannot_hold_the_only_upstream_connection(self):
        lane = asyncio.Semaphore(1)

        class Body:
            def __init__(inner):
                inner.parts = [b"x" * 4096, b"y" * 4096]
                inner.closed = False

            def __aiter__(inner):
                return inner

            async def __anext__(inner):
                if not inner.parts:
                    raise StopAsyncIteration
                return inner.parts.pop(0)

            async def aclose(inner):
                if not inner.closed:
                    inner.closed = True
                    lane.release()

        class Reader:
            async def open_range(inner, *args):
                await lane.acquire()
                return WebDavRangeResponse(206, None, 8192, None, None, Body())

        reader = Reader()
        limiter = self.module._BudgetReader(reader, lambda: False)
        limiter.begin(self.module._ReadBudget(8192, time.monotonic() + 5))
        response = await limiter.open_range("private-library", "private-video.mp4", ByteRange(0, 8191))
        self.assertTrue(await anext(response.body))
        foreground = asyncio.create_task(reader.open_range("private-library", "private-video.mp4", ByteRange(0, 8191)))
        done, _ = await asyncio.wait({foreground}, timeout=0.1)
        if done:
            await foreground.result().body.aclose()
        else:
            foreground.cancel()
            await asyncio.gather(foreground, return_exceptions=True)
        await response.body.aclose()
        self.assertTrue(done, "preview yielding or pausing must leave the upstream connection free")

    async def test_ending_budget_cancels_loopback_reads_paused_for_playback(self):
        playing = False
        limiter = self.module._BudgetReader(self.reader, lambda: playing)
        limiter.begin(self.module._ReadBudget(8192, time.monotonic() + 30))
        with patch.object(self.module, "_CHUNK_BYTES", 4096):
            response = await limiter.open_range("private-library", "private-video.mp4", ByteRange(0, 8191))
            iterator = response.body.__aiter__()
            self.assertEqual(len(await anext(iterator)), 4096)
            playing = True
            blocked = asyncio.create_task(anext(iterator))
            await asyncio.sleep(0.02)
            limiter.end()
            done, _ = await asyncio.wait({blocked}, timeout=0.2)
            if not done:
                blocked.cancel()
                await asyncio.gather(blocked, return_exceptions=True)
        self.assertTrue(done, "service shutdown must not wait for the playback pause deadline")
        self.assertTrue(blocked.cancelled())

    async def test_upstream_error_messages_are_not_revealed_by_loopback_reader(self):
        class BrokenReader:
            async def open_range(inner, *args):
                raise RuntimeError("https://private.invalid/?secret=do-not-log")

        limiter = self.module._BudgetReader(BrokenReader(), lambda: False)
        limiter.begin(self.module._ReadBudget(8192, time.monotonic() + 5))
        response = await limiter.open_range("private-library", "private-video.mp4", ByteRange(0, 100))
        with self.assertRaises(RuntimeError) as caught:
            await anext(response.body)
        self.assertNotIn("private.invalid", str(caught.exception))
        self.assertNotIn("do-not-log", str(caught.exception))

    async def test_only_one_job_runs_and_close_cleans_queued_and_partial_work(self):
        active = 0
        peak = 0
        started = asyncio.Event()

        async def blocked(url, target, at, deadline):
            nonlocal active, peak
            active += 1
            peak = max(peak, active)
            target.write_bytes(JPEG)
            started.set()
            try:
                await asyncio.Event().wait()
            finally:
                active -= 1

        with patch.object(self.service, "_render_frame", side_effect=blocked):
            await self.service.prepare(details())
            await asyncio.wait_for(started.wait(), 1)
            for index in range(2, 10):
                self.assertEqual((await self.service.prepare(details(index)))["state"], "pending")
            self.assertEqual((await self.service.prepare(details(10)))["state"], "unavailable")
            await asyncio.sleep(0.02)
            self.assertEqual(peak, 1)
            await asyncio.wait_for(self.service.close(), 0.5)
        self.assertEqual(active, 0)
        self.assertEqual(list(self.root.iterdir()), [])
        self.assertEqual((await self.service.status(details(2)))["state"], "unavailable")

    async def test_wall_clock_deadline_ends_foreground_pause(self):
        self.playing = True
        with self.assertRaises(TimeoutError):
            await self.service._render_frame("http://127.0.0.1:1/src/token", self.root / "test.jpg", 1.0,
                                             time.monotonic() + 0.02)


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "ffmpeg is not installed")
class PreviewFFmpegTests(PreviewFixture):
    async def test_rejects_playlists_without_fetching_referenced_urls(self):
        secondary = []
        app = web.Application()
        async def playlist(request):
            return web.Response(text="#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\nsegment.ts\n#EXT-X-ENDLIST\n")
        async def segment(request):
            secondary.append(True)
            return web.Response(body=b"invalid transport stream")
        app.router.add_get("/master.m3u8", playlist)
        app.router.add_get("/segment.ts", segment)
        server = TestServer(app)
        await server.start_server()
        try:
            with self.assertRaises(RuntimeError):
                await self.service._render_frame(str(server.make_url("/master.m3u8")), self.root / "playlist.jpg", 0, time.monotonic() + 10)
            self.assertEqual(secondary, [], "playlist references must never bypass the bounded reader")
        finally:
            await server.close()

    async def test_real_ffmpeg_uses_loopback_ranges_and_returns_320_pixel_jpegs(self):
        original = Path(self.tmp.name) / "synthetic.mp4"
        await asyncio.to_thread(subprocess.run, ["ffmpeg", "-v", "error", "-f", "lavfi", "-i",
                        "testsrc=size=640x360:rate=12:duration=3", "-c:v", "libx264",
                        "-threads", "1", "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(original)],
                       check=True, timeout=30)
        self.reader.payload = original.read_bytes()
        item = {**details(), "size_bytes": len(self.reader.payload), "duration_seconds": 3.0}
        await self.service.prepare(item)
        for _ in range(1000):
            status = await self.service.status(item)
            if status["state"] != "pending":
                break
            await asyncio.sleep(0.01)
        self.assertEqual(status["state"], "ready")
        self.assertEqual(len(status["frames"]), 8)
        for index in range(8):
            frame = await self.service.frame(item, index, status["version"])
            info = await asyncio.to_thread(subprocess.run, ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                                   "stream=width,height", "-of", "json", str(frame)], capture_output=True,
                                  text=True, check=True, timeout=5)
            self.assertEqual(json.loads(info.stdout)["streams"][0], {"width": 320, "height": 180})
        self.assertLessEqual(self.reader.read, 64 * 1024 * 1024)
        self.assertTrue(all(request.length <= 1024 * 1024 for request in self.reader.requests))
        self.assertFalse(any(path.suffix == ".mp4" for path in self.root.rglob("*")))


class PreviewHttpTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.repo = PlayerCatalogRepositorySQLite(Path(self.tmp.name) / "player.sqlite3")
        await self.repo.open()
        self.addAsyncCleanup(self.repo.close)
        self.media_id = str(details()["media_id"])
        await self.repo.apply_package(CatalogPackage(
            "offline-preview-package", "private-library", "b" * 64, None, None,
            (CatalogMedia(self.media_id, "video", 100000, "video/mp4", 1280, 720, 90.0),),
            (CatalogLocation(self.media_id, "offline-preview-package", "private-video.mp4", '"v1"'),)))
        await self.repo.refresh_media_activity()
        self.reader = BytesReader(b"x" * 100000)
        module = importlib.import_module("ppvio.infrastructure.seek_previews")
        self.service = module.SeekPreviewService(self.repo, self.reader, work_dir=Path(self.tmp.name) / "previews",
                                                is_playing=lambda: self.server.active_playback_streams > 0)
        self.server = self.make_server(previews=self.service)
        await self.service.start()
        self.addAsyncCleanup(self.service.close)
        self.client = TestClient(TestServer(self.server.application()))
        await self.client.start_server()
        self.addAsyncCleanup(self.client.close)
        self.url = f"/api/v1/media/{details()['media_id']}/preview"

    def make_server(self, *, previews):
        return PlayerHttpServer(self.repo, SessionService(self.repo, access_secret="s" * 32),
                                ShuffleDeckService(self.repo), self.reader, previews=previews,
                                max_streams=1, max_streams_per_client=1, startup_range_bytes=4)

    async def login(self, client=None):
        client = self.client if client is None else client
        response = await client.post("/api/v1/auth/login", json={"secret": "s" * 32})
        self.assertEqual(response.status, 200)
        # The loopback fixture uses HTTP; preserve production Secure cookies and send this test session explicitly.
        client.session.headers["Cookie"] = f"ppvio_session={response.cookies['ppvio_session'].value}"

    async def render(self, url, target, at, deadline):
        target.write_bytes(JPEG)

    async def ready(self):
        for _ in range(200):
            response = await self.client.get(self.url)
            self.assertEqual(response.status, 200)
            status = await response.json()
            if status["state"] != "pending":
                return status
            await asyncio.sleep(0.01)
        self.fail("HTTP preview did not settle")

    async def prepare_ready(self):
        with patch.object(self.service, "_render_frame", side_effect=self.render):
            response = await self.client.post(self.url)
            self.assertEqual(response.status, 200)
            return await self.ready()

    async def test_status_and_frame_require_authentication(self):
        for url in (self.url, self.url + "/0.jpg?v=" + "a" * 64):
            response = await self.client.get(url)
            self.assertEqual(response.status, 401)
        self.assertEqual((await self.client.post(self.url, headers={
            "Origin": str(self.client.make_url("/")).rstrip("/")})).status, 401)

    async def test_prepare_requires_origin_and_dto_only_contains_same_origin_urls(self):
        await self.login()
        self.assertEqual((await self.client.post(self.url, headers={"Origin": "https://untrusted.invalid"})).status, 403)
        with patch.object(self.service, "_render_frame", side_effect=self.render):
            response = await self.client.post(self.url, headers={"Origin": str(self.client.make_url("/")).rstrip("/")})
            self.assertEqual(response.status, 200)
            status = await self.ready()
        self.assertEqual(status, {"state": "ready", "version": status["version"], "frames": [
            {"index": index, "at": float((index + 1) * 10),
             "url": f"{self.url}/{index}.jpg?v={status['version']}"} for index in range(8)]})
        self.assertNotIn("private", json.dumps(status))
        self.assertEqual(self.server.active_playback_streams, 0)

    async def test_jpeg_is_versioned_and_unavailable_indexes_are_not_served(self):
        await self.login()
        status = await self.prepare_ready()
        response = await self.client.get(status["frames"][0]["url"])
        self.assertEqual(response.status, 200)
        self.assertEqual(response.content_type, "image/jpeg")
        self.assertEqual(await response.read(), JPEG)
        self.assertEqual(response.headers["Cache-Control"], "no-store")
        self.assertEqual(response.headers["X-Content-Type-Options"], "nosniff")
        for suffix in ("/0.jpg", "/0.jpg?v=wrong", "/8.jpg?v=" + "a" * 64, "/x.jpg?v=" + "a" * 64):
            self.assertEqual((await self.client.get(self.url + suffix)).status, 404)

    async def test_status_never_queues_work_and_disabled_service_stays_available(self):
        await self.login()
        self.assertEqual((await (await self.client.get(self.url)).json())["state"], "unavailable")
        self.assertEqual(self.reader.read, 0)
        client = TestClient(TestServer(self.make_server(previews=None).application()))
        await client.start_server()
        self.addAsyncCleanup(client.close)
        await self.login(client)
        for response in (await client.get(self.url), await client.post(self.url)):
            self.assertEqual(response.status, 200)
            self.assertEqual(await response.json(), {"state": "unavailable", "frames": []})

    async def test_loopback_waits_for_foreground_then_resumes_without_taking_a_slot(self):
        await self.login()
        release_foreground = asyncio.Event()
        self.addCleanup(release_foreground.set)
        render_started = asyncio.Event()
        allow_source_read = asyncio.Event()
        loopback_opened = asyncio.Event()
        original_open = self.reader.open_range

        async def gated_read(package, relpath, byte_range):
            response = await original_open(package, relpath, byte_range)
            if byte_range.start != 4096:
                return response

            async def body():
                iterator = response.body.__aiter__()
                try:
                    yield await anext(iterator)
                    await release_foreground.wait()
                    async for chunk in iterator:
                        yield chunk
                finally:
                    await response.body.aclose()

            return WebDavRangeResponse(206, "video/mp4", byte_range.length, None, None, body())

        async def loopback_render(url, target, at, deadline):
            render_started.set()
            await allow_source_read.wait()
            async with aiohttp.ClientSession() as session:
                async with session.get(url, headers={"Range": "bytes=0-127"}) as response:
                    loopback_opened.set()
                    self.assertEqual(await response.read(), b"x" * 128)
            target.write_bytes(JPEG)

        with patch.object(self.reader, "open_range", side_effect=gated_read), patch.object(
                self.service, "_render_frame", side_effect=loopback_render):
            self.assertEqual((await self.client.post(self.url)).status, 200)
            await asyncio.wait_for(render_started.wait(), 1)
            foreground = await self.client.get(f"/api/v1/media/{self.media_id}/stream", headers={"Range": "bytes=4096-12287"})
            self.assertEqual(foreground.status, 206)
            self.assertEqual(await foreground.content.readexactly(4096), b"x" * 4096)
            self.assertEqual(self.server.active_playback_streams, 1)
            allow_source_read.set()
            await asyncio.wait_for(loopback_opened.wait(), 1)
            await asyncio.sleep(0.06)
            self.assertEqual(len(self.reader.requests), 1, "preview must not open upstream ranges during foreground playback")
            self.assertEqual(self.server.active_playback_streams, 1)
            release_foreground.set()
            self.assertEqual(await foreground.read(), b"x" * 4096)
            self.assertEqual((await self.ready())["state"], "ready")
        self.assertEqual(self.server.active_playback_streams, 0)


if __name__ == "__main__":
    unittest.main()
