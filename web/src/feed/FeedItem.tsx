import {
  ArrowsClockwiseIcon, CaretLeftIcon, CaretRightIcon, DotsThreeIcon, HeartIcon,
  PlayIcon, SlidersHorizontalIcon, SpeakerHighIcon, SpeakerSlashIcon, SparkleIcon,
} from "@phosphor-icons/react";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { chooseStream, type Media } from "../api";
import { setPref, usePrefs } from "../prefs";
import { setRating, StarRating } from "../ratings";
import { useLocked } from "../ui/privacy";
import { GestureRecognizer } from "./gestures";
import { MediaActions } from "./MediaActions";
import { useFeedPlayback, type BufferReadiness } from "./useFeedPlayback";
import { LoadingFeedback } from "../ui/LoadingFeedback";
import { SeekBar } from "../ui/SeekBar";
import { SeekPreview } from "../ui/SeekPreview";
import { BookmarkButton } from "../ui/Bookmarks";
import { usePlaybackRecovery, RecoveryNotice } from "../player/usePlaybackRecovery";
import { useClipRange } from "../player/clipRange";
import { usePlaybackHistory } from "../player/usePlaybackHistory";
import { QuickTagButton, QuickTagPanel } from "../ui/QuickTags";
import { Sheet } from "../ui/Sheet";
import { haptic } from "../ui/haptics";
import { OdometerIndex } from "../ui/CinemaChrome";
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
  onRemove?: (media: Media) => void;
  /** Organize mode docks cleanly below the video (never overlapping the video frame). */
  raised?: boolean;
  organizePanel?: ReactNode;
  index?: number;
  total?: number;
  onPrev?: () => void;
  onNext?: () => void;
  onRefresh?: () => void;
  onToggleOrganize?: () => void;
  preferencesTrigger?: ReactNode;
  startAt?: number;
  onEnded?: () => void;
}

interface Burst { id: number; x: number; y: number }

export function FeedItem({
  media, active, mounted, eager = false, onBufferReadiness, onRemove,
  raised = false, organizePanel, index = 0, total = 1,
  onPrev, onNext, onRefresh, onToggleOrganize, preferencesTrigger,
  startAt, onEnded,
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
  const { attachVideo, visible } = useFeedPlayback(video, {
    media, src, active, mounted, eager, paused, locked, onPause, onBufferReadiness, original,
  });

  const enabled = active && mounted && !locked && visible;
  usePlaybackHistory(video, media, src, enabled);
  const { range, invalid } = useClipRange(
    video, src, mounted && (active || eager) && !locked && visible, clip, active && !paused, active,
  );
  const recovery = usePlaybackRecovery(video, src, enabled);

  useEffect(() => {
    if (active) return;
    setPaused(false);
    setFast(false);
    setMenu(false);
    setQuickTags(false);
    const el = video.current;
    if (!el) return;
    if (!clip) el.currentTime = 0;
    el.playbackRate = 1;
  }, [active, mounted, src, clip?.start]);

  useEffect(() => { if (video.current) video.current.muted = prefs.muted; }, [prefs.muted]);

  // Direct keyboard controls: Space pause, M mute, 1-5 instant star rating, 0 clear rating
  useEffect(() => {
    if (!active || menu) return;
    const onKey = (event: KeyboardEvent) => {
      if (
        event.metaKey || event.ctrlKey || event.altKey
        || event.target instanceof HTMLInputElement
        || event.target instanceof HTMLTextAreaElement
      ) return;
      if (event.key === " ") {
        event.preventDefault();
        setPaused(value => !value);
      } else if (event.key.toLowerCase() === "m") {
        setPref("muted", !prefs.muted);
      } else if (event.key >= "1" && event.key <= "5") {
        event.preventDefault();
        const n = Number(event.key);
        haptic(n >= 4 ? 12 : 6);
        setRating(media.id, n, { announceToast: true });
      } else if (event.key === "0") {
        event.preventDefault();
        setRating(media.id, 0, { announceToast: true });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, menu, prefs.muted, media.id]);

  useEffect(() => {
    const g = new GestureRecognizer((event, x) => {
      const el = video.current;
      if (event === "tap") setPaused(value => !value);
      else if (event === "double-tap") {
        haptic(14);
        setRating(media.id, 5, { announceToast: true });
        const y = lastY.current;
        setBursts(list => [...list, { id: performance.now(), x, y }]);
      } else if (event === "long-press-start" && el) {
        haptic(10);
        el.playbackRate = 2;
        setFast(true);
      } else if (event === "long-press-end" && el) {
        el.playbackRate = 1;
        setFast(false);
      }
    });
    recognizer.current = g;
    return () => g.dispose();
  }, [media.id]);

  const progressRatio = total > 0 ? ((index + 1) / total) * 100 : 0;

  return (
    <section
      className="flex h-full w-full shrink-0 snap-start snap-always flex-col overflow-hidden bg-bg"
      aria-label="视频"
    >
      {/* 100% UNOBSTRUCTED OPTICAL VIDEO STAGE — zero floating controls or text over the video */}
      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden px-2 py-2 sm:px-16 sm:py-3">
        {/* Flanking horizontal folio arrows live cleanly in the darkroom side margins OUTSIDE the video */}
        {onPrev && (
          <motion.button
            type="button"
            aria-label="上一条视频"
            disabled={index <= 0}
            onClick={() => { haptic(6); onPrev(); }}
            whileTap={{ scale: 0.9 }}
            transition={SPRING_TAP}
            className="absolute left-4 top-1/2 z-10 hidden size-11 -translate-y-1/2 place-items-center rounded-full border border-line bg-surface/80 text-ink transition-colors hover:border-gold/55 hover:text-gold-bright disabled:opacity-20 sm:grid"
          >
            <CaretLeftIcon size={20} weight="bold" />
          </motion.button>
        )}
        {onNext && (
          <motion.button
            type="button"
            aria-label="下一条视频"
            disabled={index >= total - 1}
            onClick={() => { haptic(6); onNext(); }}
            whileTap={{ scale: 0.9 }}
            transition={SPRING_TAP}
            className="absolute right-4 top-1/2 z-10 hidden size-11 -translate-y-1/2 place-items-center rounded-full border border-line bg-surface/80 text-ink transition-colors hover:border-gold/55 hover:text-gold-bright disabled:opacity-20 sm:grid"
          >
            <CaretRightIcon size={20} weight="bold" />
          </motion.button>
        )}

        {/* Dedicated unobstructed optical aperture container */}
        <div
          data-feed-stage
          className={`relative flex size-full items-center justify-center overflow-hidden rounded-[16px] bg-black will-change-transform ${
            landscape ? "max-w-5xl" : "max-w-[540px]"
          } sm:aperture-frame`}
        >
          {mounted ? (
            <video
              ref={attachVideo}
              src={src}
              poster={media.cover_url ?? undefined}
              playsInline
              loop={!clip && !onEnded}
              muted={prefs.muted}
              onEnded={() => { if (!clip && enabled && !paused) onEnded?.(); }}
              preload={!locked && visible && (active || eager) ? "auto" : "metadata"}
              onLoadedMetadata={event => {
                if (!startedAt.current && startAt !== undefined) {
                  event.currentTarget.currentTime = Math.min(startAt, event.currentTarget.duration);
                  startedAt.current = true;
                }
              }}
              onLoadStart={() => { setFailed(false); setLoading(true); }}
              onWaiting={event => { if (!event.currentTarget.paused) setLoading(true); }}
              onSeeking={event => { if (!event.currentTarget.paused) setLoading(true); }}
              onCanPlay={() => setLoading(false)}
              onSeeked={event => setLoading(!event.currentTarget.paused && event.currentTarget.readyState < 3)}
              onPlay={event => setLoading(event.currentTarget.readyState < 3)}
              onPause={() => setLoading(false)}
              onError={() => { setFailed(true); setLoading(false); }}
              onPlaying={() => { setFailed(false); setLoading(false); }}
              className="size-full object-contain"
            />
          ) : media.cover_url ? (
            <img src={media.cover_url} alt="" className="size-full object-contain" />
          ) : null}

          {/* Clean gesture surface: tap to pause, double-tap to 5★ love, hold for 2×; horizontal swipe passes through to folio pager */}
          <div
            className="absolute inset-0 touch-pan-x select-none"
            onPointerDown={event => {
              lastY.current = event.clientY;
              recognizer.current?.down(event.clientX, event.clientY, performance.now());
            }}
            onPointerMove={event => recognizer.current?.move(event.clientX, event.clientY)}
            onPointerUp={event => recognizer.current?.up(event.clientX, performance.now())}
            onPointerCancel={() => recognizer.current?.cancel()}
            onContextMenu={event => event.preventDefault()}
          />

          <LoadingFeedback
            video={video}
            source={src}
            waiting={loading}
            enabled={active && mounted && !paused && !locked && visible && !failed && !invalid}
          />

          {invalid && active && (
            <div className="glass-sheet absolute inset-x-6 top-1/3 z-10 rounded-[20px] border border-line p-5 text-center text-ink">
              <p className="mb-3 text-sm">片段位置已超出视频时长</p>
              <button
                type="button"
                className="pressable min-h-11 rounded-full bg-gold px-5 text-sm font-semibold text-bg"
                onClick={() => {
                  setOriginal(true);
                  setPaused(false);
                  if (video.current) {
                    video.current.currentTime = 0;
                    void video.current.play().catch(() => setPaused(true));
                  }
                }}
              >
                打开原视频
              </button>
            </div>
          )}

          <AnimatePresence>
            {paused && active && (
              <motion.span
                key="paused"
                className="glass-pill pointer-events-none absolute left-1/2 top-1/2 -ml-9 -mt-9 grid size-18 place-items-center rounded-full border-gold/40 text-gold-bright"
                initial={{ opacity: 0, scale: 0.84 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 1.08 }}
                transition={SPRING_PILL}
              >
                <PlayIcon size={30} weight="fill" className="translate-x-0.5" />
              </motion.span>
            )}
            {fast && (
              <motion.span
                key="fast"
                className="glass-pill-gold pointer-events-none absolute left-1/2 top-4 -translate-x-1/2 rounded-full px-4 py-1 text-[13px] font-semibold"
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={SPRING_PILL}
              >
                2×
              </motion.span>
            )}
            {bursts.map(burst => (
              <motion.span
                key={burst.id}
                className="pointer-events-none absolute"
                style={{ left: burst.x - 40, top: burst.y - 40 }}
                initial={{ scale: 0.6, opacity: 0, rotate: -10 }}
                animate={{ scale: [0.6, 1.25, 1.0], opacity: [0, 1, 1, 0], y: -64 }}
                transition={{ duration: 0.72, ease: [0.22, 1, 0.36, 1] }}
                onAnimationComplete={() => setBursts(list => list.filter(b => b.id !== burst.id))}
              >
                <HeartIcon size={80} weight="fill" className="text-gold-bright drop-shadow-[0_8px_24px_rgba(229,196,132,0.55)]" />
              </motion.span>
            ))}
          </AnimatePresence>

          {enabled && !invalid && (
            <RecoveryNotice
              {...recovery}
              compatible={hasLow && !prefs.lowRes ? () => setPref("lowRes", true) : undefined}
            />
          )}
        </div>
      </div>

      {/* Inline Organize Drawer — sits cleanly BELOW the video inside the flex column, NEVER covering video pixels */}
      <AnimatePresence initial={false}>
        {raised && active && organizePanel && (
          <motion.div
            key="inline-organize"
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 12 }}
            transition={SPRING_PILL}
            className="mx-auto w-full max-w-2xl shrink-0 border-t border-line bg-surface/95 px-3 py-1"
          >
            {organizePanel}
          </motion.div>
        )}
      </AnimatePresence>

      {/* DEDICATED OUTSIDE BOTTOM CONSOLE — 100% OUTSIDE THE VIDEO FRAME */}
      <footer className="shrink-0 border-t border-line bg-bg px-3.5 pb-[max(0.7rem,env(safe-area-inset-bottom))] pt-1.5 sm:px-8">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-1.5">
          {/* Unobstructed full-width timeline scrubber */}
          <SeekBar
            video={video}
            source={src}
            mediaId={media.id}
            enabled={enabled && !invalid}
            duration={media.duration_seconds ?? 0}
            bounds={range}
          />

          {/* Clean Perimeter Control Rail: 1 unified row on desktop, 2 balanced symmetric rows on 390px mobile */}
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
            {/* Row 1 (Mobile) / Left+Center (Desktop): Direct 1-Tap 5-Star Rating + Horizontal Folio Index */}
            <div className="flex items-center justify-between gap-3 sm:flex-1">
              <StarRating mediaId={media.id} compact />

              <div className="flex items-center gap-2 sm:mx-auto">
                {onPrev && (
                  <button
                    type="button"
                    aria-label="上一条"
                    disabled={index <= 0}
                    onClick={() => { haptic(6); onPrev(); }}
                    className="grid size-8 place-items-center rounded-full border border-line text-ink/85 hover:border-gold/50 disabled:opacity-25 sm:hidden"
                  >
                    <CaretLeftIcon size={15} weight="bold" />
                  </button>
                )}
                <div className="flex items-center gap-2.5">
                  <OdometerIndex current={index + 1} total={total} className="text-[13px]" />
                  <div className="hidden h-[2px] w-24 overflow-hidden bg-white/15 md:block" aria-hidden="true">
                    <div
                      className="h-full bg-gold transition-[width] duration-300 ease-out"
                      style={{ width: `${Math.min(100, progressRatio)}%` }}
                    />
                  </div>
                </div>
                {onNext && (
                  <button
                    type="button"
                    aria-label="下一条"
                    disabled={index >= total - 1}
                    onClick={() => { haptic(6); onNext(); }}
                    className="grid size-8 place-items-center rounded-full border border-line text-ink/85 hover:border-gold/50 disabled:opacity-25 sm:hidden"
                  >
                    <CaretRightIcon size={15} weight="bold" />
                  </button>
                )}
              </div>
            </div>

            {/* Row 2 (Mobile) / Right (Desktop): Minimal essential controls — ALL outside the video */}
            <div className="flex items-center justify-between gap-1.5 sm:justify-end sm:gap-2">
              <ConsoleButton
                label={prefs.muted ? "打开声音" : "静音"}
                active={prefs.muted}
                onClick={() => { haptic(6); setPref("muted", !prefs.muted); }}
              >
                {prefs.muted ? <SpeakerSlashIcon size={18} weight="fill" /> : <SpeakerHighIcon size={18} weight="fill" />}
              </ConsoleButton>

              <QuickTagButton media={media} enabled={enabled} iconOnly />
              <BookmarkButton media={media} video={video} enabled={enabled} />

              {onToggleOrganize && (
                <ConsoleButton
                  label={raised ? "完成整理" : "开启极速整理"}
                  active={raised}
                  onClick={() => { haptic(8); onToggleOrganize(); }}
                >
                  <SparkleIcon size={18} weight={raised ? "fill" : "regular"} />
                </ConsoleButton>
              )}

              {onRefresh && (
                <ConsoleButton
                  label="按喜好换一批"
                  onClick={() => { haptic(10); onRefresh(); }}
                >
                  <ArrowsClockwiseIcon size={18} />
                </ConsoleButton>
              )}

              {preferencesTrigger ?? (
                <span className="hidden" aria-hidden="true"><SlidersHorizontalIcon size={16} /></span>
              )}

              {hasLow && (
                <button
                  type="button"
                  onClick={() => setPref("lowRes", !prefs.lowRes)}
                  aria-label="切换清晰度"
                  className="h-9 rounded-full border border-line px-3 text-[13px] font-medium text-ink/85 hover:border-gold/50 hover:text-gold-bright"
                >
                  {prefs.lowRes ? "480P" : "原画"}
                </button>
              )}

              <ConsoleButton label="更多" onClick={() => setMenu(true)}>
                <DotsThreeIcon size={20} weight="bold" />
              </ConsoleButton>
            </div>
          </div>
        </div>
      </footer>

      <MediaActions media={media} open={menu} onClose={() => setMenu(false)} onRemove={onRemove} video={video} />
      <Sheet open={quickTags && enabled} onClose={() => setQuickTags(false)} title="标签收藏">
        <QuickTagPanel media={media} onDone={() => setQuickTags(false)} />
      </Sheet>
    </section>
  );
}

function ConsoleButton({
  label, active = false, onClick, children,
}: {
  label: string; active?: boolean; onClick: () => void; children: ReactNode;
}) {
  return (
    <motion.button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active || undefined}
      onClick={onClick}
      whileTap={{ scale: 0.88 }}
      transition={SPRING_TAP}
      className={`grid size-9 place-items-center rounded-full border transition-colors ${
        active
          ? "border-gold/55 bg-gold/15 text-gold-bright"
          : "border-line bg-surface/70 text-ink/85 hover:border-gold/45 hover:text-ink"
      }`}
    >
      {children}
    </motion.button>
  );
}

export { SeekPreview };
