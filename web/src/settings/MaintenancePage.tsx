import { CaretRightIcon, CheckCircleIcon, HardDriveIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { api, type CacheStats, type Status } from "../api";
import { toast } from "../ui/toast";
import { GlassSelect } from "../ui/Skeleton";
import { SettingsHeader, SettingsLine, SettingsSection } from "./shared";

function formatBytes(bytes: number | undefined): string {
  if (!bytes || !Number.isFinite(bytes)) return "0 MB";
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
}

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
  const [cache, setCache] = useState<CacheStats | null>(null);
  useEffect(() => { void api.cacheStats().then(setCache).catch(() => undefined); }, []);
  const pct = cache?.bytes && cache?.max_bytes ? Math.min(100, Math.round((cache.bytes / cache.max_bytes) * 100)) : 0;
  return (
    <div>
      <SettingsHeader title="片库维护与状态" subtitle="目录健康监控、缓存占用、看过重置与去重" onBack={onBack} />
      {cache?.available && (
        <div className="luxury-card mb-5 rounded-[22px] p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <span className="grid size-10 shrink-0 place-items-center rounded-[13px] bg-gold-soft text-gold-bright">
                <HardDriveIcon size={20} weight="fill" />
              </span>
              <div>
                <p className="text-[14px] font-semibold text-ink">本机磁盘流式缓存</p>
                <p className="text-[12px] tabular-nums text-muted">
                  已用 {formatBytes(cache.bytes)} / {formatBytes(cache.max_bytes)} · {cache.chunks ?? 0} 个分片
                </p>
              </div>
            </div>
            <span className="text-[14px] font-semibold tabular-nums text-gold-bright">{pct}%</span>
          </div>
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-ink/10">
            <div className="h-full rounded-full bg-gold transition-all duration-500" style={{ width: `${pct}%` }} />
          </div>
        </div>
      )}
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
          <div className="flex items-center justify-between gap-4 px-4 py-3.5">
            <span>
              <span className="block text-[15px] font-medium text-ink">看过的视频</span>
              <span className="mt-0.5 block text-[13px] leading-snug text-muted">多久后重新算作没看过，刷流时会再次推荐</span>
            </span>
            <GlassSelect label="看过的视频" value={String(watched.forget_after_days ?? "")}
              options={watched.choices.map(c => ({ value: String(c ?? ""), label: c === null ? "永不" : `${c} 天` }))}
              onChange={val => {
                const days = val === "" ? null : Number(val);
                void api.setWatched(days).then(() => onWatchedChange({ ...watched, forget_after_days: days })).catch(() => toast("保存失败"));
              }} className="w-28 shrink-0" />
          </div>
        )}
        <button type="button" onClick={onDuplicates} className="flex w-full items-center justify-between px-4 py-3.5 text-left transition-colors hover:bg-ink/[0.025] active:bg-ink/[0.05]">
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
