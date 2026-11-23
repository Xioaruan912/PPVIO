import { GearSixIcon, TagIcon, PlayIcon, SquaresFourIcon } from "@phosphor-icons/react";
import { AnimatePresence, motion, MotionConfig } from "motion/react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Media, LibraryFolder } from "./api";
import { ClipList, Feed } from "./feed/Feed";
import { Login } from "./Login";
import { Duplicates } from "./pages/Duplicates";
import { TagCollections } from "./pages/TagCollections";
import { History } from "./pages/History";
import { Channels } from "./pages/Channels";
import { TagManager } from "./pages/TagManager";
import { Queue } from "./pages/Queue";
import { QueuePlayer } from "./player/QueuePlayer";
import { Library } from "./pages/Library";
import { LongPlayer } from "./player/LongPlayer";
import { Settings } from "./Settings";
import { PrivacyGuard } from "./ui/privacy";
import { Toasts } from "./ui/toast";
import { BookmarkWall } from "./ui/Bookmarks";
import { useRouteState } from "./ui/navigation";
import { Curation } from "./pages/Curation";
import { BookmarkLoopFeed } from "./pages/BookmarkLoopFeed";
import { TagFilingNotice } from "./ui/TagFilingNotice";
import { SPRING_PILL, SPRING_STAGE, SPRING_TAP, SPRING_UI } from "./ui/motion";

type Tab = "feed" | "library" | "favorites" | "settings";
type Overlay = { kind: "clips"; items: Media[]; index: number; at?: number } | { kind: "long"; items: Media[]; index: number; at?: number } | { kind: "duplicates" } | { kind: "bookmarks" } | { kind: "curation" } | { kind: "loops"; tagId?: number } | { kind: "history" | "channels" | "premium" | "tags" | "queue" } | { kind: "queue-player"; ids: string[]; index: number } | null;

/**
 * A short clip opens the swipe list of the short clips around it; a long one opens the film player,
 * which goes on to the next long video of the same wall when it ends.
 */
export function overlayFor(items: Media[], index: number): Overlay {
  const picked = items[index];
  if (!picked) return null;
  if (picked.category === "long") {
    const longs = items.filter(item => item.category === "long");
    return { kind: "long", items: longs, index: longs.indexOf(picked) };
  }
  const shorts = items.filter(item => item.category !== "long");
  return { kind: "clips", items: shorts, index: shorts.indexOf(picked) };
}

export function App() {
  const [authed, setAuthed] = useState(true);
  const [route, navigate, replace, back] = useRouteState<{ tab: Tab; overlay: Overlay; folder: LibraryFolder | null }>({ tab: "feed", overlay: null, folder: null });
  const { tab, overlay } = route;
  const [libraryOpened, setLibraryOpened] = useState(false), [favoritesOpened, setFavoritesOpened] = useState(false);
  const scrolls = useRef<Partial<Record<Tab, number>>>({});
  const setTab = (next: Tab) => {
    if (next === tab) return;
    if (next === "library") setLibraryOpened(true);
    if (next === "favorites") setFavoritesOpened(true);
    navigate({ ...route, tab: next, overlay: null });
  };
  useLayoutEffect(() => {
    window.scrollTo(0, scrolls.current[tab] ?? 0);
    return () => { scrolls.current[tab] = window.scrollY; };
  }, [tab]);
  const [closed, setClosed] = useState(0);
  const previousOverlay = useRef(overlay);
  useEffect(() => { const changed = () => setClosed(value => value + 1); window.addEventListener("ppvio:tags-changed", changed); return () => window.removeEventListener("ppvio:tags-changed", changed); }, []);
  useEffect(() => { if (previousOverlay.current && !overlay) setClosed(n => n + 1); previousOverlay.current = overlay; }, [overlay]);
  const close = () => back();
  const show = (kind: "history" | "channels" | "premium" | "tags" | "queue") => navigate({ ...route, overlay: { kind } });
  const playQueue = (ids: string[], index: number) => navigate({ ...route, overlay: { kind: "queue-player", ids, index } });
  const onUnauthorized = useCallback(() => setAuthed(false), []);
  const open = (items: Media[], index: number, _more?: () => void, at?: number) => {
    const picked = overlayFor(items, index);
    navigate({ ...route, tab, overlay: picked && (picked.kind === "clips" || picked.kind === "long") ? { ...picked, at } : picked });
  };

  if (!authed) return <MotionConfig reducedMotion="user"><Login onDone={() => setAuthed(true)} /></MotionConfig>;
  return (
    <MotionConfig reducedMotion="user">
      {tab !== "feed" && !overlay && (
        <div aria-hidden="true" className="cinema-aura pointer-events-none fixed inset-0 -z-10" />
      )}
      <div hidden={tab !== "feed" || !!overlay}><Feed onUnauthorized={onUnauthorized} enabled={tab === "feed" && !overlay} /></div>
      {libraryOpened && (
        <div hidden={tab !== "library"}>
          <motion.div animate={tab === "library" ? { opacity: 1, y: 0, scale: 1 } : { opacity: 0.7, y: 10, scale: 0.99 }} transition={SPRING_UI}>
            <Library selectedFolder={route.folder} onFolderChange={folder => navigate({ ...route, folder })} onOpen={open} refresh={closed} onBookmarks={() => navigate({ ...route, tab, overlay: { kind: "bookmarks" } })} onCuration={() => navigate({ ...route, tab, overlay: { kind: "curation" } })} onHistory={() => show("history")} onChannels={() => show("channels")} onPremium={() => show("premium")} onQueue={() => show("queue")} />
          </motion.div>
        </div>
      )}
      {favoritesOpened && (
        <div hidden={tab !== "favorites"}>
          <motion.div animate={tab === "favorites" ? { opacity: 1, y: 0, scale: 1 } : { opacity: 0.7, y: 10, scale: 0.99 }} transition={SPRING_UI}>
            <TagCollections onOpen={open} onManage={() => show("tags")} refresh={closed} notice={tab === "favorites" && !overlay ? <TagFilingNotice /> : undefined} />
          </motion.div>
        </div>
      )}
      {tab === "settings" && (
        <motion.div initial={{ opacity: 0, y: 14, scale: 0.99 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={SPRING_UI}>
          <Settings onLoggedOut={onUnauthorized} onDuplicates={() => navigate({ ...route, tab, overlay: { kind: "duplicates" } })} />
        </motion.div>
      )}

      <AnimatePresence>
        {overlay?.kind === "clips" && (
          <motion.div key="ov-clips" className="fixed inset-0 z-30 bg-black"
            initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.96 }} transition={SPRING_STAGE}>
            <OverlayClips items={overlay.items} start={overlay.index} onClose={close} at={overlay.at} />
          </motion.div>
        )}
        {overlay?.kind === "long" && overlay.items[overlay.index] && (
          <motion.div key={`ov-long-${overlay.items[overlay.index].id}`} className="fixed inset-0 z-30 bg-black"
            initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.96 }} transition={SPRING_STAGE}>
            <LongPlayer key={overlay.items[overlay.index].id} media={overlay.items[overlay.index]} next={overlay.items[overlay.index + 1]} onClose={close}
              startAt={overlay.at} onNext={() => replace({ ...route, tab, overlay: { ...overlay, at: undefined, index: overlay.index + 1 } })} />
          </motion.div>
        )}
        {overlay?.kind === "duplicates" && (
          <motion.div key="ov-dupes" className="fixed inset-0 z-30"
            initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 20 }} transition={SPRING_STAGE}>
            <Duplicates onClose={close} />
          </motion.div>
        )}
        {overlay?.kind === "bookmarks" && (
          <OverlaySheet key="ov-bookmarks">
            <BookmarkWall onBack={close} onOpen={(media, at) => open([media], 0, undefined, at)} onLoop={tagId => navigate({ ...route, overlay: { kind: "loops", tagId } })} />
          </OverlaySheet>
        )}
        {overlay?.kind === "loops" && (
          <motion.div key="ov-loops" className="fixed inset-0 z-30 bg-black"
            initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.96 }} transition={SPRING_STAGE}>
            <BookmarkLoopFeed onClose={close} tagId={overlay.tagId} />
          </motion.div>
        )}
        {overlay?.kind === "curation" && <OverlaySheet key="ov-curation"><Curation onBack={close} onOpen={open} /></OverlaySheet>}
        {overlay?.kind === "history" && <OverlaySheet key="ov-history"><History onBack={close} onOpen={open} /></OverlaySheet>}
        {(overlay?.kind === "channels" || overlay?.kind === "premium") && (
          <OverlaySheet key={`ov-${overlay.kind}`}>
            <Channels onBack={close} onOpen={open} premiumOnly={overlay.kind === "premium"} onPlayQueue={items => playQueue(items.map(item => item.id), 0)} />
          </OverlaySheet>
        )}
        {overlay?.kind === "tags" && <OverlaySheet key="ov-tags"><TagManager onBack={close} /></OverlaySheet>}
        {overlay?.kind === "queue" && <OverlaySheet key="ov-queue"><Queue onBack={close} onPlay={playQueue} /></OverlaySheet>}
        {overlay?.kind === "queue-player" && (
          <motion.div key="ov-qp" className="fixed inset-0 z-30 bg-black"
            initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.96 }} transition={SPRING_STAGE}>
            <QueuePlayer ids={overlay.ids} start={overlay.index} onClose={close} />
          </motion.div>
        )}
      </AnimatePresence>

      {!overlay && (
        <motion.div initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} transition={SPRING_STAGE}
          className="pointer-events-none fixed inset-x-0 bottom-0 z-10 flex justify-center px-4 pb-[max(0.85rem,env(safe-area-inset-bottom))] pt-2">
          <nav aria-label="导航"
            className={`pointer-events-auto flex w-full max-w-[344px] items-center justify-between rounded-full p-1.5 transition-all duration-300 ${tab === "feed" ? "glass-dock-cinema" : "glass-dock"}`}>
            <NavItem label="刷" active={tab === "feed"} onClick={() => setTab("feed")}><PlayIcon size={21} weight={tab === "feed" ? "fill" : "regular"} /></NavItem>
            <NavItem label="片库" active={tab === "library"} onClick={() => setTab("library")}><SquaresFourIcon size={21} weight={tab === "library" ? "fill" : "regular"} /></NavItem>
            <NavItem label="标签" active={tab === "favorites"} onClick={() => setTab("favorites")}><TagIcon size={21} weight={tab === "favorites" ? "fill" : "regular"} /></NavItem>
            <NavItem label="设置" active={tab === "settings"} onClick={() => setTab("settings")}><GearSixIcon size={21} weight={tab === "settings" ? "fill" : "regular"} /></NavItem>
          </nav>
        </motion.div>
      )}
      <Toasts />
      <PrivacyGuard />
    </MotionConfig>
  );
}

function OverlaySheet({ children }: { children: React.ReactNode }) {
  return (
    <motion.div className="cinema-aura fixed inset-0 z-30 overflow-y-auto bg-bg"
      initial={{ opacity: 0, y: 28, scale: 0.985 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 22, scale: 0.985 }}
      transition={SPRING_STAGE}>
      {children}
    </motion.div>
  );
}

function OverlayClips({ items, start, onClose, at }: { items: Media[]; start: number; onClose: () => void; at?: number }) {
  const [list, setList] = useState(items);
  return <ClipList items={list} setItems={setList} start={start} onClose={onClose} startAt={at} />;
}

function NavItem({ label, active, onClick, children }: { label: string; active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <motion.button type="button" onClick={onClick} aria-current={active ? "page" : undefined}
      whileTap={{ scale: 0.88 }} transition={SPRING_TAP}
      className={`relative flex h-12 flex-1 flex-col items-center justify-center gap-0.5 rounded-full text-[11px] font-medium tracking-[0.02em] transition-colors ${active ? "text-gold-bright" : "text-white/55 hover:text-white/85"}`}>
      {active && (
        <motion.span layoutId="ppvio-nav-pill" transition={SPRING_PILL}
          className="absolute inset-0 rounded-full border border-gold/25 bg-gradient-to-b from-gold/22 via-white/[0.08] to-white/[0.04] shadow-[0_6px_20px_rgba(230,198,135,0.16),inset_0_1px_0_rgba(255,248,232,0.32)]" />
      )}
      <motion.span animate={{ scale: active ? 1.12 : 1, y: active ? -1 : 0 }} transition={SPRING_PILL}
        className="relative z-10 flex flex-col items-center gap-0.5">
        {children}
        <span>{label}</span>
      </motion.span>
    </motion.button>
  );
}
