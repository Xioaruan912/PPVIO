import { useEffect, type RefObject } from "react";
import type { Media } from "../api";
import { experienceApi, getHistorySettings, refreshHistorySettings, subscribeHistorySettings, type HistorySettings } from "../experienceApi";

export function usePlaybackHistory(video: RefObject<HTMLVideoElement | null>, media: Media, source: string, enabled: boolean) {
  useEffect(() => {
    const el = video.current;
    if (!enabled || !el) return;
    let live = true, invalidated = false, settings: HistorySettings | null = null;
    let elapsed = 0, previous = Date.now(), wasPlaying = false, buffering = false;
    let lastPosition = el.currentTime || 0, previousPosition = lastPosition, lastWrite = -Infinity;
    const controller = new AbortController();
    const allowed = () => live && !invalidated && settings?.enabled && getHistorySettings()?.enabled
      && getHistorySettings()?.epoch === settings.epoch;
    const record = (closing = false) => {
      if (!allowed() || elapsed < 2000 || Date.now() - lastWrite < (closing ? 500 : 15_000)) return;
      lastWrite = Date.now();
      void experienceApi.recordHistory({ media_id: media.id, position_seconds: Math.max(0, lastPosition), epoch: settings!.epoch }, undefined, closing).catch(() => {});
    };
    const tick = () => {
      const now = Date.now(), position = el.currentTime, playing = !buffering && !document.hidden && !el.paused && !el.seeking && el.readyState >= 2 && el.getAttribute("src") === source;
      const advanced = position - previousPosition;
      if (wasPlaying && !el.seeking && advanced > 0) {
        elapsed += Math.min(1000, Math.max(0, now - previous), advanced * 1000 / (el.playbackRate || 1));
      }
      previous = now; previousPosition = position; wasPlaying = playing;
      if (el.getAttribute("src") === source && el.readyState >= 1 && Number.isFinite(el.currentTime)) lastPosition = el.currentTime;
      if (playing) record();
    };
    const flush = () => { tick(); record(true); };
    const waiting = () => { tick(); buffering = true; wasPlaying = false; };
    const playing = () => { buffering = false; tick(); };
    const unsubscribe = subscribeHistorySettings(() => {
      const latest = getHistorySettings();
      if (settings && (!latest?.enabled || latest.epoch !== settings.epoch)) invalidated = true;
    });
    void refreshHistorySettings(controller.signal).then(value => {
      if (!live) return;
      settings = value; previous = Date.now(); previousPosition = el.currentTime; wasPlaying = !buffering && !document.hidden && !el.paused && !el.seeking && el.readyState >= 2;
    }).catch(() => {});
    const timer = setInterval(tick, 500);
    el.addEventListener("waiting", waiting); el.addEventListener("stalled", waiting); el.addEventListener("playing", playing);
    el.addEventListener("pause", flush); el.addEventListener("timeupdate", tick);
    document.addEventListener("visibilitychange", flush); window.addEventListener("pagehide", flush);
    return () => {
      flush(); live = false; controller.abort(); clearInterval(timer); unsubscribe();
      el.removeEventListener("waiting", waiting); el.removeEventListener("stalled", waiting); el.removeEventListener("playing", playing);
      el.removeEventListener("pause", flush); el.removeEventListener("timeupdate", tick);
      document.removeEventListener("visibilitychange", flush); window.removeEventListener("pagehide", flush);
    };
  }, [video, media.id, media.clip?.key, source, enabled]);
}
