import { ArrowDownIcon, ArrowsClockwiseIcon, CaretLeftIcon, TimerIcon, TrashIcon } from "@phosphor-icons/react";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, chooseStream, Unauthorized, type Media } from "../api";
import { setPref, usePrefs } from "../prefs";
import { useLocked } from "../ui/privacy";
import { announce } from "../ui/Grid";
import { toast } from "../ui/toast";
import { FeedItem } from "./FeedItem";
import type { BufferReadiness } from "./useFeedPlayback";
import { curationApi } from "../curationApi";
import { FeedPreferencesButton } from "../ui/FeedPreferences";
import { QuickTagPanel } from "../ui/QuickTags";
import { subscribeMediaChanges } from "../ui/Grid";
import { SPRING_SHEET } from "../ui/motion";
import { haptic } from "../ui/haptics";

/** Append new clips, never one already in the list. */
export function mergeFeed(current: Media[], incoming: Media[]): Media[] {
  const seen = new Set(current.map(item => item.id));
  return [...current, ...incoming.filter(item => !seen.has(item.id) && seen.add(item.id))];
}

/**
 * Clips one per screen, swiped vertically. Shared by the feed and by any wall a
 * clip is opened from (library, favorites, a folder).
 */
export function ClipList({ items, setItems, start = 0, onNearEnd, onClose, onRefresh, organize = false, enabled = true, startAt }: {
  items: Media[];
  setItems: (update: (list: Media[]) => Media[]) => void;
  start?: number;
  onNearEnd?: () => void;
  onClose?: () => void;
  onRefresh?: () => void;
  /** 整理模式: big delete / favorite / skip buttons for a quick clean-up pass. */
  organize?: boolean;
  enabled?: boolean; startAt?: number;
}) {
  const [active, setActive] = useState(start);
  const [pullY, setPullY] = useState(0);
  const pullStart = useRef<number | null>(null);
  const container = useRef<HTMLDivElement>(null);
  const prefs = usePrefs();
  const locked = useLocked();
  useEffect(() => subscribeMediaChanges(change => setItems(list => "removed" in change
    ? list.filter(item => item.id !== change.id) : list.map(item => item.id === change.id ? { ...item, ...change } : item))), [setItems]);
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

  // Open on the clip that was tapped.
  useLayoutEffect(() => {
    const el = container.current;
    if (el && enabled) el.scrollTop = active * el.clientHeight;
  }, [start, enabled]);

  useEffect(() => { if (onNearEnd && active >= items.length - 3) onNearEnd(); }, [active, items.length, onNearEnd]);

  // The clip that fills most of the screen is the active one.
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

  // On a computer the page does not scroll the clip list by itself: ↑/↓ move a clip.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const el = container.current;
      const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
      if (!enabled || !el || !step || event.metaKey || event.ctrlKey || event.altKey || event.target instanceof HTMLInputElement) return;
      event.preventDefault();
      el.scrollBy({ top: step * el.clientHeight, behavior: "smooth" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);

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

  const next = useCallback(() => container.current?.scrollBy({ top: container.current.clientHeight, behavior: "smooth" }), []);

  // Hands-free auto-swap timer: advances to the next clip automatically when enabled.
  useEffect(() => {
    if (!enabled || organize || locked || !prefs.autoSwapSeconds || active >= items.length - 1) return;
    const timer = setInterval(() => {
      if (!document.hidden) next();
    }, prefs.autoSwapSeconds * 1000);
    return () => clearInterval(timer);
  }, [enabled, organize, locked, prefs.autoSwapSeconds, active, items.length, next]);
  const [curating, setCurating] = useState(false);
  const complete = async () => {
    if (!current || curating) return;
    setCurating(true);
    try {
      await curationApi.batch([current.id], { organized: true });
      setItems(list => list.map(item => item.id === current.id ? { ...item, organized: true } : item));
      toast("已整理完成");
      if (currentSource.current.id === (current.clip?.key ?? current.id) && currentSource.current.enabled) next();
    } catch { toast("整理未保存，请重试"); }
    finally { setCurating(false); }
  };

  return (
    <div ref={container} className="h-dvh snap-y snap-mandatory overflow-y-scroll [scrollbar-width:none]"
      onTouchStart={e => { if (onRefresh && (container.current?.scrollTop ?? 0) <= 2) pullStart.current = e.touches[0]?.clientY ?? null; }}
      onTouchMove={e => {
        if (!onRefresh || pullStart.current === null || (container.current?.scrollTop ?? 0) > 2) return;
        const delta = (e.touches[0]?.clientY ?? 0) - pullStart.current;
        if (delta > 0) setPullY(Math.min(80, delta * 0.45));
      }}
      onTouchEnd={() => {
        if (onRefresh && pullY >= 52) { haptic(10); onRefresh(); }
        pullStart.current = null; setPullY(0);
      }}>
      {pullY > 12 && (
        <div aria-hidden="true" className="pointer-events-none fixed inset-x-0 top-[max(3.75rem,env(safe-area-inset-top))] z-20 flex justify-center">
          <span className="glass-pill inline-flex h-8 items-center gap-1.5 rounded-full px-3.5 text-[12px] font-medium text-gold-bright">
            <ArrowsClockwiseIcon size={14} className={pullY >= 52 ? "animate-spin" : ""} />
            {pullY >= 52 ? "松开换一批" : "下拉换一批"}
          </span>
        </div>
      )}
      <AnimatePresence>
        {organize && current && (
          <motion.div key="organize-dock"
            initial={{ opacity: 0, y: 28, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 24, scale: 0.96 }}
            transition={SPRING_SHEET}
            className="fixed inset-x-0 bottom-[calc(5.6rem+env(safe-area-inset-bottom))] z-20 mx-auto max-w-md px-3">
            <div className="glass-dock overflow-hidden rounded-[24px] text-white">
              <QuickTagPanel
                key={current.id}
                media={current}
                compact
                onDone={() => void complete()}
                doneLabel={curating ? "保存整理中…" : "完成下一条"}
                finishing={curating}
                headerMeta={
                  <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-gold/30 bg-gold/14 px-2.5 py-1 text-[12px] font-semibold tabular-nums text-gold-bright">
                    <span className="size-1.5 rounded-full bg-gold" aria-hidden="true" />
                    {active + 1}/{items.length}
                  </span>
                }
                footerLeft={
                  <>
                    <button type="button" aria-label="删除" disabled={!current.deletable} onClick={() => void remove(current)}
                      className="pressable flex min-h-11 shrink-0 items-center justify-center gap-1 rounded-full border border-accent/35 bg-accent/15 px-3.5 text-[13px] font-semibold text-accent disabled:opacity-35">
                      <TrashIcon size={17} weight="bold" />删除
                    </button>
                    <button type="button" aria-label="跳过" onClick={next}
                      className="glass-pill pressable flex min-h-11 shrink-0 items-center justify-center gap-1 rounded-full px-3.5 text-[13px] font-medium text-ink">
                      <ArrowDownIcon size={17} weight="bold" />跳过
                    </button>
                  </>
                }
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      {onClose && (
        <button type="button" onClick={onClose} aria-label="返回"
          className="glass-pill pressable fixed left-3 top-[max(0.75rem,env(safe-area-inset-top))] z-20 grid size-10 place-items-center rounded-full text-white">
          <CaretLeftIcon size={20} weight="bold" />
        </button>
      )}
      {items.map((item, index) => (
        <div key={item.clip?.key ?? item.id} data-index={index}>
          <FeedItem media={item} active={enabled && index === active} mounted={enabled && Math.abs(index - active) <= 1}
            eager={index === active + 1 && preloadNext} onBufferReadiness={onBufferReadiness}
            onFavorite={setFavorite} onRemove={item.deletable && !item.clip ? remove : undefined} raised={organize} startAt={index === start ? startAt : undefined} />
        </div>
      ))}
    </div>
  );
}

/** The home feed: the server's shuffled deck, unwatched first. */
const SWAP_STEPS = [0, 15, 30, 60] as const;

export function Feed({ onUnauthorized, enabled = true }: { onUnauthorized: () => void; enabled?: boolean }) {
  const [revision, setRevision] = useState(0);
  const prefs = usePrefs();
  const shuffle = useCallback(() => { setRevision(value => value + 1); toast("已换一批短视频"); }, []);
  const cycleSwap = () => {
    const idx = SWAP_STEPS.indexOf(prefs.autoSwapSeconds as typeof SWAP_STEPS[number]);
    const nextSec = SWAP_STEPS[(idx + 1) % SWAP_STEPS.length];
    haptic(8);
    setPref("autoSwapSeconds", nextSec);
    toast(nextSec ? `免手轮换：每 ${nextSec} 秒自动下一条` : "已关闭免手自动轮换");
  };
  return <>
    <FeedPreferencesButton className="fixed left-3 top-[max(0.75rem,env(safe-area-inset-top))] z-20" onSaved={() => setRevision(value => value + 1)} />
    <button type="button" onClick={cycleSwap} aria-label="免手自动轮换" aria-pressed={prefs.autoSwapSeconds > 0}
      className={`pressable fixed left-[5.6rem] top-[max(0.75rem,env(safe-area-inset-top))] z-20 flex h-10 items-center gap-1 rounded-full px-3 text-[12px] font-semibold ${prefs.autoSwapSeconds > 0 ? "glass-pill-gold" : "glass-pill text-white/90"}`}>
      <TimerIcon size={15} weight={prefs.autoSwapSeconds > 0 ? "fill" : "bold"} />
      <span>{prefs.autoSwapSeconds > 0 ? `${prefs.autoSwapSeconds}s` : "自动"}</span>
    </button>
    <FeedContent key={revision} onUnauthorized={onUnauthorized} enabled={enabled} onRefresh={shuffle} />
  </>;
}

function FeedContent({ onUnauthorized, enabled, onRefresh }: { onUnauthorized: () => void; enabled: boolean; onRefresh: () => void }) {
  const [items, setItems] = useState<Media[]>([]);
  const [organize, setOrganize] = useState(false);
  const [state, setState] = useState<"loading" | "ready" | "empty" | "error">("loading");
  const loading = useRef(false);
  const controller = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    if (loading.current) return;
    loading.current = true;
    const request = new AbortController(); controller.current = request;
    try {
      const page = await api.feed(6, request.signal);
      if (request.signal.aborted) return;
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

  useEffect(() => { void load(); return () => { controller.current?.abort(); loading.current = false; }; }, [load]);

  if (state === "loading") return <Centered>正在加载…</Centered>;
  if (state === "error") return <Centered>加载失败，<button className="text-accent" onClick={() => { setState("loading"); void load(); }}>重试</button></Centered>;
  if (state === "empty") return <Centered>当前偏好下没有短视频。可以调整左上角的偏好；新片库请先在设置中扫描视频目录。</Centered>;
  return (
    <>
      <button type="button" onClick={() => setOrganize(value => !value)} aria-pressed={organize}
        className={`pressable fixed right-3 top-[max(0.75rem,env(safe-area-inset-top))] z-20 h-10 rounded-full px-4 text-[13px] font-semibold ${organize ? "glass-pill-gold" : "glass-pill text-white"}`}>
        {organize ? "完成" : "整理"}
      </button>
      <ClipList items={items} setItems={setItems} onNearEnd={load} onRefresh={onRefresh} organize={organize} enabled={enabled} />
    </>
  );
}

export function Centered({ children }: { children: React.ReactNode }) {
  return <div className="grid h-dvh place-items-center px-8 text-center text-[15px] leading-relaxed text-muted">{children}</div>;
}
