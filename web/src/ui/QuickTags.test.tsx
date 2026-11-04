import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api, type Media } from "../api";
import { QuickTagButton, QuickTagPanel } from "./QuickTags";
import * as privacy from "./privacy";

const media = (id: string) => ({ id, variants: [] }) as unknown as Media;
const tags = [{ id: 1, name: "风景", count: 8 }, { id: 2, name: "旅行", count: 4 }];
const recentKey = "ppvio:quick-tags:v1";
let root: ReturnType<typeof createRoot>, box: HTMLDivElement;
let hidden = false;
const input = (name: string) => box.querySelector<HTMLInputElement>(`[aria-label="标签 ${name}"]`)!;
async function click(name: string) {
  const target = box.querySelector<HTMLElement>(`[aria-label="${name}"]`);
  expect(target, name).not.toBeNull(); await act(async () => target!.click());
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  hidden = false; vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
  vi.spyOn(privacy, "useLocked").mockReturnValue(false);
  localStorage.clear();
  vi.spyOn(api, "tags").mockResolvedValue({ items: tags });
  vi.spyOn(api, "mediaTags").mockResolvedValue({ ids: [1] });
  vi.spyOn(api, "setMediaTag").mockResolvedValue({ ids: [1, 2] });
  box = document.createElement("div"); document.body.append(box); root = createRoot(box);
});
afterEach(async () => { await act(async () => root.unmount()); box.remove(); vi.restoreAllMocks(); });

it("shows applied tags checked, guards rapid duplicate writes and waits before completing", async () => {
  let resolve!: (value: { ids: number[] }) => void;
  vi.mocked(api.setMediaTag).mockImplementation(() => new Promise(r => { resolve = r; }));
  const done = vi.fn();
  await act(async () => root.render(<QuickTagPanel media={media("one")} compact onDone={done} />));
  expect(input("风景").checked).toBe(true); expect(input("旅行").checked).toBe(false);
  await act(async () => { input("旅行").click(); input("旅行").click(); });
  expect(api.setMediaTag).toHaveBeenCalledTimes(1);
  expect(vi.mocked(api.setMediaTag).mock.calls[0].slice(0, 3)).toEqual(["one", 2, true]);
  await click("完成选择"); expect(done).not.toHaveBeenCalled();
  await act(async () => resolve({ ids: [1, 2] }));
  expect(input("旅行").checked).toBe(true);
  await click("完成选择"); expect(done).toHaveBeenCalledTimes(1);
});

it("merges concurrent tag acknowledgments without restoring a removed tag", async () => {
  const resolve = new Map<number, (value: { ids: number[] }) => void>();
  vi.mocked(api.setMediaTag).mockImplementation((_, tag) => new Promise(r => resolve.set(tag, r)));
  await act(async () => root.render(<QuickTagPanel media={media("one")} />));
  await click("标签 旅行"); await click("标签 风景");
  await act(async () => resolve.get(1)!({ ids: [2] }));
  await act(async () => resolve.get(2)!({ ids: [1, 2] }));
  expect(input("风景").checked).toBe(false); expect(input("旅行").checked).toBe(true);
});

it("retains failed selections and supports retrying the same explicit change", async () => {
  vi.mocked(api.setMediaTag).mockRejectedValueOnce(new Error("offline"));
  await act(async () => root.render(<QuickTagPanel media={media("one")} />));
  await click("标签 旅行");
  expect(input("旅行").checked).toBe(false); expect(box.querySelector('[role="alert"]')).not.toBeNull();
  await click("标签 旅行");
  expect(input("旅行").checked).toBe(true); expect(box.querySelector('[role="alert"]')).toBeNull();
});

it("retains an unsaved label error across another label save and blocks completion until retry", async () => {
  vi.mocked(api.setMediaTag).mockRejectedValueOnce(new Error("offline"));
  const done = vi.fn();
  await act(async () => root.render(<QuickTagPanel media={media("one")} onDone={done} />));
  await click("标签 旅行"); await click("标签 风景");
  expect(box.querySelector('[role="alert"]')?.textContent).toContain("旅行");
  await click("完成选择"); expect(done).not.toHaveBeenCalled();
  await click("标签 旅行"); await click("完成选择"); expect(done).toHaveBeenCalledTimes(1);
});

it("keeps only ten distinct existing positive IDs in recent labels and searches all tags", async () => {
  const many = Array.from({ length: 12 }, (_, index) => ({ id: index + 1, name: `标签${index + 1}`, count: 20 - index }));
  vi.mocked(api.tags).mockResolvedValue({ items: many });
  localStorage.setItem(recentKey, JSON.stringify([999, "2", -1, 0, 1.5, 12, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]));
  await act(async () => root.render(<QuickTagPanel media={media("one")} />));
  expect(JSON.parse(localStorage.getItem(recentKey)!)).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3]);
  expect([...box.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')][0].getAttribute("aria-label")).toBe("标签 标签12");
  const search = box.querySelector<HTMLInputElement>('[aria-label="搜索标签"]')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "标签2"); search.dispatchEvent(new Event("input", { bubbles: true })); });
  expect(box.querySelectorAll('input[type="checkbox"]')).toHaveLength(1);
  await click("标签 标签2");
  expect(JSON.parse(localStorage.getItem(recentKey)!)).toEqual([2, 12, 11, 10, 9, 8, 7, 6, 5, 4]);
});

it("rejects old reads and writes when the media changes", async () => {
  let resolve!: (value: { ids: number[] }) => void;
  vi.mocked(api.setMediaTag).mockImplementation(() => new Promise(r => { resolve = r; }));
  const saved = vi.fn();
  await act(async () => root.render(<QuickTagButton media={media("one")} onSaved={saved} />));
  await click("标签收藏"); await click("标签 旅行");
  await act(async () => root.render(<QuickTagButton media={media("two")} onSaved={saved} />));
  await act(async () => resolve({ ids: [1, 2] }));
  expect(saved).not.toHaveBeenCalled();
  expect(box.querySelector('[role="dialog"]')).toBeNull();
  let finish!: (value: { ids: number[] }) => void;
  vi.mocked(api.mediaTags).mockImplementationOnce(() => new Promise(r => { finish = r; }));
  await click("标签收藏");
  await act(async () => root.render(<QuickTagButton media={media("three")} onSaved={saved} />));
  await act(async () => finish({ ids: [2] }));
  await click("标签收藏"); expect(input("旅行").checked).toBe(false);
});

it("aborts reads and hides tag names on background or privacy lock", async () => {
  let resolve!: (value: { ids: number[] }) => void;
  vi.mocked(api.mediaTags).mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  await act(async () => root.render(<QuickTagPanel media={media("one")} />));
  const signal = vi.mocked(api.mediaTags).mock.calls[0][1];
  await act(async () => { hidden = true; document.dispatchEvent(new Event("visibilitychange")); });
  expect(signal?.aborted).toBe(true); expect(box.textContent).toBe("");
  await act(async () => resolve({ ids: [2] }));
  await act(async () => { hidden = false; document.dispatchEvent(new Event("visibilitychange")); });
  expect(input("风景").checked).toBe(true); expect(input("旅行").checked).toBe(false);
  vi.mocked(privacy.useLocked).mockReturnValue(true);
  await act(async () => root.render(<QuickTagPanel media={media("one")} />));
  expect(box.textContent).toBe("");
});

it("disables an inactive quick-tag button and closes its open sheet", async () => {
  await act(async () => root.render(<QuickTagButton media={media("one")} />));
  await click("标签收藏"); expect(box.querySelector('[role="dialog"]')).not.toBeNull();
  await act(async () => root.render(<QuickTagButton media={media("one")} enabled={false} />));
  expect(box.querySelector('[role="dialog"]')).toBeNull();
  expect(box.querySelector<HTMLButtonElement>('[aria-label="标签收藏"]')?.disabled).toBe(true);
});
