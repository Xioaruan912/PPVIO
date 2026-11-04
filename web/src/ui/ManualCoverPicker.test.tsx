import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Media } from "../api";
import { mediaTools } from "../mediaTools";
import { captureManualCover, ManualCoverPicker } from "./ManualCoverPicker";
import * as privacy from "./privacy";
import { MediaActions } from "../feed/MediaActions";
import { useRouteState } from "./navigation";

const media = { id: "a".repeat(64), duration_seconds: 100, stream_url: "/one.mp4", variants: [] } as unknown as Media;
let box: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let video: HTMLVideoElement;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  box = document.createElement("div"); document.body.append(box); root = createRoot(box);
  video = document.createElement("video"); video.src = media.stream_url; video.currentTime = 12.5;
  Object.defineProperties(video, { videoWidth: { value: 1920 }, videoHeight: { value: 1080 }, readyState: { value: 2 } });
  vi.spyOn(mediaTools, "preparePreview").mockResolvedValue({ state: "ready", frames: [{ index: 0, at: 10, url: `/api/v1/media/${media.id}/preview/0.jpg?v=${"b".repeat(64)}` }] });
  vi.spyOn(privacy, "useLocked").mockReturnValue(false);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(callback => callback(new Blob(["jpeg"], { type: "image/jpeg" })));
});
afterEach(async () => {
  await act(async () => root.unmount());
  await new Promise(resolve => setTimeout(resolve, 30));
  box.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
});

it("scales the current frame to 480 pixels and uploads its exact playhead as JPEG", async () => {
  const saved = vi.fn(), close = vi.fn();
  const request = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ...media, cover_url: "/manual.jpg" }) });
  vi.stubGlobal("fetch", request);
  await act(async () => root.render(<ManualCoverPicker media={media} video={{ current: video }} onSaved={saved} onClose={close} />));
  await act(async () => box.querySelector<HTMLButtonElement>('[aria-label="使用当前画面"]')!.click());
  const [url, init] = request.mock.calls[0];
  expect(url).toBe(`/api/v1/media/${media.id}/manual-cover?at_seconds=12.5`);
  expect(init.method).toBe("PUT"); expect(init.headers["Content-Type"]).toBe("image/jpeg");
  expect(init.body.size).toBeLessThanOrEqual(65536);
  const context = vi.mocked(HTMLCanvasElement.prototype.getContext).mock.results[0].value as CanvasRenderingContext2D;
  expect(context.drawImage).toHaveBeenCalledWith(video, 0, 0, 480, 270);
  expect(saved).toHaveBeenCalledWith(expect.objectContaining({ id: media.id, cover_url: "/manual.jpg" }));
  expect(close).toHaveBeenCalledOnce();
});

it("reduces JPEG quality for a complex frame and refuses oversized output", async () => {
  let calls = 0;
  vi.mocked(HTMLCanvasElement.prototype.toBlob).mockImplementation(callback => {
    callback(new Blob([new Uint8Array(++calls < 3 ? 65537 : 60000)], { type: "image/jpeg" }));
  });
  expect((await captureManualCover(video, 1920, 1080)).size).toBe(60000);
  const quality = vi.mocked(HTMLCanvasElement.prototype.toBlob).mock.calls.map(call => call[2]);
  expect(quality[0]).toBeGreaterThan(quality[1]!);
  vi.mocked(HTMLCanvasElement.prototype.toBlob).mockImplementation(callback => callback(new Blob([new Uint8Array(65537)], { type: "image/jpeg" })));
  await expect(captureManualCover(video, 1920, 1080)).rejects.toThrow();
});

it("uploads a loaded preview frame without seeking the video and supports reset", async () => {
  const request = vi.fn().mockResolvedValue({ ok: true, json: async () => media }); vi.stubGlobal("fetch", request);
  await act(async () => root.render(<ManualCoverPicker media={media} video={{ current: video }} onSaved={vi.fn()} onClose={vi.fn()} />));
  const img = box.querySelector("img")!;
  Object.defineProperties(img, { naturalWidth: { value: 320 }, naturalHeight: { value: 180 }, complete: { value: true } });
  await act(async () => box.querySelector<HTMLButtonElement>('[aria-label="使用 0:10 的画面"]')!.click());
  expect(request.mock.calls[0][0]).toContain("at_seconds=10"); expect(video.currentTime).toBe(12.5);
  await act(async () => root.render(<ManualCoverPicker key="reset" media={media} video={{ current: video }} onSaved={vi.fn()} onClose={vi.fn()} />));
  await act(async () => box.querySelector<HTMLButtonElement>('[aria-label="恢复默认封面"]')!.click());
  expect(request.mock.calls[1][1].method).toBe("DELETE");
});

it("keeps errors visible and allows preview selection after a canvas security error", async () => {
  vi.mocked(HTMLCanvasElement.prototype.getContext).mockImplementationOnce(() => { throw new DOMException("tainted", "SecurityError"); });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 409 }));
  await act(async () => root.render(<ManualCoverPicker media={media} video={{ current: video }} onSaved={vi.fn()} onClose={vi.fn()} />));
  await act(async () => box.querySelector<HTMLButtonElement>('[aria-label="使用当前画面"]')!.click());
  expect(box.querySelector('[role="alert"]')?.textContent).toContain("预览");
  expect(box.querySelector('[aria-label="使用 0:10 的画面"]')).not.toBeNull();
  await act(async () => box.querySelector<HTMLButtonElement>('[aria-label="恢复默认封面"]')!.click());
  expect(box.querySelector('[role="alert"]')?.textContent).toContain("空间");
});

it("aborts and suppresses stale save results when media changes or the page hides", async () => {
  let finish!: (response: unknown) => void;
  const request = vi.fn().mockImplementation(() => new Promise(resolve => { finish = resolve; })); vi.stubGlobal("fetch", request);
  const saved = vi.fn(), close = vi.fn();
  await act(async () => root.render(<ManualCoverPicker media={media} video={{ current: video }} onSaved={saved} onClose={close} />));
  await act(async () => box.querySelector<HTMLButtonElement>('[aria-label="恢复默认封面"]')!.click());
  const signal = request.mock.calls[0][1].signal as AbortSignal;
  await act(async () => root.render(<ManualCoverPicker media={{ ...media, id: "b".repeat(64) }} video={{ current: video }} onSaved={saved} onClose={close} />));
  expect(signal.aborted).toBe(true);
  await act(async () => finish({ ok: true, json: async () => media }));
  expect(saved).not.toHaveBeenCalled();
  Object.defineProperty(document, "hidden", { configurable: true, value: true });
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  expect(box.querySelector('[role="dialog"]')).toBeNull(); expect(close).toHaveBeenCalledOnce();
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
});

it("does not capture a video that has switched to another media source", async () => {
  const request = vi.fn(); vi.stubGlobal("fetch", request); video.src = "/different.mp4";
  await act(async () => root.render(<ManualCoverPicker media={media} video={{ current: video }} onSaved={vi.fn()} onClose={vi.fn()} />));
  await act(async () => box.querySelector<HTMLButtonElement>('[aria-label="使用当前画面"]')!.click());
  expect(request).not.toHaveBeenCalled(); expect(box.querySelector('[role="alert"]')).not.toBeNull();
});

it("removes preview images immediately on lock and ignores a late save after unmount", async () => {
  let finish!: (response: unknown) => void;
  const request = vi.fn().mockImplementation(() => new Promise(resolve => { finish = resolve; })); vi.stubGlobal("fetch", request);
  const saved = vi.fn(), close = vi.fn();
  await act(async () => root.render(<ManualCoverPicker media={media} video={{ current: video }} onSaved={saved} onClose={close} />));
  await act(async () => box.querySelector<HTMLButtonElement>('[aria-label="恢复默认封面"]')!.click());
  vi.mocked(privacy.useLocked).mockReturnValue(true);
  await act(async () => root.render(<ManualCoverPicker media={media} video={{ current: video }} onSaved={saved} onClose={close} />));
  expect(box.querySelector("img")).toBeNull(); expect(close).toHaveBeenCalledOnce();
  expect(request.mock.calls[0][1].signal.aborted).toBe(true);
  await act(async () => root.render(null));
  await act(async () => finish({ ok: true, json: async () => media }));
  expect(saved).not.toHaveBeenCalled();
});

it("refuses an old preview image while its replacement is still loading", async () => {
  const request = vi.fn(); vi.stubGlobal("fetch", request);
  await act(async () => root.render(<ManualCoverPicker media={media} video={{ current: video }} onSaved={vi.fn()} onClose={vi.fn()} />));
  const image = box.querySelector("img")!;
  Object.defineProperties(image, { naturalWidth: { value: 320 }, naturalHeight: { value: 180 }, complete: { value: false } });
  await act(async () => box.querySelector<HTMLButtonElement>('[aria-label="使用 0:10 的画面"]')!.click());
  expect(request).not.toHaveBeenCalled(); expect(box.querySelector('[role="alert"]')).not.toBeNull();
});

it("keeps cover selection in one sheet and returns to the library with one Back", async () => {
  history.replaceState({}, "");
  function Harness() {
    const [page, go, , back] = useRouteState("library"), [open, setOpen] = useState(false);
    return <><span data-page>{page}</span><button onClick={() => go("player")}>open-player</button><button onClick={() => setOpen(true)}>more</button><button onClick={back}>back</button>
      <MediaActions media={media} video={{ current: video }} open={open} onClose={() => setOpen(false)} /></>;
  }
  const click = async (text: string) => act(async () => [...box.querySelectorAll("button")].find(button => button.textContent === text)!.click());
  const settle = async () => act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
  await act(async () => root.render(<Harness />));
  await click("open-player"); await click("more"); await settle(); await click("选择封面"); await settle();
  expect(box.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  await act(async () => box.querySelector<HTMLButtonElement>('[aria-label="关闭封面选择"]')!.click());
  await settle(); await click("back"); await settle();
  expect(box.querySelector('[data-page]')?.textContent).toBe("library");
});
