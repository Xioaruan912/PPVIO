import { CaretLeftIcon, CheckCircleIcon, MinusCircleIcon, PlusCircleIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Media, type Tag } from "../api";
import { curationApi, type CurationChange } from "../curationApi";
import { usePrefs } from "../prefs";
import { BlurToggle, Cover, formatDuration } from "../ui/Grid";
import { Sheet } from "../ui/Sheet";
import type { Open } from "./Library";

const RECENT_KEY = "ppvio-web:curation-tag-groups";
const cleanGroup = (ids: number[], valid: Set<number>) => [...new Set(ids)].filter(id => valid.has(id)).slice(0, 20);

export function readRecentTagGroups(validIds: number[]): number[][] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    if (!Array.isArray(raw)) return [];
    const valid = new Set(validIds), groups: number[][] = [];
    for (const group of raw) {
      if (!Array.isArray(group) || !group.every(id => Number.isSafeInteger(id) && id > 0)) continue;
      const ids = cleanGroup(group as number[], valid);
      if (ids.length && !groups.some(item => item.join(",") === ids.join(","))) groups.push(ids);
      if (groups.length === 6) break;
    }
    return groups;
  } catch { return []; }
}

export function rememberTagGroup(ids: number[], validIds: number[]): number[][] {
  const group = cleanGroup(ids, new Set(validIds));
  const groups = [group, ...readRecentTagGroups(validIds).filter(item => item.join(",") !== group.join(","))]
    .filter(item => item.length > 0).slice(0, 6);
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(groups)); } catch { /* Browser storage may be disabled. */ }
  return groups;
}

interface PageState {
  organized: boolean; offset: number; active: boolean; busy: boolean; done: boolean; error: boolean; controller: AbortController;
}
type TagAction = "add" | "remove";

export function Curation({ onBack, onOpen }: { onBack: () => void; onOpen: Open }) {
  const prefs = usePrefs();
  const [organized, setOrganized] = useState(false);
  const [revision, setRevision] = useState(0);
  const [items, setItems] = useState<Media[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [actionError, setActionError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [tags, setTags] = useState<Tag[]>([]);
  const [tagsReady, setTagsReady] = useState(false);
  const [tagsError, setTagsError] = useState(false);
  const [tagAction, setTagAction] = useState<TagAction | null>(null);
  const [tagIds, setTagIds] = useState<number[]>([]);
  const [recent, setRecent] = useState<number[][]>([]);
  const pages = useRef<PageState | null>(null);
  const mutation = useRef<{ controller: AbortController; page: PageState } | null>(null);
  const tagRequest = useRef<object | null>(null);

  const loadTags = useCallback(async () => {
    const token = {}; tagRequest.current = token; setTagsError(false);
    try {
      const result = await api.tags();
      if (tagRequest.current !== token) return;
      const valid = new Set(result.items.map(tag => tag.id));
      setTags(result.items); setTagsReady(true); setTagIds(ids => cleanGroup(ids, valid));
      setRecent(readRecentTagGroups([...valid]));
    } catch { if (tagRequest.current === token) setTagsError(true); }
  }, []);
  useEffect(() => { void loadTags(); return () => { tagRequest.current = null; }; }, [loadTags]);

  const load = useCallback(async (retry = false) => {
    const page = pages.current;
    if (!page?.active || page.busy || page.done || (page.error && !retry)) return;
    page.busy = true; page.error = false; setLoading(true); setLoadError(false);
    try {
      const result = await curationApi.list(page.organized, page.offset, page.controller.signal);
      if (!page.active || pages.current !== page) return;
      page.offset += result.items.length;
      page.done = !result.has_more || !result.items.length;
      setItems(previous => { const seen = new Set(previous.map(item => item.id)); return [...previous, ...result.items.filter(item => !seen.has(item.id))]; });
      setDone(page.done);
    } catch {
      if (!page.active || pages.current !== page) return;
      page.error = true; setLoadError(true);
    } finally {
      page.busy = false;
      if (page.active && pages.current === page) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const page: PageState = { organized, offset: 0, active: true, busy: false, done: false, error: false, controller: new AbortController() };
    pages.current = page;
    setItems([]); setSelected([]); setDone(false); setLoadError(false); setActionError(false);
    setTagAction(null); setTagIds([]); setSaving(false);
    void load();
    return () => {
      page.active = false; page.controller.abort();
      if (mutation.current?.page === page) { mutation.current.controller.abort(); mutation.current = null; }
    };
  }, [organized, revision, load]);

  const restart = () => {
    if (pages.current) { pages.current.active = false; pages.current.controller.abort(); }
    setRevision(value => value + 1);
  };
  const closeTags = () => {
    if (mutation.current) return;
    setTagAction(null); setSaving(false); setActionError(false);
  };
  const apply = async (change: CurationChange) => {
    const page = pages.current;
    if (!page?.active || mutation.current || !selected.length || selected.length > 100) return;
    if ((change.add_tags || change.remove_tags) && (!tagIds.length || tagIds.length > 20)) return;
    const current = { controller: new AbortController(), page }; mutation.current = current;
    setSaving(true); setActionError(false);
    try {
      await curationApi.batch([...selected], change, current.controller.signal);
      if (mutation.current !== current || pages.current !== page || !page.active) return;
      const group = change.add_tags ?? change.remove_tags;
      if (group?.length) setRecent(rememberTagGroup(group, tags.map(tag => tag.id)));
      mutation.current = null; setSaving(false); setTagAction(null);
      // A changed status removes rows from this offset query, so load a fresh first page.
      restart();
    } catch {
      if (mutation.current === current && page.active && pages.current === page) setActionError(true);
    } finally {
      if (mutation.current === current) { mutation.current = null; setSaving(false); }
    }
  };
  const toggle = (id: string) => {
    if (saving) return;
    setSelected(ids => ids.includes(id) ? ids.filter(item => item !== id) : ids.length < 100 ? [...ids, id] : ids);
  };
  const openTags = (action: TagAction) => { setTagIds([]); setActionError(false); setTagAction(action); void loadTags(); };
  const tagLabel = tagAction === "add" ? "追加标签" : "移除标签";

  return <main className="mx-auto min-h-dvh max-w-6xl px-3 pb-32 pt-[max(1.25rem,env(safe-area-inset-top))]">
    <header className="mb-4 flex items-center gap-3 px-1">
      <button type="button" onClick={onBack} aria-label="返回片库" className="grid size-10 place-items-center rounded-full bg-surface"><CaretLeftIcon size={20} /></button>
      <h1 className="min-w-0 flex-1 text-[26px] font-semibold tracking-tight">整理片库</h1><BlurToggle />
    </header>
    <div role="tablist" aria-label="整理状态" className="mb-3 flex gap-1 rounded-full bg-surface p-1">
      {([false, true] as const).map(value => <button key={String(value)} type="button" role="tab" aria-label={value ? "已整理" : "待整理"}
        aria-selected={organized === value} disabled={saving} onClick={() => setOrganized(value)}
        className={`min-h-10 flex-1 rounded-full text-[14px] ${organized === value ? "bg-raised font-semibold" : "text-muted"}`}>{value ? "已整理" : "待整理"}</button>)}
    </div>
    <p className="mb-3 px-1 text-[13px] text-muted">整理状态与看过记录分开保存。先选择视频，再批量操作。</p>
    <section aria-label="批量整理" className="sticky top-0 z-10 mb-3 space-y-2 rounded-[14px] bg-bg py-2">
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        <span role="status" className="mr-auto tabular-nums">已选 {selected.length} / 100</span>
        <button type="button" aria-label="选择当前已加载" disabled={saving || !items.length || selected.length >= 100}
          onClick={() => setSelected(ids => [...new Set([...ids, ...items.map(item => item.id)])].slice(0, 100))}
          className="min-h-10 rounded-full bg-surface px-3 disabled:opacity-40">选择已加载</button>
        <button type="button" aria-label="清空选择" disabled={saving || !selected.length} onClick={() => setSelected([])}
          className="min-h-10 rounded-full bg-surface px-3 disabled:opacity-40">清空</button>
      </div>
      <div className="grid grid-cols-3 gap-2 text-[13px]">
        <button type="button" aria-label="追加标签" disabled={saving || !selected.length || !tagsReady} onClick={() => openTags("add")}
          className="flex min-h-11 items-center justify-center gap-1 rounded-full bg-surface disabled:opacity-40"><PlusCircleIcon size={17} />追加标签</button>
        <button type="button" aria-label="移除标签" disabled={saving || !selected.length || !tagsReady} onClick={() => openTags("remove")}
          className="flex min-h-11 items-center justify-center gap-1 rounded-full bg-surface disabled:opacity-40"><MinusCircleIcon size={17} />移除标签</button>
        <button type="button" aria-label={organized ? "移回待整理" : "标记完成"} disabled={saving || !selected.length}
          onClick={() => void apply({ organized: !organized })}
          className="flex min-h-11 items-center justify-center gap-1 rounded-full bg-ink font-semibold text-bg disabled:opacity-40">
          <CheckCircleIcon size={17} />{saving && !tagAction ? "保存中…" : organized ? "移回待整理" : "标记完成"}</button>
      </div>
    </section>
    {tagsError && <div role="alert" className="mb-3 text-[13px] text-accent">标签加载失败。
      <button type="button" aria-label="重试整理标签" onClick={() => void loadTags()} className="ml-2 min-h-10 underline">重试标签</button></div>}
    {actionError && !tagAction && <p role="alert" className="mb-3 text-[13px] text-accent">操作失败，已保留选择，请重试。</p>}
    <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-4 lg:grid-cols-6">
      {items.map((item, index) => <div key={item.id} className="min-w-0 rounded-[10px] bg-surface">
        <button type="button" aria-label={`播放第 ${index + 1} 个视频`} onClick={() => onOpen(items, index, () => void load())}
          className="relative block aspect-[3/4] w-full overflow-hidden rounded-[10px] bg-surface">
          {item.cover_url && <Cover src={item.cover_url} className={`size-full object-cover ${prefs.coverBlur ? "blur-xl scale-110" : ""}`} />}
          <span className="absolute bottom-1 right-1.5 rounded bg-black/55 px-1 text-[11px] tabular-nums text-white">{formatDuration(item.duration_seconds)}</span>
        </button>
        <label className="flex min-h-11 items-center justify-center gap-2 text-[13px]">
          <input type="checkbox" aria-label={`选择第 ${index + 1} 个视频`} checked={selected.includes(item.id)}
            disabled={saving || (!selected.includes(item.id) && selected.length >= 100)} onChange={() => toggle(item.id)} />选择
        </label>
      </div>)}
    </div>
    {done && !items.length && <p className="py-20 text-center text-[15px] text-muted">{organized ? "还没有已整理的视频" : "暂时没有待整理的视频"}</p>}
    {loadError ? <div role="alert" className="flex items-center justify-center gap-3 py-6 text-[14px] text-muted">列表加载失败
      <button type="button" aria-label="重试整理列表" onClick={() => void load(true)} className="min-h-11 rounded-full bg-surface px-4 text-ink">重试</button>
    </div> : !done && <div className="flex justify-center py-5">
      <button type="button" aria-label="加载更多整理视频" disabled={loading} onClick={() => void load()}
        className="min-h-11 rounded-full bg-surface px-6 text-[14px] disabled:opacity-50">{loading ? "正在加载…" : "加载更多"}</button>
    </div>}
    <Sheet open={tagAction !== null} onClose={closeTags} title={tagLabel}>
      <div className="space-y-4 px-3">
        <p className="text-[13px] text-muted">对已选的 {selected.length} 个视频{tagAction === "add" ? "追加" : "移除"}所选标签，其他标签保持不变。最多 20 个。</p>
        {recent.length > 0 && <section>
          <h3 className="mb-2 text-[13px] font-semibold">最近标签组</h3>
          <div className="flex flex-wrap gap-2">{recent.map(group => {
            const label = group.map(id => tags.find(tag => tag.id === id)?.name).filter(Boolean).join("、");
            return <button key={group.join(",")} type="button" aria-label={`使用标签组 ${label}`} disabled={saving} onClick={() => setTagIds([...group])}
              className="min-h-10 max-w-full truncate rounded-full bg-raised px-3 text-[13px] disabled:opacity-40">{label}</button>;
          })}</div>
        </section>}
        <fieldset disabled={saving}>
          <legend className="mb-2 text-[14px] font-semibold">选择标签 · {tagIds.length}/20</legend>
          <div className="grid grid-cols-2 gap-x-3">{tags.map(tag => <label key={tag.id} className="flex min-h-11 min-w-0 items-center gap-2 text-[14px]">
            <input type="checkbox" aria-label={`批量标签 ${tag.name}`} checked={tagIds.includes(tag.id)} disabled={!tagIds.includes(tag.id) && tagIds.length >= 20}
              onChange={() => setTagIds(ids => ids.includes(tag.id) ? ids.filter(id => id !== tag.id) : ids.length < 20 ? [...ids, tag.id] : ids)} />
            <span className="truncate">{tag.name}</span></label>)}</div>
          {!tags.length && <p className="text-[13px] text-muted">还没有标签，可在播放器中添加。</p>}
        </fieldset>
        {actionError && <p role="alert" className="text-[13px] text-accent">操作失败，已保留选择，请重试。</p>}
        <div className="sticky bottom-0 flex gap-2 bg-surface py-2">
          <button type="button" aria-label="取消批量标签" disabled={saving} onClick={closeTags} className="min-h-11 flex-1 rounded-full bg-raised text-[14px] disabled:opacity-40">取消</button>
          <button type="button" aria-label={`确认${tagLabel}`} disabled={saving || !tagIds.length} onClick={() => void apply(tagAction === "add" ? { add_tags: tagIds } : { remove_tags: tagIds })}
            className="min-h-11 flex-1 rounded-full bg-ink text-[14px] font-semibold text-bg disabled:opacity-40">{saving ? "保存中…" : tagLabel}</button>
        </div>
      </div>
    </Sheet>
  </main>;
}
