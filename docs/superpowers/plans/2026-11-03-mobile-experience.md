# PPVIO Mobile Experience Implementation Plan

> **For agentic workers:** Use the supplied task ownership and tests below; integrate task-by-task. Independent modules may be built concurrently using dispatching-parallel-agents, shared assembly belongs to the parent.

**Goal:** Complete all six researched improvements for mobile playback and unnamed libraries.
**Architecture:** Extend existing native-video UI, bounded preview infrastructure, and SQLite user state. Parent owns shared assembly, playback and navigation; independent workers own bookmarks, preview backend, and library/filter + recovery helpers.
**Tech Stack:** Python/aiohttp/SQLite, React/TypeScript/Vitest, existing ffmpeg, no new dependencies.
**Spec:** docs/superpowers/specs/2026-11-03-mobile-experience-design.md

## Global Constraints

- No TGVIO access; opaque media IDs and same-origin/auth checks remain.
- Append migration0021 only, old snapshots readable, encrypted contexts unchanged.
- New frontend modules <=600 lines; backend <=1000 lines; no new dependencies.
- Preview: 8 frames width320, 1 job, queue8, read64MiB/job, cache128MiB/7days/free1GiB.
- Network recovery: two automatic retries after1s/3s; cancelled on inactive/hidden/locked/source change.
- Tests offline and synthetic. Release only clean pushed main, PPVIO only.

## Review Focus

- Async stale events after source/activity changes must not affect the current clip.
- Back/forward and overlay closure must preserve browsing without hidden playback.
- Bookmark input, auth, restore and deletion must preserve user data and privacy.
- Preview budget, process shutdown and cache eviction must remain bounded under failures.
- Filter changes and random pagination must not append old results or duplicates.

### Task 1: Persistent bookmarks

Files: domain/bookmarks.py; infrastructure/sqlite_bookmarks.py; migrations/0021_player_bookmarks.sql; adapters/http/bookmarks.py; application/player_recovery.py; application/ports.py; tests/test_bookmarks.py; migration/recovery tests.
Interfaces: PlayerBookmarkRepositoryMixin; PlayerBookmarkHttpMixin._register_bookmark_routes(app); media GET/POST /bookmarks, DELETE /bookmarks/{bookmark_id}, global GET /api/v1/bookmarks?offset&limit. DTO bookmark {id,media_id,position_seconds,name,created_at}; global entries include media DTO under media. Parent integrates mixins in SQLite/HTTPServer and frontend.
- [x] Write and observe failing tests for bounds/idempotence/auth/global pagination/deleted media/old snapshot compatibility.
- [x] Implement repository+routes+compatible encrypted snapshot persistence, preserving inactive/orphan bookmark rows for later scans.
- [x] Run targeted backend tests and report integration hooks; do not commit or edit shared assembly.

### Task 2: Bounded visual previews

Files: infrastructure/seek_previews.py; adapters/http/previews.py; application/ports.py only if necessary (coordinate); tests/test_seek_previews.py.
Interfaces: SeekPreviewService(repository,reader,work_dir,is_playing); async start()/close(); prepare(details), status(details) return {state,version?,frames:[{index,at}]}; frame(details,index,version)->Path|None; discard(media_id). PlayerPreviewHttpMixin._register_preview_routes(app), uses self._previews. POST /api/v1/media/{id}/preview prepares; GET same reads state; GET /preview/{index}.jpg?v=version returns authenticated/versioned JPEG. HTTP status response translates internal indexes to same-origin url. Parent wires service into main/server and deletion caches.
- [x] Observe failing tests for real synthetic ffmpeg frames, queue/dedupe, read budgets/cache TTL, cancellation and auth.
- [x] Reuse existing loopback reader boundary. Generate at eight evenly spaced interior points without whole-file staging, bounded timeout and foreground priority.
- [x] Test status/prepare/frame routes with fakes and generation with local synthetic fixture, report hooks. No shared assembly edits or commits.

### Task 3: Library filters and recovery state helper

Files: web/src/pages/Library.tsx; web/src/ui/Grid.tsx; web/src/player/recovery.ts; web/src/api.ts (only videos filter signature); new focused tests. Parent adds other API methods separately after worker completes.
Interfaces: api.videos existing args plus optional filters {sort,seed,unwatched,min_seconds,max_seconds}; reusable exported recovery classification/retry helper with AbortSignal. No FeedItem/LongPlayer/App edits.
- [x] Observe failing filter request/race/random seed/retry tests.
- [x] Add compact mobile sorting/filter controls, keep seed stable across pages, improve failed pagination retry and stale request handling.
- [x] Recovery helper diagnoses only same-origin sources using Range bytes=0-0, AbortSignal and bounded timeout; closes body; classify auth/429/network/media format honestly. Parent integrates player state lifecycle.
- [x] Run frontend focused tests/tsc, return exact helper API. No commits.

### Task 4: Shared seek, preview and bookmark UI

Files: web/src/ui/SeekBar.tsx; web/src/ui/SeekPreview.tsx; web/src/ui/Bookmarks.tsx; feature API helper; feed/FeedItem.tsx; player/LongPlayer.tsx; pages bookmark wall.
- [x] Observe RED tests for throttled seek, exact release, cancellation/source changes, preserve paused state, keyboard.
- [x] Implement shared progress control, clear target time, direction-aware horizontal seeking and native vertical scroll.
- [x] Integrate preview prepare/poll only on explicit interaction; hide on inactive/privacy/background, no redundant media players.
- [x] Wire persistent bookmark add/list/delete/open-at-time through players and a library entry. Open at exact requested time once metadata arrives; don't overwrite with resume.
- [x] Verify existing loading/preload and new controls together.

### Task 5: Navigation and playback recovery integration

Files: web/src/App.tsx; feed/Feed.tsx; pages/Favorites.tsx; ui/Sheet.tsx; navigation state hook; player recovery hook.
- [x] Observe RED tests for back closes one layer, tab return preserves current clip/collection/filter/scroll, no inactive video.
- [x] Retain bounded browsing state independently from video lifecycle; register overlay/back priorities, browser history and safe fallback.
- [x] Integrate recovery helper with two bounded retries, manual retry, genuine codec fallback, keep position and pause state; abort on stale source/inactive/hidden/locked.
- [x] Verify synthetic playback and mobile viewport navigation flows.

### Task 6: Integration, rehearsal and release

- [x] Wire mixins/service in server/sqlite/main/ports, lifespan and deletion invalidation.
- [x] Rehearse migration against SQLite-backup copy; no credentials/media in logs or tests.
- [x] Run bash scripts/check.sh; fix material issues; fresh whole-change review and browser smoke.
- [ ] Commit coherent changes, push main, release.py, verify actual image/container/revisions/assets/health and unchanged neighbours.
- [ ] Deliver concise feature summary, plan/results artifacts, physical phone testing limitation.

## Execution ledger

- Design authorized by user's “全部都规划 全部都做”; six features from the prior response define scope.
- Existing development checkout is separate from production; branch codex/mobile-experience; baseline cdb1ae8.
- Parallel ownership avoids shared-file edits; parent integrates common assembly after worker reports.

- Tasks1–5 implemented and integrated. Review findings covered by RED→GREEN tests: storage/export race, paused autoplay, inactive/hidden reload, classification priority, folder navigation and polling exhaustion.
- Final checks:490 backend tests +79 frontend tests, TypeScript/Vite and guard passed.
- Production-copy migration20→21 preserved existing rows; integrity/foreign-key/idempotence checks passed.
- Browser390×844: real8-frame previews, named bookmarks/global wall/open-at-time, random sort retention, inactive video release, paused reload and paused/playing quality switches, folder Back/Forward/header/tab roundtrip passed; no page errors. Folder navigation API and variant metadata were synthetic fixtures.
- Publishing follows this implementation commit; final external receipt records exact revision, runtime and neighbour invariance. Physical phone testing remains deferred by user.
