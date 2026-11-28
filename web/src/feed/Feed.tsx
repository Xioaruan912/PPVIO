import { ArrowRightIcon, CaretLeftIcon, TrashIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { api, chooseStream, Unauthorized, type Media } from "../api";
import { usePrefs } from "../prefs";
import { hydrateMediaRatings } from "../ratings";
import { useLocked } from "../ui/privacy";
import { announce, subscribeMediaChanges } from "../ui/Grid";
import { toast } from "../ui/toast";
import { FeedItem } from "./FeedItem";
import type { BufferReadiness } from "./useFeedPlayback";
import { curationApi } from "../curationApi";
import { QuickTagPanel } from "../ui/QuickTags";
import { ensureGsap, gsap } from "../ui/gsap";
import { prewarmMedia } from "../ui/prewarm";

/** Append new clips, never one already in the list. */
export function mergeFeed(current: Media[], incoming: Media[]): Media[] {
  const seen = new Set(current.map(item => item.id));
  return [...current, ...incoming.filter(item => !seen.has(item.id) && seen.add(item.id))];
}

/**
 * Direction A — Darkroom Horizontal Folio Player:
 * - Strict left/right horizontal paging (zero vertical scrolling!)
 * - 100% unobstructed video aperture; all controls live cleanly outside the video frame
 * - Direct 1-tap 5-star rating & taste-ranked lookahead prewarming
 */
export function ClipList({
  items, setItems, start = 0, onNearEnd, onClose, onRefresh,
  organize = false, onToggleOrganize, preferencesTrigger,
  enabled = true, startAt,
}: {
  items: Media[];
  setItems: (update: (list: Media[]) => Media[]) => void;
  start?: number;
  onNearEnd?: () => void;
  onClose?: () => void;
  onRefresh?: () => void;
  organize?: boolean;
  onToggleOrganize?: () => void;
  preferencesTrigger?: ReactNode;
  enabled?: boolean;
  startAt?: number;
}) {
  ensureGsap();
  const [active, setActive] = useState(start);
  const container = useRef<HTMLDivElement>(null);
  const prefs = usePrefs();
  const locked = useLocked();

  useEffect(() => {
    hydrateMediaRatings(items);
  }, [items]);

  useEffect(
    () => subscribeMediaChanges(change => setItems(list => "removed" in change
      ? list.filter(item => item.id !== change.id)
      : list.map(item => item.id === change.id ? { ...item, ...change } : item))),
    [setItems],
  );

  const [preloadFor, setPreloadFor] = useState<{ id: string; src: string } | null>(null);
  const current = items[active];
  const currentKey = current?.clip?.key ?? current?.id;
  const currentSrc = current ? chooseStream(current, prefs.lowRes) : "";
  const currentSource = useRef({ id: currentKey, src: currentSrc, enabled });
  currentSource.current = { id: currentKey, src: currentSrc, enabled };

  const onBufferReadiness = useCallback<BufferReadiness>((id, src, ready) => {
    if (id !== currentSource.current.id || src !== currentSource.current.src) return;
    setPreloadFor(previous => ready
      ? previous?.id === id && previous.src === src ? previous : { id, src }
      : previous === null ? previous : null);
  }, []);
  const preloadNext = preloadFor?.id === currentKey && preloadFor?.src === currentSrc;

  // Aggressive lookahead prewarming for active+1 and active+2
  useEffect(() => {
    if (!enabled || locked) return;
    prewarmMedia(items[active + 1], prefs.lowRes, { rangeHead: true });
    prewarmMedia(items[active + 2], prefs.lowRes, { rangeHead: false });
  }, [active, items, enabled, locked, prefs.lowRes]);

  // Open on the tapped clip horizontally
  useLayoutEffect(() => {
    const el = container.current;
    if (el && enabled) el.scrollLeft = active * el.clientWidth;
  }, [start, enabled]);

  useEffect(() => { if (onNearEnd && active >= items.length - 3) onNearEnd(); }, [active, items.length, onNearEnd]);

  // GSAP horizontal scroll-scrubbed depth choreography (receding outgoing plate, unmasking incoming plate)
  useEffect(() => {
    const scroller = container.current;
    if (!scroller || !enabled || typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let frame = 0;
    const updateDepth = () => {
      frame = 0;
      const vw = scroller.clientWidth || window.innerWidth || 1;
      const left = scroller.scrollLeft;
      const mobile = window.innerWidth < 768;
      scroller.querySelectorAll<HTMLElement>("[data-index]").forEach(row => {
        const stage = row.querySelector<HTMLElement>("[data-feed-stage]");
        if (!stage) return;
        const idx = Number(row.dataset.index);
        const dist = Math.min(1, Math.abs(left - idx * vw) / vw);
        if (dist < 0.005) {
          gsap.set(stage, { scale: 1, opacity: 1 });
        } else {
          const minScale = mobile ? 0.94 : 0.92;
          gsap.set(stage, {
            scale: 1 - dist * (1 - minScale),
            opacity: 1 - dist * 0.55,
          });
        }
      });
    };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(updateDepth); };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    updateDepth();
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [enabled, items.length]);

  // Observe which horizontal slide fills the viewport
  useEffect(() => {
    const root = container.current;
    if (!root) return;
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          setPreloadFor(null);
          setActive(Number((entry.target as HTMLElement).dataset.index));
        }
      }
    }, { root, threshold: 0.6 });
    root.querySelectorAll<HTMLElement>("[data-index]").forEach(el => observer.observe(el));
    return () => observer.disconnect();
  }, [items.length]);

  const setFavorite = useCallback((id: string, on: boolean) => {
    setItems(list => list.map(item => item.id === id ? { ...item, favorite: on } : item));
    announce({ id, favorite: on });
  }, [setItems]);

  const remove = useCallback(async (media: Media) => {
    const index = items.findIndex(item => item.id === media.id);
    try { await api.remove(media.id); } catch { toast("删除失败，请稍后再试"); return; }
    setItems(list => list.filter(item => item.id !== media.id));
    announce({ id: media.id, removed: true });
    toast("已删除", {
      label: "撤销",
      run: () => void api.restore(media.id).then(({ restored }) => {
        if (!restored) { toast("已经开始删除，无法撤销"); return; }
        setItems(list => [...list.slice(0, index), media, ...list.slice(index)]);
      }),
    }, 6000);
  }, [items, setItems]);

  const goBy = useCallback((delta: 1 | -1) => {
    const el = container.current;
    if (!el) return;
    const stepWidth = el.clientWidth || window.innerWidth || 1;
    el.scrollBy({ left: delta * stepWidth, behavior: "smooth" });
  }, []);

  const prev = useCallback(() => goBy(-1), [goBy]);
  const next = useCallback(() => goBy(1), [goBy]);

  // Hands-free auto-swap timer
  useEffect(() => {
    if (!enabled || organize || locked || !prefs.autoSwapSeconds || active >= items.length - 1) return;
    const timer = setInterval(() => {
      if (!document.hidden) next();
    }, prefs.autoSwapSeconds * 1000);
    return () => clearInterval(timer);
  }, [enabled, organize, locked, prefs.autoSwapSeconds, active, items.length, next]);

  const [curating, setCurating] = useState(false);
  const complete = useCallback(async (addTags?: number[], macroLabel?: string) => {
    if (!current || curating) return;
    const targetId = current.id;
    const targetKey = current.clip?.key ?? current.id;
    setCurating(true);
    try {
      await curationApi.batch([targetId], addTags?.length ? { add_tags: addTags, organized: true } : { organized: true });
      setItems(list => list.map(item => item.id === targetId ? { ...item, organized: true } : item));
      toast(macroLabel ? `已一键归入「${macroLabel}」` : "已整理完成", {
        label: "撤销",
        run: () => {
          void curationApi.batch([targetId], addTags?.length ? { remove_tags: addTags, organized: false } : { organized: false })
            .then(() => {
              setItems(list => list.map(item => item.id === targetId ? { ...item, organized: false } : item));
              toast("已撤销整理状态");
            });
        },
      }, 5000);
      if (currentSource.current.id === targetKey && currentSource.current.enabled) next();
    } catch { toast("整理未保存，请重试"); }
    finally { setCurating(false); }
  }, [current, curating, next, setItems]);

  // Horizontal Folio keyboard controls (← / → flip horizontally; D/Enter complete organize; S skip)
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const el = container.current;
      if (
        !enabled || !el || event.metaKey || event.ctrlKey || event.altKey
        || event.target instanceof HTMLInputElement
        || event.target instanceof HTMLTextAreaElement
      ) return;
      if (event.key === "ArrowRight") {
        event.preventDefault();
        goBy(1);
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        goBy(-1);
      } else if (organize && (event.key === "d" || event.key === "D" || event.key === "Enter")) {
        event.preventDefault();
        void complete();
      } else if (organize && (event.key === "s" || event.key === "S")) {
        event.preventDefault();
        next();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled, organize, complete, next, goBy]);

  const organizePanel = organize && current ? (
    <QuickTagPanel
      key={current.id}
      media={current}
      compact
      onDone={() => void complete()}
      onApplyMacro={(tagIds, label) => void complete(tagIds, label)}
      doneLabel={curating ? "保存整理中…" : "完成下一条"}
      finishing={curating}
      footerLeft={
        <>
          <button
            type="button"
            aria-label="删除"
            disabled={!current.deletable}
            onClick={() => void remove(current)}
            className="pressable flex min-h-10 shrink-0 items-center justify-center gap-1 rounded-full border border-accent/40 bg-accent/12 px-3.5 text-[13px] font-semibold text-accent disabled:opacity-35"
          >
            <TrashIcon size={15} weight="bold" />删除
          </button>
          <button
            type="button"
            aria-label="跳过"
            onClick={next}
            className="pressable flex min-h-10 shrink-0 items-center justify-center gap-1 rounded-full border border-line bg-surface px-3.5 text-[13px] font-medium text-ink"
          >
            <ArrowRightIcon size={15} weight="bold" />跳过
          </button>
        </>
      }
    />
  ) : null;

  return (
    <div
      ref={container}
      className="ppvio-feed-scroller flex size-full snap-x snap-mandatory overflow-x-scroll overflow-y-hidden [scrollbar-width:none]"
    >
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          aria-label="返回"
          className="fixed left-4 top-[max(0.8rem,env(safe-area-inset-top))] z-30 grid size-10 place-items-center rounded-full border border-line bg-surface/90 text-ink hover:border-gold/50"
        >
          <CaretLeftIcon size={20} weight="bold" />
        </button>
      )}
      {items.map((item, index) => (
        <div key={item.clip?.key ?? item.id} data-index={index} className="h-full w-full shrink-0 snap-start snap-always">
          <FeedItem
            media={item}
            active={enabled && index === active}
            mounted={enabled && Math.abs(index - active) <= 1}
            eager={index === active + 1 && preloadNext}
            onBufferReadiness={onBufferReadiness}
            onFavorite={setFavorite}
            onRemove={item.deletable && !item.clip ? remove : undefined}
            raised={organize}
            organizePanel={index === active ? organizePanel : undefined}
            index={index}
            total={items.length}
            onPrev={prev}
            onNext={next}
            onRefresh={onRefresh}
            onToggleOrganize={onToggleOrganize}
            preferencesTrigger={preferencesTrigger}
            startAt={index === start ? startAt : undefined}
          />
        </div>
      ))}
    </div>
  );
}

/** The home feed: taste-ranked horizontal folio deck. */
export function Feed({ onUnauthorized, enabled = true }: { onUnauthorized: () => void; enabled?: boolean }) {
  const [revision, setRevision] = useState(0);
  const shuffle = useCallback(() => {
    void api.refreshFeed().catch(() => undefined).finally(() => {
      setRevision(value => value + 1);
      toast("已按最新评分与喜好重排推荐");
    });
  }, []);

  return (
    <FeedContent
      key={revision}
      onUnauthorized={onUnauthorized}
      enabled={enabled}
      onRefresh={shuffle}
    />
  );
}

function FeedContent({
  onUnauthorized, enabled, onRefresh,
}: {
  onUnauthorized: () => void; enabled: boolean; onRefresh: () => void;
}) {
  const [items, setItems] = useState<Media[]>([]);
  const [organize, setOrganize] = useState(false);
  const [state, setState] = useState<"loading" | "ready" | "empty" | "error">("loading");
  const loading = useRef(false);
  const controller = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    if (loading.current) return;
    loading.current = true;
    const request = new AbortController();
    controller.current = request;
    try {
      const page = await api.feed(8, request.signal);
      if (request.signal.aborted) return;
      hydrateMediaRatings(page.items);
      setItems(current => mergeFeed(current, page.items));
      setState(current => page.items.length || current === "ready" ? "ready" : "empty");
    } catch (error) {
      if (request.signal.aborted) return;
      if (error instanceof Unauthorized) onUnauthorized();
      else setState(current => current === "ready" ? current : "error");
    } finally {
      if (controller.current === request) loading.current = false;
    }
  }, [onUnauthorized]);

  useEffect(() => {
    void load();
    return () => { controller.current?.abort(); loading.current = false; };
  }, [load]);

  if (state === "loading") return <Centered>正在按喜好编排放映…</Centered>;
  if (state === "error") {
    return (
      <Centered>
        加载失败，<button className="text-gold-bright underline" onClick={() => { setState("loading"); void load(); }}>重试</button>
      </Centered>
    );
  }
  if (state === "empty") {
    return (
      <Centered>
        当前偏好下没有短视频；可在设置中扫描目录或调整推荐偏好。
      </Centered>
    );
  }
  return (
    <ClipList
      items={items}
      setItems={setItems}
      onNearEnd={load}
      onRefresh={onRefresh}
      organize={organize}
      onToggleOrganize={() => setOrganize(v => !v)}
      enabled={enabled}
    />
  );
}

export function Centered({ children }: { children: React.ReactNode }) {
  return <div className="grid size-full place-items-center px-8 text-center text-[15px] leading-relaxed text-muted">{children}</div>;
}
