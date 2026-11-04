import { CaretLeftIcon, CaretRightIcon, PencilSimpleIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Media, type Tag } from "../api";
import { defaultChannelFilters, experienceApi, type Channel, type ChannelFilters } from "../experienceApi";
import { BlurToggle, Grid, usePages } from "../ui/Grid";
import { useLocked } from "../ui/privacy";
import { Sheet } from "../ui/Sheet";
import type { Open } from "./Library";

const field = "min-h-11 w-full min-w-0 rounded-lg bg-bg px-3 text-sm disabled:opacity-50";
const action = "min-h-11 rounded-full bg-raised px-4 text-sm disabled:opacity-50";
const premiumFilters = { ...defaultChannelFilters(), premium_only: true };

export function Channels({ onBack, onOpen, premiumOnly = false, onPlayQueue }: { onBack: () => void; onOpen: Open; premiumOnly?: boolean; onPlayQueue?: (items: Media[]) => void }) {
  const [channels, setChannels] = useState<Channel[]>([]), [tags, setTags] = useState<Tag[]>([]);
  const [selected, setSelected] = useState<string | null>(premiumOnly ? "premium" : null);
  const [editor, setEditor] = useState<Channel | "new" | null>(null), [deleting, setDeleting] = useState(false);
  const [loading, setLoading] = useState(false), [failed, setFailed] = useState(false), [tagsFailed, setTagsFailed] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const alive = useRef(true), mutation = useRef(false), generation = useRef(0), locked = useLocked();
  const load = async () => {
    const version = ++generation.current; setLoading(true); setFailed(false); setTagsFailed(false);
    const [list, tagList] = await Promise.allSettled([experienceApi.channels(), api.tags()]);
    if (!alive.current || generation.current !== version) return;
    if (list.status === "fulfilled") setChannels(list.value.items); else setFailed(true);
    if (tagList.status === "fulfilled") setTags(tagList.value.items); else setTagsFailed(true);
    setLoading(false);
  };
  useEffect(() => { alive.current = true; if (!premiumOnly) void load(); return () => { alive.current = false; ++generation.current; }; }, [premiumOnly]);
  useEffect(() => { setSelected(premiumOnly ? "premium" : null); }, [premiumOnly]);
  useEffect(() => { if (locked && !busy) { setEditor(null); setDeleting(false); } }, [locked, busy]);
  const current = channels.find(channel => channel.id === selected);
  const closeEditor = () => { if (!mutation.current) { setEditor(null); setDeleting(false); setError(""); } };
  const save = async (name: string, filters: ChannelFilters) => {
    if (!editor || mutation.current || locked) return;
    mutation.current = true; ++generation.current; setLoading(false); setBusy(true); setError("");
    try {
      const saved = editor === "new" ? await experienceApi.createChannel(name, filters) : await experienceApi.updateChannel(editor.id, name, filters);
      if (!alive.current) return;
      setChannels(list => [...list.filter(channel => channel.id !== saved.id), saved]); setEditor(null);
    } catch { if (alive.current) setError("频道未保存，请检查名称和筛选条件后重试。"); }
    finally { mutation.current = false; if (alive.current) setBusy(false); }
  };
  const remove = async () => {
    if (!editor || editor === "new" || mutation.current || locked) return;
    mutation.current = true; ++generation.current; setLoading(false); setBusy(true); setError(""); const id = editor.id;
    try {
      await experienceApi.deleteChannel(id);
      if (!alive.current) return;
      setChannels(list => list.filter(channel => channel.id !== id)); if (selected === id) setSelected(null); setEditor(null); setDeleting(false);
    } catch { if (alive.current) setError("频道删除失败，请重试。"); }
    finally { mutation.current = false; if (alive.current) setBusy(false); }
  };
  const browsing = selected === "premium" || !!current;
  return <main className="mx-auto min-h-dvh max-w-6xl px-3 pb-28 pt-[max(1rem,env(safe-area-inset-top))]">
    <header className="mb-4 flex items-center gap-2"><button type="button" aria-label={browsing && !premiumOnly ? "返回频道列表" : "返回片库"} onClick={() => browsing && !premiumOnly ? setSelected(null) : onBack()} className="grid size-11 shrink-0 place-items-center"><CaretLeftIcon size={22} /></button><h1 className="min-w-0 flex-1 truncate text-2xl font-semibold">{selected === "premium" ? "精品" : current?.name ?? "筛选频道"}</h1>{current && <button type="button" aria-label={`编辑频道 ${current.name}`} onClick={() => { setError(""); setEditor(current); }} className="grid size-11 shrink-0 place-items-center"><PencilSimpleIcon size={20} /></button>}<BlurToggle /></header>
    {browsing ? <ChannelWall key={`${selected}:${JSON.stringify(current?.filters)}`} channel={current} onOpen={onOpen} onPlayQueue={onPlayQueue} /> : <>
      <p className="mb-4 px-1 text-sm leading-relaxed text-muted">保存筛选条件，新加入的视频会自动进入符合条件的频道。</p>
      <div className="mb-4 flex flex-wrap gap-2"><button type="button" aria-label="新建频道" disabled={loading || failed || channels.length >= 30} onClick={() => { setError(""); setEditor("new"); }} className={action}>新建频道</button><button type="button" aria-label="浏览精品" onClick={() => setSelected("premium")} className={action}>精品</button><span className="self-center text-xs text-muted">{channels.length} / 30</span></div>
      {loading && <p role="status" className="py-12 text-center text-sm text-muted">正在读取频道…</p>}
      {(failed || tagsFailed) && <div role="alert" className="mb-4 text-sm text-accent"><button type="button" aria-label="重试频道列表" onClick={() => void load()} className={action}>频道或标签读取失败，点击重试</button></div>}
      {channels.map(channel => <div key={channel.id} className="mb-2 flex min-w-0 items-center rounded-xl bg-surface p-1"><button type="button" aria-label={`打开频道 ${channel.name}`} onClick={() => setSelected(channel.id)} className="flex min-h-14 min-w-0 flex-1 items-center gap-3 px-3 text-left"><span className="min-w-0 flex-1 truncate text-sm">{channel.name}</span><CaretRightIcon size={18} className="shrink-0 text-muted" /></button><button type="button" aria-label={`编辑频道 ${channel.name}`} onClick={() => { setError(""); setEditor(channel); }} className="grid size-11 shrink-0 place-items-center text-muted"><PencilSimpleIcon size={19} /></button></div>)}
      {!loading && !failed && !channels.length && <p className="py-16 text-center text-sm text-muted">还没有保存的频道</p>}
    </>}
    <Sheet open={!!editor && !locked} onClose={closeEditor} title={deleting ? "删除频道？" : editor === "new" ? "新建频道" : "编辑频道"}>
      {editor && (deleting && editor !== "new" ? <><p className="px-3 py-3 text-sm text-muted">删除“{editor.name}”的筛选条件，不会删除视频。</p>{error && <p role="alert" className="px-3 text-sm text-accent">{error}</p>}<div className="flex gap-2 p-2"><button type="button" disabled={busy} onClick={() => setDeleting(false)} className={`${action} flex-1`}>取消</button><button type="button" aria-label="确认删除频道" disabled={busy} onClick={() => void remove()} className="min-h-11 flex-1 rounded-full bg-accent text-sm text-white disabled:opacity-50">删除频道</button></div></> : <ChannelEditor key={editor === "new" ? "new" : editor.id} channel={editor === "new" ? undefined : editor} tags={tags} tagsFailed={tagsFailed} busy={busy} error={error} onSave={save} onClose={closeEditor} onDelete={() => { setError(""); setDeleting(true); }} />)}
    </Sheet>
  </main>;
}

function ChannelWall({ channel, onOpen, onPlayQueue }: { channel?: Channel; onOpen: Open; onPlayQueue?: (items: Media[]) => void }) {
  const fetchPage = useCallback((_: string | null, offset: number) => channel ? experienceApi.channelItems(channel.id, offset) : experienceApi.queryChannel(premiumFilters, offset), [channel]);
  const pages = usePages(fetchPage, channel?.id ?? "premium");
  useEffect(() => { void pages.more(); }, [pages.more]);
  return <>{onPlayQueue && pages.items.length > 0 && <button type="button" aria-label="播放频道队列" onClick={() => onPlayQueue(pages.items.slice(0, 100))} className={`${action} mb-4`}>播放已加载视频</button>}
    {pages.done && !pages.items.length ? <p className="py-16 text-center text-sm text-muted">暂时没有符合条件的视频</p> : <Grid items={pages.items} done={pages.done} error={pages.error} onRetry={() => void pages.retry()} onEnd={() => void pages.more()} onOpen={(index, at) => onOpen(pages.items, index, () => void pages.more(), at)} />}
    {!pages.done && !pages.error && <button type="button" aria-label="加载更多频道视频" onClick={() => void pages.more()} className={`${action} mx-auto my-6 block`}>加载更多</button>}
  </>;
}

function ChannelEditor({ channel, tags, tagsFailed, busy, error, onSave, onClose, onDelete }: { channel?: Channel; tags: Tag[]; tagsFailed: boolean; busy: boolean; error: string; onSave: (name: string, filters: ChannelFilters) => void; onClose: () => void; onDelete: () => void }) {
  const [name, setName] = useState(channel?.name ?? ""), [filters, setFilters] = useState<ChannelFilters>(() => ({ ...defaultChannelFilters(), ...channel?.filters }));
  const [minimum, setMinimum] = useState(channel?.filters.min_seconds?.toString() ?? ""), [maximum, setMaximum] = useState(channel?.filters.max_seconds?.toString() ?? "");
  const [invalid, setInvalid] = useState("");
  const set = <K extends keyof ChannelFilters>(key: K, value: ChannelFilters[K]) => setFilters(previous => ({ ...previous, [key]: value }));
  const toggle = (key: "include_tags" | "exclude_tags", id: number) => set(key, filters[key].includes(id) ? filters[key].filter(value => value !== id) : [...filters[key], id]);
  const submit = () => {
    const min = minimum.trim() === "" ? null : Number(minimum), max = maximum.trim() === "" ? null : Number(maximum);
    if (!name.trim() || name.trim().length > 60) { setInvalid("频道名称需为 1–60 个字符。"); return; }
    if ([min, max].some(value => value !== null && (!Number.isFinite(value) || value < 0 || value >= 2 ** 53)) || (min !== null && max !== null && min > max)) { setInvalid("请输入有效时长，最短时长不能超过最长时长。"); return; }
    setInvalid(""); onSave(name.trim(), { ...filters, include_tags: filters.include_tags.filter(id => !filters.exclude_tags.includes(id)), min_seconds: min, max_seconds: max });
  };
  return <div className="space-y-3 px-2 pb-2"><fieldset disabled={busy} className="min-w-0 space-y-3 disabled:opacity-60"><label className="block text-xs text-muted">频道名称<input aria-label="频道名称" autoFocus maxLength={60} value={name} onChange={event => setName(event.target.value)} className={`${field} mt-1`} /></label>
    {(["include_tags", "exclude_tags"] as const).map(key => <fieldset key={key} className="min-w-0"><legend className="mb-1 text-xs text-muted">{key === "include_tags" ? "包含标签" : "排除标签"}（{filters[key].length}/20）</legend><div className="flex max-h-36 flex-wrap gap-1 overflow-y-auto">{tags.map(tag => <label key={tag.id} className="flex min-h-11 max-w-full items-center gap-2 rounded-lg bg-bg px-3 text-sm"><input type="checkbox" aria-label={`${key === "include_tags" ? "包含标签" : "排除标签"} ${tag.name}`} checked={filters[key].includes(tag.id)} disabled={!filters[key].includes(tag.id) && filters[key].length >= 20} onChange={() => toggle(key, tag.id)} /><span className="truncate">{tag.name}</span></label>)}</div></fieldset>)}
    <p className="text-xs text-muted">排除标签优先；未选包含标签时匹配所有视频。</p>
    <div className="grid grid-cols-2 gap-3"><label className="text-xs text-muted">标签匹配<select aria-label="标签匹配" value={filters.match} onChange={event => set("match", event.target.value as ChannelFilters["match"])} className={`${field} mt-1`}><option value="all">同时包含（AND）</option><option value="any">包含任一（OR）</option></select></label><label className="text-xs text-muted">观看状态<select aria-label="观看状态" value={filters.watched} onChange={event => set("watched", event.target.value as ChannelFilters["watched"])} className={`${field} mt-1`}><option value="all">全部</option><option value="unwatched">未看</option><option value="watched">看过</option></select></label>
    <label className="text-xs text-muted">最短时长（秒）<input aria-label="最短时长（秒）" type="number" min={0} value={minimum} onChange={event => setMinimum(event.target.value)} placeholder="不限" className={`${field} mt-1`} /></label><label className="text-xs text-muted">最长时长（秒）<input aria-label="最长时长（秒）" type="number" min={0} value={maximum} onChange={event => setMaximum(event.target.value)} placeholder="不限" className={`${field} mt-1`} /></label>
    <label className="text-xs text-muted">视频分类<select aria-label="视频分类" value={filters.category} onChange={event => set("category", event.target.value as ChannelFilters["category"])} className={`${field} mt-1`}><option value="all">全部</option><option value="short">短视频</option><option value="long">长视频</option></select></label><label className="text-xs text-muted">排序<select aria-label="频道排序" value={filters.sort} onChange={event => set("sort", event.target.value as ChannelFilters["sort"])} className={`${field} mt-1`}><option value="newest">最新</option><option value="longest">时长最长</option><option value="largest">体积最大</option><option value="random">随机</option></select></label></div>
    <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" aria-label="只看精品" checked={filters.premium_only} onChange={event => set("premium_only", event.target.checked)} />只看精品</label>
  </fieldset>{(error || invalid || tagsFailed) && <p role="alert" className="text-sm text-accent">{invalid || error || "标签未读取，请关闭后重试读取频道。"}</p>}<div className="flex gap-2"><button type="button" disabled={busy} onClick={onClose} className={`${action} flex-1`}>取消</button><button type="button" aria-label="保存频道" disabled={busy || tagsFailed || !name.trim()} onClick={submit} className="min-h-11 flex-1 rounded-full bg-accent text-sm text-white disabled:opacity-50">{busy ? "正在保存…" : "保存频道"}</button></div>{channel && <button type="button" aria-label="删除频道" disabled={busy} onClick={onDelete} className="min-h-11 w-full text-sm text-accent disabled:opacity-50">删除频道</button>}</div>;
}
