import { useEffect, useRef, useState, type RefObject } from "react";
import { createSeekSession, seekIntent } from "./seek";
import type { ClipBounds } from "./clipRange";

export function useHorizontalSeek(video: RefObject<HTMLVideoElement | null>, source: string, enabled: boolean, bounds?: ClipBounds | null) {
  const [target, setTarget] = useState<number | null>(null);
  const press = useRef<{ x: number; y: number; at: number; width: number; session?: ReturnType<typeof createSeekSession> } | null>(null);
  const cancel = () => { press.current?.session?.cancel(); press.current = null; setTarget(null); };
  useEffect(() => {
    cancel();
    const hide = () => { if (document.hidden) cancel(); };
    document.addEventListener("visibilitychange", hide);
    const el = video.current;
    el?.addEventListener("pause", cancel);
    return () => { cancel(); el?.removeEventListener("pause", cancel); document.removeEventListener("visibilitychange", hide); };
  }, [source, enabled, bounds?.start, bounds?.end]);
  const length = () => bounds ? bounds.end - bounds.start : video.current?.duration ?? 0;
  return {
    target,
    down(x: number, y: number) {
      if (!enabled || !video.current || !(video.current.duration > 0)) return;
      press.current = { x, y, at: video.current.currentTime, width: video.current.getBoundingClientRect().width || window.innerWidth };
    },
    move(x: number, y: number) {
      const p = press.current, el = video.current;
      if (!p || !el || !enabled) return false;
      const intent = seekIntent(x - p.x, y - p.y);
      if (!p.session) {
        if (intent === "vertical") { cancel(); return false; }
        if (intent !== "horizontal") return false;
        p.session = createSeekSession(el, setTarget, bounds ?? undefined);
      }
      p.session.move(p.at + (x - p.x) / p.width * length());
      return true;
    },
    up(x: number, y: number) {
      const p = press.current;
      if (!p?.session) { cancel(); return false; }
      if (video.current && enabled) p.session.commit(p.at + (x - p.x) / p.width * length());
      void y; cancel(); return true;
    },
    cancel,
  };
}
