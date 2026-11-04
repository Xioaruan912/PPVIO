# PPVIO Library Experience Implementation Plan

> **For agentic workers:** Use dispatching-parallel-agents for the explicitly isolated new modules below; parent owns shared assembly, migration, backup and player integration. Keep a ledger here and do not repeat completed work.

**Goal:** Deliver all seven user-approved Stash-inspired functions end to end.
**Architecture:** Append user metadata to SQLite, reuse existing filtered media DTOs and native players, extend encrypted snapshots compatibly. No dependencies; durable server-side MOVE per subsequent user instruction.
**Tech Stack:** Python/aiohttp/SQLite, React/TypeScript/Vitest/native video.
**Spec:** docs/superpowers/specs/2026-11-03-library-experience.md

## Global Constraints

- Root AGENTS.md and src/ppvio/AGENTS.md; offline tests/synthetic media; no production cookies/media or TGVIO access.
- Parent alone edits0023/server.py/sqlite.py/media.py/main.py/App.tsx/api.ts/mediaTools.ts/Feed*/LongPlayer/Bookmarks/shared Grid.
- New backend files<=1000lines, frontend<=600lines; no dependencies. Auth/same-origin/opaque IDs maintained.
- Full check before commits, clean pushed main release.py only; production-copy rehearsal; neighbor verification.

## Shared contracts

- Tables0023(parent): player_history_settings(singleton PK,enabled,epoch); player_view_history(media_id PK,seen_at,position_seconds); player_channels(channel_id PK,name UNIQUE NOCASE,filters TEXT,created_at,updated_at); player_media_ratings(media_id PK,premium,updated_at); player_bookmark_tags(bookmark_id FK player_bookmarks CASCADE,tag_id FK player_tags CASCADE,PK pair); player_tag_aliases(alias TEXT UNIQUE NOCASE,tag_id FK player_tags CASCADE); player_tag_parents(tag_id PK FK player_tags CASCADE,parent_id FK player_tags CASCADE); player_manual_covers(media_id PK,jpeg BLOB,at_seconds REAL,version TEXT,updated_at INT).
- New state tables except history increment player_bookmark_snapshot.revision; bookmark-tag mutations trigger dirty/invalidate relevant feed as needed; existing tag merges invoke current dirty/invalidation triggers.
- ChannelFilters JSON: {include_tags:number[],exclude_tags:number[],match:'all'|'any',watched:'all'|'unwatched'|'watched',min_seconds:number|null,max_seconds:number|null,category:'all'|'short'|'long',premium_only:boolean,sort:'newest'|'longest'|'largest'|'random'}. Unknown fields rejected; defaults allowed. Threshold300seconds passed server setting where appropriate.
- HTTP: GET/PUT /api/v1/history/settings->{enabled,epoch}; POST /api/v1/history {media_id,position_seconds,epoch}->{recorded}; GET /api/v1/history?offset&limit->{items:(Media+seen_at+position_seconds)[],has_more}; DELETE /api/v1/history[/media_id]->{enabled,epoch}.
- HTTP: GET/POST /api/v1/channels; PATCH/DELETE /api/v1/channels/{id}; GET /api/v1/channels/{id}/items?offset&limit; POST /api/v1/channels/query {filters,offset?,limit?}->Page.
- HTTP: PUT /api/v1/media/{id}/premium {premium:boolean}->Media (or {premium}); GET /api/v1/tag-catalog->{items:(Tag+aliases+parent_id)[]}; PATCH /api/v1/tag-catalog/{id} {name?,aliases?,parent_id?}; POST /api/v1/tag-catalog/merge {source_ids:number[],target_id:number}; PUT /api/v1/media/{id}/bookmarks/{bid}/tags {tag_ids:number[]}->{tag_ids}; GET same path->{tag_ids}.
- Global bookmark GET optionally tag_id filters bookmark tags (parent). DTO bookmarks include tag_ids:number[]; parent extends bookmark domain/serialization if worker does not own existing modules.
- Cover: PUT /api/v1/media/{id}/manual-cover binaryimage/jpeg + query at_seconds; DELETE same; GET same?v=sha responds JPEG private; PUT/DELETE returns refreshed Media. Agent owns repository/domain validation/new HTTP/UI; parent DTO prefers manual-cover URL.

## Review Focus

Late history writes after clear/disable; foreground/pause/unmount timings; merged/deleted tags referenced by channels/bookmarks/parents/preferences; atomic v5 restore with conflicting IDs and legacy data; cover byte/dimension/quota validation; source cancellation across queue/quality/history seeks and invalid media.

### Task1: Parent foundation and migration
- [x] Capture baseline; branchcodex/library-experience from72df36b; create0023 matching contracts and dirty triggers.
- [x] Add tests migration22→24 row preservation/idempotence; assemble isolated modules as workers report.

### Task2: Metadata backend (isolated worker)
Own new domain/library_experience.py, infrastructure/sqlite_experience.py, sqlite_tag_catalog.py, adapters/http/experience.py and focused tests only. No shared assembly/migration/bookmarks/recovery files.
- [x] RED/GREEN history epoch/privacy/limit/paging; channels validation/live AND/OR/excludes/watched/premium queries; rating independence and taggable bookmark endpoints.
- [x] RED/GREEN tag name/alias/parent validation and transactional merge, remap all filter references, no cycles/dangling references.
- [x] Export PlayerExperienceRepositoryMixin + PlayerTagCatalogRepositoryMixin and PlayerExperienceHttpMixin._register_experience_routes. Methods export_experience()->dict and restore_experience(payload,tag_mapping:dict[int,int],bookmark_mapping:dict[str,str])->None cover channels/ratings/bookmark_tags/tag_details; parent handles snapshot orchestration/manualcovers separately. Report exact signatures. No commits.

### Task3: Manual covers (isolated worker)
Own new domain/manual_covers.py,infrastructure/sqlite_manual_covers.py,adapters/http/manual_covers.py,web/src/ui/ManualCoverPicker.tsx and tests only.
- [x] RED/GREEN JPEG validation64KiB/dimensions16MiB total, replacement quota delta, restore/export base64 with validation, default reset and durable retrieval.
- [x] Export PlayerManualCoverRepositoryMixin.get_manual_cover(media_id)->dict|None with jpeg/version/at_seconds/updated_at; save_manual_cover(media_id,jpeg,at_seconds),delete_manual_cover; export_manual_covers()->list,restore_manual_covers(payload)->None.
- [x] HTTP _register_manual_cover_routes, sameorigin onwrites, no path input/remote reads; UI ManualCoverPicker({media,video,onSaved:(media:Media)=>void,onClose}) capturescanvas longedge<=480 JPEG to<=64KiB, offers existing preview prepare/status/frames and default reset; stale/unmount/privacy guards; reportintegrationhooks. No commits.

### Task4: Library management UI (isolated worker)
Own new web/src/experienceApi.ts,pages/History.tsx,pages/Channels.tsx,pages/TagManager.tsx and tests only. No shared App/Library/players/Settings/api files.
- [x] Typed API matching contracts. History({onBack,onOpen:Open}) date groups, perdelete/clear/settingsenabled; notify settings cache via exported helpers for parent playback hook (or report hooks).
- [x] Channels({onBack,onOpen:Open, premiumOnly?:boolean}) dynamic list/edit filter sheetCRUD, querypaging/retry/staleguards; builtin精品 mode. PassonOpen full loaded items/index/more; expose callback onPlayQueue?(items:Media[]) for selected queue launch if straightforward, parent also offers percard queue.
- [x] TagManager({onBack}) create viaexistingapi, rename/delete/aliases/parent/merge with explicit target selection and destructive confirmations, errors retain edits; coverBlur honored, mobilelayout, bounds and tests. No commits.

### Task5: Parent player, queue and UI integration
- [x] RED/GREEN actual foreground playback history hook2s/15s/epoch and savedpositionopen; FeedItem/LongPlayer shareit.
- [x] Queue modulelocalStorage100distinctIDbounded,validation,APIrefreshonopen; queuepage and mixed short/long controller, auto-next/prev/random; append controls in Grid/MediaActions.
- [x] Premium toggle, channel/history/tag/queue entries inLibrary; Bookmarks nameediting/tagselection/filter andLoopFeedtagfilter; feeds/library reflect cover andpremiumchanges.

### Task6: Parent recovery and final release
- [x] v5 snapshot extra metadata/manualcovers,64MiBguard,1–4compatibility, atomic validation/remapping tests; removeallnewmetadata onfinaldelete; tagsdelete removes channel refs/pendingaliases safely.
- [ ] Fullcheck, independent backend/frontend review+fixes, syntheticbrowseracceptance all7, prod-copy22→24 rehearsal, cleancommit/pushmain/release.py and neighbor/health/schema/assets verification.

## Ledger

- Baseline72df36b. User explicitly selected all seven recommendations and instructed start; prior deploy/push authorization persists. Existing dev checkout is isolated from/root/PPVIO production; use new branch in this checkout, no extra worktree needed.
- Research: Stashdevelop944dd694, savedfilters/history/currentframecover/marker tags/queues/taghierarchy/ratings verified through official docs and schemas in preceding turn. Extend existing modules instead of adding libraries.
- Ruling: history and temporary queue are disposable browsing state, stored onserver/browser respectively; no cloud history export, so clearing it cannot be undone by stale snapshots. Cover bytes are durable userchoice and backedup with metadata; bounded16MiB cover storage and64MiB encryptedsnapshot read/write.

### Task7: Tags replace old favorites (parent + isolated modules)
- [x] QuickTagPanel/TagCollections replace legacy favorite UI; common/recent tags, per-write error and completion gating.
- [x] 0024 durable MOVE service, source endpoint/ETag guard, no overwrite, crash reconciliation, deletion coordination and ID-preserving scan/restore.
- [x] Explicit legacy-group import, verified retirement, per-file cleanup, old recursive backup worker disabled.
- [ ] Final code review fixes, complete check and synthetic browser acceptance.
- [ ] Push and deploy clean main; live existing-data MOVE, rescan/range verification, verified old-group retirement and encrypted v5 export.

Ledger 2026-11-04: baseline check passed before edits. Focused filing40, legacy23 and all feature tests have offline proof; final integrated gates still in progress. Read-only SQLite backup rehearsal22→24 preserved every row of33 original tables, integrity/foreign keys and idempotence pass. Fresh metadata:174 distinct tagged +66 group members =178 distinct candidate videos;4 manual groups/70 memberships. Counts may change before live maintenance, so recapture. Review identified late bookmark-filter pages, organize save gating, queue unavailable-next, stalled history, legacy marker remapping and undo-deletion resumption; regressions added before fixes.
