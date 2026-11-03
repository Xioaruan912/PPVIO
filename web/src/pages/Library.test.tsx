import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Library } from "./Library";

let root: Root, container: HTMLDivElement, urls: URL[], atEnd: () => void;
const select = async (label: string, value: string) => act(async () => {
  const el = container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
  expect(el).not.toBeNull(); el.value = value; el.dispatchEvent(new Event("change", { bubbles: true }));
});
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); urls = [];
  vi.stubGlobal("IntersectionObserver", class {
    constructor(cb: IntersectionObserverCallback) { atEnd = () => cb([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver); }
    observe() {} disconnect() {}
  });
  vi.stubGlobal("fetch", async (input: string) => {
    const url = new URL(input, "https://player.test");
    if (url.pathname === "/api/v1/tags") return Response.json({ items: [] });
    urls.push(url);
    const offset = Number(url.searchParams.get("offset"));
    return Response.json({ items: Array.from({ length: 20 }, (_, index) => ({ id: `${offset + index}`, stream_url: "/stream", cover_url: null,
      duration_seconds: 30, width: 360, height: 640, variants: [], favorite: false, deletable: false, category: "short" })), has_more: true });
  });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

describe("library filters", () => {
  it("accepts the route's folder snapshot and delegates folder back navigation", async () => {
    const folder = { id: "folder", label: "测试文件夹", date: null, video_count: 20 };
    const change = vi.fn();
    await act(async () => root.render(<Library onOpen={() => {}} selectedFolder={folder} onFolderChange={change} />));
    expect(container.querySelector("h1")?.textContent).toBe("测试文件夹");
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="返回文件夹"]')!.click());
    expect(change).toHaveBeenCalledWith(null);
    await act(async () => root.render(<Library onOpen={() => {}} selectedFolder={null} onFolderChange={change} />));
    expect(container.querySelector("h1")?.textContent).toBe("片库");
  });
  it("sends mobile duration and unwatched controls and resets pagination", async () => {
    await act(async () => root.render(<Library onOpen={() => {}} />));
    await act(async () => atEnd());
    expect(urls.at(-1)!.searchParams.get("offset")).toBe("20");
    await select("排序", "longest");
    expect(urls.at(-1)!.searchParams.get("sort")).toBe("longest");
    expect(urls.at(-1)!.searchParams.get("offset")).toBe("0");
    await select("时长范围", "short");
    expect(urls.at(-1)!.searchParams.get("max_seconds")).toBe("60");
    expect(urls.at(-1)!.searchParams.has("min_seconds")).toBe(false);
    await select("时长范围", "medium");
    expect(urls.at(-1)!.searchParams.get("min_seconds")).toBe("60");
    expect(urls.at(-1)!.searchParams.get("max_seconds")).toBe("300");
    await select("时长范围", "long");
    expect(urls.at(-1)!.searchParams.get("min_seconds")).toBe("300");
    expect(urls.at(-1)!.searchParams.has("max_seconds")).toBe(false);
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="只看未看"]')!.click());
    expect(urls.at(-1)!.searchParams.get("unwatched")).toBe("true");
    expect(container.querySelector('[aria-label="只看未看"]')!.getAttribute("aria-pressed")).toBe("true");
  });

  it("keeps random ordering seeded across pages and removes the seed for other sorts", async () => {
    await act(async () => root.render(<Library onOpen={() => {}} />));
    await select("排序", "random");
    const seed = urls.at(-1)!.searchParams.get("seed");
    expect(seed).toMatch(/^\d+$/);
    await act(async () => atEnd());
    expect(urls.at(-1)!.searchParams.get("offset")).toBe("20");
    expect(urls.at(-1)!.searchParams.get("seed")).toBe(seed);
    await select("排序", "largest");
    expect(urls.at(-1)!.searchParams.get("sort")).toBe("largest");
    expect(urls.at(-1)!.searchParams.has("seed")).toBe(false);
  });
});
