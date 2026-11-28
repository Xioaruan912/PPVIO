"""Pure taste-learning & recommendation scoring for personal video libraries.

Combines explicit 1-5 star ratings with implicit library signals (premium,
favorites, bookmarks), propagating preference across unrated videos via
Bayesian-smoothed tag affinity, folder affinity, duration/aspect bands, and
64-bit cover perceptual-hash (dHash) visual proximity.
"""
from __future__ import annotations

from collections import defaultdict, deque
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
import random
import re

from ppvio.domain.feed import shuffled_cycle

_PHASH_RE = re.compile(r"^[0-9a-f]{16}$")

STAR_WEIGHTS: Mapping[int, float] = {
    5: 3.0,
    4: 1.6,
    3: 0.25,
    2: -1.5,
    1: -3.2,
}

_MAX_POS_HASH_ANCHORS = 40
_MAX_NEG_HASH_ANCHORS = 20


class InvalidRating(ValueError):
    """Raised when a star rating payload is outside the 0..5 contract."""


@dataclass(frozen=True)
class RecommendationSignal:
    media_id: str
    stars: int | None = None
    premium: bool = False
    favorite: bool = False
    bookmarked: bool = False
    tag_ids: tuple[int, ...] = ()
    folder_key: str | None = None
    duration_seconds: float | None = None
    width: int | None = None
    height: int | None = None
    phash: str | None = None
    updated_at: int = 0


@dataclass(frozen=True)
class TasteSummary:
    active: bool
    rated_count: int
    five_star_count: int
    disliked_count: int
    top_tags: tuple[tuple[int, float], ...]


def parse_stars(value: object) -> int:
    if type(value) is not int or not 0 <= value <= 5:
        raise InvalidRating("stars must be an integer between 0 and 5")
    return value


def _parse_phash(value: str | None) -> int | None:
    if not isinstance(value, str) or not _PHASH_RE.fullmatch(value):
        return None
    return int(value, 16)


def _duration_bucket(seconds: float | None) -> str | None:
    if seconds is None or seconds <= 0:
        return None
    if seconds < 20:
        return "micro"
    if seconds < 60:
        return "short"
    if seconds < 180:
        return "medium"
    if seconds <= 300:
        return "clip_long"
    return "feature"


def _orientation(width: int | None, height: int | None) -> str | None:
    if not width or not height or width <= 0 or height <= 0:
        return None
    return "landscape" if width > height else "portrait"


def _anchor_weight(signal: RecommendationSignal) -> float:
    weight = 0.0
    if signal.stars is not None:
        weight += STAR_WEIGHTS.get(signal.stars, 0.0)
    if signal.stars is None or signal.stars >= 3:
        if signal.premium:
            weight += 1.4
        if signal.favorite:
            weight += 1.0
        if signal.bookmarked:
            weight += 0.9
    return weight


def score_library(
    signals: Sequence[RecommendationSignal],
) -> tuple[dict[str, float], frozenset[str], TasteSummary]:
    """Score every candidate in `signals` from explicit & implicit taste anchors."""
    tag_sum: dict[int, float] = defaultdict(float)
    tag_cnt: dict[int, int] = defaultdict(int)
    folder_sum: dict[str, float] = defaultdict(float)
    folder_cnt: dict[str, int] = defaultdict(int)
    dur_sum: dict[str, float] = defaultdict(float)
    dur_cnt: dict[str, int] = defaultdict(int)
    orient_sum: dict[str, float] = defaultdict(float)
    orient_cnt: dict[str, int] = defaultdict(int)

    pos_hashes: list[tuple[int, float, int]] = []
    neg_hashes: list[tuple[int, float, int]] = []
    disliked: set[str] = set()
    rated_count = 0
    five_star_count = 0
    anchor_count = 0

    for item in signals:
        if item.stars is not None:
            rated_count += 1
            if item.stars == 5:
                five_star_count += 1
            if item.stars <= 2:
                disliked.add(item.media_id)
        weight = _anchor_weight(item)
        if weight == 0.0:
            continue
        anchor_count += 1
        for tag_id in item.tag_ids:
            tag_sum[tag_id] += weight
            tag_cnt[tag_id] += 1
        if item.folder_key:
            folder_sum[item.folder_key] += weight
            folder_cnt[item.folder_key] += 1
        bucket = _duration_bucket(item.duration_seconds)
        if bucket is not None:
            dur_sum[bucket] += weight
            dur_cnt[bucket] += 1
        orient = _orientation(item.width, item.height)
        if orient is not None:
            orient_sum[orient] += weight
            orient_cnt[orient] += 1
        parsed = _parse_phash(item.phash)
        if parsed is not None:
            if weight >= 1.4:
                pos_hashes.append((item.updated_at, weight, parsed))
            elif weight <= -1.4:
                neg_hashes.append((item.updated_at, -weight, parsed))

    if anchor_count == 0:
        return {}, frozenset(disliked), TasteSummary(False, rated_count, five_star_count, len(disliked), ())

    tag_affinity = {tid: tag_sum[tid] / (tag_cnt[tid] + 2.0) for tid in tag_sum}
    folder_affinity = {fk: folder_sum[fk] / (folder_cnt[fk] + 2.5) for fk in folder_sum}
    dur_affinity = {
        k: max(-0.45, min(0.45, dur_sum[k] / (dur_cnt[k] + 4.0) * 0.35))
        for k in dur_sum
    }
    orient_affinity = {
        k: max(-0.35, min(0.35, orient_sum[k] / (orient_cnt[k] + 5.0) * 0.28))
        for k in orient_sum
    }

    pos_hashes.sort(key=lambda row: (row[1], row[0]), reverse=True)
    neg_hashes.sort(key=lambda row: (row[1], row[0]), reverse=True)
    top_pos_ints = tuple(row[2] for row in pos_hashes[:_MAX_POS_HASH_ANCHORS])
    top_neg_ints = tuple(row[2] for row in neg_hashes[:_MAX_NEG_HASH_ANCHORS])

    scores: dict[str, float] = {}
    for item in signals:
        score = 0.0
        if item.tag_ids:
            matched = [tag_affinity[tid] for tid in item.tag_ids if tid in tag_affinity]
            if matched:
                matched.sort(reverse=True)
                pos_part = [v for v in matched if v > 0][:3]
                neg_part = [v for v in matched if v < 0][:2]
                if pos_part:
                    score += (sum(pos_part) / len(pos_part)) * 1.85
                if neg_part:
                    score += (sum(neg_part) / len(neg_part)) * 1.5
        if item.folder_key and item.folder_key in folder_affinity:
            score += folder_affinity[item.folder_key] * 1.15
        bucket = _duration_bucket(item.duration_seconds)
        if bucket is not None:
            score += dur_affinity.get(bucket, 0.0)
        orient = _orientation(item.width, item.height)
        if orient is not None:
            score += orient_affinity.get(orient, 0.0)

        parsed = _parse_phash(item.phash)
        if parsed is not None:
            if top_pos_ints:
                min_pos = min((parsed ^ anchor).bit_count() for anchor in top_pos_ints)
                if min_pos <= 14:
                    score += 1.35
                elif min_pos <= 20:
                    score += 0.75
                elif min_pos <= 25:
                    score += 0.25
            if top_neg_ints:
                min_neg = min((parsed ^ anchor).bit_count() for anchor in top_neg_ints)
                if min_neg <= 12:
                    score -= 0.95

        if item.stars == 1:
            score -= 12.0
        elif item.stars == 2:
            score -= 6.0
        elif item.stars == 4:
            score += 0.85
        elif item.stars == 5:
            score += 2.1
        if item.premium and (item.stars is None or item.stars >= 3):
            score += 0.7
        if item.favorite and (item.stars is None or item.stars >= 3):
            score += 0.5
        scores[item.media_id] = round(score, 4)

    top_tags = tuple(
        sorted(
            ((tid, round(val, 3)) for tid, val in tag_affinity.items() if val > 0.05),
            key=lambda pair: (-pair[1], pair[0]),
        )[:8]
    )
    summary = TasteSummary(True, rated_count, five_star_count, len(disliked), top_tags)
    return scores, frozenset(disliked), summary


def recommended_cycle(
    media_ids: Sequence[str],
    *,
    preferred: set[str] | frozenset[str],
    watched: set[str],
    recent: Sequence[str],
    recent_target: int,
    scores: Mapping[str, float],
    disliked: set[str] | frozenset[str],
    rng: random.Random,
) -> list[str]:
    """Order one feed cycle: unwatched taste-matched (3:1 with discovery) -> watched -> disliked."""
    blocked = set(recent) if recent_target > 0 else set()
    result: list[str] = []

    def order_pool(pool_ids: list[str], *, use_score: bool) -> deque[str]:
        if not use_score:
            ordered = shuffled_cycle(pool_ids, rng=rng)
        else:
            keyed = [
                (
                    scores.get(mid, 0.0)
                    + (2.4 if mid in preferred else 0.0)
                    + rng.uniform(-0.32, 0.32),
                    mid,
                )
                for mid in pool_ids
            ]
            keyed.sort(key=lambda pair: pair[0], reverse=True)
            ordered = [mid for _, mid in keyed]
        return deque([m for m in ordered if m not in blocked] + [m for m in ordered if m in blocked])

    active_ids = [mid for mid in media_ids if mid not in disliked]
    demoted_ids = [mid for mid in media_ids if mid in disliked]

    for seen in (False, True):
        tier = [mid for mid in active_ids if (mid in watched) == seen]
        if not tier:
            continue
        liked_pool = [
            mid for mid in tier
            if (mid in preferred) or scores.get(mid, 0.0) > 0.25
        ]
        discovery_pool = [
            mid for mid in tier
            if not ((mid in preferred) or scores.get(mid, 0.0) > 0.25)
        ]
        q_taste = order_pool(liked_pool, use_score=True)
        q_discover = order_pool(discovery_pool, use_score=False)
        while q_taste or q_discover:
            for slot in (0, 0, 0, 1):
                chosen = (q_taste if slot == 0 else q_discover) or (q_discover if slot == 0 else q_taste)
                if chosen:
                    result.append(chosen.popleft())

    if demoted_ids:
        result.extend(order_pool(demoted_ids, use_score=True))
    return result
