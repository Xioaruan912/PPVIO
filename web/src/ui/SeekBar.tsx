import { useEffect, useRef, useState, type RefObject } from "react";
import { bufferedAhead } from "../feed/mediaBuffer";
import { createSeekSession } from "../player/seek";
import { SeekPreview } from "./SeekPreview";

export function SeekBar({ video, source, mediaId, enabled = true, duration: fallback = 0 }: {
  video: RefObject<HTMLVideoElement | null>; source: string; mediaId: string; enabled?: boolean; duration?: number;
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
    if (!enabled) cancel();
    return () => { cancel(); events.forEach(name => el?.removeEventListener(name, update)); document.removeEventListener("visibilitychange", visibility); };
  }, [video, source, enabled, fallback]);
  const change = (value: number) => {
    if (!enabled || !video.current) return;
    targetRef.current = value;
    if (session.current) session.current.move(value);
    else { const s = createSeekSession(video.current, () => {}); s.commit(value); }
  };
  const value = target ?? time;
  return <div className="relative h-9 w-full touch-none" onClick={event => event.stopPropagation()}>
    <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 overflow-hidden rounded-full bg-white/25"><div className="absolute inset-y-0 left-0 bg-white/35" style={{ width: `${duration > 0 ? Math.min(100, bufferEnd / duration * 100) : 0}%` }} /><div className="relative h-full bg-white" style={{ width: `${duration > 0 ? Math.min(100, value / duration * 100) : 0}%` }} /></div>
    <input type="range" aria-label="播放进度" aria-valuetext={`${Math.floor(value)} 秒`} min={0} max={duration || 0} step={0.1} value={Math.min(value, duration || 0)} disabled={!enabled || duration <= 0}
      onPointerDown={event => { if (!enabled || !video.current) return; event.currentTarget.setPointerCapture?.(event.pointerId); targetRef.current = Number(event.currentTarget.value); session.current = createSeekSession(video.current, setTarget); setTarget(targetRef.current); }}
      onInput={event => change(Number(event.currentTarget.value))}
      onChange={() => {}}
      onPointerUp={() => { session.current?.commit(targetRef.current); session.current = null; setTime(targetRef.current); setTarget(null); }}
      onPointerCancel={() => { session.current?.cancel(); session.current = null; setTarget(null); }}
      className="absolute inset-0 h-full w-full cursor-pointer opacity-0" />
    <SeekPreview id={mediaId} time={value} enabled={enabled && target !== null} />
  </div>;
}
