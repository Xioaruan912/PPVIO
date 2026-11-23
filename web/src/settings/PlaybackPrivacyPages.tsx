import { EyeClosedIcon, FilmStripIcon, LightningIcon, ShieldCheckIcon } from "@phosphor-icons/react";
import { api } from "../api";
import { usePrefs } from "../prefs";
import { toast } from "../ui/toast";
import { IosSwitch, PrefToggle, SettingsHeader, SettingsSection } from "./shared";

export function PlaybackPage({ mode, onModeChange, onBack }: {
  mode: { mode: "webdav" | "direct"; direct_available: boolean } | null;
  onModeChange: (next: { mode: "webdav" | "direct"; direct_available: boolean }) => void;
  onBack: () => void;
}) {
  const prefs = usePrefs();
  return (
    <div>
      <SettingsHeader title="播放与画质引擎" subtitle="起播策略、流式传输与带宽偏好" onBack={onBack} />
      <div className="luxury-card mb-5 flex items-center gap-3.5 rounded-[22px] p-4">
        <span className="grid size-11 shrink-0 place-items-center rounded-[14px] bg-gold-soft text-gold-bright">
          {mode?.mode === "direct" ? <LightningIcon size={22} weight="fill" /> : <FilmStripIcon size={22} weight="fill" />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[14px] font-semibold text-ink">当前策略：{prefs.lowRes ? "480p 极速起播" : "原画直出"}</p>
          <p className="mt-0.5 text-[12px] text-muted">
            {mode?.direct_available ? (mode.mode === "direct" ? "已启用 115 直连高速通道" : "当前走 OpenList WebDAV 中转") : "标准 WebDAV 流式读取"}
          </p>
        </div>
      </div>

      <SettingsSection title="画质与传输">
        <PrefToggle pref="lowRes" title="低清优先" hint="有 480p 副本时优先起播，缓存与拖动响应更快" />
        {mode?.direct_available && (
          <label className="flex cursor-pointer items-center justify-between gap-4 px-4 py-3.5 transition-colors hover:bg-white/[0.025]">
            <span>
              <span className="block text-[15px] font-medium text-ink">115 直连</span>
              <span className="mt-0.5 block text-[13px] leading-snug text-muted">直接从 115 获取视频流，通常更快；如遇网络异常可关掉改走网盘</span>
            </span>
            <IosSwitch checked={mode.mode === "direct"} onChange={checked => {
              const next = checked ? "direct" : "webdav";
              void api.setReadMode(next).then(() => onModeChange({ ...mode, mode: next })).catch(() => toast("切换失败"));
            }} />
          </label>
        )}
      </SettingsSection>
    </div>
  );
}

export function PrivacyPage({ onBack }: { onBack: () => void }) {
  const prefs = usePrefs();
  return (
    <div>
      <SettingsHeader title="隐私与安全防护" subtitle="防窥模糊、后台遮屏与本地会话保护" onBack={onBack} />
      <div className="luxury-card mb-5 flex items-center gap-3.5 rounded-[22px] p-4">
        <span className="grid size-11 shrink-0 place-items-center rounded-[14px] bg-ok/16 text-ok">
          {prefs.privacyLock ? <ShieldCheckIcon size={23} weight="fill" /> : <EyeClosedIcon size={23} weight="fill" />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[14px] font-semibold text-ink">
            {prefs.coverBlur && prefs.privacyLock ? "双重隐私保护已开启" : prefs.coverBlur || prefs.privacyLock ? "部分隐私保护已开启" : "当前未启用防窥保护"}
          </p>
          <p className="mt-0.5 text-[12px] text-muted">片库封面模糊与切后台自动遮屏均保存在本机浏览器。</p>
        </div>
      </div>

      <SettingsSection title="视觉与离开防护">
        <PrefToggle pref="coverBlur" title="封面模糊" hint="片库、标签和历史里的封面默认高斯模糊，点顶部眼睛图标临时显示" />
        <PrefToggle pref="privacyLock" title="离开时遮住画面" hint="一分钟无操作或切到后台时自动盖住画面并暂停播放；观看长视频时不会触发" />
      </SettingsSection>
    </div>
  );
}
