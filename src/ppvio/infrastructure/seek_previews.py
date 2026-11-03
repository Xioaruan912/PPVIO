"""On-demand seek JPEGs; all media reads stay behind the player's loopback boundary."""
from __future__ import annotations

import asyncio
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass
import hashlib
import json
import math
from pathlib import Path
import re
import shutil
import signal
import stat
import time

from ppvio.domain.ranges import ByteRange
from ppvio.infrastructure.rendition_maker import _SourceServer
from ppvio.infrastructure.webdav_read import WebDavRangeResponse

FRAME_COUNT = 8
READ_BYTES = 64 * 1024 * 1024
CACHE_BYTES = 128 * 1024 * 1024
TTL_SECONDS = 7 * 86400
FREE_BYTES = 1024 * 1024 * 1024
JOB_SECONDS = 180.0
RETRY_SECONDS = 600.0
_FRAME_BYTES = 256 * 1024
_CHUNK_BYTES = 1024 * 1024
_ID = re.compile(r"^[0-9a-f]{64}$")
_CACHE_NAME = re.compile(r"^[0-9a-f]{64}-[0-9a-f]{64}(?:\.tmp)?$")


class PreviewBudgetExceeded(RuntimeError):
    pass


@dataclass
class _ReadBudget:
    remaining: int
    deadline: float
    active: bool = True


async def _idle(is_playing: Callable[[], bool], deadline: float, budget: _ReadBudget | None = None) -> None:
    while True:
        if budget is not None and not budget.active:
            raise asyncio.CancelledError()
        if time.monotonic() >= deadline:
            raise TimeoutError("preview deadline exceeded")
        if not is_playing():
            return
        await asyncio.sleep(0.05)


class _BudgetReader:
    """Reserve every upstream chunk before reading, including concurrent ffmpeg seeks."""

    def __init__(self, reader, is_playing: Callable[[], bool]) -> None:
        self._reader = reader
        self._is_playing = is_playing
        self._budget: _ReadBudget | None = None
        self._reads: set[asyncio.Future] = set()

    def begin(self, budget: _ReadBudget) -> None:
        self.end()
        self._budget = budget

    def end(self) -> None:
        if self._budget is not None:
            self._budget.active = False
        self._budget = None
        for task in self._reads:
            task.cancel()

    async def _read(self, operation, budget: _ReadBudget):
        task = asyncio.ensure_future(operation)
        self._reads.add(task)
        try:
            return await asyncio.wait_for(task, max(0.001, budget.deadline - time.monotonic()))
        except StopAsyncIteration:
            raise
        except Exception:
            raise RuntimeError("preview range read failed") from None
        finally:
            self._reads.discard(task)

    async def open_range(self, package, relpath, byte_range: ByteRange):
        budget = self._budget
        if budget is None or not budget.active:
            raise PreviewBudgetExceeded()

        async def body():
            position = byte_range.start
            while position <= byte_range.end:
                await _idle(self._is_playing, budget.deadline, budget)
                if not budget.active or budget.remaining <= 0:
                    raise PreviewBudgetExceeded()
                length = min(_CHUNK_BYTES, budget.remaining, byte_range.end - position + 1)
                # No await between checking and reserving: overlapping range requests share this cap.
                budget.remaining -= length
                upstream = await self._read(
                    self._reader.open_range(package, relpath, ByteRange(position, position + length - 1)), budget)
                received = 0
                buffered = bytearray()
                try:
                    if upstream.status != 206:
                        raise ValueError("preview requires bounded range responses")
                    iterator = upstream.body.__aiter__()
                    while received < length:
                        if not budget.active:
                            raise PreviewBudgetExceeded()
                        try:
                            chunk = await self._read(anext(iterator), budget)
                        except StopAsyncIteration:
                            break
                        if len(chunk) > length - received:
                            raise ValueError("range response exceeded its boundary")
                        received += len(chunk)
                        buffered.extend(chunk)
                    if received != length:
                        raise ValueError("incomplete preview range")
                finally:
                    close = getattr(upstream.body, "aclose", None)
                    if close is not None:
                        try:
                            await asyncio.wait_for(close(), 1)
                        except Exception:
                            raise RuntimeError("preview range close failed") from None
                position += received
                # Release the shared HTTP connection before playback pauses or loopback backpressure.
                await _idle(self._is_playing, budget.deadline, budget)
                yield bytes(buffered)

        return WebDavRangeResponse(206, "application/octet-stream", byte_range.length, None, None, body())


def _jpeg(path: Path) -> bool:
    """Reject links, oversized files and JPEGs with unexpected dimensions before serving."""
    try:
        mode = path.lstat()
        if not stat.S_ISREG(mode.st_mode) or not 4 <= mode.st_size <= _FRAME_BYTES:
            return False
        data = path.read_bytes()
        if not data.startswith(b"\xff\xd8") or not data.endswith(b"\xff\xd9"):
            return False
        offset = 2
        while offset + 4 <= len(data):
            if data[offset] != 255:
                return False
            marker = data[offset + 1]
            offset += 2
            if marker == 255:
                offset -= 1
                continue
            length = int.from_bytes(data[offset:offset + 2], "big")
            if length < 2 or offset + length > len(data):
                return False
            if marker in {0xC0, 0xC1, 0xC2} and length >= 8:
                height = int.from_bytes(data[offset + 3:offset + 5], "big")
                width = int.from_bytes(data[offset + 5:offset + 7], "big")
                return width == 320 and 0 < height <= 4096
            if marker == 0xDA:
                return False
            offset += length
    except (OSError, ValueError):
        pass
    return False


class SeekPreviewService:
    def __init__(self, repository, reader, *, work_dir: Path, is_playing: Callable[[], bool]) -> None:
        self._repository = repository
        self._is_playing = is_playing
        self._work_dir = work_dir.absolute()
        self._reader = _BudgetReader(reader, is_playing)
        self._source = _SourceServer(self._reader)
        self._queue: deque[tuple[dict[str, object], tuple[str, str, str | None], str]] = deque()
        self._pending: set[tuple[str, str]] = set()
        self._failures: dict[tuple[str, str], float] = {}
        self._wake = asyncio.Event()
        self._worker: asyncio.Task | None = None
        self._job: asyncio.Task | None = None
        self._current: tuple[str, str] | None = None
        self._closed = True

    async def start(self) -> None:
        if self._worker is not None:
            return
        if any(path.is_symlink() for path in (self._work_dir, *self._work_dir.parents)):
            raise ValueError("preview directory must not contain symlinks")
        self._work_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        self._prune()
        await self._source.start()
        self._closed = False
        self._worker = asyncio.create_task(self._run(), name="seek-previews")

    async def close(self) -> None:
        self._closed = True
        self._reader.end()
        if self._worker is not None:
            self._worker.cancel()
            await asyncio.gather(self._worker, return_exceptions=True)
            self._worker = None
        self._queue.clear()
        self._pending.clear()
        await self._source.close()

    async def _identity(self, details):
        media_id, size, duration = details.get("media_id"), details.get("size_bytes"), details.get("duration_seconds")
        if (not isinstance(media_id, str) or not _ID.fullmatch(media_id)
                or details.get("kind") != "video" or isinstance(size, bool) or not isinstance(size, int) or size <= 0
                or isinstance(duration, bool) or not isinstance(duration, (int, float))
                or not math.isfinite(duration) or duration <= 0):
            return None
        location = await self._repository.active_media_location(media_id)
        if location is None:
            return None
        version = hashlib.sha256(json.dumps(
            ["seek-preview-v1", media_id, size, duration, *location], separators=(",", ":")
        ).encode()).hexdigest()
        return location, version

    async def prepare(self, details) -> dict[str, object]:
        identity = await self._identity(details)
        if identity is None or self._closed:
            return {"state": "unavailable", "frames": []}
        location, version = identity
        media_id = str(details["media_id"])
        key = (media_id, version)
        result = self._status(details, version)
        if result["state"] != "unavailable":
            return result
        now = time.monotonic()
        self._failures = {key: until for key, until in self._failures.items() if until > now}
        if key in self._failures or len(self._queue) >= 8:
            return result
        if any(pending[0] == media_id for pending in self._pending):
            await self.discard(media_id)
        self._pending.add(key)
        self._queue.append((dict(details), location, version))
        self._wake.set()
        return {"state": "pending", "version": version, "frames": []}

    async def status(self, details) -> dict[str, object]:
        identity = await self._identity(details)
        return {"state": "unavailable", "frames": []} if identity is None else self._status(details, identity[1])

    def _status(self, details, version) -> dict[str, object]:
        media_id = str(details["media_id"])
        directory = self._directory(media_id, version)
        if self._valid(directory):
            (directory / "manifest.json").touch()
            return {"state": "ready", "version": version, "frames": self._frames(float(details["duration_seconds"]))}
        state = "pending" if (media_id, version) in self._pending else "unavailable"
        return {"state": state, "version": version, "frames": []}

    async def frame(self, details, index: int, version: str) -> Path | None:
        if isinstance(index, bool) or not isinstance(index, int) or not 0 <= index < FRAME_COUNT:
            return None
        identity = await self._identity(details)
        if identity is None or identity[1] != version:
            return None
        result = self._status(details, version)
        return self._directory(str(details["media_id"]), version) / f"{index}.jpg" if result["state"] == "ready" else None

    async def discard(self, media_id: str) -> None:
        if not _ID.fullmatch(media_id):
            return
        self._queue = deque(job for job in self._queue if job[0]["media_id"] != media_id)
        self._pending = {key for key in self._pending if key[0] != media_id}
        self._failures = {key: until for key, until in self._failures.items() if key[0] != media_id}
        if self._current is not None and self._current[0] == media_id and self._job is not None:
            self._job.cancel()
            await asyncio.gather(self._job, return_exceptions=True)
        for directory in self._work_dir.glob(f"{media_id}-*"):
            self._remove(directory)

    def _directory(self, media_id: str, version: str) -> Path:
        return self._work_dir / f"{media_id}-{version}"

    @staticmethod
    def _frames(duration: float) -> list[dict[str, object]]:
        return [{"index": index, "at": duration * (index + 1) / (FRAME_COUNT + 1)} for index in range(FRAME_COUNT)]

    def _valid(self, directory: Path) -> bool:
        try:
            if directory.is_symlink() or not directory.is_dir():
                return False
            manifest = directory / "manifest.json"
            if manifest.is_symlink() or not manifest.is_file() or manifest.stat().st_size > 4096:
                return False
            info = json.loads(manifest.read_text())
            age = time.time() - info["created_at"]
            return (0 <= age < TTL_SECONDS and info["version"] == directory.name.rsplit("-", 1)[-1]
                    and all(_jpeg(directory / f"{index}.jpg") for index in range(FRAME_COUNT)))
        except (OSError, ValueError, TypeError, KeyError):
            return False

    def _remove(self, directory: Path) -> None:
        if directory.parent != self._work_dir or not _CACHE_NAME.fullmatch(directory.name):
            return
        if directory.is_symlink() or directory.is_file():
            directory.unlink(missing_ok=True)
        elif directory.is_dir():
            shutil.rmtree(directory)

    def _prune(self, reserve: int = 0) -> bool:
        entries = []
        for directory in self._work_dir.iterdir():
            if not _CACHE_NAME.fullmatch(directory.name):
                continue
            if directory.name.endswith(".tmp") or not self._valid(directory):
                self._remove(directory)
                continue
            size = sum(path.lstat().st_size for path in directory.iterdir())
            entries.append(((directory / "manifest.json").stat().st_mtime, size, directory))
        total = sum(size for _, size, _ in entries)
        for _, size, directory in sorted(entries):
            if total + reserve <= CACHE_BYTES and shutil.disk_usage(self._work_dir).free >= FREE_BYTES + reserve:
                break
            self._remove(directory)
            total -= size
        return total + reserve <= CACHE_BYTES and shutil.disk_usage(self._work_dir).free >= FREE_BYTES + reserve

    async def _run(self) -> None:
        while True:
            if not self._queue or self._is_playing():
                self._wake.clear()
                try:
                    await asyncio.wait_for(self._wake.wait(), 0.1 if self._queue else 60)
                except asyncio.TimeoutError:
                    pass
                continue
            details, location, version = self._queue.popleft()
            key = (str(details["media_id"]), version)
            self._current = key
            self._job = asyncio.create_task(self._generate(details, location, version))
            try:
                await self._job
            except asyncio.CancelledError:
                if self._closed:
                    raise
            except Exception:
                # Preview failure stays separate from playback; no paths, URLs or ffmpeg output are logged.
                self._failures[key] = time.monotonic() + RETRY_SECONDS
                if len(self._failures) > 256:
                    self._failures.pop(next(iter(self._failures)))
            finally:
                self._pending.discard(key)
                self._current = None
                self._job = None

    async def _generate(self, details, location, version) -> None:
        if not self._prune(reserve=_FRAME_BYTES * FRAME_COUNT + 4096):
            raise OSError("insufficient preview cache space")
        target = self._directory(str(details["media_id"]), version)
        temporary = target.with_name(target.name + ".tmp")
        temporary.mkdir(mode=0o700)
        deadline = time.monotonic() + JOB_SECONDS
        self._reader.begin(_ReadBudget(READ_BYTES, deadline))
        url = self._source.register(location[0], location[1], int(details["size_bytes"]))
        try:
            for frame in self._frames(float(details["duration_seconds"])):
                if shutil.disk_usage(self._work_dir).free < FREE_BYTES + _FRAME_BYTES:
                    raise OSError("insufficient preview cache space")
                path = temporary / f"{frame['index']}.jpg"
                await self._render_frame(url, path, float(frame["at"]), deadline)
                if not _jpeg(path):
                    raise ValueError("invalid preview JPEG")
            identity = await self._identity(details)
            if identity is None or identity[1] != version:
                raise ValueError("preview source changed")
            (temporary / "manifest.json").write_text(json.dumps({"version": version, "created_at": time.time()}))
            self._remove(target)
            temporary.rename(target)
            self._prune()
        finally:
            self._reader.end()
            self._source.forget(url)
            self._remove(temporary)

    async def _render_frame(self, url: str, target: Path, at: float, deadline: float) -> None:
        await _idle(self._is_playing, deadline)
        proc = await asyncio.create_subprocess_exec(
            "nice", "-n", "19", "ffmpeg", "-nostdin", "-y", "-v", "error", "-threads", "1",
            "-protocol_whitelist", "http,tcp",
            "-format_whitelist", "mov,matroska,webm,avi,mpegts,mpeg,flv,ogg,asf,rm", "-ss", f"{at:.6f}", "-i", url,
            "-map", "0:v:0", "-an", "-sn", "-dn", "-frames:v", "1", "-filter_threads", "1",
            "-vf", "scale=320:-2,setsar=1", "-threads", "1", "-q:v", "6", "-map_metadata", "-1",
            "-fs", str(_FRAME_BYTES), str(target), stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
        paused = False
        try:
            while proc.returncode is None:
                if time.monotonic() >= deadline:
                    raise TimeoutError("preview deadline exceeded")
                playing = self._is_playing()
                if playing != paused:
                    proc.send_signal(signal.SIGSTOP if playing else signal.SIGCONT)
                    paused = playing
                try:
                    await asyncio.wait_for(proc.wait(), 0.05)
                except asyncio.TimeoutError:
                    pass
            if proc.returncode:
                raise RuntimeError("preview command failed")
        finally:
            if proc.returncode is None:
                if paused:
                    proc.send_signal(signal.SIGCONT)
                proc.kill()
                await proc.wait()
