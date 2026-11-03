import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FeedPreferencesButton } from "./FeedPreferences";

let root: Root, box: HTMLDivElement;
let writes: unknown[], saved: ReturnType<typeof vi.fn<() => void>>;
let fetchPreferences: () => Promise<Response>, savePreferences: () => Promise<Response>;
const empty = { preferred_tags: [], excluded_tags: [], mode: "mixed" };
const tags = Array.from({ length: 22 }, (_, i) => ({ id: i + 1, name: `标签${i + 1}`, count: 1 }));
const click = async (label: string) => act(async () => {
  const el = box.querySelector<HTMLElement>(`[aria-label="${label}"]`); expect(el, label).not.toBeNull(); el!.click();
});
const submit = async () => act(async () => box.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
const checkbox = (kind: string, id: number) => box.querySelector<HTMLInputElement>(`[aria-label="${kind} 标签${id}"]`)!;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  writes = []; saved = vi.fn(); fetchPreferences = async () => Response.json(empty); savePreferences = async () => Response.json(empty);
  vi.stubGlobal("fetch", async (path: string, init?: RequestInit) => {
    if (path === "/api/v1/tags") return Response.json({ items: tags });
    if (init?.method === "PUT") { writes.push(JSON.parse(String(init.body))); return savePreferences(); }
    return fetchPreferences();
  });
  box = document.createElement("div"); document.body.append(box); root = createRoot(box);
});
afterEach(async () => { await act(async () => root.unmount()); box.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const open = async () => { await act(async () => root.render(<FeedPreferencesButton onSaved={saved} />)); await click("刷流偏好"); };

it("keeps preferred and excluded tags disjoint and saves an explicit only mode", async () => {
  await open(); await click("仅偏好标签"); await submit();
  expect(writes).toEqual([]);
  await click("偏好 标签1"); expect(checkbox("排除", 1).disabled).toBe(true);
  await click("排除 标签2"); expect(checkbox("偏好", 2).disabled).toBe(true);
  await submit();
  expect(writes).toEqual([{ preferred_tags: [1], excluded_tags: [2], mode: "only" }]); expect(saved).toHaveBeenCalledTimes(1);
});
it("limits each tag set to twenty and preserves edits after a failed save", async () => {
  await open();
  for (let id = 1; id <= 20; id++) await click(`偏好 标签${id}`);
  expect(checkbox("偏好", 21).disabled).toBe(true);
  savePreferences = async () => new Response("failed", { status: 500 });
  await submit(); expect(box.querySelector('[role="alert"]')).not.toBeNull();
  expect(checkbox("偏好", 1).checked).toBe(true); expect(saved).not.toHaveBeenCalled();
  savePreferences = async () => Response.json(empty); await submit(); expect(saved).toHaveBeenCalledTimes(1);
});
it("discards late loads across close and reopen even when the open key repeats", async () => {
  let resolve!: (r: Response) => void; fetchPreferences = () => new Promise(r => { resolve = r; });
  await open(); await click("取消偏好设置");
  fetchPreferences = async () => Response.json({ preferred_tags: [2], excluded_tags: [], mode: "mixed" });
  await click("刷流偏好");
  await act(async () => resolve(Response.json({ preferred_tags: [1], excluded_tags: [], mode: "only" })));
  expect(checkbox("偏好", 2).checked).toBe(true); expect(checkbox("偏好", 1).checked).toBe(false);
});
it("keeps an in-flight save attached to the feed refresh and ignores completion after unmount", async () => {
  let resolve!: (r: Response) => void; savePreferences = () => new Promise(r => { resolve = r; });
  await open(); await submit(); await click("取消偏好设置");
  expect(box.querySelector<HTMLButtonElement>('[aria-label="取消偏好设置"]')!.disabled).toBe(true);
  await act(async () => resolve(Response.json(empty))); expect(saved).toHaveBeenCalledTimes(1);
  await click("刷流偏好"); await submit(); await act(async () => root.unmount());
  await act(async () => resolve(Response.json(empty))); expect(saved).toHaveBeenCalledTimes(1); root = createRoot(box);
});
it("offers an explicit retry for loading failures and removes deleted tag ids", async () => {
  fetchPreferences = async () => new Response("failed", { status: 500 }); await open();
  expect(box.querySelector('[role="alert"]')).not.toBeNull();
  fetchPreferences = async () => Response.json({ preferred_tags: [1, 999], excluded_tags: [2, 999], mode: "mixed" });
  await click("重试偏好设置"); await submit();
  expect(writes).toEqual([{ preferred_tags: [1], excluded_tags: [2], mode: "mixed" }]);
});
