import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "../api";
import * as privacy from "./privacy";
import { BookmarkTagFilter } from "./BookmarkTagFilter";

const tags = [{ id: 1, name: "风景", count: 8 }, { id: 2, name: "旅行", count: 4 }];
let root: ReturnType<typeof createRoot>, box: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  vi.spyOn(privacy, "useLocked").mockReturnValue(false);
  vi.spyOn(api, "tags").mockResolvedValue({ items: tags });
  box = document.createElement("div"); document.body.append(box); root = createRoot(box);
});
afterEach(async () => { await act(async () => root.unmount()); box.remove(); vi.restoreAllMocks(); });

it("selects an existing label or all clips through the controlled filter", async () => {
  const change = vi.fn();
  await act(async () => root.render(<BookmarkTagFilter value={1} onChange={change} />));
  const select = box.querySelector<HTMLSelectElement>('[aria-label="片段标签"]')!;
  expect(select.value).toBe("1"); expect(select.options[0].textContent).toBe("全部标签");
  await act(async () => { select.value = "2"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(change).toHaveBeenLastCalledWith(2);
  await act(async () => { select.value = ""; select.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(change).toHaveBeenLastCalledWith(undefined);
});

it("prunes a deleted tag only after the catalog loads successfully and supports retry", async () => {
  const change = vi.fn(); vi.mocked(api.tags).mockRejectedValueOnce(new Error("offline"));
  await act(async () => root.render(<BookmarkTagFilter value={999} onChange={change} />));
  expect(change).not.toHaveBeenCalled(); expect(box.querySelector('[role="alert"]')).not.toBeNull();
  await act(async () => box.querySelector<HTMLButtonElement>('[aria-label="重试片段标签"]')!.click());
  expect(change).toHaveBeenCalledWith(undefined);
});

it("ignores an obsolete catalog read after privacy locking and prunes a later changed value", async () => {
  let resolve!: (value: { items: typeof tags }) => void;
  vi.mocked(api.tags).mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  const change = vi.fn();
  await act(async () => root.render(<BookmarkTagFilter value={1} onChange={change} />));
  const signal = vi.mocked(api.tags).mock.calls[0][0];
  vi.mocked(privacy.useLocked).mockReturnValue(true);
  await act(async () => root.render(<BookmarkTagFilter value={1} onChange={change} />));
  expect(signal?.aborted).toBe(true); expect(box.textContent).toBe("");
  await act(async () => resolve({ items: [] })); expect(change).not.toHaveBeenCalled();
  vi.mocked(privacy.useLocked).mockReturnValue(false);
  await act(async () => root.render(<BookmarkTagFilter value={1} onChange={change} />));
  await act(async () => root.render(<BookmarkTagFilter value={999} onChange={change} />));
  expect(change).toHaveBeenCalledWith(undefined);
});

it("waits for the refreshed catalog before pruning a value selected while hidden", async () => {
  const change = vi.fn();
  await act(async () => root.render(<BookmarkTagFilter value={1} onChange={change} />));
  vi.mocked(privacy.useLocked).mockReturnValue(true);
  await act(async () => root.render(<BookmarkTagFilter value={3} onChange={change} />));
  let resolve!: (value: { items: typeof tags }) => void;
  vi.mocked(api.tags).mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  vi.mocked(privacy.useLocked).mockReturnValue(false);
  await act(async () => root.render(<BookmarkTagFilter value={3} onChange={change} />));
  expect(change).not.toHaveBeenCalled();
  await act(async () => resolve({ items: [...tags, { id: 3, name: "新增", count: 1 }] }));
  expect(change).not.toHaveBeenCalled();
});
