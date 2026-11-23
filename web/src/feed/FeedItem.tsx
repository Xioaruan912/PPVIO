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
import { haptic } from "../ui/haptics";

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
        haptic(12);
        setQuickTags(true);
        const y = lastY.current;
        setBursts(list => [...list, { id: performance.now(), x, y }]);
      } else if (event === "long-press-start" && el) { haptic(10); el.playbackRate = 2; setFast(true); }
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

      {/* Subtle top & bottom cinema vignettes so floating glass controls always remain legible */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-28 bg-gradient-to-b from-black/55 to-transparent" />
      <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 h-44 bg-gradient-to-t from-black/72 via-black/28 to-transparent" />

      <LoadingFeedback video={video} source={src} waiting={loading}
        enabled={active && mounted && !paused && !locked && visible && !failed && !invalid} />
      {invalid && active && <div className="glass-sheet absolute inset-x-6 top-1/3 z-10 rounded-[22px] border border-white/[0.14] p-5 text-center text-white"><p className="mb-3 text-sm">片段位置已超出视频时长</p><button type="button" className="pressable min-h-11 rounded-full bg-accent px-5 text-sm font-semibold text-white" onClick={() => { setOriginal(true); setPaused(false); if (video.current) { video.current.currentTime = 0; void video.current.play().catch(() => setPaused(true)); } }}>打开原视频</button></div>}

      <AnimatePresence>
        {paused && active && (
          <motion.span key="paused" className="glass-pill pointer-events-none absolute left-1/2 top-1/2 -ml-10 -mt-10 grid size-20 place-items-center rounded-full border-gold/30 text-gold-bright shadow-[0_12px_36px_rgba(0,0,0,0.55)]"
            initial={{ opacity: 0, scale: 0.72 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 1.15 }}
            transition={{ type: "spring", visualDuration: 0.28, bounce: 0.2 }}>
            <PlayIcon size={34} weight="fill" className="translate-x-0.5" />
          </motion.span>
        )}
        {fast && (
          <motion.span key="fast" className="glass-pill-gold pointer-events-none absolute left-1/2 top-[max(1.1rem,env(safe-area-inset-top))] -translate-x-1/2 rounded-full px-4 py-1.5 text-[13px] font-semibold tracking-tight"
            initial={{ opacity: 0, y: -12, scale: 0.88 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -6, scale: 0.94 }}
            transition={{ type: "spring", visualDuration: 0.26, bounce: 0.2 }}>2× 快进中</motion.span>
        )}
        {bursts.map(burst => (
          <motion.span key={burst.id} className="pointer-events-none absolute" style={{ left: burst.x - 44, top: burst.y - 44 }}
            initial={{ scale: 0.35, opacity: 0, rotate: -14 }} animate={{ scale: [0.35, 1.32, 1.05], opacity: [0, 1, 1, 0], y: -74 }}
            transition={{ duration: 0.82, ease: [0.22, 1, 0.36, 1] }} onAnimationComplete={() => setBursts(list => list.filter(b => b.id !== burst.id))}>
            <motion.span aria-hidden="true" className="absolute inset-1 rounded-full border-2 border-gold-bright/80"
              initial={{ scale: 0.4, opacity: 0.9 }} animate={{ scale: 2.1, opacity: 0 }} transition={{ duration: 0.55, ease: "easeOut" }} />
            <HeartIcon size={88} weight="fill" className="text-accent drop-shadow-[0_8px_28px_rgba(255,69,58,0.6)]" />
          </motion.span>
        ))}
      </AnimatePresence>

      {enabled && !invalid && <RecoveryNotice {...recovery} compatible={hasLow && !prefs.lowRes ? () => setPref("lowRes", true) : undefined} />}
      {enabled && horizontal.target !== null && <div className="pointer-events-none absolute inset-x-0 bottom-44"><SeekPreview id={media.id} time={horizontal.target} enabled /></div>}

      {!raised && (
        <motion.div
          animate={active ? { opacity: 1, y: 0 } : { opacity: 0, y: 12 }}
          transition={{ type: "spring", visualDuration: 0.38, bounce: 0.08 }}
          className="pointer-events-none absolute bottom-[calc(7.25rem+env(safe-area-inset-bottom))] left-3.5 flex max-w-[70%] flex-col items-start gap-2">
          <AnimatePresence>
            {prefs.muted && active && (
              <motion.button key="unmute-hint" type="button" aria-label="点按开启声音"
                initial={{ opacity: 0, y: 8, scale: 0.92 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -6, scale: 0.92 }}
                transition={{ type: "spring", visualDuration: 0.3, bounce: 0.16 }}
                onClick={() => { haptic(8); setPref("muted", false); }}
                className="glass-pill-gold pressable pointer-events-auto inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[12px] font-semibold">
                <SpeakerSlashIcon size={14} weight="fill" />点按开启声音
              </motion.button>
            )}
          </AnimatePresence>
          {media.groups?.[0]?.label && (
            <div className="glass-pill inline-flex max-w-full items-center gap-2 rounded-full px-3.5 py-1.5 text-[13px] font-medium tracking-[-0.01em] text-ink/95">
              <span className="size-1.5 shrink-0 rounded-full bg-gold shadow-[0_0_8px_rgba(230,198,135,0.9)]" aria-hidden="true" />
              <span className="truncate">{media.groups[0].label}</span>
            </div>
          )}
        </motion.div>
      )}

      <motion.div
        animate={active ? { opacity: 1, x: 0 } : { opacity: 0.5, x: 16 }}
        transition={{ type: "spring", visualDuration: 0.38, bounce: 0.14 }}
        className={`absolute right-3 flex flex-col items-center gap-3.5 transition-[bottom] duration-300 ease-out ${raised ? "bottom-[calc(18.5rem+env(safe-area-inset-bottom))]" : "bottom-[calc(7rem+env(safe-area-inset-bottom))]"}`}>
        <QuickTagButton media={media} enabled={enabled} iconOnly />
        <RailButton label={prefs.muted ? "打开声音" : "静音"} onClick={() => setPref("muted", !prefs.muted)}>
          {prefs.muted ? <SpeakerSlashIcon size={22} weight="fill" /> : <SpeakerHighIcon size={22} weight="fill" className="text-gold-bright" />}
        </RailButton>
        <BookmarkButton media={media} video={video} enabled={enabled} />
        <RailButton label="更多" onClick={() => setMenu(true)}><DotsThreeIcon size={24} weight="bold" /></RailButton>
        {hasLow && (
          <motion.button type="button" onClick={() => setPref("lowRes", !prefs.lowRes)} aria-label="切换清晰度"
            whileHover={{ scale: 1.07 }} whileTap={{ scale: 0.88 }} transition={{ type: "spring", stiffness: 500, damping: 24 }}
            className="glass-pill rounded-full px-2.5 py-1.5 text-[11px] font-semibold tracking-wide text-gold-bright">
            {prefs.lowRes ? "低清" : "原画"}
          </motion.button>
        )}
      </motion.div>

      <MediaActions media={media} open={menu} onClose={() => setMenu(false)} onRemove={onRemove} video={video} />
      <Sheet open={quickTags && enabled} onClose={() => setQuickTags(false)} title="标签收藏"><QuickTagPanel media={media} onDone={() => setQuickTags(false)} /></Sheet>

      <div className="absolute inset-x-0 bottom-[calc(4.9rem+env(safe-area-inset-bottom))] px-3.5">
        <SeekBar video={video} source={src} mediaId={media.id} enabled={enabled && !invalid} duration={media.duration_seconds ?? 0} bounds={range} />
      </div>
    </section>
  );
}

function RailButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <motion.button type="button" aria-label={label} title={label} onClick={onClick}
      whileHover={{ scale: 1.08 }} whileTap={{ scale: 0.82 }}
      transition={{ type: "spring", stiffness: 520, damping: 24 }}
      className="glass-pill grid size-11 place-items-center rounded-full text-white hover:border-gold/35">
      {children}
    </motion.button>
  );
}
