import { ArrowsClockwiseIcon, CaretLeftIcon, CornersOutIcon, SpeakerHighIcon, SpeakerSlashIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";
import { api, chooseStream, type Media } from "../api";
import { useLocked } from "../ui/privacy";
import { haptic } from "../ui/haptics";

/**
 * Multi-View Wall: plays 2 (mobile 2×1) or 4 (2×2) simultaneous 480p-preferred streams.
 * All tiles start muted; tapping a tile focuses audio onto it with a champagne-gold rim.
 */
export function MultiView({ onBack, onOpen }: { onBack: () => void; onOpen: (items: Media[], index: number) => void }) {
  const locked = useLocked();
  const [count, setCount] = useState<2 | 4>(() => (typeof window !== "undefined" && window.innerWidth >= 768 ? 4 : 2));
  const [items, setItems] = useState<Media[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeAudio, setActiveAudio] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setActiveAudio(null);
    try {
      const page = await api.feed(4);
      setItems(page.items.slice(0, 4));
    } catch { /* keep previous if offline */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const visible = items.slice(0, count);
  return (
    <div className="fixed inset-0 z-30 flex flex-col bg-black">
      <header className="glass-header z-20 flex items-center gap-2 px-3 pb-2.5 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <button type="button" onClick={onBack} aria-label="返回片库"
          className="glass-pill pressable grid size-10 shrink-0 place-items-center rounded-full text-white">
          <CaretLeftIcon size={19} weight="bold" />
        </button>
        <h1 className="min-w-0 flex-1 truncate text-[17px] font-semibold tracking-[-0.02em] text-ink">多屏同看</h1>
        <button type="button" onClick={() => { haptic(8); setCount(c => c === 2 ? 4 : 2); }}
          className="glass-pill pressable h-9 rounded-full px-3 text-[12px] font-semibold text-gold-bright">
          {count === 2 ? "2 屏" : "4 屏"}
        </button>
        <button type="button" onClick={() => setActiveAudio(null)} aria-label="全部静音"
          className="glass-pill pressable grid size-9 place-items-center rounded-full text-white">
          <SpeakerSlashIcon size={17} />
        </button>
        <button type="button" onClick={() => { haptic(10); void load(); }} disabled={loading} aria-label="换一批"
          className="glass-pill-gold pressable flex h-9 items-center gap-1 rounded-full px-3.5 text-[12px] font-semibold disabled:opacity-50">
          <ArrowsClockwiseIcon size={14} className={loading ? "animate-spin" : ""} />换一批
        </button>
      </header>

      <div className={`grid flex-1 gap-1.5 p-1.5 pb-[max(0.5rem,env(safe-area-inset-bottom))] ${count === 4 ? "grid-cols-2 grid-rows-2" : "grid-cols-1 grid-rows-2 sm:grid-cols-2 sm:grid-rows-1"}`}>
        {loading && !visible.length ? (
          Array.from({ length: count }, (_, i) => (
            <div key={i} className="animate-pulse rounded-[16px] border border-white/[0.08] bg-surface" />
          ))
        ) : visible.map((media, index) => {
          const soundOn = !locked && activeAudio === media.id;
          // Prefer 480p rendition so multi-stream stays fluid on mobile & desktop.
          const src = chooseStream(media, true);
          return (
            <div key={media.id}
              onClick={() => { haptic(8); setActiveAudio(cur => cur === media.id ? null : media.id); }}
              className={`relative overflow-hidden rounded-[16px] bg-[#0a0b0e] transition-all ${soundOn ? "ring-2 ring-gold-bright shadow-[0_0_24px_rgba(230,198,135,0.28)]" : "ring-1 ring-white/[0.1]"}`}>
              <video src={src} poster={media.cover_url ?? undefined} autoPlay loop playsInline muted={!soundOn}
                className="size-full object-cover" />
              <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-between bg-gradient-to-t from-black/75 to-transparent px-2.5 pb-2 pt-8">
                <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${soundOn ? "glass-pill-gold" : "glass-pill text-white/80"}`}>
                  {soundOn ? <SpeakerHighIcon size={12} weight="fill" /> : <SpeakerSlashIcon size={12} />}
                  {soundOn ? "有声主屏" : "点按开声"}
                </span>
                <button type="button" aria-label={`独享播放第 ${index + 1} 路`}
                  onClick={e => { e.stopPropagation(); onOpen(visible, index); }}
                  className="glass-pill pressable pointer-events-auto grid size-8 place-items-center rounded-full text-white hover:border-gold/40">
                  <CornersOutIcon size={15} />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
