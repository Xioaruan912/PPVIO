import { useSyncExternalStore } from "react";

export type PanicDecoy = "notes" | "clock";

export interface Prefs {
  lowRes: boolean;
  muted: boolean;
  /** Covers on walls stay blurred until revealed. */
  coverBlur: boolean;
  /** Cover the screen after a minute without a touch, and whenever the app goes to the background. */
  privacyLock: boolean;
  /** Disguise the browser tab title & icon with a neutral label. */
  stealthTitle: string;
  /** Harmless decoy screen shown when locked or panic-triggered. */
  panicDecoy: PanicDecoy;
  /** Hold or hover a single blurred cover to temporarily reveal it. */
  peekOnHold: boolean;
  /** Hands-free auto-advance interval in seconds for short feed (0 = off). */
  autoSwapSeconds: number;
}

// Kept from the TGVIO days so phones keep their playback preferences.
const KEY = "tgvio-web:prefs";
// Low-res first by default: it caches and starts faster, which is how the owner watches.
const DEFAULTS: Prefs = {
  lowRes: true,
  muted: true,
  coverBlur: true,
  privacyLock: true,
  stealthTitle: "",
  panicDecoy: "notes",
  peekOnHold: true,
  autoSwapSeconds: 0,
};
// Sound is opt-in for each page visit; other playback preferences remain durable.
let current: Prefs = { ...DEFAULTS, ...safeParse(localStorage.getItem(KEY)), muted: true };
const listeners = new Set<() => void>();

function safeParse(text: string | null): Partial<Prefs> {
  try { return text ? JSON.parse(text) as Partial<Prefs> : {}; } catch { return {}; }
}

export function setPref<K extends keyof Prefs>(key: K, value: Prefs[K]): void {
  current = { ...current, [key]: value };
  localStorage.setItem(KEY, JSON.stringify(current));
  listeners.forEach(listener => listener());
}

export function usePrefs(): Prefs {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => listeners.delete(listener); }, () => current);
}
