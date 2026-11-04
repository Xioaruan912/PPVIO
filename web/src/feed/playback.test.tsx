import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, type Media } from "../api";
import { PrivacyGuard } from "../ui/privacy";
import { ClipList } from "./Feed";
import { FeedItem } from "./FeedItem";
import { curationApi } from "../curationApi";

const items = Array.from({ length: 6 }, (_, i): Media => ({
  id: `clip-${i}`, stream_url: `/clip-${i}.mp4`, width: 360, height: 640,
  size_bytes: 6 * 1024 ** 2, duration_seconds: 60, variants: [],
  cover_url: null, favorite: false, deletable: false, category: "short",
}));
let root: Root, container: HTMLDivElement;
let intersect: IntersectionObserverCallback;
const videos = () => [...container.querySelectorAll("video")];
const videoAt = (index: number) => container.querySelector<HTMLVideoElement>(`[data-index="${index}"] video`)!;
const fire = (video: HTMLVideoElement, name: string) => act(() => { video.dispatchEvent(new Event(name)); });
function buffer(video: HTMLVideoElement, end: number, currentTime = 0) {
  Object.defineProperties(video, {
    currentSrc: { configurable: true, value: video.src },
    readyState: { configurable: true, value: 4 },
    duration: { configurable: true, value: 60 },
    currentTime: { configurable: true, value: currentTime, writable: true },
    buffered: { configurable: true, value: { length: 1, start: () => 0, end: () => end } },
  });
  fire(video, "progress");
}
async function renderFeed() {
  await act(async () => { root.render(<ClipList items={items} setItems={() => {}} />); });
}
async function enter(index: number) {
  await act(async () => {
    intersect([{ isIntersecting: true, target: container.querySelector(`[data-index="${index}"]`)! } as IntersectionObserverEntry], {} as IntersectionObserver);
  });
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal("IntersectionObserver", class {
    constructor(cb: IntersectionObserverCallback) { intersect = cb; }
    observe() {} disconnect() {}
  });
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (this: HTMLMediaElement) {
    Object.defineProperty(this, "paused", { configurable: true, value: false });
    return Promise.resolve();
  });
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (this: HTMLMediaElement) {
    Object.defineProperty(this, "paused", { configurable: true, value: true });
  });
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("feed playback priority", () => {
  it("does not skip a new active video when an earlier organize save finishes", async () => {
    vi.spyOn(api, "tags").mockResolvedValue({ items: [{ id: 1, name: "A", count: 0 }] });
    vi.spyOn(api, "mediaTags").mockResolvedValue({ ids: [] });
    const tagWrite = vi.spyOn(api, "setMediaTag");
    let resolve!: (result: { changed: number }) => void;
    vi.spyOn(curationApi, "batch").mockImplementation(() => new Promise(r => { resolve = r; }));
    await act(async () => root.render(<ClipList items={items} setItems={() => {}} organize />));
    const scroller = container.firstElementChild as HTMLDivElement;
    scroller.scrollBy = vi.fn();
    await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent?.includes("完成下一条"))!.click());
    const tag = container.querySelector<HTMLInputElement>('[aria-label="标签 A"]')!;
    expect(tag.disabled).toBe(true);
    await act(async () => tag.click()); expect(tagWrite).not.toHaveBeenCalled();
    await enter(1);
    await act(async () => resolve({ changed: 1 }));
    expect(scroller.scrollBy).not.toHaveBeenCalled();
  });

  it("waits for the pending tag save before completing organization", async () => {
    vi.spyOn(api, "tags").mockResolvedValue({ items: [{ id: 1, name: "A", count: 0 }] });
    vi.spyOn(api, "mediaTags").mockResolvedValue({ ids: [] });
    let resolve!: (value: { ids: number[] }) => void;
    vi.spyOn(api, "setMediaTag").mockImplementation(() => new Promise(r => { resolve = r; }));
    const complete = vi.spyOn(curationApi, "batch").mockResolvedValue({ changed: 1 });
    await act(async () => root.render(<ClipList items={items} setItems={() => {}} organize />));
    await act(async () => container.querySelector<HTMLInputElement>('[aria-label="标签 A"]')!.click());
    const done = [...container.querySelectorAll("button")].find(button => button.textContent === "完成下一条")!;
    expect(done.disabled).toBe(true);
    await act(async () => done.click()); expect(complete).not.toHaveBeenCalled();
    await act(async () => resolve({ ids: [1] })); expect(done.disabled).toBe(false);
  });

  it("waits for preload permission before seeking a neighbor and seeks again after its reload", async () => {
    const clips = [{ ...items[0], clip: { key: "one", start: 10, end: 12 } },
      { ...items[0], clip: { key: "two", start: 30, end: 33 } }];
    await act(async () => root.render(<ClipList items={clips} setItems={() => {}} />));
    const second = videoAt(1);
    buffer(second, 0, 0); fire(second, "loadedmetadata"); expect(second.currentTime).toBe(0);
    buffer(videoAt(0), 12, 10); fire(videoAt(0), "loadedmetadata");
    expect(second.currentTime).toBe(30);
    second.currentTime = 0; fire(second, "loadedmetadata"); expect(second.currentTime).toBe(30);
  });
  it("keeps two ranges of the same video separate, loops within bounds and pauses without restarting", async () => {
    const clips = [{ ...items[0], clip: { key: "one", start: 10, end: 12 } },
      { ...items[0], clip: { key: "two", start: 30, end: 33 } }];
    await act(async () => root.render(<ClipList items={clips} setItems={() => {}} />));
    const first = videoAt(0), second = videoAt(1);
    expect(first).not.toBe(second); expect(first.loop).toBe(false);
    buffer(first, 12, 10); fire(first, "loadedmetadata");
    expect(first.currentTime).toBe(10); expect(second.preload).toBe("auto");
    first.currentTime = 12.1; fire(first, "timeupdate"); expect(first.currentTime).toBe(10);
    const slider = container.querySelector<HTMLInputElement>('[data-index="0"] input[type="range"]')!;
    expect(slider.min).toBe("10"); expect(slider.max).toBe("12");
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: " " })));
    first.currentTime = 12.1; fire(first, "ended"); expect(first.paused).toBe(true); expect(first.currentTime).toBe(12.1);
    await enter(1); buffer(second, 33, 0); fire(second, "loadedmetadata"); expect(second.currentTime).toBe(30);
    expect(second.paused).toBe(false); expect(first.paused).toBe(true);
  });
  it("restarts a suspended metadata load once when the next clip is promoted", async () => {
    await renderFeed();
    const next = videoAt(1);
    const load = vi.mocked(HTMLMediaElement.prototype.load);
    const callsForNext = () => load.mock.contexts.filter(el => el === next).length;
    const before = callsForNext();
    buffer(videoAt(0), 15);
    expect(callsForNext()).toBe(before + 1);
    buffer(videoAt(0), 16);
    fire(videoAt(0), "waiting");
    buffer(videoAt(0), 20);
    expect(callsForNext()).toBe(before + 1);
  });

  it("keeps an already useful next buffer instead of restarting it", async () => {
    await renderFeed();
    const next = videoAt(1);
    buffer(next, 5);
    const load = vi.mocked(HTMLMediaElement.prototype.load);
    const before = load.mock.contexts.filter(el => el === next).length;
    buffer(videoAt(0), 15);
    expect(next.preload).toBe("auto");
    expect(load.mock.contexts.filter(el => el === next)).toHaveLength(before);
  });

  it("keeps the privacy lock in control when the page becomes visible again", async () => {
    await act(async () => { root.render(<><PrivacyGuard /><ClipList items={items} setItems={() => {}} /></>); });
    buffer(videoAt(0), 15);
    expect(videoAt(1).preload).toBe("auto");
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(videoAt(0).paused).toBe(true);
    expect(videoAt(1).preload).toBe("metadata");
    await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="继续"]')!.click(); });
    buffer(videoAt(0), 15);
    expect(videoAt(1).preload).toBe("auto");
  });

  it("keeps sources attached when StrictMode replays mount cleanup", async () => {
    await act(async () => { root.render(<StrictMode><ClipList items={items} setItems={() => {}} /></StrictMode>); });
    expect(videoAt(0).getAttribute("src")).toBe(items[0].stream_url);
    expect(videoAt(1).getAttribute("src")).toBe(items[1].stream_url);
    buffer(videoAt(0), 15);
    expect(videoAt(1).preload).toBe("auto");
  });

  it("eagerly preloads only the next clip after the current buffer is healthy", async () => {
    await renderFeed();
    expect(videoAt(1).preload).toBe("metadata");
    buffer(videoAt(0), 15);
    expect(videoAt(1).preload).toBe("auto");
    fire(videoAt(0), "waiting");
    expect(videoAt(1).preload).toBe("metadata");
    buffer(videoAt(0), 20);
    expect(videoAt(1).preload).toBe("auto");
    await enter(1);
    expect(videoAt(0).preload).toBe("metadata");
    expect(videoAt(2).preload).toBe("metadata");
    buffer(videoAt(1), 15);
    expect(videoAt(2).preload).toBe("auto");
    expect(videos()).toHaveLength(3);
  });

  it("revokes eager preloading when paused or hidden, and releases videos outside the window", async () => {
    await renderFeed();
    const first = videoAt(0);
    buffer(first, 15);
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: " " })); });
    expect(videoAt(1).preload).toBe("metadata");
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: " " })); });
    buffer(first, 15);
    expect(videoAt(1).preload).toBe("auto");
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(videoAt(1).preload).toBe("metadata");
    expect(first.paused).toBe(true);
    await enter(3);
    expect(first.getAttribute("src")).toBeNull();
    expect(videos()).toHaveLength(3);
    await enter(0);
    expect(videoAt(0).getAttribute("src")).toBe(items[0].stream_url);
  });

  it("does not reuse readiness from a different quality source", async () => {
    await renderFeed();
    buffer(videoAt(0), 15);
    expect(videoAt(1).preload).toBe("auto");
    const changed = [{ ...items[0], stream_url: "/new-quality.mp4" }, ...items.slice(1)];
    await act(async () => { root.render(<ClipList items={changed} setItems={() => {}} />); });
    expect(videoAt(1).preload).toBe("metadata");
  });

  it("autoplays when returning to a paused clip that was unmounted by a distant jump", async () => {
    await renderFeed();
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: " " })); });
    expect(videoAt(0).paused).toBe(true);
    await enter(3);
    await enter(0);
    expect(videoAt(0).paused).toBe(false);
  });

  it("ignores rejection of an obsolete play request after a rapid swipe", async () => {
    let rejectOld!: (reason: Error) => void;
    vi.mocked(HTMLMediaElement.prototype.play).mockImplementationOnce(() => new Promise((_, reject) => { rejectOld = reject; }));
    const renderItem = (active: boolean) => act(async () => { root.render(
      <FeedItem media={items[0]} mounted active={active} onFavorite={() => {}} />,
    ); });
    await renderItem(true);
    await renderItem(false);
    await renderItem(true);
    await act(async () => { rejectOld(new DOMException("obsolete request", "NotAllowedError")); });
    expect(container.querySelector("video")!.paused).toBe(false);
  });
});
