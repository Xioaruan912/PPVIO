import { useSyncExternalStore } from "react";
import type { Media } from "./api";

export interface QueueEntry { id: string; cover_url: string | null; duration_seconds: number | null; category: "short" | "long" }
const KEY = "ppvio-web:play-queue", ID = /^[0-9a-f]{64}$/;
const listeners = new Set<() => void>();
export function readQueue(raw: string | null): QueueEntry[] {
  try {
    const values: unknown = JSON.parse(raw ?? "[]"); if (!Array.isArray(values)) return [];
    const seen = new Set<string>(), result: QueueEntry[] = [];
    for (const value of values.slice(0, 1000)) {
      if (!value || typeof value !== "object" || !ID.test(value.id) || seen.has(value.id)) continue;
      seen.add(value.id);
      result.push({ id: value.id, cover_url: typeof value.cover_url === "string" && value.cover_url.startsWith(`/api/v1/media/${value.id}/`) ? value.cover_url : null,
        duration_seconds: typeof value.duration_seconds === "number" && Number.isFinite(value.duration_seconds) && value.duration_seconds >= 0 ? value.duration_seconds : null,
        category: value.category === "long" ? "long" : "short" });
      if (result.length === 100) break;
    }
    return result;
  } catch { return []; }
}
function stored() { try { return readQueue(localStorage.getItem(KEY)); } catch { return []; } }
let entries = stored();
function publish(next: QueueEntry[]) {
  entries = next;
  try { localStorage.setItem(KEY, JSON.stringify(entries)); } catch { /* The current session still works without browser storage. */ }
  listeners.forEach(listener => listener());
}
window.addEventListener("storage", event => { if (event.key === KEY || event.key === null) { entries = stored(); listeners.forEach(listener => listener()); } });
export const getQueue = () => entries;
export const useQueue = () => useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, getQueue);
export function addToQueue(media: Media): boolean {
  if (!ID.test(media.id) || entries.length >= 100 || entries.some(item => item.id === media.id)) return false;
  publish([...entries, ...readQueue(JSON.stringify([media]))]); return true;
}
export const clearQueue = () => publish([]);
export const removeFromQueue = (id: string) => publish(entries.filter(item => item.id !== id));
export function moveQueue(id: string, delta: number) {
  const from = entries.findIndex(item => item.id === id), to = from + delta;
  if (from < 0 || to < 0 || to >= entries.length) return;
  const next = [...entries]; [next[from], next[to]] = [next[to], next[from]]; publish(next);
}
