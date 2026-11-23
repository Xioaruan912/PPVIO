import { AnimatePresence, motion, type PanInfo } from "motion/react";
import { useBackLayer } from "./navigation";
import { EASE_HUD, SPRING_SHEET } from "./motion";

/** An iOS-style luxury Liquid Glass bottom sheet with 1:1 drag-to-dismiss and velocity handoff. */
export function Sheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title?: string; children: React.ReactNode }) {
  useBackLayer(open, onClose);
  const onDragEnd = (_: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) => {
    if (info.offset.y > 85 || info.velocity.y > 460) onClose();
  };
  return (
    <AnimatePresence>
      {open && (
        <motion.div className="fixed inset-0 z-40 flex items-end justify-center bg-black/65 backdrop-blur-[6px]" onClick={onClose}
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={EASE_HUD}>
          <motion.div role="dialog" aria-label={title} onClick={event => event.stopPropagation()}
            drag="y" dragConstraints={{ top: 0 }} dragElastic={{ top: 0.06, bottom: 0.4 }} onDragEnd={onDragEnd}
            className="glass-sheet max-h-[82dvh] w-full max-w-lg overflow-y-auto rounded-t-[28px] px-3 pb-[max(1.2rem,env(safe-area-inset-bottom))] pt-2.5"
            initial={{ y: "100%", scale: 0.97 }} animate={{ y: 0, scale: 1 }} exit={{ y: "100%", scale: 0.98 }} transition={SPRING_SHEET}>
            <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-gold/35" aria-hidden="true" />
            {title && <h2 className="px-3 pb-2.5 text-[17px] font-semibold tracking-[-0.02em] text-ink">{title}</h2>}
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export function SheetButton({ onClick, danger, children }: { onClick: () => void; danger?: boolean; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick}
      className={`pressable flex min-h-13 w-full items-center gap-3 rounded-[16px] px-4 text-left text-[15px] font-medium transition-colors hover:bg-white/[0.06] active:bg-white/[0.1] ${danger ? "text-accent" : "text-ink"}`}>
      {children}
    </button>
  );
}
