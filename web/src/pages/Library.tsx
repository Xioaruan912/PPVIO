import {
  ArrowsClockwiseIcon, CaretLeftIcon, CaretRightIcon, ClockCounterClockwiseIcon, FadersHorizontalIcon,
  FolderIcon, QueueIcon, SparkleIcon, SquaresFourIcon, StarIcon,
} from "@phosphor-icons/react";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type LibraryDate, type LibraryFolder, type Media, type Tag, type VideoFilters, type VideoSort } from "../api";
import { usePrefs } from "../prefs";
import { BlurToggle, Cover, formatDuration, Grid, usePages, WatchedBar } from "../ui/Grid";
import { SPRING_PILL, SPRING_TAP, SPRING_UI } from "../ui/motion";
import { GlassSelect, GridSkeleton, ListSkeleton } from "../ui/Skeleton";
import { haptic } from "../ui/haptics";

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

/** ``refresh`` changes whenever a player closes, so watch progress is re-read. */
export function Library({ onOpen, onBookmarks, onCuration, onHistory, onChannels, onPremium, onQueue, onMultiView, onLoops, refresh = 0, selectedFolder, onFolderChange }: { onOpen: Open; onBookmarks?: () => void; onCuration?: () => void; onHistory?: () => void; onChannels?: () => void; onPremium?: () => void; onQueue?: () => void; onMultiView?: () => void; onLoops?: () => void; refresh?: number; selectedFolder?: LibraryFolder | null; onFolderChange?: (folder: LibraryFolder | null) => void }) {
  const [view, setView] = useState<View>("short");
  const [localFolder, setLocalFolder] = useState<LibraryFolder | null>(null);
  const [pullY, setPullY] = useState(0);
  const [manualRefresh, setManualRefresh] = useState(0);
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
    <main className="mx-auto min-h-dvh max-w-6xl px-3.5 pb-32 pt-[max(1.25rem,env(safe-area-inset-top))]"
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
      <header className="mb-4 flex items-center gap-2.5 px-0.5">
        {folder ? (
          <button type="button" onClick={() => setFolder(null)} aria-label="返回文件夹"
            className="ios-card pressable grid size-10 shrink-0 place-items-center rounded-full text-ink">
            <CaretLeftIcon size={19} weight="bold" />
          </button>
        ) : null}
        <h1 className="min-w-0 flex-1 truncate text-[32px] font-semibold leading-tight tracking-[-0.035em] text-ink">{folder ? folder.label : "片库"}</h1>
        {onBookmarks && <button type="button" onClick={onBookmarks} className="ios-card pressable min-h-10 rounded-full px-3.5 text-[13px] font-medium text-ink hover:border-gold/30">片段</button>}
        {onCuration && <button type="button" onClick={onCuration} className="ios-card pressable min-h-10 rounded-full px-3.5 text-[13px] font-medium text-ink hover:border-gold/30">待整理</button>}
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
              whileHover={{ y: -2 }} whileTap={{ scale: 0.93 }} transition={SPRING_TAP}
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
              <button key={key} type="button" role="tab" aria-selected={view === key} onClick={() => setView(key)}
                className={`relative h-10 flex-1 rounded-full text-[14px] transition-colors ${view === key ? "font-semibold text-gold-bright" : "text-muted hover:text-ink/85"}`}>
                {view === key && (
                  <motion.span layoutId="ppvio-library-seg" transition={SPRING_PILL}
                    className="absolute inset-0 rounded-full border border-gold/28 bg-gradient-to-b from-gold/20 via-white/[0.08] to-white/[0.03] shadow-[0_4px_16px_rgba(230,198,135,0.16),inset_0_1px_0_rgba(255,248,232,0.28)]" />
                )}
                <span className="relative z-10">{label}</span>
              </button>
            ))}
          </div>
          {view === "folders" ? <Folders key={manualRefresh} onPick={setFolder} /> : <CategoryWall category={view} onOpen={onOpen} refresh={refresh} reload={manualRefresh} />}
        </>
      )}
    </main>
  );
}

function CategoryWall({ category, onOpen, refresh, reload = 0 }: { category: "short" | "long"; onOpen: Open; refresh: number; reload?: number }) {
  const [tags, setTags] = useState<Tag[]>([]);
  const [tag, setTag] = useState<number | null>(null);
  const [sort, setSort] = useState<VideoSort>("newest");
  const [unwatched, setUnwatched] = useState(false);
  const [timeband, setTimeband] = useState("all");
  const [recent, setRecent] = useState<Recent[]>([]);
  const [progress, setProgress] = useState<Map<string, number>>(new Map());
  useEffect(() => { void api.tags().then(t => setTags(t.items.filter(x => x.count > 0))).catch(() => undefined); }, []);
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
              className={`pressable h-8.5 shrink-0 rounded-full px-3.5 text-[13px] transition-colors ${tag === t.id ? "glass-pill-gold font-semibold" : "ios-card text-muted hover:border-gold/30 hover:text-ink"}`}>{t.name}</button>
          ))}
        </div>
      )}
      {!pages.done && !pages.items.length && !pages.error ? <GridSkeleton wide={category === "long"} count={category === "long" ? 4 : 9} />
        : pages.done && !pages.items.length ? <Empty>{tag !== null ? "这个标签下还没有视频" : category === "long" ? "还没有长视频" : "还没有短视频"}</Empty>
        : <Grid items={pages.items} wide={category === "long"} progress={category === "long" ? progress : undefined} done={pages.done} onEnd={() => void pages.more()}
            error={pages.error} onRetry={() => void pages.retry()} onOpen={(index, at) => onOpen(pages.items, index, () => void pages.more(), at)} />}
    </>
  );
}

/** 继续观看: long videos left part-way, newest first. */
function ContinueRow({ items, onOpen }: { items: Recent[]; onOpen: Open }) {
  const prefs = usePrefs();
  return (
    <section className="mb-5">
      <h2 className="mb-2.5 px-0.5 text-[15px] font-semibold tracking-[-0.01em] text-ink">继续观看</h2>
      <div className="-mx-3.5 flex gap-2.5 overflow-x-auto px-3.5 [scrollbar-width:none]">
        {items.map((item, index) => (
          <motion.button key={item.id} type="button" onClick={() => onOpen(items, index)} aria-label={`继续观看第 ${index + 1} 个`}
            whileTap={{ scale: 0.96 }} transition={SPRING_TAP}
            className="luxury-card sheen-overlay relative aspect-video w-60 shrink-0 rounded-[16px] text-left">
            {item.cover_url && <Cover src={item.cover_url} className={`size-full object-cover transition-transform duration-500 hover:scale-105 ${prefs.coverBlur ? "blur-xl scale-110" : ""}`} />}
            <span aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-black/82 to-transparent" />
            <span className="glass-pill absolute bottom-2 left-2 rounded-full px-2.5 py-0.5 text-[11px] font-medium tabular-nums text-gold-bright">
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

/** Plain folders by their names first, then Archive batches by date. */
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
      <FolderIcon size={20} weight="duotone" className="shrink-0 text-muted" />
      <span className="min-w-0 flex-1 truncate text-[15px] font-medium text-ink">{label}</span>
      {hint && <span className="text-[12px] text-faint">{hint}</span>}
      <span className="text-[13px] tabular-nums text-muted">{count}</span>
      <CaretRightIcon size={15} className={`text-faint transition-transform duration-200 ${open ? "rotate-90" : ""}`} />
    </button>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="py-24 text-center text-[15px] text-muted">{children}</p>;
}
