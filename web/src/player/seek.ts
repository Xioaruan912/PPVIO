export function seekIntent(dx: number, dy: number): "pending" | "horizontal" | "vertical" {
  if (Math.max(Math.abs(dx), Math.abs(dy)) < 12) return "pending";
  return Math.abs(dx) > Math.abs(dy) * 1.2 ? "horizontal" : "vertical";
}

/** Visual feedback is immediate; media seeks are bounded and tied to this source. */
export function createSeekSession(video: HTMLVideoElement, preview: (time: number) => void, bounds?: { start: number; end: number }) {
  const source = video.getAttribute("src");
  let live = true, last = -Infinity, target = video.currentTime, timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => { live = false; clearTimeout(timer); video.removeEventListener("pause", cancel); };
  video.addEventListener("pause", cancel);
  const valid = () => live && video.getAttribute("src") === source;
  const clamp = (time: number) => Math.max(bounds?.start ?? 0, Math.min(bounds?.end ?? (Number.isFinite(video.duration) ? video.duration : 0), Number.isFinite(time) ? time : 0));
  const write = (exact: boolean) => {
    if (!valid()) return;
    try {
      if (!exact && typeof video.fastSeek === "function") video.fastSeek(target);
      else video.currentTime = target;
      last = Date.now();
    } catch { /* Metadata can disappear while the browser switches sources. */ }
  };
  return {
    move(time: number) {
      if (!valid()) return;
      target = clamp(time); preview(target);
      if (Date.now() - last >= 80) write(false);
      else if (timer === undefined) timer = setTimeout(() => { timer = undefined; write(false); }, 80 - (Date.now() - last));
    },
    commit(time = target) {
      clearTimeout(timer); target = clamp(time); write(true); cancel();
    },
    cancel,
  };
}
