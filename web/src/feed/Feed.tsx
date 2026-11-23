import { ArrowDownIcon, CaretLeftIcon, TrashIcon } from "@phosphor-icons/react";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, chooseStream, Unauthorized, type Media } from "../api";
import { usePrefs } from "../prefs";
import { announce } from "../ui/Grid";
import { toast } from "../ui/toast";
import { FeedItem } from "./FeedItem";
import type { BufferReadiness } from "./useFeedPlayback";
import { curationApi } from "../curationApi";
import { FeedPreferencesButton } from "../ui/FeedPreferences";
import { QuickTagPanel } from "../ui/QuickTags";
import { subscribeMediaChanges } from "../ui/Grid";
import { SPRING_SHEET } from "../ui/motion";

/** Append new clips, never one already in the list. */
export function mergeFeed(current: Media[], incoming: Media[]): Media[] {
  const seen = new Set(current.map(item => item.id));
  return [...current, ...incoming.filter(item => !seen.has(item.id) && seen.add(item.id))];
}

/**
 * Clips one per screen, swiped vertically. Shared by the feed and by any wall a
 * clip is opened from (library, favorites, a folder).
 */
export function ClipList({ items, setItems, start = 0, onNearEnd, onClose, organize = false, enabled = true, startAt }: {
  items: Media[];
  setItems: (update: (list: Media[]) => Media[]) => void;
  start?: number;
  onNearEnd?: () => void;
  onClose?: () => void;
  /** 整理模式: big delete / favorite / skip buttons for a quick clean-up pass. */
  organize?: boolean;
  enabled?: boolean; startAt?: number;
}) {
  const [active, setActive] = useState(start);
  const container = useRef<HTMLDivElement>(null);
  const prefs = usePrefs();
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

  const next = () => container.current?.scrollBy({ top: container.current.clientHeight, behavior: "smooth" });
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
    <div ref={container} className="h-dvh snap-y snap-mandatory overflow-y-scroll [scrollbar-width:none]">
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
export function Feed({ onUnauthorized, enabled = true }: { onUnauthorized: () => void; enabled?: boolean }) {
  const [revision, setRevision] = useState(0);
  return <><FeedPreferencesButton className="fixed left-3 top-[max(0.75rem,env(safe-area-inset-top))] z-20" onSaved={() => setRevision(value => value + 1)} /><FeedContent key={revision} onUnauthorized={onUnauthorized} enabled={enabled} /></>;
}

function FeedContent({ onUnauthorized, enabled }: { onUnauthorized: () => void; enabled: boolean }) {
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
      <ClipList items={items} setItems={setItems} onNearEnd={load} organize={organize} enabled={enabled} />
    </>
  );
}

export function Centered({ children }: { children: React.ReactNode }) {
  return <div className="grid h-dvh place-items-center px-8 text-center text-[15px] leading-relaxed text-muted">{children}</div>;
}
