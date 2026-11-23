import {
  CaretLeftIcon, CaretRightIcon, ClockCounterClockwiseIcon, FadersHorizontalIcon,
  FolderIcon, QueueIcon, StarIcon,
} from "@phosphor-icons/react";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type LibraryDate, type LibraryFolder, type Media, type Tag, type VideoFilters, type VideoSort } from "../api";
import { usePrefs } from "../prefs";
import { BlurToggle, Cover, formatDuration, Grid, usePages, WatchedBar } from "../ui/Grid";
import { SPRING_PILL, SPRING_TAP, SPRING_UI } from "../ui/motion";

export type Open = (items: Media[], index: number, more?: () => void, at?: number) => void;

type View = "short" | "long" | "folders";

type Recent = Media & { position_seconds: number };

/** ``refresh`` changes whenever a player closes, so watch progress is re-read. */
export function Library({ onOpen, onBookmarks, onCuration, onHistory, onChannels, onPremium, onQueue, refresh = 0, selectedFolder, onFolderChange }: { onOpen: Open; onBookmarks?: () => void; onCuration?: () => void; onHistory?: () => void; onChannels?: () => void; onPremium?: () => void; onQueue?: () => void; refresh?: number; selectedFolder?: LibraryFolder | null; onFolderChange?: (folder: LibraryFolder | null) => void }) {
  const [view, setView] = useState<View>("short");
  const [localFolder, setLocalFolder] = useState<LibraryFolder | null>(null);
  const folder = selectedFolder === undefined ? localFolder : selectedFolder;
  const setFolder = onFolderChange ?? setLocalFolder;
  const shortcuts = [
    ["最近看过", onHistory, ClockCounterClockwiseIcon],
    ["频道", onChannels, FadersHorizontalIcon],
    ["精品", onPremium, StarIcon],
    ["待播", onQueue, QueueIcon],
  ] as const;
  return (
    <main className="mx-auto min-h-dvh max-w-6xl px-3.5 pb-32 pt-[max(1.25rem,env(safe-area-inset-top))]">
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
          {view === "folders" ? <Folders onPick={setFolder} /> : <CategoryWall category={view} onOpen={onOpen} refresh={refresh} />}
        </>
      )}
    </main>
  );
}

function CategoryWall({ category, onOpen, refresh }: { category: "short" | "long"; onOpen: Open; refresh: number }) {
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
  const pages = usePages(fetchPage, JSON.stringify([category, tag, filters]));
  useEffect(() => { void pages.more(); }, [pages.more]);
  return (
    <>
      {category === "long" && tag === null && recent.length > 0 && <ContinueRow items={recent} onOpen={onOpen} />}
      <div className="mb-3 flex flex-wrap items-center gap-2 text-[13px]">
        <select aria-label="排序" value={sort} onChange={event => setSort(event.target.value as VideoSort)}
          className="ios-card min-h-10 min-w-0 flex-1 rounded-full px-3.5 text-ink outline-none focus:border-accent">
          <option value="newest">最新</option><option value="longest">时长最长</option>
          <option value="largest">体积最大</option><option value="random">随机</option>
        </select>
        <select aria-label="时长范围" value={timeband} onChange={event => setTimeband(event.target.value)}
          className="ios-card min-h-10 min-w-0 flex-1 rounded-full px-3.5 text-ink outline-none focus:border-accent">
          <option value="all">全部时长</option><option value="short">1 分钟内</option>
          <option value="medium">1–5 分钟</option><option value="long">5 分钟以上</option>
        </select>
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
      {pages.done && !pages.items.length ? <Empty>{tag !== null ? "这个标签下还没有视频" : category === "long" ? "还没有长视频" : "还没有短视频"}</Empty>
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
  if (dates === null) return <Empty>正在加载…</Empty>;
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
