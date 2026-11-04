import { CaretLeftIcon, TrashIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { experienceApi, getHistorySettings, refreshHistorySettings, subscribeHistorySettings, type HistoryItem } from "../experienceApi";
import { usePrefs } from "../prefs";
import { BlurToggle, Cover, formatDuration, WatchedBar } from "../ui/Grid";
import { useLocked } from "../ui/privacy";
import { Sheet } from "../ui/Sheet";
import type { Open } from "./Library";

function dateLabel(seconds: number): string {
  const date = new Date(seconds * 1000), today = new Date(), yesterday = new Date(); yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return "今天";
  if (date.toDateString() === yesterday.toDateString()) return "昨天";
  return date.toLocaleDateString();
}

export function History({ onBack, onOpen }: { onBack: () => void; onOpen: Open }) {
  const settings = useSyncExternalStore(subscribeHistorySettings, getHistorySettings);
  const prefs = usePrefs(), locked = useLocked();
  const [items, setItems] = useState<HistoryItem[]>([]), [done, setDone] = useState(false), [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false), [settingsFailed, setSettingsFailed] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [confirm, setConfirm] = useState(false);
  const alive = useRef(true), mutating = useRef(false);
  const page = useRef({ controller: new AbortController(), offset: 0, busy: false, done: false });
  const reset = (finished = false) => {
    page.current.controller.abort(); page.current = { controller: new AbortController(), offset: 0, busy: false, done: finished };
    setItems([]); setDone(finished); setFailed(false); setLoading(false);
  };
  const load = async () => {
    const generation = page.current;
    if (generation.busy || generation.done || !alive.current) return;
    generation.busy = true; setLoading(true); setFailed(false);
    try {
      const result = await experienceApi.history(generation.offset, 30, generation.controller.signal);
      if (!alive.current || generation !== page.current) return;
      generation.offset += result.items.length;
      generation.done = !result.has_more || result.items.length === 0;
      setItems(list => [...list, ...result.items.filter(item => !list.some(x => x.id === item.id))]); setDone(generation.done);
    } catch { if (alive.current && generation === page.current) setFailed(true); }
    finally { generation.busy = false; if (alive.current && generation === page.current) setLoading(false); }
  };
  const loadSettings = async (signal?: AbortSignal) => {
    setSettingsFailed(false);
    try { await refreshHistorySettings(signal); }
    catch { if (alive.current && !signal?.aborted) setSettingsFailed(true); }
  };
  useEffect(() => {
    alive.current = true; const controller = new AbortController();
    if (page.current.controller.signal.aborted) reset();
    void loadSettings(controller.signal); void load();
    return () => { alive.current = false; controller.abort(); page.current.controller.abort(); };
  }, []);
  useEffect(() => { if (locked) setConfirm(false); }, [locked]);
  const mutate = async (action: "toggle" | "clear" | "remove", id?: string) => {
    if (mutating.current || locked) return;
    mutating.current = true; setBusy(true); setError("");
    try {
      if (action === "toggle") await experienceApi.setHistoryEnabled(!settings?.enabled);
      else await experienceApi.clearHistory(id);
      if (!alive.current) return;
      if (action === "clear") { reset(true); setConfirm(false); }
      if (action === "remove") { reset(); void load(); }
    } catch { if (alive.current) setError("未能保存更改，请重试。"); }
    finally { mutating.current = false; if (alive.current) setBusy(false); }
  };
  const groups = new Map<string, { item: HistoryItem; index: number }[]>();
  items.forEach((item, index) => { const label = dateLabel(item.seen_at); groups.set(label, [...groups.get(label) ?? [], { item, index }]); });
  return <main className="mx-auto min-h-dvh max-w-3xl px-3 pb-28 pt-[max(1rem,env(safe-area-inset-top))]">
    <header className="mb-4 flex items-center gap-2"><button type="button" aria-label="返回片库" onClick={onBack} className="grid size-11 shrink-0 place-items-center"><CaretLeftIcon size={22} /></button><h1 className="min-w-0 flex-1 text-2xl font-semibold">观看历史</h1><BlurToggle /></header>
    <div className="mb-4 rounded-xl bg-surface p-3">
      <div className="flex items-center justify-between gap-3"><span className="text-sm">记录观看历史</span><button type="button" role="switch" aria-label="记录观看历史" aria-checked={settings?.enabled ?? false} disabled={busy || !settings || settingsFailed} onClick={() => void mutate("toggle")} className="min-h-11 rounded-full bg-raised px-4 text-sm disabled:opacity-50">{settings?.enabled ? "已开启" : "已关闭"}</button></div>
      <p className="mt-1 text-xs leading-relaxed text-muted">观看记录仅保存在当前服务器，不进入云端备份。关闭记录会停止保存新的观看位置。</p>
      {settingsFailed && <button type="button" aria-label="重试历史设置" onClick={() => void loadSettings()} className="mt-2 min-h-11 text-sm text-accent">设置读取失败，点击重试</button>}
    </div>
    <button type="button" aria-label="清空观看历史" disabled={busy} onClick={() => { setError(""); setConfirm(true); }} className="mb-4 min-h-11 rounded-full bg-surface px-4 text-sm text-accent disabled:opacity-50">清空历史</button>
    {error && <p role="alert" className="mb-3 text-sm text-accent">{error}</p>}
    {[...groups].map(([label, entries]) => <section key={label} className="mb-6"><h2 className="mb-2 px-1 text-sm font-semibold">{label}</h2><div className="grid gap-2 sm:grid-cols-2">{entries.map(({ item, index }) => <div key={item.id} className="flex min-w-0 gap-2 rounded-xl bg-surface p-2">
      <button type="button" aria-label={`继续观看第 ${index + 1} 个视频`} onClick={() => onOpen(items, index, () => void load(), item.position_seconds)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
        <span className="relative aspect-video w-28 shrink-0 overflow-hidden rounded-lg bg-bg">{item.cover_url && <Cover src={item.cover_url} className={`size-full object-cover ${prefs.coverBlur ? "blur-xl scale-110" : ""}`} />}<WatchedBar seconds={item.position_seconds} duration={item.duration_seconds} /></span>
        <span className="min-w-0 text-sm"><span className="block">继续观看</span><span className="text-xs tabular-nums text-muted">{formatDuration(item.position_seconds) || "0:00"} / {formatDuration(item.duration_seconds)}</span></span>
      </button><button type="button" aria-label={`删除第 ${index + 1} 条历史`} disabled={busy} onClick={() => void mutate("remove", item.id)} className="grid size-11 shrink-0 place-items-center text-muted disabled:opacity-40"><TrashIcon size={19} /></button>
    </div>)}</div></section>)}
    {!items.length && done && <p className="py-16 text-center text-sm text-muted">还没有观看记录</p>}
    {failed ? <div role="alert" className="py-6 text-center"><button type="button" aria-label="重试历史列表" onClick={() => void load()} className="min-h-11 rounded-full bg-surface px-5 text-sm">加载失败，点击重试</button></div> : !done && <button type="button" aria-label="加载更多历史" disabled={loading || busy} onClick={() => void load()} className="mx-auto my-6 block min-h-11 rounded-full bg-surface px-5 text-sm disabled:opacity-50">{loading ? "正在读取历史…" : "加载更多"}</button>}
    <Sheet open={confirm && !locked} onClose={() => { if (!busy) setConfirm(false); }} title="清空观看历史？"><p className="px-3 py-2 text-sm leading-relaxed text-muted">所有观看记录和保存位置都会被清除，无法恢复。</p><div className="flex gap-2 p-2"><button type="button" disabled={busy} onClick={() => setConfirm(false)} className="min-h-11 flex-1 rounded-full bg-raised text-sm">取消</button><button type="button" aria-label="确认清空历史" disabled={busy} onClick={() => void mutate("clear")} className="min-h-11 flex-1 rounded-full bg-accent text-sm text-white disabled:opacity-50">{busy ? "正在清空…" : "清空历史"}</button></div></Sheet>
  </main>;
}
