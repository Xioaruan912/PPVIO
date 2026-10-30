import { afterEach, describe, expect, it, vi } from "vitest";
import { api, chooseStream, type Media } from "./api";

const media = (variants: Media["variants"]): Media => ({
  id: "m", width: 1920, height: 1080, duration_seconds: 30, stream_url: "/orig", cover_url: null,
  favorite: false, deletable: false, category: "short", variants,
});

describe("chooseStream", () => {
  it("prefers the lowest copy when low-res is on", () => {
    const m = media([{ id: "a", height: 720, label: "720p", stream_url: "/720" }, { id: "b", height: 480, label: "480p", stream_url: "/480" }]);
    expect(chooseStream(m, true)).toBe("/480");
    expect(chooseStream(m, false)).toBe("/orig");
  });
  it("plays a copy instead of HEVC the browser cannot decode", () => {
    const m = { ...media([{ id: "a", height: 480, label: "480p", stream_url: "/480" }]), codec: "hevc" };
    expect(chooseStream(m, false, false)).toBe("/480");
    expect(chooseStream(m, false, true)).toBe("/orig");
    expect(chooseStream({ ...m, variants: [] }, false, false)).toBe("/orig");
  });
  it("falls back to the original without copies", () => {
    expect(chooseStream(media([]), true)).toBe("/orig");
  });
});

describe("request", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("treats 204 No Content as success", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
    await expect(api.addToCollection("c", "m")).resolves.toBeUndefined();
  });
});
