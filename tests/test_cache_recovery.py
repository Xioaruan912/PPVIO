from __future__ import annotations

import errno
import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from ppvio.infrastructure.range_store import RangeStore


CHUNK = 64 * 1024


class CacheRecoveryTests(unittest.TestCase):
    def make_store(self, root: Path, chunks: int = 4, **options: object) -> RangeStore:
        store = RangeStore(root, chunk_bytes=CHUNK, max_bytes=chunks * CHUNK, **options)
        store.open()
        return store

    def test_failed_eviction_stays_accounted_and_retries_after_recovery(self) -> None:
        with TemporaryDirectory() as temporary:
            root = Path(temporary) / "cache"
            store = self.make_store(root, 1)
            store.write_chunk("a", 0, b"a" * CHUNK)
            unlink = Path.unlink

            def deny_oldest(path: Path, *args: object, **kwargs: object) -> None:
                if path == root / "a" / "0.bin":
                    raise PermissionError(errno.EACCES, "locked cache chunk")
                unlink(path, *args, **kwargs)

            with patch.object(Path, "unlink", deny_oldest):
                store.write_chunk("b", 0, b"b" * CHUNK)
            self.assertTrue(store.has("a", 0), "a failed unlink must remain indexed")
            self.assertEqual(store.total_bytes, CHUNK)
            self.assertEqual(sum(p.stat().st_size for p in root.glob("*/*.bin")), CHUNK)
            self.assertGreaterEqual(store.stats()["eviction_failures"], 1)
            store.maintain()
            self.assertFalse((root / "a" / "0.bin").exists())
            self.assertEqual(store.total_bytes, 0)

    def test_delete_key_retains_failed_chunks_until_maintenance_retry(self) -> None:
        with TemporaryDirectory() as temporary:
            root = Path(temporary) / "cache"
            store = self.make_store(root)
            store.write_chunk("a", 0, b"a" * CHUNK)
            store.write_chunk("a", 1, b"tail")
            unlink = Path.unlink

            def deny_head(path: Path, *args: object, **kwargs: object) -> None:
                if path == root / "a" / "0.bin":
                    raise PermissionError(errno.EACCES, "locked cache chunk")
                unlink(path, *args, **kwargs)

            with patch.object(Path, "unlink", deny_head):
                store.delete_key("a")
            self.assertEqual(store.total_bytes, CHUNK)
            self.assertTrue(store.has("a", 0))
            self.assertFalse(store.has("a", 1))
            store.maintain()
            self.assertEqual(store.chunk_count, 0)
            self.assertFalse((root / "a" / "0.bin").exists())

    def test_failed_read_and_unlink_do_not_hide_disk_usage(self) -> None:
        with TemporaryDirectory() as temporary:
            root = Path(temporary) / "cache"
            store = self.make_store(root)
            store.write_chunk("a", 0, b"cached")
            with patch("builtins.open", side_effect=PermissionError("read denied")):
                with patch.object(Path, "unlink", side_effect=PermissionError("unlink denied")):
                    self.assertIsNone(store.read_slice("a", 0, 0, 6))
            self.assertEqual(store.total_bytes, 6)
            store.maintain()
            self.assertEqual(store.total_bytes, 0)

    def test_shrink_with_all_unlinks_blocked_is_finite_and_accounted(self) -> None:
        with TemporaryDirectory() as temporary:
            root = Path(temporary) / "cache"
            store = self.make_store(root)
            for key in "abc":
                store.write_chunk(key, 0, key.encode() * CHUNK)
            small = RangeStore(root, chunk_bytes=CHUNK, max_bytes=CHUNK)
            attempts = 0

            def deny(path: Path, *args: object, **kwargs: object) -> None:
                nonlocal attempts
                attempts += 1
                if attempts > 6:
                    raise AssertionError("eviction repeatedly selected blocked chunks")
                raise PermissionError(errno.EACCES, "locked cache chunk")

            with patch.object(Path, "unlink", deny):
                small.open()
            self.assertEqual(small.total_bytes, 3 * CHUNK)
            self.assertEqual(small.chunk_count, 3)
            small.maintain()
            self.assertLessEqual(small.total_bytes, CHUNK)
            self.assertEqual(sum(p.stat().st_size for p in root.glob("*/*.bin")), small.total_bytes)

    def test_lru_access_order_survives_restart(self) -> None:
        with TemporaryDirectory() as temporary:
            root = Path(temporary) / "cache"
            store = self.make_store(root, 2)
            store.write_chunk("a", 0, b"a" * CHUNK)
            store.write_chunk("b", 0, b"b" * CHUNK)
            recent = (root / "a" / "0.bin").stat().st_mtime + 60
            for key in "ab":
                os.utime(root / key / "0.bin", (100, 100))
            with patch("ppvio.infrastructure.range_store.time.time", return_value=recent):
                self.assertEqual(store.read_slice("a", 0, 0, 1), b"a")
            iterdir = Path.iterdir

            def ordered(path: Path):
                return iter(sorted(iterdir(path)))

            with patch.object(Path, "iterdir", ordered):
                reopened = self.make_store(root, 2)
            reopened.write_chunk("c", 0, b"c" * CHUNK)
            self.assertTrue(reopened.has("a", 0), "the recently accessed chunk must survive restart")
            self.assertFalse(reopened.has("b", 0))

    def test_idle_expiry_uses_last_access_and_survives_restart(self) -> None:
        with TemporaryDirectory() as temporary:
            root = Path(temporary) / "cache"
            with patch("ppvio.infrastructure.range_store.time.time", return_value=1000):
                store = self.make_store(root, max_age_seconds=100)
                store.write_chunk("a", 0, b"cached")
            with patch("ppvio.infrastructure.range_store.time.time", return_value=1050):
                self.assertEqual(store.read_slice("a", 0, 0, 1), b"c")
            with patch("ppvio.infrastructure.range_store.time.time", return_value=1101):
                store.maintain()
                self.assertTrue(store.has("a", 0), "age is measured since use, not since creation")
                reopened = self.make_store(root, max_age_seconds=100)
                self.assertTrue(reopened.has("a", 0))
            with patch("ppvio.infrastructure.range_store.time.time", return_value=1151):
                reopened.maintain()
            self.assertEqual(reopened.total_bytes, 0)
            self.assertFalse((root / "a" / "0.bin").exists())
            self.assertEqual(reopened.stats()["expired_chunks"], 1)
            self.assertEqual(reopened.stats()["max_age_seconds"], 100)

    def test_recent_touch_cancels_failed_expiry(self) -> None:
        with TemporaryDirectory() as temporary:
            root = Path(temporary) / "cache"
            with patch("ppvio.infrastructure.range_store.time.time", return_value=1000):
                store = self.make_store(root, max_age_seconds=100)
                store.write_chunk("a", 0, b"cached")
            with patch("ppvio.infrastructure.range_store.time.time", return_value=1101):
                with patch.object(Path, "unlink", side_effect=PermissionError("locked")):
                    store.maintain()
                self.assertEqual(store.total_bytes, 6)
                store.touch("a", 0)
            with patch("ppvio.infrastructure.range_store.time.time", return_value=1150):
                store.maintain()
            self.assertTrue(store.has("a", 0), "a once-expired chunk can become active again")
            self.assertEqual(store.stats()["expired_chunks"], 0)

    def test_idle_expiry_keeps_precise_access_within_mtime_throttle(self) -> None:
        with TemporaryDirectory() as temporary:
            with patch("ppvio.infrastructure.range_store.time.time", return_value=1000):
                store = self.make_store(Path(temporary) / "cache", max_age_seconds=100)
                store.write_chunk("a", 0, b"cached")
            with patch("ppvio.infrastructure.range_store.time.time", return_value=1000.5):
                store.touch("a", 0)
            with patch("ppvio.infrastructure.range_store.time.time", return_value=1100.25):
                store.maintain()
            self.assertTrue(store.has("a", 0))

    def test_relayout_preserves_idle_age_of_split_chunks(self) -> None:
        with TemporaryDirectory() as temporary:
            root = Path(temporary) / "cache"
            media = root / "a"
            media.mkdir(parents=True)
            (root / "layout.json").write_text(json.dumps({"chunk_bytes": 2 * CHUNK}))
            chunk = media / "0.bin"
            chunk.write_bytes(b"a" * (2 * CHUNK))
            os.utime(chunk, (1000, 1000))
            with patch("ppvio.infrastructure.range_store.time.time", return_value=1200):
                store = self.make_store(root, max_age_seconds=100)
            self.assertEqual(store.chunk_count, 0, "splitting must not make idle bytes look newly used")

    def test_stale_writer_temps_are_cleaned_without_following_symlinks(self) -> None:
        with TemporaryDirectory() as temporary:
            parent = Path(temporary)
            root = parent / "cache"
            media = root / "a"
            media.mkdir(parents=True)
            outside = parent / "outside"
            outside.mkdir()
            stale = media / ".0.bin.tmp"
            fresh = media / ".1.bin.tmp"
            unrelated = media / ".notes.bin.tmp"
            external = outside / ".2.bin.tmp"
            for path in (stale, fresh, unrelated, external):
                path.write_bytes(b"partial")
                os.utime(path, (100, 100))
            os.utime(fresh, (9999, 9999))
            (root / "linked-dir").symlink_to(outside, target_is_directory=True)
            (media / ".3.bin.tmp").symlink_to(external)
            with patch("ppvio.infrastructure.range_store.time.time", return_value=10000):
                store = self.make_store(root)
            self.assertFalse(stale.exists())
            self.assertTrue(fresh.exists())
            self.assertTrue(unrelated.exists())
            self.assertTrue(external.exists())
            self.assertTrue((media / ".3.bin.tmp").is_symlink())
            retry = media / ".4.bin.tmp"
            retry.write_bytes(b"partial")
            os.utime(retry, (100, 100))
            with patch("ppvio.infrastructure.range_store.time.time", return_value=10000):
                store.maintain()
            self.assertFalse(retry.exists())

    def test_writer_does_not_follow_an_abandoned_temp_symlink(self) -> None:
        with TemporaryDirectory() as temporary:
            root = Path(temporary) / "cache"
            store = self.make_store(root)
            media = root / "a"
            media.mkdir()
            outside = Path(temporary) / "outside"
            outside.write_bytes(b"unrelated")
            (media / ".0.bin.tmp").symlink_to(outside)
            with self.assertRaises(OSError):
                store.write_chunk("a", 0, b"new")
            self.assertEqual(outside.read_bytes(), b"unrelated")
            self.assertEqual(store.total_bytes, 0)

    def test_missing_chunk_during_delete_is_already_reclaimed(self) -> None:
        with TemporaryDirectory() as temporary:
            root = Path(temporary) / "cache"
            store = self.make_store(root)
            store.write_chunk("a", 0, b"cached")
            (root / "a" / "0.bin").unlink()
            store.delete_key("a")
            self.assertEqual(store.total_bytes, 0)
            self.assertEqual(store.stats()["eviction_failures"], 0)

    def test_free_space_reserve_evicts_existing_cache_before_writing(self) -> None:
        with TemporaryDirectory() as temporary:
            root = Path(temporary) / "cache"

            def usage(path: Path) -> SimpleNamespace:
                used = sum(p.stat().st_size for p in root.glob("*/*.bin"))
                return SimpleNamespace(total=4 * CHUNK, used=used, free=4 * CHUNK - used)

            with patch("ppvio.infrastructure.range_store.shutil.disk_usage", side_effect=usage):
                store = self.make_store(root, min_free_bytes=2 * CHUNK)
                for key in "abc":
                    store.write_chunk(key, 0, key.encode() * CHUNK)
                self.assertFalse(store.has("a", 0))
                self.assertTrue(store.has("b", 0))
                self.assertTrue(store.has("c", 0))
                self.assertEqual(store.total_bytes, 2 * CHUNK)
                self.assertEqual(store.stats()["min_free_bytes"], 2 * CHUNK)

    def test_reserve_maintenance_recovers_from_external_disk_pressure(self) -> None:
        with TemporaryDirectory() as temporary:
            root = Path(temporary) / "cache"
            available = 8 * CHUNK

            def usage(path: Path) -> SimpleNamespace:
                used = sum(p.stat().st_size for p in root.glob("*/*.bin"))
                return SimpleNamespace(total=available, used=used, free=available - used)

            with patch("ppvio.infrastructure.range_store.shutil.disk_usage", side_effect=usage):
                store = self.make_store(root, min_free_bytes=2 * CHUNK)
                store.write_chunk("a", 0, b"a" * CHUNK)
                store.write_chunk("b", 0, b"b" * CHUNK)
                available = 3 * CHUNK
                store.maintain()
            self.assertFalse(store.has("a", 0))
            self.assertTrue(store.has("b", 0))
            self.assertEqual(store.total_bytes, CHUNK)

    def test_unmet_reserve_does_not_fabricate_a_disk_write_failure(self) -> None:
        with TemporaryDirectory() as temporary:
            root = Path(temporary) / "cache"
            with patch("ppvio.infrastructure.range_store.shutil.disk_usage", return_value=SimpleNamespace(free=0)):
                store = self.make_store(root, min_free_bytes=2 * CHUNK)
                store.write_chunk("a", 0, b"cached")
                self.assertEqual(store.read_slice("a", 0, 0, 6), b"cached")

    def test_reserve_preserves_old_chunk_if_replacement_fails(self) -> None:
        with TemporaryDirectory() as temporary:
            root = Path(temporary) / "cache"
            store = self.make_store(root, min_free_bytes=CHUNK)
            store.write_chunk("a", 0, b"old")
            with patch("ppvio.infrastructure.range_store.shutil.disk_usage", return_value=SimpleNamespace(free=0)):
                with patch.object(Path, "replace", side_effect=OSError("replacement failed")):
                    with self.assertRaises(OSError):
                        store.write_chunk("a", 0, b"new")
            self.assertEqual(store.read_slice("a", 0, 0, 3), b"old")
            self.assertEqual(store.total_bytes, 3)

    def test_nested_consumer_pins_survive_budget_pressure_until_last_unpin(self) -> None:
        with TemporaryDirectory() as temporary:
            root = Path(temporary) / "cache"
            store = self.make_store(root, 1)
            store.pin("a", 0)
            store.pin("a", 0)
            store.write_chunk("a", 0, b"a" * CHUNK)
            store.write_chunk("b", 0, b"b" * CHUNK)
            self.assertTrue(store.has("a", 0))
            self.assertFalse(store.has("b", 0))
            store.unpin("a", 0)
            store.write_chunk("c", 0, b"c" * CHUNK)
            self.assertTrue(store.has("a", 0))
            store.unpin("a", 0)
            self.assertTrue(store.has("a", 0), "last unpin must not evict before its caller consumes bytes")
            store.write_chunk("d", 0, b"d" * CHUNK)
            self.assertFalse(store.has("a", 0))
            self.assertTrue(store.has("d", 0))

    def test_nested_consumer_pins_defer_expiry_until_last_unpin(self) -> None:
        with TemporaryDirectory() as temporary:
            root = Path(temporary) / "cache"
            with patch("ppvio.infrastructure.range_store.time.time", return_value=1000):
                store = self.make_store(root, max_age_seconds=100)
                store.write_chunk("a", 0, b"cached")
            store.pin("a", 0)
            store.pin("a", 0)
            with patch("ppvio.infrastructure.range_store.time.time", return_value=1200):
                store.maintain()
                self.assertTrue(store.has("a", 0))
                store.unpin("a", 0)
                store.maintain()
                self.assertTrue(store.has("a", 0))
                store.unpin("a", 0)
                self.assertTrue(store.has("a", 0))
                store.maintain()
            self.assertFalse(store.has("a", 0))
            self.assertEqual(store.stats()["expired_chunks"], 1)

    def test_pins_defer_pending_delete_retry_and_disk_pressure(self) -> None:
        with TemporaryDirectory() as temporary:
            root = Path(temporary) / "cache"
            store = self.make_store(root, min_free_bytes=CHUNK)
            store.write_chunk("a", 0, b"cached")
            with patch.object(Path, "unlink", side_effect=PermissionError("locked")):
                store.delete_key("a")
            store.pin("a", 0)
            with patch("ppvio.infrastructure.range_store.shutil.disk_usage", return_value=SimpleNamespace(free=0)):
                store.maintain()
                self.assertTrue(store.has("a", 0))
                store.unpin("a", 0)
                self.assertTrue(store.has("a", 0))
                store.maintain()
            self.assertFalse(store.has("a", 0))

    def test_explicit_delete_keeps_pin_refcounts_until_consumers_release_them(self) -> None:
        with TemporaryDirectory() as temporary:
            root = Path(temporary) / "cache"
            store = self.make_store(root, 1)
            store.pin("a", 0)
            store.pin("a", 0)
            store.write_chunk("a", 0, b"a" * CHUNK)
            store.delete_key("a")
            self.assertFalse(store.has("a", 0), "explicit invalidation can delete pinned chunks")
            store.write_chunk("a", 0, b"a" * CHUNK)
            store.unpin("a", 0)
            store.write_chunk("b", 0, b"b" * CHUNK)
            self.assertTrue(store.has("a", 0), "deletion must not erase a still-active consumer pin")
            store.unpin("a", 0)
            store.write_chunk("c", 0, b"c" * CHUNK)
            self.assertFalse(store.has("a", 0))

    def test_head_warm_admission_requires_reserve_plus_the_full_head(self) -> None:
        with TemporaryDirectory() as temporary:
            store = self.make_store(
                Path(temporary) / "cache", 8, head_chunks=2, min_free_bytes=2 * CHUNK
            )
            with patch("ppvio.infrastructure.range_store.shutil.disk_usage", return_value=SimpleNamespace(free=3 * CHUNK)):
                self.assertFalse(store.head_room(), "space for one chunk cannot admit a two-chunk head")
            with patch("ppvio.infrastructure.range_store.shutil.disk_usage", return_value=SimpleNamespace(free=4 * CHUNK)):
                self.assertTrue(store.head_room())
            with patch("ppvio.infrastructure.range_store.shutil.disk_usage", side_effect=OSError("unavailable")):
                self.assertFalse(store.head_room(), "unknown free space cannot admit background warming")

    def test_disabled_reserve_preserves_head_budget_admission(self) -> None:
        with TemporaryDirectory() as temporary:
            store = self.make_store(Path(temporary) / "cache", 2, head_chunks=1)
            with patch("ppvio.infrastructure.range_store.shutil.disk_usage", side_effect=OSError("unavailable")):
                self.assertTrue(store.head_room())
                store.write_chunk("a", 0, b"a" * CHUNK)
                self.assertFalse(store.head_room())


if __name__ == "__main__":
    unittest.main()
