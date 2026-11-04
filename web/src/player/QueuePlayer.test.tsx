import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api, type Media } from "../api";
import { QueuePlayer } from "./QueuePlayer";
import { setPref } from "../prefs";
const media = (id: string, category = "short") => ({ id, category, stream_url: `/${id}.mp4`, cover_url: null, width: 360, height: 640, duration_seconds: 60, size_bytes: 100, variants: [], favorite: false, deletable: false }) as Media;
let root: ReturnType<typeof createRoot>, box: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  vi.stubGlobal("fetch", async () => Response.json({ enabled: true, epoch: 1 }));
  box = document.createElement("div"); document.body.append(box); root = createRoot(box);
});
afterEach(async () => { await act(async () => root.unmount()); box.remove(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it("advances a long video to retry and skip when the next queue item is unavailable",async()=>{
 vi.useFakeTimers();
 vi.spyOn(api,"media").mockImplementation((id)=>id==="a"?Promise.resolve(media("a","long")):Promise.reject(new Error("deleted")));
 vi.spyOn(api,"longProgress").mockResolvedValue({items:[],recent_items:[]});
 await act(async()=>root.render(<QueuePlayer ids={["a","b","c"]} start={0} onClose={()=>{}}/>));
 await act(async()=>box.querySelector("video")!.dispatchEvent(new Event("ended")));
 for (let second = 0; second < 6; second++) await act(async()=>vi.advanceTimersByTimeAsync(1000));
 expect(box.querySelector("video")).toBeNull();
 expect(box.textContent).toContain("待播 2/3");
 expect(box.textContent).toContain("这个视频暂时无法播放");
});

it("starts long videos muted and lets the user enable sound", async () => {
  setPref("muted", true);
  vi.spyOn(api, "media").mockResolvedValue(media("long", "long"));
  vi.spyOn(api, "longProgress").mockResolvedValue({ items: [], recent_items: [] });
  await act(async () => root.render(<QueuePlayer ids={["long"]} start={0} onClose={() => {}} />));
  expect(box.querySelector("video")!.muted).toBe(true);
  await act(async () => box.querySelector<HTMLButtonElement>('[aria-label="打开声音"]')!.click());
  expect(box.querySelector("video")!.muted).toBe(false);
  setPref("muted", true);
});
