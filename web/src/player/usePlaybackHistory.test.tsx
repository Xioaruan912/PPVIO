import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { Media } from "../api";
import { experienceApi } from "../experienceApi";
import { usePlaybackHistory } from "./usePlaybackHistory";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
let generation = 10;
it("records real foreground viewing after2s and cancels recording after settings disable", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); vi.useFakeTimers();
  const writes: unknown[] = []; let enabled = true, epoch = ++generation;
  vi.stubGlobal("fetch", async (path: string, init?: RequestInit) => {
    if (path.endsWith("/settings")) { if (init?.method === "PUT") { enabled = false; epoch++; } return Response.json({ enabled, epoch }); }
    writes.push(JSON.parse(String(init?.body))); return Response.json({ recorded: true });
  });
  const root = createRoot(document.createElement("div")), video = document.createElement("video"); video.src = "/v"; video.currentTime = 7;
  Object.defineProperties(video, { paused: { configurable: true, value: false }, readyState: { value: 4 }, duration: { value: 100 } });
  function Harness({ enabled = true }: { enabled?: boolean }) { usePlaybackHistory({ current: video }, { id: "a".repeat(64) } as Media, "/v", enabled); return null; }
  try {
    await act(async () => root.render(<Harness />));
    const advancing = setInterval(() => { video.currentTime += 0.5; }, 500);
    await act(async () => vi.advanceTimersByTimeAsync(1900)); expect(writes).toEqual([]);
    await act(async () => vi.advanceTimersByTimeAsync(1100)); clearInterval(advancing); expect(writes).toHaveLength(1);
    expect(writes[0]).toEqual({ media_id: "a".repeat(64), position_seconds: expect.any(Number), epoch });
    await act(async () => experienceApi.setHistoryEnabled(false));
    await act(async () => vi.advanceTimersByTimeAsync(20_000)); expect(writes).toHaveLength(1);
    await act(async () => root.render(<Harness enabled={false} />)); expect(writes).toHaveLength(1);
  } finally { await act(async () => root.unmount()); }
});
it("ignores metadata-only neighbors and paused videos", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); vi.useFakeTimers();
  const fetch = vi.fn().mockResolvedValue(Response.json({ enabled: true, epoch: ++generation })); vi.stubGlobal("fetch", fetch);
  const root = createRoot(document.createElement("div")), video = document.createElement("video"); video.src = "/v";
  Object.defineProperty(video, "readyState", { value: 4 });
  function Harness({ enabled = false }: { enabled?: boolean }) { usePlaybackHistory({ current: video }, { id: "a".repeat(64) } as Media, "/v", enabled); return null; }
  try {
    await act(async () => root.render(<Harness />)); await act(async () => vi.advanceTimersByTimeAsync(5000)); expect(fetch).not.toHaveBeenCalled();
    await act(async () => root.render(<Harness enabled />)); await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(fetch.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(0);
  } finally { await act(async () => root.unmount()); }
});

it("does not count waiting or a nonadvancing playhead as viewed time", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); vi.useFakeTimers();
  const writes: unknown[] = [];
  vi.stubGlobal("fetch", async (_path: string, init?: RequestInit) => {
    if (init?.method === "POST") writes.push(init.body);
    return Response.json({ enabled: true, epoch: ++generation });
  });
  const root = createRoot(document.createElement("div")), video = document.createElement("video"); video.src = "/v";
  Object.defineProperties(video, { paused: { value: false }, readyState: { value: 2 } });
  function Harness() { usePlaybackHistory({ current: video }, { id: "b".repeat(64) } as Media, "/v", true); return null; }
  try {
    await act(async () => root.render(<Harness />));
    video.dispatchEvent(new Event("waiting"));
    await act(async () => vi.advanceTimersByTimeAsync(5000)); expect(writes).toHaveLength(0);
    video.dispatchEvent(new Event("playing"));
    await act(async () => vi.advanceTimersByTimeAsync(5000)); expect(writes).toHaveLength(0);
  } finally { await act(async () => root.unmount()); }
});
