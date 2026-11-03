import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { diagnoseFailure } from "./recovery";
import { usePlaybackRecovery } from "./usePlaybackRecovery";

vi.mock("./recovery", () => ({ diagnoseFailure: vi.fn() }));
let root: Root, box: HTMLDivElement, el: HTMLVideoElement;
function Harness({ enabled = true }: { enabled?: boolean }) {
  const r = usePlaybackRecovery({ current: el }, "/clip.mp4", enabled);
  return <span>{r.failure?.message}</span>;
}
beforeEach(() => {
  vi.useFakeTimers(); Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  box = document.createElement("div"); document.body.append(box); root = createRoot(box);
  el = document.createElement("video"); el.src = "/clip.mp4";
  Object.defineProperties(el, { duration: { value: 120 }, error: { configurable: true, value: null }, paused: { configurable: true, value: false } });
  vi.spyOn(el, "load").mockImplementation(() => { Object.defineProperty(el, "error", { configurable: true, value: null }); }); vi.spyOn(el, "play").mockResolvedValue();
  vi.mocked(diagnoseFailure).mockReset().mockResolvedValue({ kind: "network", message: "网络暂时中断", retryable: true });
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
});
afterEach(async () => { await act(async () => root.unmount()); box.remove(); vi.useRealTimers(); vi.restoreAllMocks(); });
const error = () => act(async () => { Object.defineProperty(el, "error", { configurable: true, value: { code: 2 } }); el.dispatchEvent(new Event("error")); });
it("retries network failure twice and restores the real playhead after reload", async () => {
  await act(async () => root.render(<Harness />)); el.currentTime = 37;
  await error(); await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(el.load).toHaveBeenCalledTimes(1);
  el.currentTime = 0; await act(async () => el.dispatchEvent(new Event("loadedmetadata"))); expect(el.currentTime).toBe(37);
  await error(); await act(async () => vi.advanceTimersByTimeAsync(3000)); expect(el.load).toHaveBeenCalledTimes(2);
  await error(); await act(async () => vi.advanceTimersByTimeAsync(10000)); expect(el.load).toHaveBeenCalledTimes(2);
});
it("does not retry access failures and cancels queued retry when inactive", async () => {
  await act(async () => root.render(<Harness />));
  vi.mocked(diagnoseFailure).mockResolvedValueOnce({ kind: "throttled", message: "限流中", retryable: false });
  await error(); await act(async () => vi.advanceTimersByTimeAsync(10000)); expect(el.load).not.toHaveBeenCalled();
  await error(); await act(async () => root.render(<Harness enabled={false} />));
  await act(async () => vi.advanceTimersByTimeAsync(5000)); expect(el.load).not.toHaveBeenCalled();
});

it("keeps a paused autoplay video paused across a native reload", async () => {
  Object.defineProperty(el, "paused", { configurable: true, value: true }); el.autoplay = true;
  const pause = vi.spyOn(el, "pause").mockImplementation(() => {});
  await act(async () => root.render(<Harness />)); el.currentTime = 14;
  await error(); await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(el.autoplay).toBe(false);
  el.currentTime = 0; await act(async () => el.dispatchEvent(new Event("loadedmetadata")));
  expect(el.currentTime).toBe(14); expect(el.play).not.toHaveBeenCalled(); expect(pause).toHaveBeenCalled();
});

it("diagnoses an error that happened during inactive preload when it becomes active", async () => {
  await act(async () => root.render(<Harness enabled={false} />)); await error();
  expect(diagnoseFailure).not.toHaveBeenCalled();
  await act(async () => root.render(<Harness />));
  expect(diagnoseFailure).toHaveBeenCalledTimes(1);
  await act(async () => vi.advanceTimersByTimeAsync(1000)); expect(el.load).toHaveBeenCalledTimes(1);
});

it("restores a pending reload after metadata arrived while the page was inactive", async () => {
  await act(async () => root.render(<Harness />)); el.currentTime = 23;
  await error(); await act(async () => vi.advanceTimersByTimeAsync(1000));
  await act(async () => root.render(<Harness enabled={false} />)); el.currentTime = 0;
  await act(async () => el.dispatchEvent(new Event("loadedmetadata")));
  Object.defineProperty(el, "readyState", { configurable: true, value: 1 });
  await act(async () => root.render(<Harness />)); expect(el.currentTime).toBe(23);
});

it("restores autoplay after a playing recovery so subsequent source changes can play", async () => {
  el.autoplay = true; await act(async () => root.render(<Harness />));
  await error(); await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(el.autoplay).toBe(false);
  await act(async () => el.dispatchEvent(new Event("playing")));
  expect(el.autoplay).toBe(true);
});

it("diagnoses a reload that failed while inactive without losing the saved position", async () => {
  await act(async () => root.render(<Harness />)); el.currentTime = 23;
  await error(); await act(async () => vi.advanceTimersByTimeAsync(1000));
  await act(async () => root.render(<Harness enabled={false} />)); el.currentTime = 0;
  await error(); const calls = vi.mocked(diagnoseFailure).mock.calls.length;
  await act(async () => root.render(<Harness />)); expect(diagnoseFailure).toHaveBeenCalledTimes(calls + 1);
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  await act(async () => el.dispatchEvent(new Event("loadedmetadata"))); expect(el.currentTime).toBe(23);
});

it("diagnoses a reload error on visibility return even when enabled never changed", async () => {
  await act(async () => root.render(<Harness />)); el.currentTime = 23;
  await error(); await act(async () => vi.advanceTimersByTimeAsync(1000)); el.currentTime = 0;
  Object.defineProperty(document, "hidden", { configurable: true, value: true });
  await act(async () => document.dispatchEvent(new Event("visibilitychange"))); await error();
  const calls = vi.mocked(diagnoseFailure).mock.calls.length;
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  expect(diagnoseFailure).toHaveBeenCalledTimes(calls + 1);
  await act(async () => vi.advanceTimersByTimeAsync(3000));
  await act(async () => el.dispatchEvent(new Event("loadedmetadata"))); expect(el.currentTime).toBe(23);
});
