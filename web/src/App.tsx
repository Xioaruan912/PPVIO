import { GearSixIcon, TagIcon, PlayIcon, SquaresFourIcon } from "@phosphor-icons/react";
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

  if (!authed) return <Login onDone={() => setAuthed(true)} />;
  return (
    <>
      <div hidden={tab !== "feed" || !!overlay}><Feed onUnauthorized={onUnauthorized} enabled={tab === "feed" && !overlay} /></div>
      {libraryOpened && <div hidden={tab !== "library"}><Library selectedFolder={route.folder} onFolderChange={folder => navigate({ ...route, folder })} onOpen={open} refresh={closed} onBookmarks={() => navigate({ ...route, tab, overlay: { kind: "bookmarks" } })} onCuration={() => navigate({ ...route, tab, overlay: { kind: "curation" } })} onHistory={() => show("history")} onChannels={() => show("channels")} onPremium={() => show("premium")} onQueue={() => show("queue")} /></div>}
      {favoritesOpened && <div hidden={tab !== "favorites"}><TagCollections onOpen={open} onManage={() => show("tags")} refresh={closed} notice={tab === "favorites" && !overlay ? <TagFilingNotice /> : undefined} /></div>}
      {tab === "settings" && <Settings onLoggedOut={onUnauthorized} onDuplicates={() => navigate({ ...route, tab, overlay: { kind: "duplicates" } })} />}

      {overlay?.kind === "clips" && <OverlayClips items={overlay.items} start={overlay.index} onClose={close} at={overlay.at} />}
      {overlay?.kind === "long" && overlay.items[overlay.index] && (
        <LongPlayer key={overlay.items[overlay.index].id} media={overlay.items[overlay.index]} next={overlay.items[overlay.index + 1]} onClose={close}
          startAt={overlay.at} onNext={() => replace({ ...route, tab, overlay: { ...overlay, at: undefined, index: overlay.index + 1 } })} />
      )}
      {overlay?.kind === "duplicates" && <Duplicates onClose={close} />}

      {overlay?.kind === "bookmarks" && <div className="fixed inset-0 z-30 overflow-y-auto bg-bg"><BookmarkWall onBack={close} onOpen={(media, at) => open([media], 0, undefined, at)} onLoop={tagId => navigate({ ...route, overlay: { kind: "loops", tagId } })} /></div>}
      {overlay?.kind === "loops" && <BookmarkLoopFeed onClose={close} tagId={overlay.tagId} />}
      {overlay?.kind === "curation" && <div className="fixed inset-0 z-30 overflow-y-auto bg-bg"><Curation onBack={close} onOpen={open} /></div>}

      {overlay?.kind === "history" && <div className="fixed inset-0 z-30 overflow-y-auto bg-bg"><History onBack={close} onOpen={open} /></div>}
      {(overlay?.kind === "channels" || overlay?.kind === "premium") && <div className="fixed inset-0 z-30 overflow-y-auto bg-bg"><Channels onBack={close} onOpen={open} premiumOnly={overlay.kind === "premium"} onPlayQueue={items => playQueue(items.map(item => item.id), 0)} /></div>}
      {overlay?.kind === "tags" && <div className="fixed inset-0 z-30 overflow-y-auto bg-bg"><TagManager onBack={close} /></div>}
      {overlay?.kind === "queue" && <div className="fixed inset-0 z-30 overflow-y-auto bg-bg"><Queue onBack={close} onPlay={playQueue} /></div>}
      {overlay?.kind === "queue-player" && <QueuePlayer ids={overlay.ids} start={overlay.index} onClose={close} />}

      {!overlay && (
        <nav className={`fixed inset-x-0 bottom-0 z-10 flex justify-around px-2 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-6 ${tab === "feed" ? "bg-gradient-to-t from-black/80 to-transparent" : "border-t border-line bg-bg/90 pt-2 backdrop-blur-md"}`} aria-label="导航">
          <NavItem label="刷" active={tab === "feed"} onClick={() => setTab("feed")}><PlayIcon size={22} weight={tab === "feed" ? "fill" : "regular"} /></NavItem>
          <NavItem label="片库" active={tab === "library"} onClick={() => setTab("library")}><SquaresFourIcon size={22} weight={tab === "library" ? "fill" : "regular"} /></NavItem>
          <NavItem label="标签" active={tab === "favorites"} onClick={() => setTab("favorites")}><TagIcon size={22} weight={tab === "favorites" ? "fill" : "regular"} /></NavItem>
          <NavItem label="设置" active={tab === "settings"} onClick={() => setTab("settings")}><GearSixIcon size={22} weight={tab === "settings" ? "fill" : "regular"} /></NavItem>
        </nav>
      )}
      <Toasts />
      <PrivacyGuard />
    </>
  );
}

function OverlayClips({ items, start, onClose, at }: { items: Media[]; start: number; onClose: () => void; at?: number }) {
  const [list, setList] = useState(items);
  return <div className="fixed inset-0 z-30 bg-black"><ClipList items={list} setItems={setList} start={start} onClose={onClose} startAt={at} /></div>;
}

function NavItem({ label, active, onClick, children }: { label: string; active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} aria-current={active ? "page" : undefined}
      className={`flex w-16 flex-col items-center gap-0.5 text-[11px] transition-colors ${active ? "text-ink" : "text-faint"}`}>
      {children}{label}
    </button>
  );
}
