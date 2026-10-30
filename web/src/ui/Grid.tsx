import { EyeIcon, EyeSlashIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import type { Media } from "../api";
import { setPref, usePrefs } from "../prefs";

export function formatDuration(seconds: number | null): string {
  if (!seconds || !Number.isFinite(seconds)) return "";
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`;
}

/** A wall of covers; reaching its end asks for the next page. ``progress`` maps id to seconds watched. */
export function Grid({ items, onOpen, onEnd, done, wide, progress }: {
  items: Media[]; onOpen: (index: number) => void; onEnd: () => void; done: boolean; wide?: boolean; progress?: Map<string, number>;
}) {
  const prefs = usePrefs();
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || done) return;
    const observer = new IntersectionObserver(entries => { if (entries[0]?.isIntersecting) onEnd(); }, { rootMargin: "600px" });
    observer.observe(el);
    return () => observer.disconnect();
  }, [onEnd, done, items.length]);
  return (
    <>
      <div className={`grid gap-1.5 ${wide ? "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4" : "grid-cols-3 sm:grid-cols-4 lg:grid-cols-6"}`}>
        {items.map((item, index) => (
          <button key={item.id} type="button" onClick={() => onOpen(index)} aria-label={`播放第 ${index + 1} 个视频`}
            className={`relative overflow-hidden rounded-[10px] bg-surface ${wide ? "aspect-video" : "aspect-[3/4]"}`}>
            {item.cover_url && <Cover src={item.cover_url}
              className={`size-full object-cover transition-[filter] duration-300 ${prefs.coverBlur ? "blur-xl scale-110" : ""}`} />}
            <span className="absolute bottom-1 right-1.5 rounded bg-black/55 px-1 text-[11px] tabular-nums text-white">{formatDuration(item.duration_seconds)}</span>
            <WatchedBar seconds={progress?.get(item.id)} duration={item.duration_seconds} />
          </button>
        ))}
      </div>
      {!done && <div ref={sentinel} className="h-10" />}
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

type Change = { id: string; favorite: boolean } | { id: string; removed: true };
const changeListeners = new Set<(change: Change) => void>();

/** Tell every wall on the page that a video was favorited or deleted somewhere else (a player, the clip list). */
export function announce(change: Change): void {
  changeListeners.forEach(listener => listener(change));
}

/** How far into a video the owner got, as a thin line along the bottom of its cover. */
export function WatchedBar({ seconds, duration }: { seconds: number | undefined; duration: number | null }) {
  if (!seconds || !duration) return null;
  return (
    <span className="absolute inset-x-0 bottom-0 h-[3px] bg-white/25">
      <span className="block h-full bg-accent" style={{ width: `${Math.min(100, (seconds / duration) * 100)}%` }} />
    </span>
  );
}

export function BlurToggle() {
  const prefs = usePrefs();
  return (
    <button type="button" onClick={() => setPref("coverBlur", !prefs.coverBlur)} aria-label={prefs.coverBlur ? "显示封面" : "模糊封面"}
      className="grid size-10 place-items-center rounded-full bg-surface text-muted">
      {prefs.coverBlur ? <EyeSlashIcon size={20} /> : <EyeIcon size={20} />}
    </button>
  );
}

/** Pages of media from a cursor- or offset-based endpoint, loaded on demand. */
export function usePages(fetchPage: (cursor: string | null, offset: number) => Promise<{ items: Media[]; has_more: boolean; next_cursor?: string | null }>, key: string) {
  const [items, setItems] = useState<Media[]>([]);
  const [done, setDone] = useState(false);
  const [error, setError] = useState(false);
  const state = useRef({ cursor: null as string | null, busy: false, key });
  useEffect(() => {
    const apply = (change: Change) => setItems(list => "removed" in change
      ? list.filter(m => m.id !== change.id)
      : list.map(m => m.id === change.id ? { ...m, favorite: change.favorite } : m));
    changeListeners.add(apply);
    return () => { changeListeners.delete(apply); };
  }, []);
  useEffect(() => { state.current = { cursor: null, busy: false, key }; setItems([]); setDone(false); setError(false); }, [key]);
  const more = async () => {
    const s = state.current;
    if (s.busy || done) return;
    s.busy = true;
    try {
      const page = await fetchPage(s.cursor, items.length);
      if (state.current.key !== s.key) return;
      s.cursor = page.next_cursor ?? null;
      setItems(list => { const seen = new Set(list.map(m => m.id)); return [...list, ...page.items.filter(m => !seen.has(m.id))]; });
      if (!page.has_more || !page.items.length) setDone(true);
    } catch { setError(true); setDone(true); }
    finally { s.busy = false; }
  };
  return { items, setItems, done, error, more };
}
