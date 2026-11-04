import { beforeEach, afterEach, expect, it, vi } from "vitest";

beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());

it("never lets a delayed settings read lower the acknowledged clear epoch or re-enable recording", async () => {
  let resolve!: (value: Response) => void;
  vi.stubGlobal("fetch", async (_path: string, init: RequestInit) => init.method === "GET" ? new Promise<Response>(r => { resolve = r; }) : Response.json({ enabled: false, epoch: 8 }));
  const { experienceApi, getHistorySettings, refreshHistorySettings, subscribeHistorySettings } = await import("./experienceApi");
  const observed: unknown[] = [], unsubscribe = subscribeHistorySettings(() => observed.push(getHistorySettings()));
  const pending = refreshHistorySettings(); await experienceApi.setHistoryEnabled(false);
  resolve(Response.json({ enabled: true, epoch: 7 })); await pending;
  expect(getHistorySettings()).toEqual({ enabled: false, epoch: 8 }); expect(observed).toEqual([{ enabled: false, epoch: 8 }]);
  unsubscribe();
});

it("notifies playback subscribers when a single history deletion advances the epoch", async () => {
  const requests: { path: string; init: RequestInit }[] = [];
  vi.stubGlobal("fetch", async (path: string, init: RequestInit) => { requests.push({ path, init }); return Response.json({ enabled: true, epoch: requests.length }); });
  const { experienceApi, getHistorySettings, refreshHistorySettings, subscribeHistorySettings } = await import("./experienceApi");
  await refreshHistorySettings(); const observed: unknown[] = [];
  const unsubscribe = subscribeHistorySettings(() => observed.push(getHistorySettings()));
  await experienceApi.clearHistory("opaque/id");
  expect(requests[1].path).toBe("/api/v1/history/opaque%2Fid"); expect(requests[1].init.method).toBe("DELETE");
  expect(observed).toEqual([{ enabled: true, epoch: 2 }]); unsubscribe();
});

it("records a captured playhead and epoch with the same-origin session and optional unload delivery", async () => {
  let sent!: RequestInit;
  vi.stubGlobal("fetch", async (_path: string, init: RequestInit) => { sent = init; return Response.json({ recorded: false }); });
  const { experienceApi } = await import("./experienceApi");
  const controller = new AbortController();
  expect(await experienceApi.recordHistory({ media_id: "opaque", position_seconds: 37.25, epoch: 9 }, controller.signal, true)).toEqual({ recorded: false });
  expect(JSON.parse(String(sent.body))).toEqual({ media_id: "opaque", position_seconds: 37.25, epoch: 9 });
  expect(sent.credentials).toBe("same-origin"); expect(sent.keepalive).toBe(true); expect(sent.signal).toBe(controller.signal);
});
