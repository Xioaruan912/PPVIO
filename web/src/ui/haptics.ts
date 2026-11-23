/** Subtle tactile haptic pulse on mobile browsers that support the Vibration API. */
export function haptic(ms = 10): void {
  try {
    if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
      navigator.vibrate(ms);
    }
  } catch { /* Ignore browsers that block vibration without prior gesture. */ }
}
