import { AnimatePresence, motion, MotionConfig } from "motion/react";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import type { Media, LibraryFolder } from "./api";
import { ClipList, Feed } from "./feed/Feed";
import { Login } from "./Login";
import { bootstrapRatings } from "./ratings";
import { PrivacyGuard } from "./ui/privacy";
import { Toasts } from "./ui/toast";
import { useRouteState } from "./ui/navigation";
import { TagFilingNotice } from "./ui/TagFilingNotice";
import { BlurToggle } from "./ui/Grid";
import { SPRING_PILL, SPRING_STAGE, SPRING_TAP } from "./ui/motion";
import { DismissibleOverlay } from "./ui/DismissibleOverlay";

const Library = lazy(() => import("./pages/Library").then(m => ({ default: m.Library })));
const TagCollections = lazy(() => import("./pages/TagCollections").then(m => ({ default: m.TagCollections })));
const Settings = lazy(() => import("./Settings").then(m => ({ default: m.Settings })));
const LongPlayer = lazy(() => import("./player/LongPlayer").then(m => ({ default: m.LongPlayer })));
const Duplicates = lazy(() => import("./pages/Duplicates").then(m => ({ default: m.Duplicates })));
const BookmarkWall = lazy(() => import("./ui/Bookmarks").then(m => ({ default: m.BookmarkWall })));
const BookmarkLoopFeed = lazy(() => import("./pages/BookmarkLoopFeed").then(m => ({ default: m.BookmarkLoopFeed })));
const Curation = lazy(() => import("./pages/Curation").then(m => ({ default: m.Curation })));
const History = lazy(() => import("./pages/History").then(m => ({ default: m.History })));
const Channels = lazy(() => import("./pages/Channels").then(m => ({ default: m.Channels })));
const TagManager = lazy(() => import("./pages/TagManager").then(m => ({ default: m.TagManager })));
const Queue = lazy(() => import("./pages/Queue").then(m => ({ default: m.Queue })));
const QueuePlayer = lazy(() => import("./player/QueuePlayer").then(m => ({ default: m.QueuePlayer })));
const MultiView = lazy(() => import("./pages/MultiView").then(m => ({ default: m.MultiView })));

type Tab = "feed" | "library" | "favorites" | "settings";
const TAB_ORDER: readonly Tab[] = ["feed", "library", "favorites", "settings"];
const TAB_LABELS: Record<Tab, string> = {
  feed: "放映",
  library: "片库",
  favorites: "标签",
  settings: "设置",
};

type Overlay =
  | { kind: "clips"; items: Media[]; index: number; at?: number }
  | { kind: "long"; items: Media[]; index: number; at?: number }
  | { kind: "duplicates" }
  | { kind: "bookmarks" }
  | { kind: "curation" }
  | { kind: "loops"; tagId?: number }
  | { kind: "multiview" }
  | { kind: "history" | "channels" | "premium" | "tags" | "queue" }
  | { kind: "queue-player"; ids: string[]; index: number }
  | null;

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

function PageFallback() {
  return (
    <div className="grid size-full place-items-center bg-bg">
      <div className="size-7 animate-spin rounded-full border-2 border-gold/25 border-t-gold" />
    </div>
  );
}

export function App() {
  const [authed, setAuthed] = useState(true);
  const [route, navigate, replace, back] = useRouteState<{ tab: Tab; overlay: Overlay; folder: LibraryFolder | null }>({
    tab: "feed",
    overlay: null,
    folder: null,
  });
  const { tab, overlay } = route;
  const [libraryOpened, setLibraryOpened] = useState(false);
  const [favoritesOpened, setFavoritesOpened] = useState(false);
  const prevTabRef = useRef<Tab>(tab);
  const direction = TAB_ORDER.indexOf(tab) >= TAB_ORDER.indexOf(prevTabRef.current) ? 1 : -1;
  useEffect(() => { prevTabRef.current = tab; }, [tab]);
  useEffect(() => { if (authed) void bootstrapRatings(); }, [authed]);

  const setTab = (next: Tab) => {
    if (next === tab) return;
    if (next === "library") setLibraryOpened(true);
    if (next === "favorites") setFavoritesOpened(true);
    navigate({ ...route, tab: next, overlay: null });
  };

  const [closed, setClosed] = useState(0);
  const previousOverlay = useRef(overlay);
  useEffect(() => {
    const changed = () => setClosed(value => value + 1);
    window.addEventListener("ppvio:tags-changed", changed);
    return () => window.removeEventListener("ppvio:tags-changed", changed);
  }, []);
  useEffect(() => {
    if (previousOverlay.current && !overlay) setClosed(n => n + 1);
    previousOverlay.current = overlay;
  }, [overlay]);

  const close = () => back();
  const show = (kind: "history" | "channels" | "premium" | "tags" | "queue") => navigate({ ...route, overlay: { kind } });
  const playQueue = (ids: string[], index: number) => navigate({ ...route, overlay: { kind: "queue-player", ids, index } });
  const onUnauthorized = useCallback(() => setAuthed(false), []);
  const open = (items: Media[], index: number, _more?: () => void, at?: number) => {
    const picked = overlayFor(items, index);
    navigate({ ...route, tab, overlay: picked && (picked.kind === "clips" || picked.kind === "long") ? { ...picked, at } : picked });
  };

  if (!authed) {
    return (
      <MotionConfig reducedMotion="user">
        <Login onDone={() => setAuthed(true)} />
      </MotionConfig>
    );
  }

  return (
    <MotionConfig reducedMotion="user">
      {/* Direction A: Strict single-viewport 100dvh Darkroom Folio Shell (zero vertical scrolling) */}
      <div className="cinema-aura flex h-dvh w-full flex-col overflow-hidden bg-bg text-ink">
        {/* Top Architectural Folio Navigation — COMPLETELY OUTSIDE ALL VIDEO FRAMES */}
        {!overlay && (
          <header className="z-20 flex h-13 shrink-0 items-center justify-between gap-3 border-b border-line bg-bg/95 px-4 pt-[env(safe-area-inset-top)] sm:h-14 sm:px-8">
            <span className="hidden text-[15px] font-semibold tracking-[-0.02em] text-ink sm:inline">PPVIO</span>
            <nav aria-label="导航" className="mx-auto flex items-center gap-6 sm:gap-9">
              {TAB_ORDER.map(key => {
                const active = tab === key;
                return (
                  <motion.button
                    key={key}
                    type="button"
                    onClick={() => setTab(key)}
                    aria-current={active ? "page" : undefined}
                    whileTap={{ scale: 0.94 }}
                    transition={SPRING_TAP}
                    className={`relative flex h-13 items-center text-[15px] tracking-[-0.01em] transition-colors sm:h-14 ${
                      active ? "font-semibold text-ink" : "font-normal text-muted hover:text-ink"
                    }`}
                  >
                    <span>{TAB_LABELS[key]}</span>
                    {active && (
                      <motion.span
                        layoutId="ppvio-folio-tab"
                        transition={SPRING_PILL}
                        className="absolute inset-x-0 bottom-0 h-[2px] bg-gold"
                      />
                    )}
                  </motion.button>
                );
              })}
            </nav>
            <div className="flex w-10 items-center justify-end">
              {tab !== "feed" && <BlurToggle />}
            </div>
          </header>
        )}

        {/* Primary Single-Viewport Horizontal Folio Stage */}
        <div className="relative min-h-0 flex-1 overflow-hidden">
          <div hidden={tab !== "feed" || !!overlay} className="size-full">
            <Feed onUnauthorized={onUnauthorized} enabled={tab === "feed" && !overlay} />
          </div>

          <Suspense fallback={<PageFallback />}>
            {libraryOpened && (
              <div hidden={tab !== "library"} className="size-full">
                <motion.div
                  className="size-full"
                  initial={false}
                  animate={tab === "library" ? { opacity: 1, x: 0 } : { opacity: 0, x: direction * -28 }}
                  transition={SPRING_STAGE}
                >
                  <Library
                    selectedFolder={route.folder}
                    onFolderChange={folder => navigate({ ...route, folder })}
                    onOpen={open}
                    refresh={closed}
                    onBookmarks={() => navigate({ ...route, tab, overlay: { kind: "bookmarks" } })}
                    onCuration={() => navigate({ ...route, tab, overlay: { kind: "curation" } })}
                    onHistory={() => show("history")}
                    onChannels={() => show("channels")}
                    onPremium={() => show("premium")}
                    onQueue={() => show("queue")}
                    onMultiView={() => navigate({ ...route, tab, overlay: { kind: "multiview" } })}
                    onLoops={() => navigate({ ...route, tab, overlay: { kind: "loops" } })}
                  />
                </motion.div>
              </div>
            )}

            {favoritesOpened && (
              <div hidden={tab !== "favorites"} className="size-full">
                <motion.div
                  className="size-full"
                  initial={false}
                  animate={tab === "favorites" ? { opacity: 1, x: 0 } : { opacity: 0, x: direction * -28 }}
                  transition={SPRING_STAGE}
                >
                  <TagCollections
                    onOpen={open}
                    onManage={() => show("tags")}
                    refresh={closed}
                    notice={tab === "favorites" && !overlay ? <TagFilingNotice /> : undefined}
                  />
                </motion.div>
              </div>
            )}

            {tab === "settings" && (
              <motion.div
                key="folio-settings"
                className="size-full"
                initial={{ opacity: 0, x: direction * 32 }}
                animate={{ opacity: 1, x: 0 }}
                transition={SPRING_STAGE}
              >
                <Settings
                  onLoggedOut={onUnauthorized}
                  onDuplicates={() => navigate({ ...route, tab, overlay: { kind: "duplicates" } })}
                />
              </motion.div>
            )}

            <AnimatePresence>
              {overlay?.kind === "clips" && (
                <motion.div key="ov-clips" className="fixed inset-0 z-30 bg-bg"
                  initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.97 }} transition={SPRING_STAGE}>
                  <OverlayClips items={overlay.items} start={overlay.index} onClose={close} at={overlay.at} />
                </motion.div>
              )}
              {overlay?.kind === "long" && overlay.items[overlay.index] && (
                <DismissibleOverlay key={`ov-long-${overlay.items[overlay.index].id}`} onClose={close}>
                  <LongPlayer
                    key={overlay.items[overlay.index].id}
                    media={overlay.items[overlay.index]}
                    next={overlay.items[overlay.index + 1]}
                    onClose={close}
                    startAt={overlay.at}
                    onNext={() => replace({ ...route, tab, overlay: { ...overlay, at: undefined, index: overlay.index + 1 } })}
                  />
                </DismissibleOverlay>
              )}
              {overlay?.kind === "duplicates" && (
                <OverlaySheet key="ov-dupes"><Duplicates onClose={close} /></OverlaySheet>
              )}
              {overlay?.kind === "bookmarks" && (
                <OverlaySheet key="ov-bookmarks">
                  <BookmarkWall onBack={close} onOpen={(media, at) => open([media], 0, undefined, at)} onLoop={tagId => navigate({ ...route, overlay: { kind: "loops", tagId } })} />
                </OverlaySheet>
              )}
              {overlay?.kind === "loops" && (
                <motion.div key="ov-loops" className="fixed inset-0 z-30 bg-bg"
                  initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.97 }} transition={SPRING_STAGE}>
                  <BookmarkLoopFeed onClose={close} tagId={overlay.tagId} />
                </motion.div>
              )}
              {overlay?.kind === "multiview" && (
                <motion.div key="ov-multiview" className="fixed inset-0 z-30 bg-bg"
                  initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.97 }} transition={SPRING_STAGE}>
                  <MultiView onBack={close} onOpen={open} />
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
                <motion.div key="ov-qp" className="fixed inset-0 z-30 bg-bg"
                  initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.97 }} transition={SPRING_STAGE}>
                  <QueuePlayer ids={overlay.ids} start={overlay.index} onClose={close} />
                </motion.div>
              )}
            </AnimatePresence>
          </Suspense>
        </div>
      </div>

      <Toasts />
      <PrivacyGuard />
    </MotionConfig>
  );
}

function OverlaySheet({ children }: { children: React.ReactNode }) {
  return (
    <motion.div
      className="cinema-aura fixed inset-0 z-30 overflow-y-auto bg-bg"
      style={{ backgroundColor: "#050507" }}
      initial={{ opacity: 0, x: 32 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 24 }}
      transition={SPRING_STAGE}
    >
      {children}
    </motion.div>
  );
}

function OverlayClips({ items, start, onClose, at }: { items: Media[]; start: number; onClose: () => void; at?: number }) {
  const [list, setList] = useState(items);
  return <ClipList items={list} setItems={setList} start={start} onClose={onClose} startAt={at} />;
}
