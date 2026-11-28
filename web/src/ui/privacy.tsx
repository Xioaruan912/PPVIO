import { useEffect, useState, useSyncExternalStore } from "react";
import { setPref, usePrefs } from "../prefs";
import { haptic } from "./haptics";

export const IDLE_LOCK_MS = 60_000;

const NEUTRAL_ICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%2325272e'/%3E%3Cpath d='M9 11h14M9 16h10M9 21h12' stroke='%23d8dae2' stroke-width='2.2' stroke-linecap='round'/%3E%3C/svg%3E";

// One flag the whole app reads: covered or not. Playing media pauses while covered.
let locked = false;
let longPlayback = false;
const listeners = new Set<() => void>();
const set = (value: boolean) => { if (locked !== value) { locked = value; listeners.forEach(l => l()); } };

export function useLocked(): boolean {
  return useSyncExternalStore(l => { listeners.add(l); return () => listeners.delete(l); }, () => locked);
}

/** Instant Panic / Boss mode: pause, mute, and cover with a harmless decoy screen. */
export function triggerPanic(): void {
  haptic(12);
  setPref("muted", true);
  if (typeof document !== "undefined") {
    document.querySelectorAll("video").forEach(v => { try { v.pause(); v.muted = true; } catch { /* ignore */ } });
  }
  set(true);
}

/** A long video on screen: watching a film without touching it is not idling. */
export function setLongPlayback(on: boolean): void { longPlayback = on; }

export function PrivacyGuard() {
  const prefs = usePrefs();
  const isLocked = useLocked();

  // Browser tab title, favicon stealth disguise, and lock-screen MediaSession shield.
  useEffect(() => {
    const label = prefs.stealthTitle.trim();
    document.title = label || "PPVIO";
    const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (icon) {
      if (!icon.dataset.origHref) icon.dataset.origHref = icon.href;
      icon.href = label ? NEUTRAL_ICON : icon.dataset.origHref;
    }
    try {
      if ("mediaSession" in navigator && typeof MediaMetadata !== "undefined") {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: label || "媒体",
          artist: "",
          album: "",
          artwork: [],
        });
      }
    } catch { /* MediaSession not supported in all environments. */ }
  }, [prefs.stealthTitle, isLocked]);

  // Global panic shortcuts: Shift+H, double-Escape, and 2-finger tap on mobile.
  useEffect(() => {
    let lastEsc = 0;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.isContentEditable || target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
      if (event.shiftKey && event.key.toLowerCase() === "h") {
        event.preventDefault();
        if (locked) set(false); else triggerPanic();
      } else if (event.key === "Escape") {
        const now = performance.now();
        if (now - lastEsc < 400) { triggerPanic(); lastEsc = 0; }
        else lastEsc = now;
      }
    };
    const onTouch = (event: TouchEvent) => {
      if (event.touches.length === 2 && !locked) triggerPanic();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("touchstart", onTouch, { passive: true });
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("touchstart", onTouch);
    };
  }, []);

  useEffect(() => {
    if (!prefs.privacyLock) { set(false); return; }
    let last = Date.now();
    const touch = () => { last = Date.now(); };
    const hide = () => { if (document.visibilityState === "hidden") set(true); };
    const timer = setInterval(() => { if (!longPlayback && Date.now() - last > IDLE_LOCK_MS) set(true); }, 2000);
    const events = ["pointerdown", "keydown", "wheel", "touchstart"] as const;
    events.forEach(e => window.addEventListener(e, touch, { passive: true }));
    document.addEventListener("visibilitychange", hide);
    return () => {
      clearInterval(timer);
      events.forEach(e => window.removeEventListener(e, touch));
      document.removeEventListener("visibilitychange", hide);
    };
  }, [prefs.privacyLock]);

  if (!isLocked) return null;
  return prefs.panicDecoy === "clock" ? <ClockDecoy onUnlock={() => set(false)} /> : <NotesDecoy onUnlock={() => set(false)} />;
}

function ClockDecoy({ onUnlock }: { onUnlock: () => void }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(t); }, []);
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const dateStr = now.toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "long" });
  return (
    <button type="button" onClick={onUnlock} aria-label="继续"
      className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-bg text-ink select-none">
      <span className="text-[72px] font-light leading-none tracking-[-0.04em] tabular-nums text-ink">{hh}:{mm}</span>
      <span className="mt-3 text-[15px] text-muted">{dateStr}</span>
    </button>
  );
}

function NotesDecoy({ onUnlock }: { onUnlock: () => void }) {
  return (
    <button type="button" onClick={onUnlock} aria-label="继续"
      className="fixed inset-0 z-50 flex flex-col bg-bg px-5 pb-12 pt-[max(2.5rem,env(safe-area-inset-top))] text-left text-ink select-none">
      <div className="mx-auto w-full max-w-lg">
        <div className="mb-6 flex items-baseline justify-between border-b border-line pb-3">
          <span className="text-[24px] font-semibold tracking-tight text-ink">备忘录</span>
          <span className="text-[12px] text-faint">已同步</span>
        </div>
        <div className="space-y-3">
          <div className="ios-card rounded-[16px] p-4">
            <span className="block text-[15px] font-medium text-ink">本周待办清单</span>
            <span className="mt-1 block text-[13px] text-muted">1. 整理周报与项目进度 · 2. 预约体检 · 3. 采购日用品</span>
          </div>
          <div className="ios-card rounded-[16px] p-4">
            <span className="block text-[15px] font-medium text-ink">阅读摘录</span>
            <span className="mt-1 block text-[13px] text-muted">保持专注与克制，减少不必要的上下文切换。</span>
          </div>
          <div className="ios-card rounded-[16px] p-4">
            <span className="block text-[15px] font-medium text-ink">差旅清单</span>
            <span className="mt-1 block text-[13px] text-muted">充电器、降噪耳机、身份证、移动电源</span>
          </div>
        </div>
      </div>
    </button>
  );
}
