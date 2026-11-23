import { CaretDownIcon, CaretLeftIcon, CaretUpIcon, PlayIcon, TrashIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { clearQueue, moveQueue, removeFromQueue, useQueue } from "../queue";
import { usePrefs } from "../prefs";
import { Cover, formatDuration } from "../ui/Grid";
import { Sheet, SheetButton } from "../ui/Sheet";

export function Queue({ onBack, onPlay }: { onBack: () => void; onPlay: (ids: string[], index: number) => void }) {
  const items = useQueue(), prefs = usePrefs(); const [confirm, setConfirm] = useState(false);
  return <main className="mx-auto min-h-dvh max-w-3xl px-3.5 pb-24 pt-[max(1.25rem,env(safe-area-inset-top))]">
    <header className="mb-4 flex items-center gap-2.5 px-0.5"><button type="button" aria-label="返回片库" onClick={onBack} className="ios-card pressable grid size-10 shrink-0 place-items-center rounded-full text-ink"><CaretLeftIcon size={19} weight="bold" /></button><h1 className="flex-1 text-[26px] font-semibold tracking-[-0.03em] text-ink">待播队列 <span className="text-[14px] font-normal tabular-nums text-muted">{items.length}/100</span></h1><button type="button" disabled={!items.length} onClick={() => setConfirm(true)} className="ios-card pressable min-h-10 rounded-full px-3.5 text-[13px] font-medium text-muted disabled:opacity-40">清空</button></header>
    <p className="mb-4 px-1 text-sm text-muted">本浏览器保存。按顺序连续播放，也可以上下调整。</p>
    {!items.length && <p className="py-20 text-center text-muted">在片库卡片或播放器中加入想看的视频。</p>}
    {items.map((item, index) => <div key={item.id} className="ios-card mb-2 flex items-center gap-2 rounded-[16px] p-2">
      <button type="button" aria-label={`播放队列第 ${index + 1} 个视频`} onClick={() => onPlay(items.map(item => item.id), index)} className="pressable flex min-w-0 flex-1 items-center gap-3 text-left"><div className="aspect-video w-24 shrink-0 overflow-hidden rounded-[10px] bg-black ring-1 ring-white/[0.08]">{item.cover_url && <Cover src={item.cover_url} className={`size-full object-cover ${prefs.coverBlur ? "scale-110 blur-xl" : ""}`} />}</div><span className="text-sm"><span className="block font-medium text-ink">第 {index + 1} 个视频</span><span className="text-xs tabular-nums text-muted">{formatDuration(item.duration_seconds)}</span></span></button>
      <div className="flex"><button type="button" aria-label={`上移第 ${index + 1} 个视频`} disabled={index === 0} onClick={() => moveQueue(item.id, -1)} className="pressable grid size-9 place-items-center rounded-full hover:bg-white/[0.06] disabled:opacity-30"><CaretUpIcon size={17} /></button><button type="button" aria-label={`下移第 ${index + 1} 个视频`} disabled={index === items.length - 1} onClick={() => moveQueue(item.id, 1)} className="pressable grid size-9 place-items-center rounded-full hover:bg-white/[0.06] disabled:opacity-30"><CaretDownIcon size={17} /></button><button type="button" aria-label={`移出第 ${index + 1} 个视频`} onClick={() => removeFromQueue(item.id)} className="pressable grid size-9 place-items-center rounded-full text-muted hover:bg-white/[0.06]"><TrashIcon size={17} /></button></div>
    </div>)}
    {items.length > 0 && <button type="button" onClick={() => onPlay(items.map(item => item.id), 0)} className="pressable mx-auto mt-5 flex min-h-12 items-center gap-2 rounded-full bg-accent px-6 text-[15px] font-semibold text-white shadow-[0_8px_22px_rgba(255,69,58,0.3)]"><PlayIcon size={19} weight="fill" />从第一条播放</button>}
    <Sheet open={confirm} onClose={() => setConfirm(false)} title="清空待播队列？"><SheetButton danger onClick={() => { clearQueue(); setConfirm(false); }}>清空队列</SheetButton></Sheet>
  </main>;
}
