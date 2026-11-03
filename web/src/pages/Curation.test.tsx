import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Media } from "../api";
import { Curation, readRecentTagGroups, rememberTagGroup } from "./Curation";

let root: Root, box: HTMLDivElement, requests: URL[], writes: Record<string, unknown>[];
let page: (organized: boolean, offset: number) => Promise<Response>, mutate: () => Promise<Response>;
const KEY = "ppvio-web:curation-tag-groups";
const tags = [{ id: 1, name: "标签一", count: 1 }, { id: 2, name: "标签二", count: 0 }];
const media = (id: string): Media => ({ id, width: 360, height: 640, duration_seconds: 30, stream_url: "/stream", cover_url: "/cover",
  variants: [], favorite: false, deletable: false, category: "short" });
const respond = (start: number, count = 20, more = true) => Response.json({ items: Array.from({ length: count }, (_, i) => media(`${start + i}`)), has_more: more });
const click = async (label: string) => act(async () => {
  const el = box.querySelector<HTMLElement>(`[aria-label="${label}"]`); expect(el, label).not.toBeNull(); el!.click();
});
const selected = () => [...box.querySelectorAll<HTMLInputElement>('input[aria-label^="选择第"]')].filter(input => input.checked);
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); localStorage.removeItem(KEY); requests = []; writes = [];
  page = async (_organized, offset) => respond(offset); mutate = async () => Response.json({ changed: 1 });
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    if (input === "/api/v1/tags") return Response.json({ items: tags });
    if (init?.method === "POST") { writes.push(JSON.parse(String(init.body))); return mutate(); }
    const url = new URL(input, "https://player.test"); requests.push(url);
    return page(url.searchParams.get("organized") === "true", Number(url.searchParams.get("offset")));
  });
  box = document.createElement("div"); document.body.append(box); root = createRoot(box);
});
afterEach(async () => { await act(async () => root.unmount()); box.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const render = async (onOpen = vi.fn()) => { await act(async () => root.render(<Curation onBack={() => {}} onOpen={onOpen} />)); return onOpen; };

it("opens original media, honors cover blur, and resets selection and pagination on query changes", async () => {
  const onOpen = await render(); expect(box.querySelector("img")?.className).toContain("blur-xl");
  await click("播放第 1 个视频"); expect(onOpen.mock.calls[0][0][0].id).toBe("0");
  await click("选择第 1 个视频"); await click("加载更多整理视频");
  expect(requests.at(-1)!.searchParams.get("offset")).toBe("20");
  await click("已整理");
  expect(selected()).toHaveLength(0); expect(requests.at(-1)!.searchParams.get("offset")).toBe("0");
  expect(requests.at(-1)!.searchParams.get("organized")).toBe("true");
});
it("caps multi-selection at 100 across pages and sends one batch", async () => {
  await render(); for (let i = 0; i < 5; i++) await click("加载更多整理视频");
  await click("选择当前已加载"); expect(selected()).toHaveLength(100);
  expect(box.querySelector<HTMLInputElement>('[aria-label="选择第 101 个视频"]')!.disabled).toBe(true);
  await click("标记完成"); expect(writes).toHaveLength(1);
  expect(writes[0].media_ids).toHaveLength(100); expect(writes[0].organized).toBe(true);
  expect(requests.at(-1)!.searchParams.get("offset")).toBe("0"); expect(selected()).toHaveLength(0);
});
it("keeps append and remove separate, preserves failed selections and reuses recent groups", async () => {
  await render(); await click("选择第 1 个视频"); await click("追加标签"); await click("批量标签 标签一");
  mutate = async () => new Response("fail", { status: 500 }); await click("确认追加标签");
  expect(selected()).toHaveLength(1); expect(box.querySelector<HTMLInputElement>('[aria-label="批量标签 标签一"]')!.checked).toBe(true);
  expect(localStorage.getItem(KEY)).toBeNull();
  mutate = async () => Response.json({ changed: 1 }); await click("确认追加标签");
  expect(writes[1]).toEqual({ media_ids: ["0"], add_tags: [1] });
  expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual([[1]]);
  await click("选择第 1 个视频"); await click("移除标签"); await click("使用标签组 标签一"); await click("确认移除标签");
  expect(writes[2]).toEqual({ media_ids: ["0"], remove_tags: [1] });
});
it("reloads from offset zero after organization and discards an in-flight appended page", async () => {
  let resolve!: (response: Response) => void;
  await render(); await click("选择第 1 个视频");
  page = async (_organized, offset) => offset === 20 ? new Promise(r => { resolve = r; }) : respond(100, 20, false);
  await click("加载更多整理视频"); await click("标记完成");
  expect(requests.at(-1)!.searchParams.get("offset")).toBe("0");
  await act(async () => resolve(respond(20)));
  const onOpen = await render(); await click("播放第 1 个视频");
  expect(onOpen.mock.calls[0][0].map((item: Media) => item.id)).toEqual(Array.from({ length: 20 }, (_, i) => `${100 + i}`));
});
it("rejects an ABA stale query response and requires an explicit retry after failure", async () => {
  let resolve!: (response: Response) => void; let count = 0;
  page = async () => ++count === 1 ? new Promise(r => { resolve = r; }) : new Response("fail", { status: 500 });
  await render(); await click("已整理"); await click("待整理");
  expect(requests).toHaveLength(3);
  await act(async () => resolve(respond(999))); expect(box.querySelector("img")).toBeNull();
  expect(box.querySelector('[role="alert"]')).not.toBeNull(); expect(requests).toHaveLength(3);
  page = async () => respond(5, 1, false); await click("重试整理列表");
  expect(box.querySelectorAll('input[aria-label^="选择第"]')).toHaveLength(1);
  expect(requests.at(-1)!.searchParams.get("offset")).toBe("0");
});
it("waits for an in-flight batch before closing its sheet and ignores completion after unmount", async () => {
  let resolve!: (response: Response) => void; mutate = () => new Promise(r => { resolve = r; });
  await render(); await click("选择第 1 个视频"); await click("追加标签"); await click("批量标签 标签一"); await click("确认追加标签");
  await click("取消批量标签"); expect(box.querySelector<HTMLButtonElement>('[aria-label="取消批量标签"]')!.disabled).toBe(true);
  await act(async () => resolve(Response.json({ changed: 1 })));
  expect(localStorage.getItem(KEY)).toBe("[[1]]"); expect(selected()).toHaveLength(0); expect(requests).toHaveLength(2);
  await click("选择第 1 个视频"); await click("标记完成"); await act(async () => root.unmount());
  await act(async () => resolve(Response.json({ changed: 1 }))); expect(requests).toHaveLength(2); root = createRoot(box);
});
it("bounds recent groups, filters deleted tags, and tolerates corrupt or blocked browser storage", () => {
  const valid = Array.from({ length: 30 }, (_, i) => i + 1);
  for (let i = 1; i <= 8; i++) rememberTagGroup([i], valid);
  expect(readRecentTagGroups(valid)).toEqual([[8], [7], [6], [5], [4], [3]]);
  rememberTagGroup([7], valid); expect(readRecentTagGroups(valid)[0]).toEqual([7]);
  rememberTagGroup(valid, valid); expect(readRecentTagGroups(valid)[0]).toHaveLength(20);
  localStorage.setItem(KEY, JSON.stringify([[1, 2, 999], [2, 2], ["1"], null]));
  expect(readRecentTagGroups([1, 2])).toEqual([[1, 2], [2]]);
  localStorage.setItem(KEY, "{"); expect(readRecentTagGroups(valid)).toEqual([]);
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
  expect(readRecentTagGroups(valid)).toEqual([]); expect(() => rememberTagGroup([1], valid)).not.toThrow();
});
