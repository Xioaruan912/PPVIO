import { CaretLeftIcon, CaretRightIcon, SignOutIcon } from "@phosphor-icons/react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { api, type Status } from "./api";
import { usePrefs } from "./prefs";
import { useTasteProfile } from "./ratings";
import { SPRING_PILL } from "./ui/motion";
import { IosSwitch, normalizeFolder, PrefToggle, SettingsSection } from "./settings/shared";
import { StoragePage } from "./settings/StoragePage";
import { MaintenancePage } from "./settings/MaintenancePage";
import { haptic } from "./ui/haptics";
import { toast } from "./ui/toast";

export { normalizeFolder };

type Chapter = "general" | "storage" | "maintenance";
const CHAPTERS: readonly [Chapter, string][] = [
  ["general", "播放与隐私"],
  ["storage", "网盘目录"],
  ["maintenance", "片库维护"],
];

/**
 * Pure 3-Chapter Settings Folio:
 * 1. 播放与隐私 (Overview metrics + 115 direct / 480p / Cover blur / Idle lock + Logout)
 * 2. 网盘目录 (WebDAV & library roots)
 * 3. 片库维护 (Status, cache, watched window, duplicates)
 */
export function Settings({ onLoggedOut, onDuplicates }: { onLoggedOut: () => void; onDuplicates: () => void }) {
  const prefs = usePrefs();
  const taste = useTasteProfile();
  const [page, setPage] = useState<Chapter>("general");
  const [dir, setDir] = useState<1 | -1>(1);
  const [status, setStatus] = useState<Status | null>(null);
  const [mode, setMode] = useState<{ mode: "webdav" | "direct"; direct_available: boolean } | null>(null);
  const [watched, setWatched] = useState<{ forget_after_days: number | null; choices: (number | null)[] } | null>(null);
  const [dupes, setDupes] = useState<number | null>(null);

  useEffect(() => {
    void api.status().then(setStatus).catch(() => undefined);
    void api.readMode().then(setMode).catch(() => undefined);
    void api.watched().then(setWatched).catch(() => undefined);
    void api.duplicates().then(d => setDupes(d.total)).catch(() => undefined);
  }, []);

  const currentIdx = CHAPTERS.findIndex(([k]) => k === page);
  const goTo = (next: Chapter) => {
    const nextIdx = CHAPTERS.findIndex(([k]) => k === next);
    if (nextIdx === currentIdx) return;
    haptic(6);
    setDir(nextIdx > currentIdx ? 1 : -1);
    setPage(next);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        e.metaKey || e.ctrlKey || e.altKey
        || e.target instanceof HTMLInputElement
        || e.target instanceof HTMLTextAreaElement
        || e.target instanceof HTMLSelectElement
      ) return;
      if (e.key === "ArrowRight" && currentIdx < CHAPTERS.length - 1) {
        e.preventDefault();
        goTo(CHAPTERS[currentIdx + 1][0]);
      } else if (e.key === "ArrowLeft" && currentIdx > 0) {
        e.preventDefault();
        goTo(CHAPTERS[currentIdx - 1][0]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [currentIdx]);

  return (
    <main className="mx-auto flex h-full w-full max-w-4xl flex-col overflow-hidden px-4 pb-[max(0.85rem,env(safe-area-inset-bottom))] pt-3 sm:px-8 sm:pb-5 sm:pt-5">
      <header className="mb-4 flex shrink-0 flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-[22px] font-semibold leading-none tracking-[-0.03em] text-ink sm:text-[28px]">设置</h1>
        <div className="flex w-full items-center justify-between gap-1 rounded-full border border-line bg-surface p-1 shadow-[0_2px_10px_-4px_rgba(20,22,25,0.06)] sm:w-auto" role="tablist">
          {CHAPTERS.map(([key, label]) => {
            const active = page === key;
            return (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => goTo(key)}
                className={`relative h-8.5 flex-1 rounded-full px-3.5 text-[13.5px] transition-colors sm:h-9 sm:flex-none sm:px-4 sm:text-[14px] ${
                  active ? "font-semibold text-white" : "text-muted hover:text-ink"
                }`}
              >
                {active && (
                  <motion.span
                    layoutId="ppvio-settings-chapter"
                    transition={SPRING_PILL}
                    className="absolute inset-0 rounded-full bg-gold"
                  />
                )}
                <span className="relative z-10 whitespace-nowrap">{label}</span>
              </button>
            );
          })}
        </div>
      </header>

      <div className="relative min-h-0 flex-1 overflow-y-auto pr-1 [scrollbar-width:none]">
        <AnimatePresence mode="wait" initial={false}>
          {page === "general" && (
            <motion.div
              key="general"
              initial={{ opacity: 0, x: dir * 18 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: dir * -14 }}
              transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
              className="space-y-5"
            >
              <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <MetricBlock label="片库规模" value={status?.scan?.active_videos != null ? String(status.scan.active_videos) : "—"} />
                <MetricBlock label="已评影片" value={String(taste.rated_count)} accent={taste.active} />
                <MetricBlock label="传输通道" value={mode?.mode === "direct" ? "115 直连" : "WebDAV"} />
                <MetricBlock label="起播画质" value={prefs.lowRes ? "480P 优先" : "原画直出"} />
              </section>

              <SettingsSection title="播放与传输">
                <PrefToggle pref="lowRes" title="480P 极速起播" hint="优先播放轻量化副本，滑切更流畅" />
                {mode?.direct_available && (
                  <label className="flex cursor-pointer items-center justify-between gap-4 px-4 py-3.5 transition-colors hover:bg-ink/[0.025]">
                    <span>
                      <span className="block text-[15px] font-medium text-ink">115 直连</span>
                      <span className="mt-0.5 block text-[13px] leading-snug text-muted">跳过网盘代理直连取流，起播与拖动更快</span>
                    </span>
                    <IosSwitch
                      checked={mode.mode === "direct"}
                      onChange={checked => {
                        const next = checked ? "direct" : "webdav";
                        void api.setReadMode(next).then(() => setMode({ ...mode, mode: next })).catch(() => toast("切换失败"));
                      }}
                    />
                  </label>
                )}
              </SettingsSection>

              <SettingsSection title="隐私防护">
                <PrefToggle pref="coverBlur" title="封面防窥" hint="片库与标签封面默认模糊，点顶栏眼睛随时切换" />
                <PrefToggle pref="peekOnHold" title="按住 / 悬停偷看封面" hint="模糊模式下长按或悬停单张临时清晰" />
                <PrefToggle pref="privacyLock" title="离开自动遮屏" hint="切到后台或静置一分钟自动暂停并遮住画面" />
              </SettingsSection>

              <div className="flex justify-end pt-1">
                <button
                  type="button"
                  onClick={() => void api.logout().finally(onLoggedOut)}
                  className="inline-flex h-10 items-center gap-2 rounded-full border border-accent/40 px-5 text-[14px] font-medium text-accent hover:bg-accent/12"
                >
                  <SignOutIcon size={16} />退出登录
                </button>
              </div>
            </motion.div>
          )}

          {page === "storage" && (
            <motion.div key="storage" initial={{ opacity: 0, x: dir * 18 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: dir * -14 }} transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}>
              <StoragePage onBack={() => goTo("general")} />
            </motion.div>
          )}

          {page === "maintenance" && (
            <motion.div key="maintenance" initial={{ opacity: 0, x: dir * 18 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: dir * -14 }} transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}>
              <MaintenancePage
                status={status}
                watched={watched}
                onWatchedChange={setWatched}
                dupes={dupes}
                onDuplicates={onDuplicates}
                onBack={() => goTo("general")}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <footer className="mt-3 flex shrink-0 items-center justify-between gap-4 border-t border-line pt-3">
        <div className="flex flex-1 items-center gap-2.5 max-w-xs">
          {CHAPTERS.map(([key, label], i) => {
            const active = i === currentIdx;
            return (
              <button key={key} type="button" onClick={() => goTo(key)} className="group flex flex-1 flex-col gap-1.5 text-left">
                <span className={`tabular-nums text-[13px] transition-colors ${active ? "font-semibold text-gold" : "text-faint group-hover:text-muted"}`}>
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span className={`block h-[2px] w-full rounded-full transition-colors ${active ? "bg-gold" : "bg-ink/12 group-hover:bg-ink/25"}`} />
                <span className="sr-only">{label}</span>
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-label="上一章"
            disabled={currentIdx <= 0}
            onClick={() => goTo(CHAPTERS[currentIdx - 1][0])}
            className="grid size-10 place-items-center rounded-full border border-line bg-surface text-ink shadow-[0_2px_8px_rgba(20,22,25,0.05)] hover:border-gold/50 hover:text-gold disabled:opacity-35"
          >
            <CaretLeftIcon size={18} weight="bold" />
          </button>
          <button
            type="button"
            aria-label="下一章"
            disabled={currentIdx >= CHAPTERS.length - 1}
            onClick={() => goTo(CHAPTERS[currentIdx + 1][0])}
            className="grid size-10 place-items-center rounded-full border border-line bg-surface text-ink shadow-[0_2px_8px_rgba(20,22,25,0.05)] hover:border-gold/50 hover:text-gold disabled:opacity-35"
          >
            <CaretRightIcon size={18} weight="bold" />
          </button>
        </div>
      </footer>
    </main>
  );
}

function MetricBlock({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="ios-card rounded-[16px] px-4 py-4">
      <div className="text-[13px] text-muted">{label}</div>
      <div className={`mt-2 truncate text-[26px] font-semibold leading-none tracking-[-0.03em] tabular-nums ${accent ? "text-gold" : "text-ink"}`}>
        {value}
      </div>
    </div>
  );
}
