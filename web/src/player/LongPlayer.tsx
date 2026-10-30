import {
  ArrowClockwiseIcon, ArrowCounterClockwiseIcon, CaretLeftIcon, CircleNotchIcon, CornersOutIcon, DotsThreeIcon, HeartIcon,
  PauseIcon, PictureInPictureIcon, PlayIcon, SpeakerHighIcon, SpeakerSlashIcon,
} from "@phosphor-icons/react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { api, chooseStream, type Media } from "../api";
import { GestureRecognizer } from "../feed/gestures";
import { MediaActions } from "../feed/MediaActions";
import { setPref, usePrefs } from "../prefs";
import { announce, Cover, formatDuration } from "../ui/Grid";
import { setLongPlayback, useLocked } from "../ui/privacy";
import { toast } from "../ui/toast";

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

/** The end of the buffered range the playhead is in, or the playhead itself. */
function bufferedEnd(el: HTMLVideoElement): number {
  for (let i = 0; i < el.buffered.length; i++) {
    if (el.buffered.start(i) <= el.currentTime + 0.5 && el.currentTime <= el.buffered.end(i)) return el.buffered.end(i);
  }
  return el.currentTime;
}

type FullscreenVideo = HTMLVideoElement & { webkitEnterFullscreen?: () => void };

export function LongPlayer({ media, next, onClose, onNext }: {
  media: Media; onClose: () => void;
  /** The next long video of the wall this one was opened from; it starts by itself when this one ends. */
  next?: Media; onNext?: () => void;
}) {
  const prefs = usePrefs();
  const locked = useLocked();
  const root = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [controls, setControls] = useState(true);
  const [time, setTime] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [duration, setDuration] = useState(media.duration_seconds ?? 0);
  const [speed, setSpeed] = useState(1);
  const [fast, setFast] = useState(false);
  const [muted, setMuted] = useState(false);
  const [loading, setLoading] = useState(true);
  const [jump, setJump] = useState<"back" | "forward" | null>(null);
  const [favorite, setFavorite] = useState(media.favorite);
  const [failed, setFailed] = useState(false);
  const [menu, setMenu] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const resume = useRef(0);
  const src = chooseStream(media, prefs.lowRes);
  const hasLow = media.variants.some(v => v.height && v.height < (media.height ?? Infinity));
  const title = media.groups?.[0]?.label;
  const pip = document.pictureInPictureEnabled;

  useEffect(() => { setLongPlayback(true); return () => setLongPlayback(false); }, []);
  useEffect(() => {
    void api.longProgress().then(p => {
      resume.current = resumeAt(p.items.find(i => i.id === media.id)?.position_seconds, media.duration_seconds);
      // The video may have loaded before the saved position arrived.
      const el = video.current;
      if (el && resume.current && el.readyState >= 1 && el.currentTime < 1) el.currentTime = resume.current;
    }).catch(() => undefined);
  }, [media.id, media.duration_seconds]);
  useEffect(() => { if (locked) video.current?.pause(); }, [locked]);

  // Save where we are while playing, when the app goes to the background, and once more on the way out.
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

  // Controls fade out while playing.
  useEffect(() => {
    if (!controls || !playing || menu) return;
    const timer = setTimeout(() => setControls(false), 3000);
    return () => clearTimeout(timer);
  }, [controls, playing, menu]);

  const seekBy = (delta: number) => {
    const el = video.current;
    if (el) el.currentTime = Math.max(0, Math.min(el.duration || Infinity, el.currentTime + delta));
  };
  const jumpBy = (forward: boolean) => {
    seekBy(forward ? 10 : -10);
    setJump(forward ? "forward" : "back");
    setTimeout(() => setJump(null), 500);
  };
  const toggle = () => { const el = video.current; if (el) void (el.paused ? el.play() : el.pause()); };
  const toggleMute = () => { const el = video.current; if (el) { el.muted = !el.muted; setMuted(el.muted); } };
  const toggleFavorite = () => {
    const on = !favorite;
    setFavorite(on);
    announce({ id: media.id, favorite: on });
    void api.favorite(media.id, on).catch(() => { setFavorite(!on); announce({ id: media.id, favorite: !on }); toast("收藏没保存上，再试一次"); });
  };
  const remove = async () => {
    try { await api.remove(media.id); } catch { toast("删除失败，请稍后再试"); return; }
    announce({ id: media.id, removed: true });
    onClose();
    toast("已删除", {
      label: "撤销",
      run: () => void api.restore(media.id).then(({ restored }) => toast(restored ? "已恢复，刷新后可见" : "已经开始删除，无法撤销")),
    }, 6000);
  };

  // iPhone Safari has no element full screen; only the video itself can go full screen there.
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
      const el = video.current;
      if (event === "tap") setControls(value => !value);
      else if (event === "double-tap") jumpBy(x > window.innerWidth / 2);
      else if (event === "long-press-start" && el && !el.paused) { el.playbackRate = 2; setFast(true); }
      else if (event === "long-press-end" && el) { el.playbackRate = speed; setFast(false); }
    });
    gestures.current = g;
    return () => g.dispose();
  }, [speed]);

  // Keyboard on a computer; typing in a sheet's text field is left alone.
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

  // Up next: a short countdown that can be cancelled, then the next video of the wall.
  useEffect(() => {
    if (countdown === null || !onNext) return;
    if (countdown <= 0) { onNext(); return; }
    const timer = setTimeout(() => setCountdown(value => value === null ? null : value - 1), 1000);
    return () => clearTimeout(timer);
  }, [countdown, onNext]);

  const pct = (value: number) => `${duration ? Math.min(100, (value / duration) * 100) : 0}%`;

  return (
    <div ref={root} className="fixed inset-0 z-30 bg-black">
      <video ref={video} src={src} playsInline autoPlay className="size-full object-contain"
        onLoadedMetadata={event => {
          setDuration(event.currentTarget.duration);
          if (resume.current) event.currentTarget.currentTime = resume.current;
          event.currentTarget.playbackRate = speed;
        }}
        onError={() => { setFailed(true); setLoading(false); }}
        onLoadStart={() => setLoading(true)} onWaiting={() => setLoading(true)} onCanPlay={() => setLoading(false)}
        onPlaying={() => { setFailed(false); setLoading(false); }}
        onPlay={() => { setPlaying(true); setCountdown(null); }} onPause={() => { setPlaying(false); setControls(true); }}
        onEnded={() => { if (next && onNext) setCountdown(NEXT_IN_SECONDS); }}
        onProgress={event => setBuffered(bufferedEnd(event.currentTarget))}
        onTimeUpdate={event => { setTime(event.currentTarget.currentTime); setBuffered(bufferedEnd(event.currentTarget)); }} />

      <div className="absolute inset-0 touch-none select-none"
        onPointerDown={event => gestures.current?.down(event.clientX, event.clientY, performance.now())}
        onPointerMove={event => { gestures.current?.move(event.clientX, event.clientY); if (event.pointerType === "mouse") setControls(true); }}
        onPointerUp={event => gestures.current?.up(event.clientX, performance.now())}
        onPointerCancel={() => gestures.current?.cancel()}
        onContextMenu={event => event.preventDefault()} />

      {loading && !failed && (
        <CircleNotchIcon size={44} className="pointer-events-none absolute left-1/2 top-1/2 -ml-[22px] -mt-[22px] animate-spin text-white/80" aria-label="正在缓冲" />
      )}
      {failed && (
        <div className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 px-6 text-center text-[14px] text-white/80">
          <p>这个视频在当前浏览器放不了</p>
          {hasLow && !prefs.lowRes && (
            <button type="button" onClick={() => { setFailed(false); setPref("lowRes", true); }}
              className="pointer-events-auto mt-3 rounded-full bg-white/15 px-4 py-2 text-[14px] font-semibold text-white">换低清试试</button>
          )}
        </div>
      )}

      <AnimatePresence>
        {jump && (
          <motion.span key={jump} className={`pointer-events-none absolute top-1/2 -mt-8 grid size-16 place-items-center rounded-full bg-black/45 text-white ${jump === "forward" ? "right-[18%]" : "left-[18%]"}`}
            initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }}>
            {jump === "forward" ? <ArrowClockwiseIcon size={28} /> : <ArrowCounterClockwiseIcon size={28} />}
          </motion.span>
        )}
        {fast && (
          <motion.span key="fast" className="pointer-events-none absolute left-1/2 top-[max(1.25rem,env(safe-area-inset-top))] -translate-x-1/2 rounded-full bg-black/55 px-3 py-1 text-[13px] font-semibold text-white backdrop-blur-sm"
            initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>2× 快进中</motion.span>
        )}
        {controls && !fast && (
          <motion.div key="controls" className="pointer-events-none absolute inset-0 flex flex-col justify-between bg-gradient-to-b from-black/60 via-transparent to-black/70"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <div className="pointer-events-auto flex items-center gap-1 px-3 pt-[max(0.75rem,env(safe-area-inset-top))] text-white">
              <button type="button" onClick={onClose} aria-label="返回" className="grid size-10 shrink-0 place-items-center rounded-full"><CaretLeftIcon size={24} weight="bold" /></button>
              <p className="min-w-0 flex-1 truncate text-[15px] font-medium">{title}</p>
              <button type="button" onClick={toggleFavorite} aria-label={favorite ? "取消收藏" : "收藏"} aria-pressed={favorite}
                className="grid size-10 place-items-center rounded-full">
                <HeartIcon size={26} weight="fill" className={favorite ? "text-accent" : "text-white"} />
              </button>
              <button type="button" onClick={() => setMenu(true)} aria-label="更多" className="grid size-10 place-items-center rounded-full"><DotsThreeIcon size={26} weight="bold" /></button>
            </div>
            <div className="pointer-events-auto px-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
              <div className="relative h-6 w-full">
                <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 overflow-hidden rounded-full bg-white/20">
                  <div className="absolute inset-y-0 left-0 bg-white/35" style={{ width: pct(buffered) }} />
                  <div className="absolute inset-y-0 left-0 bg-accent" style={{ width: pct(time) }} />
                </div>
                <span className="pointer-events-none absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow" style={{ left: pct(time) }} />
                <input type="range" min={0} max={duration || 0} step={1} value={Math.min(time, duration || 0)} aria-label="播放进度"
                  onChange={event => { if (video.current) video.current.currentTime = Number(event.target.value); }}
                  className="absolute inset-0 h-full w-full cursor-pointer opacity-0" />
              </div>
              <div className="mt-1 flex items-center gap-1 text-white">
                <button type="button" onClick={toggle} aria-label={playing ? "暂停" : "播放"} className="grid size-10 place-items-center">
                  {playing ? <PauseIcon size={26} weight="fill" /> : <PlayIcon size={26} weight="fill" />}
                </button>
                <button type="button" onClick={() => jumpBy(false)} aria-label="后退 10 秒" className="hidden size-10 place-items-center sm:grid"><ArrowCounterClockwiseIcon size={22} /></button>
                <button type="button" onClick={() => jumpBy(true)} aria-label="前进 10 秒" className="hidden size-10 place-items-center sm:grid"><ArrowClockwiseIcon size={22} /></button>
                <span className="ml-1 whitespace-nowrap text-[13px] tabular-nums text-white/85">{formatDuration(time) || "0:00"} / {formatDuration(duration)}</span>
                <span className="flex-1" />
                <button type="button" onClick={toggleMute} aria-label={muted ? "打开声音" : "静音"} className="grid size-10 place-items-center">
                  {muted ? <SpeakerSlashIcon size={22} /> : <SpeakerHighIcon size={22} />}
                </button>
                <button type="button" className="rounded-full bg-white/15 px-2.5 py-1 text-[13px] font-semibold"
                  onClick={() => { const next = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length]; setSpeed(next); if (video.current) video.current.playbackRate = next; }}>
                  {speed}×
                </button>
                {hasLow && (
                  <button type="button" className="ml-1 rounded-full bg-white/15 px-2.5 py-1 text-[13px] font-semibold"
                    onClick={() => { resume.current = video.current?.currentTime ?? 0; setPref("lowRes", !prefs.lowRes); }}>
                    {prefs.lowRes ? "低清" : "原画"}
                  </button>
                )}
                {pip && <button type="button" onClick={() => void pictureInPicture()} aria-label="画中画" className="grid size-10 place-items-center"><PictureInPictureIcon size={22} /></button>}
                <button type="button" onClick={() => void fullscreen()} aria-label="全屏" className="grid size-10 place-items-center"><CornersOutIcon size={22} /></button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {countdown !== null && next && (
        <div className="absolute bottom-[calc(6.5rem+env(safe-area-inset-bottom))] right-4 z-10 flex w-72 max-w-[calc(100%-2rem)] gap-3 rounded-[14px] bg-black/75 p-2.5 text-white backdrop-blur-md" role="status">
          <div className="relative aspect-video w-24 shrink-0 overflow-hidden rounded-[8px] bg-surface">
            {next.cover_url && <Cover src={next.cover_url} className={`size-full object-cover ${prefs.coverBlur ? "blur-md" : ""}`} />}
          </div>
          <div className="flex min-w-0 flex-1 flex-col justify-between">
            <p className="text-[13px] text-white/80">{countdown} 秒后播放下一个</p>
            <div className="flex gap-2">
              <button type="button" onClick={() => onNext?.()} className="whitespace-nowrap rounded-full bg-accent px-3 py-1 text-[13px] font-semibold">立即播放</button>
              <button type="button" onClick={() => setCountdown(null)} className="whitespace-nowrap rounded-full bg-white/15 px-3 py-1 text-[13px]">取消</button>
            </div>
          </div>
        </div>
      )}

      <MediaActions media={media} open={menu} onClose={() => setMenu(false)} onRemove={media.deletable ? () => void remove() : undefined} />
    </div>
  );
}
