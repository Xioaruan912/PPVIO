import { StarIcon } from "@phosphor-icons/react";
import { motion } from "motion/react";
import { useSyncExternalStore } from "react";
import { api, type Media, type TasteProfile } from "./api";
import { haptic } from "./ui/haptics";
import { SPRING_TAP } from "./ui/motion";
import { toast } from "./ui/toast";

const KEY = "ppvio:ratings:v1";
const listeners = new Set<() => void>();

function read(): Record<string, number> {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return raw && typeof raw === "object" ? (raw as Record<string, number>) : {};
  } catch {
    return {};
  }
}

let ratings: Record<string, number> = read();
let profile: TasteProfile = { active: false, rated_count: 0, five_star_count: 0, top_tags: [] };
let hydrated = false;

function notify() {
  listeners.forEach(listener => listener());
}

function persistLocal() {
  try {
    localStorage.setItem(KEY, JSON.stringify(ratings));
  } catch {
    /* ignore storage quota */
  }
}

/** Merge any server-provided rating fields from loaded Media DTOs. */
export function hydrateMediaRatings(items: Media[]): void {
  let changed = false;
  let next: Record<string, number> | null = null;
  for (const item of items) {
    if (typeof item.rating === "number" && item.rating >= 1 && item.rating <= 5) {
      if (ratings[item.id] !== item.rating) {
        next ??= { ...ratings };
        next[item.id] = item.rating;
        changed = true;
      }
    }
  }
  if (changed && next) {
    ratings = next;
    persistLocal();
    notify();
  }
}

/** Sync local ratings up once and fetch authoritative SQLite ratings + taste profile. */
export async function bootstrapRatings(): Promise<void> {
  if (hydrated) return;
  hydrated = true;
  try {
    const localEntries = Object.entries(ratings).filter(
      ([id, v]) => /^[0-9a-f]{64}$/.test(id) && Number.isInteger(v) && v >= 1 && v <= 5,
    );
    if (localEntries.length > 0) {
      await api.syncRatings(Object.fromEntries(localEntries)).catch(() => undefined);
    }
    const remote = await api.ratings();
    ratings = { ...ratings, ...remote.ratings };
    profile = remote.profile;
    persistLocal();
    notify();
  } catch {
    hydrated = false;
  }
}

export function setRating(mediaId: string, stars: number, { announceToast = false }: { announceToast?: boolean } = {}): void {
  const clamped = Math.max(0, Math.min(5, Math.round(stars)));
  const prev = ratings[mediaId] ?? 0;
  const next = { ...ratings };
  if (clamped === 0) delete next[mediaId];
  else next[mediaId] = clamped;
  ratings = next;
  persistLocal();
  notify();

  if (announceToast) {
    if (clamped >= 4) toast(`已评 ${clamped}★ · 将优先推荐同类影片`);
    else if (clamped >= 1 && clamped <= 2) toast(`已评 ${clamped}★ · 将减少同类推荐`);
    else if (clamped === 3) toast("已评 3★");
    else toast("已取消评分");
  }

  void api.setRating(mediaId, clamped).then(() => {
    void api.ratings().then(remote => {
      profile = remote.profile;
      notify();
    }).catch(() => undefined);
  }).catch(() => {
    // Revert only if still matching optimistic state and remote explicitly failed
    if ((ratings[mediaId] ?? 0) === clamped && /^[0-9a-f]{64}$/.test(mediaId)) {
      const rollback = { ...ratings };
      if (prev === 0) delete rollback[mediaId];
      else rollback[mediaId] = prev;
      ratings = rollback;
      persistLocal();
      notify();
      toast("评分未保存到服务器，请重试");
    }
  });
}

export function getRating(mediaId: string): number {
  return ratings[mediaId] ?? 0;
}

export function useRatings(): Record<string, number> {
  return useSyncExternalStore(
    listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => ratings,
  );
}

export function useTasteProfile(): TasteProfile {
  return useSyncExternalStore(
    listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => profile,
  );
}

export function StarRating({
  mediaId,
  compact = false,
  announce = true,
}: {
  mediaId: string;
  compact?: boolean;
  announce?: boolean;
}) {
  const map = useRatings();
  const value = map[mediaId] ?? 0;
  return (
    <div className={`inline-flex items-center ${compact ? "gap-0.5" : "gap-1"}`} role="group" aria-label="星级评分">
      {[1, 2, 3, 4, 5].map(n => {
        const filled = n <= value;
        return (
          <motion.button
            key={n}
            type="button"
            aria-label={`评分 ${n} 星`}
            aria-pressed={filled}
            whileTap={{ scale: 0.82 }}
            transition={SPRING_TAP}
            onClick={() => {
              haptic(n >= 4 ? 12 : 6);
              setRating(mediaId, value === n ? 0 : n, { announceToast: announce });
            }}
            className={`grid place-items-center rounded-full transition-colors ${compact ? "size-8" : "size-9 sm:size-10"} ${
              filled
                ? "text-gold-bright drop-shadow-[0_0_10px_rgba(229,196,132,0.4)]"
                : "text-ink/25 hover:text-gold/75"
            }`}
          >
            <StarIcon size={compact ? 17 : 20} weight={filled ? "fill" : "regular"} />
          </motion.button>
        );
      })}
    </div>
  );
}
