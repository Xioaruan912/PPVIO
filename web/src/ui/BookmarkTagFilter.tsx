import { useEffect, useRef, useState } from "react";
import { api, type Tag } from "../api";
import { useLocked } from "./privacy";

export function BookmarkTagFilter({ value, onChange }: { value?: number; onChange: (id?: number) => void }) {
  const [tags, setTags] = useState<Tag[]>([]), [loading, setLoading] = useState(true), [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false), [retry, setRetry] = useState(0);
  const locked = useLocked(), [visible, setVisible] = useState(() => !document.hidden);
  const changed = useRef(onChange), catalogReady = useRef(false); changed.current = onChange;
  useEffect(() => {
    const change = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", change);
    return () => document.removeEventListener("visibilitychange", change);
  }, []);
  useEffect(() => {
    if (locked || !visible) return;
    const controller = new AbortController(); catalogReady.current = false; setLoading(true); setLoaded(false); setFailed(false);
    void api.tags(controller.signal).then(result => {
      if (!controller.signal.aborted) { catalogReady.current = true; setTags(result.items); setLoaded(true); }
    }).catch(() => { if (!controller.signal.aborted) setFailed(true); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => { catalogReady.current = false; controller.abort(); };
  }, [retry, locked, visible]);
  useEffect(() => {
    if (!locked && visible && loaded && catalogReady.current && value !== undefined && !tags.some(tag => tag.id === value)) changed.current(undefined);
  }, [value, tags, loaded, locked, visible]);
  if (locked || !visible) return null;
  return <div className="mb-4 min-w-0">
    <label className="flex min-h-11 min-w-0 items-center gap-3 text-sm text-muted">片段标签
      <select aria-label="片段标签" value={value ?? ""} disabled={loading || failed} onChange={event => changed.current(event.target.value ? Number(event.target.value) : undefined)}
        className="min-h-11 min-w-0 flex-1 rounded-lg bg-surface px-3 text-sm text-ink disabled:opacity-50">
        <option value="">全部标签</option>{tags.map(tag => <option key={tag.id} value={tag.id}>{tag.name}</option>)}
      </select>
    </label>
    {loading && <p role="status" className="mt-1 text-xs text-muted">正在读取片段标签…</p>}
    {failed && <div role="alert" className="mt-1 text-sm text-accent"><button type="button" aria-label="重试片段标签" onClick={() => setRetry(number => number + 1)} className="min-h-11 rounded-full bg-surface px-4">标签读取失败，点击重试</button></div>}
  </div>;
}
