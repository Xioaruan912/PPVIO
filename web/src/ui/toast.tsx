import { AnimatePresence, motion } from "motion/react";
import { useSyncExternalStore } from "react";
import { SPRING_PILL } from "./motion";

interface Toast { id: number; text: string; action?: { label: string; run: () => void } }

let toasts: Toast[] = [];
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(listener => listener());

export function toast(text: string, action?: Toast["action"], ms = 4000): void {
  const item = { id: performance.now(), text, action };
  toasts = [...toasts.slice(-2), item];
  emit();
  setTimeout(() => { toasts = toasts.filter(t => t.id !== item.id); emit(); }, ms);
}

export function Toasts() {
  const list = useSyncExternalStore(l => { listeners.add(l); return () => listeners.delete(l); }, () => toasts);
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-[calc(5.9rem+env(safe-area-inset-bottom))] z-40 flex flex-col items-center gap-2 px-4" role="status">
      <AnimatePresence mode="popLayout">
        {list.map(t => (
          <motion.div key={t.id} layout
            initial={{ opacity: 0, y: 18, scale: 0.88 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.92 }}
            transition={SPRING_PILL}
            className="glass-dock pointer-events-auto flex items-center gap-3.5 rounded-full px-4 py-2.5 text-[14px] font-medium text-ink">
            <span className="size-1.5 shrink-0 rounded-full bg-gold" aria-hidden="true" />
            <span>{t.text}</span>
            {t.action && (
              <button type="button" className="pressable rounded-full bg-gold-soft px-3 py-1 text-[13px] font-semibold text-gold"
                onClick={() => { t.action!.run(); toasts = toasts.filter(x => x.id !== t.id); emit(); }}>
                {t.action.label}
              </button>
            )}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
