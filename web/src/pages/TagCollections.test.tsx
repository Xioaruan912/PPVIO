import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api, type Media } from "../api";
import * as privacy from "../ui/privacy";
import { TagCollections } from "./TagCollections";

const media = (id: string): Media => ({ id, stream_url: `/${id}`, cover_url: `/${id}.jpg`, width: 360, height: 640, duration_seconds: 30, variants: [], favorite: false, deletable: false, category: "short" });
const tags = [{ id: 1, name: "风景", count: 8 }, { id: 2, name: "旅行", count: 4 }];
let root: ReturnType<typeof createRoot>, box: HTMLDivElement;
let serve: (url: URL, init?: RequestInit) => Response | Promise<Response>;
const requests: { url: URL; signal?: AbortSignal | null }[] = [];
async function click(name: string) {
  const target = box.querySelector<HTMLElement>(`[aria-label="${name}"]`);
  expect(target, name).not.toBeNull(); await act(async () => target!.click());
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  requests.length = 0;
  vi.spyOn(privacy, "useLocked").mockReturnValue(false);
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  vi.spyOn(api, "tags").mockResolvedValue({ items: tags });
  vi.stubGlobal("IntersectionObserver", class { observe() {} disconnect() {} });
  serve = () => Response.json({ items: [media("all")], has_more: false });
  vi.stubGlobal("fetch", (input: string, init?: RequestInit) => {
    const url = new URL(input, "http://localhost"); requests.push({ url, signal: init?.signal }); return serve(url, init);
  });
  box = document.createElement("div"); document.body.append(box); root = createRoot(box);
});
afterEach(async () => { await act(async () => root.unmount()); box.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("browses all tagged originals, displays live label counts, and opens the loaded wall", async () => {
  const open = vi.fn(), manage = vi.fn();
  serve = () => Response.json({ items: [media("a"), media("b")], has_more: false });
  await act(async () => root.render(<TagCollections onOpen={open} onManage={manage} />));
  expect(box.querySelector("h1")?.textContent).toBe("标签收藏");
  expect(box.querySelector('[aria-label="打开标签 风景"]')?.textContent).toContain("8");
  expect(requests[0].url.pathname).toBe("/api/v1/tag-collections");
  expect(requests[0].url.searchParams.get("tag_id")).toBeNull();
  expect(requests[0].url.searchParams.get("limit")).toBe("20");
  expect(box.querySelector("img")?.className).toContain("blur-xl");
  await click("播放第 2 个视频");
  expect(open.mock.calls[0][0].map((item: Media) => item.id)).toEqual(["a", "b"]);
  expect(open.mock.calls[0][1]).toBe(1);
  await click("管理标签"); expect(manage).toHaveBeenCalledTimes(1);
});

it("aborts an old label query and ignores its late response after selecting another label", async () => {
  let resolve!: (value: Response) => void;
  serve = url => url.searchParams.get("tag_id") === "1" ? new Promise(r => { resolve = r; })
    : Response.json({ items: [media(url.searchParams.get("tag_id") === "2" ? "fresh" : "all")], has_more: false });
  await act(async () => root.render(<TagCollections onOpen={() => {}} onManage={() => {}} />));
  await click("打开标签 风景"); const obsolete = requests.at(-1)!;
  await click("打开标签 旅行"); expect(obsolete.signal?.aborted).toBe(true);
  await act(async () => resolve(Response.json({ items: [media("stale")], has_more: false })));
  expect(box.querySelector("img")?.getAttribute("src")).toBe("/fresh.jpg");
  expect(box.querySelectorAll("img")).toHaveLength(1);
});

it("keeps the failed offset for an explicit retry", async () => {
  let fail = true;
  serve = url => url.searchParams.get("offset") === "0" ? Response.json({ items: [media("first")], has_more: true })
    : fail ? new Response("offline", { status: 500 }) : Response.json({ items: [media("next")], has_more: false });
  await act(async () => root.render(<TagCollections onOpen={() => {}} onManage={() => {}} />));
  await click("加载更多标签收藏");
  expect(box.querySelector('[role="alert"]')).not.toBeNull();
  expect(requests.at(-1)?.url.searchParams.get("offset")).toBe("1");
  fail = false; await click("重试加载");
  expect(requests.at(-1)?.url.searchParams.get("offset")).toBe("1");
  expect(box.querySelectorAll("img")).toHaveLength(2);
});

it("refreshes counts and the selected wall after returning from the player", async () => {
  await act(async () => root.render(<TagCollections refresh={0} onOpen={() => {}} onManage={() => {}} />));
  await click("打开标签 风景");
  vi.mocked(api.tags).mockResolvedValue({ items: [{ ...tags[0], count: 9 }, tags[1]] });
  serve = () => Response.json({ items: [media("updated")], has_more: false });
  await act(async () => root.render(<TagCollections refresh={1} onOpen={() => {}} onManage={() => {}} />));
  expect(box.querySelector('[aria-label="打开标签 风景"]')?.textContent).toContain("9");
  expect(requests.at(-1)?.url.searchParams.get("tag_id")).toBe("1");
  expect(requests.at(-1)?.url.searchParams.get("offset")).toBe("0");
  expect(box.querySelector("img")?.getAttribute("src")).toBe("/updated.jpg");
});

it("retries label list failures and removes label names while locked", async () => {
  vi.mocked(api.tags).mockRejectedValueOnce(new Error("offline"));
  await act(async () => root.render(<TagCollections onOpen={() => {}} onManage={() => {}} />));
  await click("重试标签列表"); expect(box.querySelector('[aria-label="打开标签 风景"]')).not.toBeNull();
  vi.mocked(privacy.useLocked).mockReturnValue(true);
  await act(async () => root.render(<TagCollections onOpen={() => {}} onManage={() => {}} />));
  expect(box.textContent).toBe("");
});
