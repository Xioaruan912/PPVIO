import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { clipPreloadReady, resolveClipRange, useClipRange } from "./clipRange";
import { createSeekSession } from "./seek";

it("resolves legacy points to20seconds, clamps to actual duration and rejects empty bounds", () => {
  expect(resolveClipRange({ key: "a", start: 10 }, 100)).toEqual({ start: 10, end: 30 });
  expect(resolveClipRange({ key: "a", start: 90, end: 120 }, 100)).toEqual({ start: 90, end: 100 });
  expect(resolveClipRange({ key: "a", start: 100 }, 100)).toBeNull();
  expect(resolveClipRange({ key: "a", start: -1 }, 100)).toBeNull();
  expect(resolveClipRange({ key: "a", start: 20, end: 20 }, 100)).toBeNull();
});

it("keeps one source's different clips independent and stops stale loop writes when inactive", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const box = document.createElement("div"); const root = createRoot(box), video = document.createElement("video"); video.src = "/v";
  Object.defineProperties(video, { duration: { value: 100 }, readyState: { value: 4 } });
  function Harness({ keyId, start, end, enabled = true }: { keyId: string; start: number; end: number; enabled?: boolean }) {
    useClipRange({ current: video }, "/v", enabled, { key: keyId, start, end }); return null;
  }
  try {
    await act(async () => root.render(<Harness keyId="a" start={10} end={20} />)); expect(video.currentTime).toBe(10);
    video.currentTime = 20.1; await act(async () => video.dispatchEvent(new Event("timeupdate"))); expect(video.currentTime).toBe(10);
    await act(async () => root.render(<Harness keyId="b" start={30} end={40} />)); expect(video.currentTime).toBe(30);
    video.currentTime = 35;
    await act(async () => root.render(<Harness keyId="overlap" start={32} end={38} />)); expect(video.currentTime).toBe(32);
    await act(async () => root.render(<Harness keyId="b" start={30} end={40} enabled={false} />));
    video.currentTime = 45; await act(async () => video.dispatchEvent(new Event("timeupdate"))); expect(video.currentTime).toBe(45);
  } finally { await act(async () => root.unmount()); }
});

it("preloads short ranges only after useful interval buffering and never resumes a paused loop", async () => {
  const video = document.createElement("video"); video.src = "/v"; video.currentTime = 10;
  Object.defineProperties(video, { duration: { value: 100 }, readyState: { value: 4 },
    buffered: { configurable: true, value: { length: 1, start: () => 10, end: () => 10.1 } } });
  expect(clipPreloadReady(video, { start: 10, end: 12 }, false)).toBe(false);
  Object.defineProperty(video, "buffered", { value: { length: 1, start: () => 10, end: () => 12 } });
  expect(clipPreloadReady(video, { start: 10, end: 12 }, false)).toBe(true);
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const root = createRoot(document.createElement("div")); const play = vi.spyOn(video, "play").mockResolvedValue();
  function Harness({ enabled = true }: { enabled?: boolean }) { useClipRange({ current: video }, "/v", enabled, { key: "paused", start: 10, end: 12 }, false); return null; }
  try {
    await act(async () => root.render(<Harness />));
    video.currentTime = 11;
    await act(async () => root.render(<Harness enabled={false} />));
    await act(async () => root.render(<Harness />)); expect(video.currentTime).toBe(11);
    video.currentTime = 12; Object.defineProperty(video, "ended", { value: true });
    await act(async () => video.dispatchEvent(new Event("ended")));
    expect(play).not.toHaveBeenCalled(); expect(video.currentTime).toBe(12);
  } finally { await act(async () => root.unmount()); vi.restoreAllMocks(); }
});

it("seeking in a clip cannot escape its selected interval", () => {
  const video = document.createElement("video"); video.src = "/v";
  Object.defineProperty(video, "duration", { value: 100 });
  const seek = createSeekSession(video, () => {}, { start: 10, end: 20 });
  seek.move(1); expect(video.currentTime).toBe(10); seek.commit(90); expect(video.currentTime).toBe(20);
});
