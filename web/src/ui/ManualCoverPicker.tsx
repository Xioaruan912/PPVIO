import { XIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState, type RefObject } from "react";
import type { Media } from "../api";
import type { PreviewFrame } from "../mediaTools";
import { Sheet } from "./Sheet";
import { clock, useSeekPreview } from "./SeekPreview";
import { useLocked } from "./privacy";

const MAX_BYTES = 64 * 1024;

/** Both live video and preview frames use the same bounded, local JPEG encoder. */
export async function captureManualCover(source: CanvasImageSource, width: number, height: number): Promise<Blob> {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw new Error("画面尚未解码，请稍后重试或选择预览画面。");
  const canvas = document.createElement("canvas");
  try {
    let scale = Math.min(1, 480 / Math.max(width, height));
    for (let attempt = 0; attempt < 3; attempt++, scale *= .75) {
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      const context = canvas.getContext("2d");
      if (!context) throw new Error("此浏览器无法读取画面，请选择预览画面重试。");
      context.drawImage(source, 0, 0, canvas.width, canvas.height);
      for (const quality of [.88, .75, .6, .45]) {
        const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/jpeg", quality));
        if (!blob || blob.type !== "image/jpeg") throw new Error("画面无法编码为 JPEG，请选择预览画面重试。");
        if (blob.size > 0 && blob.size <= MAX_BYTES) return blob;
      }
    }
    throw new Error("画面超过 64 KiB，请选择其他预览画面。");
  } catch (error) {
    if (error instanceof DOMException && error.name === "SecurityError") throw new Error("浏览器阻止读取当前画面，请选择下方预览画面重试。");
    throw error;
  } finally {
    // Release the decoded canvas once its encoded Blob no longer needs it.
    canvas.width = canvas.height = 0;
  }
}

function sourceMatches(video: HTMLVideoElement, media: Media): boolean {
  const source = video.currentSrc || video.src;
  if (!source) return false;
  try {
    const current = new URL(source, location.href);
    return current.origin === location.origin && [media.stream_url, ...(media.variants ?? []).map(item => item.stream_url)].some(value => {
      const expected = new URL(value, location.href);
      return expected.origin === current.origin && expected.pathname === current.pathname;
    });
  } catch { return false; }
}

export function ManualCoverPicker({ media, video, onSaved, onClose, embedded = false }: {
  media: Media; video: RefObject<HTMLVideoElement | null>; onSaved: (media: Media) => void; onClose: () => void; embedded?: boolean;
}) {
  const locked = useLocked();
  const [dismissed, setDismissed] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const current = useRef({ id: media.id, locked, onSaved, onClose });
  current.current = { id: media.id, locked, onSaved, onClose };
  const alive = useRef(false), busyRef = useRef(false), cancelled = useRef(false);
  const operation = useRef<AbortController | null>(null);
  const images = useRef(new Map<number, HTMLImageElement>());
  const shown = !dismissed && !locked && !document.hidden;
  const preview = useSeekPreview(media.id, shown);

  const close = () => {
    if (cancelled.current) return;
    cancelled.current = true; operation.current?.abort(); setDismissed(true);
    current.current.onClose();
  };
  useEffect(() => {
    alive.current = true; cancelled.current = false; busyRef.current = false;
    setDismissed(false); setBusy(false); setError("");
    return () => { alive.current = false; operation.current?.abort(); };
  }, [media.id]);
  useEffect(() => {
    const hidden = () => { if (document.hidden) close(); };
    document.addEventListener("visibilitychange", hidden);
    return () => document.removeEventListener("visibilitychange", hidden);
  }, []);
  useEffect(() => { if (locked || document.hidden) close(); }, [locked]);

  const valid = (id: string, controller: AbortController) => alive.current && !cancelled.current
    && current.current.id === id && !current.current.locked && !document.hidden
    && operation.current === controller && !controller.signal.aborted;

  const save = async (selection?: { source: CanvasImageSource; width: number; height: number; at: number; video?: HTMLVideoElement; sourceUrl?: string }) => {
    if (busyRef.current || !alive.current || cancelled.current || current.current.locked || document.hidden) return;
    const id = media.id, controller = new AbortController();
    operation.current = controller; busyRef.current = true; setBusy(true); setError("");
    try {
      const blob = selection ? await captureManualCover(selection.source, selection.width, selection.height) : undefined;
      if (!valid(id, controller)) return;
      if (selection?.video && (video.current !== selection.video || !sourceMatches(selection.video, media)
          || (selection.video.currentSrc || selection.video.src) !== selection.sourceUrl)) throw new Error("视频已切换，请重新选择画面。");
      const response = await fetch(`/api/v1/media/${id}/manual-cover${selection ? `?at_seconds=${selection.at}` : ""}`, {
        method: selection ? "PUT" : "DELETE", credentials: "same-origin", cache: "no-store", signal: controller.signal,
        ...(blob ? { headers: { "Content-Type": "image/jpeg" }, body: blob } : {}),
      });
      if (!response.ok) throw new Error(response.status === 409 ? "封面空间已满，请先恢复其他视频的默认封面。"
        : response.status === 401 ? "登录已过期，请重新登录后重试。" : "封面未保存，请稍后重试。");
      const updated = await response.json() as Media;
      if (!valid(id, controller)) return;
      if (updated.id !== id) throw new Error("视频已切换，请重新选择画面。");
      current.current.onSaved(updated); close();
    } catch (failure) {
      if (valid(id, controller)) setError(failure instanceof Error ? failure.message : "封面未保存，请稍后重试。");
    } finally {
      if (valid(id, controller)) { busyRef.current = false; setBusy(false); }
    }
  };

  const capture = () => {
    const element = video.current;
    const duration = media.duration_seconds;
    if (!element || element.readyState < 2 || !sourceMatches(element, media)
        || !Number.isFinite(element.currentTime) || element.currentTime < 0
        || duration == null || !Number.isFinite(duration) || duration <= 0 || element.currentTime > duration) {
      setError("视频画面尚未准备好或已切换，请稍后重试或选择下方预览画面。"); return;
    }
    void save({ source: element, width: element.videoWidth, height: element.videoHeight, at: element.currentTime,
      video: element, sourceUrl: element.currentSrc || element.src });
  };
  const choosePreview = (frame: PreviewFrame) => {
    const image = images.current.get(frame.index);
    let sourceReady = false;
    try {
      const expected = new URL(frame.url, location.href);
      sourceReady = expected.origin === location.origin && !!image && image.complete
        && new URL(image.currentSrc || image.src, location.href).href === expected.href;
    } catch { /* A malformed or stale preview cannot become a cover. */ }
    if (!sourceReady || !image || !image.naturalWidth || !image.naturalHeight || !Number.isFinite(frame.at) || frame.at < 0
        || media.duration_seconds == null || !Number.isFinite(media.duration_seconds)
        || media.duration_seconds <= 0 || frame.at > media.duration_seconds) {
      setError("预览画面尚未加载，请稍后重试或刷新预览。"); return;
    }
    void save({ source: image, width: image.naturalWidth, height: image.naturalHeight, at: frame.at });
  };

  // Privacy transitions remove decoded images immediately, without the sheet's exit animation.
  if (!shown) return null;
  const content = <>
    <div className="mb-2 flex items-center justify-between gap-2 px-3">
      <p className="text-xs text-muted">画面仅保存为封面，保留原视频。</p>
      <button type="button" onClick={close} aria-label="关闭封面选择" className="grid size-11 shrink-0 place-items-center"><XIcon size={22} /></button>
    </div>
    <button type="button" aria-label="使用当前画面" disabled={busy} onClick={capture}
      className="mx-3 mb-3 min-h-11 rounded-full bg-accent px-5 text-sm text-white disabled:opacity-50">{busy ? "正在保存…" : "使用当前画面"}</button>
    {error && <p role="alert" className="mb-3 px-3 text-sm text-accent">{error}</p>}
    <p className="mb-2 px-3 text-sm font-medium">或选择预览画面</p>
    {preview.state === "ready" && preview.frames.length > 0 ? <div className="grid grid-cols-2 gap-2 px-3">
      {preview.frames.map(frame => <button key={frame.index} type="button" disabled={busy} aria-label={`使用 ${clock(frame.at)} 的画面`}
        onClick={() => choosePreview(frame)} className="relative min-h-11 overflow-hidden rounded-lg bg-black disabled:opacity-50">
        <img ref={element => { if (element) images.current.set(frame.index, element); else images.current.delete(frame.index); }}
          src={frame.url} alt={`约 ${clock(frame.at)} 的画面`} className="aspect-video w-full object-contain" />
        <span className="absolute bottom-1 left-1 rounded bg-black/70 px-1 text-xs tabular-nums text-white">{clock(frame.at)}</span>
      </button>)}
    </div> : <p role="status" className="px-3 py-8 text-center text-sm text-muted">{preview.state === "unavailable" ? "预览暂不可用，仍可尝试当前画面。"
      : preview.exhausted ? "预览仍在排队，请稍后刷新。" : "正在准备 8 帧预览…"}</p>}
    {(preview.exhausted || preview.state === "unavailable") && <button type="button" disabled={busy} onClick={preview.refresh}
      className="mx-3 my-2 min-h-11 rounded-full bg-raised px-4 text-sm disabled:opacity-50">刷新预览</button>}
    <button type="button" aria-label="恢复默认封面" disabled={busy} onClick={() => void save()}
      className="mt-3 min-h-11 w-full rounded-lg px-4 text-left text-sm text-muted disabled:opacity-50">恢复默认封面</button>
  </>;
  return embedded ? content : <Sheet open onClose={close} title="选择封面">{content}</Sheet>;
}
