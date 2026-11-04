import { useEffect, useRef, useState } from "react";
import { api, type Tag } from "../api";
import { mediaTools, type Bookmark } from "../mediaTools";
import { useLocked } from "./privacy";

const action = "min-h-11 rounded-full bg-raised px-4 text-sm disabled:opacity-50";

export function BookmarkEditor({ bookmark, onSaved, onClose }: {
  bookmark: Bookmark; onSaved: (bookmark: Bookmark) => void; onClose: () => void;
}) {
  const locked = useLocked(), [visible, setVisible] = useState(() => !document.hidden);
  const close = useRef(onClose); close.current = onClose;
  useEffect(() => {
    const change = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", change);
    return () => document.removeEventListener("visibilitychange", change);
  }, []);
  useEffect(() => { if (locked || !visible) close.current(); }, [locked, visible]);
  return locked || !visible ? null : <BookmarkForm key={`${bookmark.media_id}:${bookmark.id}`} bookmark={bookmark} onSaved={onSaved} onClose={onClose} />;
}

function BookmarkForm({ bookmark, onSaved, onClose }: {
  bookmark: Bookmark; onSaved: (bookmark: Bookmark) => void; onClose: () => void;
}) {
  const [name, setName] = useState(bookmark.name ?? ""), [selected, setSelected] = useState(() => [...new Set(bookmark.tag_ids ?? [])]);
  const [tags, setTags] = useState<Tag[]>([]), [loading, setLoading] = useState(true), [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const alive = useRef(false), mutation = useRef(false), read = useRef<AbortController | null>(null);
  const callbacks = useRef({ onSaved, onClose }); callbacks.current = { onSaved, onClose };
  const load = async () => {
    read.current?.abort(); const controller = new AbortController(); read.current = controller;
    setLoading(true); setFailed(false);
    try {
      const result = await api.tags(controller.signal);
      if (!alive.current || controller.signal.aborted) return;
      setTags(result.items); setSelected(ids => ids.filter(id => result.items.some(tag => tag.id === id)));
    } catch { if (alive.current && !controller.signal.aborted) setFailed(true); }
    finally { if (alive.current && !controller.signal.aborted) setLoading(false); }
  };
  useEffect(() => {
    alive.current = true; void load();
    return () => { alive.current = false; read.current?.abort(); };
  }, [bookmark.media_id, bookmark.id]);

  const save = async () => {
    if (!alive.current || mutation.current || loading || failed || document.hidden) return;
    const remark = name.trim();
    if (remark.length > 40) { setError("片段备注最多 40 个字符。"); return; }
    if (selected.length > 20) { setError("每个片段最多选择 20 个标签。"); return; }
    mutation.current = true; setBusy(true); setError("");
    try {
      const updated = await mediaTools.updateBookmark(bookmark.media_id, bookmark.id, { name: remark, tag_ids: selected });
      if (!alive.current || document.hidden) return;
      if (updated.id !== bookmark.id || updated.media_id !== bookmark.media_id) throw new Error("片段已切换，请重新打开编辑。");
      callbacks.current.onSaved(updated); callbacks.current.onClose();
    } catch { if (alive.current && !document.hidden) setError("片段未保存，备注和标签已保留，请重试。"); }
    finally { mutation.current = false; if (alive.current) setBusy(false); }
  };
  const toggle = (id: number, checked: boolean) => setSelected(ids => checked ? ids.length < 20 ? [...ids, id] : ids : ids.filter(value => value !== id));
  return <form aria-label="编辑片段" onSubmit={event => { event.preventDefault(); void save(); }} className="min-w-0 space-y-3 px-3 pb-2">
    <fieldset disabled={busy} className="min-w-0 space-y-3 disabled:opacity-60">
      <label className="block text-xs text-muted">片段备注<input aria-label="片段备注" maxLength={40} value={name} onChange={event => setName(event.target.value)} placeholder="备注（可选）"
        className="mt-1 min-h-11 w-full min-w-0 rounded-lg bg-bg px-3 text-sm text-ink" /></label>
      <fieldset className="min-w-0"><legend className="mb-1 text-xs text-muted">片段标签（{selected.length}/20）</legend>
        {loading ? <p role="status" className="py-4 text-sm text-muted">正在读取标签…</p> : failed ? <div role="alert"><button type="button" aria-label="重试片段编辑标签" onClick={() => void load()} className={action}>标签读取失败，点击重试</button></div>
          : tags.length ? <div className="flex max-h-60 flex-wrap gap-1.5 overflow-y-auto">{tags.map(tag => <label key={tag.id} className="flex min-h-11 max-w-full items-center gap-2 rounded-lg bg-bg px-3 text-sm">
            <input type="checkbox" aria-label={`片段标签 ${tag.name}`} checked={selected.includes(tag.id)} disabled={!selected.includes(tag.id) && selected.length >= 20}
              onChange={event => toggle(tag.id, event.target.checked)} className="shrink-0 accent-accent" /><span className="min-w-0 break-words">{tag.name}</span>
          </label>)}</div> : <p className="py-4 text-sm text-muted">还没有标签，可先保存备注。</p>}
      </fieldset>
    </fieldset>
    {error && <p role="alert" className="text-sm text-accent">{error}</p>}
    <div className="flex gap-2"><button type="button" aria-label="取消编辑片段" disabled={busy} onClick={() => { if (!mutation.current) callbacks.current.onClose(); }} className={`${action} flex-1`}>取消</button>
      <button type="submit" aria-label="保存片段" disabled={busy || loading || failed} className="min-h-11 flex-1 rounded-full bg-accent px-4 text-sm text-white disabled:opacity-50">{busy ? "正在保存…" : "保存片段"}</button></div>
  </form>;
}
