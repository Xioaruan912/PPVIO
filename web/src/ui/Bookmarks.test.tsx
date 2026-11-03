import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { Media } from "../api";
import { mediaTools } from "../mediaTools";
import { BookmarkButton } from "./Bookmarks";

it("saves the current playhead and can jump back to the saved moment", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const box = document.createElement("div"); document.body.append(box); const root = createRoot(box);
  const v = document.createElement("video"); v.currentTime = 37;
  const media = { id: "one", stream_url: "/one.mp4" } as Media;
  const b = { id: "b", media_id: "one", position_seconds: 37, name: "", created_at: 1 };
  vi.spyOn(mediaTools, "bookmarks").mockResolvedValue({ items: [] });
  vi.spyOn(mediaTools, "addBookmark").mockResolvedValue(b);
  try {
    await act(async () => root.render(<BookmarkButton media={media} video={{ current: v }} enabled />));
    await act(async () => box.querySelector<HTMLButtonElement>('[aria-label="片内书签"]')!.click());
    await act(async () => [...box.querySelectorAll("button")].find(x => x.textContent?.includes("收藏当前时刻"))!.click());
    expect(mediaTools.addBookmark).toHaveBeenCalledWith("one", 37, "");
    expect(box.textContent).toContain("0:37"); v.currentTime = 1;
    await act(async () => box.querySelector<HTMLButtonElement>('[aria-label="跳到 0:37"]')!.click());
    expect(v.currentTime).toBe(37);
  } finally { await act(async () => root.unmount()); box.remove(); vi.restoreAllMocks(); }
});
