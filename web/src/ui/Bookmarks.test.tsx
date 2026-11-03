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

it("saves a range clamped to the actual duration and can turn an old point into a range", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const box = document.createElement("div"); document.body.append(box); const root = createRoot(box);
  const video = document.createElement("video"); video.currentTime = 37;
  Object.defineProperty(video, "duration", { value: 45 });
  const point = { id: "old", media_id: "one", position_seconds: 30, name: "", created_at: 1 };
  vi.spyOn(mediaTools, "bookmarks").mockResolvedValue({ items: [point] });
  vi.spyOn(mediaTools, "addBookmark").mockResolvedValue({ ...point, id: "new", position_seconds: 37, end_seconds: 45 });
  vi.spyOn(mediaTools, "updateBookmark").mockResolvedValue({ ...point, end_seconds: 45 });
  try {
    await act(async () => root.render(<BookmarkButton media={{ id: "one" } as Media} video={{ current: video }} enabled />));
    await act(async () => box.querySelector<HTMLButtonElement>('[aria-label="片内书签"]')!.click());
    await act(async () => box.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    await act(async () => [...box.querySelectorAll("button")].find(button => button.textContent?.includes("收藏当前时刻"))!.click());
    expect(mediaTools.addBookmark).toHaveBeenCalledWith("one", 37, "", 45);
    await act(async () => [...box.querySelectorAll("button")].find(button => button.textContent === "设为片段")!.click());
    expect(mediaTools.updateBookmark).toHaveBeenCalledWith("one", "old", { end_seconds: 45 });
    expect(box.textContent).toContain("0:30–0:45");
  } finally { await act(async () => root.unmount()); box.remove(); vi.restoreAllMocks(); }
});
