import { CheckIcon, EyeIcon, EyeSlashIcon, StarIcon } from "@phosphor-icons/react";
import { motion } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { chooseStream, type Media } from "../api";
import { setPref, usePrefs } from "../prefs";
import { addToQueue, getQueue } from "../queue";
import { useRatings } from "../ratings";
import { toast } from "./toast";
import { PreviewButton } from "./SeekPreview";
import { SPRING_TAP } from "./motion";
import { useGridBatchReveal } from "./gsap";
import { FlutedPrivacyShield } from "./CinemaChrome";
import { prewarmMedia } from "./prewarm";
import { haptic } from "./haptics";

export function formatDuration(seconds: number | null): string {
  if (!seconds || !Number.isFinite(seconds)) return "";
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`;
}

/**
 * Editorial Cinema Archive wall:
 * - GSAP ScrollTrigger.batch() staggered aperture unveils
 * - Desktop hover prewarm + muted live video preview + resting film-grade bloom
 * - Goons-inspired fluted optical refraction privacy shield when coverBlur is enabled
 * - Optional frictionless multi-select batch triage mode (long-press or toggle)
 */
export function Grid({
  items, onOpen, onEnd, done, error, onRetry, wide, progress,
  selecting = false, selectedIds, onToggleSelect, onStartSelect,
}: {
  items: Media[]; onOpen: (index: number, at?: number) => void; onEnd: () => void; done: boolean; error?: boolean;
  onRetry?: () => void; wide?: boolean; progress?: Map<string, number>;
  selecting?: boolean;
  selectedIds?: Set<string>;
  onToggleSelect?: (id: string) => void;
  onStartSelect?: (id: string) => void;
}) {
  const prefs = usePrefs();
  const ratings = useRatings();
  const [peeking, setPeeking] = useState<string | null>(null);
  const [hoverPlayId, setHoverPlayId] = useState<string | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressed = useRef(false);
  const gridRef = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);

  useGridBatchReveal(gridRef, items.length);

  useEffect(() => () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    if (longPressTimer.current) clearTimeout(longPressTimer.current);
  }, []);

  useEffect(() => {
    const el = sentinel.current;
    if (!el || done || error) return;
    const observer = new IntersectionObserver(entries => { if (entries[0]?.isIntersecting) onEnd(); }, { rootMargin: "600px" });
    observer.observe(el);
    return () => observer.disconnect();
  }, [onEnd, done, error, items.length]);

  const clearHover = () => {
    if (hoverTimer.current) { clearTimeout(hoverTimer.current); hoverTimer.current = null; }
    setHoverPlayId(null);
  };
  const clearLongPress = () => {
    if (longPressTimer.current) { clearTimeout(longPressTimer.current); longPressTimer.current = null; }
  };

  return (
    <>
      <div ref={gridRef} className={`grid gap-2.5 ${wide ? "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4" : "grid-cols-3 sm:grid-cols-4 lg:grid-cols-6"}`}>
        {items.map((item, index) => {
          const blurred = prefs.coverBlur && !(prefs.peekOnHold && peeking === item.id);
          const stars = ratings[item.id] ?? 0;
          const isSelected = !!selectedIds?.has(item.id);
          const showHoverVideo = hoverPlayId === item.id && !blurred && !selecting;
          return (
            <div key={item.id} data-grid-card className="group relative min-w-0">
              <motion.button
                type="button"
                onClick={() => {
                  if (longPressed.current) { longPressed.current = false; return; }
                  if (selecting && onToggleSelect) { haptic(6); onToggleSelect(item.id); return; }
                  onOpen(index);
                }}
                aria-label={selecting ? `${isSelected ? "取消选择" : "选择"}第 ${index + 1} 个视频` : `播放第 ${index + 1} 个视频`}
                aria-pressed={selecting ? isSelected : undefined}
                whileTap={{ scale: 0.96 }}
                transition={SPRING_TAP}
                onPointerEnter={e => {
                  if (e.pointerType === "mouse") {
                    prewarmMedia(item, prefs.lowRes);
                    if (prefs.coverBlur && prefs.peekOnHold) setPeeking(item.id);
                    if (!selecting) {
                      clearHover();
                      hoverTimer.current = setTimeout(() => setHoverPlayId(item.id), 380);
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
                className={`luxury-card sheen-overlay relative block w-full rounded-[15px] ${wide ? "aspect-video" : "aspect-[3/4]"} ${isSelected ? "ring-2 ring-gold-bright ring-offset-1 ring-offset-bg scale-[0.96]" : ""}`}
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
                {!selecting && !showHoverVideo && (
                  <span aria-hidden="true"
                    className="glass-pill film-slate pointer-events-none absolute left-1/2 top-1/2 hidden size-12 -translate-x-1/2 -translate-y-1/2 scale-90 place-items-center rounded-full text-[9.5px] font-semibold text-gold-bright opacity-0 transition-[opacity,transform] duration-250 ease-out sm:grid group-hover:scale-100 group-hover:opacity-100">
                    PLAY
                  </span>
                )}
                <span aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-black/84 via-black/26 to-transparent" />
                {stars > 0 && (
                  <span className="glass-pill film-slate absolute bottom-1.5 left-1.5 inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-semibold text-gold-bright">
                    <StarIcon size={10} weight="fill" />{stars}
                  </span>
                )}
                <span className="glass-pill film-slate absolute bottom-1.5 right-1.5 rounded-full px-2 py-0.5 text-[10px] font-medium text-ink">
                  {formatDuration(item.duration_seconds)}
                </span>
                {selecting && (
                  <span aria-hidden="true"
                    className={`absolute right-2 top-2 grid size-6.5 place-items-center rounded-full border transition-colors ${isSelected ? "border-gold-bright bg-gold text-bg shadow-[0_4px_14px_rgba(229,196,132,0.45)]" : "border-white/45 bg-black/55 text-transparent"}`}>
                    <CheckIcon size={14} weight="bold" />
                  </span>
                )}
                <WatchedBar seconds={progress?.get(item.id)} duration={item.duration_seconds} />
              </motion.button>
              {!selecting && (
                <>
                  <PreviewButton media={item} onPlay={at => onOpen(index, at)} />
                  <button type="button" aria-label={`加入待播第 ${index + 1} 个视频`}
                    onClick={() => toast(addToQueue(item) ? "已加入待播队列" : getQueue().length >= 100 ? "队列已满，最多100个" : "已在待播队列中")}
                    className="glass-pill pressable absolute left-1.5 top-1.5 min-h-8 rounded-full px-2.5 text-[11px] font-medium text-ink/95 hover:border-gold/45">
                    待播
                  </button>
                </>
              )}
            </div>
          );
        })}
      </div>
      {error ? <div role="alert" className="flex items-center justify-center gap-3 py-6 text-[14px] text-muted">
        加载失败
        {onRetry && <button type="button" aria-label="重试加载" onClick={onRetry} className="ios-card pressable min-h-10 rounded-full px-4 text-ink">重试</button>}
      </div> : !done && <div ref={sentinel} className="h-10" />}
    </>
  );
}

export const COVER_RETRIES = 4;

/** A cover that asks again, after a growing pause, when the server was busy. */
export function Cover({ src, className }: { src: string; className: string }) {
  const [attempt, setAttempt] = useState(0);
  useEffect(() => setAttempt(0), [src]);
  return <img key={attempt} src={src} alt="" loading="lazy" decoding="async" className={className}
    onError={() => { if (attempt < COVER_RETRIES) setTimeout(() => setAttempt(n => n + 1), 1500 * 2 ** attempt + Math.random() * 500); }} />;
}

type Change = { id: string; favorite?: boolean; premium?: boolean; organized?: boolean; cover_url?: string | null } | { id: string; removed: true };
const changeListeners = new Set<(change: Change) => void>();

export function announce(change: Change): void {
  changeListeners.forEach(listener => listener(change));
}

export function subscribeMediaChanges(listener: (change: Change) => void) {
  changeListeners.add(listener); return () => { changeListeners.delete(listener); };
}

export function WatchedBar({ seconds, duration }: { seconds: number | undefined; duration: number | null }) {
  if (!seconds || !duration) return null;
  return (
    <span className="absolute inset-x-0 bottom-0 h-[3px] bg-white/18">
      <span className="block h-full rounded-r-full bg-gradient-to-r from-gold to-gold-bright shadow-[0_0_8px_rgba(229,196,132,0.65)]" style={{ width: `${Math.min(100, (seconds / duration) * 100)}%` }} />
    </span>
  );
}

export function BlurToggle() {
  const prefs = usePrefs();
  return (
    <motion.button type="button" onClick={() => setPref("coverBlur", !prefs.coverBlur)} aria-label={prefs.coverBlur ? "显示封面" : "模糊封面"}
      whileTap={{ scale: 0.88 }} transition={SPRING_TAP}
      className={`ios-card grid size-10 shrink-0 place-items-center rounded-full transition-colors ${prefs.coverBlur ? "border-gold/40 text-gold-bright" : "text-muted hover:text-ink"}`}>
      {prefs.coverBlur ? <EyeSlashIcon size={19} weight="fill" /> : <EyeIcon size={19} />}
    </motion.button>
  );
}

export function usePages(fetchPage: (cursor: string | null, offset: number) => Promise<{ items: Media[]; has_more: boolean; next_cursor?: string | null }>, key: string) {
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
      setItems(list => { const seen = new Set(list.map(m => m.id)); return [...list, ...page.items.filter(m => !seen.has(m.id))]; });
      s.done = !page.has_more || !page.items.length;
      setDone(s.done);
    } catch {
      if (!s.active || state.current !== s) return;
      s.error = true; setError(true);
    }
    finally { s.busy = false; }
  }, [fetchPage, key]);
  const more = useCallback(() => load(false), [load]);
  const retry = useCallback(() => load(true), [load]);
  return { items, setItems, done, error, more, retry };
}
