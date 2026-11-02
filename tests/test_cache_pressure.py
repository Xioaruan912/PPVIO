from __future__ import annotations

import asyncio
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from ppvio.application.range_cache import MediaRangeCache
from ppvio.application.warm_backfill import MediaWarmBackfill
from ppvio.domain.ranges import ByteRange
from ppvio.infrastructure.range_store import RangeStore


class RangeReader:
    def __init__(self, payload: bytes) -> None:
        self.payload = payload
        self.calls = 0

    async def open_range(self, package: str, relpath: str, byte_range: ByteRange):
        self.calls += 1
        payload = self.payload[byte_range.start:byte_range.end + 1]

        class Body:
            def __init__(self) -> None:
                self.offset = 0

            def __aiter__(self):
                return self

            async def __anext__(self) -> bytes:
                if self.offset >= len(payload):
                    raise StopAsyncIteration
                piece = payload[self.offset:self.offset + 64 * 1024]
                self.offset += len(piece)
                return piece

            async def aclose(self) -> None:
                pass

        return SimpleNamespace(status=206, content_length=len(payload), body=Body())


class CachePressureIntegrationTests(unittest.IsolatedAsyncioTestCase):
    async def test_a_window_larger_than_available_disk_cache_still_streams_completely(self) -> None:
        chunk = 1024 ** 2
        payload = b"".join(bytes([index]) * chunk for index in range(4))
        with TemporaryDirectory() as temporary:
            root = Path(temporary) / "cache"

            def disk_usage(_path):
                used = sum(p.stat().st_size for p in root.glob("*/*.bin"))
                return SimpleNamespace(free=4 * chunk - used)

            with patch("ppvio.infrastructure.range_store.shutil.disk_usage", side_effect=disk_usage):
                store = RangeStore(root, chunk_bytes=chunk, max_bytes=10 * chunk, min_free_bytes=2 * chunk)
                cache = MediaRangeCache(store, RangeReader(payload), window_bytes=len(payload), max_attempts=1)
                cache.open()
                try:
                    async def read() -> bytes:
                        return b"".join([piece async for piece in cache.stream(
                            "clip", "package", "clip.mp4", len(payload), ByteRange(0, len(payload) - 1),
                        )])
                    self.assertEqual(await asyncio.wait_for(asyncio.gather(read(), read()), 2), [payload, payload])
                    self.assertEqual(store.stats()["pinned_chunks"], 0)
                finally:
                    await cache.shutdown()

    async def test_cancelled_prime_releases_its_pin(self) -> None:
        entered = asyncio.Event()

        class WaitingReader:
            async def open_range(self, *args):
                entered.set()
                await asyncio.Event().wait()

        with TemporaryDirectory() as temporary:
            store = RangeStore(Path(temporary) / "cache", chunk_bytes=64 * 1024, max_bytes=1024 ** 2)
            cache = MediaRangeCache(store, WaitingReader())
            cache.open()
            task = asyncio.create_task(cache.prime("clip", "package", "clip.mp4", 65536, ByteRange(0, 65535)))
            try:
                await asyncio.wait_for(entered.wait(), 0.5)
                self.assertEqual(store.stats()["pinned_chunks"], 1)
                task.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await task
                self.assertEqual(store.stats()["pinned_chunks"], 0)
            finally:
                task.cancel()
                await cache.shutdown()

    async def test_disk_reserve_stops_warming_before_it_discards_newer_heads(self) -> None:
        chunk = 64 * 1024
        ids = [f"clip-{index}" for index in range(20)]

        class Repository:
            async def count_active_videos(self):
                return len(ids)

            async def list_video_ids(self, **kwargs):
                return ids

            async def active_media_details(self, media_id):
                return {"size_bytes": chunk}

            async def active_media_location(self, media_id):
                return ("package", media_id, None)

        with TemporaryDirectory() as temporary:
            root = Path(temporary) / "cache"

            def disk_usage(_path):
                used = sum(p.stat().st_size for p in root.glob("*/*.bin"))
                return SimpleNamespace(free=3 * chunk - used)

            with patch("ppvio.infrastructure.range_store.shutil.disk_usage", side_effect=disk_usage):
                store = RangeStore(root, chunk_bytes=chunk, max_bytes=10 * chunk,
                                   head_chunks=1, min_free_bytes=chunk)
                reader = RangeReader(b"x" * chunk)
                cache = MediaRangeCache(store, reader, window_bytes=chunk)
                cache.open()
                try:
                    await MediaWarmBackfill(cache, Repository(), head_bytes=chunk, workers=1).run(asyncio.Event())
                    self.assertEqual(reader.calls, 2)
                    self.assertTrue(store.has(ids[0], 0))
                    self.assertTrue(store.has(ids[1], 0))
                finally:
                    await cache.shutdown()
