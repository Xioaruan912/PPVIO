import { TagIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { api, type Media, type Tag } from "../api";
import { Sheet } from "./Sheet";
import { useLocked } from "./privacy";

const RECENT_KEY = "ppvio:quick-tags:v1";
const action = "min-h-11 rounded-full bg-raised px-4 text-sm disabled:opacity-50";

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

export function QuickTagButton({ media, onSaved, enabled = true }: {
  media: Media; onSaved?: () => void; enabled?: boolean;
}) {
  const visible = useVisible(), [openedId, setOpenedId] = useState<string | null>(null);
  useEffect(() => { setOpenedId(null); }, [media.id, enabled, visible]);
  const open = openedId === media.id && visible && enabled;
  return <>
    <button type="button" aria-label="标签收藏" disabled={!enabled || !visible} onClick={() => setOpenedId(media.id)}
      className="flex min-h-11 items-center justify-center gap-2 rounded-full bg-raised px-3 text-sm disabled:opacity-50"><TagIcon size={20} />标签收藏</button>
    {open && <Sheet open onClose={() => setOpenedId(null)} title="标签收藏">
      <TagPanel key={media.id} media={media} onSaved={onSaved} onDone={() => setOpenedId(null)} />
    </Sheet>}
  </>;
}

export function QuickTagPanel({ media, onDone, compact = false, doneLabel = "完成选择", finishing = false }: {
  media: Media; onDone?: () => void; compact?: boolean; doneLabel?: string; finishing?: boolean;
}) {
  const visible = useVisible();
  return visible ? <TagPanel key={media.id} media={media} onDone={onDone} compact={compact} doneLabel={doneLabel} finishing={finishing} /> : null;
}

function TagPanel({ media, onDone, onSaved, compact = false, doneLabel = "完成选择", finishing = false }: {
  media: Media; onDone?: () => void; onSaved?: () => void; compact?: boolean; doneLabel?: string; finishing?: boolean;
}) {
  const [tags, setTags] = useState<Tag[]>([]), [selected, setSelected] = useState<number[]>([]);
  const [recent, setRecent] = useState<number[]>([]), [query, setQuery] = useState("");
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
      // Each acknowledgment applies only its tag; other tag requests can finish in any order.
      setSelected(ids => on ? [...new Set([...ids, tag.id])] : ids.filter(id => id !== tag.id));
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
  const search = query.trim().toLocaleLowerCase();
  const common = [...tags].sort((a, b) => b.count - a.count || a.id - b.id);
  const preferred = [...recent, ...common.map(tag => tag.id).filter(id => !recent.includes(id))].slice(0, 10);
  const groups = search ? [{ title: "搜索结果", items: tags.filter(tag => tag.name.toLocaleLowerCase().includes(search)) }]
    : [{ title: "最近 / 常用", items: preferred.map(id => tags.find(tag => tag.id === id)!).filter(Boolean) },
      { title: "全部标签", items: tags.filter(tag => !preferred.includes(tag.id)) }];

  return <section aria-label="快捷标签选择" aria-busy={loading} className={`${compact ? "p-3" : "px-3 pb-2"} min-w-0 space-y-3`}>
    <p className="text-xs leading-relaxed text-muted">点选即保存，可同时收藏到多个标签。</p>
    <input type="search" aria-label="搜索标签" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索标签"
      className="min-h-11 w-full min-w-0 rounded-lg bg-bg px-3 text-sm" />
    {loading ? <p role="status" className="py-4 text-center text-sm text-muted">正在读取标签…</p>
      : failed ? <div role="alert" className="text-sm text-accent"><button type="button" aria-label="重试读取标签" onClick={() => void load()} className={action}>标签读取失败，点击重试</button></div>
        : !tags.length ? <p className="py-4 text-center text-sm text-muted">暂无标签，请在标签管理中创建。</p>
          : <div className={`${compact ? "max-h-44" : "max-h-72"} space-y-3 overflow-y-auto`}>
            {groups.map(group => group.items.length > 0 && <fieldset key={group.title} className="min-w-0"><legend className="mb-1 text-xs text-muted">{group.title}</legend>
              <div className="flex flex-wrap gap-1.5">{group.items.map(tag => {
                const checked = selected.includes(tag.id), pending = busy.has(tag.id);
                return <label key={tag.id} className={`flex min-h-11 max-w-full items-center gap-2 rounded-lg px-3 text-sm ${checked ? "bg-accent/15 text-ink" : "bg-bg"} ${pending ? "opacity-60" : ""}`}>
                  <input type="checkbox" aria-label={`标签 ${tag.name}`} aria-busy={pending} checked={checked} disabled={pending || finishing}
                    onChange={event => void setTag(tag, event.target.checked)} className="shrink-0 accent-accent" />
                  <span className="min-w-0 break-words">{tag.name}</span>{pending && <span className="shrink-0 text-xs text-muted">保存中</span>}
                </label>;
              })}</div>
            </fieldset>)}
            {search && !groups[0].items.length && <p className="py-4 text-center text-sm text-muted">没有匹配的标签</p>}
          </div>}
    {Object.values(errors).map(error => <p key={error} role="alert" className="text-sm text-accent">{error}</p>)}
    {onDone && <button type="button" aria-label={doneLabel} disabled={finishing || loading || failed || busy.size > 0 || Object.keys(errors).length > 0} onClick={onDone}
      className="min-h-11 w-full rounded-full bg-accent px-4 text-sm font-medium text-white disabled:opacity-50">{doneLabel}</button>}
  </section>;
}
