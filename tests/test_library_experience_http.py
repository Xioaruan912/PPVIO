from __future__ import annotations

from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from aiohttp.test_utils import TestClient, TestServer

from ppvio.adapters.http import PlayerHttpServer
from ppvio.application.auth import SessionService
from ppvio.application.feed import ShuffleDeckService
from ppvio.domain.catalog import CatalogLocation, CatalogMedia, CatalogPackage
from test_library_experience import repository_class


class DummyReader:
    async def open_range(self, remote_path, byte_range):
        raise AssertionError('not streaming')


class ExperienceHttpTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = TemporaryDirectory()
        self.repo = repository_class()(Path(self.tmp.name) / 'player.sqlite3')
        await self.repo.open()
        self.media_id = '1' * 64
        await self.repo.apply_package(CatalogPackage('package', 'synthetic/package', 'b'*64, None, None,
            (CatalogMedia(self.media_id, 'video', 1000, 'video/mp4', 1080, 1920, 30),),
            (CatalogLocation(self.media_id, 'package', '1.mp4'),)))
        await self.repo.refresh_media_activity()
        server = PlayerHttpServer(self.repo, SessionService(self.repo, access_secret='s'*32), ShuffleDeckService(self.repo), DummyReader(), large_video_seconds=300)
        app = server.application()
        self.client = TestClient(TestServer(app))
        await self.client.start_server()
        response = await self.client.post('/api/v1/auth/login', json={'secret': 's'*32})
        self.cookies = {'ppvio_session': response.cookies['ppvio_session'].value}

    async def asyncTearDown(self):
        await self.client.close()
        await self.repo.close()
        self.tmp.cleanup()

    async def call(self, method, path, **kwargs):
        response = await self.client.request(method, path, cookies=self.cookies, **kwargs)
        body = await response.json() if response.content_type == 'application/json' else await response.text()
        return response.status, body

    async def test_history_settings_record_paging_and_epoch(self):
        status, settings = await self.call('GET', '/api/v1/history/settings')
        self.assertEqual((status, settings), (200, {'enabled': True, 'epoch': 0}))
        self.assertEqual(await self.call('POST', '/api/v1/history', json={'media_id': self.media_id, 'position_seconds': 3, 'epoch': 0}), (200, {'recorded': True}))
        status, history = await self.call('GET', '/api/v1/history?limit=1')
        self.assertEqual(status, 200)
        self.assertEqual(history['items'][0]['id'], self.media_id)
        self.assertEqual(history['items'][0]['position_seconds'], 3)
        self.assertFalse(history['has_more'])
        self.assertEqual((await self.call('GET', '/api/v1/history?limit=101'))[0], 400)
        status, cleared = await self.call('DELETE', '/api/v1/history')
        self.assertEqual((status, cleared['epoch']), (200, 1))
        self.assertEqual((await self.call('POST', '/api/v1/history', json={'media_id': self.media_id, 'position_seconds': 4, 'epoch': 0}))[1], {'recorded': False})

    async def test_channel_and_premium_endpoints(self):
        status, channel = await self.call('POST', '/api/v1/channels', json={'name': 'test', 'filters': {}})
        self.assertEqual(status, 201)
        self.assertEqual((await self.call('GET', f"/api/v1/channels/{channel['id']}/items"))[1]['items'][0]['id'], self.media_id)
        self.assertEqual((await self.call('POST', '/api/v1/channels/query', json={'filters': {'premium_only': True}}))[1]['items'], [])
        self.assertEqual((await self.call('PUT', f'/api/v1/media/{self.media_id}/premium', json={'premium': True}))[0], 200)
        self.assertTrue((await self.call('PUT', f'/api/v1/media/{self.media_id}/premium', json={'premium': True}))[1]['premium'])
        self.assertEqual((await self.call('POST', '/api/v1/channels/query', json={'filters': {'premium_only': True}}))[1]['items'][0]['id'], self.media_id)
        self.assertEqual((await self.call('PATCH', f"/api/v1/channels/{channel['id']}", json={'name': 'new'}))[1]['name'], 'new')
        self.assertEqual((await self.call('POST', '/api/v1/channels/query', json={'filters': {'hacked': True}}))[0], 400)
        self.assertEqual((await self.call('DELETE', f"/api/v1/channels/{channel['id']}"))[0], 200)

    async def test_bookmark_tag_and_catalog_endpoints(self):
        tag = await self.repo.create_tag('tag')
        bookmark = await self.repo.add_bookmark(self.media_id, 1)
        path = f'/api/v1/media/{self.media_id}/bookmarks/{bookmark.id}/tags'
        self.assertEqual(await self.call('PUT', path, json={'tag_ids': [tag.tag_id]}), (200, {'tag_ids': [tag.tag_id]}))
        self.assertEqual((await self.call('GET', path))[1], {'tag_ids': [tag.tag_id]})
        self.assertEqual((await self.call('PATCH', f'/api/v1/tag-catalog/{tag.tag_id}', json={'aliases': ['alias']}))[1]['aliases'], ['alias'])
        other = await self.repo.create_tag('other')
        status, body = await self.call('POST', '/api/v1/tag-catalog/merge', json={'source_ids': [other.tag_id], 'target_id': tag.tag_id})
        self.assertEqual(status, 200)
        self.assertEqual(len(body['items']), 1)

    async def test_all_mutations_reject_foreign_origin_before_writes(self):
        for method, path, body in (
            ('PUT', '/api/v1/history/settings', {'enabled': False}),
            ('POST', '/api/v1/history', {'media_id': self.media_id, 'position_seconds': 1, 'epoch': 0}),
            ('DELETE', '/api/v1/history', None),
            ('POST', '/api/v1/channels', {'name': 'bad', 'filters': {}}),
            ('POST', '/api/v1/channels/query', {'filters': {}}),
            ('PUT', f'/api/v1/media/{self.media_id}/premium', {'premium': True}),
            ('POST', '/api/v1/tag-catalog/merge', {'source_ids': [], 'target_id': 1}),
        ):
            with self.subTest(path=path):
                self.assertEqual((await self.call(method, path, json=body, headers={'Origin': 'https://other.example'}))[0], 403)
        self.assertEqual(await self.repo.get_history_settings(), {'enabled': True, 'epoch': 0})
        self.assertEqual(await self.repo.list_channels(), [])

    async def test_auth_and_opaque_identifiers_and_strict_payloads(self):
        self.client.session.cookie_jar.clear()
        response = await self.client.get('/api/v1/history')
        self.assertEqual(response.status, 401)
        self.assertEqual((await self.call('DELETE', '/api/v1/history/not-a-hash'))[0], 404)
        self.assertEqual((await self.call('PUT', '/api/v1/history/settings', json={'enabled': True, 'extra': 1}))[0], 400)
        self.assertEqual((await self.call('POST', '/api/v1/channels/query', json={'filters': {}, 'offset': True}))[0], 400)
