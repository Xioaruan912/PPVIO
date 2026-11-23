import { CaretDownIcon, CheckIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { Sheet } from "./Sheet";

/** Breathing obsidian skeleton cards for media grids while the first page loads. */
export function GridSkeleton({ wide = false, count = 6 }: { wide?: boolean; count?: number }) {
  return (
    <div aria-hidden="true" className={`grid gap-2.5 ${wide ? "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4" : "grid-cols-3 sm:grid-cols-4 lg:grid-cols-6"}`}>
      {Array.from({ length: count }, (_, index) => (
        <div key={index}
          className={`relative overflow-hidden rounded-[16px] border border-white/[0.06] bg-surface ${wide ? "aspect-video" : "aspect-[3/4]"}`}>
          <div className="size-full animate-pulse bg-gradient-to-br from-white/[0.05] via-gold/[0.03] to-transparent" />
        </div>
      ))}
    </div>
  );
}

export function ListSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div aria-hidden="true" className="ios-card divide-y divide-line overflow-hidden rounded-[20px]">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex h-14 items-center gap-3 px-4">
          <div className="size-6 animate-pulse rounded-md bg-white/[0.08]" />
          <div className="h-3.5 flex-1 animate-pulse rounded-full bg-white/[0.07]" style={{ maxWidth: `${52 + (i % 3) * 14}%` }} />
          <div className="h-3 w-8 animate-pulse rounded-full bg-white/[0.06]" />
        </div>
      ))}
    </div>
  );
}

/**
 * Luxury Liquid Glass bottom-sheet selector that keeps a synced native <select> in the DOM
 * for screen readers, keyboard shortcuts, and existing automated test contracts.
 */
export function GlassSelect<T extends string>({ label, value, options, onChange, className = "" }: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (next: T) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const current = options.find(opt => opt.value === value)?.label ?? value;
  return (
    <div className={`relative ${className}`}>
      <select aria-label={label} value={value} onChange={event => onChange(event.target.value as T)} className="sr-only" tabIndex={-1}>
        {options.map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
      </select>
      <button type="button" onClick={() => setOpen(true)} aria-haspopup="listbox" aria-expanded={open}
        className="ios-card pressable flex min-h-10 w-full items-center justify-between gap-2 rounded-full px-3.5 text-[13px] font-medium text-ink hover:border-gold/35">
        <span className="truncate">{current}</span>
        <CaretDownIcon size={13} weight="bold" className="shrink-0 text-gold/80" />
      </button>
      <Sheet open={open} onClose={() => setOpen(false)} title={label}>
        <div role="listbox" aria-label={label} className="space-y-1.5 px-1 pb-1">
          {options.map(opt => {
            const active = opt.value === value;
            return (
              <button key={opt.value} type="button" role="option" aria-selected={active}
                onClick={() => { onChange(opt.value); setOpen(false); }}
                className={`pressable flex min-h-12 w-full items-center justify-between rounded-[16px] px-4 text-[15px] transition-colors ${active ? "border border-gold/35 bg-gold/16 font-semibold text-gold-bright" : "text-ink/90 hover:bg-white/[0.06]"}`}>
                <span>{opt.label}</span>
                {active && <CheckIcon size={18} weight="bold" className="text-gold-bright" />}
              </button>
            );
          })}
        </div>
      </Sheet>
    </div>
  );
}
