import {
  ArrowsClockwiseIcon, CaretLeftIcon, CaretRightIcon, CheckCircleIcon, CheckSquareOffsetIcon,
  ClockCounterClockwiseIcon, FadersHorizontalIcon, FolderIcon, LightningIcon, PlusIcon,
  QueueIcon, SparkleIcon, SquaresFourIcon, StarIcon, TagIcon, XIcon,
} from "@phosphor-icons/react";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type LibraryDate, type LibraryFolder, type Media, type Tag, type VideoFilters, type VideoSort } from "../api";
import { curationApi } from "../curationApi";
import { usePrefs } from "../prefs";
import { addToQueue } from "../queue";
import { BlurToggle, Cover, formatDuration, Grid, usePages, WatchedBar } from "../ui/Grid";
import { SPRING_PILL, SPRING_SHEET, SPRING_TAP, SPRING_UI } from "../ui/motion";
import { GlassSelect, GridSkeleton, ListSkeleton } from "../ui/Skeleton";
import { haptic } from "../ui/haptics";
import { FlutedPrivacyShield, OdometerIndex, SlotButton } from "../ui/CinemaChrome";
import { prewarmMedia } from "../ui/prewarm";
import { Sheet } from "../ui/Sheet";
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
type View = "short" | "long" | "folders";
type Recent = Media & { position_seconds: number };

export function Library({ onOpen, onBookmarks, onCuration, onHistory, onChannels, onPremium, onQueue, onMultiView, onLoops, refresh = 0, selectedFolder, onFolderChange }: { onOpen: Open; onBookmarks?: () => void; onCuration?: () => void; onHistory?: () => void; onChannels?: () => void; onPremium?: () => void; onQueue?: () => void; onMultiView?: () => void; onLoops?: () => void; refresh?: number; selectedFolder?: LibraryFolder | null; onFolderChange?: (folder: LibraryFolder | null) => void }) {
  const [view, setView] = useState<View>("short");
  const [localFolder, setLocalFolder] = useState<LibraryFolder | null>(null);
  const [pullY, setPullY] = useState(0);
  const [manualRefresh, setManualRefresh] = useState(0);
  const [batchMode, setBatchMode] = useState(false);
  const touchStartY = useRef<number | null>(null);
  const folder = selectedFolder === undefined ? localFolder : selectedFolder;
  const setFolder = onFolderChange ?? setLocalFolder;
  const shortcuts = [
    ["最近看过", onHistory, ClockCounterClockwiseIcon],
    ["频道", onChannels, FadersHorizontalIcon],
    ["精品", onPremium, StarIcon],
    ["待播", onQueue, QueueIcon],
  ] as const;

  return (
    <main className="mx-auto min-h-dvh max-w-6xl px-3.5 pb-36 pt-[max(1.25rem,env(safe-area-inset-top))]"
      onTouchStart={e => { if (window.scrollY <= 0) touchStartY.current = e.touches[0]?.clientY ?? null; }}
      onTouchMove={e => {
        if (touchStartY.current === null || window.scrollY > 0) return;
        const delta = (e.touches[0]?.clientY ?? 0) - touchStartY.current;
        if (delta > 0) setPullY(Math.min(84, delta * 0.45));
      }}
      onTouchEnd={() => {
        if (pullY >= 52) { haptic(10); setManualRefresh(n => n + 1); }
        touchStartY.current = null; setPullY(0);
      }}>
      {pullY > 10 && (
        <div aria-hidden="true" className="mb-2 flex justify-center overflow-hidden" style={{ height: Math.round(pullY * 0.65) }}>
          <span className="glass-pill inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[12px] font-medium text-gold-bright">
            <ArrowsClockwiseIcon size={14} className={pullY >= 52 ? "animate-spin" : ""} />
            {pullY >= 52 ? "松开刷新片库" : "下拉刷新"}
          </span>
        </div>
      )}
      <header className="mb-4 flex items-center gap-2 px-0.5">
        {folder ? (
          <button type="button" onClick={() => setFolder(null)} aria-label="返回文件夹"
            className="ios-card pressable grid size-10 shrink-0 place-items-center rounded-full text-ink">
            <CaretLeftIcon size={19} weight="bold" />
          </button>
        ) : null}
        <h1 className="min-w-0 flex-1 truncate text-[30px] font-semibold leading-tight tracking-[-0.035em] text-ink">{folder ? folder.label : "片库"}</h1>
        {!folder && view !== "folders" && (
          <SlotButton
            ariaLabel={batchMode ? "退出批量整理" : "批量整理"}
            ariaPressed={batchMode}
            active={batchMode}
            onClick={() => { haptic(8); setBatchMode(v => !v); }}
            icon={<CheckSquareOffsetIcon size={15} weight={batchMode ? "fill" : "bold"} />}
            label={batchMode ? "完成" : "多选"}
            hoverLabel={batchMode ? "退出" : "批量"}
            className="h-10 shrink-0 px-3 text-[12.5px] font-medium"
          />
        )}
        {onBookmarks && <button type="button" onClick={onBookmarks} className="ios-card pressable min-h-10 shrink-0 rounded-full px-3 text-[12.5px] font-medium text-ink hover:border-gold/35">片段</button>}
        {onCuration && <button type="button" onClick={onCuration} className="ios-card pressable min-h-10 shrink-0 rounded-full px-3 text-[12.5px] font-medium text-ink hover:border-gold/35">待整理</button>}
        <BlurToggle />
      </header>
      {!folder && (onLoops || onMultiView) && (
        <div className="mb-3 grid grid-cols-2 gap-2">
          {onLoops && (
            <motion.button type="button" onClick={onLoops} whileTap={{ scale: 0.96 }} transition={SPRING_TAP}
              className="luxury-card sheen-overlay flex items-center gap-2.5 rounded-[18px] px-3.5 py-3 text-left">
              <span className="grid size-9 shrink-0 place-items-center rounded-[12px] bg-gold-soft text-gold-bright">
                <SparkleIcon size={18} weight="fill" />
              </span>
              <span className="min-w-0">
                <span className="block truncate text-[13px] font-semibold text-ink">高光连刷</span>
                <span className="block truncate text-[11px] text-muted">循环精选片段</span>
              </span>
            </motion.button>
          )}
          {onMultiView && (
            <motion.button type="button" onClick={onMultiView} whileTap={{ scale: 0.96 }} transition={SPRING_TAP}
              className="luxury-card sheen-overlay flex items-center gap-2.5 rounded-[18px] px-3.5 py-3 text-left">
              <span className="grid size-9 shrink-0 place-items-center rounded-[12px] bg-white/[0.08] text-gold-bright">
                <SquaresFourIcon size={18} weight="fill" />
              </span>
              <span className="min-w-0">
                <span className="block truncate text-[13px] font-semibold text-ink">多屏同看</span>
                <span className="block truncate text-[11px] text-muted">2 / 4 路同步播放</span>
              </span>
            </motion.button>
          )}
        </div>
      )}
      {!folder && (
        <div className="mb-4 grid grid-cols-4 gap-2">
          {shortcuts.map(([label, action, Icon]) => action && (
            <motion.button key={label} type="button" onClick={action}
              whileTap={{ scale: 0.94 }} transition={SPRING_TAP}
              className="luxury-card sheen-overlay flex min-h-17 flex-col items-center justify-center gap-1.5 rounded-[18px] px-2 py-2.5 text-[12px] font-medium text-ink/95">
              <Icon size={21} weight="duotone" className="text-gold" />
              <span>{label}</span>
            </motion.button>
          ))}
        </div>
      )}
      {folder ? <FolderWall folder={folder} onOpen={onOpen} /> : (
        <>
          <div className="ios-card mb-4 flex gap-1 rounded-full p-1" role="tablist">
            {([["short", "短视频"], ["long", "长视频"], ["folders", "文件夹"]] as const).map(([key, label]) => (
              <button key={key} type="button" role="tab" aria-selected={view === key} onClick={() => { setView(key); if (key === "folders") setBatchMode(false); }}
                className={`relative h-10 flex-1 rounded-full text-[14px] transition-colors ${view === key ? "font-semibold text-gold-bright" : "text-muted hover:text-ink/85"}`}>
                {view === key && (
                  <motion.span layoutId="ppvio-library-seg" transition={SPRING_PILL}
                    className="absolute inset-0 rounded-full border border-gold/30 bg-gradient-to-b from-gold/20 via-white/[0.08] to-white/[0.03] shadow-[0_4px_16px_rgba(229,196,132,0.16)]" />
                )}
                <span className="relative z-10">{label}</span>
              </button>
            ))}
          </div>
          {view === "folders"
            ? <Folders key={manualRefresh} onPick={setFolder} />
            : <CategoryWall category={view} onOpen={onOpen} refresh={refresh} reload={manualRefresh} batchMode={batchMode} setBatchMode={setBatchMode} />}
        </>
      )}
    </main>
  );
}

function CategoryWall({
  category, onOpen, refresh, reload = 0, batchMode, setBatchMode,
}: {
  category: "short" | "long"; onOpen: Open; refresh: number; reload?: number;
  batchMode: boolean; setBatchMode: (on: boolean) => void;
}) {
  const [tags, setTags] = useState<Tag[]>([]);
  const [allTags, setAllTags] = useState<Tag[]>([]);
  const [tag, setTag] = useState<number | null>(null);
  const [sort, setSort] = useState<VideoSort>("newest");
  const [unwatched, setUnwatched] = useState(false);
  const [timeband, setTimeband] = useState("all");
  const [recent, setRecent] = useState<Recent[]>([]);
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
      setRecent(p.recent_items ?? []);
      setProgress(new Map((p.items ?? []).map(i => [i.id, i.position_seconds])));
    }).catch(() => undefined);
  }, [category, refresh]);

  const filters = useMemo<VideoFilters>(() => ({ sort, unwatched,
    seed: sort === "random" ? Math.floor(Math.random() * 2147483647) : undefined,
    min_seconds: timeband === "medium" ? 60 : timeband === "long" ? 300 : undefined,
    max_seconds: timeband === "short" ? 60 : timeband === "medium" ? 300 : undefined,
  }), [category, tag, sort, unwatched, timeband]);
  const fetchPage = useCallback((_: string | null, offset: number) => api.videos(category, offset, 20, tag, filters), [category, tag, filters]);
  const pages = usePages(fetchPage, JSON.stringify([category, tag, filters, reload]));
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
    <>
      {category === "long" && tag === null && recent.length > 0 && <ContinueRow items={recent} onOpen={onOpen} />}
      <div className="mb-3 flex flex-wrap items-center gap-2 text-[13px]">
        <GlassSelect label="排序" value={sort} options={SORT_OPTIONS} onChange={setSort} className="min-w-0 flex-1" />
        <GlassSelect label="时长范围" value={timeband} options={TIMEBAND_OPTIONS} onChange={setTimeband} className="min-w-0 flex-1" />
        <button type="button" aria-label="只看未看" aria-pressed={unwatched} onClick={() => setUnwatched(value => !value)}
          className={`pressable min-h-10 shrink-0 rounded-full px-3.5 font-medium transition-colors ${unwatched ? "glass-pill-gold font-semibold" : "ios-card text-muted hover:text-ink"}`}>只看未看</button>
      </div>
      {tags.length > 0 && (
        <div className="-mx-3.5 mb-3.5 flex gap-2 overflow-x-auto px-3.5 [scrollbar-width:none]">
          {[{ id: null, name: "全部" } as { id: number | null; name: string }, ...tags].map(t => (
            <button key={String(t.id)} type="button" onClick={() => setTag(t.id)}
              className={`pressable h-8.5 shrink-0 rounded-full px-3.5 text-[13px] transition-colors ${tag === t.id ? "glass-pill-gold font-semibold" : "ios-card text-muted hover:border-gold/35 hover:text-ink"}`}>{t.name}</button>
          ))}
        </div>
      )}
      {!pages.done && !pages.items.length && !pages.error ? <GridSkeleton wide={category === "long"} count={category === "long" ? 4 : 9} />
        : pages.done && !pages.items.length ? <Empty>{tag !== null ? "这个标签下还没有视频" : category === "long" ? "还没有长视频" : "还没有短视频"}</Empty>
        : <Grid items={pages.items} wide={category === "long"} progress={category === "long" ? progress : undefined} done={pages.done} onEnd={() => void pages.more()}
            error={pages.error} onRetry={() => void pages.retry()} onOpen={(index, at) => onOpen(pages.items, index, () => void pages.more(), at)}
            selecting={batchMode} selectedIds={selectedIds} onToggleSelect={toggleSelect} onStartSelect={startSelect} />}

      {/* Floating Optical Batch Console when multi-selecting directly inside Library */}
      <AnimatePresence>
        {batchMode && (
          <motion.div key="lib-batch-console"
            initial={{ opacity: 0, y: 24, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20, scale: 0.96 }}
            transition={SPRING_SHEET}
            className="fixed inset-x-0 bottom-[calc(5.6rem+env(safe-area-inset-bottom))] z-20 mx-auto max-w-xl px-3">
            <div className="glass-dock space-y-2.5 rounded-[22px] p-3 text-ink">
              <div className="flex items-center gap-2">
                <span className="inline-flex items-center gap-1.5 rounded-full border border-gold/30 bg-gold/12 px-2.5 py-1">
                  <OdometerIndex current={selectedIds.size} total={Math.min(100, pages.items.length)} />
                </span>
                <span className="text-[12px] text-muted">长按或点选卡片</span>
                <span className="flex-1" />
                <button type="button" onClick={selectAllLoaded} className="glass-pill pressable h-8 rounded-full px-3 text-[12px] font-medium text-ink">全选本页</button>
                <button type="button" aria-label="关闭批量整理" onClick={() => setBatchMode(false)} className="glass-pill pressable grid size-8 place-items-center rounded-full text-muted hover:text-ink"><XIcon size={15} /></button>
              </div>
              {macros.length > 0 && selectedIds.size > 0 && (
                <div className="flex items-center gap-1.5 overflow-x-auto [scrollbar-width:none]">
                  <span className="film-slate shrink-0 text-[10px] text-gold/80">一键</span>
                  {macros.map(m => (
                    <button key={m.ids.join(",")} type="button" disabled={savingBatch}
                      onClick={() => void applyBatch({ add_tags: m.ids, organized: true }, `已一键归入「${m.label}」`)}
                      className="pressable inline-flex h-8 shrink-0 items-center gap-1 rounded-full border border-gold/35 bg-gold/12 px-2.5 text-[12px] font-medium text-gold-bright hover:bg-gold/22 disabled:opacity-45">
                      <LightningIcon size={12} weight="fill" className="text-gold" />
                      <span className="max-w-[150px] truncate">{m.label}</span>
                    </button>
                  ))}
                </div>
              )}
              <div className="grid grid-cols-3 gap-2">
                <button type="button" disabled={!selectedIds.size || savingBatch} onClick={() => setTagSheetOpen(true)}
                  className="glass-pill pressable flex h-10 items-center justify-center gap-1 rounded-full text-[13px] font-medium disabled:opacity-40">
                  <TagIcon size={15} />打标签
                </button>
                <button type="button" disabled={!selectedIds.size || savingBatch}
                  onClick={() => {
                    const chosen = pages.items.filter(i => selectedIds.has(i.id));
                    let added = 0;
                    chosen.forEach(item => { if (addToQueue(item)) added++; });
                    haptic(10);
                    toast(added ? `已加入待播队列 ${added} 个` : "所选视频已在待播队列中");
                    setBatchMode(false);
                  }}
                  className="glass-pill pressable flex h-10 items-center justify-center gap-1 rounded-full text-[13px] font-medium disabled:opacity-40">
                  <QueueIcon size={15} />入待播
                </button>
                <button type="button" disabled={!selectedIds.size || savingBatch}
                  onClick={() => void applyBatch({ organized: true }, "已标为整理完成")}
                  className="glass-pill-gold pressable flex h-10 items-center justify-center gap-1 rounded-full text-[13px] font-semibold disabled:opacity-40">
                  <CheckCircleIcon size={16} weight="bold" />标已整理
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <Sheet open={tagSheetOpen} onClose={() => setTagSheetOpen(false)} title={`批量打标签 · ${selectedIds.size} 个视频`}>
        <div className="space-y-3 px-3">
          <div className="flex gap-2">
            <input type="text" value={newTagName} onChange={e => setNewTagName(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); void createInlineTag(); } }}
              placeholder="输入新标签名回车快速创建"
              className="min-h-11 flex-1 rounded-[14px] border border-line bg-bg/90 px-3.5 text-sm text-ink placeholder:text-faint outline-none focus:border-gold/50" />
            <button type="button" onClick={() => void createInlineTag()} disabled={!newTagName.trim()}
              className="glass-pill-gold pressable inline-flex min-h-11 shrink-0 items-center gap-1 rounded-[14px] px-3.5 text-[13px] font-semibold disabled:opacity-40">
              <PlusIcon size={15} weight="bold" />新建
            </button>
          </div>
          <div className="flex max-h-60 flex-wrap gap-1.5 overflow-y-auto [scrollbar-width:none]">
            {allTags.map(t => {
              const on = pickedTags.includes(t.id);
              return (
                <button key={t.id} type="button"
                  onClick={() => setPickedTags(ids => on ? ids.filter(id => id !== t.id) : ids.length < 20 ? [...ids, t.id] : ids)}
                  className={`pressable min-h-9 rounded-full border px-3.5 text-[13px] ${on ? "border-gold/60 bg-gold/22 font-semibold text-gold-bright" : "border-line bg-white/[0.04] text-ink/88"}`}>
                  {t.name}
                </button>
              );
            })}
          </div>
          <div className="flex gap-2 pt-1">
            <button type="button" onClick={() => void applyBatch({ add_tags: pickedTags }, "已批量追加标签")}
              disabled={!pickedTags.length || savingBatch}
              className="glass-pill pressable min-h-11 flex-1 rounded-full text-[13.5px] font-medium disabled:opacity-40">仅追加标签</button>
            <button type="button" onClick={() => void applyBatch({ add_tags: pickedTags, organized: true }, "已打标并标为整理完成")}
              disabled={!pickedTags.length || savingBatch}
              className="glass-pill-gold pressable min-h-11 flex-1 rounded-full text-[13.5px] font-semibold disabled:opacity-40">打标 + 完成整理</button>
          </div>
        </div>
      </Sheet>
    </>
  );
}

function ContinueRow({ items, onOpen }: { items: Recent[]; onOpen: Open }) {
  const prefs = usePrefs();
  return (
    <section className="mb-5">
      <h2 className="mb-2.5 px-0.5 text-[15px] font-semibold tracking-[-0.01em] text-ink">继续观看</h2>
      <div className="-mx-3.5 flex gap-2.5 overflow-x-auto px-3.5 [scrollbar-width:none]">
        {items.map((item, index) => (
          <motion.button key={item.id} type="button" onClick={() => onOpen(items, index)}
            onPointerEnter={() => prewarmMedia(item, prefs.lowRes)}
            aria-label={`继续观看第 ${index + 1} 个`}
            whileTap={{ scale: 0.96 }} transition={SPRING_TAP}
            className="luxury-card sheen-overlay group relative aspect-video w-60 shrink-0 rounded-[16px] text-left">
            {item.cover_url && <Cover src={item.cover_url} className={`film-grade size-full object-cover ${prefs.coverBlur ? "blur-xl scale-110" : ""}`} />}
            <FlutedPrivacyShield active={prefs.coverBlur} />
            <span aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-black/84 to-transparent" />
            <span className="glass-pill film-slate absolute bottom-2 left-2 rounded-full px-2.5 py-0.5 text-[10.5px] font-medium text-gold-bright">
              剩 {formatDuration((item.duration_seconds ?? 0) - item.position_seconds)}
            </span>
            <WatchedBar seconds={item.position_seconds} duration={item.duration_seconds} />
          </motion.button>
        ))}
      </div>
    </section>
  );
}

function FolderWall({ folder, onOpen }: { folder: LibraryFolder; onOpen: Open }) {
  const fetchPage = useCallback((cursor: string | null) => api.folderVideos(folder.id, cursor), [folder.id]);
  const pages = usePages(fetchPage, folder.id);
  useEffect(() => { void pages.more(); }, [folder.id]);
  return <Grid items={pages.items} done={pages.done} onEnd={() => void pages.more()}
    error={pages.error} onRetry={() => void pages.retry()} onOpen={(index, at) => onOpen(pages.items, index, () => void pages.more(), at)} />;
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
    <div className="ios-card divide-y divide-line overflow-hidden rounded-[20px]">
      {plain.map(f => <Row key={f.id} label={f.label} count={f.video_count} onClick={() => onPick(f)} />)}
      {dates.filter(d => d.date).map(d => (
        <div key={d.date}>
          <Row label={d.date!} count={d.video_count} hint={`${d.folder_count} 批`} open={open === d.date} onClick={() => setOpen(open === d.date ? null : d.date)} />
          <AnimatePresence initial={false}>
            {open === d.date && (
              <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={SPRING_UI}
                className="overflow-hidden divide-y divide-line/60 bg-bg/45">
                {batches.map(f => <Row key={f.id} label={f.label} count={f.video_count} indent onClick={() => onPick(f)} />)}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      ))}
    </div>
  );
}

function Row({ label, count, hint, indent, open, onClick }: { label: string; count: number; hint?: string; indent?: boolean; open?: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className={`flex h-14 w-full items-center gap-3 px-4 text-left transition-colors hover:bg-white/[0.03] active:bg-white/[0.06] ${indent ? "pl-10" : ""}`}>
      <FolderIcon size={20} weight="duotone" className="shrink-0 text-gold/80" />
      <span className="min-w-0 flex-1 truncate text-[15px] font-medium text-ink">{label}</span>
      {hint && <span className="text-[12px] text-faint">{hint}</span>}
      <span className="film-slate text-[12px] text-muted">{count}</span>
      <CaretRightIcon size={15} className={`text-faint transition-transform duration-200 ${open ? "rotate-90" : ""}`} />
    </button>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="py-24 text-center text-[15px] text-muted">{children}</p>;
}
