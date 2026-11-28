import { CaretLeftIcon, CaretRightIcon, CheckIcon, EyeIcon, EyeSlashIcon } from "@phosphor-icons/react";
import { motion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { chooseStream, type Media } from "../api";
import { setPref, usePrefs } from "../prefs";
import { hydrateMediaRatings } from "../ratings";
import { PreviewButton } from "./SeekPreview";
import { SPRING_TAP } from "./motion";
import { useFolioTransition } from "./gsap";
import { FlutedPrivacyShield } from "./CinemaChrome";
import { prewarmMedia } from "./prewarm";
import { haptic } from "./haptics";

export function formatDuration(seconds: number | null): string {
  if (!seconds || !Number.isFinite(seconds)) return "";
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`;
}

function useFolioPageSize(wide: boolean): number {
  const compute = () => {
    if (typeof window === "undefined") return wide ? 6 : 8;
    const w = window.innerWidth;
    if (w >= 1024) return wide ? 6 : 8;
    if (w >= 640) return wide ? 6 : 6;
    return wide ? 4 : 6;
  };
  const [size, setSize] = useState(compute);
  useEffect(() => {
    const onResize = () => setSize(compute());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [wide]);
  return size;
}

/**
 * Direction A — Darkroom Horizontal Folio Grid:
 * - Zero vertical scroll: paginates plates into clean single-viewport horizontal folios
 * - Pure Daniel Vignal / Maximilian Berndt visual plates: zero tiny pills or text clutter at rest
 * - GSAP Codrops-style horizontal clip-path transition on page turns + keyboard ←/→ + swipe
 */
export function Grid({
  items, onOpen, onEnd, done, error, onRetry, wide = false, progress,
  selecting = false, selectedIds, onToggleSelect, onStartSelect,
  folio = true,
}: {
  items: Media[];
  onOpen: (index: number, at?: number) => void;
  onEnd: () => void;
  done: boolean;
  error?: boolean;
  onRetry?: () => void;
  wide?: boolean;
  progress?: Map<string, number>;
  selecting?: boolean;
  selectedIds?: Set<string>;
  onToggleSelect?: (id: string) => void;
  onStartSelect?: (id: string) => void;
  folio?: boolean;
}) {
  const prefs = usePrefs();
  const [peeking, setPeeking] = useState<string | null>(null);
  const [hoverPlayId, setHoverPlayId] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [dir, setDir] = useState<1 | -1>(1);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressed = useRef(false);
  const swipeStart = useRef<{ x: number; y: number } | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);

  const pageSize = useFolioPageSize(wide);
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const clampedPage = Math.min(page, totalPages - 1);

  useEffect(() => {
    hydrateMediaRatings(items);
  }, [items]);

  useEffect(() => {
    if (page > totalPages - 1) setPage(Math.max(0, totalPages - 1));
  }, [page, totalPages]);

  useEffect(() => () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    if (longPressTimer.current) clearTimeout(longPressTimer.current);
  }, []);

  // Preserve sentinel observer contract for infinite-prefetch & existing tests
  useEffect(() => {
    const el = sentinel.current;
    if (!el || done || error) return;
    const observer = new IntersectionObserver(entries => {
      if (entries[0]?.isIntersecting) onEnd();
    }, { rootMargin: "400px" });
    observer.observe(el);
    return () => observer.disconnect();
  }, [onEnd, done, error, items.length]);

  const flipTo = useCallback((nextPage: number) => {
    if (nextPage === clampedPage) return;
    if (nextPage < 0) return;
    if (nextPage >= totalPages) {
      if (!done && !error) onEnd();
      return;
    }
    setDir(nextPage > clampedPage ? 1 : -1);
    setPage(nextPage);
    haptic(6);
    if (!done && !error && nextPage >= totalPages - 1) onEnd();
  }, [clampedPage, totalPages, done, error, onEnd]);

  // Keyboard ← / → horizontal folio navigation
  useEffect(() => {
    if (!folio) return;
    const onKey = (event: KeyboardEvent) => {
      if (
        event.metaKey || event.ctrlKey || event.altKey
        || event.target instanceof HTMLInputElement
        || event.target instanceof HTMLTextAreaElement
        || event.target instanceof HTMLSelectElement
      ) return;
      if (event.key === "ArrowRight") {
        if (clampedPage < totalPages - 1 || !done) {
          event.preventDefault();
          flipTo(clampedPage + 1);
        }
      } else if (event.key === "ArrowLeft" && clampedPage > 0) {
        event.preventDefault();
        flipTo(clampedPage - 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [folio, clampedPage, totalPages, done, flipTo]);

  useFolioTransition(stageRef, `${clampedPage}-${wide}`, dir);

  const visibleEntries = useMemo(() => {
    if (!folio) return items.map((item, globalIndex) => ({ item, globalIndex }));
    const start = clampedPage * pageSize;
    return items.slice(start, start + pageSize).map((item, idx) => ({
      item,
      globalIndex: start + idx,
    }));
  }, [folio, items, clampedPage, pageSize]);

  const clearHover = () => {
    if (hoverTimer.current) { clearTimeout(hoverTimer.current); hoverTimer.current = null; }
    setHoverPlayId(null);
  };
  const clearLongPress = () => {
    if (longPressTimer.current) { clearTimeout(longPressTimer.current); longPressTimer.current = null; }
  };

  // Visible page segments (cap at 6 clean hairline segments like Order & Chaos)
  const segmentWindowStart = Math.max(0, Math.min(clampedPage - 2, totalPages - 6));
  const segmentIndices = Array.from(
    { length: Math.min(6, totalPages) },
    (_, i) => segmentWindowStart + i,
  );

  return (
    <div
      className={folio ? "flex min-h-0 flex-1 flex-col justify-between overflow-hidden" : ""}
      onPointerDown={e => {
        if (!folio) return;
        swipeStart.current = { x: e.clientX, y: e.clientY };
      }}
      onPointerUp={e => {
        if (!folio || !swipeStart.current) return;
        const dx = e.clientX - swipeStart.current.x;
        const dy = e.clientY - swipeStart.current.y;
        swipeStart.current = null;
        if (Math.abs(dx) > 58 && Math.abs(dx) > Math.abs(dy) * 1.4) {
          flipTo(clampedPage + (dx < 0 ? 1 : -1));
        }
      }}
      onPointerCancel={() => { swipeStart.current = null; }}
    >
      {/* Pure uncluttered media plate canvas */}
      <div
        ref={stageRef}
        className={
          folio
            ? `grid min-h-0 flex-1 gap-3 sm:gap-5 ${
                wide
                  ? "grid-cols-2 grid-rows-2 sm:grid-cols-3 sm:grid-rows-2"
                  : "grid-cols-2 grid-rows-3 sm:grid-cols-3 sm:grid-rows-2 lg:grid-cols-4 lg:grid-rows-2"
              }`
            : `grid gap-3 ${wide ? "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4" : "grid-cols-3 sm:grid-cols-4 lg:grid-cols-6"}`
        }
      >
        {visibleEntries.map(({ item, globalIndex }) => {
          const blurred = prefs.coverBlur && !(prefs.peekOnHold && peeking === item.id);
          const isSelected = !!selectedIds?.has(item.id);
          const showHoverVideo = hoverPlayId === item.id && !blurred && !selecting;
          return (
            <div key={item.id} data-grid-card className="group relative min-h-0 min-w-0">
              <motion.button
                type="button"
                onClick={() => {
                  if (longPressed.current) { longPressed.current = false; return; }
                  if (selecting && onToggleSelect) { haptic(6); onToggleSelect(item.id); return; }
                  onOpen(globalIndex);
                }}
                aria-label={selecting ? `${isSelected ? "取消选择" : "选择"}第 ${globalIndex + 1} 个视频` : `播放第 ${globalIndex + 1} 个视频`}
                aria-pressed={selecting ? isSelected : undefined}
                whileTap={{ scale: 0.97 }}
                transition={SPRING_TAP}
                onPointerEnter={e => {
                  if (e.pointerType === "mouse") {
                    prewarmMedia(item, prefs.lowRes);
                    if (prefs.coverBlur && prefs.peekOnHold) setPeeking(item.id);
                    if (!selecting) {
                      clearHover();
                      hoverTimer.current = setTimeout(() => setHoverPlayId(item.id), 340);
                    }
                  }
                }}
                onPointerLeave={() => {
                  if (peeking === item.id) setPeeking(null);
                  clearHover();
                  clearLongPress();
                }}
                onPointerDown={e => {
                  prewarmMedia(item, prefs.lowRes);
                  if (prefs.coverBlur && prefs.peekOnHold) setPeeking(item.id);
                  if (!selecting && onStartSelect && e.button === 0) {
                    longPressed.current = false;
                    clearLongPress();
                    longPressTimer.current = setTimeout(() => {
                      longPressed.current = true;
                      haptic(14);
                      onStartSelect(item.id);
                    }, 430);
                  }
                }}
                onPointerUp={() => { if (peeking === item.id) setPeeking(null); clearLongPress(); }}
                onPointerCancel={() => { if (peeking === item.id) setPeeking(null); clearLongPress(); }}
                className={`relative block overflow-hidden rounded-[12px] border border-white/[0.08] bg-surface transition-[border-color,transform] duration-300 ${
                  folio ? "size-full" : `w-full ${wide ? "aspect-video" : "aspect-[3/4]"}`
                } ${
                  isSelected
                    ? "ring-2 ring-gold-bright ring-offset-1 ring-offset-bg scale-[0.97]"
                    : "hover:border-gold/45"
                }`}
              >
                {item.cover_url && (
                  <Cover
                    src={item.cover_url}
                    className={`film-grade size-full object-cover ${blurred ? "blur-xl scale-110" : ""}`}
                  />
                )}
                {showHoverVideo && (
                  <video
                    src={chooseStream(item, true)}
                    autoPlay
                    loop
                    muted
                    playsInline
                    preload="metadata"
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-0 size-full object-cover"
                  />
                )}
                <FlutedPrivacyShield active={blurred} />
                {selecting && (
                  <span
                    aria-hidden="true"
                    className={`absolute right-2.5 top-2.5 grid size-6.5 place-items-center rounded-full border transition-colors ${
                      isSelected ? "border-gold-bright bg-gold text-bg" : "border-white/50 bg-black/55 text-transparent"
                    }`}
                  >
                    <CheckIcon size={14} weight="bold" />
                  </span>
                )}
                <WatchedBar seconds={progress?.get(item.id)} duration={item.duration_seconds} />
              </motion.button>

              {/* Subtle hover-only preview trigger (zero resting clutter, keeps Grid preview contract) */}
              {!selecting && (
                <div className="opacity-0 transition-opacity duration-200 focus-within:opacity-100 group-hover:opacity-100">
                  <PreviewButton media={item} onPlay={at => onOpen(globalIndex, at)} />
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Bottom Order & Chaos Horizontal Folio Pager Rail */}
      {folio && (items.length > 0 || error) && (
        <div className="mt-3 flex shrink-0 items-center justify-between gap-4 border-t border-line pt-3">
          <div className="flex flex-1 items-center gap-2.5 max-w-md">
            {segmentIndices.map(seg => {
              const active = seg === clampedPage;
              return (
                <button
                  key={seg}
                  type="button"
                  onClick={() => flipTo(seg)}
                  aria-label={`第 ${seg + 1} 页`}
                  aria-current={active ? "page" : undefined}
                  className="group flex flex-1 flex-col gap-1.5 text-left"
                >
                  <span className={`tabular-nums text-[13px] transition-colors ${active ? "font-semibold text-ink" : "text-faint group-hover:text-muted"}`}>
                    {String(seg + 1).padStart(2, "0")}
                  </span>
                  <span className={`block h-[2px] w-full transition-colors ${active ? "bg-gold" : "bg-white/15 group-hover:bg-white/30"}`} />
                </button>
              );
            })}
          </div>

          <div className="flex items-center gap-2">
            {error && onRetry && (
              <button type="button" aria-label="重试加载" onClick={onRetry}
                className="h-9 rounded-full border border-accent/50 px-3.5 text-[13px] font-medium text-accent">
                重试
              </button>
            )}
            <button
              type="button"
              aria-label="上一页"
              disabled={clampedPage <= 0}
              onClick={() => flipTo(clampedPage - 1)}
              className="grid size-10 place-items-center rounded-full border border-line bg-surface/70 text-ink transition-colors hover:border-gold/55 disabled:opacity-25"
            >
              <CaretLeftIcon size={18} weight="bold" />
            </button>
            <button
              type="button"
              aria-label="下一页"
              disabled={clampedPage >= totalPages - 1 && done}
              onClick={() => flipTo(clampedPage + 1)}
              className="grid size-10 place-items-center rounded-full border border-line bg-surface/70 text-ink transition-colors hover:border-gold/55 disabled:opacity-25"
            >
              <CaretRightIcon size={18} weight="bold" />
            </button>
          </div>
        </div>
      )}

      {/* Non-folio fallback error / hidden sentinel for pagination contract */}
      {!folio && error ? (
        <div role="alert" className="flex items-center justify-center gap-3 py-6 text-[14px] text-muted">
          加载失败
          {onRetry && <button type="button" aria-label="重试加载" onClick={onRetry} className="ios-card pressable min-h-10 rounded-full px-4 text-ink">重试</button>}
        </div>
      ) : !done && <div ref={sentinel} className="h-px w-full shrink-0" aria-hidden="true" />}
      {folio && error && <span role="alert" className="sr-only">加载失败</span>}
    </div>
  );
}

export const COVER_RETRIES = 4;

export function Cover({ src, className }: { src: string; className: string }) {
  const [attempt, setAttempt] = useState(0);
  useEffect(() => setAttempt(0), [src]);
  return (
    <img
      key={attempt}
      src={src}
      alt=""
      loading="lazy"
      decoding="async"
      className={className}
      onError={() => {
        if (attempt < COVER_RETRIES) setTimeout(() => setAttempt(n => n + 1), 1500 * 2 ** attempt + Math.random() * 500);
      }}
    />
  );
}

type Change =
  | { id: string; favorite?: boolean; premium?: boolean; organized?: boolean; cover_url?: string | null }
  | { id: string; removed: true };
const changeListeners = new Set<(change: Change) => void>();

export function announce(change: Change): void {
  changeListeners.forEach(listener => listener(change));
}

export function subscribeMediaChanges(listener: (change: Change) => void) {
  changeListeners.add(listener);
  return () => { changeListeners.delete(listener); };
}

export function WatchedBar({ seconds, duration }: { seconds: number | undefined; duration: number | null }) {
  if (!seconds || !duration) return null;
  return (
    <span className="absolute inset-x-0 bottom-0 h-[2.5px] bg-white/15">
      <span className="block h-full bg-gold" style={{ width: `${Math.min(100, (seconds / duration) * 100)}%` }} />
    </span>
  );
}

export function BlurToggle() {
  const prefs = usePrefs();
  return (
    <motion.button
      type="button"
      onClick={() => setPref("coverBlur", !prefs.coverBlur)}
      aria-label={prefs.coverBlur ? "显示封面" : "模糊封面"}
      whileTap={{ scale: 0.88 }}
      transition={SPRING_TAP}
      className={`grid size-9 shrink-0 place-items-center rounded-full border transition-colors ${
        prefs.coverBlur ? "border-gold/45 bg-gold/14 text-gold-bright" : "border-line bg-surface/60 text-muted hover:text-ink"
      }`}
    >
      {prefs.coverBlur ? <EyeSlashIcon size={17} weight="fill" /> : <EyeIcon size={17} />}
    </motion.button>
  );
}

export function usePages(
  fetchPage: (cursor: string | null, offset: number) => Promise<{ items: Media[]; has_more: boolean; next_cursor?: string | null }>,
  key: string,
) {
  const [items, setItems] = useState<Media[]>([]);
  const [done, setDone] = useState(false);
  const [error, setError] = useState(false);
  const state = useRef({ cursor: null as string | null, busy: false, key, done: false, error: false, offset: 0, active: true });
  useEffect(() => {
    const apply = (change: Change) => setItems(list => "removed" in change
      ? list.filter(m => m.id !== change.id)
      : list.map(m => m.id === change.id ? { ...m, ...change } : m));
    changeListeners.add(apply);
    return () => { changeListeners.delete(apply); };
  }, []);
  useEffect(() => {
    const generation = { cursor: null as string | null, busy: false, key, done: false, error: false, offset: 0, active: true };
    state.current = generation;
    setItems([]); setDone(false); setError(false);
    return () => { generation.active = false; };
  }, [key]);
  const load = useCallback(async (retry: boolean) => {
    const s = state.current;
    if (!s.active || s.key !== key || s.busy || s.done || (s.error && !retry)) return;
    s.busy = true;
    s.error = false; setError(false);
    try {
      const page = await fetchPage(s.cursor, s.offset);
      if (!s.active || state.current !== s) return;
      s.cursor = page.next_cursor ?? null;
      s.offset += page.items.length;
      setItems(list => {
        const seen = new Set(list.map(m => m.id));
        return [...list, ...page.items.filter(m => !seen.has(m.id))];
      });
      s.done = !page.has_more || !page.items.length;
      setDone(s.done);
    } catch {
      if (!s.active || state.current !== s) return;
      s.error = true; setError(true);
    } finally {
      s.busy = false;
    }
  }, [fetchPage, key]);
  const more = useCallback(() => load(false), [load]);
  const retry = useCallback(() => load(true), [load]);
  return { items, setItems, done, error, more, retry };
}
