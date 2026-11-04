import { Unauthorized, type Media, type Page, type Tag } from "./api";

export interface HistorySettings { enabled: boolean; epoch: number }
export interface HistoryItem extends Media { seen_at: number; position_seconds: number }
export interface HistoryRecord { media_id: string; position_seconds: number; epoch: number }
export interface ChannelFilters {
  include_tags: number[]; exclude_tags: number[]; match: "all" | "any";
  watched: "all" | "unwatched" | "watched"; min_seconds: number | null; max_seconds: number | null;
  category: "all" | "short" | "long"; premium_only: boolean; sort: "newest" | "longest" | "largest" | "random";
}
export interface Channel { id: string; name: string; filters: ChannelFilters; created_at: number; updated_at: number }
export interface CatalogTag extends Tag { aliases: string[]; parent_id: number | null }
export const defaultChannelFilters = (): ChannelFilters => ({ include_tags: [], exclude_tags: [], match: "all", watched: "all",
  min_seconds: null, max_seconds: null, category: "all", premium_only: false, sort: "newest" });

async function request<T>(path: string, method = "GET", body?: unknown, signal?: AbortSignal, keepalive = false): Promise<T> {
  const response = await fetch(path, { method, credentials: "same-origin", signal, keepalive,
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
  if (response.status === 401) throw new Unauthorized();
  if (!response.ok) throw new Error(`${response.status} ${await response.text().catch(() => "")}`.trim());
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}

let historySettings: HistorySettings | null = null;
const historyListeners = new Set<() => void>();
export const getHistorySettings = (): HistorySettings | null => historySettings;
export function subscribeHistorySettings(listener: () => void): () => void {
  historyListeners.add(listener); return () => { historyListeners.delete(listener); };
}
function rememberHistorySettings(value: HistorySettings): HistorySettings {
  // A settings read started before a clear must never restore its old recording epoch.
  if (!historySettings || value.epoch >= historySettings.epoch) {
    if (historySettings?.epoch !== value.epoch || historySettings.enabled !== value.enabled) {
      historySettings = value; historyListeners.forEach(listener => listener());
    }
  }
  return historySettings!;
}
export async function refreshHistorySettings(signal?: AbortSignal): Promise<HistorySettings> {
  return rememberHistorySettings(await request<HistorySettings>("/api/v1/history/settings", "GET", undefined, signal));
}
const historyMutation = async (path: string, method: string, body?: unknown, signal?: AbortSignal) =>
  rememberHistorySettings(await request<HistorySettings>(path, method, body, signal));

export const experienceApi = {
  historySettings: refreshHistorySettings,
  setHistoryEnabled: (enabled: boolean, signal?: AbortSignal) => historyMutation("/api/v1/history/settings", "PUT", { enabled }, signal),
  history: (offset = 0, limit = 30, signal?: AbortSignal) => request<{ items: HistoryItem[]; has_more: boolean }>(`/api/v1/history?offset=${offset}&limit=${limit}`, "GET", undefined, signal),
  recordHistory: (value: HistoryRecord, signal?: AbortSignal, keepalive = false) => request<{ recorded: boolean }>("/api/v1/history", "POST", value, signal, keepalive),
  clearHistory: (id?: string, signal?: AbortSignal) => historyMutation(`/api/v1/history${id ? `/${encodeURIComponent(id)}` : ""}`, "DELETE", undefined, signal),
  channels: (signal?: AbortSignal) => request<{ items: Channel[] }>("/api/v1/channels", "GET", undefined, signal),
  createChannel: (name: string, filters: ChannelFilters, signal?: AbortSignal) => request<Channel>("/api/v1/channels", "POST", { name, filters }, signal),
  updateChannel: (id: string, name: string, filters: ChannelFilters, signal?: AbortSignal) => request<Channel>(`/api/v1/channels/${encodeURIComponent(id)}`, "PATCH", { name, filters }, signal),
  deleteChannel: (id: string, signal?: AbortSignal) => request<{ deleted: boolean }>(`/api/v1/channels/${encodeURIComponent(id)}`, "DELETE", undefined, signal),
  channelItems: (id: string, offset = 0, limit = 20, signal?: AbortSignal) => request<Page>(`/api/v1/channels/${encodeURIComponent(id)}/items?offset=${offset}&limit=${limit}`, "GET", undefined, signal),
  queryChannel: (filters: ChannelFilters, offset = 0, limit = 20, signal?: AbortSignal) => request<Page>("/api/v1/channels/query", "POST", { filters, offset, limit }, signal),
  tagCatalog: (signal?: AbortSignal) => request<{ items: CatalogTag[] }>("/api/v1/tag-catalog", "GET", undefined, signal),
  updateTag: (id: number, value: { name?: string; aliases?: string[]; parent_id?: number | null }, signal?: AbortSignal) => request<CatalogTag>(`/api/v1/tag-catalog/${id}`, "PATCH", value, signal),
  deleteTag: (id: number, signal?: AbortSignal) => request<{ deleted: boolean }>(`/api/v1/tags/${id}`, "DELETE", undefined, signal),
  mergeTags: (source_ids: number[], target_id: number, signal?: AbortSignal) => request<{ items: CatalogTag[] }>("/api/v1/tag-catalog/merge", "POST", { source_ids, target_id }, signal),
};
