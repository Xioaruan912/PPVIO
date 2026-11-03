import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, type Media } from "../api";
import { FeedItem } from "../feed/FeedItem";
import { LongPlayer } from "../player/LongPlayer";
import { LoadingFeedback } from "./LoadingFeedback";

const media: Media = { id: "clip", stream_url: "/clip.mp4", cover_url: null, width: 360, height: 640,
  duration_seconds: 60, size_bytes: 1024 ** 2, variants: [], favorite: false, deletable: false, category: "short" };
let container: HTMLDivElement, root: Root;
const tick = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });
const status = () => container.querySelector('[role="status"]');
const fire = (video: HTMLVideoElement, event: string) => act(() => {
  if (["play", "playing", "pause"].includes(event)) {
    Object.defineProperty(video, "paused", { configurable: true, value: event === "pause" });
  }
  video.dispatchEvent(new Event(event));
});
function setBuffer(video: HTMLVideoElement, time: number, ranges: [number, number][]) {
  Object.defineProperties(video, {
    currentSrc: { configurable: true, value: video.src },
    currentTime: { configurable: true, value: time, writable: true },
    buffered: { configurable: true, value: {
      length: ranges.length, start: (i: number) => ranges[i][0], end: (i: number) => ranges[i][1],
    } },
  });
  fire(video, "progress");
}

beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (this: HTMLMediaElement) {
    Object.defineProperty(this, "paused", { configurable: true, value: false });
    return Promise.resolve();
  });
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (this: HTMLMediaElement) {
    Object.defineProperty(this, "paused", { configurable: true, value: true });
  });
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  vi.spyOn(api, "longProgress").mockResolvedValue({ items: [], recent_items: [] });
  vi.spyOn(api, "saveProgress").mockResolvedValue(undefined);
  vi.spyOn(api, "clearProgress").mockResolvedValue(undefined);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove(); vi.restoreAllMocks(); vi.useRealTimers();
});

describe("loading feedback", () => {
  it("waits200ms and shows only real contiguous buffer ahead of the playhead", async () => {
    const video = document.createElement("video");
    video.src = "a";
    const ref = { current: video };
    await act(async () => { root.render(<LoadingFeedback video={ref} source="a" waiting enabled />); });
    setBuffer(video, 10, [[0, 5], [20, 30]]);
    tick(199); expect(status()).toBeNull();
    tick(1); expect(status()?.textContent).toContain("正在加载");
    expect(status()?.textContent).not.toContain("已缓冲");
    setBuffer(video, 10, [[0, 12.49]]);
    expect(status()?.textContent).toContain("已缓冲 2.4 秒");
    tick(1000); expect(status()?.textContent).toContain("已缓冲 2.4 秒");
    setBuffer(video, 11, [[0, 12.49]]);
    expect(status()?.textContent).toContain("已缓冲 1.4 秒");
  });

  it("does not flash on quick recovery or retain another source's pending timer", async () => {
    const ref = { current: document.createElement("video") };
    const render = (source: string, waiting: boolean) => act(async () => {
      root.render(<StrictMode><LoadingFeedback video={ref} source={source} waiting={waiting} enabled /></StrictMode>);
    });
    await render("a", true); tick(100);
    await render("a", false); tick(300); expect(status()).toBeNull();
    await render("a", true); tick(150);
    await render("b", true); tick(100); expect(status()).toBeNull();
    tick(100); expect(status()).not.toBeNull();
    await render("b", false); expect(status()).toBeNull();
  });

  it("hides immediately in the background and starts a fresh delay on return", async () => {
    const ref = { current: document.createElement("video") };
    await act(async () => { root.render(<LoadingFeedback video={ref} source="a" waiting enabled />); });
    tick(200); expect(status()).not.toBeNull();
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(status()).toBeNull();
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    tick(199); expect(status()).toBeNull();
    tick(1); expect(status()).not.toBeNull();
  });

  it("cancels a pending hint when disabled or unmounted", async () => {
    const ref = { current: document.createElement("video") };
    await act(async () => { root.render(<LoadingFeedback video={ref} source="a" waiting enabled />); });
    tick(100);
    await act(async () => { root.render(<LoadingFeedback video={ref} source="a" waiting enabled={false} />); });
    tick(300); expect(status()).toBeNull();
    await act(async () => { root.render(<LoadingFeedback video={ref} source="a" waiting enabled />); });
    tick(100);
    await act(async () => { root.render(null); });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe.each(["short", "long"] as const)("%s player feedback", kind => {
  const renderPlayer = () => act(async () => {
    root.render(kind === "short" ? <FeedItem media={media} active mounted onFavorite={() => {}} />
      : <LongPlayer media={{ ...media, category: "long" }} onClose={() => {}} />);
  });
  it("reports loading, hides on recovery, and never labels a pause or failure as loading", async () => {
    await renderPlayer();
    const video = container.querySelector("video")!;
    fire(video, "loadstart");
    tick(199); expect(status()).toBeNull();
    tick(1); expect(status()?.textContent).toContain("正在加载");
    setBuffer(video, 1, [[0, 3.4]]);
    expect(status()?.textContent).toContain("已缓冲 2.4 秒");
    fire(video, "playing"); expect(status()).toBeNull();
    fire(video, "waiting"); tick(200); expect(status()).not.toBeNull();
    fire(video, "pause"); expect(status()).toBeNull();
    fire(video, "seeking"); fire(video, "waiting"); tick(300); expect(status()).toBeNull();
    fire(video, "play"); fire(video, "waiting"); tick(200); expect(status()).not.toBeNull();
    fire(video, "error"); expect(status()).toBeNull();
  });
});
