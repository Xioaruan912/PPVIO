from __future__ import annotations

import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from ppvio.domain.catalog import CatalogLocation, CatalogMedia, CatalogPackage
from ppvio.domain.library_experience import ChannelFilters, InvalidExperience, validate_experience_snapshot
from ppvio.domain.tags import InvalidTag
from ppvio.infrastructure.sqlite import PlayerCatalogRepositorySQLite


def repository_class():
    return PlayerCatalogRepositorySQLite

class ChannelValidationTests(unittest.TestCase):
    def test_defaults_and_strict_types(self):
        filters = ChannelFilters.from_json({})
        self.assertEqual(filters.to_json()['match'], 'all')
        for payload in ({'unknown': 1}, {'include_tags': [True]}, {'premium_only': 1},
                        {'min_seconds': float('nan')}, {'max_seconds': -1},
                        {'min_seconds': 4, 'max_seconds': 2}, {'sort': 'resume'},
                        {'include_tags': list(range(1, 22))}):
            with self.subTest(payload=payload), self.assertRaises(InvalidExperience):
                ChannelFilters.from_json(payload)
        self.assertEqual(ChannelFilters.from_json({'include_tags': [2, 1, 2], 'exclude_tags': [2]}).to_json()['include_tags'], [1])


    def test_snapshot_references_alias_namespace_and_graph_are_validated(self):
        base = {'channels': [], 'ratings': [], 'bookmark_tags': [], 'tag_details': []}
        bad_cycle = {**base, 'tag_details': [
            {'tag_id': 1, 'aliases': [], 'parent_id': 2},
            {'tag_id': 2, 'aliases': [], 'parent_id': 1}]}
        with self.assertRaises(InvalidExperience):
            validate_experience_snapshot(bad_cycle)
        wrong_parent = {**base, 'tag_details': [{'tag_id': 1, 'aliases': [], 'parent_id': 99}]}
        with self.assertRaises(InvalidExperience):
            validate_experience_snapshot(wrong_parent, known_tag_ids={1})
        wrong_alias = {**base, 'tag_details': [{'tag_id': 1, 'aliases': ['SECOND'], 'parent_id': None}]}
        with self.assertRaises(InvalidExperience):
            validate_experience_snapshot(wrong_alias, tag_names={1: 'first', 2: 'second'})
        wrong_bookmark = {**base, 'bookmark_tags': [{'bookmark_id': 'f'*32, 'tag_ids': [1]}]}
        with self.assertRaises(InvalidExperience):
            validate_experience_snapshot(wrong_bookmark, known_tag_ids={1}, known_bookmark_ids=set())


class ExperienceRepositoryTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = TemporaryDirectory()
        self.repo = repository_class()(Path(self.tmp.name) / 'player.sqlite3')
        await self.repo.open()
        self.ids = [f'{n:064x}' for n in range(1, 5)]
        await self.repo.apply_package(CatalogPackage(
            'package', 'synthetic/package', 'a' * 64, None, None,
            tuple(CatalogMedia(mid, 'video', (n+1)*1000, 'video/mp4', 1080, 1920,
                               [10, 300, 301, 800][n]) for n, mid in enumerate(self.ids)),
            tuple(CatalogLocation(mid, 'package', f'{n}.mp4') for n, mid in enumerate(self.ids))))
        await self.repo.refresh_media_activity()
        self.a = (await self.repo.create_tag('A')).tag_id
        self.b = (await self.repo.create_tag('B')).tag_id
        self.c = (await self.repo.create_tag('C')).tag_id

    async def asyncTearDown(self):
        await self.repo.close()
        self.tmp.cleanup()

    async def test_history_epoch_blocks_late_writes_and_is_not_exported(self):
        state = await self.repo.get_history_settings()
        self.assertEqual(state, {'enabled': True, 'epoch': 0})
        self.assertTrue(await self.repo.record_history(self.ids[0], 4, epoch=0, seen_at=100))
        self.assertTrue(await self.repo.record_history(self.ids[0], 6, epoch=0, seen_at=101))
        self.assertEqual(await self.repo.list_history(), [{'media_id': self.ids[0], 'seen_at': 101, 'position_seconds': 6.0}])
        cleared = await self.repo.clear_history(self.ids[0])
        self.assertEqual(cleared['epoch'], 1)
        self.assertFalse(await self.repo.record_history(self.ids[0], 8, epoch=0))
        disabled = await self.repo.set_history_enabled(False)
        self.assertEqual(disabled, {'enabled': False, 'epoch': 2})
        self.assertFalse(await self.repo.record_history(self.ids[0], 8, epoch=2))
        await self.repo.set_history_enabled(True)
        self.assertEqual((await self.repo.get_history_settings())['epoch'], 3)
        self.assertNotIn('history', await self.repo.export_experience())

    async def test_history_caps_latest_records_and_filters_unavailable(self):
        conn = self.repo._require()
        conn.executemany('INSERT INTO player_view_history(media_id,seen_at,position_seconds) VALUES(?,?,?)',
                         [(f'{n:064x}', n, 0) for n in range(10, 2010)])
        conn.commit()
        await self.repo.record_history(self.ids[0], 1, epoch=0, seen_at=5000)
        self.assertEqual(conn.execute('SELECT COUNT(*) FROM player_view_history').fetchone()[0], 2000)
        self.assertIsNone(conn.execute('SELECT 1 FROM player_view_history WHERE media_id=?', (f'{10:064x}',)).fetchone())
        self.assertEqual(len(await self.repo.list_history()), 1)
        for bad in (True, -1, float('inf')):
            with self.assertRaises(InvalidExperience):
                await self.repo.record_history(self.ids[0], bad, epoch=0)
        with self.assertRaises(InvalidExperience):
            await self.repo.record_history(self.ids[0], 11, epoch=0)

    async def test_channels_live_boolean_filters_and_premium_independence(self):
        for mid, tag in ((self.ids[0], self.a), (self.ids[1], self.a), (self.ids[1], self.b), (self.ids[2], self.b)):
            await self.repo.set_media_tag(mid, tag, enabled=True)
        channel = await self.repo.create_channel('  Favourites  ', {'include_tags': [self.a, self.b]})
        self.assertEqual(channel['name'], 'Favourites')
        self.assertEqual(await self.repo.query_channel_ids(channel['filters']), [self.ids[1]])
        self.assertEqual(await self.repo.query_channel_ids({'include_tags': [self.a, self.b], 'match': 'any', 'exclude_tags': [self.b]}), [self.ids[0]])
        self.assertEqual(await self.repo.query_channel_ids({'category': 'short'}), self.ids[:2])
        self.assertEqual(await self.repo.query_channel_ids({'category': 'long'}), self.ids[2:])
        await self.repo.mark_watched(self.ids[0])
        self.assertEqual(await self.repo.query_channel_ids({'watched': 'watched'}), self.ids[:1])
        await self.repo.set_premium(self.ids[2], True)
        self.assertEqual(await self.repo.query_channel_ids({'premium_only': True}), self.ids[2:3])
        self.assertFalse(await self.repo.is_global_favorite(self.ids[2]))
        await self.repo.set_media_tag(self.ids[3], self.a, enabled=True)
        await self.repo.set_media_tag(self.ids[3], self.b, enabled=True)
        self.assertEqual(await self.repo.query_channel_ids(channel['filters']), [self.ids[1], self.ids[3]])
        with self.assertRaises(InvalidExperience):
            await self.repo.create_channel('bad', {'include_tags': [999]})
        self.assertEqual(len(await self.repo.list_channels()), 1)

    async def test_channels_have_capacity_unique_names_and_stable_random_pages(self):
        for n in range(30):
            await self.repo.create_channel(str(n), {})
        with self.assertRaises(InvalidExperience):
            await self.repo.create_channel('overflow', {})
        with self.assertRaises(InvalidExperience):
            await self.repo.create_channel('0', {})
        all_ids = await self.repo.query_channel_ids({'sort': 'random'})
        first = await self.repo.query_channel_ids({'sort': 'random'}, limit=2)
        second = await self.repo.query_channel_ids({'sort': 'random'}, offset=2, limit=2)
        self.assertEqual(first+second, all_ids)

    async def test_bookmark_tags_validate_all_before_mutation(self):
        bookmark = await self.repo.add_bookmark(self.ids[0], 1)
        self.assertEqual(await self.repo.set_bookmark_tags(self.ids[0], bookmark.id, [self.b, self.a, self.a]), [self.a, self.b])
        with self.assertRaises(InvalidExperience):
            await self.repo.set_bookmark_tags(self.ids[0], bookmark.id, [self.c, 999])
        self.assertEqual(await self.repo.bookmark_tag_ids(self.ids[0], bookmark.id), [self.a, self.b])
        self.assertIsNone(await self.repo.bookmark_tag_ids(self.ids[1], bookmark.id))

    async def test_alias_namespace_parent_cycles_and_depth(self):
        detail = await self.repo.update_tag_details(self.a, {'aliases': ['alpha'], 'parent_id': self.b})
        self.assertEqual(detail['aliases'], ['alpha'])
        for name in ('ALPHA', 'a'):
            if name == 'a':
                self.assertEqual((await self.repo.create_tag(name)).tag_id, self.a)
            else:
                with self.assertRaises(InvalidTag):
                    await self.repo.create_tag(name)
        with self.assertRaises(InvalidTag):
            await self.repo.rename_tag(self.c, 'Alpha')
        with self.assertRaises(InvalidTag):
            await self.repo.update_tag_details(self.b, {'parent_id': self.a})
        with self.assertRaises(InvalidTag):
            await self.repo.update_tag_details(self.c, {'aliases': ['A']})
        previous = self.b
        for n in range(6):
            tag = (await self.repo.create_tag(f'depth{n}')).tag_id
            await self.repo.update_tag_details(previous, {'parent_id': tag})
            previous = tag
        with self.assertRaises(InvalidTag):
            await self.repo.update_tag_details(previous, {'parent_id': self.c})

    async def test_merge_moves_pending_bookmark_preferences_channels_and_children_atomically(self):
        bookmark = await self.repo.add_bookmark(self.ids[0], 1)
        await self.repo.set_bookmark_tags(self.ids[0], bookmark.id, [self.a])
        await self.repo.set_media_tag(self.ids[0], self.a, enabled=True)
        await self.repo.update_tag_details(self.a, {'aliases': ['alpha']})
        await self.repo.update_tag_details(self.c, {'parent_id': self.a})
        channel = await self.repo.create_channel('merge', {'include_tags': [self.a], 'exclude_tags': [self.b]})
        conn = self.repo._require()
        conn.execute('INSERT INTO player_pending_media_tags(media_id,tag_id,tagged_at) VALUES(?,?,?)', ('f'*64, self.a, 1))
        conn.execute('UPDATE player_feed_preferences SET preferred_tags=?,excluded_tags=? WHERE singleton=1', (json.dumps([self.a]), json.dumps([self.b])))
        conn.commit()
        await self.repo.merge_tags([self.a], self.b)
        self.assertEqual(await self.repo.media_tag_ids(self.ids[0]), [self.b])
        self.assertEqual(await self.repo.bookmark_tag_ids(self.ids[0], bookmark.id), [self.b])
        self.assertEqual(conn.execute('SELECT tag_id FROM player_pending_media_tags').fetchone()[0], self.b)
        self.assertEqual((await self.repo.get_channel(channel['id']))['filters']['include_tags'], [])
        self.assertEqual((await self.repo.get_channel(channel['id']))['filters']['exclude_tags'], [self.b])
        prefs = await self.repo.get_feed_preferences()
        self.assertEqual(prefs.preferred_tags, ())
        self.assertEqual(prefs.excluded_tags, (self.b,))
        catalog = {t['id']: t for t in await self.repo.list_tag_catalog()}
        self.assertNotIn(self.a, catalog)
        self.assertEqual(catalog[self.c]['parent_id'], self.b)
        self.assertIn('A', catalog[self.b]['aliases'])
        self.assertIn('alpha', catalog[self.b]['aliases'])
        before = await self.repo.export_experience()
        with self.assertRaises(InvalidTag):
            await self.repo.merge_tags([self.b], self.c)  # parent into descendant would cycle
        self.assertEqual(await self.repo.export_experience(), before)

    async def test_delete_prunes_channel_and_preference_references(self):
        channel = await self.repo.create_channel('delete', {'include_tags': [self.a], 'exclude_tags': [self.b]})
        await self.repo.delete_tag(self.a)
        self.assertEqual((await self.repo.get_channel(channel['id']))['filters']['include_tags'], [])

    async def test_history_is_disposable_and_other_metadata_marks_snapshot_dirty(self):
        initial = self.repo._require().execute('SELECT revision FROM player_bookmark_snapshot').fetchone()[0]
        await self.repo.record_history(self.ids[0], 1, epoch=0)
        await self.repo.clear_history()
        await self.repo.set_history_enabled(False)
        self.assertEqual(self.repo._require().execute('SELECT revision FROM player_bookmark_snapshot').fetchone()[0], initial)
        await self.repo.set_premium(self.ids[0], True)
        self.assertGreater(self.repo._require().execute('SELECT revision FROM player_bookmark_snapshot').fetchone()[0], initial)

    async def test_merge_alias_limit_rejection_preserves_every_source(self):
        await self.repo.update_tag_details(self.b, {'aliases': [f'alias{n}' for n in range(10)]})
        await self.repo.set_media_tag(self.ids[0], self.a, enabled=True)
        before = await self.repo.export_experience()
        with self.assertRaises(InvalidTag):
            await self.repo.merge_tags([self.a], self.b)
        self.assertEqual(await self.repo.export_experience(), before)
        self.assertEqual(await self.repo.media_tag_ids(self.ids[0]), [self.a])

    async def test_restore_late_failure_rolls_back_all_metadata_and_outer_recovery(self):
        before = await self.repo.export_experience()
        payload = {'channels': [{'id': 'f'*32, 'name': 'new', 'filters': {}, 'created_at': 1, 'updated_at': 1}],
                   'ratings': [{'media_id': 'e'*64, 'premium': True, 'updated_at': 1}],
                   'bookmark_tags': [{'bookmark_id': 'd'*32, 'tag_ids': [self.a]}],
                   'tag_details': [{'tag_id': self.a, 'aliases': ['newalias'], 'parent_id': None}]}
        with self.assertRaises(InvalidExperience):
            async with self.repo.recovery_transaction():
                await self.repo.set_history_enabled(False)
                await self.repo.restore_experience(payload, {self.a: self.a}, {})
        self.assertEqual(await self.repo.export_experience(), before)
        self.assertEqual(await self.repo.get_history_settings(), {'enabled': True, 'epoch': 0})

    async def test_snapshot_remaps_tags_and_bookmarks_and_rolls_back_failures(self):
        b = await self.repo.add_bookmark(self.ids[0], 1)
        await self.repo.set_bookmark_tags(self.ids[0], b.id, [self.a])
        await self.repo.update_tag_details(self.a, {'aliases': ['alpha'], 'parent_id': self.b})
        await self.repo.create_channel('snapshot', {'include_tags': [self.a]})
        await self.repo.set_premium(self.ids[0], True)
        payload = await self.repo.export_experience()
        self.assertEqual(validate_experience_snapshot(payload), payload)
        payload['bookmark_tags'][0]['bookmark_id'] = 'f'*32
        payload['bookmark_tags'][0]['tag_ids'] = [800]
        payload['channels'][0]['filters']['include_tags'] = [800]
        payload['tag_details'] = [{'tag_id': 800, 'aliases': ['other'], 'parent_id': None}]
        await self.repo.restore_experience(payload, {800: self.c}, {'f'*32: b.id})
        self.assertIn(self.c, await self.repo.bookmark_tag_ids(self.ids[0], b.id))
        before = await self.repo.export_experience()
        invalid = {**payload, 'tag_details': [{'tag_id': 800, 'aliases': ['B'], 'parent_id': None}]}
        with self.assertRaises((InvalidTag, InvalidExperience)):
            await self.repo.restore_experience(invalid, {800: self.c}, {'f'*32: b.id})
        self.assertEqual(await self.repo.export_experience(), before)
