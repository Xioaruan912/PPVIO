import { useEffect, useRef, useState, type RefObject } from "react";
import { bufferedAhead } from "../feed/mediaBuffer";

export interface Clip { key: string; start: number; end?: number | null }
export interface ClipBounds { start: number; end: number }
export function resolveClipRange(clip: Clip, duration: number): ClipBounds | null {
  const end = clip.end ?? clip.start + 20;
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(clip.start) || clip.start < 0 || clip.start >= duration || !Number.isFinite(end) || end <= clip.start) return null;
  return { start: clip.start, end: Math.min(end, duration) };
}

export function clipPreloadReady(video: HTMLVideoElement, range: ClipBounds, allowed: boolean) {
  if (video.readyState < 3 || video.seeking || video.currentTime < range.start || video.currentTime >= range.end) return false;
  const ahead = Math.min(bufferedAhead(video), range.end - video.currentTime);
  const high = Math.min(4, Math.max(0.5, (range.end - range.start) / 3));
  return ahead + 0.05 >= Math.min(range.end - video.currentTime, allowed ? Math.min(1.5, high / 3) : high);
}

export function useClipRange(video: RefObject<HTMLVideoElement | null>, source: string, enabled: boolean, clip?: Clip, playing = true, active = true) {
  const [range, setRange] = useState<ClipBounds | null>(null), [invalid, setInvalid] = useState(false);
  const initialized = useRef("");
  const key = clip?.key, start = clip?.start, end = clip?.end;
  useEffect(() => {
    const el = video.current;
    if (!el || !clip || !enabled) { setRange(null); setInvalid(false); return; }
    const identity = JSON.stringify([source, key, start, end, active]); let live = true, frame = 0;
    const synchronize = () => {
      if (!live || document.hidden || el.getAttribute("src") !== source || el.readyState < 1) return;
      const bounds = resolveClipRange(clip, el.duration);
      setRange(previous => previous?.start === bounds?.start && previous?.end === bounds?.end ? previous : bounds);
      setInvalid(!bounds);
      if (!bounds) { if (!el.paused) el.pause(); return; }
      const first = initialized.current !== identity;
      if (first || (playing && (el.currentTime < bounds.start || el.currentTime >= bounds.end))) {
        const ended = el.ended;
        initialized.current = identity;
        el.currentTime = bounds.start;
        if (ended && playing) void el.play().catch(() => {});
      }
    };
    const tick = () => { synchronize(); if (live) frame = requestAnimationFrame(tick); };
    const metadata = () => { initialized.current = ""; synchronize(); };
    el.addEventListener("loadedmetadata", metadata);
    const events = ["durationchange", "timeupdate", "ended"];
    events.forEach(name => el.addEventListener(name, synchronize)); synchronize(); if (playing) frame = requestAnimationFrame(tick);
    return () => { live = false; cancelAnimationFrame(frame); el.removeEventListener("loadedmetadata", metadata); events.forEach(name => el.removeEventListener(name, synchronize)); };
  }, [source, enabled, key, start, end, playing, active]);
  return { range, invalid };
}
