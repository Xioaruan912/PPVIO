import { CaretRightIcon, CheckCircleIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { api, type Status } from "../api";
import { toast } from "../ui/toast";
import { SettingsHeader, SettingsLine, SettingsSection } from "./shared";

function ago(seconds: number | null): string {
  if (!seconds) return "还没有";
  const minutes = Math.round((Date.now() / 1000 - seconds) / 60);
  return minutes < 1 ? "刚刚" : minutes < 60 ? `${minutes} 分钟前` : `${Math.round(minutes / 60)} 小时前`;
}

export function MaintenancePage({ status, watched, dupes, onWatchedChange, onDuplicates, onBack }: {
  status: Status | null;
  watched: { forget_after_days: number | null; choices: (number | null)[] } | null;
  dupes: number | null;
  onWatchedChange: (next: { forget_after_days: number | null; choices: (number | null)[] }) => void;
  onDuplicates: () => void;
  onBack: () => void;
}) {
  return (
    <div>
      <SettingsHeader title="片库维护与状态" subtitle="目录健康监控、看过重置与去重清理" onBack={onBack} />
      {status && (
        <SettingsSection title="目录与同步状态">
          {status.libraries.map(lib => (
            <div key={lib.root} className="flex items-center gap-3 px-4 py-3.5">
              {lib.reachable === false
                ? <WarningCircleIcon size={20} weight="fill" className="shrink-0 text-accent" />
                : <CheckCircleIcon size={20} weight="fill" className="shrink-0 text-ok" />}
              <span className="min-w-0 flex-1 truncate text-[15px] text-ink">{lib.root}</span>
              <span className={`text-[13px] ${lib.reachable === false ? "text-accent" : "text-muted"}`}>
                {lib.reachable === false ? "读不到，可能被移走了" : "正常"}
              </span>
            </div>
          ))}
          <SettingsLine label="活跃视频" value={status.scan?.active_videos != null ? `${status.scan.active_videos} 个` : "扫描中"} />
          <SettingsLine label="上次完整扫描" value={ago(status.scan?.last_full_at ?? null)} />
          {status.probe_pending > 0 && <SettingsLine label="正在读取时长" value={`还剩 ${status.probe_pending} 个`} />}
          <SettingsLine label="收藏备份" value={status.backup.failed ? `${status.backup.failed} 个失败` : status.backup.pending ? `${status.backup.pending} 个等待中` : "已同步"} warn={status.backup.failed > 0} />
        </SettingsSection>
      )}

      <SettingsSection title="片库策略与清理">
        {watched && (
          <label className="flex items-center justify-between gap-4 px-4 py-3.5">
            <span>
              <span className="block text-[15px] font-medium text-ink">看过的视频</span>
              <span className="mt-0.5 block text-[13px] leading-snug text-muted">多久后重新算作没看过，刷流时会再次推荐</span>
            </span>
            <select value={watched.forget_after_days ?? ""} className="h-9 rounded-[11px] border border-line bg-black/55 px-2.5 text-[14px] text-ink outline-none focus:border-gold/50"
              onChange={e => {
                const days = e.target.value === "" ? null : Number(e.target.value);
                void api.setWatched(days).then(() => onWatchedChange({ ...watched, forget_after_days: days })).catch(() => toast("保存失败"));
              }}>
              {watched.choices.map(c => <option key={String(c)} value={c ?? ""}>{c === null ? "永不" : `${c} 天`}</option>)}
            </select>
          </label>
        )}
        <button type="button" onClick={onDuplicates} className="flex w-full items-center justify-between px-4 py-3.5 text-left transition-colors hover:bg-white/[0.03] active:bg-white/[0.06]">
          <span>
            <span className="block text-[15px] font-medium text-ink">疑似重复</span>
            <span className="mt-0.5 block text-[13px] leading-snug text-muted">封面和时长几乎一样的视频，留一个删其余</span>
          </span>
          <span className="flex items-center gap-1.5 text-[14px] font-medium tabular-nums text-gold">
            {dupes ? `${dupes} 组` : "无重复"}<CaretRightIcon size={14} className="text-faint" />
          </span>
        </button>
      </SettingsSection>
    </div>
  );
}
