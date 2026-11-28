import { DotsThreeIcon, HeartIcon, SpeakerHighIcon, SpeakerSlashIcon, PlayIcon, CheckCircleIcon, ArrowRightIcon } from "@phosphor-icons/react";
import { AnimatePresence, motion, useMotionValue, useTransform, type PanInfo } from "motion/react";
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
import { FilmSlatePill } from "../ui/CinemaChrome";
import { SPRING_PILL, SPRING_TAP } from "../ui/motion";

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
  /** 整理模式 buttons sit at the bottom; also enables 1:1 horizontal swipe-to-triage! */
  raised?: boolean;
  onTriageKeep?: () => void;
  onTriageSkip?: () => void;
  startAt?: number;
  onEnded?: () => void;
}

interface Burst { id: number; x: number; y: number }

export function FeedItem({
  media, active, mounted, eager = false, onBufferReadiness, onRemove,
  raised = false, onTriageKeep, onTriageSkip, startAt, onEnded,
}: Props) {
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
  const { attachVideo, visible, buffered } = useFeedPlayback(video, {
    media, src, active, mounted, eager, paused, locked, onPause, onBufferReadiness, original,
  });

  // 1:1 Apple pointer physics for Organize Swipe-to-Triage (Right = Keep/Organize, Left = Skip)
  const triageX = useMotionValue(0);
  const triageRotate = useTransform(triageX, [-220, 0, 220], [-6.5, 0, 6.5]);
  const keepOpacity = useTransform(triageX, [24, 110], [0, 1]);
  const keepScale = useTransform(triageX, [24, 110], [0.88, 1]);
  const skipOpacity = useTransform(triageX, [-110, -24], [1, 0]);
  const skipScale = useTransform(triageX, [-110, -24], [1, 0.88]);
  const handleTriageEnd = (_: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) => {
    if (!raised) return;
    if (info.offset.x > 92 || info.velocity.x > 460) {
      haptic(14);
      onTriageKeep?.();
    } else if (info.offset.x < -92 || info.velocity.x < -460) {
      haptic(8);
      onTriageSkip?.();
    }
  };

  const enabled = active && mounted && !locked && visible;
  usePlaybackHistory(video, media, src, enabled);
  const { range, invalid } = useClipRange(video, src, mounted && (active || eager) && !locked && visible, clip, active && !paused, active);
  // Horizontal scrub yields to horizontal Swipe-to-Triage while Organize mode is active.
  const horizontal = useHorizontalSeek(video, src, enabled && !invalid && !raised, range);
  const recovery = usePlaybackRecovery(video, src, enabled);

  useEffect(() => {
    if (active) return;
    setPaused(false); setFast(false); setMenu(false); setQuickTags(false);
    triageX.set(0);
    const el = video.current;
    if (!el) return;
    if (!clip) el.currentTime = 0;
    el.playbackRate = 1;
  }, [active, mounted, src, clip?.start, triageX]);

  useEffect(() => { if (video.current) video.current.muted = prefs.muted; }, [prefs.muted]);

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

  const resLabel = media.height ? `${media.height}P` : null;

  return (
    <section className="relative h-dvh w-full snap-start snap-always overflow-hidden bg-bg" aria-label="视频">
      {/* Ambient cinema backplate for desktop portrait framing or landscape clips */}
      {media.cover_url && (
        <img
          src={media.cover_url}
          alt=""
          aria-hidden="true"
          className={`pointer-events-none absolute inset-0 size-full scale-110 object-cover blur-3xl ${landscape ? "opacity-45" : "hidden opacity-28 lg:block"}`}
        />
      )}

      {/* Scrubbed depth stage + 1:1 Swipe-to-Triage physics when Organize mode is enabled */}
      <motion.div
        data-feed-stage
        drag={raised && active ? "x" : false}
        dragDirectionLock
        dragConstraints={{ left: 0, right: 0 }}
        dragElastic={{ left: 0.42, right: 0.42 }}
        onDragEnd={handleTriageEnd}
        style={raised ? { x: triageX, rotate: triageRotate } : undefined}
        className={`relative mx-auto size-full overflow-hidden bg-black will-change-transform ${!landscape ? "lg:my-3 lg:h-[calc(100dvh-1.5rem)] lg:max-w-[540px] lg:rounded-[24px] lg:aperture-frame" : ""}`}
      >
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

        {/* Gesture surface */}
        <div className="absolute inset-0 touch-pan-y select-none"
          onPointerDown={event => { lastY.current = event.clientY; horizontal.down(event.clientX, event.clientY); recognizer.current?.down(event.clientX, event.clientY, performance.now()); }}
          onPointerMove={event => { if (horizontal.move(event.clientX, event.clientY)) { event.currentTarget.setPointerCapture?.(event.pointerId); recognizer.current?.cancel(); } else recognizer.current?.move(event.clientX, event.clientY); }}
          onPointerUp={event => { if (horizontal.up(event.clientX, event.clientY)) recognizer.current?.cancel(); else recognizer.current?.up(event.clientX, performance.now()); }}
          onPointerCancel={() => { horizontal.cancel(); recognizer.current?.cancel(); }}
          onContextMenu={event => event.preventDefault()} />

        {/* Directional aperture stamps during Swipe-to-Triage */}
        {raised && active && (
          <>
            <motion.div aria-hidden="true" style={{ opacity: keepOpacity, scale: keepScale }}
              className="pointer-events-none absolute left-5 top-24 z-20 inline-flex items-center gap-2 rounded-full border border-gold/70 bg-black/75 px-4 py-2 text-[14px] font-semibold text-gold-bright backdrop-blur-md">
              <CheckCircleIcon size={20} weight="fill" className="text-ok" />
              <span>整理留存 →</span>
            </motion.div>
            <motion.div aria-hidden="true" style={{ opacity: skipOpacity, scale: skipScale }}
              className="pointer-events-none absolute right-5 top-24 z-20 inline-flex items-center gap-2 rounded-full border border-line-strong bg-black/75 px-4 py-2 text-[14px] font-semibold text-ink/90 backdrop-blur-md">
              <span>← 跳过此条</span>
              <ArrowRightIcon size={18} weight="bold" />
            </motion.div>
          </>
        )}

        {/* Cinema framing vignettes */}
        <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-32 bg-gradient-to-b from-black/62 via-black/18 to-transparent" />
        <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 h-52 bg-gradient-to-t from-black/78 via-black/32 to-transparent" />

        <LoadingFeedback video={video} source={src} waiting={loading}
          enabled={active && mounted && !paused && !locked && visible && !failed && !invalid} />
        {invalid && active && (
          <div className="glass-sheet absolute inset-x-6 top-1/3 z-10 rounded-[22px] border border-line p-5 text-center text-ink">
            <p className="mb-3 text-sm">片段位置已超出视频时长</p>
            <button type="button" className="pressable min-h-11 rounded-full bg-accent px-5 text-sm font-semibold text-white"
              onClick={() => { setOriginal(true); setPaused(false); if (video.current) { video.current.currentTime = 0; void video.current.play().catch(() => setPaused(true)); } }}>
              打开原视频
            </button>
          </div>
        )}

        <AnimatePresence>
          {paused && active && (
            <motion.span key="paused" className="glass-pill pointer-events-none absolute left-1/2 top-1/2 -ml-10 -mt-10 grid size-20 place-items-center rounded-full border-gold/40 text-gold-bright shadow-[0_14px_38px_rgba(0,0,0,0.6)]"
              initial={{ opacity: 0, scale: 0.84 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 1.08 }}
              transition={SPRING_PILL}>
              <PlayIcon size={34} weight="fill" className="translate-x-0.5" />
            </motion.span>
          )}
          {fast && (
            <motion.span key="fast" className="glass-pill-gold film-slate pointer-events-none absolute left-1/2 top-[max(3.9rem,env(safe-area-inset-top))] -translate-x-1/2 rounded-full px-4 py-1.5 text-[12px] font-semibold"
              initial={{ opacity: 0, y: -10, scale: 0.92 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -6, scale: 0.94 }}
              transition={SPRING_PILL}>2.0× FAST</motion.span>
          )}
          {bursts.map(burst => (
            <motion.span key={burst.id} className="pointer-events-none absolute" style={{ left: burst.x - 44, top: burst.y - 44 }}
              initial={{ scale: 0.6, opacity: 0, rotate: -14 }} animate={{ scale: [0.6, 1.28, 1.04], opacity: [0, 1, 1, 0], y: -74 }}
              transition={{ duration: 0.78, ease: [0.22, 1, 0.36, 1] }} onAnimationComplete={() => setBursts(list => list.filter(b => b.id !== burst.id))}>
              <motion.span aria-hidden="true" className="absolute inset-1 rounded-full border-2 border-gold-bright/80"
                initial={{ scale: 0.65, opacity: 0.9 }} animate={{ scale: 2.0, opacity: 0 }} transition={{ duration: 0.5, ease: "easeOut" }} />
              <HeartIcon size={88} weight="fill" className="text-accent drop-shadow-[0_8px_28px_rgba(255,69,58,0.6)]" />
            </motion.span>
          ))}
        </AnimatePresence>

        {enabled && !invalid && <RecoveryNotice {...recovery} compatible={hasLow && !prefs.lowRes ? () => setPref("lowRes", true) : undefined} />}
        {enabled && horizontal.target !== null && <div className="pointer-events-none absolute inset-x-0 bottom-44"><SeekPreview id={media.id} time={horizontal.target} enabled /></div>}

        {/* Editorial bottom-left cinema title unmask & live film-slate telemetry */}
        {!raised && (
          <div className="pointer-events-none absolute bottom-[calc(7.3rem+env(safe-area-inset-bottom))] left-3.5 flex max-w-[74%] flex-col items-start gap-2">
            <AnimatePresence>
              {prefs.muted && active && (
                <motion.button key="unmute-hint" type="button" aria-label="点按开启声音"
                  initial={{ opacity: 0, y: 8, scale: 0.94 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -6, scale: 0.94 }}
                  transition={SPRING_PILL}
                  onClick={() => { haptic(8); setPref("muted", false); }}
                  className="glass-pill-gold pressable pointer-events-auto inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[12px] font-semibold">
                  <SpeakerSlashIcon size={14} weight="fill" />点按开启声音
                </motion.button>
              )}
            </AnimatePresence>
            {active && (
              <FilmSlatePill
                resolution={resLabel}
                codec={media.codec}
                bufferedSeconds={buffered}
                lowRes={prefs.lowRes && hasLow}
              />
            )}
            {media.groups?.[0]?.label && (
              <div className="overflow-hidden">
                <motion.div
                  animate={active ? { opacity: 1, y: 0 } : { opacity: 0, y: 18 }}
                  transition={{ duration: 0.36, ease: [0.22, 1, 0.36, 1] }}
                  className="glass-pill inline-flex max-w-full items-center gap-2 rounded-full px-3.5 py-1.5 text-[13px] font-medium tracking-[-0.01em] text-ink">
                  <span className="size-1.5 shrink-0 rounded-full bg-gold shadow-[0_0_8px_rgba(229,196,132,0.9)]" aria-hidden="true" />
                  <span className="truncate">{media.groups[0].label}</span>
                </motion.div>
              </div>
            )}
          </div>
        )}

        {/* Right optical rail — stably anchored (no stagger on rapid swipes) */}
        <div className={`absolute right-3 flex flex-col items-center gap-3 transition-[bottom] duration-250 ease-out ${raised ? "bottom-[calc(23.5rem+env(safe-area-inset-bottom))]" : "bottom-[calc(7.1rem+env(safe-area-inset-bottom))]"}`}>
          <QuickTagButton media={media} enabled={enabled} iconOnly />
          <RailButton label={prefs.muted ? "打开声音" : "静音"} onClick={() => setPref("muted", !prefs.muted)}>
            {prefs.muted ? <SpeakerSlashIcon size={21} weight="fill" /> : <SpeakerHighIcon size={21} weight="fill" className="text-gold-bright" />}
          </RailButton>
          <BookmarkButton media={media} video={video} enabled={enabled} />
          <RailButton label="更多" onClick={() => setMenu(true)}><DotsThreeIcon size={23} weight="bold" /></RailButton>
          {hasLow && !raised && (
            <motion.button type="button" onClick={() => setPref("lowRes", !prefs.lowRes)} aria-label="切换清晰度"
              whileTap={{ scale: 0.9 }} transition={SPRING_TAP}
              className="glass-pill film-slate rounded-full px-2.5 py-1.5 text-[10px] font-semibold text-gold-bright">
              {prefs.lowRes ? "480P" : "原画"}
            </motion.button>
          )}
        </div>

        {!raised && (
          <div className="absolute inset-x-0 bottom-[calc(4.9rem+env(safe-area-inset-bottom))] px-3.5">
            <SeekBar video={video} source={src} mediaId={media.id} enabled={enabled && !invalid} duration={media.duration_seconds ?? 0} bounds={range} />
          </div>
        )}
      </motion.div>

      <MediaActions media={media} open={menu} onClose={() => setMenu(false)} onRemove={onRemove} video={video} />
      <Sheet open={quickTags && enabled} onClose={() => setQuickTags(false)} title="标签收藏"><QuickTagPanel media={media} onDone={() => setQuickTags(false)} /></Sheet>
    </section>
  );
}

function RailButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <motion.button type="button" aria-label={label} title={label} onClick={onClick}
      whileTap={{ scale: 0.88 }} transition={SPRING_TAP}
      className="glass-pill grid size-11 place-items-center rounded-full text-ink hover:border-gold/40">
      {children}
    </motion.button>
  );
}
