import { StarIcon } from "@phosphor-icons/react";
import { useSyncExternalStore } from "react";
import { haptic } from "./ui/haptics";

const KEY = "ppvio:ratings:v1";
const listeners = new Set<() => void>();

function read(): Record<string, number> {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return raw && typeof raw === "object" ? raw as Record<string, number> : {};
  } catch { return {}; }
}

let ratings: Record<string, number> = read();

export function setRating(mediaId: string, stars: number): void {
  const clamped = Math.max(0, Math.min(5, Math.round(stars)));
  const next = { ...ratings };
  if (clamped === 0) delete next[mediaId];
  else next[mediaId] = clamped;
  ratings = next;
  try { localStorage.setItem(KEY, JSON.stringify(ratings)); } catch { /* ignore */ }
  listeners.forEach(l => l());
}

export function getRating(mediaId: string): number {
  return ratings[mediaId] ?? 0;
}

export function useRatings(): Record<string, number> {
  return useSyncExternalStore(l => { listeners.add(l); return () => listeners.delete(l); }, () => ratings);
}

export function StarRating({ mediaId, compact = false }: { mediaId: string; compact?: boolean }) {
  const map = useRatings();
  const value = map[mediaId] ?? 0;
  return (
    <div className={`flex items-center ${compact ? "gap-1" : "gap-1.5"}`} role="group" aria-label="星级评分">
      {[1, 2, 3, 4, 5].map(n => {
        const filled = n <= value;
        return (
          <button key={n} type="button" aria-label={`评分 ${n} 星`} aria-pressed={filled}
            onClick={() => { haptic(8); setRating(mediaId, value === n ? 0 : n); }}
            className={`pressable grid place-items-center rounded-full transition-colors ${compact ? "size-8" : "size-10"} ${filled ? "text-gold-bright" : "text-white/28 hover:text-gold/70"}`}>
            <StarIcon size={compact ? 18 : 22} weight={filled ? "fill" : "regular"} />
          </button>
        );
      })}
    </div>
  );
}
