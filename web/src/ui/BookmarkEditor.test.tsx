import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "../api";
import { mediaTools, type Bookmark } from "../mediaTools";
import * as privacy from "./privacy";
import { BookmarkEditor } from "./BookmarkEditor";

const bookmark: Bookmark = { id: "mark", media_id: "one", position_seconds: 20, end_seconds: 40, name: "原备注", created_at: 1, tag_ids: [1] };
const tags = [{ id: 1, name: "风景", count: 8 }, { id: 2, name: "旅行", count: 4 }];
let root: ReturnType<typeof createRoot>, box: HTMLDivElement;
let hidden = false;
async function click(name: string) {
  const target = box.querySelector<HTMLElement>(`[aria-label="${name}"]`);
  expect(target, name).not.toBeNull(); await act(async () => target!.click());
}
async function change(name: string, value: string) {
  const target = box.querySelector<HTMLInputElement>(`[aria-label="${name}"]`)!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(target, value); target.dispatchEvent(new Event("input", { bubbles: true })); });
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  hidden = false; vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
  vi.spyOn(privacy, "useLocked").mockReturnValue(false);
  vi.spyOn(api, "tags").mockResolvedValue({ items: tags });
  vi.spyOn(mediaTools, "updateBookmark").mockResolvedValue({ ...bookmark, name: "山野", tag_ids: [1, 2] });
  box = document.createElement("div"); document.body.append(box); root = createRoot(box);
});
afterEach(async () => { await act(async () => root.unmount()); box.remove(); vi.restoreAllMocks(); });

it("atomically saves the remark and selected existing tags without changing the clip range", async () => {
  const saved = vi.fn(), close = vi.fn();
  await act(async () => root.render(<BookmarkEditor bookmark={bookmark} onSaved={saved} onClose={close} />));
  expect(box.querySelector('[role="dialog"]')).toBeNull();
  expect(box.querySelector<HTMLInputElement>('[aria-label="片段标签 风景"]')?.checked).toBe(true);
  await change("片段备注", " 山野 "); await click("片段标签 旅行"); await click("保存片段");
  expect(mediaTools.updateBookmark).toHaveBeenCalledWith("one", "mark", { name: "山野", tag_ids: [1, 2] });
  expect(saved).toHaveBeenCalledWith({ ...bookmark, name: "山野", tag_ids: [1, 2] }); expect(close).toHaveBeenCalledTimes(1);
});

it("retains failed edits and selections for a retry", async () => {
  vi.mocked(mediaTools.updateBookmark).mockRejectedValueOnce(new Error("offline"));
  await act(async () => root.render(<BookmarkEditor bookmark={bookmark} onSaved={() => {}} onClose={() => {}} />));
  await change("片段备注", "山野"); await click("片段标签 旅行"); await click("保存片段");
  expect(box.querySelector('[role="alert"]')).not.toBeNull();
  expect(box.querySelector<HTMLInputElement>('[aria-label="片段备注"]')?.value).toBe("山野");
  expect(box.querySelector<HTMLInputElement>('[aria-label="片段标签 旅行"]')?.checked).toBe(true);
  await click("保存片段"); expect(mediaTools.updateBookmark).toHaveBeenCalledTimes(2);
});

it("guards duplicate saves and closing while a save is in flight", async () => {
  let resolve!: (value: Bookmark) => void;
  vi.mocked(mediaTools.updateBookmark).mockImplementation(() => new Promise(r => { resolve = r; }));
  const close = vi.fn();
  await act(async () => root.render(<BookmarkEditor bookmark={bookmark} onSaved={() => {}} onClose={close} />));
  await act(async () => { box.querySelector<HTMLButtonElement>('[aria-label="保存片段"]')!.click(); box.querySelector<HTMLButtonElement>('[aria-label="保存片段"]')!.click(); });
  expect(mediaTools.updateBookmark).toHaveBeenCalledTimes(1);
  await click("取消编辑片段"); expect(close).not.toHaveBeenCalled();
  await act(async () => resolve(bookmark)); expect(close).toHaveBeenCalledTimes(1);
});

it("caps selections at twenty, prunes deleted IDs, and rejects an overlong remark", async () => {
  vi.mocked(api.tags).mockResolvedValue({ items: Array.from({ length: 21 }, (_, index) => ({ id: index + 1, name: `标签${index + 1}`, count: 1 })) });
  const selected = Array.from({ length: 20 }, (_, index) => index + 1);
  await act(async () => root.render(<BookmarkEditor bookmark={{ ...bookmark, tag_ids: [...selected, 999] }} onSaved={() => {}} onClose={() => {}} />));
  expect(box.querySelector<HTMLInputElement>('[aria-label="片段标签 标签21"]')?.disabled).toBe(true);
  await click("片段标签 标签1"); expect(box.querySelector<HTMLInputElement>('[aria-label="片段标签 标签21"]')?.disabled).toBe(false);
  await click("片段标签 标签21");
  await change("片段备注", "长".repeat(41)); await click("保存片段");
  expect(mediaTools.updateBookmark).not.toHaveBeenCalled();
  await change("片段备注", "有效"); await click("保存片段");
  expect(vi.mocked(mediaTools.updateBookmark).mock.calls[0][2].tag_ids).toEqual([...selected.slice(1), 21]);
});

it("rejects an old save after switching bookmarks and hides the form when locked", async () => {
  let resolve!: (value: Bookmark) => void;
  vi.mocked(mediaTools.updateBookmark).mockImplementation(() => new Promise(r => { resolve = r; }));
  const saved = vi.fn(), close = vi.fn();
  await act(async () => root.render(<BookmarkEditor bookmark={bookmark} onSaved={saved} onClose={close} />));
  await click("保存片段");
  await act(async () => root.render(<BookmarkEditor bookmark={{ ...bookmark, id: "new", name: "新片段" }} onSaved={saved} onClose={close} />));
  await act(async () => resolve(bookmark)); expect(saved).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled();
  expect(box.querySelector<HTMLInputElement>('[aria-label="片段备注"]')?.value).toBe("新片段");
  vi.mocked(privacy.useLocked).mockReturnValue(true);
  await act(async () => root.render(<BookmarkEditor bookmark={bookmark} onSaved={saved} onClose={close} />));
  expect(box.textContent).toBe("");
});

it("retries tag reads without discarding the typed remark, and aborts when hidden", async () => {
  vi.mocked(api.tags).mockRejectedValueOnce(new Error("offline"));
  const close = vi.fn();
  await act(async () => root.render(<BookmarkEditor bookmark={bookmark} onSaved={() => {}} onClose={close} />));
  await change("片段备注", "保留备注"); await click("重试片段编辑标签");
  expect(box.querySelector<HTMLInputElement>('[aria-label="片段备注"]')?.value).toBe("保留备注");
  const signal = vi.mocked(api.tags).mock.calls.at(-1)?.[0];
  await act(async () => { hidden = true; document.dispatchEvent(new Event("visibilitychange")); });
  expect(signal?.aborted).toBe(true); expect(box.textContent).toBe(""); expect(close).toHaveBeenCalledTimes(1);
});
