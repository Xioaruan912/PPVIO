import { afterEach, expect, it, vi } from "vitest";
vi.mock("react", () => ({ useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot() }));
afterEach(() => { localStorage.clear(); vi.resetModules(); });
it("starts each page muted despite an old sound preference and preserves other choices", async () => {
  localStorage.setItem("tgvio-web:prefs", JSON.stringify({ muted: false, lowRes: false, coverBlur: false }));
  const prefs = await import("./prefs");
  expect(prefs.usePrefs()).toMatchObject({ muted: true, lowRes: false, coverBlur: false });
  prefs.setPref("muted", false);
  expect(prefs.usePrefs().muted).toBe(false);
  vi.resetModules();
  expect((await import("./prefs")).usePrefs().muted).toBe(true);
});
