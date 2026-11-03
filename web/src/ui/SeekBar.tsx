import { useEffect, useRef, useState, type RefObject } from "react";
import { bufferedAhead } from "../feed/mediaBuffer";
import { createSeekSession } from "../player/seek";
import { SeekPreview } from "./SeekPreview";
import type { ClipBounds } from "../player/clipRange";

export function SeekBar({ video, source, mediaId, enabled = true, duration: fallback = 0, bounds }: {
  video: RefObject<HTMLVideoElement | null>; source: string; mediaId: string; enabled?: boolean; duration?: number; bounds?: ClipBounds | null;
}) {
  const [time, setTime] = useState(0), [duration, setDuration] = useState(fallback), [target, setTarget] = useState<number | null>(null);
  const [bufferEnd, setBufferEnd] = useState(0);
  const session = useRef<ReturnType<typeof createSeekSession> | null>(null);
  const targetRef = useRef(0);
  useEffect(() => {
    const el = video.current;
    const update = () => { setTime(el?.currentTime || 0); setBufferEnd(el ? el.currentTime + bufferedAhead(el) : 0); setDuration(Number.isFinite(el?.duration) ? el!.duration : fallback); };
    const cancel = () => { session.current?.cancel(); session.current = null; setTarget(null); };
    update();
    const events = ["timeupdate", "loadedmetadata", "durationchange", "seeked", "progress"];
    events.forEach(name => el?.addEventListener(name, update));
    const visibility = () => { if (document.hidden) cancel(); };
    document.addEventListener("visibilitychange", visibility);
    el?.addEventListener("pause", cancel);
    if (!enabled) cancel();
    return () => { cancel(); el?.removeEventListener("pause", cancel); events.forEach(name => el?.removeEventListener(name, update)); document.removeEventListener("visibilitychange", visibility); };
  }, [video, source, enabled, fallback, bounds?.start, bounds?.end]);
  const change = (value: number) => {
    if (!enabled || !video.current) return;
    targetRef.current = value;
    if (session.current) session.current.move(value);
    else { const s = createSeekSession(video.current, () => {}, bounds ?? undefined); s.commit(value); }
  };
  const value = target ?? time;
  const minimum = bounds?.start ?? 0, maximum = bounds?.end ?? duration;
  const percent = (at: number) => maximum > minimum ? Math.max(0, Math.min(100, (at - minimum) / (maximum - minimum) * 100)) : 0;
  return <div className="relative h-9 w-full touch-none" onClick={event => event.stopPropagation()}>
    <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 overflow-hidden rounded-full bg-white/25"><div className="absolute inset-y-0 left-0 bg-white/35" style={{ width: `${percent(bufferEnd)}%` }} /><div className="relative h-full bg-white" style={{ width: `${percent(value)}%` }} /></div>
    <input type="range" aria-label="播放进度" aria-valuetext={`${Math.floor(value)} 秒`} min={minimum} max={maximum || 0} step={0.1} value={Math.max(minimum, Math.min(value, maximum || 0))} disabled={!enabled || maximum <= minimum}
      onPointerDown={event => { if (!enabled || !video.current) return; event.currentTarget.setPointerCapture?.(event.pointerId); targetRef.current = Number(event.currentTarget.value); session.current = createSeekSession(video.current, setTarget, bounds ?? undefined); setTarget(targetRef.current); }}
      onInput={event => change(Number(event.currentTarget.value))}
      onChange={() => {}}
      onPointerUp={() => { session.current?.commit(targetRef.current); session.current = null; setTime(video.current?.currentTime ?? 0); setTarget(null); }}
      onPointerCancel={() => { session.current?.cancel(); session.current = null; setTarget(null); }}
      className="absolute inset-0 h-full w-full cursor-pointer opacity-0" />
    <SeekPreview id={mediaId} time={value} enabled={enabled && target !== null} />
  </div>;
}
