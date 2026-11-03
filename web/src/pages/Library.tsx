import { CaretLeftIcon, CaretRightIcon, FolderIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type LibraryDate, type LibraryFolder, type Media, type Tag, type VideoFilters, type VideoSort } from "../api";
import { usePrefs } from "../prefs";
import { BlurToggle, Cover, formatDuration, Grid, usePages, WatchedBar } from "../ui/Grid";

export type Open = (items: Media[], index: number, more?: () => void, at?: number) => void;

type View = "short" | "long" | "folders";

type Recent = Media & { position_seconds: number };

/** ``refresh`` changes whenever a player closes, so watch progress is re-read. */
export function Library({ onOpen, onBookmarks, onCuration, refresh = 0, selectedFolder, onFolderChange }: { onOpen: Open; onBookmarks?: () => void; onCuration?: () => void; refresh?: number; selectedFolder?: LibraryFolder | null; onFolderChange?: (folder: LibraryFolder | null) => void }) {
  const [view, setView] = useState<View>("short");
  const [localFolder, setLocalFolder] = useState<LibraryFolder | null>(null);
  const folder = selectedFolder === undefined ? localFolder : selectedFolder;
  const setFolder = onFolderChange ?? setLocalFolder;
  return (
    <main className="mx-auto min-h-dvh max-w-6xl px-3 pb-32 pt-[max(1.25rem,env(safe-area-inset-top))]">
      <header className="mb-4 flex items-center gap-3 px-1">
        {folder ? (
          <button type="button" onClick={() => setFolder(null)} aria-label="返回文件夹" className="grid size-10 place-items-center rounded-full bg-surface"><CaretLeftIcon size={20} /></button>
        ) : null}
        <h1 className="min-w-0 flex-1 truncate text-[26px] font-semibold tracking-tight">{folder ? folder.label : "片库"}</h1>
        {onBookmarks && <button type="button" onClick={onBookmarks} className="min-h-10 rounded-full bg-surface px-4 text-[14px]">片段</button>}
        {onCuration && <button type="button" onClick={onCuration} className="min-h-10 rounded-full bg-surface px-3 text-[14px]">待整理</button>}
        <BlurToggle />
      </header>
      {folder ? <FolderWall folder={folder} onOpen={onOpen} /> : (
        <>
          <div className="mb-4 flex gap-1 rounded-full bg-surface p-1" role="tablist">
            {([["short", "短视频"], ["long", "长视频"], ["folders", "文件夹"]] as const).map(([key, label]) => (
              <button key={key} type="button" role="tab" aria-selected={view === key} onClick={() => setView(key)}
                className={`h-9 flex-1 rounded-full text-[14px] transition ${view === key ? "bg-raised font-semibold text-ink" : "text-muted"}`}>{label}</button>
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
      setRecent(p.recent_items);
      setProgress(new Map(p.items.map(i => [i.id, i.position_seconds])));
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
          className="min-h-10 min-w-0 flex-1 rounded-full bg-surface px-3 text-ink">
          <option value="newest">最新</option><option value="longest">时长最长</option>
          <option value="largest">体积最大</option><option value="random">随机</option>
        </select>
        <select aria-label="时长范围" value={timeband} onChange={event => setTimeband(event.target.value)}
          className="min-h-10 min-w-0 flex-1 rounded-full bg-surface px-3 text-ink">
          <option value="all">全部时长</option><option value="short">1 分钟内</option>
          <option value="medium">1–5 分钟</option><option value="long">5 分钟以上</option>
        </select>
        <button type="button" aria-label="只看未看" aria-pressed={unwatched} onClick={() => setUnwatched(value => !value)}
          className={`min-h-10 shrink-0 rounded-full px-3 ${unwatched ? "bg-ink font-semibold text-bg" : "bg-surface text-muted"}`}>只看未看</button>
      </div>
      {tags.length > 0 && (
        <div className="-mx-3 mb-3 flex gap-2 overflow-x-auto px-3 [scrollbar-width:none]">
          {[{ id: null, name: "全部" } as { id: number | null; name: string }, ...tags].map(t => (
            <button key={String(t.id)} type="button" onClick={() => setTag(t.id)}
              className={`h-8 shrink-0 rounded-full px-3.5 text-[13px] ${tag === t.id ? "bg-ink font-semibold text-bg" : "bg-surface text-muted"}`}>{t.name}</button>
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
      <h2 className="mb-2 px-1 text-[15px] font-semibold">继续观看</h2>
      <div className="-mx-3 flex gap-2 overflow-x-auto px-3 [scrollbar-width:none]">
        {items.map((item, index) => (
          <button key={item.id} type="button" onClick={() => onOpen(items, index)} aria-label={`继续观看第 ${index + 1} 个`}
            className="relative aspect-video w-56 shrink-0 overflow-hidden rounded-[10px] bg-surface text-left">
            {item.cover_url && <Cover src={item.cover_url} className={`size-full object-cover ${prefs.coverBlur ? "blur-xl scale-110" : ""}`} />}
            <span className="absolute bottom-1.5 left-2 rounded bg-black/55 px-1 text-[11px] tabular-nums text-white">
              剩 {formatDuration((item.duration_seconds ?? 0) - item.position_seconds)}
            </span>
            <WatchedBar seconds={item.position_seconds} duration={item.duration_seconds} />
          </button>
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
    <div className="flex flex-col gap-1">
      {plain.map(f => <Row key={f.id} label={f.label} count={f.video_count} onClick={() => onPick(f)} />)}
      {dates.filter(d => d.date).map(d => (
        <div key={d.date}>
          <Row label={d.date!} count={d.video_count} hint={`${d.folder_count} 批`} open={open === d.date} onClick={() => setOpen(open === d.date ? null : d.date)} />
          {open === d.date && batches.map(f => <Row key={f.id} label={f.label} count={f.video_count} indent onClick={() => onPick(f)} />)}
        </div>
      ))}
    </div>
  );
}

function Row({ label, count, hint, indent, open, onClick }: { label: string; count: number; hint?: string; indent?: boolean; open?: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className={`flex h-14 w-full items-center gap-3 rounded-[14px] px-4 text-left active:bg-surface ${indent ? "pl-10" : ""}`}>
      <FolderIcon size={22} className="shrink-0 text-muted" />
      <span className="min-w-0 flex-1 truncate text-[15px]">{label}</span>
      {hint && <span className="text-[12px] text-faint">{hint}</span>}
      <span className="text-[13px] tabular-nums text-muted">{count}</span>
      <CaretRightIcon size={16} className={`text-faint transition-transform ${open ? "rotate-90" : ""}`} />
    </button>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="py-24 text-center text-[15px] text-muted">{children}</p>;
}
