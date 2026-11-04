import { useEffect, useState } from "react";
import { useLocked } from "./privacy";

interface Filing { pending: number; moving: number; retrying: number; synced: number; unsupported: number; item?: { status: string; last_error: string | null; primary_tag_id: number | null } | null }
export function TagFilingNotice({ mediaId }: { mediaId?: string }) {
  const [state, setState] = useState<Filing | null>(null), [failed, setFailed] = useState(false), [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false), [visible, setVisible] = useState(!document.hidden);
  const locked = useLocked();
  useEffect(() => {
    const changed = () => setRevision(value => value + 1), visibility = () => setVisible(!document.hidden);
    window.addEventListener("ppvio:tags-changed", changed); document.addEventListener("visibilitychange", visibility);
    return () => { window.removeEventListener("ppvio:tags-changed", changed); document.removeEventListener("visibilitychange", visibility); };
  }, []);
  const path = mediaId ? `/api/v1/media/${mediaId}/tag-filing` : "/api/v1/tag-filing";
  useEffect(() => {
    if (locked || !visible) return;
    const controller = new AbortController(); let loading = false;
    const load = async () => {
      if (loading) return; loading = true;
      try {
        const response = await fetch(path, { credentials: "same-origin", signal: controller.signal });
        if (!response.ok) throw new Error();
        const value: Filing = await response.json();
        if (!controller.signal.aborted) { setState(value); setFailed(false); }
      } catch { if (!controller.signal.aborted) setFailed(true); }
      finally { loading = false; }
    };
    void load(); const timer = setInterval(() => void load(), 5000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [path, revision, locked, visible]);
  const retry = async () => {
    if (busy) return; setBusy(true);
    try {
      const response = await fetch(`${path}/retry`, { method: "POST", credentials: "same-origin" });
      if (!response.ok) throw new Error(); setRevision(value => value + 1);
    } catch { setFailed(true); }
    finally { setBusy(false); }
  };
  if (locked || !visible) return null;
  return <div className="mb-3 rounded-xl bg-surface px-3 py-2 text-xs leading-relaxed text-muted" role="status">
    {failed ? <button type="button" onClick={() => setRevision(value => value + 1)} className="min-h-10">文件归类状态读取失败，点击重试</button>
      : state ? <><span>{mediaId ? state.item?.status === "synced" ? "已移动到主标签目录" : state.item ? "文件正在按标签归类" : "标签选择后会移动到主标签目录" : `WebDAV归类：已完成 ${state.synced}，待完成 ${state.pending}${state.unsupported ? `，需处理 ${state.unsupported}` : ""}`}</span>
        {(state.retrying > 0 || state.unsupported > 0) && <button type="button" disabled={busy} onClick={() => void retry()} className="ml-3 min-h-10 text-accent disabled:opacity-40">{busy ? "提交中…" : "重试归类"}</button>}</> : "正在读取文件归类状态…"}
    <p>文件只放在一个主标签目录，其他标签用于检索。</p>
  </div>;
}
