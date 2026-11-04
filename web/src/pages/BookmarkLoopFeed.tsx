import { useCallback, useEffect, useRef, useState } from "react";
import type { Media } from "../api";
import { mediaTools } from "../mediaTools";
import { Centered, ClipList } from "../feed/Feed";

export function BookmarkLoopFeed({ onClose, tagId }: { onClose: () => void; tagId?: number }) {
  const [items, setItems] = useState<Media[]>([]), [failed, setFailed] = useState(false), [done, setDone] = useState(false);
  const current = useRef<{ controller: AbortController; offset: number; busy: boolean; done: boolean } | null>(null);
  const load = useCallback(async () => {
    const page = current.current;
    if (!page || page.busy || page.done) return;
    page.busy = true; setFailed(false);
    try {
      const result = await mediaTools.allBookmarks(page.offset, page.controller.signal, tagId);
      if (current.current !== page || page.controller.signal.aborted) return;
      page.offset += result.items.length; page.done = !result.has_more || !result.items.length;
      setDone(page.done);
      setItems(previous => {
        const seen = new Set(previous.map(item => item.clip?.key));
        return [...previous, ...result.items.filter(b => !seen.has(b.id)).map(b => ({ ...b.media,
          clip: { key: b.id, start: b.position_seconds, end: b.end_seconds } }))];
      });
    } catch { if (current.current === page && !page.controller.signal.aborted) setFailed(true); }
    finally { page.busy = false; }
  }, [tagId]);
  useEffect(() => {
    const page = { controller: new AbortController(), offset: 0, busy: false, done: false }; current.current = page;
    void load();
    return () => { page.controller.abort(); if (current.current === page) current.current = null; };
  }, [load]);
  return <div className="fixed inset-0 z-30 bg-black">
    {items.length > 0 ? <ClipList items={items} setItems={setItems} onClose={onClose} onNearEnd={load} />
      : <Centered><div><p className="mb-4">{failed ? "片段读取失败" : done ? "还没有书签，可在播放器中收藏片段。" : "正在读取片段…"}</p>{failed && <button type="button" className="min-h-11 px-4 text-accent" onClick={() => void load()}>重试</button>}<button type="button" className="min-h-11 px-4 text-white" onClick={onClose}>返回片段</button></div></Centered>}
    {failed && items.length > 0 && <button type="button" onClick={() => void load()} className="fixed right-3 top-4 z-20 min-h-11 rounded-full bg-black/70 px-4 text-sm text-white">更多片段读取失败，重试</button>}
  </div>;
}
