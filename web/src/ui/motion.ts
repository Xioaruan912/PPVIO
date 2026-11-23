import type { Transition } from "motion/react";

/** Expressive Apple VisionOS UI spring: silky settle with refined physicality. */
export const SPRING_UI: Transition = {
  type: "spring",
  visualDuration: 0.38,
  bounce: 0.12,
};

/** Full-stage page & overlay transition spring. */
export const SPRING_STAGE: Transition = {
  type: "spring",
  visualDuration: 0.42,
  bounce: 0.08,
};

/** Sheet & modal spring: tactile iOS drawer momentum settle. */
export const SPRING_SHEET: Transition = {
  type: "spring",
  visualDuration: 0.4,
  bounce: 0.16,
};

/** Shared-element luminous pill spring for dock & segmented controls. */
export const SPRING_PILL: Transition = {
  type: "spring",
  visualDuration: 0.36,
  bounce: 0.22,
};

/** Elastic tactile tap spring for buttons and floating rail controls. */
export const SPRING_TAP: Transition = {
  type: "spring",
  stiffness: 500,
  damping: 24,
};

/** Quick silky ease-out for HUD overlays. */
export const EASE_HUD: Transition = {
  duration: 0.24,
  ease: [0.22, 1, 0.36, 1],
};

/** Organic non-uniform delay for grid & rail wave entrances (capped under 240ms total). */
export function waveDelay(index: number, cap = 9): number {
  const n = Math.min(index, cap);
  return 0.025 * n - 0.0012 * n * n;
}
