import { useEffect, useRef, useState, type RefObject } from "react";
import { createSeekSession, seekIntent } from "./seek";

export function useHorizontalSeek(video: RefObject<HTMLVideoElement | null>, source: string, enabled: boolean) {
  const [target, setTarget] = useState<number | null>(null);
  const press = useRef<{ x: number; y: number; at: number; width: number; session?: ReturnType<typeof createSeekSession> } | null>(null);
  const cancel = () => { press.current?.session?.cancel(); press.current = null; setTarget(null); };
  useEffect(() => {
    cancel();
    const hide = () => { if (document.hidden) cancel(); };
    document.addEventListener("visibilitychange", hide);
    return () => { cancel(); document.removeEventListener("visibilitychange", hide); };
  }, [source, enabled]);
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
        p.session = createSeekSession(el, setTarget);
      }
      p.session.move(p.at + (x - p.x) / p.width * el.duration);
      return true;
    },
    up(x: number, y: number) {
      const p = press.current;
      if (!p?.session) { cancel(); return false; }
      if (video.current && enabled) p.session.commit(p.at + (x - p.x) / p.width * video.current.duration);
      void y; cancel(); return true;
    },
    cancel,
  };
}
