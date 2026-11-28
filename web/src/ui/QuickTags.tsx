import { CheckIcon, LightningIcon, MagnifyingGlassIcon, PlusIcon, TagIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { api, type Media, type Tag } from "../api";
import { Sheet } from "./Sheet";
import { useLocked } from "./privacy";
import { readTriageMacros, rememberTriageMacro } from "./triageMacros";
import { haptic } from "./haptics";

const RECENT_KEY = "ppvio:quick-tags:v1";
const action = "ios-card pressable min-h-10 rounded-full px-4 text-sm font-medium text-ink disabled:opacity-50";

function useVisible(): boolean {
  const locked = useLocked(), [visible, setVisible] = useState(() => !document.hidden);
  useEffect(() => {
    const change = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", change);
    return () => document.removeEventListener("visibilitychange", change);
  }, []);
  return visible && !locked;
}

function remember(ids: number[]): void {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(ids)); } catch { /* Tags still save when local storage is unavailable. */ }
}

function recentTags(tags: Tag[]): number[] {
  const known = new Set(tags.map(tag => tag.id));
  let stored: unknown;
  try { stored = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]"); } catch { stored = []; }
  const ids = Array.isArray(stored) ? [...new Set(stored.filter((id): id is number =>
    typeof id === "number" && Number.isSafeInteger(id) && id > 0 && known.has(id)))].slice(0, 10) : [];
  remember(ids); return ids;
}

export function QuickTagButton({ media, onSaved, enabled = true, iconOnly = false }: {
  media: Media; onSaved?: () => void; enabled?: boolean; iconOnly?: boolean;
}) {
  const visible = useVisible(), [openedId, setOpenedId] = useState<string | null>(null);
  useEffect(() => { setOpenedId(null); }, [media.id, enabled, visible]);
  const open = openedId === media.id && visible && enabled;
  return <>
    <button type="button" aria-label="标签收藏" title="标签收藏" disabled={!enabled || !visible} onClick={() => setOpenedId(media.id)}
      className={iconOnly
        ? "glass-pill pressable grid size-11 place-items-center rounded-full text-ink hover:border-gold/40 disabled:opacity-45"
        : "glass-pill pressable flex size-10 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-full text-[13px] font-medium text-ink disabled:opacity-45 sm:w-auto sm:px-3.5"}>
      <TagIcon size={iconOnly ? 22 : 18} weight={iconOnly ? "fill" : "regular"} />{!iconOnly && <span className="hidden sm:inline">标签收藏</span>}
    </button>
    {open && <Sheet open onClose={() => setOpenedId(null)} title="标签收藏">
      <TagPanel key={media.id} media={media} onSaved={onSaved} onDone={() => setOpenedId(null)} />
    </Sheet>}
  </>;
}

export function QuickTagPanel({ media, onDone, onApplyMacro, compact = false, doneLabel = "完成选择", finishing = false, headerMeta, footerLeft }: {
  media: Media; onDone?: () => void;
  /** Optional 1-tap macro callback: applies a saved multi-tag combo and advances immediately. */
  onApplyMacro?: (tagIds: number[], label: string) => void;
  compact?: boolean; doneLabel?: string; finishing?: boolean;
  headerMeta?: React.ReactNode; footerLeft?: React.ReactNode;
}) {
  const visible = useVisible();
  return visible ? (
    <TagPanel
      key={media.id}
      media={media}
      onDone={onDone}
      onApplyMacro={onApplyMacro}
      compact={compact}
      doneLabel={doneLabel}
      finishing={finishing}
      headerMeta={headerMeta}
      footerLeft={footerLeft}
    />
  ) : null;
}

function TagPanel({ media, onDone, onSaved, onApplyMacro, compact = false, doneLabel = "完成选择", finishing = false, headerMeta, footerLeft }: {
  media: Media; onDone?: () => void; onSaved?: () => void;
  onApplyMacro?: (tagIds: number[], label: string) => void;
  compact?: boolean; doneLabel?: string; finishing?: boolean;
  headerMeta?: React.ReactNode; footerLeft?: React.ReactNode;
}) {
  const [tags, setTags] = useState<Tag[]>([]), [selected, setSelected] = useState<number[]>([]);
  const [recent, setRecent] = useState<number[]>([]), [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(true), [failed, setFailed] = useState(false), [errors, setErrors] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState<Set<number>>(() => new Set());
  const alive = useRef(false), generation = useRef(0), busyIds = useRef(new Set<number>()), recentIds = useRef<number[]>([]);
  const reads = useRef<AbortController | null>(null), writes = useRef(new Set<AbortController>());
  const load = async () => {
    reads.current?.abort();
    const controller = new AbortController(), version = ++generation.current;
    reads.current = controller; setLoading(true); setFailed(false);
    try {
      const [labels, applied] = await Promise.all([api.tags(controller.signal), api.mediaTags(media.id, controller.signal)]);
      if (!alive.current || controller.signal.aborted || version !== generation.current) return;
      setTags(labels.items); setSelected(applied.ids);
      const ids = recentTags(labels.items); recentIds.current = ids; setRecent(ids);
    } catch {
      if (alive.current && !controller.signal.aborted && version === generation.current) setFailed(true);
    } finally {
      if (alive.current && !controller.signal.aborted && version === generation.current) setLoading(false);
    }
  };
  useEffect(() => {
    alive.current = true; void load();
    return () => {
      alive.current = false; ++generation.current; reads.current?.abort();
      writes.current.forEach(controller => controller.abort()); writes.current.clear(); busyIds.current.clear();
    };
  }, [media.id]);

  const setTag = async (tag: Tag, on: boolean) => {
    if (!alive.current || finishing || loading || failed || busyIds.current.has(tag.id) || document.hidden) return;
    const controller = new AbortController();
    busyIds.current.add(tag.id); writes.current.add(controller); setBusy(new Set(busyIds.current));
    try {
      await api.setMediaTag(media.id, tag.id, on, controller.signal);
      if (!alive.current || controller.signal.aborted || document.hidden) return;
      haptic(6);
      // Each acknowledgment applies only its tag; other tag requests can finish in any order.
      setSelected(ids => {
        const next = on ? [...new Set([...ids, tag.id])] : ids.filter(id => id !== tag.id);
        return next;
      });
      setErrors(previous => { const next = { ...previous }; delete next[tag.id]; return next; });
      if (on) {
        const ids = [tag.id, ...recentIds.current.filter(id => id !== tag.id)].slice(0, 10);
        recentIds.current = ids; remember(ids); setRecent(ids);
      }
      onSaved?.();
    } catch {
      if (alive.current && !controller.signal.aborted && !document.hidden) setErrors(previous => ({ ...previous, [tag.id]: `“${tag.name}”未保存，请再次点选重试。` }));
    } finally {
      writes.current.delete(controller); busyIds.current.delete(tag.id);
      if (alive.current && !controller.signal.aborted) setBusy(new Set(busyIds.current));
    }
  };

  const quickCreate = async () => {
    const cleanName = query.trim().replace(/\s+/gu, " ");
    if (!cleanName || creating || finishing || !alive.current) return;
    setCreating(true);
    try {
      const created = await api.createTag(cleanName);
      if (!alive.current) return;
      setTags(list => list.some(t => t.id === created.id) ? list : [created, ...list]);
      setQuery("");
      await setTag(created, true);
    } catch {
      if (alive.current) setErrors(prev => ({ ...prev, [-1]: `无法创建“${cleanName}”，请检查是否重名或超过 20 字。` }));
    } finally {
      if (alive.current) setCreating(false);
    }
  };

  const handleDone = () => {
    if (selected.length) rememberTriageMacro(selected, tags);
    onDone?.();
  };

  const search = query.trim().toLocaleLowerCase();
  const exactExists = !!search && tags.some(t => t.name.toLocaleLowerCase() === search);
  const common = [...tags].sort((a, b) => b.count - a.count || a.id - b.id);
  const preferred = [...recent, ...common.map(tag => tag.id).filter(id => !recent.includes(id))].slice(0, 10);
  const groups = search ? [{ title: "搜索结果", items: tags.filter(tag => tag.name.toLocaleLowerCase().includes(search)) }]
    : [{ title: "最近 / 常用", items: preferred.map(id => tags.find(tag => tag.id === id)!).filter(Boolean) },
      { title: "全部标签", items: tags.filter(tag => !preferred.includes(tag.id)) }];
  const macros = compact && onApplyMacro && !loading && !failed ? readTriageMacros(tags).slice(0, 3) : [];

  return <section aria-label="快捷标签选择" aria-busy={loading} className={`${compact ? "p-3" : "px-3 pb-2"} min-w-0 space-y-2.5`}>
    {compact ? (
      <div className="flex items-center gap-2">
        {headerMeta}
        <div className="relative min-w-0 flex-1">
          <MagnifyingGlassIcon size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gold/75" />
          <input type="search" aria-label="搜索标签" value={query} onChange={event => setQuery(event.target.value)}
            onKeyDown={e => { if (e.key === "Enter" && search && !exactExists) { e.preventDefault(); void quickCreate(); } }}
            placeholder="筛选或回车新建标签"
            className="h-9 w-full min-w-0 rounded-full border border-line bg-black/45 pl-8.5 pr-3 text-[13px] text-ink placeholder:text-faint outline-none focus:border-gold/50" />
        </div>
        {search && !exactExists && (
          <button type="button" onClick={() => void quickCreate()} disabled={creating || finishing}
            className="glass-pill-gold pressable inline-flex h-9 shrink-0 items-center gap-1 rounded-full px-3 text-[12px] font-semibold disabled:opacity-45">
            <PlusIcon size={13} weight="bold" />新建
          </button>
        )}
      </div>
    ) : (
      <>
        <p className="text-xs leading-relaxed text-muted">点选即保存，输入不存在的名称可直接新建并打标。</p>
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <MagnifyingGlassIcon size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-gold/75" />
            <input type="search" aria-label="搜索标签" value={query} onChange={event => setQuery(event.target.value)}
              onKeyDown={e => { if (e.key === "Enter" && search && !exactExists) { e.preventDefault(); void quickCreate(); } }}
              placeholder="搜索或直接新建标签"
              className="min-h-11 w-full min-w-0 rounded-[14px] border border-line bg-bg/90 pl-10 pr-3 text-sm text-ink placeholder:text-faint outline-none focus:border-gold/50" />
          </div>
          {search && !exactExists && (
            <button type="button" onClick={() => void quickCreate()} disabled={creating || finishing}
              className="glass-pill-gold pressable inline-flex min-h-11 shrink-0 items-center gap-1 rounded-[14px] px-3.5 text-[13px] font-semibold disabled:opacity-45">
              <PlusIcon size={15} weight="bold" />新建
            </button>
          )}
        </div>
      </>
    )}

    {macros.length > 0 && !search && (
      <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5 [scrollbar-width:none]" aria-label="一键连发套餐">
        <span className="film-slate shrink-0 text-[10px] font-medium uppercase text-gold/80">一键</span>
        {macros.map(macro => (
          <button key={macro.ids.join(",")} type="button" disabled={finishing || busy.size > 0}
            onClick={() => { haptic(10); onApplyMacro?.(macro.ids, macro.label); }}
            className="pressable inline-flex h-8 shrink-0 items-center gap-1 rounded-full border border-gold/35 bg-gold/12 px-2.5 text-[12px] font-medium text-gold-bright hover:bg-gold/22 disabled:opacity-45">
            <LightningIcon size={12} weight="fill" className="shrink-0 text-gold" />
            <span className="max-w-[160px] truncate">{macro.label}</span>
          </button>
        ))}
      </div>
    )}

    {loading ? <p role="status" className="py-3 text-center text-[13px] text-muted">正在读取标签…</p>
      : failed ? <div role="alert" className="text-sm text-accent"><button type="button" aria-label="重试读取标签" onClick={() => void load()} className={action}>标签读取失败，点击重试</button></div>
        : !tags.length ? <p className="py-3 text-center text-[13px] text-muted">暂无标签，输入上方搜索框回车即可快速新建。</p>
          : <div className={`${compact ? "max-h-24" : "max-h-72"} space-y-2 overflow-y-auto [scrollbar-width:none]`}>
            {groups.map(group => group.items.length > 0 && <fieldset key={group.title} className="min-w-0">
              {!compact && <legend className="mb-1.5 text-xs font-medium text-muted">{group.title}</legend>}
              <div className="flex flex-wrap gap-1.5">{group.items.map(tag => {
                const checked = selected.includes(tag.id), pending = busy.has(tag.id);
                return <label key={tag.id}
                  className={`pressable inline-flex cursor-pointer items-center gap-1.5 rounded-full border transition-[background-color,border-color,color,transform] duration-150 ${compact ? "min-h-8.5 px-3 text-[12.5px]" : "min-h-10 px-3.5 text-sm"} max-w-full ${checked ? "border-gold/60 bg-gold/22 font-semibold text-gold-bright" : "border-line bg-white/[0.04] text-ink/88 hover:border-line-strong"} ${pending ? "opacity-60" : ""}`}>
                  <input type="checkbox" aria-label={`标签 ${tag.name}`} aria-busy={pending} checked={checked} disabled={pending || finishing}
                    onChange={event => void setTag(tag, event.target.checked)} className="sr-only" />
                  {checked && <CheckIcon size={12} weight="bold" className="shrink-0 text-gold-bright" />}
                  <span className="min-w-0 break-words">{tag.name}</span>
                  {pending && <span className="shrink-0 text-[11px] text-muted">保存中</span>}
                </label>;
              })}</div>
            </fieldset>)}
            {search && !groups[0].items.length && <p className="py-3 text-center text-[13px] text-muted">没有匹配的标签，点击“新建”即可创建并应用</p>}
          </div>}
    {Object.values(errors).map(error => <p key={error} role="alert" className="text-xs text-accent">{error}</p>)}
    {onDone && (
      <div className="flex items-center gap-2 pt-0.5">
        {footerLeft}
        <button type="button" aria-label={doneLabel} disabled={finishing || loading || failed || busy.size > 0 || Object.keys(errors).length > 0} onClick={handleDone}
          className="glass-pill-gold pressable min-h-11 flex-1 rounded-full px-4 text-[14px] font-semibold disabled:opacity-45 disabled:shadow-none">{doneLabel}</button>
      </div>
    )}
  </section>;
}
