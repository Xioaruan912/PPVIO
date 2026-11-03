import { Unauthorized, type Page } from "./api";

export interface FeedPreferences { preferred_tags: number[]; excluded_tags: number[]; mode: "mixed" | "only" }
export interface CurationChange { add_tags?: number[]; remove_tags?: number[]; organized?: boolean }

async function request<T>(path: string, signal?: AbortSignal, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(path, { credentials: "same-origin", signal, method,
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
  if (response.status === 401) throw new Unauthorized();
  if (!response.ok) throw new Error(`${response.status} ${await response.text().catch(() => "")}`.trim());
  return response.json() as Promise<T>;
}

export const curationApi = {
  preferences: (signal?: AbortSignal) => request<FeedPreferences>("/api/v1/feed/preferences", signal),
  savePreferences: (value: FeedPreferences, signal?: AbortSignal) => request<FeedPreferences>("/api/v1/feed/preferences", signal, "PUT", value),
  list: (organized: boolean, offset: number, signal?: AbortSignal) =>
    request<Page>(`/api/v1/curation?organized=${organized}&offset=${offset}&limit=20`, signal),
  batch: (ids: string[], change: CurationChange, signal?: AbortSignal) =>
    request<{ changed: number }>("/api/v1/curation/batch", signal, "POST", { media_ids: ids, ...change }),
};
