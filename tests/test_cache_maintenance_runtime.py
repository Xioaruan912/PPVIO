from __future__ import annotations

import asyncio
import unittest
from unittest.mock import Mock

from ppvio.main import _cache_maintenance_poll


class CacheMaintenanceRuntimeTests(unittest.IsolatedAsyncioTestCase):
    async def test_idle_maintenance_stops_with_service(self) -> None:
        stop = asyncio.Event()
        store = Mock()
        store.maintain.side_effect = stop.set
        await asyncio.wait_for(_cache_maintenance_poll(store, lambda: False, stop), 0.5)
        store.maintain.assert_called_once_with()

    async def test_maintenance_yields_to_playback_then_retries(self) -> None:
        stop = asyncio.Event()
        store = Mock()
        store.maintain.side_effect = stop.set
        checks = 0

        def is_playing() -> bool:
            nonlocal checks
            checks += 1
            if checks == 1:
                store.maintain.assert_not_called()
                return True
            return False

        await asyncio.wait_for(_cache_maintenance_poll(store, is_playing, stop, seconds=0.01), 0.5)
        self.assertGreaterEqual(checks, 2)
        store.maintain.assert_called_once_with()

    async def test_a_disk_error_does_not_kill_the_background_worker(self) -> None:
        stop = asyncio.Event()
        store = Mock()
        def maintain() -> None:
            if store.maintain.call_count == 1:
                raise OSError("temporary")
            stop.set()
        store.maintain.side_effect = maintain
        with self.assertLogs("ppvio.main", level="WARNING"):
            await asyncio.wait_for(_cache_maintenance_poll(store, lambda: False, stop, seconds=0.01), 0.5)
        self.assertEqual(store.maintain.call_count, 2)
