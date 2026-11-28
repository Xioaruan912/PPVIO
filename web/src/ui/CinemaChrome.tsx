import { AnimatePresence, motion } from "motion/react";
import type { ReactNode } from "react";
import { EASE_HUD, SPRING_TAP } from "./motion";

/**
 * Mechanical vertical odometer index readout (actuel-img.com inspired).
 * Rolls digits cleanly inside an overflow-hidden aperture with tabular Azeret Mono figures.
 */
export function OdometerIndex({ current, total, className = "" }: { current: number; total: number; className?: string }) {
  const curStr = String(current).padStart(2, "0");
  const totStr = String(Math.max(current, total)).padStart(2, "0");
  return (
    <span className={`film-slate inline-flex items-center gap-1 text-[11px] font-semibold text-gold-bright ${className}`}>
      <span className="relative inline-flex h-[1.25em] min-w-[2ch] items-center justify-center overflow-hidden">
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span
            key={curStr}
            initial={{ y: "85%", opacity: 0 }}
            animate={{ y: "0%", opacity: 1 }}
            exit={{ y: "-85%", opacity: 0 }}
            transition={{ duration: 0.24, ease: [0.77, 0, 0.175, 1] }}
            className="inline-block"
          >
            {curStr}
          </motion.span>
        </AnimatePresence>
      </span>
      <span className="text-ink/35">/</span>
      <span className="text-ink/70">{totStr}</span>
    </span>
  );
}

/**
 * Dual-label vertical clip-path swap button (mud.co.jp + actuel-img.com inspired).
 * Slides the secondary label cleanly into view on fine-pointer hover without layout shift.
 */
export function SlotButton({
  label,
  hoverLabel,
  icon,
  onClick,
  active = false,
  disabled = false,
  ariaLabel,
  ariaPressed,
  className = "",
}: {
  label: string;
  hoverLabel?: string;
  icon?: ReactNode;
  onClick?: () => void;
  active?: boolean;
  disabled?: boolean;
  ariaLabel?: string;
  ariaPressed?: boolean;
  className?: string;
}) {
  return (
    <motion.button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel ?? label}
      aria-pressed={ariaPressed}
      whileTap={disabled ? undefined : { scale: 0.94 }}
      transition={SPRING_TAP}
      className={`slot-trigger pressable inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-full ${active ? "glass-pill-gold font-semibold" : "glass-pill text-ink"} ${className}`}
    >
      {icon}
      <span className="slot-swap">
        <span>{label}</span>
        <span aria-hidden="true">{hoverLabel ?? label}</span>
      </span>
    </motion.button>
  );
}

/**
 * Compact Film-Slate technical telemetry badge (actuel-img.com inspired).
 * Displays real resolution, codec, buffer ahead, or speed in Azeret Mono.
 */
export function FilmSlatePill({
  resolution,
  codec,
  bufferedSeconds,
  lowRes,
  className = "",
}: {
  resolution?: string | null;
  codec?: string | null;
  bufferedSeconds?: number;
  lowRes?: boolean;
  className?: string;
}) {
  const parts: string[] = [];
  if (lowRes) parts.push("480P");
  else if (resolution) parts.push(resolution);
  if (codec) parts.push(codec.toUpperCase());
  if (bufferedSeconds !== undefined && bufferedSeconds > 0.2) {
    parts.push(`BUF ${bufferedSeconds.toFixed(0)}S`);
  }
  if (!parts.length) return null;
  return (
    <motion.span
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={EASE_HUD}
      className={`film-slate glass-pill inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-medium text-ink/85 ${className}`}
    >
      <span className="live-dot size-1.5 shrink-0 rounded-full bg-ok shadow-[0_0_6px_rgba(48,209,88,0.85)]" aria-hidden="true" />
      <span>{parts.join(" · ")}</span>
    </motion.span>
  );
}

/**
 * Fluted optical glass privacy curtain (goonsdesign.com 12-slat refraction shield).
 * Sits smoothly above privacy-blurred covers and clears cleanly on hold-to-peek.
 */
export function FlutedPrivacyShield({ active }: { active: boolean }) {
  if (!active) return null;
  return (
    <span
      aria-hidden="true"
      className="fluted-shield pointer-events-none absolute inset-0 transition-opacity duration-300"
    />
  );
}
