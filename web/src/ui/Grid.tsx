import { EyeIcon, EyeSlashIcon, StarIcon } from "@phosphor-icons/react";
import { motion } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Media } from "../api";
import { setPref, usePrefs } from "../prefs";
import { addToQueue, getQueue } from "../queue";
import { useRatings } from "../ratings";
import { toast } from "./toast";
import { PreviewButton } from "./SeekPreview";
import { SPRING_TAP, SPRING_UI, waveDelay } from "./motion";

export function formatDuration(seconds: number | null): string {
  if (!seconds || !Number.isFinite(seconds)) return "";
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`;
}

/** A wall of covers; reaching its end asks for the next page. ``progress`` maps id to seconds watched. */
export function Grid({ items, onOpen, onEnd, done, error, onRetry, wide, progress }: {
  items: Media[]; onOpen: (index: number, at?: number) => void; onEnd: () => void; done: boolean; error?: boolean;
  onRetry?: () => void; wide?: boolean; progress?: Map<string, number>;
}) {
  const prefs = usePrefs();
  const ratings = useRatings();
  const [peeking, setPeeking] = useState<string | null>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || done || error) return;
    const observer = new IntersectionObserver(entries => { if (entries[0]?.isIntersecting) onEnd(); }, { rootMargin: "600px" });
    observer.observe(el);
    return () => observer.disconnect();
  }, [onEnd, done, error, items.length]);
  return (
    <>
      <div className={`grid gap-2.5 ${wide ? "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4" : "grid-cols-3 sm:grid-cols-4 lg:grid-cols-6"}`}>
        {items.map((item, index) => {
          const blurred = prefs.coverBlur && !(prefs.peekOnHold && peeking === item.id);
          const stars = ratings[item.id] ?? 0;
          return (
            <motion.div key={item.id}
              initial={index < 12 ? { opacity: 0, y: 14, scale: 0.96 } : false}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              transition={{ ...SPRING_UI, delay: index < 12 ? waveDelay(index, 11) : 0 }}
              className="group relative min-w-0">
              <motion.button type="button" onClick={() => onOpen(index)} aria-label={`播放第 ${index + 1} 个视频`}
                whileTap={{ scale: 0.96 }} transition={SPRING_TAP}
                onPointerEnter={e => { if (prefs.coverBlur && prefs.peekOnHold && e.pointerType === "mouse") setPeeking(item.id); }}
                onPointerLeave={() => { if (peeking === item.id) setPeeking(null); }}
                onPointerDown={() => { if (prefs.coverBlur && prefs.peekOnHold) setPeeking(item.id); }}
                onPointerUp={() => { if (peeking === item.id) setPeeking(null); }}
                onPointerCancel={() => { if (peeking === item.id) setPeeking(null); }}
                className={`luxury-card sheen-overlay relative block w-full rounded-[16px] ${wide ? "aspect-video" : "aspect-[3/4]"}`}>
                {item.cover_url && <Cover src={item.cover_url}
                  className={`size-full object-cover transition-[filter,transform] duration-300 ease-out group-hover:scale-[1.05] ${blurred ? "blur-xl scale-110" : ""}`} />}
                <span aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-black/80 via-black/25 to-transparent" />
                {stars > 0 && (
                  <span className="glass-pill absolute bottom-1.5 left-1.5 inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-gold-bright">
                    <StarIcon size={10} weight="fill" />{stars}
                  </span>
                )}
                <span className="glass-pill absolute bottom-1.5 right-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium tabular-nums text-ink">{formatDuration(item.duration_seconds)}</span>
                <WatchedBar seconds={progress?.get(item.id)} duration={item.duration_seconds} />
              </motion.button>
              <PreviewButton media={item} onPlay={at => onOpen(index, at)} />
              <button type="button" aria-label={`加入待播第 ${index + 1} 个视频`}
                onClick={() => toast(addToQueue(item) ? "已加入待播队列" : getQueue().length >= 100 ? "队列已满，最多100个" : "已在待播队列中")}
                className="glass-pill pressable absolute left-1.5 top-1.5 min-h-8 rounded-full px-2.5 text-[11px] font-medium text-ink/95 hover:border-gold/40">待播</button>
            </motion.div>
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

/** A cover that asks again, after a growing pause, when the server was busy (it turns covers away rather than queue them). */
export function Cover({ src, className }: { src: string; className: string }) {
  const [attempt, setAttempt] = useState(0);
  useEffect(() => setAttempt(0), [src]);
  return <img key={attempt} src={src} alt="" loading="lazy" decoding="async" className={className}
    onError={() => { if (attempt < COVER_RETRIES) setTimeout(() => setAttempt(n => n + 1), 1500 * 2 ** attempt + Math.random() * 500); }} />;
}

type Change = { id: string; favorite?: boolean; premium?: boolean; cover_url?: string | null } | { id: string; removed: true };
const changeListeners = new Set<(change: Change) => void>();

/** Tell every wall on the page that a video was favorited or deleted somewhere else (a player, the clip list). */
export function announce(change: Change): void {
  changeListeners.forEach(listener => listener(change));
}

export function subscribeMediaChanges(listener: (change: Change) => void) {
  changeListeners.add(listener); return () => { changeListeners.delete(listener); };
}

/** How far into a video the owner got, as a thin line along the bottom of its cover. */
export function WatchedBar({ seconds, duration }: { seconds: number | undefined; duration: number | null }) {
  if (!seconds || !duration) return null;
  return (
    <span className="absolute inset-x-0 bottom-0 h-[3px] bg-white/18">
      <span className="block h-full rounded-r-full bg-gradient-to-r from-gold to-gold-bright shadow-[0_0_8px_rgba(230,198,135,0.65)]" style={{ width: `${Math.min(100, (seconds / duration) * 100)}%` }} />
    </span>
  );
}

export function BlurToggle() {
  const prefs = usePrefs();
  return (
    <motion.button type="button" onClick={() => setPref("coverBlur", !prefs.coverBlur)} aria-label={prefs.coverBlur ? "显示封面" : "模糊封面"}
      whileTap={{ scale: 0.88 }} transition={SPRING_TAP}
      className={`ios-card grid size-10 shrink-0 place-items-center rounded-full transition-colors ${prefs.coverBlur ? "border-gold/35 text-gold-bright" : "text-muted hover:text-ink"}`}>
      {prefs.coverBlur ? <EyeSlashIcon size={19} weight="fill" /> : <EyeIcon size={19} />}
    </motion.button>
  );
}

/** Pages of media from a cursor- or offset-based endpoint, loaded on demand. */
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
