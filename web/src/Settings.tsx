import {
  CloudIcon, FilmSlateIcon, HardDrivesIcon, ShieldCheckIcon, SignOutIcon, SparkleIcon,
} from "@phosphor-icons/react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { api, type Status, type StorageSettings } from "./api";
import { usePrefs } from "./prefs";
import { useBackLayer } from "./ui/navigation";
import { SPRING_STAGE, SPRING_TAP } from "./ui/motion";
import { normalizeFolder, PrefToggle, SettingsNavRow, SettingsSection } from "./settings/shared";
import { StoragePage } from "./settings/StoragePage";
import { PlaybackPage, PrivacyPage } from "./settings/PlaybackPrivacyPages";
import { MaintenancePage } from "./settings/MaintenancePage";

export { normalizeFolder };

type Subpage = "hub" | "storage" | "playback" | "privacy" | "maintenance";

export function Settings({ onLoggedOut, onDuplicates }: { onLoggedOut: () => void; onDuplicates: () => void }) {
  const prefs = usePrefs();
  const [page, setPage] = useState<Subpage>("hub");
  const [storage, setStorage] = useState<StorageSettings | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [mode, setMode] = useState<{ mode: "webdav" | "direct"; direct_available: boolean } | null>(null);
  const [watched, setWatched] = useState<{ forget_after_days: number | null; choices: (number | null)[] } | null>(null);
  const [dupes, setDupes] = useState<number | null>(null);

  useBackLayer(page !== "hub", () => setPage("hub"));

  useEffect(() => {
    void api.storage().then(setStorage).catch(() => undefined);
    void api.status().then(setStatus).catch(() => undefined);
    void api.readMode().then(setMode).catch(() => undefined);
    void api.watched().then(setWatched).catch(() => undefined);
    void api.duplicates().then(d => setDupes(d.total)).catch(() => undefined);
  }, []);

  const unreachable = status?.libraries.some(lib => lib.reachable === false) ?? false;
  const folderCount = storage?.libraries.length ?? 0;

  const openPage = (next: Subpage) => {
    setPage(next);
    window.scrollTo({ top: 0, behavior: "instant" });
  };

  return (
    <main className="mx-auto min-h-dvh max-w-xl overflow-x-clip px-4 pb-32 pt-[max(1.25rem,env(safe-area-inset-top))]">
      <AnimatePresence mode="popLayout" initial={false}>
        {page === "hub" ? (
          <motion.div key="hub"
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0, transition: SPRING_STAGE }}
            exit={{ opacity: 0, x: -16, transition: { duration: 0.16, ease: "easeOut" } }}>
            <h1 className="px-1 text-[32px] font-semibold leading-tight tracking-[-0.035em] text-ink">设置</h1>

            {/* Cinema System Overview Hero Card */}
            <section className="luxury-card sheen-overlay mt-4 rounded-[26px] p-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-gold/30 bg-gold/14 px-2.5 py-0.5 text-[11px] font-semibold tracking-wide text-gold-bright">
                    <SparkleIcon size={12} weight="fill" />PPVIO 私人影院
                  </span>
                  <p className="mt-2.5 text-[28px] font-semibold leading-none tracking-[-0.03em] tabular-nums text-ink">
                    {status?.scan?.active_videos != null ? `${status.scan.active_videos}` : "—"}
                    <span className="ml-1.5 text-[14px] font-normal text-muted">部视频</span>
                  </p>
                </div>
                <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[12px] font-medium ${unreachable ? "bg-accent-soft text-accent" : "bg-ok/16 text-ok"}`}>
                  <span className={`size-1.5 rounded-full ${unreachable ? "bg-accent" : "bg-ok shadow-[0_0_8px_rgba(48,209,88,0.8)]"}`} />
                  {unreachable ? "目录异常" : "服务正常"}
                </span>
              </div>
              <div className="mt-4 grid grid-cols-3 gap-2">
                <div className="rounded-[14px] border border-white/[0.07] bg-black/35 px-3 py-2">
                  <span className="block text-[11px] text-faint">传输通道</span>
                  <span className="mt-0.5 block truncate text-[13px] font-semibold text-ink">
                    {mode?.mode === "direct" ? "115 直连" : "WebDAV"}
                  </span>
                </div>
                <div className="rounded-[14px] border border-white/[0.07] bg-black/35 px-3 py-2">
                  <span className="block text-[11px] text-faint">起播画质</span>
                  <span className="mt-0.5 block truncate text-[13px] font-semibold text-gold-bright">
                    {prefs.lowRes ? "480p 优先" : "原画直出"}
                  </span>
                </div>
                <div className="rounded-[14px] border border-white/[0.07] bg-black/35 px-3 py-2">
                  <span className="block text-[11px] text-faint">隐私防窥</span>
                  <span className="mt-0.5 block truncate text-[13px] font-semibold text-ink">
                    {prefs.coverBlur && prefs.privacyLock ? "双重开启" : prefs.coverBlur || prefs.privacyLock ? "已开启" : "已关闭"}
                  </span>
                </div>
              </div>
            </section>

            {/* Quick Controls */}
            <SettingsSection title="常用快捷开关">
              <PrefToggle pref="coverBlur" title="封面模糊" hint="片库与标签封面默认模糊防窥" />
              <PrefToggle pref="lowRes" title="低清优先" hint="有 480p 副本时优先起播，滑动更顺" />
            </SettingsSection>

            {/* Dedicated Component Sub-pages */}
            <SettingsSection title="组件与系统设置">
              <SettingsNavRow
                icon={<CloudIcon size={20} weight="fill" />}
                iconTone="bg-sky-500/18 text-sky-300 border border-sky-400/20"
                title="网盘与视频目录"
                subtitle="WebDAV 地址、账号凭据与媒体文件夹"
                value={folderCount ? `${folderCount} 个目录` : "未配置"}
                onClick={() => openPage("storage")}
              />
              <SettingsNavRow
                icon={<FilmSlateIcon size={20} weight="fill" />}
                iconTone="bg-gold-soft text-gold-bright border border-gold/25"
                title="播放与画质引擎"
                subtitle="起播画质偏好、115 直连通道设置"
                value={mode?.mode === "direct" ? "115 直连" : "WebDAV"}
                onClick={() => openPage("playback")}
              />
              <SettingsNavRow
                icon={<ShieldCheckIcon size={20} weight="fill" />}
                iconTone="bg-ok/16 text-ok border border-ok/25"
                title="隐私与安全防护"
                subtitle="封面模糊、离开与切后台自动遮屏"
                value={prefs.privacyLock ? "已防护" : "基础"}
                onClick={() => openPage("privacy")}
              />
              <SettingsNavRow
                icon={<HardDrivesIcon size={20} weight="fill" />}
                iconTone="bg-purple-500/18 text-purple-300 border border-purple-400/20"
                title="片库维护与状态"
                subtitle="扫描健康度、看过重置周期、疑似重复"
                value={dupes ? `${dupes} 组重复` : unreachable ? "需检查" : "健康"}
                warn={unreachable}
                onClick={() => openPage("maintenance")}
              />
            </SettingsSection>

            <motion.button type="button" whileTap={{ scale: 0.97 }} transition={SPRING_TAP}
              className="ios-card mt-7 flex h-12 w-full items-center justify-center gap-2 rounded-full text-[15px] font-medium text-accent hover:border-accent/35"
              onClick={() => void api.logout().finally(onLoggedOut)}>
              <SignOutIcon size={18} weight="bold" />退出登录
            </motion.button>
          </motion.div>
        ) : (
          <motion.div key={page}
            initial={{ opacity: 0, x: 28 }}
            animate={{ opacity: 1, x: 0, transition: SPRING_STAGE }}
            exit={{ opacity: 0, x: 20, transition: { duration: 0.16, ease: "easeOut" } }}>
            {page === "storage" && <StoragePage onBack={() => openPage("hub")} onSaved={setStorage} />}
            {page === "playback" && <PlaybackPage mode={mode} onModeChange={setMode} onBack={() => openPage("hub")} />}
            {page === "privacy" && <PrivacyPage onBack={() => openPage("hub")} />}
            {page === "maintenance" && (
              <MaintenancePage status={status} watched={watched} dupes={dupes}
                onWatchedChange={setWatched} onDuplicates={onDuplicates} onBack={() => openPage("hub")} />
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </main>
  );
}
