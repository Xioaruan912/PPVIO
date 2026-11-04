import { CaretDownIcon, CaretLeftIcon, CaretUpIcon, PlayIcon, TrashIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { clearQueue, moveQueue, removeFromQueue, useQueue } from "../queue";
import { usePrefs } from "../prefs";
import { Cover, formatDuration } from "../ui/Grid";
import { Sheet, SheetButton } from "../ui/Sheet";

export function Queue({ onBack, onPlay }: { onBack: () => void; onPlay: (ids: string[], index: number) => void }) {
  const items = useQueue(), prefs = usePrefs(); const [confirm, setConfirm] = useState(false);
  return <main className="mx-auto min-h-dvh max-w-3xl px-3 pb-24 pt-[max(1rem,env(safe-area-inset-top))]">
    <header className="mb-4 flex items-center gap-2"><button type="button" aria-label="返回片库" onClick={onBack} className="grid size-11 place-items-center"><CaretLeftIcon size={22} /></button><h1 className="flex-1 text-2xl font-semibold">待播队列 <span className="text-sm text-muted">{items.length}/100</span></h1><button type="button" disabled={!items.length} onClick={() => setConfirm(true)} className="min-h-11 px-3 text-sm text-muted disabled:opacity-40">清空</button></header>
    <p className="mb-4 px-2 text-sm text-muted">本浏览器保存。按顺序连续播放，也可以上下调整。</p>
    {!items.length && <p className="py-20 text-center text-muted">在片库卡片或播放器中加入想看的视频。</p>}
    {items.map((item, index) => <div key={item.id} className="mb-2 flex items-center gap-2 rounded-xl bg-surface p-2">
      <button type="button" aria-label={`播放队列第 ${index + 1} 个视频`} onClick={() => onPlay(items.map(item => item.id), index)} className="flex min-w-0 flex-1 items-center gap-3 text-left"><div className="aspect-video w-24 shrink-0 overflow-hidden rounded-lg bg-black">{item.cover_url && <Cover src={item.cover_url} className={`size-full object-cover ${prefs.coverBlur ? "scale-110 blur-xl" : ""}`} />}</div><span className="text-sm"><span className="block">第 {index + 1} 个视频</span><span className="text-muted">{formatDuration(item.duration_seconds)}</span></span></button>
      <div className="flex"><button type="button" aria-label={`上移第 ${index + 1} 个视频`} disabled={index === 0} onClick={() => moveQueue(item.id, -1)} className="grid size-10 place-items-center disabled:opacity-30"><CaretUpIcon size={18} /></button><button type="button" aria-label={`下移第 ${index + 1} 个视频`} disabled={index === items.length - 1} onClick={() => moveQueue(item.id, 1)} className="grid size-10 place-items-center disabled:opacity-30"><CaretDownIcon size={18} /></button><button type="button" aria-label={`移出第 ${index + 1} 个视频`} onClick={() => removeFromQueue(item.id)} className="grid size-10 place-items-center text-muted"><TrashIcon size={18} /></button></div>
    </div>)}
    {items.length > 0 && <button type="button" onClick={() => onPlay(items.map(item => item.id), 0)} className="mx-auto mt-5 flex min-h-12 items-center gap-2 rounded-full bg-accent px-6 text-white"><PlayIcon size={20} weight="fill" />从第一条播放</button>}
    <Sheet open={confirm} onClose={() => setConfirm(false)} title="清空待播队列？"><SheetButton danger onClick={() => { clearQueue(); setConfirm(false); }}>清空队列</SheetButton></Sheet>
  </main>;
}
