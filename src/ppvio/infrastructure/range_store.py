from __future__ import annotations

from collections import OrderedDict
import json
from pathlib import Path
import os
import re
import shutil
import stat
import time


_LAYOUT = "layout.json"
_TOUCH_INTERVAL_SECONDS = 1.0
_TEMP_MAX_AGE_SECONDS = 3600


class RangeStore:
    """Byte-bounded, chunk-granular, LRU disk cache for media byte ranges.

    Files live at ``<root>/<key>/<index>.bin`` and are only created once a whole
    chunk has been fetched, so a cached file is always complete. The whole store is
    bounded by ``max_bytes`` whatever the size of the library.

    Two tiers share that budget. The first ``head_chunks`` chunks of a clip are its
    *head* (what makes a clip start instantly); everything else is *playback* data.
    Heads may use at most ``head_share`` of the budget, so warming heads can never
    crowd out what is being watched, and watching can never wipe the warm heads.
    The tier follows from the chunk index alone, so it survives a restart without
    any extra metadata.
    """

    def __init__(
        self,
        root: Path,
        *,
        chunk_bytes: int,
        max_bytes: int,
        head_chunks: int = 0,
        head_share: float = 0.5,
        max_age_seconds: float = 0,
        min_free_bytes: int = 0,
    ) -> None:
        self._root = Path(root)
        self.chunk_bytes = max(64 * 1024, int(chunk_bytes))
        self.max_bytes = max(self.chunk_bytes, int(max_bytes))
        self.head_chunks = max(0, int(head_chunks))
        self.max_age_seconds = max(0.0, float(max_age_seconds))
        self.min_free_bytes = max(0, int(min_free_bytes))
        share = min(1.0, max(0.0, float(head_share)))
        # Never smaller than one head, or a freshly written head would evict itself.
        self.head_budget = (
            max(self.chunk_bytes * self.head_chunks, int(self.max_bytes * share)) if self.head_chunks else 0
        )
        self._index: "OrderedDict[tuple[str, int], int]" = OrderedDict()
        self._total = 0
        self._head_total = 0
        self._accessed: dict[tuple[str, int], float] = {}
        self._persisted_access: dict[tuple[str, int], float] = {}
        self._pending_deletes: set[tuple[str, int]] = set()
        self._pins: dict[tuple[str, int], int] = {}
        self._eviction_failures = 0
        self._expired_chunks = 0

    def is_head(self, index: int) -> bool:
        return index < self.head_chunks

    @property
    def head_bytes(self) -> int:
        return self._head_total

    def head_room(self) -> bool:
        """Whether background head warming fits its budget and disk reserve."""
        if self.head_chunks <= 0 or self._head_total + self.chunk_bytes > self.head_budget:
            return False
        if not self.min_free_bytes:
            return True
        free = self._disk_free()
        required = self.min_free_bytes + max(1, self.head_chunks) * self.chunk_bytes
        return free is not None and free >= required

    @property
    def total_bytes(self) -> int:
        return self._total

    @property
    def chunk_count(self) -> int:
        return len(self._index)

    def open(self) -> None:
        self._index.clear()
        self._total = 0
        self._head_total = 0
        self._accessed.clear()
        self._persisted_access.clear()
        self._pending_deletes.clear()
        self._pins.clear()
        self._relayout()
        if not self._root.exists():
            return
        chunks = []
        for media_dir in self._root.iterdir():
            if media_dir.is_symlink() or not media_dir.is_dir():
                continue
            key = media_dir.name
            for chunk in media_dir.glob("*.bin"):
                try:
                    index = int(chunk.stem)
                    if chunk.is_symlink():
                        continue
                    info = chunk.stat()
                except (ValueError, OSError):
                    continue
                chunks.append((info.st_mtime, key, index, info.st_size))
        for accessed, key, index, size in sorted(chunks):
            self._index[(key, index)] = size
            self._accessed[(key, index)] = accessed
            self._persisted_access[(key, index)] = accessed
            self._total += size
            if self.is_head(index):
                self._head_total += size
        # A smaller budget than the cache on disk shrinks it right away.
        self.maintain()

    def _relayout(self) -> None:
        """Keep the cache valid when the configured chunk size changes.

        A chunk file is named by its index, so its byte offset depends on the chunk
        size it was written with. That size is recorded in ``layout.json``; a cache
        without the record (written before it existed) is judged by its largest
        file. Chunks of a whole multiple of the new size are split in place, which
        keeps warm heads without reading anything from the archive again; any other
        layout is dropped. The old tree is first renamed aside in one step and
        converted one clip at a time, so an interrupted conversion resumes on the
        next start instead of mixing two layouts.
        """
        aside = self._root.with_name(self._root.name + ".relayout")
        if not aside.exists():
            previous = self._recorded_chunk_bytes(self._root)
            if previous is None or previous == self.chunk_bytes:
                self._write_layout(self._root)
                return
            self._root.rename(aside)
        previous = self._recorded_chunk_bytes(aside) or 0
        self._root.mkdir(parents=True, exist_ok=True)
        self._write_layout(self._root)
        if previous > self.chunk_bytes and previous % self.chunk_bytes == 0:
            ratio = previous // self.chunk_bytes
            for media_dir in sorted(aside.iterdir()):
                if media_dir.is_dir():
                    self._split_clip(media_dir, self._root / media_dir.name, ratio)
        shutil.rmtree(aside, ignore_errors=True)

    def _recorded_chunk_bytes(self, root: Path) -> int | None:
        """The chunk size a cache tree was written with; None for an empty tree."""
        try:
            return int(json.loads((root / _LAYOUT).read_text())["chunk_bytes"])
        except FileNotFoundError:
            pass
        except (OSError, ValueError, KeyError, TypeError):
            return -1  # unreadable record: the layout is unknown and gets dropped
        if not root.is_dir():
            return None
        largest = max((chunk.stat().st_size for chunk in root.glob("*/*.bin")), default=0)
        if largest == 0:
            return None
        # Full chunks fill the size they were written with.
        return largest if largest > self.chunk_bytes else self.chunk_bytes

    def _write_layout(self, root: Path) -> None:
        root.mkdir(parents=True, exist_ok=True)
        temporary = root / f".{_LAYOUT}.tmp"
        temporary.write_text(json.dumps({"chunk_bytes": self.chunk_bytes}))
        temporary.replace(root / _LAYOUT)

    def _split_clip(self, source: Path, target: Path, ratio: int) -> None:
        target.mkdir(parents=True, exist_ok=True)
        for chunk in source.glob("*.bin"):
            try:
                index = int(chunk.stem)
                accessed = chunk.stat().st_mtime
                data = chunk.read_bytes()
            except (ValueError, OSError):
                continue
            for part, offset in enumerate(range(0, len(data), self.chunk_bytes)):
                piece = target / f"{index * ratio + part}.bin"
                temporary = piece.with_name(f".{piece.name}.tmp")
                temporary.write_bytes(data[offset : offset + self.chunk_bytes])
                temporary.replace(piece)
                os.utime(piece, (accessed, accessed), follow_symlinks=False)
        shutil.rmtree(source, ignore_errors=True)

    def _path(self, key: str, index: int) -> Path:
        return self._root / key / f"{index}.bin"

    def has(self, key: str, index: int) -> bool:
        return (key, index) in self._index

    def pin(self, key: str, index: int) -> None:
        """Keep a requested chunk available until its waiting consumers release it."""
        cache_key = (key, index)
        self._pins[cache_key] = self._pins.get(cache_key, 0) + 1

    def unpin(self, key: str, index: int) -> None:
        cache_key = (key, index)
        count = self._pins.get(cache_key, 0)
        if count > 1:
            self._pins[cache_key] = count - 1
        else:
            self._pins.pop(cache_key, None)

    def touch(self, key: str, index: int) -> None:
        cache_key = (key, index)
        if cache_key not in self._index:
            return
        self._index.move_to_end(cache_key)
        now = time.time()
        self._accessed[cache_key] = now
        interval = (
            min(_TOUCH_INTERVAL_SECONDS, self.max_age_seconds / 10)
            if self.max_age_seconds else _TOUCH_INTERVAL_SECONDS
        )
        if now - self._persisted_access.get(cache_key, 0) >= interval:
            try:
                os.utime(self._path(key, index), (now, now), follow_symlinks=False)
            except OSError:
                return
            self._persisted_access[cache_key] = now

    def read_slice(self, key: str, index: int, offset: int, length: int) -> bytes | None:
        if (key, index) not in self._index:
            return None
        path = self._path(key, index)
        try:
            with open(path, "rb") as handle:
                handle.seek(max(0, offset))
                data = handle.read(max(0, length))
        except OSError:
            self._forget(key, index)
            return None
        self.touch(key, index)
        return data

    def write_chunk(self, key: str, index: int, data: bytes) -> None:
        directory = self._root / key
        directory.mkdir(parents=True, exist_ok=True)
        if self.min_free_bytes:
            self._evict({(key, index)}, required_free=self.min_free_bytes + len(data))
        target = self._path(key, index)
        temporary = target.with_name(f".{index}.bin.tmp")
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o666)
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        temporary.replace(target)
        previous = self._index.get((key, index))
        if previous is not None:
            self._account(index, -previous)
        self._index[(key, index)] = len(data)
        self._account(index, len(data))
        self._pending_deletes.discard((key, index))
        self._persisted_access.pop((key, index), None)
        self.touch(key, index)
        self._evict()

    def _account(self, index: int, delta: int) -> None:
        self._total += delta
        if self.is_head(index):
            self._head_total += delta

    def _forget(self, key: str, index: int, *, retry: bool = True) -> bool:
        cache_key = (key, index)
        try:
            self._path(key, index).unlink()
        except FileNotFoundError:
            pass
        except OSError:
            if retry:
                self._pending_deletes.add(cache_key)
            self._eviction_failures += 1
            return False
        size = self._index.pop(cache_key, None)
        if size is not None:
            self._account(index, -size)
        self._accessed.pop(cache_key, None)
        self._persisted_access.pop(cache_key, None)
        self._pending_deletes.discard(cache_key)
        return True

    def delete_key(self, key: str) -> None:
        for cache_key in list(self._index):
            if cache_key[0] != key:
                continue
            self._forget(*cache_key)
        try:
            (self._root / key).rmdir()
        except OSError:
            pass

    def _victim(
        self, blocked: set[tuple[str, int]], *, disk_pressure: bool = False
    ) -> tuple[str, int] | None:
        """The least recently used chunk of the tier that has to give way."""
        want_head = self.head_chunks > 0 and self._head_total > self.head_budget
        for cache_key in self._index:
            if cache_key not in blocked and self.is_head(cache_key[1]) == want_head:
                return cache_key
        if want_head and self._total <= self.max_bytes and not disk_pressure:
            return None
        return next((item for item in self._index if item not in blocked), None)

    def _evict(
        self, blocked: set[tuple[str, int]] | None = None, *, required_free: int = 0
    ) -> None:
        # Heads over their share go first; otherwise playback data does, so warming
        # and watching never evict each other. Only one tier left: plain LRU.
        blocked = set() if blocked is None else set(blocked)
        blocked.update(self._pins)
        while self._index:
            free = self._disk_free() if required_free else None
            disk_pressure = free is not None and free < required_free
            if not (
                self._total > self.max_bytes
                or (self.head_chunks and self._head_total > self.head_budget)
                or disk_pressure
            ):
                break
            victim = self._victim(blocked, disk_pressure=disk_pressure)
            if victim is None:
                break
            if not self._forget(*victim):
                blocked.add(victim)

    def maintain(self) -> None:
        """Retry failed deletions, expire idle chunks and reclaim owned cache space."""
        self._clean_temporary()
        blocked = set(self._pins)
        for cache_key in list(self._pending_deletes):
            if cache_key in blocked:
                continue
            if not self._forget(*cache_key):
                blocked.add(cache_key)
        if self.max_age_seconds:
            cutoff = time.time() - self.max_age_seconds
            for cache_key, accessed in list(self._accessed.items()):
                if accessed > cutoff or cache_key in blocked:
                    continue
                if self._forget(*cache_key, retry=False):
                    self._expired_chunks += 1
                else:
                    blocked.add(cache_key)
        self._evict(blocked, required_free=self.min_free_bytes)

    def _disk_free(self) -> int | None:
        try:
            return shutil.disk_usage(self._root).free
        except OSError:
            return None

    def _clean_temporary(self) -> None:
        """Only remove old, regular writer temps from actual media directories."""
        try:
            root_fd = os.open(self._root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        except OSError:
            return
        try:
            for key in os.listdir(root_fd):
                try:
                    directory_fd = os.open(
                        key, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root_fd
                    )
                except OSError:
                    continue
                try:
                    for name in os.listdir(directory_fd):
                        if re.fullmatch(r"\.-?\d+\.bin\.tmp", name) is None:
                            continue
                        try:
                            info = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
                            if (
                                stat.S_ISREG(info.st_mode)
                                and time.time() - info.st_mtime >= _TEMP_MAX_AGE_SECONDS
                            ):
                                os.unlink(name, dir_fd=directory_fd)
                        except OSError:
                            continue
                finally:
                    os.close(directory_fd)
        finally:
            os.close(root_fd)

    def stats(self) -> dict[str, object]:
        free = self._disk_free() if self.min_free_bytes else None
        return {
            "bytes": self._total,
            "chunks": len(self._index),
            "max_bytes": self.max_bytes,
            "head_bytes": self._head_total,
            "head_budget": self.head_budget,
            "chunk_bytes": self.chunk_bytes,
            "eviction_failures": self._eviction_failures,
            "expired_chunks": self._expired_chunks,
            "pinned_chunks": len(self._pins),
            "max_age_seconds": self.max_age_seconds,
            "min_free_bytes": self.min_free_bytes,
            "disk_free_bytes": free,
            "min_free_met": free >= self.min_free_bytes if free is not None else None,
            "updated_at": time.time(),
        }
