import { useEffect, useRef, useState, type RefObject } from "react";
import { diagnoseFailure, type PlaybackFailure } from "./recovery";

export function usePlaybackRecovery(video: RefObject<HTMLVideoElement | null>, source: string, enabled: boolean) {
  const [failure, setFailure] = useState<PlaybackFailure | null>(null);
  const [retrying, setRetrying] = useState(false);
  const retryRef = useRef<() => void>(() => {});
  const pending = useRef<{ source: string; position: number; wantedPlay: boolean } | null>(null);
  useEffect(() => {
    const el = video.current;
    if (!el) return;
    if (pending.current?.source !== source) pending.current = null;
    const originalAutoplay = el.autoplay;
    let live = true, tries = 0, saved = pending.current?.position ?? 0, restoring = !!pending.current, wantedPlay = pending.current?.wantedPlay ?? !el.paused;
    let timer: ReturnType<typeof setTimeout> | undefined, diagnosis: AbortController | undefined;
    const originalSource = el.getAttribute("src");
    const current = () => live && enabled && !document.hidden && el.getAttribute("src") === originalSource;
    const clear = () => { clearTimeout(timer); diagnosis?.abort(); };
    const retry = () => {
      if (!current()) return;
      diagnosis?.abort(); setRetrying(true); restoring = true;
      pending.current = { source, position: saved, wantedPlay };
      try { el.autoplay = false; el.load(); } catch { setRetrying(false); }
    };
    retryRef.current = () => { clear(); tries = 0; if (el.currentTime > 0 || !restoring) saved = el.currentTime || 0; if (!el.error) wantedPlay = !el.paused; retry(); };
    const failed = async () => {
      if (!current()) return;
      clear(); saved = Math.max(0, el.currentTime || saved); setRetrying(false);
      const request = new AbortController(); diagnosis = request;
      try {
        const result = await diagnoseFailure(source, el.error?.code, request.signal);
        if (!current() || request.signal.aborted) return;
        setFailure(result);
        if (result.kind === "network" && result.retryable && tries < 2) {
          timer = setTimeout(() => { tries++; retry(); }, [1000, 3000][tries]);
        }
      } catch { /* An obsolete diagnosis is cancelled when the clip leaves. */ }
    };
    const metadata = () => {
      if (!restoring || !current()) return;
      restoring = false; pending.current = null;
      try { el.currentTime = Math.min(saved, Number.isFinite(el.duration) ? el.duration : saved); } catch { /* Wait for usable metadata. */ }
      if (wantedPlay) void el.play().catch(() => { if (current()) { setRetrying(false); setFailure({ kind: "unknown", message: "请点击画面继续播放", retryable: false }); } });
      else { el.pause(); setRetrying(false); setFailure(null); }
    };
    const playing = () => { if (!current()) return; el.autoplay = originalAutoplay; pending.current = null; wantedPlay = true; saved = 0; tries = 0; clear(); if (current()) { setFailure(null); setRetrying(false); } };
    const pause = () => { if (!el.error && !restoring) wantedPlay = false; };
    const synchronize = () => {
      if (!current()) return;
      if (el.error) void failed();
      else if (restoring && el.readyState >= 1) metadata();
    };
    const hidden = () => { if (document.hidden) { clear(); setRetrying(false); } else synchronize(); };
    setFailure(null); setRetrying(false);
    el.addEventListener("error", failed); el.addEventListener("loadedmetadata", metadata);
    el.addEventListener("playing", playing); el.addEventListener("pause", pause);
    document.addEventListener("visibilitychange", hidden);
    synchronize();
    return () => { live = false; clear(); retryRef.current = () => {}; el.removeEventListener("error", failed); el.removeEventListener("loadedmetadata", metadata); el.removeEventListener("playing", playing); el.removeEventListener("pause", pause); document.removeEventListener("visibilitychange", hidden); };
  }, [source, enabled]);
  return { failure, retrying, retry: () => retryRef.current() };
}

export function RecoveryNotice({ failure, retrying, retry, compatible }: {
  failure: PlaybackFailure | null; retrying: boolean; retry: () => void; compatible?: () => void;
}) {
  if (!failure) return null;
  return <div className="absolute inset-x-0 top-1/2 z-10 -translate-y-1/2 px-6 text-center text-sm text-white" role="alert">
    <p className="mx-auto max-w-sm rounded-lg bg-black/65 px-3 py-2">{retrying ? "正在重新加载，保留播放位置…" : failure.message}</p>
    <div className="mt-2 flex justify-center gap-2">
      {failure.kind === "auth" ? <button type="button" className="rounded-full bg-white/20 px-4 py-2" onClick={() => window.location.reload()}>重新登录</button>
        : <button type="button" disabled={retrying} className="rounded-full bg-white/20 px-4 py-2 disabled:opacity-50" onClick={retry}>重新加载</button>}
      {compatible && failure.kind === "codec" && <button type="button" className="rounded-full bg-white/20 px-4 py-2" onClick={compatible}>换低清试试</button>}
    </div>
  </div>;
}
