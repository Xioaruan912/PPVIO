"""Validated viewer metadata. This module never reads catalog storage."""
from __future__ import annotations

from dataclasses import dataclass
import math
import re
import unicodedata

from ppvio.domain.bookmarks import MAX_BOOKMARKS, valid_bookmark_id
from ppvio.domain.tags import MAX_TAGS, InvalidTag, clean_tag_name, tag_name_key

MAX_HISTORY = 2000
MAX_CHANNELS = 30
MAX_FILTER_TAGS = 20
MAX_ALIASES = 10
MAX_TAG_DEPTH = 8
MAX_RATINGS = 100000
_MEDIA_ID = re.compile(r'^[0-9a-f]{64}$')
_CHANNEL_ID = re.compile(r'^[0-9a-f]{32}$')


class InvalidExperience(ValueError):
    pass


def media_identifier(value: object) -> str:
    if not isinstance(value, str) or not _MEDIA_ID.fullmatch(value):
        raise InvalidExperience('invalid media identifier')
    return value


def channel_identifier(value: object) -> str:
    if not isinstance(value, str) or not _CHANNEL_ID.fullmatch(value):
        raise InvalidExperience('invalid channel identifier')
    return value


def clean_channel_name(value: object) -> str:
    if not isinstance(value, str):
        raise InvalidExperience('channel name must be text')
    name = ' '.join(value.split())
    if not name or len(name) > 60 or any(unicodedata.category(ch).startswith('C') for ch in name):
        raise InvalidExperience('channel name must have 1 to 60 visible characters')
    return name


def tag_ids(value: object, *, limit: int = MAX_FILTER_TAGS) -> list[int]:
    if (not isinstance(value, list) or len(value) > limit
            or any(type(item) is not int or not 0 < item < 2**63 for item in value)):
        raise InvalidExperience(f'at most {limit} positive tag identifiers are required')
    return sorted(set(value))


def nonnegative_seconds(value: object) -> float:
    if (type(value) not in (int, float) or not 0 <= value < 2**53
            or not math.isfinite(value)):
        raise InvalidExperience('invalid playback position or duration')
    return float(value)


def timestamp(value: object) -> int:
    if type(value) is not int or not 0 <= value < 2**63:
        raise InvalidExperience('invalid timestamp')
    return value


def validate_paging(offset: object, limit: object, *, maximum: int = MAX_RATINGS) -> tuple[int, int]:
    if type(offset) is not int or not 0 <= offset <= maximum or type(limit) is not int or not 1 <= limit <= 101:
        raise InvalidExperience('invalid paging')
    return offset, limit


@dataclass(frozen=True, slots=True)
class ChannelFilters:
    include_tags: tuple[int, ...] = ()
    exclude_tags: tuple[int, ...] = ()
    match: str = 'all'
    watched: str = 'all'
    min_seconds: float | None = None
    max_seconds: float | None = None
    category: str = 'all'
    premium_only: bool = False
    sort: str = 'newest'

    @classmethod
    def from_json(cls, value: object) -> ChannelFilters:
        if not isinstance(value, dict) or set(value) - set(cls.__dataclass_fields__):
            raise InvalidExperience('invalid channel filters')
        exclude = tag_ids(value.get('exclude_tags', []))
        include = [tag for tag in tag_ids(value.get('include_tags', [])) if tag not in exclude]
        match, watched = value.get('match', 'all'), value.get('watched', 'all')
        category, sort = value.get('category', 'all'), value.get('sort', 'newest')
        if (match not in ('all', 'any') or watched not in ('all', 'unwatched', 'watched')
                or category not in ('all', 'short', 'long')
                or sort not in ('newest', 'longest', 'largest', 'random')
                or type(value.get('premium_only', False)) is not bool):
            raise InvalidExperience('invalid channel filter choice')
        low, high = value.get('min_seconds'), value.get('max_seconds')
        low = None if low is None else nonnegative_seconds(low)
        high = None if high is None else nonnegative_seconds(high)
        if low is not None and high is not None and low > high:
            raise InvalidExperience('minimum duration exceeds maximum')
        return cls(tuple(include), tuple(exclude), match, watched, low, high, category,
                   value.get('premium_only', False), sort)

    def to_json(self) -> dict:
        return {field: list(value) if isinstance(value, tuple) else value
                for field, value in ((field, getattr(self, field)) for field in self.__dataclass_fields__)}


def clean_aliases(value: object) -> list[str]:
    if not isinstance(value, list) or len(value) > MAX_ALIASES:
        raise InvalidExperience(f'at most {MAX_ALIASES} aliases per tag')
    try:
        aliases = [clean_tag_name(alias) for alias in value]
    except InvalidTag as exc:
        raise InvalidExperience(str(exc)) from None
    if len({tag_name_key(alias) for alias in aliases}) != len(aliases):
        raise InvalidExperience('duplicate tag alias')
    return sorted(aliases, key=tag_name_key)


def validate_parent_graph(parents: dict[int, int | None], known: set[int]) -> None:
    for child in known:
        seen: set[int] = set()
        node: int | None = child
        while node is not None:
            if node not in known:
                raise InvalidExperience('parent tag not found')
            if node in seen:
                raise InvalidExperience('tag parent cycle')
            seen.add(node)
            if len(seen) > MAX_TAG_DEPTH:
                raise InvalidExperience(f'tag hierarchy is at most {MAX_TAG_DEPTH} levels')
            node = parents.get(node)


def validate_experience_snapshot(value: object, *, known_tag_ids: set[int] | None = None,
                                 known_bookmark_ids: set[str] | None = None,
                                 tag_names: dict[int, str] | None = None) -> dict:
    """Normalize the self-contained v5 extension before any recovery writes."""
    fields = {'channels', 'ratings', 'bookmark_tags', 'tag_details'}
    if not isinstance(value, dict) or set(value) - fields:
        raise InvalidExperience('invalid experience snapshot')
    limits = {'channels': MAX_CHANNELS, 'ratings': MAX_RATINGS,
              'bookmark_tags': MAX_BOOKMARKS, 'tag_details': MAX_TAGS}
    result = {}
    for field, limit in limits.items():
        rows = value.get(field, [])
        if not isinstance(rows, list) or len(rows) > limit:
            raise InvalidExperience(f'too many {field} records')
        result[field] = []
    seen_ids, seen_names = set(), set()
    for row in value.get('channels', []):
        if not isinstance(row, dict) or set(row) != {'id', 'name', 'filters', 'created_at', 'updated_at'}:
            raise InvalidExperience('invalid channel record')
        ident, name = channel_identifier(row['id']), clean_channel_name(row['name'])
        if ident in seen_ids or tag_name_key(name) in seen_names:
            raise InvalidExperience('duplicate channel record')
        seen_ids.add(ident)
        seen_names.add(tag_name_key(name))
        result['channels'].append({'id': ident, 'name': name,
            'filters': ChannelFilters.from_json(row['filters']).to_json(),
            'created_at': timestamp(row['created_at']), 'updated_at': timestamp(row['updated_at'])})
    seen = set()
    for row in value.get('ratings', []):
        if not isinstance(row, dict) or set(row) != {'media_id', 'premium', 'updated_at'} or type(row['premium']) is not bool:
            raise InvalidExperience('invalid rating record')
        ident = media_identifier(row['media_id'])
        if ident in seen:
            raise InvalidExperience('duplicate rating record')
        seen.add(ident)
        result['ratings'].append({'media_id': ident, 'premium': row['premium'], 'updated_at': timestamp(row['updated_at'])})
    seen = set()
    for row in value.get('bookmark_tags', []):
        if not isinstance(row, dict) or set(row) != {'bookmark_id', 'tag_ids'} or not valid_bookmark_id(row['bookmark_id']):
            raise InvalidExperience('invalid bookmark tag record')
        if row['bookmark_id'] in seen:
            raise InvalidExperience('duplicate bookmark tag record')
        seen.add(row['bookmark_id'])
        result['bookmark_tags'].append({'bookmark_id': row['bookmark_id'], 'tag_ids': tag_ids(row['tag_ids'])})
    seen, aliases = set(), set()
    for row in value.get('tag_details', []):
        if not isinstance(row, dict) or set(row) != {'tag_id', 'aliases', 'parent_id'}:
            raise InvalidExperience('invalid tag detail record')
        ident = tag_ids([row['tag_id']])[0]
        parent = row['parent_id']
        if parent is not None:
            parent = tag_ids([parent])[0]
        names = clean_aliases(row['aliases'])
        keys = {tag_name_key(alias) for alias in names}
        if ident in seen or aliases & keys:
            raise InvalidExperience('duplicate tag detail or alias')
        seen.add(ident)
        aliases.update(keys)
        result['tag_details'].append({'tag_id': ident, 'aliases': names, 'parent_id': parent})
    references = set()
    for channel in result['channels']:
        references.update(channel['filters']['include_tags'] + channel['filters']['exclude_tags'])
    for row in result['bookmark_tags']:
        references.update(row['tag_ids'])
        if known_bookmark_ids is not None and row['bookmark_id'] not in known_bookmark_ids:
            raise InvalidExperience('snapshot bookmark not found')
    parents = {row['tag_id']: row['parent_id'] for row in result['tag_details']}
    references.update(parents)
    references.update(parent for parent in parents.values() if parent is not None)
    known = set(tag_names) if tag_names is not None else known_tag_ids
    if known is not None and not references <= known:
        raise InvalidExperience('snapshot tag not found')
    validate_parent_graph(parents, references if known is None else known)
    if tag_names is not None:
        canonical = {tag_name_key(name) for name in tag_names.values()}
        if aliases & canonical:
            raise InvalidExperience('a tag name or alias already exists')
    return result
