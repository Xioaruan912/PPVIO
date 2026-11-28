import {
  ArrowClockwiseIcon, ArrowCounterClockwiseIcon, CaretLeftIcon, CornersOutIcon, DotsThreeIcon,
  DeviceRotateIcon, FrameCornersIcon, LockSimpleIcon, LockSimpleOpenIcon, PauseIcon,
  PictureInPictureIcon, PlayIcon, RepeatIcon, SpeakerHighIcon, SpeakerSlashIcon, SunDimIcon,
} from "@phosphor-icons/react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { api, chooseStream, type Media } from "../api";
import { mediaTools } from "../mediaTools";
import { GestureRecognizer } from "../feed/gestures";
import { MediaActions } from "../feed/MediaActions";
import { setPref, usePrefs } from "../prefs";
import { setRating, StarRating } from "../ratings";
import { announce, Cover, formatDuration } from "../ui/Grid";
import { setLongPlayback, useLocked } from "../ui/privacy";
import { toast } from "../ui/toast";
import { LoadingFeedback } from "../ui/LoadingFeedback";
import { SeekBar } from "../ui/SeekBar";
import { SeekPreview } from "../ui/SeekPreview";
import { BookmarkButton } from "../ui/Bookmarks";
import { useHorizontalSeek } from "./useHorizontalSeek";
import { usePlaybackRecovery, RecoveryNotice } from "./usePlaybackRecovery";
import { usePlaybackHistory } from "./usePlaybackHistory";
import { QuickTagButton } from "../ui/QuickTags";
import { haptic } from "../ui/haptics";
import { useApertureReveal } from "../ui/gsap";
import { FlutedPrivacyShield } from "../ui/CinemaChrome";
import { prewarmMedia } from "../ui/prewarm";
import { EASE_HUD, SPRING_PILL, SPRING_STAGE, SPRING_TAP } from "../ui/motion";

const SPEEDS = [1, 1.25, 1.5, 2];
const SAVE_EVERY_MS = 10_000;
const NEXT_IN_SECONDS = 5;

export function resumeAt(saved: number | undefined, duration: number | null): number {
  if (!saved || saved < 10) return 0;
  if (duration && saved > duration - 30) return 0;
  return saved;
}

export type PlayerKey = "toggle" | "back" | "forward" | "fullscreen" | "mute" | "close";

export function playerKey(key: string): PlayerKey | null {
  switch (key.length === 1 ? key.toLowerCase() : key) {
    case " ": case "k": return "toggle";
    case "ArrowLeft": case "j": return "back";
    case "ArrowRight": case "l": return "forward";
    case "f": return "fullscreen";
    case "m": return "mute";
    case "Escape": return "close";
    default: return null;
  }
}

type FullscreenVideo = HTMLVideoElement & { webkitEnterFullscreen?: () => void };

/**
 * Unobstructed Long Video Cinema Player:
 * - Dedicated top header & bottom console live OUTSIDE the <video> frame so controls never cover playback
 * - Direct 1-tap 5-star rating right in the bottom console (+ keys 1-5) feeds taste recommendations
 * - Tap the video to enter pure Cinema Zen Mode (hides rails cleanly for 100% black edge-to-edge viewing)
 */
export function LongPlayer({ media, next, onClose, onNext, startAt, continueNext = false }: {
  media: Media; onClose: () => void;
  next?: Media; onNext?: () => void; startAt?: number; continueNext?: boolean;
}) {
  const prefs = usePrefs();
  const locked = useLocked();
  const root = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [controls, setControls] = useState(true);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(media.duration_seconds ?? 0);
  const [speed, setSpeed] = useState(1);
  const [fast, setFast] = useState(false);
  const [loading, setLoading] = useState(true);
  const [jump, setJump] = useState<"back" | "forward" | null>(null);
  const [failed, setFailed] = useState(false);
  const [menu, setMenu] = useState(false);
  const [screenLocked, setScreenLocked] = useState(false);
  const [unlockHint, setUnlockHint] = useState(false);
  const [markers, setMarkers] = useState<number[]>([]);
  const [fillMode, setFillMode] = useState(false);
  const [rotated, setRotated] = useState(false);
  const [loopA, setLoopA] = useState<number | null>(null);
  const [loopB, setLoopB] = useState<number | null>(null);
  const [brightness, setBrightness] = useState(1);
  const [vHud, setVHud] = useState<{ kind: "brightness" | "volume"; value: number } | null>(null);
  const vDrag = useRef<{ kind: "brightness" | "volume"; startY: number; startVal: number; active: boolean } | null>(null);
  const [countdown, setCountdown] = useState<number | null>(null);
  const resume = useRef(startAt ?? 0);
  const src = chooseStream(media, prefs.lowRes);

  useApertureReveal(stage, [media.id]);

  useEffect(() => {
    if (locked) return;
    prewarmMedia(media, prefs.lowRes, { tail: true });
    if (next) prewarmMedia(next, prefs.lowRes, { rangeHead: true });
  }, [media, next, prefs.lowRes, locked]);

  const changeQuality = (low: boolean) => {
    const el = video.current;
    resume.current = el?.currentTime ?? 0;
    if (el) el.autoplay = !el.paused;
    setPref("lowRes", low);
  };
  const hasLow = media.variants.some(v => v.height && v.height < (media.height ?? Infinity));
  const title = media.groups?.[0]?.label ?? "影院放映";
  const pip = document.pictureInPictureEnabled;

  const horizontal = useHorizontalSeek(video, src, !locked && !screenLocked);
  const recovery = usePlaybackRecovery(video, src, !locked);
  usePlaybackHistory(video, media, src, !locked);

  useEffect(() => {
    const controller = new AbortController();
    void mediaTools.bookmarks(media.id, controller.signal)
      .then(r => { if (!controller.signal.aborted) setMarkers(r.items.map(b => b.position_seconds)); })
      .catch(() => undefined);
    return () => controller.abort();
  }, [media.id]);

  useEffect(() => { setLongPlayback(true); return () => setLongPlayback(false); }, []);
  useEffect(() => {
    if (startAt !== undefined) return;
    let live = true;
    void api.longProgress().then(p => {
      if (!live) return;
      resume.current = resumeAt(p.items.find(i => i.id === media.id)?.position_seconds, media.duration_seconds);
      const el = video.current;
      if (el && resume.current && el.readyState >= 1 && el.currentTime < 1) el.currentTime = resume.current;
    }).catch(() => undefined);
    return () => { live = false; };
  }, [media.id, media.duration_seconds, startAt]);
  useEffect(() => { if (locked) video.current?.pause(); }, [locked]);

  useEffect(() => {
    const save = () => {
      const el = video.current;
      if (!el || !(el.currentTime > 0)) return;
      if (el.duration && el.currentTime > el.duration * 0.95) void api.clearProgress(media.id).catch(() => undefined);
      else void api.saveProgress(media.id, Math.floor(el.currentTime)).catch(() => undefined);
    };
    const timer = setInterval(() => { if (!video.current?.paused) save(); }, SAVE_EVERY_MS);
    const hidden = () => { if (document.visibilityState === "hidden") save(); };
    document.addEventListener("visibilitychange", hidden);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", hidden); save(); };
  }, [media.id]);

  const seekBy = (delta: number) => {
    const el = video.current;
    if (el) el.currentTime = Math.max(0, Math.min(el.duration || Infinity, el.currentTime + delta));
  };
  const jumpBy = (forward: boolean) => {
    haptic(10);
    seekBy(forward ? 10 : -10);
    setJump(forward ? "forward" : "back");
    setTimeout(() => setJump(null), 500);
  };
  const toggle = () => { const el = video.current; if (el) void (el.paused ? el.play() : el.pause()); };
  const toggleMute = () => setPref("muted", !prefs.muted);
  const remove = async () => {
    try { await api.remove(media.id); } catch { toast("删除失败，请稍后再试"); return; }
    announce({ id: media.id, removed: true });
    onClose();
    toast("已删除", {
      label: "撤销",
      run: () => void api.restore(media.id).then(({ restored }) => toast(restored ? "已恢复，刷新后可见" : "已经开始删除，无法撤销")),
    }, 6000);
  };

  const fullscreen = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (document.fullscreenEnabled && root.current) {
        await root.current.requestFullscreen();
        await (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }).lock?.("landscape");
      } else (video.current as FullscreenVideo | null)?.webkitEnterFullscreen?.();
    } catch { /* ignore */ }
  };
  const pictureInPicture = async () => {
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await video.current?.requestPictureInPicture();
    } catch { toast("这个浏览器不支持画中画"); }
  };

  const gestures = useRef<GestureRecognizer | null>(null);
  useEffect(() => {
    const g = new GestureRecognizer((event, x) => {
      if (screenLocked) {
        if (event === "tap") setUnlockHint(v => !v);
        return;
      }
      const el = video.current;
      if (event === "tap") setControls(value => !value);
      else if (event === "double-tap") jumpBy(x > window.innerWidth / 2);
      else if (event === "long-press-start" && el && !el.paused) { haptic(10); el.playbackRate = 2; setFast(true); }
      else if (event === "long-press-end" && el) { el.playbackRate = speed; setFast(false); }
    });
    gestures.current = g;
    return () => g.dispose();
  }, [speed, screenLocked]);

  const keys = useRef<(key: PlayerKey) => void>(() => undefined);
  keys.current = key => {
    if (key === "toggle") toggle();
    else if (key === "back" || key === "forward") jumpBy(key === "forward");
    else if (key === "fullscreen") void fullscreen();
    else if (key === "mute") toggleMute();
    else if (!document.fullscreenElement) onClose();
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (menu || event.metaKey || event.ctrlKey || event.altKey) return;
      if (target?.isContentEditable || (target instanceof HTMLInputElement && target.type !== "range")) return;
      if (event.key >= "1" && event.key <= "5") {
        event.preventDefault();
        const n = Number(event.key);
        haptic(n >= 4 ? 12 : 6);
        setRating(media.id, n, { announceToast: true });
        return;
      }
      const key = playerKey(event.key);
      if (!key) return;
      event.preventDefault();
      keys.current(key);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menu, media.id]);

  useEffect(() => {
    if (countdown === null || !onNext) return;
    if (countdown <= 0) { onNext(); return; }
    const timer = setTimeout(() => setCountdown(value => value === null ? null : value - 1), 1000);
    return () => clearTimeout(timer);
  }, [countdown, onNext]);

  const jumpToFraction = (fraction: number) => {
    const el = video.current;
    const total = el?.duration || duration;
    if (!el || !total || !Number.isFinite(total)) return;
    haptic(8);
    el.currentTime = Math.max(0, Math.min(total - 1, total * fraction));
    setTime(el.currentTime);
  };

  const toggleAB = () => {
    const el = video.current;
    if (!el) return;
    haptic(8);
    if (loopA === null) {
      setLoopA(el.currentTime);
      setLoopB(null);
      toast(`已设 A 点 (${formatDuration(el.currentTime) || "0:00"})`);
    } else if (loopB === null) {
      const a = Math.min(loopA, el.currentTime);
      const b = Math.max(loopA, el.currentTime);
      if (b - a < 1) { toast("A-B 间隔至少 1 秒"); return; }
      setLoopA(a); setLoopB(b);
      el.currentTime = a;
      toast(`A-B 循环中 (${formatDuration(a) || "0:00"}–${formatDuration(b)})`);
    } else {
      setLoopA(null); setLoopB(null);
      toast("已关闭 A-B 循环");
    }
  };

  const showRails = controls && !fast && !screenLocked;

  return (
    <div ref={root} className="fixed inset-0 z-30 flex flex-col overflow-hidden bg-bg">
      {/* Top Perimeter Bar — OUTSIDE the video */}
      {showRails && (
        <header className="flex shrink-0 items-center gap-2 border-b border-line bg-bg px-3.5 py-2 pt-[max(0.6rem,env(safe-area-inset-top))] text-ink sm:px-6">
          <button type="button" onClick={onClose} aria-label="返回"
            className="grid size-9.5 shrink-0 place-items-center rounded-full border border-line bg-surface/80 hover:border-gold/50">
            <CaretLeftIcon size={19} weight="bold" />
          </button>
          <p className="min-w-0 flex-1 truncate text-[15px] font-semibold tracking-[-0.015em] text-ink">{title}</p>
          <button type="button" onClick={() => { haptic(8); setFillMode(v => !v); }} aria-label="切换画面比例" title="适应/铺满"
            className={`hidden size-9 shrink-0 place-items-center rounded-full border sm:grid ${fillMode ? "border-gold/55 bg-gold/15 text-gold-bright" : "border-line bg-surface/70"}`}>
            <FrameCornersIcon size={17} />
          </button>
          <button type="button" onClick={() => { haptic(8); setRotated(v => !v); }} aria-label="旋转画面" title="旋转 90°"
            className={`hidden size-9 shrink-0 place-items-center rounded-full border sm:grid ${rotated ? "border-gold/55 bg-gold/15 text-gold-bright" : "border-line bg-surface/70"}`}>
            <DeviceRotateIcon size={17} />
          </button>
          <button type="button" onClick={() => { haptic(8); setScreenLocked(true); setUnlockHint(true); setControls(false); }} aria-label="锁定屏幕防误触"
            className="grid size-9 shrink-0 place-items-center rounded-full border border-line bg-surface/70">
            <LockSimpleIcon size={17} />
          </button>
          <QuickTagButton media={media} enabled={!locked} />
          <BookmarkButton media={media} video={video} enabled={!locked} />
          <button type="button" onClick={() => setMenu(true)} aria-label="更多"
            className="grid size-9 shrink-0 place-items-center rounded-full border border-line bg-surface/70">
            <DotsThreeIcon size={21} weight="bold" />
          </button>
        </header>
      )}

      {/* 100% UNOBSTRUCTED VIDEO STAGE */}
      <div ref={stage} className="relative min-h-0 flex-1 overflow-hidden bg-black">
        <video
          ref={video}
          src={src}
          poster={media.cover_url ?? undefined}
          playsInline
          autoPlay
          muted={prefs.muted}
          className={`size-full transition-transform duration-300 ${fillMode ? "object-cover" : "object-contain"} ${rotated ? "rotate-90 scale-[1.35]" : ""}`}
          onLoadedMetadata={event => {
            setDuration(event.currentTarget.duration);
            if (resume.current) { event.currentTarget.currentTime = resume.current; resume.current = 0; }
            event.currentTarget.playbackRate = speed;
          }}
          onError={() => { setFailed(true); setLoading(false); }}
          onLoadStart={() => { setFailed(false); setLoading(true); }}
          onWaiting={event => { if (!event.currentTarget.paused) setLoading(true); }}
          onSeeking={event => { if (!event.currentTarget.paused) setLoading(true); }}
          onSeeked={event => setLoading(!event.currentTarget.paused && event.currentTarget.readyState < 3)}
          onCanPlay={() => setLoading(false)}
          onPlaying={() => { setFailed(false); setLoading(false); }}
          onPlay={event => { setPlaying(true); setCountdown(null); setLoading(event.currentTarget.readyState < 3); }}
          onPause={() => { setPlaying(false); setLoading(false); }}
          onEnded={() => { if ((next || continueNext) && onNext) setCountdown(NEXT_IN_SECONDS); }}
          onTimeUpdate={event => {
            const t = event.currentTarget.currentTime;
            if (loopA !== null && loopB !== null && t >= loopB) { event.currentTarget.currentTime = loopA; setTime(loopA); return; }
            setTime(t);
          }}
        />

        {brightness < 1 && (
          <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-black" style={{ opacity: Math.max(0, Math.min(0.7, 1 - brightness)) }} />
        )}

        <div
          className="absolute inset-0 touch-none select-none"
          onPointerDown={event => {
            horizontal.down(event.clientX, event.clientY);
            gestures.current?.down(event.clientX, event.clientY, performance.now());
            if (!screenLocked && event.pointerType !== "mouse") {
              const w = window.innerWidth || 390;
              if (event.clientX < w * 0.4) vDrag.current = { kind: "brightness", startY: event.clientY, startVal: brightness, active: false };
              else if (event.clientX > w * 0.6) vDrag.current = { kind: "volume", startY: event.clientY, startVal: video.current?.volume ?? 1, active: false };
            }
          }}
          onPointerMove={event => {
            const vd = vDrag.current;
            if (vd && !screenLocked) {
              const dy = vd.startY - event.clientY;
              if (!vd.active && Math.abs(dy) > 18 && horizontal.target === null) {
                vd.active = true;
                horizontal.cancel();
                gestures.current?.cancel();
              }
              if (vd.active) {
                const delta = dy / 220;
                if (vd.kind === "brightness") {
                  const nextB = Math.max(0.35, Math.min(1, vd.startVal + delta));
                  setBrightness(nextB);
                  setVHud({ kind: "brightness", value: Math.round(nextB * 100) });
                } else if (video.current) {
                  const nextV = Math.max(0, Math.min(1, vd.startVal + delta));
                  video.current.volume = nextV;
                  if (nextV > 0 && prefs.muted) setPref("muted", false);
                  setVHud({ kind: "volume", value: Math.round(nextV * 100) });
                }
                return;
              }
            }
            if (horizontal.move(event.clientX, event.clientY)) {
              vDrag.current = null;
              event.currentTarget.setPointerCapture?.(event.pointerId);
              gestures.current?.cancel();
            } else {
              gestures.current?.move(event.clientX, event.clientY);
            }
          }}
          onPointerUp={event => {
            if (vDrag.current?.active) { vDrag.current = null; setTimeout(() => setVHud(null), 700); return; }
            vDrag.current = null;
            if (horizontal.up(event.clientX, event.clientY)) gestures.current?.cancel();
            else gestures.current?.up(event.clientX, performance.now());
          }}
          onPointerCancel={() => { vDrag.current = null; setVHud(null); horizontal.cancel(); gestures.current?.cancel(); }}
          onContextMenu={event => event.preventDefault()}
        />

        <AnimatePresence>
          {vHud && (
            <motion.div key="vhud" initial={{ opacity: 0, scale: 0.92 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }} transition={EASE_HUD}
              className="glass-dock pointer-events-none absolute left-1/2 top-1/3 z-20 flex -translate-x-1/2 items-center gap-2 rounded-full px-4 py-2 text-[13px] font-semibold text-gold-bright">
              {vHud.kind === "brightness" ? <SunDimIcon size={17} weight="fill" /> : <SpeakerHighIcon size={17} weight="fill" />}
              <span>{vHud.value}%</span>
            </motion.div>
          )}
          {jump && (
            <motion.span key={jump} className={`glass-pill pointer-events-none absolute top-1/2 -mt-9 grid size-16 place-items-center rounded-full border-gold/35 text-gold-bright ${jump === "forward" ? "right-[16%]" : "left-[16%]"}`}
              initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }} transition={SPRING_PILL}>
              {jump === "forward" ? <ArrowClockwiseIcon size={26} weight="bold" /> : <ArrowCounterClockwiseIcon size={26} weight="bold" />}
            </motion.span>
          )}
          {fast && (
            <motion.span key="fast" className="glass-pill-gold pointer-events-none absolute left-1/2 top-4 -translate-x-1/2 rounded-full px-4 py-1 text-[13px] font-semibold"
              initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={SPRING_PILL}>2×</motion.span>
          )}
          {screenLocked && unlockHint && (
            <motion.button key="unlock-screen" type="button" aria-label="解除防误触锁屏"
              onClick={() => { haptic(8); setScreenLocked(false); setUnlockHint(false); setControls(true); }}
              initial={{ opacity: 0, scale: 0.92 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }} transition={SPRING_STAGE}
              className="glass-pill-gold pressable absolute left-4 top-1/2 z-20 flex -translate-y-1/2 items-center gap-1.5 rounded-full px-4 py-2.5 text-[14px] font-semibold">
              <LockSimpleOpenIcon size={17} weight="bold" />解锁
            </motion.button>
          )}
        </AnimatePresence>

        <LoadingFeedback video={video} source={src} waiting={loading} enabled={!locked && !failed} />
        <RecoveryNotice {...recovery} compatible={hasLow && !prefs.lowRes ? () => changeQuality(true) : undefined} />
        {horizontal.target !== null && (
          <div className="pointer-events-none absolute inset-x-0 bottom-6"><SeekPreview id={media.id} time={horizontal.target} enabled={!locked} /></div>
        )}

        {countdown !== null && (next || continueNext) && (
          <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={SPRING_STAGE}
            className="glass-dock absolute bottom-4 right-4 z-10 flex w-72 max-w-[calc(100%-2rem)] gap-3 rounded-[18px] p-3 text-ink" role="status">
            <div className="relative aspect-video w-24 shrink-0 overflow-hidden rounded-[10px] bg-surface">
              {next?.cover_url && <Cover src={next.cover_url} className={`size-full object-cover ${prefs.coverBlur ? "blur-xl scale-110" : ""}`} />}
              <FlutedPrivacyShield active={prefs.coverBlur} />
            </div>
            <div className="flex min-w-0 flex-1 flex-col justify-between">
              <p className="text-[13px] font-semibold text-gold-bright">下一部 · {countdown}s</p>
              <div className="flex gap-2">
                <button type="button" onClick={() => onNext?.()} className="glass-pill-gold pressable rounded-full px-3 py-1 text-[13px] font-semibold">立即播放</button>
                <button type="button" onClick={() => setCountdown(null)} className="pressable rounded-full bg-white/12 px-3 py-1 text-[13px]">取消</button>
              </div>
            </div>
          </motion.div>
        )}
      </div>

      {/* Bottom Perimeter Console — OUTSIDE the video frame */}
      {showRails && (
        <footer className="shrink-0 border-t border-line bg-bg px-3.5 pb-[max(0.85rem,env(safe-area-inset-bottom))] pt-2 text-ink sm:px-8">
          <div className="mx-auto flex w-full max-w-5xl flex-col gap-2">
            <SeekBar video={video} source={src} mediaId={media.id} duration={duration} enabled={!locked} markers={markers} />
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <motion.button type="button" onClick={toggle} aria-label={playing ? "暂停" : "播放"}
                  whileTap={{ scale: 0.88 }} transition={SPRING_TAP}
                  className="glass-pill-gold grid size-10 shrink-0 place-items-center rounded-full">
                  {playing ? <PauseIcon size={18} weight="fill" /> : <PlayIcon size={18} weight="fill" className="translate-x-0.5" />}
                </motion.button>
                <button type="button" onClick={() => jumpBy(false)} aria-label="后退 10 秒"
                  className="pressable hidden size-9 place-items-center rounded-full hover:bg-white/10 sm:grid">
                  <ArrowCounterClockwiseIcon size={18} />
                </button>
                <button type="button" onClick={() => jumpBy(true)} aria-label="前进 10 秒"
                  className="pressable hidden size-9 place-items-center rounded-full hover:bg-white/10 sm:grid">
                  <ArrowClockwiseIcon size={18} />
                </button>
                <span className="tabular-nums text-[13px] font-medium text-ink/90">
                  {formatDuration(time) || "0:00"} <span className="text-ink/40">/</span> {formatDuration(duration)}
                </span>
              </div>

              {/* Direct 1-Tap 5-Star Rating right on the outside cinema console */}
              <StarRating mediaId={media.id} compact />

              <div className="flex items-center gap-1.5">
                <div className="hidden items-center gap-1 md:flex">
                  {([0.2, 0.4, 0.6, 0.8] as const).map(frac => (
                    <button key={frac} type="button" onClick={() => jumpToFraction(frac)} aria-label={`空降 ${Math.round(frac * 100)}%`}
                      className="h-8 rounded-full border border-line px-2.5 text-[12px] font-medium text-ink/80 hover:border-gold/50 hover:text-gold-bright">
                      {Math.round(frac * 100)}%
                    </button>
                  ))}
                </div>
                <button type="button" onClick={toggleAB} aria-label="A-B 循环"
                  className={`inline-flex h-8.5 items-center gap-1 rounded-full border px-2.5 text-[13px] font-medium ${loopA !== null ? "border-gold/60 bg-gold/18 text-gold-bright" : "border-line text-ink/85"}`}>
                  <RepeatIcon size={14} weight="bold" />
                  {loopA === null ? "A-B" : loopB === null ? "设B" : "循环"}
                </button>
                <button type="button" onClick={toggleMute} aria-label={prefs.muted ? "打开声音" : "静音"}
                  className="grid size-9 place-items-center rounded-full hover:bg-white/10">
                  {prefs.muted ? <SpeakerSlashIcon size={19} /> : <SpeakerHighIcon size={19} className="text-gold-bright" />}
                </button>
                <button type="button" className="h-8.5 rounded-full border border-line px-2.5 text-[13px] font-semibold text-gold-bright"
                  onClick={() => {
                    const nextSpeed = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length];
                    setSpeed(nextSpeed);
                    if (video.current) video.current.playbackRate = nextSpeed;
                  }}>
                  {speed}×
                </button>
                {hasLow && (
                  <button type="button" className="h-8.5 rounded-full border border-line px-2.5 text-[13px] font-medium"
                    onClick={() => changeQuality(!prefs.lowRes)}>
                    {prefs.lowRes ? "480P" : "原画"}
                  </button>
                )}
                {pip && (
                  <button type="button" onClick={() => void pictureInPicture()} aria-label="画中画"
                    className="hidden size-9 place-items-center rounded-full hover:bg-white/10 sm:grid">
                    <PictureInPictureIcon size={18} />
                  </button>
                )}
                <button type="button" onClick={() => void fullscreen()} aria-label="全屏"
                  className="grid size-9 place-items-center rounded-full hover:bg-white/10">
                  <CornersOutIcon size={18} />
                </button>
              </div>
            </div>
          </div>
        </footer>
      )}

      <MediaActions media={media} open={menu} onClose={() => setMenu(false)} onRemove={media.deletable ? () => void remove() : undefined} video={video} />
    </div>
  );
}
