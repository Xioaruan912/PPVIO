import { afterEach, expect, it, vi } from "vitest";
import { createSeekSession, seekIntent } from "./seek";

afterEach(() => vi.useRealTimers());

it("coalesces moves to80ms, commits exact release and never changes pause state", () => {
  vi.useFakeTimers();
  const video = document.createElement("video"); video.src = "/one.mp4";
  Object.defineProperty(video, "duration", { value: 120 });
  const setter = vi.spyOn(video, "currentTime", "set");
  const pause = vi.spyOn(video, "pause"); const play = vi.spyOn(video, "play");
  const preview = vi.fn(); const s = createSeekSession(video, preview);
  s.move(20); s.move(30); s.move(40);
  expect(setter).toHaveBeenCalledTimes(1); expect(preview).toHaveBeenLastCalledWith(40);
  vi.advanceTimersByTime(80); expect(video.currentTime).toBe(40);
  s.move(50); s.commit(55.5); vi.advanceTimersByTime(100);
  expect(video.currentTime).toBe(55.5);
  expect(play).not.toHaveBeenCalled(); expect(pause).not.toHaveBeenCalled();
});

it("drops pending seeks on source changes and cancellation and clamps positions", () => {
  vi.useFakeTimers(); const v = document.createElement("video"); v.src = "/one.mp4";
  Object.defineProperty(v, "duration", { value: 60 });
  const s = createSeekSession(v, () => {}); s.move(-20); expect(v.currentTime).toBe(0);
  s.move(90); s.cancel(); vi.advanceTimersByTime(100); expect(v.currentTime).toBe(0);
  const next = createSeekSession(v, () => {}); next.move(5); next.move(30); v.src = "/two.mp4";
  vi.advanceTimersByTime(100); next.commit(50); expect(v.currentTime).toBe(5);
  expect(seekIntent(5, 4)).toBe("pending"); expect(seekIntent(13, 24)).toBe("vertical");
  expect(seekIntent(40, 8)).toBe("horizontal");
});

it("cancels delayed seeks when playback pauses but allows a fresh paused drag", () => {
  vi.useFakeTimers(); const video = document.createElement("video"); video.src = "/v";
  Object.defineProperty(video, "duration", { value: 100 });
  const first = createSeekSession(video, () => {}); first.move(10); first.move(20);
  video.dispatchEvent(new Event("pause")); vi.advanceTimersByTime(100); first.commit(30);
  expect(video.currentTime).toBe(10);
  const next = createSeekSession(video, () => {}); next.commit(40); expect(video.currentTime).toBe(40);
});
