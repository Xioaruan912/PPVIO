import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { Media } from "../api";
import { allowNextPreload, bufferedAhead } from "./mediaBuffer";
import { clipPreloadReady, resolveClipRange } from "../player/clipRange";

export type BufferReadiness = (id: string, src: string, ready: boolean) => void;

export function useFeedPlayback(video: RefObject<HTMLVideoElement | null>, options: {
  media: Media; src: string; active: boolean; mounted: boolean; eager: boolean; paused: boolean; locked: boolean;
  onPause: () => void; onBufferReadiness?: BufferReadiness; original?: boolean;
}) {
  const { media, src, active, mounted, eager, paused, locked, onPause, onBufferReadiness, original = false } = options;
  const preloadStarted = useRef(false);
  const [visible, setVisible] = useState(document.visibilityState !== "hidden");
  useEffect(() => {
    const change = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", change);
    return () => document.removeEventListener("visibilitychange", change);
  }, []);

  // Capture the removed node: by passive-effect cleanup time React may have replaced it.
  const attachVideo = useCallback((el: HTMLVideoElement | null) => {
    video.current = el;
    if (!el) return;
    preloadStarted.current = false;
    // StrictMode replays ref cleanup on the same node; restore the removed source.
    if (el.getAttribute("src") !== src) el.setAttribute("src", src);
    return () => {
      video.current = null;
      el.pause();
      el.removeAttribute("src");
      el.load();
    };
  }, [video, src]);

  useEffect(() => {
    const el = video.current;
    if (!el || active || !mounted || !eager || locked || !visible || preloadStarted.current) return;
    preloadStarted.current = true;
    // Mobile Chromium can leave metadata fetching suspended after preload changes.
    // Restart once, before this clip becomes visible; keep buffers on later fluctuations.
    if (bufferedAhead(el) < 2) el.load();
  }, [video, active, mounted, eager, locked, visible, src]);

  useEffect(() => {
    const el = video.current;
    if (!el || !mounted) return;
    let obsolete = false;
    const play = () => {
      void el.play().catch((error: unknown) => {
        if (!obsolete && !(error instanceof DOMException && error.name === "AbortError")) onPause();
      });
    };
    if (active && !paused && !locked && visible) {
      play();
      el.addEventListener("canplay", play);
    } else el.pause();
    return () => { obsolete = true; el.removeEventListener("canplay", play); };
  }, [video, active, mounted, paused, locked, visible, src, onPause]);

  useEffect(() => {
    const el = video.current;
    if (!active || !el || !mounted) return;
    let allowed = false;
    // The original's bitrate is not the selected rendition's bitrate.
    const bytesPerSecond = src === media.stream_url && media.duration_seconds
      ? (media.size_bytes ?? 0) / media.duration_seconds : 0;
    const publish = (ready: boolean) => {
      allowed = ready;
      onBufferReadiness?.(media.clip?.key ?? media.id, src, ready);
    };
    const update = () => {
      const range = media.clip ? resolveClipRange(media.clip, el.duration) : null;
      publish(el.currentSrc === new URL(src, document.baseURI).href
        && !paused && !locked && visible && !el.paused
        && (media.clip && !original ? !!range && clipPreloadReady(el, range, allowed) : allowNextPreload(el, allowed, bytesPerSecond)));
    };
    const wait = () => publish(false);
    const updates = ["progress", "timeupdate", "playing", "canplay", "seeked", "ratechange"];
    const waits = ["waiting", "stalled", "seeking", "pause", "error", "emptied"];
    updates.forEach(event => el.addEventListener(event, update));
    waits.forEach(event => el.addEventListener(event, wait));
    update();
    return () => {
      updates.forEach(event => el.removeEventListener(event, update));
      waits.forEach(event => el.removeEventListener(event, wait));
    };
  }, [video, active, mounted, paused, locked, visible, src, media.id,
    media.stream_url, media.size_bytes, media.duration_seconds, media.clip?.key, media.clip?.start, media.clip?.end, original, onBufferReadiness]);

  return { attachVideo, visible };
}
