import { Unauthorized, type Media } from "./api";

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(path, { credentials: "same-origin", ...init,
    headers: { ...(init.body ? { "Content-Type": "application/json" } : {}), ...init.headers } });
  if (r.status === 401) throw new Unauthorized();
  if (!r.ok) throw new Error(`请求失败（${r.status}）`);
  return r.json() as Promise<T>;
}
export interface Bookmark { id: string; media_id: string; position_seconds: number; name: string; created_at: number }
export interface PreviewFrame { index: number; at: number; url: string }
export interface Preview { state: "pending" | "ready" | "unavailable"; version?: string; frames: PreviewFrame[] }
export const mediaTools = {
  bookmarks: (id: string, signal?: AbortSignal) => call<{ items: Bookmark[] }>(`/api/v1/media/${id}/bookmarks`, { signal }),
  allBookmarks: (offset = 0, signal?: AbortSignal) => call<{ items: (Bookmark & { media: Media })[]; has_more: boolean }>(`/api/v1/bookmarks?offset=${offset}&limit=20`, { signal }),
  addBookmark: (id: string, position_seconds: number, name = "") => call<Bookmark>(`/api/v1/media/${id}/bookmarks`, { method: "POST", body: JSON.stringify({ position_seconds, name }) }),
  deleteBookmark: (media: string, id: string) => call<unknown>(`/api/v1/media/${media}/bookmarks/${id}`, { method: "DELETE" }),
  preparePreview: (id: string, signal?: AbortSignal) => call<Preview>(`/api/v1/media/${id}/preview`, { method: "POST", signal }),
  preview: (id: string, signal?: AbortSignal) => call<Preview>(`/api/v1/media/${id}/preview`, { signal }),
};
