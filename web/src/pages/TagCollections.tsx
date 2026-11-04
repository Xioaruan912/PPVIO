import { useCallback, useEffect, useRef, useState } from "react";
import { api, Unauthorized, type Page, type Tag } from "../api";
import { BlurToggle, Grid, usePages } from "../ui/Grid";
import { useLocked } from "../ui/privacy";
import type { Open } from "./Library";

const action = "min-h-11 rounded-full bg-surface px-4 text-sm disabled:opacity-50";

export const tagCollectionAPI = {
  async list(tagId: number | null, offset = 0, signal?: AbortSignal): Promise<Page> {
    const query = new URLSearchParams({ offset: String(offset), limit: "20" });
    if (tagId !== null) query.set("tag_id", String(tagId));
    const response = await fetch(`/api/v1/tag-collections?${query}`, { credentials: "same-origin", signal });
    if (response.status === 401) throw new Unauthorized();
    if (!response.ok) throw new Error(`标签收藏读取失败 (${response.status})`);
    return response.json() as Promise<Page>;
  },
};

export function TagCollections({ onOpen, onManage, refresh = 0, notice }: {
  onOpen: Open; onManage: () => void; refresh?: number; notice?: React.ReactNode;
}) {
  const [tags, setTags] = useState<Tag[]>([]), [selected, setSelected] = useState<number | null>(null), [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true), [failed, setFailed] = useState(false), [retry, setRetry] = useState(0);
  const locked = useLocked(), [visible, setVisible] = useState(() => !document.hidden);
  useEffect(() => {
    const change = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", change);
    return () => document.removeEventListener("visibilitychange", change);
  }, []);
  useEffect(() => {
    if (locked || !visible) return;
    const controller = new AbortController();
    setLoading(true); setFailed(false);
    void api.tags(controller.signal).then(result => {
      if (controller.signal.aborted) return;
      setTags(result.items);
      setSelected(id => id !== null && !result.items.some(tag => tag.id === id) ? null : id);
    }).catch(() => { if (!controller.signal.aborted) setFailed(true); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [refresh, retry, locked, visible]);
  if (locked || !visible) return null;
  const matches = tags.filter(tag => tag.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const title = tags.find(tag => tag.id === selected)?.name ?? "全部已归类";
  return <main className="mx-auto min-h-dvh max-w-6xl px-3 pb-32 pt-[max(1.25rem,env(safe-area-inset-top))]">
    <header className="mb-4 flex min-w-0 items-center gap-2 px-1"><h1 className="min-w-0 flex-1 text-[26px] font-semibold tracking-tight">标签收藏</h1>
      <button type="button" aria-label="管理标签" onClick={onManage} className="min-h-11 shrink-0 rounded-full bg-surface px-3 text-sm">管理标签</button><BlurToggle />
    </header>
    {notice}
    <input type="search" aria-label="搜索标签收藏" placeholder="搜索标签" value={query} onChange={event => setQuery(event.target.value)}
      className="mb-3 min-h-11 w-full min-w-0 rounded-lg bg-surface px-3 text-sm" />
    <div aria-label="标签分类" className="mb-5 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
      <button type="button" aria-label="全部已归类" aria-pressed={selected === null} onClick={() => setSelected(null)}
        className={`min-h-14 rounded-xl px-3 py-2 text-left text-sm ${selected === null ? "bg-accent font-semibold text-white" : "bg-surface"}`}>全部已归类</button>
      {matches.map(tag => <button key={tag.id} type="button" aria-label={`打开标签 ${tag.name}`} aria-pressed={selected === tag.id} onClick={() => setSelected(tag.id)}
        className={`flex min-h-14 min-w-0 items-center gap-2 rounded-xl px-3 py-2 text-left text-sm ${selected === tag.id ? "bg-accent text-white" : "bg-surface"}`}>
        <span className="min-w-0 flex-1 break-words">{tag.name}</span><span className="shrink-0 text-xs tabular-nums opacity-75">{tag.count}</span>
      </button>)}
    </div>
    {loading && <p role="status" className="mb-4 text-center text-sm text-muted">正在读取标签…</p>}
    {failed && <div role="alert" className="mb-4 text-sm text-accent"><button type="button" aria-label="重试标签列表" onClick={() => setRetry(value => value + 1)} className={action}>标签读取失败，点击重试</button></div>}
    {!loading && !failed && !matches.length && <p className="mb-5 text-center text-sm text-muted">{query.trim() ? "没有匹配的标签" : "还没有标签，请先管理标签或在视频中选择标签。"}</p>}
    <h2 className="mb-3 px-1 text-base font-semibold">{title}</h2>
    <TagWall key={`${selected ?? "all"}:${refresh}`} tagId={selected} onOpen={onOpen} />
  </main>;
}

function TagWall({ tagId, onOpen }: { tagId: number | null; onOpen: Open }) {
  const controller = useRef<AbortController | null>(null);
  const fetchPage = useCallback((_: string | null, offset: number) => tagCollectionAPI.list(tagId, offset, controller.current?.signal), [tagId]);
  const pages = usePages(fetchPage, String(tagId));
  useEffect(() => {
    controller.current = new AbortController(); void pages.more();
    return () => controller.current?.abort();
  }, [pages.more]);
  return <>
    {pages.done && !pages.items.length ? <p className="py-16 text-center text-sm text-muted">这里还没有视频。播放时点“标签收藏”即可归类。</p>
      : <Grid items={pages.items} done={pages.done} error={pages.error} onRetry={() => void pages.retry()} onEnd={() => void pages.more()}
        onOpen={(index, at) => onOpen(pages.items, index, () => void pages.more(), at)} />}
    {!pages.done && !pages.error && <button type="button" aria-label="加载更多标签收藏" onClick={() => void pages.more()} className={`${action} mx-auto my-6 block`}>加载更多</button>}
  </>;
}
