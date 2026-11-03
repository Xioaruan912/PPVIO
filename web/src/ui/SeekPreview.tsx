import { EyeIcon, PlayIcon, XIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import type { Media } from "../api";
import { useBackLayer } from "./navigation";
import { mediaTools, type Preview } from "../mediaTools";

export function useSeekPreview(id: string, enabled: boolean) {
  const [result, setResult] = useState<{ id: string; preview: Preview; exhausted?: boolean } | null>(null);
  const [request, setRequest] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const abort = new AbortController(); let timer: ReturnType<typeof setTimeout>, tries = 0;
    const load = async (prepare: boolean) => {
      try {
        const preview = await (prepare ? mediaTools.preparePreview(id, abort.signal) : mediaTools.preview(id, abort.signal));
        if (abort.signal.aborted) return;
        const exhausted = preview.state === "pending" && ++tries >= 40;
        setResult({ id, preview, exhausted });
        if (preview.state === "pending" && !exhausted) timer = setTimeout(() => void load(false), 1500);
      } catch { if (!abort.signal.aborted) setResult({ id, preview: { state: "unavailable", frames: [] } }); }
    };
    void load(true);
    return () => { abort.abort(); clearTimeout(timer); };
  }, [id, enabled, request]);
  return { ...(result?.id === id ? result.preview : { state: "pending" as const, frames: [] }), exhausted: result?.id === id && result.exhausted, refresh: () => setRequest(n => n + 1) };
}

export function clock(seconds: number) {
  const n = Math.max(0, Math.floor(seconds));
  return n >= 3600 ? `${Math.floor(n / 3600)}:${String(Math.floor(n / 60) % 60).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`
    : `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`;
}

export function SeekPreview({ id, time, enabled }: { id: string; time: number; enabled: boolean }) {
  const preview = useSeekPreview(id, enabled);
  if (!enabled) return null;
  const frame = preview?.frames.reduce<(NonNullable<Preview["frames"]>[number]) | undefined>((best, f) => !best || Math.abs(f.at - time) < Math.abs(best.at - time) ? f : best, undefined);
  return (
    <div className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-2 w-36 -translate-x-1/2 overflow-hidden rounded-lg bg-black/85 p-1 text-center text-xs text-white" role="status" aria-label="目标时间">
      {frame && <img src={frame.url} alt="目标位置附近的画面" className="aspect-video w-full rounded object-contain" />}
      <span className="block py-1 tabular-nums">{clock(time)}</span>
      {!frame && <span className="block pb-1 text-[10px] text-white/65">{preview?.state === "unavailable" ? "画面预览暂不可用" : preview.exhausted ? "仍在生成，请稍后重试" : "正在生成画面预览…"}</span>}
    </div>
  );
}

export function PreviewButton({ media, onPlay }: { media: Media; onPlay?: (at: number) => void }) {
  const [open, setOpen] = useState(false);
  const preview = useSeekPreview(media.id, open);
  useBackLayer(open, () => setOpen(false));
  useEffect(() => {
    if (!open) return;
    const abort = new AbortController();
    const close = () => setOpen(false);
    const hidden = () => { if (document.hidden) close(); };
    document.addEventListener("visibilitychange", hidden, { signal: abort.signal });
    return () => abort.abort();
  }, [open]);
  return <>
    <button type="button" onClick={() => setOpen(true)} aria-label="预览画面" className="absolute right-1 top-1 grid size-8 place-items-center rounded-full bg-black/60 text-white"><EyeIcon size={17} /></button>
    {open && <div role="dialog" aria-modal="true" aria-label="画面预览" className="fixed inset-0 z-40 flex items-center justify-center bg-black/75 p-4" onClick={() => setOpen(false)}>
      <div className="max-h-[85dvh] w-full max-w-lg overflow-auto rounded-2xl bg-surface p-3 text-ink" onClick={event => event.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between"><h2 className="px-2 font-semibold">画面预览</h2><button type="button" onClick={() => setOpen(false)} aria-label="关闭预览" className="grid size-10 place-items-center"><XIcon size={22} /></button></div>
        {preview?.state === "ready" ? <div className="grid grid-cols-2 gap-2">{preview.frames.map(frame => <button key={frame.index} type="button" onClick={() => { setOpen(false); onPlay?.(frame.at); }} className="relative overflow-hidden rounded-lg bg-black" aria-label={`从 ${clock(frame.at)} 播放`}>
          <img src={frame.url} alt={`约 ${clock(frame.at)} 的画面`} className="aspect-video w-full object-contain" />
          <span className="absolute bottom-1 left-1 flex items-center gap-1 rounded bg-black/70 px-1 text-xs text-white"><PlayIcon size={12} />{clock(frame.at)}</span>
        </button>)}</div> : <p className="px-3 py-12 text-center text-sm text-muted" role="status">{preview?.state === "unavailable" ? "暂时无法生成预览，仍可正常播放视频" : preview.exhausted ? "预览仍在排队或生成，可稍后刷新" : "正在生成画面预览，首次需要稍等…"}</p>}
        {(preview.exhausted || preview.state === "unavailable") && <button type="button" onClick={preview.refresh} className="mx-auto mb-4 block rounded-full bg-raised px-5 py-3 text-sm">刷新预览</button>}
      </div>
    </div>}
  </>;
}
