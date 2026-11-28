import {
  CaretLeftIcon, CaretRightIcon, CheckCircleIcon, CheckSquareOffsetIcon,
  FolderIcon, LightningIcon, PlusIcon, QueueIcon, SlidersHorizontalIcon,
  SparkleIcon, TagIcon, XIcon,
} from "@phosphor-icons/react";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type LibraryDate, type LibraryFolder, type Media, type Tag, type VideoFilters, type VideoSort } from "../api";
import { curationApi } from "../curationApi";
import { addToQueue } from "../queue";
import { useTasteProfile } from "../ratings";
import { Grid, usePages } from "../ui/Grid";
import { SPRING_PILL, SPRING_SHEET, SPRING_UI } from "../ui/motion";
import { GlassSelect, GridSkeleton, ListSkeleton } from "../ui/Skeleton";
import { haptic } from "../ui/haptics";
import { OdometerIndex } from "../ui/CinemaChrome";
import { Sheet, SheetButton } from "../ui/Sheet";
import { toast } from "../ui/toast";
import { readTriageMacros, rememberTriageMacro } from "../ui/triageMacros";

const SORT_OPTIONS = [
  { value: "newest", label: "最新" },
  { value: "longest", label: "时长最长" },
  { value: "largest", label: "体积最大" },
  { value: "random", label: "随机" },
] as const;

const TIMEBAND_OPTIONS = [
  { value: "all", label: "全部时长" },
  { value: "short", label: "1 分钟内" },
  { value: "medium", label: "1–5 分钟" },
  { value: "long", label: "5 分钟以上" },
] as const;

export type Open = (items: Media[], index: number, more?: () => void, at?: number) => void;
type View = "recommended" | "short" | "long" | "folders";

/**
 * Direction A — Single-Viewport Horizontal Folio Library:
 * - Strict 100% viewport fit with zero vertical scrolling
 * - Ultra-low text density: pure visual plates + clean chapter tabs (推荐 / 短视频 / 长视频 / 文件夹)
 * - Secondary tools tucked cleanly inside one minimal "更多工具" Sheet so main canvas stays serene
 */
export function Library({
  onOpen, onBookmarks, onCuration, onHistory, onChannels, onPremium,
  onQueue, onMultiView, onLoops, refresh = 0, selectedFolder, onFolderChange,
}: {
  onOpen: Open;
  onBookmarks?: () => void;
  onCuration?: () => void;
  onHistory?: () => void;
  onChannels?: () => void;
  onPremium?: () => void;
  onQueue?: () => void;
  onMultiView?: () => void;
  onLoops?: () => void;
  refresh?: number;
  selectedFolder?: LibraryFolder | null;
  onFolderChange?: (folder: LibraryFolder | null) => void;
}) {
  // Keep "short" as default so existing pagination & filter workflows work identically;
  // "recommended" sits directly next to it for instant 1-tap taste recommendations!
  const [view, setView] = useState<View>("short");
  const [localFolder, setLocalFolder] = useState<LibraryFolder | null>(null);
  const [batchMode, setBatchMode] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const taste = useTasteProfile();
  const folder = selectedFolder === undefined ? localFolder : selectedFolder;
  const setFolder = onFolderChange ?? setLocalFolder;

  const hasTools = !!(onBookmarks || onCuration || onHistory || onChannels || onPremium || onQueue || onMultiView || onLoops);

  return (
    <main className="mx-auto flex h-full w-full max-w-7xl flex-col overflow-hidden px-4 pb-3 pt-4 sm:px-8 sm:pb-5 sm:pt-5">
      {/* Clean Folio Header: 1 row on desktop, 2 crisp non-wrapping rows on 390px mobile */}
      <header className="mb-3 flex shrink-0 flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center justify-between gap-2 sm:contents">
          <div className="flex min-w-0 items-center gap-2.5">
            {folder && (
              <button
                type="button"
                onClick={() => setFolder(null)}
                aria-label="返回文件夹"
                className="grid size-9 shrink-0 place-items-center rounded-full border border-line bg-surface/70 text-ink hover:border-gold/50"
              >
                <CaretLeftIcon size={18} weight="bold" />
              </button>
            )}
            <h1 className="truncate text-[22px] font-semibold leading-none tracking-[-0.03em] text-ink sm:text-[28px]">
              {folder ? folder.label : "片库"}
            </h1>
          </div>

          <div className="flex items-center gap-2 sm:order-3">
            {!folder && view !== "folders" && (
              <button
                type="button"
                aria-label={batchMode ? "退出批量整理" : "批量整理"}
                aria-pressed={batchMode}
                onClick={() => { haptic(8); setBatchMode(v => !v); }}
                className={`inline-flex h-9 items-center gap-1.5 rounded-full border px-3 text-[13.5px] font-medium transition-colors sm:px-3.5 sm:text-[14px] ${
                  batchMode ? "border-gold bg-gold text-bg" : "border-line bg-surface/70 text-ink hover:border-gold/50"
                }`}
              >
                <CheckSquareOffsetIcon size={16} weight={batchMode ? "fill" : "regular"} />
                <span>{batchMode ? "完成" : "多选"}</span>
              </button>
            )}
            {!folder && hasTools && (
              <button
                type="button"
                aria-label="更多片库入口"
                onClick={() => setToolsOpen(true)}
                className="inline-flex h-9 items-center gap-1.5 rounded-full border border-line bg-surface/70 px-3 text-[13.5px] font-medium text-ink hover:border-gold/50 sm:px-3.5 sm:text-[14px]"
              >
                <SlidersHorizontalIcon size={16} />
                <span className="hidden sm:inline">空间</span>
              </button>
            )}
          </div>
        </div>

        {!folder && (
          <div className="flex w-full items-center justify-between gap-1 rounded-full border border-line bg-surface/70 p-1 sm:order-2 sm:w-auto" role="tablist">
            {(
              [
                ["recommended", "为你推荐"],
                ["short", "短视频"],
                ["long", "长视频"],
                ["folders", "文件夹"],
              ] as const
            ).map(([key, label]) => {
              const active = view === key;
              return (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => {
                    haptic(6);
                    setView(key);
                    if (key === "folders") setBatchMode(false);
                  }}
                  className={`relative flex h-8.5 flex-1 items-center justify-center gap-1 rounded-full px-2.5 text-[13px] transition-colors sm:h-9 sm:flex-none sm:px-4 sm:text-[14px] ${
                    active ? "font-semibold text-bg" : "text-muted hover:text-ink"
                  }`}
                >
                  {active && (
                    <motion.span
                      layoutId="ppvio-library-folio-tab"
                      transition={SPRING_PILL}
                      className="absolute inset-0 rounded-full bg-gold"
                    />
                  )}
                  <span className="relative z-10 inline-flex items-center gap-1 whitespace-nowrap">
                    {key === "recommended" && <SparkleIcon size={13} weight={active || taste.active ? "fill" : "regular"} />}
                    {label}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </header>

      {/* Main Single-Viewport Folio Content */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {folder ? (
          <FolderWall folder={folder} onOpen={onOpen} />
        ) : view === "folders" ? (
          <Folders onPick={setFolder} />
        ) : view === "recommended" ? (
          <RecommendedWall onOpen={onOpen} refresh={refresh} batchMode={batchMode} setBatchMode={setBatchMode} />
        ) : (
          <CategoryWall
            category={view}
            onOpen={onOpen}
            refresh={refresh}
            batchMode={batchMode}
            setBatchMode={setBatchMode}
          />
        )}
      </div>

      {/* Clean Secondary Spaces Sheet — keeps every capability 1 tap away without cluttering the canvas */}
      <Sheet open={toolsOpen} onClose={() => setToolsOpen(false)} title="更多空间">
        <div className="space-y-1 px-1">
          {onCuration && <SheetButton onClick={() => { setToolsOpen(false); onCuration(); }}>整理工作台</SheetButton>}
          {onBookmarks && <SheetButton onClick={() => { setToolsOpen(false); onBookmarks(); }}>精彩片段</SheetButton>}
          {onLoops && <SheetButton onClick={() => { setToolsOpen(false); onLoops(); }}>高光连刷</SheetButton>}
          {onMultiView && <SheetButton onClick={() => { setToolsOpen(false); onMultiView(); }}>多屏同看</SheetButton>}
          {onHistory && <SheetButton onClick={() => { setToolsOpen(false); onHistory(); }}>最近看过</SheetButton>}
          {onChannels && <SheetButton onClick={() => { setToolsOpen(false); onChannels(); }}>智能频道</SheetButton>}
          {onPremium && <SheetButton onClick={() => { setToolsOpen(false); onPremium(); }}>精品收藏</SheetButton>}
          {onQueue && <SheetButton onClick={() => { setToolsOpen(false); onQueue(); }}>待播队列</SheetButton>}
        </div>
      </Sheet>
    </main>
  );
}

function RecommendedWall({
  onOpen, refresh, batchMode, setBatchMode,
}: {
  onOpen: Open; refresh: number; batchMode: boolean; setBatchMode: (on: boolean) => void;
}) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const taste = useTasteProfile();
  const fetchPage = useCallback((_: string | null, offset: number) => api.recommendations("all", offset, 20), []);
  const pages = usePages(fetchPage, `rec:${refresh}:${taste.rated_count}`);
  useEffect(() => { void pages.more(); }, [pages.more]);
  useEffect(() => { if (!batchMode) setSelectedIds(new Set()); }, [batchMode]);

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (next.size < 100) next.add(id);
      return next;
    });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {taste.top_tags.length > 0 && (
        <div className="mb-3 flex shrink-0 items-center gap-2 overflow-x-auto [scrollbar-width:none]">
          <span className="shrink-0 text-[14px] text-gold-bright">偏好焦点</span>
          {taste.top_tags.slice(0, 5).map(t => (
            <span key={t.id} className="shrink-0 rounded-full border border-gold/30 bg-gold/10 px-3 py-1 text-[13px] text-ink">
              {t.name}
            </span>
          ))}
        </div>
      )}
      {!pages.done && !pages.items.length && !pages.error ? (
        <GridSkeleton wide={false} count={8} />
      ) : pages.done && !pages.items.length ? (
        <Empty>在放映页给喜欢的视频点几颗星，这里就会自动推选同类佳片</Empty>
      ) : (
        <Grid
          items={pages.items}
          done={pages.done}
          onEnd={() => void pages.more()}
          error={pages.error}
          onRetry={() => void pages.retry()}
          onOpen={(index, at) => onOpen(pages.items, index, () => void pages.more(), at)}
          selecting={batchMode}
          selectedIds={selectedIds}
          onToggleSelect={toggleSelect}
          onStartSelect={id => { setBatchMode(true); setSelectedIds(new Set([id])); }}
        />
      )}
    </div>
  );
}

function CategoryWall({
  category, onOpen, refresh, batchMode, setBatchMode,
}: {
  category: "short" | "long";
  onOpen: Open;
  refresh: number;
  batchMode: boolean;
  setBatchMode: (on: boolean) => void;
}) {
  const [tags, setTags] = useState<Tag[]>([]);
  const [allTags, setAllTags] = useState<Tag[]>([]);
  const [tag, setTag] = useState<number | null>(null);
  const [sort, setSort] = useState<VideoSort>("newest");
  const [unwatched, setUnwatched] = useState(false);
  const [timeband, setTimeband] = useState("all");
  const [progress, setProgress] = useState<Map<string, number>>(new Map());
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [tagSheetOpen, setTagSheetOpen] = useState(false);
  const [pickedTags, setPickedTags] = useState<number[]>([]);
  const [newTagName, setNewTagName] = useState("");
  const [savingBatch, setSavingBatch] = useState(false);

  const loadTags = useCallback(() => {
    void api.tags().then(t => {
      setAllTags(t.items);
      setTags(t.items.filter(x => x.count > 0));
    }).catch(() => undefined);
  }, []);
  useEffect(() => { loadTags(); }, [loadTags, refresh]);
  useEffect(() => { if (!batchMode) setSelectedIds(new Set()); }, [batchMode]);
  useEffect(() => {
    if (category !== "long") return;
    void api.longProgress().then(p => {
      setProgress(new Map((p.items ?? []).map(i => [i.id, i.position_seconds])));
    }).catch(() => undefined);
  }, [category, refresh]);

  const filters = useMemo<VideoFilters>(() => ({
    sort,
    unwatched,
    seed: sort === "random" ? Math.floor(Math.random() * 2147483647) : undefined,
    min_seconds: timeband === "medium" ? 60 : timeband === "long" ? 300 : undefined,
    max_seconds: timeband === "short" ? 60 : timeband === "medium" ? 300 : undefined,
  }), [category, tag, sort, unwatched, timeband]);

  const fetchPage = useCallback((_: string | null, offset: number) => api.videos(category, offset, 20, tag, filters), [category, tag, filters]);
  const pages = usePages(fetchPage, JSON.stringify([category, tag, filters]));
  useEffect(() => { void pages.more(); }, [pages.more]);

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (next.size < 100) next.add(id);
      return next;
    });
  };
  const startSelect = (id: string) => {
    setBatchMode(true);
    setSelectedIds(new Set([id]));
  };
  const selectAllLoaded = () => {
    haptic(8);
    setSelectedIds(new Set(pages.items.slice(0, 100).map(i => i.id)));
  };

  const applyBatch = async (change: { add_tags?: number[]; organized?: boolean }, label: string) => {
    const ids = [...selectedIds];
    if (!ids.length || savingBatch) return;
    setSavingBatch(true);
    try {
      await curationApi.batch(ids, change);
      if (change.add_tags?.length) rememberTriageMacro(change.add_tags, allTags);
      haptic(12);
      toast(`${label}（${ids.length} 个视频）`);
      setSelectedIds(new Set());
      setTagSheetOpen(false);
      setPickedTags([]);
      setBatchMode(false);
      loadTags();
    } catch {
      toast("批量操作失败，请重试");
    } finally {
      setSavingBatch(false);
    }
  };

  const createInlineTag = async () => {
    const clean = newTagName.trim().replace(/\s+/gu, " ");
    if (!clean || savingBatch) return;
    try {
      const created = await api.createTag(clean);
      setAllTags(list => [created, ...list]);
      setPickedTags(ids => [...new Set([...ids, created.id])]);
      setNewTagName("");
    } catch {
      toast("创建标签失败");
    }
  };

  const macros = readTriageMacros(allTags).slice(0, 3);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* Slim Filter & Tag Strip: clean 3-column filter row on mobile without right-edge clipping */}
      <div className="mb-3 flex shrink-0 flex-col gap-2 text-[14px] sm:flex-row sm:items-center">
        <div className="flex items-center gap-2">
          <GlassSelect label="排序" value={sort} options={SORT_OPTIONS} onChange={setSort} className="min-w-0 flex-1 sm:w-36 sm:flex-none" />
          <GlassSelect label="时长范围" value={timeband} options={TIMEBAND_OPTIONS} onChange={setTimeband} className="min-w-0 flex-1 sm:w-36 sm:flex-none" />
          <button
            type="button"
            aria-label="只看未看"
            aria-pressed={unwatched}
            onClick={() => setUnwatched(value => !value)}
            className={`h-10 shrink-0 rounded-full border px-4 text-[14px] font-medium transition-colors ${
              unwatched ? "border-gold bg-gold font-semibold text-bg" : "border-line bg-surface/70 text-muted hover:text-ink"
            }`}
          >
            未看
          </button>
        </div>
        {tags.length > 0 && (
          <div className="hidden min-w-0 flex-1 items-center gap-1.5 overflow-x-auto sm:flex [scrollbar-width:none]">
            {[{ id: null, name: "全部" } as { id: number | null; name: string }, ...tags].map(t => (
              <button
                key={String(t.id)}
                type="button"
                onClick={() => setTag(t.id)}
                className={`h-9 shrink-0 rounded-full border px-3.5 text-[14px] transition-colors ${
                  tag === t.id ? "border-gold/60 bg-gold/18 font-semibold text-gold-bright" : "border-line bg-surface/60 text-muted hover:text-ink"
                }`}
              >
                {t.name}
              </button>
            ))}
          </div>
        )}
      </div>

      {!pages.done && !pages.items.length && !pages.error ? (
        <GridSkeleton wide={category === "long"} count={category === "long" ? 6 : 8} />
      ) : pages.done && !pages.items.length ? (
        <Empty>{tag !== null ? "这个标签下还没有视频" : category === "long" ? "还没有长视频" : "还没有短视频"}</Empty>
      ) : (
        <Grid
          items={pages.items}
          wide={category === "long"}
          progress={category === "long" ? progress : undefined}
          done={pages.done}
          onEnd={() => void pages.more()}
          error={pages.error}
          onRetry={() => void pages.retry()}
          onOpen={(index, at) => onOpen(pages.items, index, () => void pages.more(), at)}
          selecting={batchMode}
          selectedIds={selectedIds}
          onToggleSelect={toggleSelect}
          onStartSelect={startSelect}
        />
      )}

      {/* Clean Batch Console docked inline below grid when multi-selecting */}
      <AnimatePresence>
        {batchMode && (
          <motion.div
            key="lib-batch-console"
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 12 }}
            transition={SPRING_SHEET}
            className="mt-3 shrink-0 rounded-[18px] border border-line bg-surface p-3 text-ink"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center rounded-full border border-gold/35 bg-gold/12 px-3 py-1">
                <OdometerIndex current={selectedIds.size} total={Math.min(100, pages.items.length)} />
              </span>
              <button type="button" onClick={selectAllLoaded} className="h-9 rounded-full border border-line px-3.5 text-[13px] font-medium">全选</button>
              {macros.length > 0 && selectedIds.size > 0 && macros.map(m => (
                <button
                  key={m.ids.join(",")}
                  type="button"
                  disabled={savingBatch}
                  onClick={() => void applyBatch({ add_tags: m.ids, organized: true }, `已归入「${m.label}」`)}
                  className="inline-flex h-9 items-center gap-1 rounded-full border border-gold/40 bg-gold/12 px-3 text-[13px] font-medium text-gold-bright"
                >
                  <LightningIcon size={13} weight="fill" />
                  <span className="max-w-[140px] truncate">{m.label}</span>
                </button>
              ))}
              <span className="flex-1" />
              <button type="button" disabled={!selectedIds.size || savingBatch} onClick={() => setTagSheetOpen(true)}
                className="inline-flex h-9 items-center gap-1 rounded-full border border-line px-3.5 text-[13px] font-medium disabled:opacity-35">
                <TagIcon size={15} />打标签
              </button>
              <button type="button" disabled={!selectedIds.size || savingBatch}
                onClick={() => {
                  const chosen = pages.items.filter(i => selectedIds.has(i.id));
                  let added = 0;
                  chosen.forEach(item => { if (addToQueue(item)) added++; });
                  haptic(10);
                  toast(added ? `已加入待播 ${added} 个` : "已在待播队列中");
                  setBatchMode(false);
                }}
                className="inline-flex h-9 items-center gap-1 rounded-full border border-line px-3.5 text-[13px] font-medium disabled:opacity-35">
                <QueueIcon size={15} />待播
              </button>
              <button type="button" disabled={!selectedIds.size || savingBatch}
                onClick={() => void applyBatch({ organized: true }, "已标为整理完成")}
                className="glass-pill-gold inline-flex h-9 items-center gap-1 rounded-full px-4 text-[13px] font-semibold disabled:opacity-35">
                <CheckCircleIcon size={15} weight="bold" />标已整理
              </button>
              <button type="button" aria-label="关闭批量整理" onClick={() => setBatchMode(false)}
                className="grid size-9 place-items-center rounded-full border border-line text-muted hover:text-ink">
                <XIcon size={15} />
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <Sheet open={tagSheetOpen} onClose={() => setTagSheetOpen(false)} title={`批量打标签 · ${selectedIds.size} 个视频`}>
        <div className="space-y-3 px-3">
          <div className="flex gap-2">
            <input
              type="text"
              value={newTagName}
              onChange={e => setNewTagName(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); void createInlineTag(); } }}
              placeholder="输入新标签名回车新建"
              className="min-h-11 flex-1 rounded-[14px] border border-line bg-bg/90 px-3.5 text-sm text-ink placeholder:text-faint outline-none focus:border-gold/50"
            />
            <button
              type="button"
              onClick={() => void createInlineTag()}
              disabled={!newTagName.trim()}
              className="glass-pill-gold pressable inline-flex min-h-11 shrink-0 items-center gap-1 rounded-[14px] px-3.5 text-[13px] font-semibold disabled:opacity-40"
            >
              <PlusIcon size={15} weight="bold" />新建
            </button>
          </div>
          <div className="flex max-h-60 flex-wrap gap-1.5 overflow-y-auto [scrollbar-width:none]">
            {allTags.map(t => {
              const on = pickedTags.includes(t.id);
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setPickedTags(ids => on ? ids.filter(id => id !== t.id) : ids.length < 20 ? [...ids, t.id] : ids)}
                  className={`pressable min-h-9 rounded-full border px-3.5 text-[13px] ${
                    on ? "border-gold/60 bg-gold/22 font-semibold text-gold-bright" : "border-line bg-white/[0.04] text-ink/88"
                  }`}
                >
                  {t.name}
                </button>
              );
            })}
          </div>
          <div className="flex gap-2 pt-1">
            <button type="button" onClick={() => void applyBatch({ add_tags: pickedTags }, "已批量追加标签")}
              disabled={!pickedTags.length || savingBatch}
              className="glass-pill pressable min-h-11 flex-1 rounded-full text-[14px] font-medium disabled:opacity-40">仅追加标签</button>
            <button type="button" onClick={() => void applyBatch({ add_tags: pickedTags, organized: true }, "已打标并标为整理完成")}
              disabled={!pickedTags.length || savingBatch}
              className="glass-pill-gold pressable min-h-11 flex-1 rounded-full text-[14px] font-semibold disabled:opacity-40">打标 + 完成整理</button>
          </div>
        </div>
      </Sheet>
    </div>
  );
}

function FolderWall({ folder, onOpen }: { folder: LibraryFolder; onOpen: Open }) {
  const fetchPage = useCallback((cursor: string | null) => api.folderVideos(folder.id, cursor), [folder.id]);
  const pages = usePages(fetchPage, folder.id);
  useEffect(() => { void pages.more(); }, [folder.id]);
  return (
    <Grid
      items={pages.items}
      done={pages.done}
      onEnd={() => void pages.more()}
      error={pages.error}
      onRetry={() => void pages.retry()}
      onOpen={(index, at) => onOpen(pages.items, index, () => void pages.more(), at)}
    />
  );
}

function Folders({ onPick }: { onPick: (folder: LibraryFolder) => void }) {
  const [dates, setDates] = useState<LibraryDate[] | null>(null);
  const [plain, setPlain] = useState<LibraryFolder[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [batches, setBatches] = useState<LibraryFolder[]>([]);
  useEffect(() => {
    void api.libraryDates().then(d => setDates(d.items)).catch(() => setDates([]));
    void api.libraryFolders(null).then(f => setPlain(f.items)).catch(() => undefined);
  }, []);
  useEffect(() => { if (open) void api.libraryFolders(open).then(f => setBatches(f.items)); }, [open]);
  if (dates === null) return <ListSkeleton rows={5} />;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto rounded-[16px] border border-line bg-surface/60 divide-y divide-line">
      {plain.map(f => <Row key={f.id} label={f.label} count={f.video_count} onClick={() => onPick(f)} />)}
      {dates.filter(d => d.date).map(d => (
        <div key={d.date}>
          <Row label={d.date!} count={d.video_count} open={open === d.date} onClick={() => setOpen(open === d.date ? null : d.date)} />
          <AnimatePresence initial={false}>
            {open === d.date && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={SPRING_UI}
                className="overflow-hidden divide-y divide-line/60 bg-bg/50"
              >
                {batches.map(f => <Row key={f.id} label={f.label} count={f.video_count} indent onClick={() => onPick(f)} />)}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      ))}
    </div>
  );
}

function Row({ label, count, indent, open, onClick }: { label: string; count: number; indent?: boolean; open?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex h-14 w-full items-center gap-3 px-4 text-left transition-colors hover:bg-white/[0.03] ${indent ? "pl-10" : ""}`}
    >
      <FolderIcon size={20} weight="duotone" className="shrink-0 text-gold/80" />
      <span className="min-w-0 flex-1 truncate text-[15px] font-medium text-ink">{label}</span>
      <span className="tabular-nums text-[14px] text-muted">{count}</span>
      <CaretRightIcon size={15} className={`text-faint transition-transform duration-200 ${open ? "rotate-90" : ""}`} />
    </button>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="grid min-h-0 flex-1 place-items-center px-6 text-center text-[15px] text-muted">{children}</div>;
}
