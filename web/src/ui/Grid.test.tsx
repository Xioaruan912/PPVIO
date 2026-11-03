import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Media, Page } from "../api";
import { mediaTools } from "../mediaTools";
import { Grid, usePages } from "./Grid";

const media = (id: string): Media => ({ id, stream_url: `/${id}`, cover_url: null, width: 360, height: 640,
  duration_seconds: 30, variants: [], favorite: false, deletable: false, category: "short" });
function pending() {
  let resolve!: (page: Page) => void, reject!: (error: Error) => void;
  const promise = new Promise<Page>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
let root: Root, container: HTMLDivElement, pages: ReturnType<typeof usePages>;
function Wall({ query, fetchPage }: { query: string; fetchPage: (cursor: string | null, offset: number) => Promise<Page> }) {
  pages = usePages(fetchPage, query);
  useEffect(() => { void pages.more(); }, [query]);
  return <Grid items={pages.items} done={pages.done} error={pages.error} onRetry={() => void pages.retry()}
    onEnd={() => void pages.more()} onOpen={() => {}} />;
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal("IntersectionObserver", class { observe() {} disconnect() {} });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("opens an explicit card preview without nested buttons and forwards its timestamp", async () => {
  vi.spyOn(mediaTools, "preparePreview").mockResolvedValue({ state: "ready", frames: [{ index: 0, at: 12, url: "/frame.jpg" }] });
  let opened: [number, number | undefined] | undefined;
  await act(async () => root.render(<Grid items={[media("a")]} done onEnd={() => {}}
    onOpen={(index, at) => { opened = [index, at]; }} />));
  expect(container.querySelector("button button")).toBeNull();
  const preview = container.querySelector<HTMLButtonElement>('button[aria-label="预览画面"]');
  expect(preview).not.toBeNull();
  await act(async () => preview!.click());
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="从 0:12 播放"]')!.click());
  expect(opened).toEqual([0, 12]);
});

describe("media pagination", () => {
  it("rejects an old A response after A to B to A and ignores obsolete errors", async () => {
    const a = pending(), b = pending(), current = pending();
    await act(async () => root.render(<Wall query="a" fetchPage={() => a.promise} />));
    await act(async () => root.render(<Wall query="b" fetchPage={() => b.promise} />));
    await act(async () => root.render(<Wall query="a" fetchPage={() => current.promise} />));
    await act(async () => a.resolve({ items: [media("obsolete")], has_more: false }));
    await act(async () => b.reject(new Error("obsolete failure")));
    expect(pages.items).toEqual([]);
    expect(pages.done).toBe(false);
    expect(pages.error).toBe(false);
    await act(async () => current.resolve({ items: [media("current")], has_more: false }));
    expect(pages.items.map(item => item.id)).toEqual(["current"]);
  });

  it("loads a new query even when the previous query was finished", async () => {
    const offsets: number[] = [];
    const fetchPage = async (_: string | null, offset: number) => {
      offsets.push(offset); return { items: [media(String(offsets.length))], has_more: false };
    };
    await act(async () => root.render(<Wall query="a" fetchPage={fetchPage} />));
    await act(async () => root.render(<Wall query="b" fetchPage={fetchPage} />));
    expect(offsets).toEqual([0, 0]);
    expect(pages.items.map(item => item.id)).toEqual(["2"]);
  });

  it("retains the failed offset, waits for explicit retry, and continues pagination", async () => {
    const offsets: number[] = [];
    let failures = 0;
    const fetchPage = async (_: string | null, offset: number): Promise<Page> => {
      offsets.push(offset);
      if (offset === 1 && failures++ === 0) throw new Error("offline");
      return { items: [media(String(offset))], has_more: offset < 1 };
    };
    await act(async () => root.render(<Wall query="a" fetchPage={fetchPage} />));
    await act(async () => pages.more());
    expect(pages.error).toBe(true);
    expect(pages.done).toBe(false);
    expect(pages.items.map(item => item.id)).toEqual(["0"]);
    await act(async () => pages.more());
    expect(offsets).toEqual([0, 1]);
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="重试加载"]')!.click());
    expect(offsets).toEqual([0, 1, 1]);
    expect(pages.error).toBe(false);
    expect(pages.items.map(item => item.id)).toEqual(["0", "1"]);
    expect(pages.done).toBe(true);
  });
});
