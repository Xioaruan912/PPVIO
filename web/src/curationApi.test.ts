import { afterEach, expect, it, vi } from "vitest";
import { Unauthorized } from "./api";
import { curationApi } from "./curationApi";

afterEach(() => vi.unstubAllGlobals());
it("sends bounded curation pages and distinct append/remove mutations with cancellation", async () => {
  const requests: { path: string; init: RequestInit }[] = [];
  vi.stubGlobal("fetch", async (path: string, init: RequestInit) => {
    requests.push({ path, init }); return Response.json({ changed: 1, items: [], has_more: false });
  });
  const controller = new AbortController();
  await curationApi.list(true, 40, controller.signal);
  await curationApi.batch(["one"], { add_tags: [1], remove_tags: [2], organized: false }, controller.signal);
  expect(requests[0].path).toBe("/api/v1/curation?organized=true&offset=40&limit=20");
  expect(requests[0].init.credentials).toBe("same-origin");
  expect(requests[0].init.signal).toBe(controller.signal);
  expect(requests[1].init.method).toBe("POST");
  expect(JSON.parse(String(requests[1].init.body))).toEqual({ media_ids: ["one"], add_tags: [1], remove_tags: [2], organized: false });
});
it("saves the explicit preference mode and propagates authentication failures", async () => {
  const requests: RequestInit[] = [];
  vi.stubGlobal("fetch", async (_path: string, init: RequestInit) => { requests.push(init); return Response.json({}); });
  await curationApi.savePreferences({ preferred_tags: [1], excluded_tags: [2], mode: "only" });
  expect(JSON.parse(String(requests[0].body))).toEqual({ preferred_tags: [1], excluded_tags: [2], mode: "only" });
  expect(requests[0].method).toBe("PUT");
  vi.stubGlobal("fetch", async () => new Response(null, { status: 401 }));
  await expect(curationApi.preferences()).rejects.toBeInstanceOf(Unauthorized);
});
