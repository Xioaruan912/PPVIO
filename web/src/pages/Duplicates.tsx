import { CaretLeftIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { api, type Media } from "../api";
import { BlurToggle, formatDuration } from "../ui/Grid";
import { usePrefs } from "../prefs";
import { toast } from "../ui/toast";
import { Empty } from "./Library";

const size = (bytes: number | null | undefined) => bytes ? `${(bytes / 1024 / 1024).toFixed(bytes > 1e9 ? 0 : 1)} MB` : "";

/** 疑似重复: keep one copy and delete the rest, or say they are not the same. */
export function Duplicates({ onClose }: { onClose: () => void }) {
  const prefs = usePrefs();
  const [groups, setGroups] = useState<Media[][] | null>(null);
  useEffect(() => { void api.duplicates().then(d => setGroups(d.groups.map(g => g.items))).catch(() => setGroups([])); }, []);

  const keep = async (group: Media[], kept: Media) => {
    const others = group.filter(item => item.id !== kept.id);
    setGroups(list => list?.filter(g => g !== group) ?? null);
    const removed: string[] = [];
    for (const item of others) {
      try { await api.remove(item.id); removed.push(item.id); } catch { /* reported below */ }
    }
    if (removed.length < others.length) toast("有的没删掉，稍后再试");
    else toast(`已删除 ${removed.length} 个`, { label: "撤销", run: () => {
      void Promise.all(removed.map(id => api.restore(id))).then(() => setGroups(list => [group, ...(list ?? [])]));
    } }, 6000);
  };
  const dismiss = (group: Media[]) => {
    setGroups(list => list?.filter(g => g !== group) ?? null);
    void api.dismissDuplicates(group.map(item => item.id)).catch(() => toast("操作失败"));
  };

  return (
    <div className="fixed inset-0 z-30 overflow-y-auto bg-bg">
      <main className="mx-auto max-w-3xl px-3.5 pb-16 pt-[max(1.25rem,env(safe-area-inset-top))]">
        <header className="mb-4 flex items-center gap-2.5 px-0.5">
          <button type="button" onClick={onClose} aria-label="返回" className="ios-card pressable grid size-10 shrink-0 place-items-center rounded-full text-ink"><CaretLeftIcon size={19} weight="bold" /></button>
          <h1 className="flex-1 text-[26px] font-semibold tracking-[-0.03em] text-ink">疑似重复</h1>
          <BlurToggle />
        </header>
        <p className="mb-5 px-1 text-[13px] leading-relaxed text-muted">封面和时长几乎一样的视频。点「保留这个」会删除同组其他的（网盘文件也删），6 秒内可撤销。</p>
        {groups === null ? <Empty>正在比对…</Empty> : !groups.length ? <Empty>没有疑似重复的视频</Empty> : groups.map((group, index) => (
          <section key={group.map(m => m.id).join()} className="ios-card mb-4 rounded-[20px] p-3.5">
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
              {group.map(item => (
                <div key={item.id} className="flex flex-col gap-2">
                  <div className="relative aspect-[3/4] overflow-hidden rounded-[12px] bg-raised ring-1 ring-white/[0.08]">
                    {item.cover_url && <img src={item.cover_url} alt="" loading="lazy" className={`size-full object-cover ${prefs.coverBlur ? "scale-110 blur-xl" : ""}`} />}
                    <span className="absolute bottom-1.5 right-1.5 rounded-md bg-black/55 px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-white backdrop-blur-sm">{formatDuration(item.duration_seconds)}</span>
                  </div>
                  <span className="text-[12px] tabular-nums text-muted">{item.width}×{item.height} · {size(item.size_bytes)}</span>
                  <button type="button" onClick={() => void keep(group, item)} className="pressable h-9 rounded-full bg-raised text-[13px] font-semibold text-ink hover:bg-ink/10">保留这个</button>
                </div>
              ))}
            </div>
            <button type="button" onClick={() => dismiss(group)} className="pressable mt-3 h-9 w-full rounded-full text-[13px] text-muted hover:bg-ink/[0.04]">不是重复（第 {index + 1} 组）</button>
          </section>
        ))}
      </main>
    </div>
  );
}
