from __future__ import annotations

import asyncio
import json
from pathlib import Path
import sqlite3
from tempfile import TemporaryDirectory
import unittest

from aiohttp.test_utils import TestClient, TestServer

from ppvio.adapters.http import PlayerHttpServer
from ppvio.adapters.http.tag_filing import PlayerTagFilingHttpMixin
from ppvio.application.auth import SessionService
from ppvio.application.feed import ShuffleDeckService
from ppvio.application.ports import RemoteFileStat, WebDavWriteError
from ppvio.application.tag_filing import TagFilingService
from ppvio.domain.catalog import CatalogLocation, CatalogMedia, CatalogPackage
from ppvio.domain.tag_filing import TagFilingError, destination, folder_package_id, validate_snapshot
from ppvio.domain.storage_settings import PlayerStorageSettings
from ppvio.infrastructure.folder_catalog import plain_media_id
from ppvio.infrastructure.migration import run_migrations
from ppvio.infrastructure.sqlite import PlayerCatalogRepositorySQLite
from ppvio.infrastructure.sqlite_tag_filing import PlayerTagFilingRepositoryMixin


if issubclass(PlayerCatalogRepositorySQLite, PlayerTagFilingRepositoryMixin):
    Repository = PlayerCatalogRepositorySQLite
else:
    class Repository(PlayerTagFilingRepositoryMixin, PlayerCatalogRepositorySQLite):
        async def apply_package(self, package):
            await super().apply_package(self.remap_tag_filing_package(package))


MEDIA = "a" * 64
ORIGIN = "Library/2026-09-22/package/video.mp4"


class Writer:
    """No content-read/upload/delete methods: the service must only use MOVE/stat."""
    def __init__(self):
        self.files = {ORIGIN: RemoteFileStat(4, '"v1"')}
        self.calls = []
        self.directories = []
        self.error = None
        self.after_move = None
        self.before_move = None

    async def stat(self, path):
        return self.files.get(path)

    async def ensure_directory(self, path):
        self.directories.append(path)

    async def move(self, source, target, *, overwrite, source_etag=None):
        assert overwrite is False
        self.calls.append((source, target, overwrite))
        if self.before_move:
            await self.before_move()
        if self.error:
            raise self.error
        if source_etag is not None and self.files[source].etag != source_etag:
            raise WebDavWriteError("move", "source_changed", 412)
        if target in self.files:
            raise WebDavWriteError("move", "conflict", 412)
        self.files[target] = self.files.pop(source)
        if self.after_move:
            await self.after_move()


class TagFilingTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = TemporaryDirectory()
        self.path = Path(self.tmp.name) / "catalog.sqlite3"
        self.repo = Repository(self.path)
        await self.repo.open()
        await self.repo.save_storage_settings(PlayerStorageSettings('https://dav.example.com/dav', 'Player', '收藏'))
        async with self.repo._write_transaction() as conn:
            conn.execute("INSERT INTO player_libraries(position,root) VALUES(0,'Library')")
        self.package = CatalogPackage("archive", "Library/2026-09-22/package", "b" * 64, None, None,
            (CatalogMedia(MEDIA, "video", 4, "video/mp4", 1080, 1920, 2),),
            (CatalogLocation(MEDIA, "archive", "video.mp4", '"v1"'),))
        await self.repo.apply_package(self.package)
        await self.repo.refresh_media_activity()
        self.tag = await self.repo.create_tag("工作/精选")
        self.second = await self.repo.create_tag("其他")
        self.now = 1000
        self.writer = Writer()
        self.service = TagFilingService(self.repo, writer=lambda: self.writer, clock=lambda: self.now)

    async def asyncTearDown(self):
        await self.repo.close()
        self.tmp.cleanup()

    async def add(self, tag=None):
        await self.repo.set_media_tag(MEDIA, (tag or self.tag).tag_id, enabled=True)
        return await self.service.request(MEDIA)

    def target(self, tag=None):
        tag = tag or self.tag
        return destination("Library", tag.name, tag.tag_id, ORIGIN)

    async def state(self):
        return await self.repo.tag_filing_record(MEDIA)

    async def test_metadata_memberships_do_not_enqueue_until_explicit_request(self):
        await self.repo.set_media_tag(MEDIA, self.tag.tag_id, enabled=True)
        self.assertFalse(await self.service.run_due())
        self.assertIsNone(await self.state())
        self.assertIn(ORIGIN, self.writer.files)
        self.assertEqual(await self.service.request_existing_tagged(), {"requested": 1, "failed": 0, "errors": {}})
        self.assertTrue(await self.service.run_due())

    async def test_archive_original_moves_with_id_playback_and_source_tombstone(self):
        await self.add()
        self.assertTrue(await self.service.is_busy(MEDIA))
        self.assertTrue(await self.service.run_due())
        self.assertNotIn(ORIGIN, self.writer.files)
        self.assertIn(self.target(), self.writer.files)
        self.assertEqual(self.writer.calls, [(ORIGIN, self.target(), False)])
        self.assertEqual(await self.repo.active_locations(MEDIA), [(self.target().rsplit('/', 1)[0], "video.mp4")])
        await self.repo.apply_package(self.package)
        await self.repo.refresh_media_activity()
        self.assertEqual(len(await self.repo.active_locations(MEDIA)), 1)
        self.assertEqual((await self.state())["status"], "synced")
        self.assertFalse(await self.service.is_busy(MEDIA))

    async def test_plain_rescan_remaps_back_to_opaque_archive_id(self):
        await self.add()
        await self.service.run_due()
        directory, name = self.target().rsplit('/', 1)
        raw_id = plain_media_id(4, name)
        package_id = folder_package_id(directory)
        scanned = CatalogPackage(package_id, directory, "c" * 64, None, None,
            (CatalogMedia(raw_id, "video", 4, "video/mp4"),),
            (CatalogLocation(raw_id, package_id, name),))
        await self.repo.apply_package(scanned)
        await self.repo.refresh_media_activity()
        self.assertIsNone(await self.repo.active_media_details(raw_id))
        self.assertEqual((await self.repo.active_media_details(MEDIA))["width"], 1080)
        self.assertEqual((await self.repo.active_media_location(MEDIA))[:2], (directory, name))

    async def test_secondary_and_rename_do_not_move_but_primary_removal_does(self):
        await self.add()
        await self.service.run_due()
        await self.add(self.second)
        self.assertFalse(await self.service.run_due())
        await self.repo.rename_tag(self.tag.tag_id, "新的名字")
        await self.service.request(MEDIA)
        self.assertFalse(await self.service.run_due())
        await self.repo.set_media_tag(MEDIA, self.tag.tag_id, enabled=False)
        await self.service.request(MEDIA)
        await self.service.run_due()
        self.assertEqual(len(self.writer.calls), 2)
        self.assertIn(self.target(self.second), self.writer.files)

    async def test_last_tag_removal_returns_original_archive_location(self):
        await self.add()
        await self.service.run_due()
        await self.repo.set_media_tag(MEDIA, self.tag.tag_id, enabled=False)
        await self.service.request(MEDIA)
        await self.service.run_due()
        self.assertIn(ORIGIN, self.writer.files)
        self.assertEqual(await self.repo.active_location_records(MEDIA), [("archive", "Library/2026-09-22/package", "video.mp4")])
        await self.repo.apply_package(self.package)
        self.assertEqual(len(await self.repo.active_locations(MEDIA)), 1)

    async def test_network_failure_leaves_original_and_durable_clear_retry(self):
        await self.add()
        self.writer.error = ConnectionResetError("private path must never leak")
        await self.service.run_due()
        row = await self.state()
        self.assertEqual(row["status"], "retry")
        self.assertEqual(row["last_error"], "storage_error")
        self.assertIn(ORIGIN, self.writer.files)
        self.assertIsNotNone(row["plan_target"])
        self.writer.error = None
        await self.service.retry_now(MEDIA)
        await self.service.run_due()
        self.assertIn(self.target(), self.writer.files)

    async def test_unsupported_move_never_tries_copy_upload_or_delete(self):
        await self.add()
        self.writer.error = WebDavWriteError("move", "move_unsupported", 405)
        await self.service.run_due()
        self.assertEqual((await self.state())["status"], "unsupported")
        self.assertIn(ORIGIN, self.writer.files)
        self.assertFalse(await self.service.run_due())
        self.assertTrue(await self.service.is_busy(MEDIA))

    async def test_ambiguous_move_ack_reconciles_without_second_move(self):
        await self.add()
        async def lost_ack():
            raise ConnectionResetError()
        self.writer.after_move = lost_ack
        await self.service.run_due()
        self.assertEqual((await self.state())["status"], "retry")
        self.assertNotIn(ORIGIN, self.writer.files)
        await self.repo.close()
        self.repo = Repository(self.path)
        await self.repo.open()
        self.service = TagFilingService(self.repo, writer=lambda: self.writer, clock=lambda: self.now)
        await self.service.retry_now()
        await self.service.run_due()
        self.assertEqual(len(self.writer.calls), 1)
        self.assertEqual((await self.state())["status"], "synced")

    async def test_cancelled_worker_preserves_plan_and_restarts_safely(self):
        await self.add()
        async def cancelled():
            raise asyncio.CancelledError()
        self.writer.after_move = cancelled
        with self.assertRaises(asyncio.CancelledError):
            await self.service.run_due()
        self.assertEqual((await self.state())["status"], "moving")
        self.writer.after_move = None
        await self.service.run_due()
        self.assertEqual(len(self.writer.calls), 1)
        self.assertEqual((await self.state())["status"], "synced")

    async def test_changed_desire_during_move_requeues_from_confirmed_target(self):
        await self.add()
        async def change_primary():
            await self.repo.set_media_tag(MEDIA, self.tag.tag_id, enabled=False)
            await self.repo.set_media_tag(MEDIA, self.second.tag_id, enabled=True)
            await self.service.request(MEDIA)
        self.writer.after_move = change_primary
        await self.service.run_due()
        self.assertEqual((await self.state())["status"], "pending")
        self.assertEqual((await self.state())["current_path"], self.target())
        self.writer.after_move = None
        await self.service.run_due()
        self.assertEqual(self.writer.calls[-1][:2], (self.target(), self.target(self.second)))

    async def test_untag_after_failed_move_cancels_safe_plan_without_moving(self):
        await self.add()
        self.writer.error = ConnectionResetError()
        await self.service.run_due()
        await self.repo.set_media_tag(MEDIA, self.tag.tag_id, enabled=False)
        await self.service.request(MEDIA)
        self.writer.error = None
        await self.service.run_due()
        await self.service.run_due()
        self.assertIn(ORIGIN, self.writer.files)
        self.assertEqual(len(self.writer.calls), 1)
        self.assertEqual((await self.state())["status"], "synced")

    async def test_existing_basename_uses_safe_unique_and_never_overwrites(self):
        self.writer.files[self.target()] = RemoteFileStat(999, "other")
        await self.add()
        await self.service.run_due()
        actual = (await self.state())["current_path"]
        self.assertIn(MEDIA[:16], actual)
        self.assertEqual(self.writer.files[self.target()].size_bytes, 999)
        self.assertEqual(self.writer.files[actual].size_bytes, 4)

    async def test_catalog_reserved_missing_target_uses_unique_destination(self):
        await self.add()
        await self.service.run_due()
        del self.writer.files[self.target()]
        other = "c" * 64
        source = "Library/2026-09-22/other/video.mp4"
        await self.repo.apply_package(CatalogPackage("other", "Library/2026-09-22/other", "d" * 64, None, None,
            (CatalogMedia(other, "video", 4, "video/mp4"),), (CatalogLocation(other, "other", "video.mp4", '"other"'),)))
        self.writer.files[source] = RemoteFileStat(4, '"other"')
        await self.repo.set_media_tag(other, self.tag.tag_id, enabled=True)
        await self.service.request(other)
        await self.service.run_due()
        row = await self.repo.tag_filing_record(other)
        self.assertEqual(row["status"], "synced")
        self.assertEqual(row["current_path"], "Library/标签收藏/工作_精选--1/video--cccccccccccccccc.mp4")
        self.assertIn(row["current_path"], self.writer.files)
        self.assertNotIn(source, self.writer.files)
        self.assertEqual((await self.state())["current_path"], self.target())

    async def test_restored_plan_cannot_move_into_another_catalog_reservation(self):
        await self.add()
        await self.service.run_due()
        del self.writer.files[self.target()]
        other = "c" * 64
        source = "Library/2026-09-22/other/video.mp4"
        await self.repo.apply_package(CatalogPackage("other", "Library/2026-09-22/other", "d" * 64, None, None,
            (CatalogMedia(other, "video", 4, "video/mp4"),), (CatalogLocation(other, "other", "video.mp4", '"other"'),)))
        self.writer.files[source] = RemoteFileStat(4, '"other"')
        await self.repo.set_media_tag(other, self.tag.tag_id, enabled=True)
        await self.service.request(other)
        row = await self.repo.tag_filing_record(other)
        row.update(status="moving", plan_source=source, plan_target=self.target(),
            plan_tag_id=self.tag.tag_id, plan_generation=row["generation"], plan_package_id="other",
            plan_relpath="video.mp4", plan_size=4, plan_etag='"other"')
        await self.repo.import_tag_filing_snapshot([row])
        await self.service.run_due()
        self.assertIn(source, self.writer.files)
        self.assertNotIn(self.target(), self.writer.files)
        self.assertEqual(len(self.writer.calls), 1)
        self.assertEqual((await self.repo.tag_filing_record(other))["last_error"], "target_conflict")

    async def test_preexisting_both_candidates_fail_without_move(self):
        target = self.target()
        self.writer.files[target] = RemoteFileStat(4, "other")
        path = Path(target)
        alternate = str(path.with_name(f"{path.stem}--{MEDIA[:16]}{path.suffix}"))
        self.writer.files[alternate] = RemoteFileStat(4, "other")
        await self.add()
        await self.service.run_due()
        self.assertEqual((await self.state())["last_error"], "target_conflict")
        self.assertEqual(self.writer.calls, [])
        self.assertIn(ORIGIN, self.writer.files)

    async def test_return_origin_conflict_keeps_filed_source_for_retry(self):
        await self.add()
        await self.service.run_due()
        self.writer.files[ORIGIN] = RemoteFileStat(9, "new-file")
        await self.repo.set_media_tag(MEDIA, self.tag.tag_id, enabled=False)
        await self.service.request(MEDIA)
        await self.service.run_due()
        self.assertEqual((await self.state())["last_error"], "target_conflict")
        self.assertIn(self.target(), self.writer.files)
        self.assertEqual(self.writer.files[ORIGIN].size_bytes, 9)

    async def test_destination_appears_after_plan_refuses_overwrite(self):
        await self.add()
        async def raced_target():
            self.writer.files[self.target()] = RemoteFileStat(4, "intruder")
        self.writer.before_move = raced_target
        await self.service.run_due()
        self.assertIn(ORIGIN, self.writer.files)
        self.assertEqual((await self.state())["last_error"], "conflict")
        self.writer.before_move = None
        await self.service.retry_now()
        await self.service.run_due()
        self.assertEqual((await self.state())["last_error"], "target_conflict")
        self.assertEqual(len(self.writer.calls), 1)

    async def test_source_replaced_before_first_attempt_does_not_move_replacement(self):
        await self.add()
        self.writer.files[ORIGIN] = RemoteFileStat(4, '"replacement"')
        await self.service.run_due()
        self.assertIn(ORIGIN, self.writer.files)
        self.assertEqual(self.writer.calls, [])
        self.assertEqual((await self.state())["last_error"], "source_changed")

    async def test_source_replaced_between_stat_and_move_is_not_moved(self):
        await self.add()
        async def replace_source():
            self.writer.files[ORIGIN] = RemoteFileStat(4, '"replacement"')
        self.writer.before_move = replace_source
        await self.service.run_due()
        self.assertIn(ORIGIN, self.writer.files)
        self.assertNotIn(self.target(), self.writer.files)
        self.assertEqual((await self.state())["last_error"], "source_changed")
        self.assertIsNotNone((await self.state())["plan_source"])

    async def test_source_mutation_does_not_move_replacement(self):
        await self.add()
        self.writer.error = ConnectionResetError()
        await self.service.run_due()
        self.writer.error = None
        self.writer.files[ORIGIN] = RemoteFileStat(4, '"new"')
        await self.service.retry_now()
        await self.service.run_due()
        self.assertEqual((await self.state())["last_error"], "source_changed")
        self.assertEqual(len(self.writer.calls), 1)

    async def test_undo_deletion_resumes_the_previously_requested_filing(self):
        await self.add()
        await self.repo.request_media_deletion(MEDIA, now=self.now, undo_until=self.now + 30)
        self.assertFalse(await self.service.run_due())
        self.now += 1
        self.assertTrue(await self.repo.cancel_media_deletion(MEDIA, now=self.now))
        self.assertTrue(await self.service.run_due())
        self.assertEqual((await self.state())["status"], "synced")
        self.assertIn(self.target(), self.writer.files)

    async def test_queued_permanent_deletion_prevents_request_and_worker_move(self):
        await self.repo.request_media_deletion(MEDIA, now=self.now, undo_until=self.now)
        with self.assertRaisesRegex(TagFilingError, "media_deletion_queued"):
            await self.add()
        self.assertEqual(self.writer.calls, [])

    async def test_queue_created_after_tag_request_blocks_move(self):
        await self.add()
        await self.repo.request_media_deletion(MEDIA, now=self.now, undo_until=self.now)
        await self.service.run_due()
        self.assertEqual((await self.state())["status"], "paused")
        self.assertEqual(self.writer.calls, [])
        self.assertIn(ORIGIN, self.writer.files)

    async def test_merge_remaps_metadata_without_implicit_move(self):
        await self.add()
        await self.service.run_due()
        await self.repo.merge_tags([self.tag.tag_id], self.second.tag_id)
        await self.repo.remap_tag_filing_tag_ids({self.tag.tag_id: self.second.tag_id})
        await self.service.request(MEDIA)
        self.assertFalse(await self.service.run_due())
        self.assertEqual(len(self.writer.calls), 1)

    async def test_status_only_contains_opaque_ids_and_fixed_error_codes(self):
        await self.add()
        await self.service.run_due()
        payload = json.dumps(await self.service.status(MEDIA))
        for private in (ORIGIN, "Library", "video.mp4", self.tag.name, "package_id"):
            self.assertNotIn(private, payload)
        self.assertIn(MEDIA, payload)

    async def test_unknown_media_current_location_survives_snapshot_before_rescan(self):
        await self.add()
        await self.service.run_due()
        snapshot = await self.repo.export_tag_filing_snapshot()
        await self.repo.close()
        self.path = Path(self.tmp.name) / "restored.sqlite3"
        self.repo = Repository(self.path)
        await self.repo.open()
        await self.repo.import_tag_filing_snapshot(snapshot)
        self.assertIsNone(await self.repo.active_media_details(MEDIA))
        self.assertEqual((await self.repo.tag_filing_record(MEDIA))["current_path"], self.target())
        directory, name = self.target().rsplit('/', 1)
        raw_id = plain_media_id(4, name)
        package_id = folder_package_id(directory)
        await self.repo.apply_package(CatalogPackage(package_id, directory, "f" * 64, None, None,
            (CatalogMedia(raw_id, "video", 4, "video/mp4"),), (CatalogLocation(raw_id, package_id, name),)))
        self.assertIsNotNone(await self.repo.active_media_details(MEDIA))
        self.assertIsNone(await self.repo.active_media_details(raw_id))

    async def test_restore_rejects_unresolved_move_when_deletion_is_already_queued(self):
        await self.add()
        self.writer.error = ConnectionResetError()
        await self.service.run_due()
        snapshot = await self.repo.export_tag_filing_snapshot()
        async with self.repo._write_transaction() as conn:
            conn.execute("DELETE FROM player_tag_filing WHERE media_id=?", (MEDIA,))
        await self.repo.request_media_deletion(MEDIA, now=self.now, undo_until=self.now)
        with self.assertRaisesRegex(TagFilingError, "media_deletion_queued"):
            await self.repo.import_tag_filing_snapshot(snapshot)
        self.assertIsNone(await self.state())
        self.assertTrue(await self.repo.is_media_deletion_queued(MEDIA))

    async def test_restore_pauses_unstarted_intents_and_reconciles_existing_plan(self):
        await self.add()
        snapshot = await self.repo.export_tag_filing_snapshot()
        await self.repo.import_tag_filing_snapshot(snapshot)
        self.assertEqual((await self.state())["status"], "paused")
        self.assertFalse(await self.service.run_due())
        await self.service.retry_now()
        self.writer.error = ConnectionResetError()
        await self.service.run_due()
        snapshot = await self.repo.export_tag_filing_snapshot()
        await self.repo.import_tag_filing_snapshot(snapshot)
        self.assertEqual((await self.state())["status"], "retry")
        self.assertIsNotNone((await self.state())["plan_target"])

    async def test_snapshot_validation_rejects_paths_and_partial_plan(self):
        await self.add()
        snapshot = await self.repo.export_tag_filing_snapshot()
        bad = [dict(snapshot[0], current_path="../escape")]
        with self.assertRaises(TagFilingError):
            await self.repo.import_tag_filing_snapshot(bad)
        bad = [dict(snapshot[0], plan_source=ORIGIN)]
        with self.assertRaises(TagFilingError):
            validate_snapshot(bad)

    async def test_deleted_historical_tag_refs_export_as_null(self):
        await self.add()
        await self.service.run_due()
        affected = await self.repo.filing_media_ids_for_tag(self.tag.tag_id)
        self.assertEqual(affected, [MEDIA])
        await self.repo.delete_tag(self.tag.tag_id)
        snapshot = await self.repo.export_tag_filing_snapshot()
        self.assertIsNone(snapshot[0]['primary_tag_id'])
        self.assertIsNone(snapshot[0]['desired_tag_id'])
        self.assertEqual(snapshot[0]['current_path'], self.target())

    async def test_older_snapshot_cannot_overwrite_confirmed_current_location(self):
        await self.add()
        older = await self.repo.export_tag_filing_snapshot()
        await self.service.run_due()
        await self.repo.import_tag_filing_snapshot(older)
        self.assertEqual((await self.state())['current_path'], self.target())
        self.assertEqual((await self.state())['status'], 'synced')

    async def test_restored_state_suppresses_original_manifest_without_tombstone(self):
        await self.add()
        await self.service.run_due()
        snapshot = await self.repo.export_tag_filing_snapshot()
        await self.repo.close()
        self.repo = Repository(Path(self.tmp.name) / 'fresh.sqlite3')
        await self.repo.open()
        await self.repo.import_tag_filing_snapshot(snapshot)
        await self.repo.apply_package(self.package)
        self.assertEqual(await self.repo.active_locations(MEDIA), [])

    async def test_nested_archive_origin_retains_package_and_relpath_after_restore(self):
        nested = 'media/original/video.mp4'
        origin = 'Library/2026-09-22/package/' + nested
        async with self.repo._write_transaction() as conn:
            conn.execute("UPDATE media_locations SET remote_relpath=? WHERE media_id=?", (nested, MEDIA))
        self.writer.files[origin] = self.writer.files.pop(ORIGIN)
        await self.add()
        await self.service.run_due()
        snapshot = await self.repo.export_tag_filing_snapshot()
        await self.repo.close()
        self.repo = Repository(Path(self.tmp.name) / 'fresh.sqlite3')
        await self.repo.open()
        await self.repo.import_tag_filing_snapshot(snapshot)
        async with self.repo._write_transaction() as conn:
            conn.execute("INSERT INTO player_libraries(position,root) VALUES(0,'Library')")
        await self.repo.save_storage_settings(PlayerStorageSettings('https://dav.example.com/dav', 'Player', '收藏'))
        self.service = TagFilingService(self.repo, writer=lambda: self.writer, clock=lambda: self.now)
        await self.service.request(MEDIA)
        await self.service.run_due()
        row = await self.state()
        self.assertEqual(row['current_path'], origin)
        self.assertEqual(row['current_package_id'], 'archive')
        self.assertEqual(row['current_relpath'], nested)
        self.assertIn(origin, self.writer.files)

    async def test_hidden_archive_filename_and_tag_are_visible_to_plain_scanner(self):
        await self.repo.rename_tag(self.tag.tag_id, '_hidden')
        async with self.repo._write_transaction() as conn:
            conn.execute("UPDATE media_locations SET remote_relpath='_video.mp4' WHERE media_id=?", (MEDIA,))
        origin = ORIGIN.rsplit('/', 1)[0] + '/_video.mp4'
        self.writer.files[origin] = self.writer.files.pop(ORIGIN)
        await self.add()
        await self.service.run_due()
        target = (await self.state())['current_path']
        self.assertEqual(target.rsplit('/', 1)[1], 'video.mp4')
        self.assertIn('/hidden--', target)

    async def test_unsupported_filename_is_reported_without_moving(self):
        async with self.repo._write_transaction() as conn:
            conn.execute("UPDATE media_locations SET remote_relpath='video.bin' WHERE media_id=?", (MEDIA,))
        origin = ORIGIN.rsplit('/', 1)[0] + '/video.bin'
        self.writer.files[origin] = self.writer.files.pop(ORIGIN)
        await self.add()
        await self.service.run_due()
        self.assertEqual((await self.state())['last_error'], 'unsupported_filename')
        self.assertEqual((await self.state())['status'], 'unsupported')
        self.assertIn(origin, self.writer.files)
        self.assertEqual(self.writer.calls, [])

    async def test_changed_endpoint_prevents_new_move(self):
        await self.add()
        await self.repo.save_storage_settings(PlayerStorageSettings('https://other.example.com/dav', 'Player', '收藏'))
        await self.service.run_due()
        self.assertEqual((await self.state())['last_error'], 'storage_changed')
        self.assertEqual((await self.state())['status'], 'unsupported')
        self.assertEqual(self.writer.calls, [])
        self.assertIn(ORIGIN, self.writer.files)

    async def test_changed_endpoint_does_not_reconcile_existing_plan_on_wrong_backend(self):
        await self.add()
        self.writer.error = ConnectionResetError()
        await self.service.run_due()
        await self.repo.save_storage_settings(PlayerStorageSettings('https://other.example.com/dav', 'Player', '收藏'))
        self.writer.error = None
        await self.service.retry_now()
        await self.service.run_due()
        self.assertEqual((await self.state())['last_error'], 'storage_changed')
        self.assertEqual(len(self.writer.calls), 1)
        self.assertIsNotNone((await self.state())['plan_target'])
        await self.repo.save_storage_settings(PlayerStorageSettings('https://dav.example.com/dav', 'Player', '收藏'))
        await self.service.retry_now()
        await self.service.run_due()
        self.assertEqual((await self.state())['status'], 'synced')

    async def test_synthetic_previous_schema_backup_upgrade_does_not_enqueue_tags(self):
        migrations = Path(__file__).resolve().parents[1] / "src/ppvio/infrastructure/migrations"
        old = Path(self.tmp.name) / "old-migrations"
        old.mkdir()
        for migration in migrations.glob("*.sql"):
            if int(migration.name[:4]) <= 23:
                (old / migration.name).write_text(migration.read_text())
        source = sqlite3.connect(":memory:")
        run_migrations(source, old)
        source.execute("INSERT INTO player_tags(name,created_at) VALUES('existing',1)")
        source.commit()
        backup = sqlite3.connect(Path(self.tmp.name) / "upgrade.sqlite3")
        source.backup(backup)
        run_migrations(backup, migrations)
        self.assertEqual(backup.execute("SELECT COUNT(*) FROM player_tag_filing").fetchone()[0], 0)
        self.assertEqual(backup.execute("SELECT COUNT(*) FROM player_tags").fetchone()[0], 1)
        backup.close()
        source.close()


if issubclass(PlayerHttpServer, PlayerTagFilingHttpMixin):
    HttpServer = PlayerHttpServer
else:
    class HttpServer(PlayerTagFilingHttpMixin, PlayerHttpServer):
        pass


class TagFilingHttpTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = TemporaryDirectory()
        self.repo = Repository(Path(self.tmp.name) / "catalog.sqlite3")
        await self.repo.open()
        await self.repo.save_storage_settings(PlayerStorageSettings('https://dav.example.com/dav', 'Player', '收藏'))
        async with self.repo._write_transaction() as conn:
            conn.execute("INSERT INTO player_libraries(position,root) VALUES(0,'Library')")
        await self.repo.apply_package(CatalogPackage("package", "Library/raw", "b" * 64, None, None,
            (CatalogMedia(MEDIA, "video", 4, "video/mp4"),), (CatalogLocation(MEDIA, "package", "video.mp4"),)))
        await self.repo.refresh_media_activity()
        self.tag = await self.repo.create_tag("tag")
        await self.repo.set_media_tag(MEDIA, self.tag.tag_id, enabled=True)
        self.service = TagFilingService(self.repo, writer=lambda: None)
        server = HttpServer(self.repo, SessionService(self.repo, access_secret="s" * 32),
            ShuffleDeckService(self.repo), object(), large_video_seconds=300)
        server._tag_filing = self.service
        app = server.application()
        if not any(route.resource.canonical == '/api/v1/tag-filing' for route in app.router.routes()):
            server._register_tag_filing_routes(app)
        self.client = TestClient(TestServer(app))
        await self.client.start_server()
        response = await self.client.post('/api/v1/auth/login', json={'secret': 's' * 32})
        self.cookies = {'ppvio_session': response.cookies['ppvio_session'].value}

    async def asyncTearDown(self):
        await self.client.close()
        await self.repo.close()
        self.tmp.cleanup()

    async def test_all_routes_require_authentication(self):
        self.client.session.cookie_jar.clear()
        for method, path in (
            ('GET', '/api/v1/tag-filing'), ('POST', '/api/v1/tag-filing/retry'),
            ('POST', '/api/v1/tag-filing/organize'), ('GET', f'/api/v1/media/{MEDIA}/tag-filing'),
            ('POST', f'/api/v1/media/{MEDIA}/tag-filing'), ('POST', f'/api/v1/media/{MEDIA}/tag-filing/retry'),
        ):
            with self.subTest(path=path):
                response = await self.client.request(method, path)
                self.assertEqual(response.status, 401)

    async def test_mutations_require_same_origin_before_any_queue_write(self):
        for path in ('/api/v1/tag-filing/retry', '/api/v1/tag-filing/organize',
                     f'/api/v1/media/{MEDIA}/tag-filing', f'/api/v1/media/{MEDIA}/tag-filing/retry'):
            response = await self.client.post(path, cookies=self.cookies, headers={'Origin': 'https://other.example'})
            self.assertEqual(response.status, 403)
        self.assertEqual(await self.repo.export_tag_filing_snapshot(), [])

    async def test_explicit_organize_status_retry_and_opaque_media_routes(self):
        response = await self.client.post('/api/v1/tag-filing/organize', cookies=self.cookies)
        self.assertEqual(response.status, 202)
        self.assertEqual((await response.json())['requested'], 1)
        response = await self.client.get(f'/api/v1/media/{MEDIA}/tag-filing', cookies=self.cookies)
        self.assertEqual(response.status, 200)
        body = await response.json()
        self.assertEqual(body['item']['media_id'], MEDIA)
        self.assertNotIn('Library', json.dumps(body))
        response = await self.client.post('/api/v1/tag-filing/retry', cookies=self.cookies)
        self.assertEqual(response.status, 202)
        response = await self.client.post('/api/v1/media/not-a-hash/tag-filing', cookies=self.cookies)
        self.assertEqual(response.status, 404)
        response = await self.client.post('/api/v1/media/' + 'f' * 64 + '/tag-filing', cookies=self.cookies)
        self.assertEqual(response.status, 404)
