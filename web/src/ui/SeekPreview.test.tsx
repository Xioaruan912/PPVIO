import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { mediaTools } from "../mediaTools";
import { PreviewButton } from "./SeekPreview";
import type { Media } from "../api";

it("lets the viewer refresh when a queued preview exceeds the polling window", async () => {
  vi.useFakeTimers(); Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const box = document.createElement("div"); document.body.append(box); const root = createRoot(box);
  vi.spyOn(mediaTools, "preparePreview").mockResolvedValue({ state: "pending", frames: [] });
  vi.spyOn(mediaTools, "preview").mockResolvedValue({ state: "pending", frames: [] });
  try {
    await act(async () => root.render(<PreviewButton media={{ id: "one" } as Media} />));
    await act(async () => box.querySelector<HTMLButtonElement>('[aria-label="预览画面"]')!.click());
    await act(async () => vi.advanceTimersByTimeAsync(61000));
    const refresh = [...box.querySelectorAll("button")].find(x => x.textContent === "刷新预览");
    expect(refresh).toBeDefined();
    vi.mocked(mediaTools.preparePreview).mockResolvedValue({ state: "ready", frames: [{ index: 0, at: 10, url: "/frame.jpg" }] });
    await act(async () => refresh!.click());
    expect(box.querySelector('img')?.getAttribute("src")).toBe("/frame.jpg");
  } finally { await act(async () => root.unmount()); box.remove(); vi.restoreAllMocks(); vi.useRealTimers(); }
});
