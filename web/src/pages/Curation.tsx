import { CaretLeftIcon, CheckCircleIcon, CheckIcon, LightningIcon, MinusCircleIcon, PlusCircleIcon } from "@phosphor-icons/react";
import { motion } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Media, type Tag } from "../api";
import { curationApi, type CurationChange } from "../curationApi";
import { usePrefs } from "../prefs";
import { BlurToggle, Cover, formatDuration } from "../ui/Grid";
import { Sheet } from "../ui/Sheet";
import { FlutedPrivacyShield } from "../ui/CinemaChrome";
import { SPRING_PILL } from "../ui/motion";
import { haptic } from "../ui/haptics";
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
  const apply = async (change: CurationChange, explicitTagGroup?: number[]) => {
    const page = pages.current;
    if (!page?.active || mutation.current || !selected.length || selected.length > 100) return;
    const effectiveTags = explicitTagGroup ?? tagIds;
    if ((change.add_tags || change.remove_tags) && (!effectiveTags.length || effectiveTags.length > 20)) return;
    const current = { controller: new AbortController(), page }; mutation.current = current;
    setSaving(true); setActionError(false);
    try {
      await curationApi.batch([...selected], change, current.controller.signal);
      if (mutation.current !== current || pages.current !== page || !page.active) return;
      const group = change.add_tags ?? change.remove_tags;
      if (group?.length) setRecent(rememberTagGroup(group, tags.map(tag => tag.id)));
      haptic(10);
      mutation.current = null; setSaving(false); setTagAction(null);
      restart();
    } catch {
      if (mutation.current === current && page.active && pages.current === page) setActionError(true);
    } finally {
      if (mutation.current === current) { mutation.current = null; setSaving(false); }
    }
  };
  const toggle = (id: string) => {
    if (saving) return;
    haptic(5);
    setSelected(ids => ids.includes(id) ? ids.filter(item => item !== id) : ids.length < 100 ? [...ids, id] : ids);
  };
  const openTags = (action: TagAction) => { setTagIds([]); setActionError(false); setTagAction(action); void loadTags(); };
  const tagLabel = tagAction === "add" ? "追加标签" : "移除标签";

  return <main className="mx-auto min-h-dvh max-w-6xl px-3.5 pb-32 pt-[max(1.25rem,env(safe-area-inset-top))]">
    <header className="mb-4 flex items-center gap-2.5 px-0.5">
      <button type="button" onClick={onBack} aria-label="返回片库" className="ios-card pressable grid size-10 shrink-0 place-items-center rounded-full text-ink"><CaretLeftIcon size={19} weight="bold" /></button>
      <h1 className="min-w-0 flex-1 text-[28px] font-semibold tracking-[-0.035em] text-ink">整理工作台</h1>
      <BlurToggle />
    </header>
    <div role="tablist" aria-label="整理状态" className="ios-card mb-3 flex gap-1 rounded-full p-1">
      {([false, true] as const).map(value => (
        <button key={String(value)} type="button" role="tab" aria-label={value ? "已整理" : "待整理"}
          aria-selected={organized === value} disabled={saving} onClick={() => setOrganized(value)}
          className={`relative min-h-10 flex-1 rounded-full text-[14px] transition-colors ${organized === value ? "font-semibold text-gold-bright" : "text-muted hover:text-ink"}`}>
          {organized === value && (
            <motion.span layoutId="ppvio-curation-tab" transition={SPRING_PILL}
              className="absolute inset-0 rounded-full border border-gold/28 bg-gradient-to-b from-gold/20 via-white/[0.08] to-white/[0.03]" />
          )}
          <span className="relative z-10">{value ? "已整理" : "待整理"}</span>
        </button>
      ))}
    </div>
    <p className="mb-3 px-1 text-[13px] text-muted">点选卡片批量归类；支持一键套用常用标签组合并同步标为完成。</p>

    <section aria-label="批量整理" className="glass-dock sticky top-2 z-10 mb-4 space-y-2.5 rounded-[20px] p-3">
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        <span role="status" className="film-slate mr-auto rounded-full border border-gold/30 bg-gold/12 px-2.5 py-1 text-[11.5px] font-semibold text-gold-bright">
          已选 {selected.length} / 100
        </span>
        <button type="button" aria-label="选择当前已加载" disabled={saving || !items.length || selected.length >= 100}
          onClick={() => setSelected(ids => [...new Set([...ids, ...items.map(item => item.id)])].slice(0, 100))}
          className="glass-pill pressable min-h-9 rounded-full px-3.5 text-[12.5px] font-medium disabled:opacity-40">选择已加载</button>
        <button type="button" aria-label="清空选择" disabled={saving || !selected.length} onClick={() => setSelected([])}
          className="glass-pill pressable min-h-9 rounded-full px-3.5 text-[12.5px] font-medium disabled:opacity-40">清空</button>
      </div>

      {/* Instant 1-tap macro combos when videos are selected */}
      {recent.length > 0 && selected.length > 0 && !organized && (
        <div className="flex items-center gap-1.5 overflow-x-auto [scrollbar-width:none]">
          <span className="film-slate shrink-0 text-[10px] text-gold/85">一键归类</span>
          {recent.slice(0, 3).map(group => {
            const label = group.map(id => tags.find(t => t.id === id)?.name).filter(Boolean).join(" + ");
            if (!label) return null;
            return (
              <button key={`macro-${group.join(",")}`} type="button" disabled={saving}
                onClick={() => void apply({ add_tags: group, organized: true }, group)}
                className="pressable inline-flex h-8 shrink-0 items-center gap-1 rounded-full border border-gold/35 bg-gold/14 px-2.5 text-[12px] font-medium text-gold-bright hover:bg-gold/24 disabled:opacity-45">
                <LightningIcon size={12} weight="fill" className="text-gold" />
                <span className="max-w-[160px] truncate">{label}</span>
              </button>
            );
          })}
        </div>
      )}

      <div className="grid grid-cols-3 gap-2 text-[13px]">
        <button type="button" aria-label="追加标签" disabled={saving || !selected.length || !tagsReady} onClick={() => openTags("add")}
          className="glass-pill pressable flex min-h-10.5 items-center justify-center gap-1 rounded-full font-medium disabled:opacity-40"><PlusCircleIcon size={16} />追加标签</button>
        <button type="button" aria-label="移除标签" disabled={saving || !selected.length || !tagsReady} onClick={() => openTags("remove")}
          className="glass-pill pressable flex min-h-10.5 items-center justify-center gap-1 rounded-full font-medium disabled:opacity-40"><MinusCircleIcon size={16} />移除标签</button>
        <button type="button" aria-label={organized ? "移回待整理" : "标记完成"} disabled={saving || !selected.length}
          onClick={() => void apply({ organized: !organized })}
          className="glass-pill-gold pressable flex min-h-10.5 items-center justify-center gap-1 rounded-full font-semibold disabled:opacity-40">
          <CheckCircleIcon size={16} weight="bold" />{saving && !tagAction ? "保存中…" : organized ? "移回待整理" : "标记完成"}
        </button>
      </div>
    </section>

    {tagsError && <div role="alert" className="mb-3 text-[13px] text-accent">标签加载失败。
      <button type="button" aria-label="重试整理标签" onClick={() => void loadTags()} className="ml-2 min-h-10 underline">重试标签</button></div>}
    {actionError && !tagAction && <p role="alert" className="mb-3 text-[13px] text-accent">操作失败，已保留选择，请重试。</p>}

    <div className="grid grid-cols-3 gap-2.5 sm:grid-cols-4 lg:grid-cols-6">
      {items.map((item, index) => {
        const isChecked = selected.includes(item.id);
        return (
          <div key={item.id} className={`luxury-card group relative min-w-0 rounded-[15px] transition-transform duration-200 ${isChecked ? "ring-2 ring-gold-bright ring-offset-1 ring-offset-bg" : ""}`}>
            <button type="button" aria-label={`播放第 ${index + 1} 个视频`} onClick={() => onOpen(items, index, () => void load())}
              className="relative block aspect-[3/4] w-full overflow-hidden bg-surface">
              {item.cover_url && <Cover src={item.cover_url} className={`film-grade size-full object-cover ${prefs.coverBlur ? "blur-xl scale-110" : ""}`} />}
              <FlutedPrivacyShield active={prefs.coverBlur} />
              <span aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 h-14 bg-gradient-to-t from-black/80 to-transparent" />
              <span className="glass-pill film-slate absolute bottom-1.5 right-1.5 rounded-full px-2 py-0.5 text-[10px] text-ink">{formatDuration(item.duration_seconds)}</span>
            </button>
            <label className={`flex min-h-10 cursor-pointer items-center justify-center gap-1.5 border-t border-line px-2 text-[12.5px] font-medium transition-colors ${isChecked ? "bg-gold/18 text-gold-bright" : "bg-surface/90 text-muted hover:text-ink"}`}>
              <input type="checkbox" aria-label={`选择第 ${index + 1} 个视频`} checked={isChecked}
                disabled={saving || (!isChecked && selected.length >= 100)} onChange={() => toggle(item.id)} className="sr-only" />
              <span aria-hidden="true" className={`grid size-4.5 place-items-center rounded-full border ${isChecked ? "border-gold-bright bg-gold text-bg" : "border-line-strong text-transparent"}`}>
                <CheckIcon size={11} weight="bold" />
              </span>
              <span>{isChecked ? "已选" : "选择"}</span>
            </label>
          </div>
        );
      })}
    </div>

    {done && !items.length && <p className="py-20 text-center text-[15px] text-muted">{organized ? "还没有已整理的视频" : "暂时没有待整理的视频"}</p>}
    {loadError ? <div role="alert" className="flex items-center justify-center gap-3 py-6 text-[14px] text-muted">列表加载失败
      <button type="button" aria-label="重试整理列表" onClick={() => void load(true)} className="ios-card pressable min-h-11 rounded-full px-4 text-ink">重试</button>
    </div> : !done && <div className="flex justify-center py-5">
      <button type="button" aria-label="加载更多整理视频" disabled={loading} onClick={() => void load()}
        className="ios-card pressable min-h-11 rounded-full px-6 text-[14px] font-medium text-ink disabled:opacity-50">{loading ? "正在加载…" : "加载更多"}</button>
    </div>}

    <Sheet open={tagAction !== null} onClose={closeTags} title={tagLabel}>
      <div className="space-y-4 px-3">
        <p className="text-[13px] text-muted">对已选的 {selected.length} 个视频{tagAction === "add" ? "追加" : "移除"}所选标签，其他标签保持不变。最多 20 个。</p>
        {recent.length > 0 && <section>
          <h3 className="mb-2 text-[13px] font-semibold text-ink">最近标签组</h3>
          <div className="flex flex-wrap gap-2">{recent.map(group => {
            const label = group.map(id => tags.find(tag => tag.id === id)?.name).filter(Boolean).join("、");
            return <button key={group.join(",")} type="button" aria-label={`使用标签组 ${label}`} disabled={saving} onClick={() => setTagIds([...group])}
              className="glass-pill pressable min-h-9 max-w-full truncate rounded-full px-3 text-[13px] text-gold-bright disabled:opacity-40">{label}</button>;
          })}</div>
        </section>}
        <fieldset disabled={saving}>
          <legend className="mb-2 text-[14px] font-semibold text-ink">选择标签 · {tagIds.length}/20</legend>
          <div className="grid grid-cols-2 gap-2">{tags.map(tag => {
            const checked = tagIds.includes(tag.id);
            return (
              <label key={tag.id} className={`pressable flex min-h-11 min-w-0 cursor-pointer items-center gap-2 rounded-[14px] border px-3 text-[13.5px] transition-colors ${checked ? "border-gold/55 bg-gold/18 font-semibold text-gold-bright" : "border-line bg-white/[0.03] text-ink/90"}`}>
                <input type="checkbox" aria-label={`批量标签 ${tag.name}`} checked={checked} disabled={!checked && tagIds.length >= 20}
                  onChange={() => setTagIds(ids => ids.includes(tag.id) ? ids.filter(id => id !== tag.id) : ids.length < 20 ? [...ids, tag.id] : ids)} className="sr-only" />
                <span aria-hidden="true" className={`grid size-4.5 shrink-0 place-items-center rounded-full border ${checked ? "border-gold-bright bg-gold text-bg" : "border-line-strong text-transparent"}`}>
                  <CheckIcon size={11} weight="bold" />
                </span>
                <span className="truncate">{tag.name}</span>
              </label>
            );
          })}</div>
          {!tags.length && <p className="text-[13px] text-muted">还没有标签，可在播放器中添加。</p>}
        </fieldset>
        {actionError && <p role="alert" className="text-[13px] text-accent">操作失败，已保留选择，请重试。</p>}
        <div className="sticky bottom-0 flex gap-2 bg-[#101116]/95 py-2 backdrop-blur-md">
          <button type="button" aria-label="取消批量标签" disabled={saving} onClick={closeTags} className="glass-pill pressable min-h-11 flex-1 rounded-full text-[14px] disabled:opacity-40">取消</button>
          <button type="button" aria-label={`确认${tagLabel}`} disabled={saving || !tagIds.length} onClick={() => void apply(tagAction === "add" ? { add_tags: tagIds } : { remove_tags: tagIds })}
            className="glass-pill-gold pressable min-h-11 flex-1 rounded-full text-[14px] font-semibold disabled:opacity-40">{saving ? "保存中…" : tagLabel}</button>
        </div>
      </div>
    </Sheet>
  </main>;
}
