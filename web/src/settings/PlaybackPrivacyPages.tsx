import { EyeClosedIcon, FilmStripIcon, LightningIcon, ShieldCheckIcon, ShieldWarningIcon } from "@phosphor-icons/react";
import { api } from "../api";
import { setPref, usePrefs, type PanicDecoy } from "../prefs";
import { toast } from "../ui/toast";
import { triggerPanic } from "../ui/privacy";
import { GlassSelect } from "../ui/Skeleton";
import { IosSwitch, PrefToggle, SettingsHeader, SettingsSection } from "./shared";

const STEALTH_TITLES = [
  { value: "", label: "不伪装（PPVIO）" },
  { value: "备忘录", label: "备忘录" },
  { value: "文件", label: "文件" },
  { value: "日历", label: "日历" },
  { value: "学习笔记", label: "学习笔记" },
] as const;

const DECOY_MODES = [
  { value: "notes", label: "备忘录伪装页" },
  { value: "clock", label: "极简待机时钟" },
] as const;

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
          <label className="flex cursor-pointer items-center justify-between gap-4 px-4 py-3.5 transition-colors hover:bg-ink/[0.025]">
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
        <PrefToggle pref="peekOnHold" title="按住 / 悬停偷看单张封面" hint="模糊模式下长按或鼠标悬停单张卡片临时清晰，松手立即恢复模糊" />
        <PrefToggle pref="privacyLock" title="离开时遮住画面" hint="一分钟无操作或切到后台时自动切换伪装页并暂停播放" />
      </SettingsSection>

      <SettingsSection title="防社死伪装与紧急遮屏">
        <div className="flex items-center justify-between gap-4 px-4 py-3.5">
          <span>
            <span className="block text-[15px] font-medium text-ink">标签页标题伪装</span>
            <span className="mt-0.5 block text-[13px] leading-snug text-muted">替换浏览器标签名与图标，同步脱敏锁屏媒体卡片</span>
          </span>
          <GlassSelect label="标签页标题伪装" value={prefs.stealthTitle} options={STEALTH_TITLES}
            onChange={val => setPref("stealthTitle", val)} className="w-36 shrink-0" />
        </div>
        <div className="flex items-center justify-between gap-4 px-4 py-3.5">
          <span>
            <span className="block text-[15px] font-medium text-ink">紧急遮屏伪装样式</span>
            <span className="mt-0.5 block text-[13px] leading-snug text-muted">支持手机双指轻点、电脑 Shift+H 或双击 Esc 秒切</span>
          </span>
          <GlassSelect label="紧急遮屏伪装样式" value={prefs.panicDecoy} options={DECOY_MODES}
            onChange={val => setPref("panicDecoy", val as PanicDecoy)} className="w-36 shrink-0" />
        </div>
        <div className="px-4 py-3.5">
          <button type="button" onClick={triggerPanic}
            className="ios-card pressable flex h-11 w-full items-center justify-center gap-2 rounded-full text-[14px] font-semibold text-gold-bright hover:border-gold/40">
            <ShieldWarningIcon size={18} weight="fill" />立即测试紧急伪装遮屏
          </button>
        </div>
      </SettingsSection>
    </div>
  );
}
