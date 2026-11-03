import { CircleNotchIcon } from "@phosphor-icons/react";
import { useEffect, useState, type RefObject } from "react";
import { bufferedAhead } from "../feed/mediaBuffer";

/** A loading hint, never a simulated transfer counter or a playback control. */
export function LoadingFeedback({ video, source, waiting, enabled }: {
  video: RefObject<HTMLVideoElement | null>; source: string; waiting: boolean; enabled: boolean;
}) {
  const [shownFor, setShownFor] = useState<string | null>(null);
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    setShownFor(null);
    setSeconds(0);
    if (!waiting || !enabled) return;
    const el = video.current;
    if (!el) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const measure = () => {
      const matchesSource = el.currentSrc === new URL(source, document.baseURI).href;
      setSeconds(matchesSource ? Math.floor(bufferedAhead(el) * 10) / 10 : 0);
    };
    const visibility = () => {
      clearTimeout(timer);
      setShownFor(null);
      if (document.visibilityState === "hidden") return;
      timer = setTimeout(() => { measure(); setShownFor(source); }, 200);
    };
    const events = ["progress", "timeupdate", "loadedmetadata", "durationchange", "seeking", "seeked", "emptied"];
    events.forEach(event => el.addEventListener(event, measure));
    document.addEventListener("visibilitychange", visibility);
    visibility();
    return () => {
      clearTimeout(timer);
      events.forEach(event => el.removeEventListener(event, measure));
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [video, source, waiting, enabled]);

  if (!enabled || !waiting || shownFor !== source) return null;
  return (
    <div role="status" aria-label="视频正在加载"
      className="pointer-events-none absolute left-1/2 top-1/2 z-10 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-2 rounded-2xl bg-black/65 px-5 py-4 text-center text-[13px] text-white/90 backdrop-blur-sm">
      <CircleNotchIcon size={30} aria-hidden="true" className="animate-spin motion-reduce:animate-none" />
      <span>正在加载…</span>
      {seconds > 0 && <span aria-live="off" className="whitespace-nowrap tabular-nums text-white/65">已缓冲 {seconds.toFixed(1)} 秒</span>}
    </div>
  );
}
