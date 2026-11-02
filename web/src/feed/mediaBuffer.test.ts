import { describe, expect, it } from "vitest";
import { allowNextPreload, bufferedAhead, preloadHighWater } from "./mediaBuffer";

const probe = (end: number, currentTime = 0, duration = 60, playbackRate = 1) => ({
  currentTime, duration, playbackRate, readyState: 4,
  buffered: { length: 1, start: () => 0, end: () => end },
});

describe("next video preload budget", () => {
  it("uses only the range containing the playhead, not data beyond a seek gap", () => {
    const video = { ...probe(30, 10), buffered: {
      length: 2, start: (i: number) => [0, 20][i], end: (i: number) => [5, 30][i],
    } };
    expect(bufferedAhead(video)).toBe(0);
    expect(allowNextPreload(video, false)).toBe(false);
  });

  it("has separate start and stop watermarks to avoid discarding preload on every fluctuation", () => {
    expect(allowNextPreload(probe(13), false)).toBe(true);
    expect(allowNextPreload(probe(6), true)).toBe(true);
    expect(allowNextPreload(probe(3), true)).toBe(false);
    expect(allowNextPreload(probe(6), false)).toBe(false);
  });

  it("adjusts the high watermark by bitrate but always reserves at least four seconds", () => {
    expect(preloadHighWater(0)).toBe(12);
    expect(preloadHighWater(1024 ** 2)).toBe(4);
    expect(preloadHighWater(512 * 1024)).toBe(8);
    expect(preloadHighWater(64 * 1024)).toBe(12);
    expect(allowNextPreload(probe(5), false, 1024 ** 2)).toBe(true);
  });

  it("allows short clips buffered to their end and accounts for double-speed playback", () => {
    expect(allowNextPreload(probe(3, 0, 3), false)).toBe(true);
    expect(allowNextPreload(probe(15, 0, 60, 2), false)).toBe(false);
    expect(allowNextPreload(probe(26, 0, 60, 2), false)).toBe(true);
  });

  it("does not grant eager loading for an unready or invalid media timeline", () => {
    expect(allowNextPreload({ ...probe(15), readyState: 2 }, true)).toBe(false);
    expect(allowNextPreload(probe(15, 0, NaN), false)).toBe(false);
    expect(preloadHighWater(NaN)).toBe(12);
  });
});
