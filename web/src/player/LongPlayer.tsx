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
import { bufferedAhead } from "../feed/mediaBuffer";
import { setPref, usePrefs } from "../prefs";
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
import { FilmSlatePill, FlutedPrivacyShield } from "../ui/CinemaChrome";
import { prewarmMedia } from "../ui/prewarm";
import { EASE_HUD, SPRING_PILL, SPRING_STAGE, SPRING_TAP } from "../ui/motion";

const SPEEDS = [1, 1.25, 1.5, 2];
const SAVE_EVERY_MS = 10_000;
const NEXT_IN_SECONDS = 5;

/** Where to resume: a saved position, unless it is at the very start or the very end. */
export function resumeAt(saved: number | undefined, duration: number | null): number {
  if (!saved || saved < 10) return 0;
  if (duration && saved > duration - 30) return 0;
  return saved;
}

export type PlayerKey = "toggle" | "back" | "forward" | "fullscreen" | "mute" | "close";

/** YouTube-style keys: space/k pause, ←/j and →/l jump 10 s, f full screen, m mute, Esc back. */
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

export function LongPlayer({ media, next, onClose, onNext, startAt, continueNext = false }: {
  media: Media; onClose: () => void;
  /** The next long video of the wall this one was opened from; it starts by itself when this one ends. */
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
  const [buffered, setBuffered] = useState(0);
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

  // Ceremonial GSAP aperture curtain reveal when launching or switching long videos.
  useApertureReveal(stage, [media.id]);

  // Prewarm current tail (for instant deep seeking) and next video head (for zero-wait autoplay).
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
  const title = media.groups?.[0]?.label;
  const pip = document.pictureInPictureEnabled;
  const resLabel = media.height ? `${media.height}P` : null;

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

  useEffect(() => {
    if (!controls || !playing || menu) return;
    const timer = setTimeout(() => setControls(false), 3200);
    return () => clearTimeout(timer);
  }, [controls, playing, menu]);

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
    } catch { /* not every browser allows it; the page still plays */ }
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
    setControls(true);
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
      const key = playerKey(event.key);
      if (!key) return;
      event.preventDefault();
      keys.current(key);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menu]);

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

  return (
    <div ref={root} className="fixed inset-0 z-30 bg-bg">
      <div ref={stage} className="relative size-full overflow-hidden bg-black">
        <video ref={video} src={src} poster={media.cover_url ?? undefined} playsInline autoPlay muted={prefs.muted}
          className={`size-full transition-transform duration-300 ${fillMode ? "object-cover" : "object-contain"} ${rotated ? "rotate-90 scale-[1.35]" : ""}`}
          onLoadedMetadata={event => {
            setDuration(event.currentTarget.duration);
            if (resume.current) { event.currentTarget.currentTime = resume.current; resume.current = 0; }
            event.currentTarget.playbackRate = speed;
          }}
          onProgress={event => setBuffered(bufferedAhead(event.currentTarget))}
          onError={() => { setFailed(true); setLoading(false); }}
          onLoadStart={() => { setFailed(false); setLoading(true); }}
          onWaiting={event => { if (!event.currentTarget.paused) setLoading(true); }}
          onSeeking={event => { if (!event.currentTarget.paused) setLoading(true); }}
          onSeeked={event => setLoading(!event.currentTarget.paused && event.currentTarget.readyState < 3)}
          onCanPlay={() => setLoading(false)}
          onPlaying={() => { setFailed(false); setLoading(false); }}
          onPlay={event => { setPlaying(true); setCountdown(null); setLoading(event.currentTarget.readyState < 3); }}
          onPause={() => { setPlaying(false); setControls(true); setLoading(false); }}
          onEnded={() => { if ((next || continueNext) && onNext) setCountdown(NEXT_IN_SECONDS); }}
          onTimeUpdate={event => {
            const t = event.currentTarget.currentTime;
            setBuffered(bufferedAhead(event.currentTarget));
            if (loopA !== null && loopB !== null && t >= loopB) { event.currentTarget.currentTime = loopA; setTime(loopA); return; }
            setTime(t);
          }} />

        {brightness < 1 && (
          <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-black" style={{ opacity: Math.max(0, Math.min(0.7, 1 - brightness)) }} />
        )}

        <div className="absolute inset-0 touch-none select-none"
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
            if (horizontal.move(event.clientX, event.clientY)) { vDrag.current = null; event.currentTarget.setPointerCapture?.(event.pointerId); gestures.current?.cancel(); }
            else gestures.current?.move(event.clientX, event.clientY);
            if (event.pointerType === "mouse") setControls(true);
          }}
          onPointerUp={event => {
            if (vDrag.current?.active) { vDrag.current = null; setTimeout(() => setVHud(null), 700); return; }
            vDrag.current = null;
            if (horizontal.up(event.clientX, event.clientY)) gestures.current?.cancel();
            else gestures.current?.up(event.clientX, performance.now());
          }}
          onPointerCancel={() => { vDrag.current = null; setVHud(null); horizontal.cancel(); gestures.current?.cancel(); }}
          onContextMenu={event => event.preventDefault()} />

        <AnimatePresence>
          {vHud && (
            <motion.div key="vhud" initial={{ opacity: 0, scale: 0.92 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }} transition={EASE_HUD}
              className="glass-dock film-slate pointer-events-none absolute left-1/2 top-1/3 z-20 flex -translate-x-1/2 items-center gap-2.5 rounded-full px-4 py-2 text-[12px] font-semibold text-gold-bright">
              {vHud.kind === "brightness" ? <SunDimIcon size={17} weight="fill" /> : <SpeakerHighIcon size={17} weight="fill" />}
              <span>{vHud.kind === "brightness" ? "LUM" : "VOL"} {vHud.value}%</span>
            </motion.div>
          )}
        </AnimatePresence>

        <LoadingFeedback video={video} source={src} waiting={loading} enabled={!locked && !failed} />
        <RecoveryNotice {...recovery} compatible={hasLow && !prefs.lowRes ? () => changeQuality(true) : undefined} />
        {horizontal.target !== null && <div className="pointer-events-none absolute inset-x-0 bottom-40"><SeekPreview id={media.id} time={horizontal.target} enabled={!locked} /></div>}

        <AnimatePresence>
          {jump && (
            <motion.span key={jump} className={`glass-pill pointer-events-none absolute top-1/2 -mt-9 grid size-18 place-items-center rounded-full border-gold/35 text-gold-bright ${jump === "forward" ? "right-[16%]" : "left-[16%]"}`}
              initial={{ opacity: 0, scale: 0.8, rotate: jump === "forward" ? -24 : 24 }}
              animate={{ opacity: 1, scale: 1, rotate: 0 }}
              exit={{ opacity: 0, scale: 1.08 }}
              transition={SPRING_PILL}>
              {jump === "forward" ? <ArrowClockwiseIcon size={28} weight="bold" /> : <ArrowCounterClockwiseIcon size={28} weight="bold" />}
            </motion.span>
          )}
          {fast && (
            <motion.span key="fast" className="glass-pill-gold film-slate pointer-events-none absolute left-1/2 top-[max(1.1rem,env(safe-area-inset-top))] -translate-x-1/2 rounded-full px-4 py-1.5 text-[12px] font-semibold"
              initial={{ opacity: 0, y: -10, scale: 0.92 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -6 }}
              transition={SPRING_PILL}>2.0× FAST</motion.span>
          )}
          {screenLocked && unlockHint && (
            <motion.button key="unlock-screen" type="button" aria-label="解除防误触锁屏"
              onClick={() => { haptic(8); setScreenLocked(false); setUnlockHint(false); setControls(true); }}
              initial={{ opacity: 0, scale: 0.92 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.92 }}
              transition={SPRING_STAGE}
              className="glass-pill-gold pressable absolute left-4 top-1/2 z-20 flex -translate-y-1/2 items-center gap-1.5 rounded-full px-4 py-2.5 text-[13px] font-semibold">
              <LockSimpleOpenIcon size={17} weight="bold" />点按解锁
            </motion.button>
          )}
          {controls && !fast && !screenLocked && (
            <motion.div key="controls" className="pointer-events-none absolute inset-0 flex flex-col justify-between bg-gradient-to-b from-black/72 via-transparent to-black/86"
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={EASE_HUD}>
              {/* Top Cinema Slate Header (single container entrance, children static) */}
              <motion.div initial={{ y: -12, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: -10, opacity: 0 }} transition={EASE_HUD}
                className="pointer-events-auto space-y-1.5 px-3.5 pt-[max(0.85rem,env(safe-area-inset-top))] text-ink">
                <div className="flex items-center gap-1.5 sm:gap-2">
                  <button type="button" onClick={onClose} aria-label="返回" className="glass-pill pressable grid size-10 shrink-0 place-items-center rounded-full"><CaretLeftIcon size={20} weight="bold" /></button>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[14px] font-semibold tracking-[-0.015em] text-ink sm:text-[15px]">{title}</p>
                    <div className="mt-0.5 hidden sm:flex">
                      <FilmSlatePill resolution={resLabel} codec={media.codec} bufferedSeconds={buffered} lowRes={prefs.lowRes && hasLow} className="h-5.5 px-2 py-0 text-[9.5px]" />
                    </div>
                  </div>
                  <button type="button" onClick={() => { haptic(8); setFillMode(v => !v); }} aria-label="切换画面比例" title="适应/铺满"
                    className={`glass-pill pressable grid size-9.5 shrink-0 place-items-center rounded-full sm:size-10 ${fillMode ? "border-gold/50 text-gold-bright" : ""}`}><FrameCornersIcon size={17} /></button>
                  <button type="button" onClick={() => { haptic(8); setRotated(v => !v); }} aria-label="旋转画面" title="旋转 90°"
                    className={`glass-pill pressable grid size-9.5 shrink-0 place-items-center rounded-full sm:size-10 ${rotated ? "border-gold/50 text-gold-bright" : ""}`}><DeviceRotateIcon size={17} /></button>
                  <button type="button" onClick={() => { haptic(8); setScreenLocked(true); setUnlockHint(true); setControls(false); }} aria-label="锁定屏幕防误触"
                    className="glass-pill pressable grid size-9.5 shrink-0 place-items-center rounded-full sm:size-10"><LockSimpleIcon size={17} /></button>
                  <QuickTagButton media={media} enabled={!locked} />
                  <BookmarkButton media={media} video={video} enabled={!locked} />
                  <button type="button" onClick={() => setMenu(true)} aria-label="更多" className="glass-pill pressable grid size-9.5 shrink-0 place-items-center rounded-full sm:size-10"><DotsThreeIcon size={22} weight="bold" /></button>
                </div>
                <div className="flex items-center gap-2 pl-1 sm:hidden">
                  <FilmSlatePill resolution={resLabel} codec={media.codec} bufferedSeconds={buffered} lowRes={prefs.lowRes && hasLow} className="h-6 px-2.5 py-0 text-[9.5px]" />
                </div>
              </motion.div>

              {/* Bottom Optical Specular Console */}
              <motion.div initial={{ y: 16, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 12, opacity: 0 }} transition={EASE_HUD}
                className="pointer-events-auto mx-auto w-full max-w-3xl px-3.5 pb-[max(1rem,env(safe-area-inset-bottom))]">
                <div className="mb-2 flex items-center justify-between gap-1.5 px-0.5">
                  <div className="flex items-center gap-1.5">
                    {([0.2, 0.4, 0.6, 0.8] as const).map(frac => (
                      <button key={frac} type="button" onClick={() => jumpToFraction(frac)} aria-label={`空降 ${Math.round(frac * 100)}%`}
                        className="glass-pill film-slate pressable shrink-0 rounded-full px-2.5 py-1 text-[10.5px] font-semibold text-ink/85 hover:border-gold/45 hover:text-gold-bright">
                        {Math.round(frac * 100)}%
                      </button>
                    ))}
                  </div>
                  <button type="button" onClick={toggleAB} aria-label="A-B 循环"
                    className={`pressable inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-semibold ${loopA !== null ? "glass-pill-gold" : "glass-pill text-ink/88"}`}>
                    <RepeatIcon size={13} weight="bold" />
                    {loopA === null ? "A-B" : loopB === null ? "设 B" : "循环中"}
                  </button>
                </div>
                <div className="glass-dock rounded-[22px] px-4 pb-3 pt-2">
                  <SeekBar video={video} source={src} mediaId={media.id} duration={duration} enabled={!locked} markers={markers} />
                  <div className="mt-1 flex items-center gap-1.5 text-ink">
                    <motion.button type="button" onClick={toggle} aria-label={playing ? "暂停" : "播放"}
                      whileTap={{ scale: 0.88 }} transition={SPRING_TAP}
                      className="glass-pill-gold grid size-10 shrink-0 place-items-center rounded-full">
                      {playing ? <PauseIcon size={19} weight="fill" /> : <PlayIcon size={19} weight="fill" className="translate-x-0.5" />}
                    </motion.button>
                    <button type="button" onClick={() => jumpBy(false)} aria-label="后退 10 秒" className="pressable hidden size-10 shrink-0 place-items-center rounded-full hover:bg-white/10 sm:grid"><ArrowCounterClockwiseIcon size={19} /></button>
                    <button type="button" onClick={() => jumpBy(true)} aria-label="前进 10 秒" className="pressable hidden size-10 shrink-0 place-items-center rounded-full hover:bg-white/10 sm:grid"><ArrowClockwiseIcon size={19} /></button>
                    <span className="film-slate ml-1 shrink-0 whitespace-nowrap text-[11.5px] font-medium text-ink/90">{formatDuration(time) || "0:00"} <span className="text-ink/40">/</span> {formatDuration(duration)}</span>
                    <span className="flex-1" />
                    <button type="button" onClick={toggleMute} aria-label={prefs.muted ? "打开声音" : "静音"} className="pressable grid size-9 shrink-0 place-items-center rounded-full hover:bg-white/10">
                      {prefs.muted ? <SpeakerSlashIcon size={19} /> : <SpeakerHighIcon size={19} className="text-gold-bright" />}
                    </button>
                    <button type="button" className="glass-pill film-slate pressable shrink-0 whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-semibold text-gold-bright"
                      onClick={() => { const nextSpeed = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length]; setSpeed(nextSpeed); if (video.current) video.current.playbackRate = nextSpeed; }}>
                      {speed}×
                    </button>
                    {hasLow && (
                      <button type="button" className="glass-pill film-slate pressable shrink-0 whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-semibold"
                        onClick={() => changeQuality(!prefs.lowRes)}>
                        {prefs.lowRes ? "480P" : "原画"}
                      </button>
                    )}
                    {pip && <button type="button" onClick={() => void pictureInPicture()} aria-label="画中画" className="pressable hidden size-9 shrink-0 place-items-center rounded-full hover:bg-white/10 sm:grid"><PictureInPictureIcon size={19} /></button>}
                    <button type="button" onClick={() => void fullscreen()} aria-label="全屏" className="pressable grid size-9 shrink-0 place-items-center rounded-full hover:bg-white/10"><CornersOutIcon size={19} /></button>
                  </div>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        {countdown !== null && (next || continueNext) && (
          <motion.div initial={{ opacity: 0, y: 16, scale: 0.95 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={SPRING_STAGE}
            className="glass-dock absolute bottom-[calc(7.4rem+env(safe-area-inset-bottom))] right-4 z-10 flex w-76 max-w-[calc(100%-2rem)] gap-3 rounded-[20px] p-3 text-ink" role="status">
            <div className="relative aspect-video w-24 shrink-0 overflow-hidden rounded-[12px] bg-surface ring-1 ring-line">
              {next?.cover_url && <Cover src={next.cover_url} className={`size-full object-cover ${prefs.coverBlur ? "blur-xl scale-110" : ""}`} />}
              <FlutedPrivacyShield active={prefs.coverBlur} />
            </div>
            <div className="flex min-w-0 flex-1 flex-col justify-between">
              <p className="film-slate text-[12px] font-semibold text-gold-bright">UP NEXT · {countdown}S</p>
              <div className="flex gap-2">
                <button type="button" onClick={() => onNext?.()} className="glass-pill-gold pressable whitespace-nowrap rounded-full px-3 py-1 text-[12px] font-semibold">立即播放</button>
                <button type="button" onClick={() => setCountdown(null)} className="pressable whitespace-nowrap rounded-full bg-white/12 px-3 py-1 text-[12px] font-medium">取消</button>
              </div>
            </div>
          </motion.div>
        )}

        <MediaActions media={media} open={menu} onClose={() => setMenu(false)} onRemove={media.deletable ? () => void remove() : undefined} video={video} />
      </div>
    </div>
  );
}
