from __future__ import annotations

import json
import time

from ppvio.domain.library_experience import (
    MAX_ALIASES, InvalidExperience, clean_aliases, tag_ids, validate_parent_graph,
)
from ppvio.domain.tags import MAX_TAGS, InvalidTag, Tag, clean_tag_name, tag_name_key
from ppvio.infrastructure.sqlite_experience import rewrite_channel_tags_in
from ppvio.infrastructure.sqlite_legacy_tags import remap_legacy_group_tags_in


def _tag_error(callback, *args):
    try:
        return callback(*args)
    except InvalidExperience as exc:
        raise InvalidTag(str(exc)) from None


def _catalog_state(conn) -> tuple[dict, dict, dict]:
    names = {int(row[0]): str(row[1]) for row in conn.execute('SELECT tag_id,name FROM player_tags')}
    aliases = {tag: [] for tag in names}
    for row in conn.execute('SELECT tag_id,alias FROM player_tag_aliases ORDER BY alias COLLATE NOCASE'):
        aliases[int(row[0])].append(str(row[1]))
    parents = {int(row[0]): int(row[1]) for row in conn.execute('SELECT tag_id,parent_id FROM player_tag_parents')}
    return names, aliases, parents


def _validate_catalog(names, aliases, parents) -> None:
    occupied = {tag_name_key(name): tag for tag, name in names.items()}
    for tag, values in aliases.items():
        if tag not in names:
            raise InvalidTag('tag not found')
        values = _tag_error(clean_aliases, values)
        for alias in values:
            key = tag_name_key(alias)
            if key in occupied:
                raise InvalidTag('a tag name or alias already exists')
            occupied[key] = tag
    _tag_error(validate_parent_graph, parents, set(names))


def _write_details(conn, aliases, parents, changed: set[int]) -> None:
    for tag in changed:
        conn.execute('DELETE FROM player_tag_aliases WHERE tag_id=?', (tag,))
        conn.execute('DELETE FROM player_tag_parents WHERE tag_id=?', (tag,))
    for tag in changed:
        conn.executemany('INSERT INTO player_tag_aliases(alias,tag_id) VALUES(?,?)', [(alias, tag) for alias in aliases[tag]])
        if parents.get(tag) is not None:
            conn.execute('INSERT INTO player_tag_parents(tag_id,parent_id) VALUES(?,?)', (tag, parents[tag]))


def _rewrite_preferences(conn, mapping: dict[int, int], *, remove: set[int] | None = None) -> None:
    row = conn.execute('SELECT preferred_tags,excluded_tags,mode FROM player_feed_preferences WHERE singleton=1').fetchone()
    removed = remove or set()
    preferred, excluded = [{mapping.get(tag, tag) for tag in json.loads(row[index]) if tag not in removed}
                           for index in (0, 1)]
    preferred -= excluded
    mode = row[2]
    conn.execute('UPDATE player_feed_preferences SET preferred_tags=?,excluded_tags=?,mode=? WHERE singleton=1',
                 (json.dumps(sorted(preferred)), json.dumps(sorted(excluded)), mode))


class PlayerTagCatalogRepositoryMixin:
    """Overrides the legacy tag mutations so the shared namespace stays valid."""

    async def create_tag(self, name: str) -> Tag:
        name = clean_tag_name(name)
        async with self._write_transaction() as conn:
            row = conn.execute('SELECT tag_id,name FROM player_tags WHERE name=? COLLATE NOCASE', (name,)).fetchone()
            if row is not None:
                return Tag(int(row[0]), str(row[1]))
            if conn.execute('SELECT 1 FROM player_tag_aliases WHERE alias=? COLLATE NOCASE', (name,)).fetchone():
                raise InvalidTag('a tag alias already has that name')
            if conn.execute('SELECT COUNT(*) FROM player_tags').fetchone()[0] >= MAX_TAGS:
                raise InvalidTag(f'at most {MAX_TAGS} tags')
            cursor = conn.execute('INSERT INTO player_tags(name,created_at) VALUES(?,?)', (name, int(time.time())))
            return Tag(int(cursor.lastrowid), name)

    async def rename_tag(self, tag_id: int, name: str) -> bool:
        return await self.update_tag_details(tag_id, {'name': name}) is not None

    async def delete_tag(self, tag_id: int) -> bool:
        tag_id = _tag_error(tag_ids, [tag_id])[0]
        async with self._write_transaction() as conn:
            if conn.execute('SELECT 1 FROM player_tags WHERE tag_id=?', (tag_id,)).fetchone() is None:
                return False
            rewrite_channel_tags_in(conn, {}, remove={tag_id})
            _rewrite_preferences(conn, {}, remove={tag_id})
            conn.execute('DELETE FROM player_tags WHERE tag_id=?', (tag_id,))
            return True

    async def list_tag_catalog(self) -> list[dict]:
        conn = self._require()
        names, aliases, parents = _catalog_state(conn)
        counts = {int(row[0]): int(row[1]) for row in conn.execute('''SELECT mt.tag_id,COUNT(m.media_id)
            FROM player_media_tags mt JOIN media m ON m.media_id=mt.media_id AND m.active=1 GROUP BY mt.tag_id''')}
        return [{'id': tag, 'name': names[tag], 'count': counts.get(tag, 0),
                 'aliases': aliases[tag], 'parent_id': parents.get(tag)}
                for tag in sorted(names, key=lambda tag: (tag_name_key(names[tag]), tag))]

    async def update_tag_details(self, tag_id: int, changes: dict) -> dict | None:
        tag_id = _tag_error(tag_ids, [tag_id])[0]
        if not isinstance(changes, dict) or not changes or set(changes) - {'name', 'aliases', 'parent_id'}:
            raise InvalidTag('invalid tag detail fields')
        async with self._write_transaction() as conn:
            names, aliases, parents = _catalog_state(conn)
            if tag_id not in names:
                return None
            if 'name' in changes:
                names[tag_id] = clean_tag_name(changes['name'])
            if 'aliases' in changes:
                aliases[tag_id] = _tag_error(clean_aliases, changes['aliases'])
            if 'parent_id' in changes:
                parent = changes['parent_id']
                parents[tag_id] = None if parent is None else _tag_error(tag_ids, [parent])[0]
            # Names use ASCII NOCASE, identical to the database and legacy API.
            if len({tag_name_key(name) for name in names.values()}) != len(names):
                raise InvalidTag('another tag has that name')
            _validate_catalog(names, aliases, parents)
            conn.execute('UPDATE player_tags SET name=? WHERE tag_id=?', (names[tag_id], tag_id))
            _write_details(conn, aliases, parents, {tag_id})
            count = conn.execute('SELECT COUNT(*) FROM player_media_tags t JOIN media m ON m.media_id=t.media_id AND m.active=1 WHERE tag_id=?', (tag_id,)).fetchone()[0]
            return {'id': tag_id, 'name': names[tag_id], 'count': int(count),
                    'aliases': aliases[tag_id], 'parent_id': parents.get(tag_id)}

    async def merge_tags(self, source_ids: list[int], target_id: int) -> list[dict]:
        source_ids = _tag_error(lambda values: tag_ids(values, limit=MAX_TAGS), source_ids)
        target_id = _tag_error(tag_ids, [target_id])[0]
        if not source_ids or target_id in source_ids:
            raise InvalidTag('select source tags and a separate target')
        async with self._write_transaction() as conn:
            names, aliases, parents = _catalog_state(conn)
            sources = set(source_ids)
            if not sources | {target_id} <= set(names):
                raise InvalidTag('tag not found')
            # Merging an ancestor into its descendant cannot retain the parent intent.
            ancestor = parents.get(target_id)
            while ancestor is not None:
                if ancestor in sources:
                    raise InvalidTag('cannot merge a parent into its descendant')
                ancestor = parents.get(ancestor)
            target_aliases = {tag_name_key(alias): alias for alias in aliases[target_id]}
            for source in source_ids:
                for alias in [names[source], *aliases[source]]:
                    target_aliases.setdefault(tag_name_key(alias), alias)
            aliases[target_id] = sorted(target_aliases.values(), key=tag_name_key)
            if len(aliases[target_id]) > MAX_ALIASES:
                raise InvalidTag(f'at most {MAX_ALIASES} aliases per tag after merge')
            for child, parent in list(parents.items()):
                if parent in sources:
                    parents[child] = target_id
            for source in sources:
                del names[source]
                del aliases[source]
                parents.pop(source, None)
            _validate_catalog(names, aliases, parents)
            for source in source_ids:
                for table in ('player_media_tags', 'player_pending_media_tags'):
                    conn.execute(f'''INSERT INTO {table}(media_id,tag_id,tagged_at)
                        SELECT media_id,?,tagged_at FROM {table} WHERE tag_id=?
                        ON CONFLICT(media_id,tag_id) DO UPDATE SET tagged_at=MAX(tagged_at,excluded.tagged_at)''', (target_id, source))
                conn.execute('''INSERT OR IGNORE INTO player_bookmark_tags(bookmark_id,tag_id)
                    SELECT bookmark_id,? FROM player_bookmark_tags WHERE tag_id=?''', (target_id, source))
            mapping = {source: target_id for source in source_ids}
            rewrite_channel_tags_in(conn, mapping)
            _rewrite_preferences(conn, mapping)
            remap_legacy_group_tags_in(conn, mapping)
            for source in source_ids:
                conn.execute('DELETE FROM player_tags WHERE tag_id=?', (source,))
            # Deleting a source cascades its old parent and alias rows.
            _write_details(conn, aliases, parents, set(names))
            return await self.list_tag_catalog()

    @staticmethod
    def _export_tag_details_in(conn) -> list[dict]:
        names, aliases, parents = _catalog_state(conn)
        return [{'tag_id': tag, 'aliases': aliases[tag], 'parent_id': parents.get(tag)} for tag in sorted(names)]

    @staticmethod
    def _restore_tag_details_in(conn, details: list[dict]) -> None:
        names, aliases, parents = _catalog_state(conn)
        changed = set()
        for row in details:
            tag = row['tag_id']
            if tag not in names:
                raise InvalidTag('tag not found')
            merged = {tag_name_key(alias): alias for alias in aliases[tag]}
            merged.update({tag_name_key(alias): alias for alias in row['aliases']})
            aliases[tag] = sorted(merged.values(), key=tag_name_key)
            parents[tag] = row['parent_id']
            changed.add(tag)
        _validate_catalog(names, aliases, parents)
        _write_details(conn, aliases, parents, changed)
