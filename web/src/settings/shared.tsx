import { CaretLeftIcon, CaretRightIcon } from "@phosphor-icons/react";
import { motion } from "motion/react";
import { setPref, usePrefs } from "../prefs";
import { SPRING_PILL, SPRING_TAP } from "../ui/motion";

/** Folders are relative to the WebDAV root; stray slashes are dropped. */
export function normalizeFolder(value: string): string {
  return value.trim().replace(/^\/+|\/+$/g, "");
}

export function SettingsHeader({ title, subtitle, onBack }: { title: string; subtitle?: string; onBack: () => void }) {
  return (
    <header className="mb-5 flex items-center gap-3 px-0.5">
      <motion.button type="button" onClick={onBack} aria-label="返回设置" whileTap={{ scale: 0.88 }} transition={SPRING_TAP}
        className="ios-card grid size-10 shrink-0 place-items-center rounded-full text-ink hover:border-gold/35">
        <CaretLeftIcon size={19} weight="bold" />
      </motion.button>
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-[26px] font-semibold leading-tight tracking-[-0.03em] text-ink">{title}</h1>
        {subtitle && <p className="mt-0.5 truncate text-[12px] text-muted">{subtitle}</p>}
      </div>
    </header>
  );
}

export function SettingsSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-6 first:mt-0">
      <h2 className="mb-2 px-2 text-[12px] font-medium tracking-[0.02em] text-muted">{title}</h2>
      <div className="ios-card divide-y divide-line overflow-hidden rounded-[22px]">{children}</div>
    </section>
  );
}

export function IosSwitch({ checked, onChange }: { checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <span className="relative inline-flex shrink-0 items-center">
      <input type="checkbox" className="peer sr-only" checked={checked} onChange={e => onChange(e.target.checked)} />
      <span aria-hidden="true"
        className={`relative h-[30px] w-[50px] rounded-full transition-colors duration-200 peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-gold ${checked ? "bg-ok shadow-[0_0_12px_rgba(48,209,88,0.35)]" : "bg-white/[0.16]"}`}>
        <motion.span layout transition={SPRING_PILL}
          className={`absolute top-[3px] block size-6 rounded-full bg-white shadow-[0_2px_6px_rgba(0,0,0,0.38)] ${checked ? "left-[23px]" : "left-[3px]"}`} />
      </span>
    </span>
  );
}

export function PrefToggle({ pref, title, hint }: { pref: "lowRes" | "coverBlur" | "privacyLock"; title: string; hint: string }) {
  const prefs = usePrefs();
  return (
    <label className="flex cursor-pointer items-center justify-between gap-4 px-4 py-3.5 transition-colors hover:bg-white/[0.025]">
      <span>
        <span className="block text-[15px] font-medium text-ink">{title}</span>
        <span className="mt-0.5 block text-[13px] leading-snug text-muted">{hint}</span>
      </span>
      <IosSwitch checked={prefs[pref]} onChange={checked => setPref(pref, checked)} />
    </label>
  );
}

export function SettingsNavRow({ icon, iconTone, title, subtitle, value, warn, onClick }: {
  icon: React.ReactNode; iconTone: string; title: string; subtitle: string; value?: string; warn?: boolean; onClick: () => void;
}) {
  return (
    <motion.button type="button" onClick={onClick} whileTap={{ scale: 0.985 }} transition={SPRING_TAP}
      className="flex w-full items-center gap-3.5 px-4 py-3.5 text-left transition-colors hover:bg-white/[0.03] active:bg-white/[0.06]">
      <span className={`grid size-10 shrink-0 place-items-center rounded-[13px] ${iconTone}`}>{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[15px] font-medium text-ink">{title}</span>
        <span className="mt-0.5 block truncate text-[12px] text-muted">{subtitle}</span>
      </span>
      {value && <span className={`shrink-0 text-[13px] font-medium tabular-nums ${warn ? "text-accent" : "text-gold/90"}`}>{value}</span>}
      <CaretRightIcon size={15} className="shrink-0 text-faint" />
    </motion.button>
  );
}

export function SettingsLine({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3.5 text-[15px]">
      <span className="text-ink">{label}</span>
      <span className={`text-[14px] tabular-nums ${warn ? "text-accent" : "text-muted"}`}>{value}</span>
    </div>
  );
}
