from __future__ import annotations

from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
import json

from aiohttp.test_utils import TestClient, TestServer

from ppvio.adapters.http import PlayerHttpServer
from ppvio.adapters.http.tag_collections import PlayerTagCollectionHttpMixin
from ppvio.application.auth import SessionService
from ppvio.application.feed import ShuffleDeckService
from ppvio.application.legacy_tag_groups import LegacyTagGroupService
from ppvio.application.ports import DeleteReceipt, RemoteFileStat
from ppvio.domain.catalog import CatalogLocation, CatalogMedia, CatalogPackage
from ppvio.domain.tags import InvalidTag
from ppvio.domain.storage_settings import PlayerStorageSettings
from ppvio.infrastructure.sqlite import PlayerCatalogRepositorySQLite
from ppvio.infrastructure.sqlite_legacy_tags import PlayerLegacyTagRepositoryMixin


if issubclass(PlayerCatalogRepositorySQLite, PlayerLegacyTagRepositoryMixin):
    Repository = PlayerCatalogRepositorySQLite
else:
    class Repository(PlayerLegacyTagRepositoryMixin, PlayerCatalogRepositorySQLite):
        pass

A, B, C, D = (f"{n:064x}" for n in range(1, 5))


class Writer:
    def __init__(self):
        self.files = {}
        self.deleted = []
        self.stats = []
        self.on_stat = None
        self.fail_stat = set()
        self.fail_delete = set()

    async def stat(self, path):
        self.stats.append(path)
        if self.on_stat:
            await self.on_stat(path)
        if path in self.fail_stat:
            raise OSError('offline fake failure')
        size = self.files.get(path)
        return None if size is None else RemoteFileStat(size, None)

    async def delete(self, path):
        if path in self.fail_delete:
            raise OSError('offline fake failure')
        self.deleted.append(path)
        self.files.pop(path, None)
        return DeleteReceipt(204, True)


class LegacyTagGroupTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = TemporaryDirectory()
        self.repo = Repository(Path(self.tmp.name) / "catalog.sqlite3")
        await self.repo.open()
        await self.repo.save_storage_settings(PlayerStorageSettings('https://dav.example', 'Player', '收藏'))
        await self.repo.apply_package(CatalogPackage("p", "Library/archive", "f" * 64, None, None,
            tuple(CatalogMedia(mid, "video", 100, "video/mp4", 1080, 1920, 30) for mid in (A, B, C, D)),
            tuple(CatalogLocation(mid, "p", f"{mid}.mp4") for mid in (A, B, C, D))))
        await self.repo.refresh_media_activity()
        self.group = await self.repo.create("风景", "manual", '{"keep":true}')
        await self.repo.add_item(self.group.collection_id, A)
        await self.repo.add_item(self.group.collection_id, B)
        self.writer = Writer()
        self.service = LegacyTagGroupService(self.repo, writer=lambda: self.writer)

    async def asyncTearDown(self):
        await self.repo.close()
        self.tmp.cleanup()

    async def filed(self, media_id, tag_id, *, path=None, status="synced", size=100):
        path = path or f"Library/标签收藏/风景--{tag_id}/{media_id}.mp4"
        origin = f"Library/archive/{media_id}.mp4"
        async with self.repo._write_transaction() as conn:
            conn.execute("""INSERT OR REPLACE INTO player_tag_filing(media_id,origin_path,origin_package_id,
                origin_relpath,current_path,current_package_id,current_relpath,library_root,
                primary_tag_id,desired_tag_id,status,source_endpoint,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,1)""",
                (media_id, origin, "p", f"{media_id}.mp4", path, "p", f"{media_id}.mp4", "Library", tag_id, tag_id, status, 'https://dav.example'))
        self.writer.files[path] = size
        return path

    async def test_import_is_atomic_idempotent_preserves_old_groups_and_source_timestamps(self):
        existing = await self.repo.create_tag("风景")
        async with self.repo._write_transaction() as conn:
            conn.execute("UPDATE collections SET created_at='2020-01-02 03:04:05' WHERE collection_id=?", (self.group.collection_id,))
        first = await self.service.import_legacy()
        self.assertEqual(first["mapping"], {self.group.collection_id: existing.tag_id})
        self.assertEqual(first["memberships_added"], 2)
        self.assertEqual(self.writer.stats, [])
        self.assertEqual(self.writer.deleted, [])
        await self.repo.rename_tag(existing.tag_id, "重命名标签")
        again = await self.service.import_legacy()
        self.assertEqual(again["mapping"], first["mapping"])
        self.assertEqual(again["memberships_added"], 0)
        self.assertEqual(len(await self.repo.list()), 1)
        self.assertIn('"keep":true', (await self.repo.get(self.group.collection_id)).rules_json)
        self.assertEqual(await self.repo.media_tag_ids(A), [existing.tag_id])

    async def test_long_names_get_distinct_bounded_deterministic_labels_and_creation_times(self):
        base = "长" * 20
        first = await self.repo.create(base + "甲", "manual", None)
        second = await self.repo.create(base + "乙", "manual", None)
        async with self.repo._write_transaction() as conn:
            conn.execute("UPDATE collections SET created_at='2020-01-02 03:04:05' WHERE collection_id=?", (first.collection_id,))
        imported = await self.repo.import_legacy_groups_to_tags()
        self.assertNotEqual(imported["mapping"][first.collection_id], imported["mapping"][second.collection_id])
        self.assertTrue(all(len(tag.name) <= 20 for tag in await self.repo.list_tags()))
        self.assertEqual((await self.repo.import_legacy_groups_to_tags())["mapping"], imported["mapping"])
        created = self.repo._require().execute("SELECT created_at FROM player_tags WHERE tag_id=?", (imported["mapping"][first.collection_id],)).fetchone()[0]
        self.assertEqual(created, 1577934245)

    async def test_merge_remaps_group_marker_and_keeps_import_and_retirement_working(self):
        imported = await self.service.import_legacy()
        source = imported["mapping"][self.group.collection_id]
        target = await self.repo.create_tag("Merged")
        await self.repo.merge_tags([source], target.tag_id)
        self.assertEqual(json.loads((await self.repo.get(self.group.collection_id)).rules_json),
                         {"keep": True, "_ppvio_legacy_tag": {"tag_id": target.tag_id}})
        self.assertEqual((await self.service.import_legacy())["mapping"],
                         {self.group.collection_id: target.tag_id})
        await self.filed(A, target.tag_id)
        await self.filed(B, target.tag_id)
        self.assertEqual((await self.service.retire_legacy())["retired_groups"], 1)

    async def test_tag_limit_rolls_back_every_membership_and_mapping(self):
        async with self.repo._write_transaction() as conn:
            conn.executemany("INSERT INTO player_tags(name,created_at) VALUES(?,0)", [(f"existing{n}",) for n in range(200)])
        with self.assertRaises(InvalidTag):
            await self.repo.import_legacy_groups_to_tags()
        self.assertEqual(await self.repo.media_tag_ids(A), [])
        self.assertEqual((await self.repo.get(self.group.collection_id)).rules_json, '{"keep":true}')

    async def test_tag_wall_excludes_untagged_inactive_variants_and_removed_even_if_active(self):
        tag = await self.repo.create_tag("tag")
        for mid in (A, B, C):
            await self.repo.set_media_tag(mid, tag.tag_id, enabled=True)
        async with self.repo._write_transaction() as conn:
            conn.execute("UPDATE media SET active=0 WHERE media_id=?", (B,))
            conn.execute("INSERT INTO media_variants(parent_media_id,variant_media_id,height) VALUES(?,?,720)", (A, C))
        self.assertEqual(await self.repo.tag_collection_ids(), (A,))
        self.assertEqual(await self.repo.tag_collection_ids(tag_id=tag.tag_id, offset=1), ())
        await self.repo.request_media_deletion(A, now=1, undo_until=2)
        async with self.repo._write_transaction() as conn:
            conn.execute("UPDATE media SET active=1 WHERE media_id=?", (A,))
        self.assertEqual(await self.repo.tag_collection_ids(), ())

    async def test_one_missing_target_keeps_every_old_group_and_backup(self):
        other = await self.repo.create("另组", "manual", None)
        await self.repo.add_item(other.collection_id, C)
        mapping = (await self.service.import_legacy())["mapping"]
        await self.filed(A, mapping[self.group.collection_id])
        await self.filed(C, mapping[other.collection_id])
        await self.repo.save_collection_backup(self.group.collection_id, A, "风景/copy.mp4", 100)
        self.writer.files["Player/风景/copy.mp4"] = 100
        result = await self.service.retire_legacy()
        self.assertEqual(result["retired_groups"], 0)
        self.assertEqual(result["blocked_media"], 1)
        self.assertEqual(len(await self.repo.list()), 2)
        self.assertEqual(self.writer.deleted, [])

    async def test_size_mismatch_and_unsynced_targets_block_retirement(self):
        mapping = (await self.service.import_legacy())["mapping"]
        tag = mapping[self.group.collection_id]
        await self.filed(A, tag, size=99)
        await self.filed(B, tag, status="retry")
        result = await self.service.retire_legacy()
        self.assertEqual(result["retired_groups"], 0)
        self.assertEqual(result["blocked_media"], 2)
        self.assertEqual(result["blocked"]["target_size_mismatch"], 1)
        self.assertEqual(result["blocked"]["filing_not_synced"], 1)

    async def test_verified_retirement_cleans_only_matching_files_and_keeps_media_and_smart_groups(self):
        smart = await self.repo.create("动态", "smart", "{}")
        tag = (await self.service.import_legacy())["mapping"][self.group.collection_id]
        target_a = await self.filed(A, tag)
        target_b = await self.filed(B, tag)
        await self.repo.save_collection_backup(self.group.collection_id, A, "风景/a.mp4", 100)
        await self.repo.save_collection_backup(self.group.collection_id, B, "风景/b.mp4", 100)
        self.writer.files["Player/风景/a.mp4"] = 100
        result = await self.service.retire_legacy()
        self.assertEqual(result["retired_groups"], 1)
        self.assertEqual(result["cleanup_removed"], 1)
        self.assertEqual(result["cleanup_missing"], 1)
        self.assertEqual(result["cleanup_remaining"], 0)
        self.assertEqual(self.writer.deleted, ["Player/风景/a.mp4"])
        self.assertIn(target_a, self.writer.files)
        self.assertIn(target_b, self.writer.files)
        self.assertEqual([group.collection_id for group in await self.repo.list()], [smart.collection_id])
        self.assertIsNotNone(await self.repo.active_media_details(A))

    async def test_cleanup_is_bounded_and_can_resume_after_groups_are_gone(self):
        tag = (await self.service.import_legacy())["mapping"][self.group.collection_id]
        for mid in (A, B):
            await self.filed(mid, tag)
            await self.repo.save_collection_backup(self.group.collection_id, mid, f"风景/{mid}.mp4", 100)
            self.writer.files[f"Player/风景/{mid}.mp4"] = 100
        result = await self.service.retire_legacy(cleanup_limit=1)
        self.assertEqual(result["cleanup_remaining"], 1)
        self.assertEqual(len(self.writer.deleted), 1)
        result = await self.service.retire_legacy(cleanup_limit=1)
        self.assertEqual(result["retired_groups"], 0)
        self.assertEqual(result["cleanup_remaining"], 0)

    async def test_cleanup_refuses_current_origin_outside_root_and_wrong_size_paths(self):
        tag = (await self.service.import_legacy())["mapping"][self.group.collection_id]
        await self.filed(A, tag, path="Player/风景/current.mp4")
        await self.filed(B, tag)
        async with self.repo._write_transaction() as conn:
            conn.execute("UPDATE player_tag_filing SET origin_path='Player/风景/original.mp4' WHERE media_id=?", (B,))
        await self.repo.save_collection_backup(self.group.collection_id, A, "风景/current.mp4", 100)
        await self.repo.save_collection_backup(self.group.collection_id, B, "风景/original.mp4", 100)
        self.writer.files["Player/风景/original.mp4"] = 100
        result = await self.service.retire_legacy()
        self.assertEqual(result["cleanup_remaining"], 2)
        self.assertEqual(result["cleanup_blocked"], 2)
        self.assertEqual(self.writer.deleted, [])
        # Orphan copies remain guarded on later retries as well.
        async with self.repo._write_transaction() as conn:
            conn.execute("UPDATE collection_backups SET relpath='../escape' WHERE media_id=?", (A,))
            conn.execute("UPDATE collection_backups SET relpath='风景/wrong.mp4' WHERE media_id=?", (B,))
        self.writer.files["Player/风景/wrong.mp4"] = 99
        result = await self.service.retire_legacy()
        self.assertEqual(result["cleanup_remaining"], 2)
        self.assertEqual(self.writer.deleted, [])

    async def test_member_or_filing_changes_during_verification_abort_all_metadata_deletion(self):
        tag = (await self.service.import_legacy())["mapping"][self.group.collection_id]
        await self.filed(A, tag)
        await self.filed(B, tag)
        changed = False
        async def change(_path):
            nonlocal changed
            if not changed:
                changed = True
                await self.repo.add_item(self.group.collection_id, C)
        self.writer.on_stat = change
        result = await self.service.retire_legacy()
        self.assertEqual(result["retired_groups"], 0)
        self.assertGreater(result["blocked"].get("legacy_groups_changed", 0), 0)
        self.assertIsNotNone(await self.repo.get(self.group.collection_id))

    async def test_metadata_delete_is_selected_manual_only_and_never_deletes_media(self):
        other = await self.repo.create("保留", "manual", None)
        smart = await self.repo.create("smart", "smart", "{}")
        self.assertEqual(await self.repo.delete_legacy_groups([self.group.collection_id, smart.collection_id]), 1)
        self.assertIsNotNone(await self.repo.get(other.collection_id))
        self.assertIsNotNone(await self.repo.get(smart.collection_id))
        self.assertIsNotNone(await self.repo.active_media_details(A))

    async def test_import_preserves_membership_dates_and_refuses_broken_saved_mapping(self):
        async with self.repo._write_transaction() as conn:
            conn.execute("UPDATE collection_items SET added_at='2020-01-02 03:04:05'")
        tag = (await self.service.import_legacy())["mapping"][self.group.collection_id]
        tagged_at = self.repo._require().execute("SELECT tagged_at FROM player_media_tags WHERE media_id=?", (A,)).fetchone()[0]
        self.assertEqual(tagged_at, 1577934245)
        await self.repo.delete_tag(tag)
        with self.assertRaises(InvalidTag):
            await self.service.import_legacy()
        self.assertEqual(await self.repo.list_tags(), [])
        self.assertIsNotNone(await self.repo.get(self.group.collection_id))

    async def test_alias_conflict_rolls_back_all_imports(self):
        other = await self.repo.create_tag('other')
        await self.repo.update_tag_details(other.tag_id, {'aliases': ['风景']})
        with self.assertRaises(InvalidTag):
            await self.service.import_legacy()
        self.assertEqual(await self.repo.media_tag_ids(A), [])
        self.assertEqual((await self.repo.get(self.group.collection_id)).rules_json, '{"keep":true}')

    async def test_oversized_mapping_rolls_back_to_keep_rules_recoverable(self):
        rules = json.dumps({'keep': 'x' * 4080})
        await self.repo.set_rules(self.group.collection_id, rules)
        with self.assertRaises(InvalidTag):
            await self.service.import_legacy()
        self.assertEqual(await self.repo.list_tags(), [])
        self.assertEqual((await self.repo.get(self.group.collection_id)).rules_json, rules)

    async def test_unimported_groups_and_missing_writer_cannot_retire(self):
        result = await self.service.retire_legacy()
        self.assertEqual(result['retired_groups'], 0)
        self.assertEqual(result['blocked']['group_not_imported'], 1)
        await self.service.import_legacy()
        result = await LegacyTagGroupService(self.repo, writer=lambda: None).retire_legacy()
        self.assertEqual(result['blocked']['storage_unavailable'], 1)
        self.assertIsNotNone(await self.repo.get(self.group.collection_id))

    async def test_filing_and_storage_changes_during_target_stat_abort_retirement(self):
        tag = (await self.service.import_legacy())['mapping'][self.group.collection_id]
        await self.filed(A, tag)
        await self.filed(B, tag)
        changed = False
        async def change(_path):
            nonlocal changed
            if not changed:
                changed = True
                async with self.repo._write_transaction() as conn:
                    conn.execute("UPDATE player_tag_filing SET updated_at=updated_at+1 WHERE media_id=?", (A,))
                    conn.execute("UPDATE player_storage_settings SET revision=revision+1")
        self.writer.on_stat = change
        result = await self.service.retire_legacy()
        self.assertEqual(result['blocked']['legacy_groups_changed'], 1)
        self.assertEqual(result['retired_groups'], 0)

    async def test_cleanup_failures_keep_authority_and_retry_without_groups(self):
        tag = (await self.service.import_legacy())['mapping'][self.group.collection_id]
        await self.filed(A, tag)
        await self.filed(B, tag)
        path = 'Player/风景/copy.mp4'
        await self.repo.save_collection_backup(self.group.collection_id, A, '风景/copy.mp4', 100)
        self.writer.files[path] = 100
        self.writer.fail_delete.add(path)
        result = await self.service.retire_legacy()
        self.assertEqual(result['retired_groups'], 1)
        self.assertEqual(result['cleanup_remaining'], 1)
        self.writer.fail_delete.clear()
        self.writer.fail_stat.add(path)
        result = await self.service.retire_legacy()
        self.assertEqual(result['cleanup_remaining'], 1)
        self.writer.fail_stat.clear()
        result = await self.service.retire_legacy()
        self.assertEqual(result['cleanup_removed'], 1)
        self.assertEqual(result['cleanup_remaining'], 0)

    async def test_cleanup_refuses_unrelated_orphans_and_ancestors_of_live_files(self):
        tag = (await self.service.import_legacy())['mapping'][self.group.collection_id]
        await self.filed(A, tag, path='Player/风景/ancestor/video.mp4')
        await self.filed(B, tag)
        await self.repo.save_collection_backup(self.group.collection_id, A, '风景/ancestor', 100)
        await self.repo.save_collection_backup('unrelated-orphan', C, 'not-ours/c.mp4', 100)
        self.writer.files['Player/风景/ancestor'] = 100
        self.writer.files['Player/not-ours/c.mp4'] = 100
        result = await self.service.retire_legacy()
        self.assertEqual(result['cleanup_blocked'], 1)
        self.assertEqual(result['cleanup_remaining'], 1)
        self.assertEqual(len(await self.repo.collection_backup_rows()), 2)
        self.assertEqual(self.writer.deleted, [])

    async def test_current_filing_changed_during_copy_stat_is_protected(self):
        tag = (await self.service.import_legacy())['mapping'][self.group.collection_id]
        await self.filed(A, tag)
        await self.filed(B, tag)
        path = 'Player/风景/copy.mp4'
        await self.repo.save_collection_backup(self.group.collection_id, A, '风景/copy.mp4', 100)
        self.writer.files[path] = 100
        async def change(stat_path):
            if stat_path == path:
                async with self.repo._write_transaction() as conn:
                    conn.execute('UPDATE player_tag_filing SET current_path=? WHERE media_id=?', (path, A))
        self.writer.on_stat = change
        result = await self.service.retire_legacy()
        self.assertEqual(result['retired_groups'], 1)
        self.assertEqual(result['cleanup_blocked'], 1)
        self.assertEqual(self.writer.deleted, [])

    async def test_cleanup_authority_cannot_follow_storage_reconfiguration(self):
        tag = (await self.service.import_legacy())['mapping'][self.group.collection_id]
        await self.filed(A, tag)
        await self.filed(B, tag)
        await self.repo.save_collection_backup(self.group.collection_id, A, '风景/copy.mp4', 100)
        self.writer.files['Other/风景/copy.mp4'] = 100
        self.assertEqual((await self.service.retire_legacy(cleanup_limit=0))['cleanup_remaining'], 1)
        await self.repo.save_storage_settings(PlayerStorageSettings('https://other.example', 'Other', '收藏'))
        result = await self.service.retire_legacy()
        self.assertEqual(result['cleanup_remaining'], 1)
        self.assertEqual(result['cleanup_blocked'], 1)
        self.assertEqual(self.writer.deleted, [])

    async def client(self, *, service=True):
        if issubclass(PlayerHttpServer, PlayerTagCollectionHttpMixin):
            Server = PlayerHttpServer
        else:
            class Server(PlayerTagCollectionHttpMixin, PlayerHttpServer):
                def application(self):
                    app = super().application()
                    self._register_tag_collection_routes(app)
                    return app
        server = Server(self.repo, SessionService(self.repo, access_secret='s'*32),
                        ShuffleDeckService(self.repo), object())
        server._legacy_tag_groups = self.service if service else None
        client = TestClient(TestServer(server.application()))
        await client.start_server()
        self.addAsyncCleanup(client.close)
        response = await client.post('/api/v1/auth/login', json={'secret': 's'*32})
        cookies = {'ppvio_session': response.cookies['ppvio_session'].value}
        return client, cookies

    async def test_http_wall_paging_selection_strict_queries_and_auth(self):
        tag = await self.repo.create_tag('tag')
        other = await self.repo.create_tag('other')
        for identity in (A, B):
            await self.repo.set_media_tag(identity, tag.tag_id, enabled=True)
        await self.repo.set_media_tag(C, other.tag_id, enabled=True)
        client, cookies = await self.client()
        response = await client.get(f'/api/v1/tag-collections?tag_id={tag.tag_id}&limit=1', cookies=cookies)
        self.assertEqual(response.status, 200)
        page = await response.json()
        self.assertEqual([item['id'] for item in page['items']], [A])
        self.assertTrue(page['has_more'])
        self.assertNotIn('Library/', json.dumps(page))
        response = await client.get(f'/api/v1/tag-collections?tag_id={tag.tag_id}&offset=1', cookies=cookies)
        self.assertEqual([item['id'] for item in (await response.json())['items']], [B])
        for query in ('limit=101', 'offset=-1', 'tag_id=0', 'tag_id=no', 'tag_id=1&tag_id=2', 'path=secret', 'offset=100001'):
            response = await client.get('/api/v1/tag-collections?' + query, cookies=cookies)
            self.assertEqual(response.status, 400, query)
        client.session.cookie_jar.clear()
        self.assertEqual((await client.get('/api/v1/tag-collections')).status, 401)

    async def test_http_migrations_require_origin_and_preserve_unverified_groups(self):
        client, cookies = await self.client()
        path = '/api/v1/tag-collections/'
        for action in ('import-legacy', 'retire-legacy'):
            response = await client.post(path + action, cookies=cookies, json={}, headers={'Origin': 'https://other.example'})
            self.assertEqual(response.status, 403)
        self.assertEqual(await self.repo.media_tag_ids(A), [])
        response = await client.post(path + 'import-legacy', cookies=cookies, json={})
        tag = (await response.json())['mapping'][self.group.collection_id]
        self.assertEqual(response.status, 200)
        response = await client.post(path + 'retire-legacy', cookies=cookies, json={})
        self.assertEqual((await response.json())['retired_groups'], 0)
        await self.filed(A, tag)
        await self.filed(B, tag)
        response = await client.post(path + 'retire-legacy', cookies=cookies, json={'cleanup_limit': 0})
        self.assertEqual((await response.json())['retired_groups'], 1)
        for payload in ({'cleanup_limit': True}, {'cleanup_limit': -1}, {'cleanup_limit': 1001}, {'path': 'elsewhere'}):
            self.assertEqual((await client.post(path + 'retire-legacy', cookies=cookies, json=payload)).status, 400)

    async def test_http_migration_service_is_optional(self):
        client, cookies = await self.client(service=False)
        self.assertEqual((await client.post('/api/v1/tag-collections/import-legacy', cookies=cookies, json={})).status, 503)
