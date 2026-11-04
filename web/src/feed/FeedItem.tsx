import { DotsThreeIcon, HeartIcon, SpeakerHighIcon, SpeakerSlashIcon, PlayIcon } from "@phosphor-icons/react";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { chooseStream, type Media } from "../api";
import { setPref, usePrefs } from "../prefs";
import { useLocked } from "../ui/privacy";
import { GestureRecognizer } from "./gestures";
import { MediaActions } from "./MediaActions";
import { useFeedPlayback, type BufferReadiness } from "./useFeedPlayback";
import { LoadingFeedback } from "../ui/LoadingFeedback";
import { SeekBar } from "../ui/SeekBar";
import { SeekPreview } from "../ui/SeekPreview";
import { BookmarkButton } from "../ui/Bookmarks";
import { useHorizontalSeek } from "../player/useHorizontalSeek";
import { usePlaybackRecovery, RecoveryNotice } from "../player/usePlaybackRecovery";
import { useClipRange } from "../player/clipRange";
import { usePlaybackHistory } from "../player/usePlaybackHistory";
import { QuickTagButton, QuickTagPanel } from "../ui/QuickTags";
import { Sheet } from "../ui/Sheet";

interface Props {
  media: Media;
  /** This clip is on screen. */
  active: boolean;
  /** Mount the video element (on screen or one away), so the next clip is already buffering. */
  mounted: boolean;
  eager?: boolean;
  onBufferReadiness?: BufferReadiness;
  onFavorite: (id: string, on: boolean) => void;
  /** Present when the server allows deleting this clip. */
  onRemove?: (media: Media) => void;
  /** 整理模式 buttons sit at the bottom; the rail moves up out of their way. */
  raised?: boolean;
  startAt?: number;
  onEnded?: () => void;
}

interface Burst { id: number; x: number; y: number }

export function FeedItem({ media, active, mounted, eager = false, onBufferReadiness, onRemove, raised = false, startAt, onEnded }: Props) {
  const prefs = usePrefs();
  const locked = useLocked();
  const [menu, setMenu] = useState(false);
  const [quickTags, setQuickTags] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const startedAt = useRef(false);
  const [paused, setPaused] = useState(false);
  const [fast, setFast] = useState(false);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [bursts, setBursts] = useState<Burst[]>([]);
  const [original, setOriginal] = useState(false);
  const clip = original ? undefined : media.clip;
  const recognizer = useRef<GestureRecognizer | null>(null);
  const lastY = useRef(0);
  const landscape = (media.width ?? 9) > (media.height ?? 16);
  const src = chooseStream(media, prefs.lowRes);
  const hasLow = media.variants.some(v => v.height && v.height < (media.height ?? Infinity));
  const onPause = useCallback(() => setPaused(true), []);
  const { attachVideo, visible } = useFeedPlayback(video, {
    media, src, active, mounted, eager, paused, locked, onPause, onBufferReadiness, original,
  });

  const enabled = active && mounted && !locked && visible;
  usePlaybackHistory(video, media, src, enabled);
  const { range, invalid } = useClipRange(video, src, mounted && (active || eager) && !locked && visible, clip, active && !paused, active);
  const horizontal = useHorizontalSeek(video, src, enabled && !invalid, range);
  const recovery = usePlaybackRecovery(video, src, enabled);

  // Play only the clip on screen; a clip that leaves the screen starts over next time.
  useEffect(() => {
    if (active) return;
    setPaused(false); setFast(false); setMenu(false); setQuickTags(false);
    const el = video.current;
    if (!el) return;
    if (!clip) el.currentTime = 0;
    el.playbackRate = 1;
  }, [active, mounted, src, clip?.start]);

  useEffect(() => { if (video.current) video.current.muted = prefs.muted; }, [prefs.muted]);

  // Space pauses and m mutes the clip on screen.
  useEffect(() => {
    if (!active || menu) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.target instanceof HTMLInputElement) return;
      if (event.key === " ") { event.preventDefault(); setPaused(value => !value); }
      else if (event.key.toLowerCase() === "m") setPref("muted", !prefs.muted);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, menu, prefs.muted]);

  useEffect(() => {
    const g = new GestureRecognizer((event, x) => {
      const el = video.current;
      if (event === "tap") setPaused(value => !value);
      else if (event === "double-tap") {
        setQuickTags(true);
        const y = lastY.current;
        setBursts(list => [...list, { id: performance.now(), x, y }]);
      } else if (event === "long-press-start" && el) { el.playbackRate = 2; setFast(true); }
      else if (event === "long-press-end" && el) { el.playbackRate = 1; setFast(false); }
    });
    recognizer.current = g;
    return () => g.dispose();
  }, [media.id, media.favorite]);

  return (
    <section className="relative h-dvh w-full snap-start snap-always overflow-hidden bg-black" aria-label="视频">
      {landscape && media.cover_url && (
        <img src={media.cover_url} alt="" aria-hidden className="absolute inset-0 size-full scale-110 object-cover opacity-50 blur-2xl" />
      )}
      {mounted ? (
        <video ref={attachVideo} src={src} poster={media.cover_url ?? undefined} playsInline loop={!clip && !onEnded} muted={prefs.muted}
          onEnded={() => { if (!clip && enabled && !paused) onEnded?.(); }}
          preload={!locked && visible && (active || eager) ? "auto" : "metadata"}
          onLoadedMetadata={event => { if (!startedAt.current && startAt !== undefined) { event.currentTarget.currentTime = Math.min(startAt, event.currentTarget.duration); startedAt.current = true; } }}
          onLoadStart={() => { setFailed(false); setLoading(true); }}
          onWaiting={event => { if (!event.currentTarget.paused) setLoading(true); }}
          onSeeking={event => { if (!event.currentTarget.paused) setLoading(true); }}
          onCanPlay={() => setLoading(false)} onSeeked={event => setLoading(!event.currentTarget.paused && event.currentTarget.readyState < 3)}
          onPlay={event => setLoading(event.currentTarget.readyState < 3)} onPause={() => setLoading(false)}
          onError={() => { setFailed(true); setLoading(false); }}
          onPlaying={() => { setFailed(false); setLoading(false); }}
          className={`absolute inset-0 size-full ${landscape ? "object-contain" : "object-cover"}`} />
      ) : media.cover_url ? (
        <img src={media.cover_url} alt="" className={`absolute inset-0 size-full ${landscape ? "object-contain" : "object-cover"}`} />
      ) : null}

      {/* The gesture surface: everything except the rail and the progress line. */}
      <div className="absolute inset-0 touch-pan-y select-none"
        onPointerDown={event => { lastY.current = event.clientY; horizontal.down(event.clientX, event.clientY); recognizer.current?.down(event.clientX, event.clientY, performance.now()); }}
        onPointerMove={event => { if (horizontal.move(event.clientX, event.clientY)) { event.currentTarget.setPointerCapture?.(event.pointerId); recognizer.current?.cancel(); } else recognizer.current?.move(event.clientX, event.clientY); }}
        onPointerUp={event => { if (horizontal.up(event.clientX, event.clientY)) recognizer.current?.cancel(); else recognizer.current?.up(event.clientX, performance.now()); }}
        onPointerCancel={() => { horizontal.cancel(); recognizer.current?.cancel(); }}
        onContextMenu={event => event.preventDefault()} />

      <LoadingFeedback video={video} source={src} waiting={loading}
        enabled={active && mounted && !paused && !locked && visible && !failed && !invalid} />
      {invalid && active && <div className="absolute inset-x-6 top-1/3 z-10 rounded-xl bg-black/80 p-5 text-center text-white"><p className="mb-3 text-sm">片段位置已超出视频时长</p><button type="button" className="min-h-11 rounded-full bg-accent px-5" onClick={() => { setOriginal(true); setPaused(false); if (video.current) { video.current.currentTime = 0; void video.current.play().catch(() => setPaused(true)); } }}>打开原视频</button></div>}

      <AnimatePresence>
        {paused && active && (
          <motion.span key="paused" className="pointer-events-none absolute left-1/2 top-1/2 -ml-9 -mt-9 grid size-18 place-items-center rounded-full bg-black/40 text-white backdrop-blur-sm"
            initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 1.1 }}>
            <PlayIcon size={34} weight="fill" />
          </motion.span>
        )}
        {fast && (
          <motion.span key="fast" className="pointer-events-none absolute left-1/2 top-[max(1.25rem,env(safe-area-inset-top))] -translate-x-1/2 rounded-full bg-black/55 px-3 py-1 text-[13px] font-semibold text-white backdrop-blur-sm"
            initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>2× 快进中</motion.span>
        )}
        {bursts.map(burst => (
          <motion.span key={burst.id} className="pointer-events-none absolute text-accent" style={{ left: burst.x - 40, top: burst.y - 40 }}
            initial={{ scale: 0.4, opacity: 0, rotate: -12 }} animate={{ scale: [0.4, 1.25, 1], opacity: [0, 1, 1, 0], y: -60 }}
            transition={{ duration: 0.8, ease: "easeOut" }} onAnimationComplete={() => setBursts(list => list.filter(b => b.id !== burst.id))}>
            <HeartIcon size={80} weight="fill" />
          </motion.span>
        ))}
      </AnimatePresence>

      {enabled && !invalid && <RecoveryNotice {...recovery} compatible={hasLow && !prefs.lowRes ? () => setPref("lowRes", true) : undefined} />}
      {enabled && horizontal.target !== null && <div className="pointer-events-none absolute inset-x-0 bottom-40"><SeekPreview id={media.id} time={horizontal.target} enabled /></div>}

      <div className={`absolute right-3 flex flex-col items-center gap-5 transition-[bottom] ${raised ? "bottom-[calc(13rem+env(safe-area-inset-bottom))]" : "bottom-[calc(5.5rem+env(safe-area-inset-bottom))]"}`}>
        <QuickTagButton media={media} enabled={enabled} />
        <RailButton label={prefs.muted ? "打开声音" : "静音"} onClick={() => setPref("muted", !prefs.muted)}>
          {prefs.muted ? <SpeakerSlashIcon size={28} weight="fill" /> : <SpeakerHighIcon size={28} weight="fill" />}
        </RailButton>
        <BookmarkButton media={media} video={video} enabled={enabled} />
        <RailButton label="更多" onClick={() => setMenu(true)}><DotsThreeIcon size={30} weight="bold" /></RailButton>
        {hasLow && (
          <button type="button" onClick={() => setPref("lowRes", !prefs.lowRes)} aria-label="切换清晰度"
            className="rounded-full bg-black/45 px-2.5 py-1 text-[12px] font-semibold text-white backdrop-blur-sm">
            {prefs.lowRes ? "低清" : "原画"}
          </button>
        )}
      </div>

      <MediaActions media={media} open={menu} onClose={() => setMenu(false)} onRemove={onRemove} video={video} />
      <Sheet open={quickTags && enabled} onClose={() => setQuickTags(false)} title="标签收藏"><QuickTagPanel media={media} onDone={() => setQuickTags(false)} /></Sheet>

      <div className="absolute inset-x-0 bottom-[calc(4.25rem+env(safe-area-inset-bottom))] px-3">
        <SeekBar video={video} source={src} mediaId={media.id} enabled={enabled && !invalid} duration={media.duration_seconds ?? 0} bounds={range} />
      </div>
    </section>
  );
}

function RailButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <motion.button type="button" aria-label={label} title={label} onClick={onClick} whileTap={{ scale: 0.85 }}
      className="grid size-12 place-items-center rounded-full text-white drop-shadow-[0_1px_6px_rgb(0_0_0/0.5)]">
      {children}
    </motion.button>
  );
}
