import { CaretLeftIcon, CaretRightIcon, SignOutIcon } from "@phosphor-icons/react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { api, type Status } from "./api";
import { usePrefs } from "./prefs";
import { useTasteProfile } from "./ratings";
import { SPRING_PILL, SPRING_STAGE } from "./ui/motion";
import { normalizeFolder, PrefToggle, SettingsSection } from "./settings/shared";
import { StoragePage } from "./settings/StoragePage";
import { PlaybackPage, PrivacyPage } from "./settings/PlaybackPrivacyPages";
import { MaintenancePage } from "./settings/MaintenancePage";
import { haptic } from "./ui/haptics";

export { normalizeFolder };

type Chapter = "hub" | "storage" | "playback" | "privacy" | "maintenance";
const CHAPTERS: readonly [Chapter, string][] = [
  ["hub", "总览"],
  ["storage", "网盘"],
  ["playback", "播放"],
  ["privacy", "隐私"],
  ["maintenance", "维护"],
];

/**
 * Direction A — Single-Viewport Horizontal Chapter Folio for Settings:
 * - Zero long vertical scrolling page; switches cleanly left/right between 5 focused chapters
 * - Shows live Taste Recommendation profile summary alongside playback/privacy status
 */
export function Settings({ onLoggedOut, onDuplicates }: { onLoggedOut: () => void; onDuplicates: () => void }) {
  const prefs = usePrefs();
  const taste = useTasteProfile();
  const [page, setPage] = useState<Chapter>("hub");
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
    <main className="mx-auto flex h-full w-full max-w-4xl flex-col overflow-hidden px-4 pb-4 pt-4 sm:px-8 sm:pb-5 sm:pt-5">
      {/* Chapter Header */}
      <header className="mb-4 flex shrink-0 flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-[22px] font-semibold leading-none tracking-[-0.03em] text-ink sm:text-[28px]">设置</h1>
        <div className="flex w-full items-center justify-between gap-1 rounded-full border border-line bg-surface/70 p-1 sm:w-auto" role="tablist">
          {CHAPTERS.map(([key, label]) => {
            const active = page === key;
            return (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => goTo(key)}
                className={`relative h-8.5 flex-1 rounded-full px-3 text-[13.5px] transition-colors sm:h-9 sm:flex-none sm:px-4 sm:text-[14px] ${
                  active ? "font-semibold text-bg" : "text-muted hover:text-ink"
                }`}
              >
                {active && (
                  <motion.span
                    layoutId="ppvio-settings-chapter"
                    transition={SPRING_PILL}
                    className="absolute inset-0 rounded-full bg-gold"
                  />
                )}
                <span className="relative z-10">{label}</span>
              </button>
            );
          })}
        </div>
      </header>

      {/* Active Chapter Stage */}
      <div className="relative min-h-0 flex-1 overflow-y-auto pr-1 [scrollbar-width:none]">
        <AnimatePresence mode="wait" initial={false}>
          {page === "hub" && (
            <motion.div
              key="hub"
              initial={{ opacity: 0, x: dir * 28 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: dir * -24 }}
              transition={SPRING_STAGE}
              className="space-y-5"
            >
              {/* Clean Editorial Status Grid — High typographic contrast, zero clutter */}
              <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <MetricBlock label="片库规模" value={status?.scan?.active_videos != null ? String(status.scan.active_videos) : "—"} />
                <MetricBlock label="已评影片" value={String(taste.rated_count)} accent={taste.active} />
                <MetricBlock label="传输通道" value={mode?.mode === "direct" ? "115 直连" : "WebDAV"} />
                <MetricBlock label="起播画质" value={prefs.lowRes ? "480P 优先" : "原画直出"} />
              </section>

              <SettingsSection title="常用开关">
                <PrefToggle pref="coverBlur" title="封面防窥" hint="片库与标签默认启用折光模糊" />
                <PrefToggle pref="lowRes" title="极速起播" hint="优先加载 480P 副本，切页更快" />
              </SettingsSection>

              <div className="flex justify-end pt-2">
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
            <motion.div key="storage" initial={{ opacity: 0, x: dir * 28 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: dir * -24 }} transition={SPRING_STAGE}>
              <StoragePage onBack={() => goTo("hub")} />
            </motion.div>
          )}

          {page === "playback" && (
            <motion.div key="playback" initial={{ opacity: 0, x: dir * 28 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: dir * -24 }} transition={SPRING_STAGE}>
              <PlaybackPage mode={mode} onModeChange={setMode} onBack={() => goTo("hub")} />
            </motion.div>
          )}

          {page === "privacy" && (
            <motion.div key="privacy" initial={{ opacity: 0, x: dir * 28 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: dir * -24 }} transition={SPRING_STAGE}>
              <PrivacyPage onBack={() => goTo("hub")} />
            </motion.div>
          )}

          {page === "maintenance" && (
            <motion.div key="maintenance" initial={{ opacity: 0, x: dir * 28 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: dir * -24 }} transition={SPRING_STAGE}>
              <MaintenancePage
                status={status}
                watched={watched}
                onWatchedChange={setWatched}
                dupes={dupes}
                onDuplicates={onDuplicates}
                onBack={() => goTo("hub")}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Bottom Order & Chaos Chapter Progress Rail */}
      <footer className="mt-3 flex shrink-0 items-center justify-between gap-4 border-t border-line pt-3">
        <div className="flex flex-1 items-center gap-2.5 max-w-md">
          {CHAPTERS.map(([key, label], i) => {
            const active = i === currentIdx;
            return (
              <button key={key} type="button" onClick={() => goTo(key)} className="flex flex-1 flex-col gap-1.5 text-left">
                <span className={`text-[13px] ${active ? "font-semibold text-ink" : "text-faint"}`}>
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span className={`block h-[2px] w-full ${active ? "bg-gold" : "bg-white/15"}`} />
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
            className="grid size-10 place-items-center rounded-full border border-line bg-surface/70 text-ink hover:border-gold/50 disabled:opacity-25"
          >
            <CaretLeftIcon size={18} weight="bold" />
          </button>
          <button
            type="button"
            aria-label="下一章"
            disabled={currentIdx >= CHAPTERS.length - 1}
            onClick={() => goTo(CHAPTERS[currentIdx + 1][0])}
            className="grid size-10 place-items-center rounded-full border border-line bg-surface/70 text-ink hover:border-gold/50 disabled:opacity-25"
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
    <div className="rounded-[16px] border border-line bg-surface/75 px-4 py-4">
      <div className="text-[13px] text-muted">{label}</div>
      <div className={`mt-2 truncate text-[26px] font-semibold leading-none tracking-[-0.03em] tabular-nums ${accent ? "text-gold-bright" : "text-ink"}`}>
        {value}
      </div>
    </div>
  );
}
