import {
  ArrowClockwiseIcon, ArrowCounterClockwiseIcon, CaretLeftIcon, CornersOutIcon, DotsThreeIcon,
  PauseIcon, PlayIcon, SpeakerHighIcon, SpeakerSlashIcon, SunDimIcon,
} from "@phosphor-icons/react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { api, chooseStream, type Media } from "../api";
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
 * Pure Kyoto Gallery Long Video Player:
 * - Unobstructed white gallery mat framing a restrained charcoal (#22252A) video aperture
 * - Top bar: Back + Title + Tags + More
 * - Bottom bar: Play + Time + Direct 5-Star Rating + Mute + Speed + Fullscreen
 * - Tap video to enter distraction-free viewing; double-tap sides to seek ±10s; hold for 2×
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

  const horizontal = useHorizontalSeek(video, src, !locked);
  const recovery = usePlaybackRecovery(video, src, !locked);
  usePlaybackHistory(video, media, src, !locked);

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

  const gestures = useRef<GestureRecognizer | null>(null);
  useEffect(() => {
    const g = new GestureRecognizer((event, x) => {
      const el = video.current;
      if (event === "tap") setControls(value => !value);
      else if (event === "double-tap") jumpBy(x > window.innerWidth / 2);
      else if (event === "long-press-start" && el && !el.paused) { haptic(10); el.playbackRate = 2; setFast(true); }
      else if (event === "long-press-end" && el) { el.playbackRate = speed; setFast(false); }
    });
    gestures.current = g;
    return () => g.dispose();
  }, [speed]);

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

  const showRails = controls && !fast;

  return (
    <div ref={root} className={`fixed inset-0 z-30 flex flex-col overflow-hidden transition-colors duration-200 ${showRails ? "cinema-aura bg-bg" : "bg-stage"}`}>
      {/* Top Kyoto Gallery Perimeter Bar — Pure: Back + Title + Tags + More */}
      {showRails && (
        <header className="shrink-0 border-b border-line bg-bg/95 px-3.5 pt-[env(safe-area-inset-top)] text-ink backdrop-blur-md sm:px-6">
          <div className="flex h-13 items-center gap-2.5">
            <button type="button" onClick={onClose} aria-label="返回"
              className="grid size-9.5 shrink-0 place-items-center rounded-full border border-line bg-surface text-ink shadow-[0_2px_8px_rgba(20,22,25,0.05)] hover:border-gold/50 hover:text-gold">
              <CaretLeftIcon size={19} weight="bold" />
            </button>
            <p className="min-w-0 flex-1 truncate text-[15px] font-semibold tracking-[-0.015em] text-ink">{title}</p>
            <QuickTagButton media={media} enabled={!locked} iconOnly />
            <button type="button" onClick={() => setMenu(true)} aria-label="更多"
              className="grid size-9 shrink-0 place-items-center rounded-full border border-line bg-surface text-ink/80 hover:border-gold/45 hover:text-gold">
              <DotsThreeIcon size={21} weight="bold" />
            </button>
          </div>
        </header>
      )}

      {/* 100% UNOBSTRUCTED KYOTO GALLERY VIDEO STAGE */}
      <div className={`relative flex min-h-0 flex-1 items-center justify-center overflow-hidden ${showRails ? "px-2.5 py-2.5 sm:px-8 sm:py-4" : ""}`}>
        <div
          style={
            showRails && media.width && media.height
              ? { aspectRatio: `${media.width} / ${media.height}` }
              : undefined
          }
          className={`relative flex items-center justify-center overflow-hidden ${
            showRails
              ? `aperture-frame rounded-[18px] bg-surface p-1.5 sm:rounded-[22px] sm:p-2.5 ${
                  media.width && media.height
                    ? (media.width >= media.height ? "w-full max-w-6xl max-h-full" : "h-full max-h-full max-w-full")
                    : "size-full max-w-6xl"
                }`
              : "size-full"
          }`}
        >
          <div ref={stage} className={`relative size-full overflow-hidden bg-stage ${showRails ? "rounded-[12px] sm:rounded-[14px]" : ""}`}>
            <video
              ref={video}
              src={src}
              poster={media.cover_url ?? undefined}
              playsInline
              autoPlay
              muted={prefs.muted}
              className="size-full object-contain"
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
              onTimeUpdate={event => setTime(event.currentTarget.currentTime)}
            />

            {brightness < 1 && (
              <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-black" style={{ opacity: Math.max(0, Math.min(0.7, 1 - brightness)) }} />
            )}

            <div
              className="absolute inset-0 touch-none select-none"
              onPointerDown={event => {
                horizontal.down(event.clientX, event.clientY);
                gestures.current?.down(event.clientX, event.clientY, performance.now());
                if (event.pointerType !== "mouse") {
                  const w = window.innerWidth || 390;
                  if (event.clientX < w * 0.4) vDrag.current = { kind: "brightness", startY: event.clientY, startVal: brightness, active: false };
                  else if (event.clientX > w * 0.6) vDrag.current = { kind: "volume", startY: event.clientY, startVal: video.current?.volume ?? 1, active: false };
                }
              }}
              onPointerMove={event => {
                const vd = vDrag.current;
                if (vd) {
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
                  className="glass-dock pointer-events-none absolute left-1/2 top-1/3 z-20 flex -translate-x-1/2 items-center gap-2 rounded-full px-4 py-2 text-[13px] font-semibold text-gold">
                  {vHud.kind === "brightness" ? <SunDimIcon size={17} weight="fill" /> : <SpeakerHighIcon size={17} weight="fill" />}
                  <span>{vHud.value}%</span>
                </motion.div>
              )}
              {jump && (
                <motion.span key={jump} className={`glass-pill pointer-events-none absolute top-1/2 -mt-9 grid size-16 place-items-center rounded-full text-gold ${jump === "forward" ? "right-[16%]" : "left-[16%]"}`}
                  initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }} transition={SPRING_PILL}>
                  {jump === "forward" ? <ArrowClockwiseIcon size={26} weight="bold" /> : <ArrowCounterClockwiseIcon size={26} weight="bold" />}
                </motion.span>
              )}
              {fast && (
                <motion.span key="fast" className="glass-pill-gold pointer-events-none absolute left-1/2 top-4 -translate-x-1/2 rounded-full px-4 py-1 text-[13px] font-semibold"
                  initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={SPRING_PILL}>2×</motion.span>
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
                  <p className="text-[13px] font-semibold text-gold">下一部 · {countdown}s</p>
                  <div className="flex gap-2">
                    <button type="button" onClick={() => onNext?.()} className="glass-pill-gold pressable rounded-full px-3 py-1 text-[13px] font-semibold">立即播放</button>
                    <button type="button" onClick={() => setCountdown(null)} className="pressable rounded-full bg-raised px-3 py-1 text-[13px] text-ink">取消</button>
                  </div>
                </div>
              </motion.div>
            )}
          </div>
        </div>
      </div>

      {/* Bottom Kyoto Gallery Perimeter Console — Pure: Play + Time + 5-Star + Mute + Speed + Fullscreen */}
      {showRails && (
        <footer className="shrink-0 border-t border-line bg-surface px-3.5 pb-[max(0.85rem,env(safe-area-inset-bottom))] pt-2 text-ink sm:px-8">
          <div className="mx-auto flex w-full max-w-5xl flex-col gap-2">
            <SeekBar video={video} source={src} mediaId={media.id} duration={duration} enabled={!locked} />
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2.5">
                <motion.button type="button" onClick={toggle} aria-label={playing ? "暂停" : "播放"}
                  whileTap={{ scale: 0.88 }} transition={SPRING_TAP}
                  className="glass-pill-gold grid size-10 shrink-0 place-items-center rounded-full">
                  {playing ? <PauseIcon size={18} weight="fill" /> : <PlayIcon size={18} weight="fill" className="translate-x-0.5" />}
                </motion.button>
                <span className="tabular-nums text-[13px] font-medium text-ink/90">
                  {formatDuration(time) || "0:00"} <span className="text-ink/35">/</span> {formatDuration(duration)}
                </span>
              </div>

              <StarRating mediaId={media.id} compact />

              <div className="flex items-center gap-1.5">
                <button type="button" onClick={toggleMute} aria-label={prefs.muted ? "打开声音" : "静音"}
                  className="grid size-9 place-items-center rounded-full border border-line bg-bg hover:border-gold/45">
                  {prefs.muted ? <SpeakerSlashIcon size={18} className="text-muted" /> : <SpeakerHighIcon size={18} className="text-gold" />}
                </button>
                <button type="button" className="h-9 rounded-full border border-line bg-bg px-3 text-[13px] font-semibold text-gold hover:border-gold/50"
                  onClick={() => {
                    const nextSpeed = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length];
                    setSpeed(nextSpeed);
                    if (video.current) video.current.playbackRate = nextSpeed;
                  }}>
                  {speed}×
                </button>
                <button type="button" onClick={() => void fullscreen()} aria-label="全屏"
                  className="grid size-9 place-items-center rounded-full border border-line bg-bg text-ink/80 hover:border-gold/45 hover:text-gold">
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
