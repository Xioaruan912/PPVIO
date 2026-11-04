from __future__ import annotations

import json
import secrets
import time

from ppvio.domain.library_experience import (
    MAX_CHANNELS, MAX_HISTORY, MAX_RATINGS, ChannelFilters, InvalidExperience,
    channel_identifier, clean_channel_name, media_identifier, nonnegative_seconds,
    tag_ids, timestamp, validate_experience_snapshot, validate_paging,
)
from ppvio.infrastructure.sqlite_curation import _VISIBLE_VIDEO
from ppvio.infrastructure.video_query import _order_sql, _watched_clause


def _channel(row) -> dict:
    return {'id': str(row['channel_id']), 'name': str(row['name']),
            'filters': ChannelFilters.from_json(json.loads(row['filters'])).to_json(),
            'created_at': int(row['created_at']), 'updated_at': int(row['updated_at'])}


def _known_tags(conn, values: list[int] | tuple[int, ...]) -> None:
    known = {int(row[0]) for row in conn.execute('SELECT tag_id FROM player_tags')}
    if not set(values) <= known:
        raise InvalidExperience('tag not found')


def remap_filters(filters: object, mapping: dict[int, int], *, remove: set[int] | None = None) -> dict:
    value = ChannelFilters.from_json(filters).to_json()
    removed = remove or set()
    for field in ('include_tags', 'exclude_tags'):
        value[field] = sorted({mapping.get(tag, tag) for tag in value[field] if tag not in removed})
    return ChannelFilters.from_json(value).to_json()


def rewrite_channel_tags_in(conn, mapping: dict[int, int], *, remove: set[int] | None = None) -> None:
    for row in conn.execute('SELECT channel_id,filters FROM player_channels').fetchall():
        before = json.loads(row['filters'])
        after = remap_filters(before, mapping, remove=remove)
        if before != after:
            conn.execute('UPDATE player_channels SET filters=?,updated_at=? WHERE channel_id=?',
                         (json.dumps(after), int(time.time()), row['channel_id']))


class PlayerExperienceRepositoryMixin:
    async def get_history_settings(self) -> dict:
        row = self._require().execute('SELECT enabled,epoch FROM player_history_settings WHERE singleton=1').fetchone()
        return {'enabled': bool(row[0]), 'epoch': int(row[1])}

    async def set_history_enabled(self, enabled: bool) -> dict:
        if type(enabled) is not bool:
            raise InvalidExperience('enabled must be boolean')
        async with self._write_transaction() as conn:
            conn.execute('UPDATE player_history_settings SET enabled=?,epoch=epoch+1 WHERE singleton=1 AND enabled<>?',
                         (int(enabled), int(enabled)))
            row = conn.execute('SELECT enabled,epoch FROM player_history_settings WHERE singleton=1').fetchone()
            return {'enabled': bool(row[0]), 'epoch': int(row[1])}

    async def record_history(self, media_id: str, position_seconds: float, *, epoch: int,
                             seen_at: int | None = None) -> bool:
        media_id, position = media_identifier(media_id), nonnegative_seconds(position_seconds)
        if type(epoch) is not int or epoch < 0:
            raise InvalidExperience('invalid history epoch')
        now = timestamp(int(time.time()) if seen_at is None else seen_at)
        async with self._write_transaction() as conn:
            row = conn.execute('SELECT enabled,epoch FROM player_history_settings WHERE singleton=1').fetchone()
            if not row[0] or row[1] != epoch:
                return False
            video = conn.execute(f'SELECT m.duration_seconds FROM media m WHERE m.media_id=? AND {_VISIBLE_VIDEO}',
                                 (media_id,)).fetchone()
            if video is None:
                raise InvalidExperience('video not found')
            if video[0] is not None and position > video[0]:
                raise InvalidExperience('history position exceeds video duration')
            conn.execute('''INSERT INTO player_view_history(media_id,seen_at,position_seconds) VALUES(?,?,?)
                ON CONFLICT(media_id) DO UPDATE SET seen_at=excluded.seen_at,position_seconds=excluded.position_seconds
                WHERE excluded.seen_at >= player_view_history.seen_at''', (media_id, now, position))
            conn.execute('''DELETE FROM player_view_history WHERE media_id IN (
                SELECT media_id FROM player_view_history ORDER BY seen_at DESC,media_id LIMIT -1 OFFSET ?)''', (MAX_HISTORY,))
            return True

    async def clear_history(self, media_id: str | None = None) -> dict:
        if media_id is not None:
            media_identifier(media_id)
        async with self._write_transaction() as conn:
            if media_id is None:
                conn.execute('DELETE FROM player_view_history')
            else:
                conn.execute('DELETE FROM player_view_history WHERE media_id=?', (media_id,))
            conn.execute('UPDATE player_history_settings SET epoch=epoch+1 WHERE singleton=1')
            row = conn.execute('SELECT enabled,epoch FROM player_history_settings WHERE singleton=1').fetchone()
            return {'enabled': bool(row[0]), 'epoch': int(row[1])}

    async def list_history(self, *, offset: int = 0, limit: int = 20) -> list[dict]:
        validate_paging(offset, limit, maximum=MAX_HISTORY)
        rows = self._require().execute(f'''SELECT h.media_id,h.seen_at,h.position_seconds
            FROM player_view_history h JOIN media m ON m.media_id=h.media_id WHERE {_VISIBLE_VIDEO}
            ORDER BY h.seen_at DESC,h.media_id LIMIT ? OFFSET ?''', (limit, offset)).fetchall()
        return [{'media_id': str(row[0]), 'seen_at': int(row[1]), 'position_seconds': float(row[2])} for row in rows]

    async def list_channels(self) -> list[dict]:
        return [_channel(row) for row in self._require().execute(
            'SELECT * FROM player_channels ORDER BY name COLLATE NOCASE,channel_id')]

    async def get_channel(self, channel_id: str) -> dict | None:
        channel_identifier(channel_id)
        row = self._require().execute('SELECT * FROM player_channels WHERE channel_id=?', (channel_id,)).fetchone()
        return None if row is None else _channel(row)

    async def create_channel(self, name: str, filters: object) -> dict:
        name, filters = clean_channel_name(name), ChannelFilters.from_json(filters)
        async with self._write_transaction() as conn:
            _known_tags(conn, filters.include_tags + filters.exclude_tags)
            if conn.execute('SELECT COUNT(*) FROM player_channels').fetchone()[0] >= MAX_CHANNELS:
                raise InvalidExperience(f'at most {MAX_CHANNELS} channels')
            if conn.execute('SELECT 1 FROM player_channels WHERE name=? COLLATE NOCASE', (name,)).fetchone():
                raise InvalidExperience('another channel has that name')
            now, ident = int(time.time()), secrets.token_hex(16)
            conn.execute('INSERT INTO player_channels(channel_id,name,filters,created_at,updated_at) VALUES(?,?,?,?,?)',
                         (ident, name, json.dumps(filters.to_json()), now, now))
            return {'id': ident, 'name': name, 'filters': filters.to_json(), 'created_at': now, 'updated_at': now}

    async def update_channel(self, channel_id: str, changes: dict) -> dict | None:
        channel_identifier(channel_id)
        if not isinstance(changes, dict) or not changes or set(changes) - {'name', 'filters'}:
            raise InvalidExperience('invalid channel fields')
        async with self._write_transaction() as conn:
            current = conn.execute('SELECT * FROM player_channels WHERE channel_id=?', (channel_id,)).fetchone()
            if current is None:
                return None
            value = _channel(current)
            name = clean_channel_name(changes.get('name', value['name']))
            filters = ChannelFilters.from_json(changes.get('filters', value['filters']))
            _known_tags(conn, filters.include_tags + filters.exclude_tags)
            if conn.execute('SELECT 1 FROM player_channels WHERE name=? COLLATE NOCASE AND channel_id<>?', (name, channel_id)).fetchone():
                raise InvalidExperience('another channel has that name')
            now = int(time.time())
            conn.execute('UPDATE player_channels SET name=?,filters=?,updated_at=? WHERE channel_id=?',
                         (name, json.dumps(filters.to_json()), now, channel_id))
            return {**value, 'name': name, 'filters': filters.to_json(), 'updated_at': now}

    async def delete_channel(self, channel_id: str) -> bool:
        channel_identifier(channel_id)
        async with self._write_transaction() as conn:
            return conn.execute('DELETE FROM player_channels WHERE channel_id=?', (channel_id,)).rowcount > 0

    async def query_channel_ids(self, filters: object, *, offset: int = 0, limit: int = 20,
                                large_video_seconds: float = 300) -> list[str]:
        filters = ChannelFilters.from_json(filters)
        validate_paging(offset, limit)
        _known_tags(self._require(), filters.include_tags + filters.exclude_tags)
        clauses = ["media.active=1", "media.kind='video'",
                   'NOT EXISTS(SELECT 1 FROM media_variants v WHERE v.variant_media_id=media.media_id)',
                   'NOT EXISTS(SELECT 1 FROM player_media_deletions d WHERE d.media_id=media.media_id)']
        params: list = []
        if filters.include_tags:
            placeholders = ','.join('?' for _ in filters.include_tags)
            if filters.match == 'all':
                clauses.append(f'(SELECT COUNT(*) FROM player_media_tags t WHERE t.media_id=media.media_id AND t.tag_id IN ({placeholders}))=?')
                params.extend((*filters.include_tags, len(filters.include_tags)))
            else:
                clauses.append(f'EXISTS(SELECT 1 FROM player_media_tags t WHERE t.media_id=media.media_id AND t.tag_id IN ({placeholders}))')
                params.extend(filters.include_tags)
        if filters.exclude_tags:
            placeholders = ','.join('?' for _ in filters.exclude_tags)
            clauses.append(f'NOT EXISTS(SELECT 1 FROM player_media_tags t WHERE t.media_id=media.media_id AND t.tag_id IN ({placeholders}))')
            params.extend(filters.exclude_tags)
        if filters.watched != 'all':
            clauses.append(('NOT ' if filters.watched == 'unwatched' else '') + _watched_clause())
        for bound, operator in ((filters.min_seconds, '>='), (filters.max_seconds, '<=')):
            if bound is not None:
                clauses.append(f'media.duration_seconds {operator} ?')
                params.append(bound)
        if filters.category != 'all':
            clauses.append('media.duration_seconds ' + ('>' if filters.category == 'long' else '<=') + ' ?')
            params.append(large_video_seconds)
        if filters.premium_only:
            clauses.append('EXISTS(SELECT 1 FROM player_media_ratings r WHERE r.media_id=media.media_id AND r.premium=1)')
        sql = ('SELECT media.media_id FROM media WHERE ' + ' AND '.join(clauses)
               + ' ORDER BY ' + _order_sql('media_id', filters.sort, 0) + ' LIMIT ? OFFSET ?')
        return [str(row[0]) for row in self._require().execute(sql, (*params, limit, offset))]

    async def is_premium(self, media_id: str) -> bool:
        row = self._require().execute('SELECT premium FROM player_media_ratings WHERE media_id=?', (media_id,)).fetchone()
        return row is not None and bool(row[0])

    async def set_premium(self, media_id: str, premium: bool) -> bool:
        media_identifier(media_id)
        if type(premium) is not bool:
            raise InvalidExperience('premium must be boolean')
        async with self._write_transaction() as conn:
            if conn.execute(f'SELECT 1 FROM media m WHERE m.media_id=? AND {_VISIBLE_VIDEO}', (media_id,)).fetchone() is None:
                return False
            if conn.execute('SELECT 1 FROM player_media_ratings WHERE media_id=?', (media_id,)).fetchone() is None:
                if conn.execute('SELECT COUNT(*) FROM player_media_ratings').fetchone()[0] >= MAX_RATINGS:
                    raise InvalidExperience('too many rating records')
            conn.execute('''INSERT INTO player_media_ratings(media_id,premium,updated_at) VALUES(?,?,?)
                ON CONFLICT(media_id) DO UPDATE SET premium=excluded.premium,updated_at=excluded.updated_at''',
                         (media_id, int(premium), int(time.time())))
            return True

    async def bookmark_tag_ids(self, media_id: str, bookmark_id: str) -> list[int] | None:
        conn = self._require()
        if conn.execute('SELECT 1 FROM player_bookmarks WHERE media_id=? AND bookmark_id=?', (media_id, bookmark_id)).fetchone() is None:
            return None
        return [int(row[0]) for row in conn.execute('SELECT tag_id FROM player_bookmark_tags WHERE bookmark_id=? ORDER BY tag_id', (bookmark_id,))]

    async def set_bookmark_tags(self, media_id: str, bookmark_id: str, values: list[int]) -> list[int] | None:
        values = tag_ids(values)
        async with self._write_transaction() as conn:
            _known_tags(conn, values)
            if conn.execute('SELECT 1 FROM player_bookmarks WHERE media_id=? AND bookmark_id=?', (media_id, bookmark_id)).fetchone() is None:
                return None
            conn.execute('DELETE FROM player_bookmark_tags WHERE bookmark_id=?', (bookmark_id,))
            conn.executemany('INSERT INTO player_bookmark_tags(bookmark_id,tag_id) VALUES(?,?)', [(bookmark_id, tag) for tag in values])
            return values

    async def export_experience(self) -> dict:
        # All component reads happen synchronously under the existing write transaction.
        async with self._write_transaction() as conn:
            grouped: dict[str, list[int]] = {}
            for row in conn.execute('SELECT bookmark_id,tag_id FROM player_bookmark_tags ORDER BY bookmark_id,tag_id'):
                grouped.setdefault(str(row[0]), []).append(int(row[1]))
            return validate_experience_snapshot({
                'channels': [_channel(row) for row in conn.execute('SELECT * FROM player_channels ORDER BY channel_id')],
                'ratings': [{'media_id': str(row[0]), 'premium': bool(row[1]), 'updated_at': int(row[2])}
                            for row in conn.execute('SELECT media_id,premium,updated_at FROM player_media_ratings ORDER BY media_id')],
                'bookmark_tags': [{'bookmark_id': key, 'tag_ids': values} for key, values in grouped.items()],
                'tag_details': self._export_tag_details_in(conn),
            })

    async def restore_experience(self, payload: object, tag_mapping: dict[int, int],
                                  bookmark_mapping: dict[str, str]) -> None:
        payload = validate_experience_snapshot(payload)
        async with self._write_transaction() as conn:
            def mapped(tag):
                if tag not in tag_mapping:
                    raise InvalidExperience('snapshot tag mapping is missing')
                target = tag_mapping[tag]
                _known_tags(conn, [target])
                return target
            channels = []
            for channel in payload['channels']:
                filters = channel['filters']
                mapping = {tag: mapped(tag) for tag in filters['include_tags'] + filters['exclude_tags']}
                channels.append({**channel, 'filters': remap_filters(filters, mapping)})
            details = [{'tag_id': mapped(row['tag_id']), 'aliases': row['aliases'],
                        'parent_id': None if row['parent_id'] is None else mapped(row['parent_id'])}
                       for row in payload['tag_details']]
            self._restore_tag_details_in(conn, details)
            for channel in channels:
                row = conn.execute('SELECT * FROM player_channels WHERE name=? COLLATE NOCASE', (channel['name'],)).fetchone()
                if row is not None:
                    if channel['updated_at'] >= row['updated_at']:
                        conn.execute('UPDATE player_channels SET filters=?,updated_at=? WHERE channel_id=?',
                                     (json.dumps(channel['filters']), channel['updated_at'], row['channel_id']))
                    continue
                if conn.execute('SELECT COUNT(*) FROM player_channels').fetchone()[0] >= MAX_CHANNELS:
                    raise InvalidExperience(f'at most {MAX_CHANNELS} channels')
                ident = channel['id']
                if conn.execute('SELECT 1 FROM player_channels WHERE channel_id=?', (ident,)).fetchone():
                    ident = secrets.token_hex(16)
                conn.execute('INSERT INTO player_channels(channel_id,name,filters,created_at,updated_at) VALUES(?,?,?,?,?)',
                             (ident, channel['name'], json.dumps(channel['filters']), channel['created_at'], channel['updated_at']))
            for row in payload['ratings']:
                conn.execute('''INSERT INTO player_media_ratings(media_id,premium,updated_at) VALUES(?,?,?)
                    ON CONFLICT(media_id) DO UPDATE SET premium=excluded.premium,updated_at=excluded.updated_at
                    WHERE excluded.updated_at >= player_media_ratings.updated_at''',
                             (row['media_id'], int(row['premium']), row['updated_at']))
            if conn.execute('SELECT COUNT(*) FROM player_media_ratings').fetchone()[0] > MAX_RATINGS:
                raise InvalidExperience('too many rating records')
            for row in payload['bookmark_tags']:
                bookmark = bookmark_mapping.get(row['bookmark_id'])
                if bookmark is None or conn.execute('SELECT 1 FROM player_bookmarks WHERE bookmark_id=?', (bookmark,)).fetchone() is None:
                    raise InvalidExperience('snapshot bookmark mapping is missing')
                tags = {mapped(tag) for tag in row['tag_ids']}
                tags.update(int(r[0]) for r in conn.execute('SELECT tag_id FROM player_bookmark_tags WHERE bookmark_id=?', (bookmark,)))
                tag_ids(sorted(tags))
                conn.executemany('INSERT OR IGNORE INTO player_bookmark_tags(bookmark_id,tag_id) VALUES(?,?)', [(bookmark, tag) for tag in sorted(tags)])
