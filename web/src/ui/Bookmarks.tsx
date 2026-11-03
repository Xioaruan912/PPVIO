import { BookmarkSimpleIcon, CaretLeftIcon, PlusIcon, TrashIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState, type RefObject } from "react";
import type { Media } from "../api";
import { mediaTools, type Bookmark } from "../mediaTools";
import { Sheet } from "./Sheet";
import { toast } from "./toast";
import { clock } from "./SeekPreview";
import { Cover } from "./Grid";
import { usePrefs } from "../prefs";
import { useLocked } from "./privacy";

export function BookmarkButton({ media, video, enabled }: { media: Media; video: RefObject<HTMLVideoElement | null>; enabled: boolean }) {
  const [open, setOpen] = useState(false), [name, setName] = useState(""), [items, setItems] = useState<Bookmark[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false), [failed, setFailed] = useState(false);
  const locked = useLocked();
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { setOpen(false); setName(""); }, [media.id, enabled, locked]);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController(); setFailed(false); setLoading(true);
    void mediaTools.bookmarks(media.id, controller.signal).then(r => { if (!controller.signal.aborted) setItems(r.items); }).catch(() => { if (!controller.signal.aborted) setFailed(true); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    const hidden = () => { if (document.hidden) setOpen(false); };
    document.addEventListener("visibilitychange", hidden);
    return () => { controller.abort(); document.removeEventListener("visibilitychange", hidden); };
  }, [open, media.id]);
  const add = async () => {
    const el = video.current;
    if (!el || busy || !enabled || locked) return;
    setBusy(true);
    try {
      const b = await mediaTools.addBookmark(media.id, el.currentTime, name);
      if (alive.current) { setItems(list => [...list.filter(x => x.id !== b.id), b].sort((a, b) => a.position_seconds - b.position_seconds)); setName(""); toast("已收藏当前时刻"); }
    } catch { if (alive.current) toast("书签未保存，请稍后重试"); }
    finally { if (alive.current) setBusy(false); }
  };
  const remove = async (b: Bookmark) => {
    try { await mediaTools.deleteBookmark(media.id, b.id); if (alive.current) setItems(list => list.filter(x => x.id !== b.id)); }
    catch { toast("书签删除失败，请重试"); }
  };
  return <>
    <button type="button" aria-label="片内书签" disabled={!enabled} onClick={() => setOpen(true)} className="grid size-11 place-items-center rounded-full text-white disabled:opacity-40"><BookmarkSimpleIcon size={26} /></button>
    <Sheet open={open && enabled && !locked} onClose={() => setOpen(false)} title="片内书签">
      <div className="mb-3 flex gap-2 px-2"><input aria-label="书签备注" placeholder="备注（可选）" maxLength={40} value={name} onChange={event => setName(event.target.value)} className="min-w-0 flex-1 rounded-lg bg-bg px-3 text-sm" />
        <button type="button" disabled={busy || loading} onClick={() => void add()} className="flex h-11 items-center gap-1 rounded-full bg-accent px-3 text-sm text-white disabled:opacity-50"><PlusIcon size={16} />收藏当前时刻</button></div>
      {failed && <p className="px-3 py-4 text-sm text-muted">书签加载失败，关闭后可重新打开。</p>}
      {loading && <p className="px-3 py-3 text-sm text-muted">正在读取书签…</p>}
      {!loading && !failed && !items.length && <p className="px-3 py-5 text-sm text-muted">记下想回来的位置，不需要给视频起名字。</p>}
      {items.map(b => <div key={b.id} className="flex items-center gap-2">
        <button type="button" aria-label={`跳到 ${clock(b.position_seconds)}`} onClick={() => { if (video.current) video.current.currentTime = b.position_seconds; setOpen(false); }} className="min-w-0 flex-1 rounded-lg px-3 py-3 text-left text-sm active:bg-raised"><span className="mr-3 tabular-nums text-accent">{clock(b.position_seconds)}</span>{b.name || "收藏的片段"}</button>
        <button type="button" aria-label={`删除 ${clock(b.position_seconds)} 书签`} onClick={() => void remove(b)} className="grid size-11 place-items-center text-muted"><TrashIcon size={18} /></button>
      </div>)}
    </Sheet>
  </>;
}

export function BookmarkWall({ onBack, onOpen }: { onBack: () => void; onOpen: (media: Media, at: number) => void }) {
  const [items, setItems] = useState<(Bookmark & { media: Media })[]>([]), [done, setDone] = useState(false), [failed, setFailed] = useState(false);
  const prefs = usePrefs();
  const busy = useRef(false), alive = useRef(true), offset = useRef(0);
  const load = async () => {
    if (busy.current) return;
    busy.current = true; setFailed(false);
    try { const page = await mediaTools.allBookmarks(offset.current); if (!alive.current) return; offset.current += page.items.length; setItems(list => [...list, ...page.items.filter(b => !list.some(x => x.id === b.id))]); setDone(!page.has_more); }
    catch { if (alive.current) setFailed(true); }
    finally { busy.current = false; }
  };
  useEffect(() => { alive.current = true; void load(); return () => { alive.current = false; }; }, []);
  return <main className="mx-auto min-h-dvh max-w-3xl px-3 pb-24 pt-[max(1rem,env(safe-area-inset-top))]">
    <header className="mb-4 flex items-center gap-3"><button type="button" aria-label="返回片库" onClick={onBack} className="grid size-11 place-items-center"><CaretLeftIcon size={22} /></button><h1 className="text-2xl font-semibold">收藏的片段</h1></header>
    {!items.length && !failed && <p className="py-16 text-center text-sm text-muted">{done ? "还没有片内书签，在播放器中收藏一个时刻即可。" : "正在读取片段…"}</p>}
    <div className="grid gap-2 sm:grid-cols-2">{items.map(b => <div key={b.id} className="flex gap-3 rounded-xl bg-surface p-2">
      <button type="button" onClick={() => onOpen(b.media, b.position_seconds)} className="flex min-w-0 flex-1 items-center gap-3 text-left" aria-label={`播放 ${b.name || clock(b.position_seconds)} 片段`}>
        <div className="aspect-video w-28 shrink-0 overflow-hidden rounded-lg bg-black">{b.media.cover_url && <Cover src={b.media.cover_url} className={`size-full object-cover ${prefs.coverBlur ? "blur-xl scale-110" : ""}`} />}</div>
        <span className="min-w-0 text-sm"><span className="block truncate">{b.name || "收藏的片段"}</span><span className="text-accent">{clock(b.position_seconds)}</span></span>
      </button>
      <button type="button" aria-label="删除片段书签" onClick={() => void mediaTools.deleteBookmark(b.media_id, b.id).then(() => { setItems(list => list.filter(x => x.id !== b.id)); offset.current = Math.max(0, offset.current - 1); }).catch(() => toast("删除失败，请重试"))} className="grid size-10 shrink-0 place-items-center text-muted"><TrashIcon size={18} /></button>
    </div>)}</div>
    {failed ? <button type="button" onClick={() => void load()} className="mx-auto my-8 block rounded-full bg-surface px-5 py-3 text-sm">读取失败，点击重试</button>
      : !done && <button type="button" onClick={() => void load()} className="mx-auto my-6 block rounded-full bg-surface px-5 py-3 text-sm">加载更多片段</button>}
  </main>;
}
