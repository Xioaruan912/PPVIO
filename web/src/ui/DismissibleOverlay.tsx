import { motion, useMotionValue, useTransform, type PanInfo } from "motion/react";
import { SPRING_STAGE } from "./motion";
import { haptic } from "./haptics";

/**
 * iOS Photos / Apple TV style pull-down-to-shrink-and-dismiss wrapper for full-screen players.
 * Only activates on downward vertical drags; horizontal scrubbing and taps pass straight through.
 */
export function DismissibleOverlay({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  const y = useMotionValue(0);
  const scale = useTransform(y, [0, 260], [1, 0.86]);
  const radius = useTransform(y, [0, 140], [0, 28]);
  const backdrop = useTransform(y, [0, 240], [1, 0.25]);

  const onDragEnd = (_: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) => {
    if (info.offset.y > 110 || info.velocity.y > 540) {
      haptic(10);
      onClose();
    }
  };

  return (
    <motion.div className="fixed inset-0 z-30"
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}>
      <motion.div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-black" style={{ opacity: backdrop }} />
      <motion.div
        drag="y"
        dragDirectionLock
        dragConstraints={{ top: 0, bottom: 0 }}
        dragElastic={{ top: 0, bottom: 0.55 }}
        onDragEnd={onDragEnd}
        style={{ y, scale, borderRadius: radius }}
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.92, y: 40 }}
        transition={SPRING_STAGE}
        className="relative size-full overflow-hidden bg-black">
        {children}
      </motion.div>
    </motion.div>
  );
}
