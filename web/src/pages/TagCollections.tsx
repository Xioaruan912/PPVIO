import { MagnifyingGlassIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, Unauthorized, type Page, type Tag } from "../api";
import { Grid, usePages } from "../ui/Grid";
import { useLocked } from "../ui/privacy";
import type { Open } from "./Library";

const action = "h-10 rounded-full border border-line bg-surface px-4 text-[14px] font-medium text-ink shadow-[0_2px_8px_rgba(20,22,25,0.04)] hover:border-gold/50 hover:text-gold disabled:opacity-45";

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
  const [tags, setTags] = useState<Tag[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const locked = useLocked();
  const [visible, setVisible] = useState(() => !document.hidden);

  useEffect(() => {
    const change = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", change);
    return () => document.removeEventListener("visibilitychange", change);
  }, []);

  useEffect(() => {
    if (locked || !visible) return;
    const controller = new AbortController();
    setLoading(true);
    setFailed(false);
    void api.tags(controller.signal).then(result => {
      if (controller.signal.aborted) return;
      setTags(result.items);
      setSelected(id => id !== null && !result.items.some(tag => tag.id === id) ? null : id);
    }).catch(() => {
      if (!controller.signal.aborted) setFailed(true);
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [refresh, retry, locked, visible]);

  if (locked || !visible) return null;
  const matches = tags.filter(tag => tag.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));

  return (
    <main className="mx-auto flex h-full w-full max-w-7xl flex-col overflow-hidden px-4 pb-[max(0.85rem,env(safe-area-inset-bottom))] pt-3 sm:px-8 sm:pb-5 sm:pt-5">
      <header className="mb-3 flex shrink-0 flex-col gap-2.5 sm:flex-row sm:items-center sm:gap-3">
        <div className="flex items-center justify-between gap-2 sm:contents">
          <h1 className="text-[22px] font-semibold leading-none tracking-[-0.03em] text-ink sm:text-[28px]">标签收藏</h1>
          <button type="button" aria-label="管理标签" onClick={onManage} className={`${action} sm:order-3`}>管理标签</button>
        </div>
        <div className="relative w-full sm:order-2 sm:ml-auto sm:w-56">
          <MagnifyingGlassIcon size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input
            type="search"
            aria-label="搜索标签收藏"
            placeholder="筛选标签"
            value={query}
            onChange={event => setQuery(event.target.value)}
            className="h-9.5 w-full rounded-full border border-line bg-surface pl-9 pr-3.5 text-[14px] text-ink placeholder:text-faint shadow-[0_2px_8px_rgba(20,22,25,0.04)] outline-none focus:border-gold/55"
          />
        </div>
      </header>

      {notice}

      {/* Single horizontal tag selector strip — zero stacked card wall */}
      <div aria-label="标签分类" className="mb-3 flex shrink-0 items-center gap-2 overflow-x-auto [scrollbar-width:none]">
        <button
          type="button"
          aria-label="全部已归类"
          aria-pressed={selected === null}
          onClick={() => setSelected(null)}
          className={`h-9.5 shrink-0 rounded-full border px-4 text-[14px] transition-colors ${
            selected === null ? "border-gold bg-gold font-semibold text-white" : "border-line bg-surface text-ink hover:border-gold/45 hover:text-gold"
          }`}
        >
          全部
        </button>
        {matches.map(tag => (
          <button
            key={tag.id}
            type="button"
            aria-label={`打开标签 ${tag.name}`}
            aria-pressed={selected === tag.id}
            onClick={() => setSelected(tag.id)}
            className={`inline-flex h-9.5 shrink-0 items-center gap-2 rounded-full border px-4 text-[14px] transition-colors ${
              selected === tag.id ? "border-gold bg-gold font-semibold text-white" : "border-line bg-surface text-ink hover:border-gold/45 hover:text-gold"
            }`}
          >
            <span>{tag.name}</span>
            <span className={`tabular-nums text-[13px] ${selected === tag.id ? "text-white/75" : "text-muted"}`}>{tag.count}</span>
          </button>
        ))}
      </div>

      {loading && <p role="status" className="mb-2 shrink-0 text-[14px] text-muted">正在读取标签…</p>}
      {failed && (
        <div role="alert" className="mb-2 shrink-0">
          <button type="button" aria-label="重试标签列表" onClick={() => setRetry(value => value + 1)} className={action}>
            标签读取失败，点击重试
          </button>
        </div>
      )}
      {!loading && !failed && !matches.length && (
        <p className="mb-2 shrink-0 text-[14px] text-muted">{query.trim() ? "没有匹配的标签" : "还没有标签"}</p>
      )}

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <TagWall key={`${selected ?? "all"}:${refresh}`} tagId={selected} onOpen={onOpen} />
      </div>
    </main>
  );
}

function TagWall({ tagId, onOpen }: { tagId: number | null; onOpen: Open }) {
  const controller = useRef<AbortController | null>(null);
  const fetchPage = useCallback((_: string | null, offset: number) => tagCollectionAPI.list(tagId, offset, controller.current?.signal), [tagId]);
  const pages = usePages(fetchPage, String(tagId));
  useEffect(() => {
    controller.current = new AbortController();
    void pages.more();
    return () => controller.current?.abort();
  }, [pages.more]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {pages.done && !pages.items.length ? (
        <div className="grid min-h-0 flex-1 place-items-center text-[15px] text-muted">这里还没有视频</div>
      ) : (
        <Grid
          items={pages.items}
          done={pages.done}
          error={pages.error}
          onRetry={() => void pages.retry()}
          onEnd={() => void pages.more()}
          onOpen={(index, at) => onOpen(pages.items, index, () => void pages.more(), at)}
        />
      )}
      {!pages.done && !pages.error && (
        <button type="button" aria-label="加载更多标签收藏" onClick={() => void pages.more()} className="sr-only">
          加载更多
        </button>
      )}
    </div>
  );
}
