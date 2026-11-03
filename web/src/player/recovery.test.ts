import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyFailure, diagnoseFailure } from "./recovery";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
const diagnose = (code?: number) => diagnoseFailure("/api/v1/media/opaque/stream", code, new AbortController().signal);

describe("playback failure classification", () => {
  it.each([
    [401, 2, "auth", false], [403, 2, "access", false], [404, 2, "access", false],
    [429, 2, "throttled", false], [503, 2, "network", true],
    [408, 4, "network", true], [502, 4, "network", true], [503, 4, "network", true], [504, 3, "network", true],
    [200, 3, "codec", false], [206, 4, "codec", false],
    [200, 2, "network", true], [200, undefined, "unknown", false],
  ] as const)("classifies status %s and media code %s honestly", (status, code, kind, retryable) => {
    expect(classifyFailure(status, code)).toMatchObject({ kind, retryable });
  });
});

describe("bounded same-origin diagnosis", () => {
  it("requests just the first byte without redirects and cancels even a successful full response", async () => {
    let options!: RequestInit, requested = "", cancelled = false;
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      requested = url; options = init;
      return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 200 });
    });
    expect(await diagnose(4)).toMatchObject({ kind: "codec", retryable: false });
    expect(new URL(requested).origin).toBe(window.location.origin);
    expect(options).toMatchObject({ method: "GET", credentials: "same-origin", mode: "same-origin", redirect: "manual", cache: "no-store" });
    expect(new Headers(options.headers).get("Range")).toBe("bytes=0-0");
    expect(cancelled).toBe(true);
  });

  it("never fetches an external, credential-bearing, or non-HTTP source", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", () => { calls++; throw new Error("must not fetch"); });
    for (const src of ["https://untrusted.test/private", "//untrusted.test/private", "data:video/mp4;base64,AA==", `http://user:secret@${window.location.host}/media`]) {
      expect(await diagnoseFailure(src, undefined, new AbortController().signal)).toMatchObject({ kind: "unknown", retryable: false });
    }
    expect(calls).toBe(0);
  });

  it("keeps server details out of messages and closes failure bodies", async () => {
    let cancelled = 0;
    vi.stubGlobal("fetch", async () => new Response(new ReadableStream({ cancel() { cancelled++; } }), {
      status: 403, headers: { "X-Upstream-Secret": "private" },
    }));
    const result = await diagnose(2);
    expect(result).toMatchObject({ kind: "access", retryable: false });
    expect(result.message).not.toContain("private");
    expect(cancelled).toBe(1);
  });

  it("does not retry an uncontrolled redirect as a network failure", async () => {
    vi.stubGlobal("fetch", async () => new Response(null, { status: 302, headers: { Location: "https://other.test/file" } }));
    expect(await diagnose()).toMatchObject({ kind: "unknown", retryable: false });
  });

  it("bounds a hung request to five seconds and reports a transient network failure", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", (_: string, options: RequestInit) => new Promise((_, reject) => {
      options.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));
    const result = diagnose();
    await vi.advanceTimersByTimeAsync(5000);
    expect(await result).toMatchObject({ kind: "network", retryable: true });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("propagates caller cancellation and clears its timeout", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", (_: string, options: RequestInit) => new Promise((_, reject) => {
      options.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));
    const controller = new AbortController();
    const result = diagnoseFailure("/media", 2, controller.signal);
    const rejection = expect(result).rejects.toMatchObject({ name: "AbortError" });
    controller.abort(); await rejection;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns a safe network message when fetch fails", async () => {
    vi.stubGlobal("fetch", async () => { throw new Error("private upstream address"); });
    const result = await diagnose(2);
    expect(result).toMatchObject({ kind: "network", retryable: true });
    expect(result.message).not.toContain("private");
  });
});
