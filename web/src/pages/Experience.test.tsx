import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Media } from "../api";
import { getHistorySettings } from "../experienceApi";
import { History } from "./History";
import { Channels } from "./Channels";
import { TagManager } from "./TagManager";

let root: Root, box: HTMLDivElement, calls: { path: string; method: string; body: any }[];
let serve: (path: string, method: string, body: any) => Response | Promise<Response>;
let epoch = 100;
const tags = [{ id: 1, name: "风景", count: 2, aliases: [], parent_id: null }, { id: 2, name: "旅行", count: 1, aliases: [], parent_id: null }];
const filters = { include_tags: [1], exclude_tags: [], match: "all", watched: "all", min_seconds: null, max_seconds: null, category: "all", premium_only: false, sort: "newest" };
const channel = { id: "one", name: "风景频道", filters, created_at: 1, updated_at: 1 };
const media = (id: string): Media => ({ id, width: 360, height: 640, duration_seconds: 90, stream_url: "/stream", cover_url: "/cover", variants: [], favorite: false, deletable: false, category: "short" });
const historyItem = (id: string) => ({ ...media(id), seen_at: Math.floor(Date.now() / 1000), position_seconds: 37 });
const click = async (label: string) => act(async () => {
  const el = box.querySelector<HTMLElement>(`[aria-label="${label}"]`); expect(el, label).not.toBeNull(); el!.click();
});
const change = async (label: string, value: string) => act(async () => {
  const el = box.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)!; expect(el, label).not.toBeNull();
  const proto = el.tagName === "SELECT" ? HTMLSelectElement.prototype : el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event(el.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
});
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); calls = []; epoch += 10;
  vi.stubGlobal("IntersectionObserver", class { observe() {} disconnect() {} });
  serve = (path, method) => {
    if (path === "/api/v1/tags" || path === "/api/v1/tag-catalog") return Response.json({ items: tags });
    if (path === "/api/v1/history/settings") return Response.json({ enabled: true, epoch });
    if (path.startsWith("/api/v1/history?")) return Response.json({ items: [historyItem("first")], has_more: false });
    if (path === "/api/v1/channels") return Response.json({ items: [channel] });
    if (path.includes("/items?") || path === "/api/v1/channels/query") return Response.json({ items: [media("first")], has_more: false });
    throw new Error(`Unexpected ${method} ${path}`);
  };
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    const method = init?.method ?? "GET", body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path: input, method, body }); return serve(input, method, body);
  });
  box = document.createElement("div"); document.body.append(box); root = createRoot(box);
});
afterEach(async () => { await act(async () => root.unmount()); box.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("groups history by date, keeps covers blurred and resumes the selected original at its saved position", async () => {
  const open = vi.fn();
  await act(async () => root.render(<History onBack={() => {}} onOpen={open} />));
  expect(box.querySelector("h2")?.textContent).toBe("今天");
  expect(box.querySelector("img")?.className).toContain("blur-xl");
  await click("继续观看第 1 个视频");
  expect(open.mock.calls[0][0][0].id).toBe("first"); expect(open.mock.calls[0][1]).toBe(0); expect(open.mock.calls[0][3]).toBe(37);
});

it("clear requires confirmation, advances cached history epoch and rejects a late appended page", async () => {
  let resolve!: (value: Response) => void;
  const base = serve;
  serve = (path, method, body) => {
    if (method === "DELETE") return Response.json({ enabled: true, epoch: ++epoch });
    if (path.startsWith("/api/v1/history?")) return path.includes("offset=0")
      ? Response.json({ items: [historyItem("first")], has_more: true }) : new Promise(r => { resolve = r; });
    return base(path, method, body);
  };
  await act(async () => root.render(<History onBack={() => {}} onOpen={() => {}} />));
  await click("加载更多历史"); await click("清空观看历史");
  expect(calls.filter(c => c.method === "DELETE")).toHaveLength(0);
  await click("确认清空历史");
  await act(async () => resolve(Response.json({ items: [historyItem("stale")], has_more: false })));
  expect(box.querySelector("img")).toBeNull(); expect(getHistorySettings()?.epoch).toBe(epoch);
});

it("failed history preference changes keep the current value and allow a retry", async () => {
  const base = serve; let fail = true;
  serve = (path, method, body) => method === "PUT" ? fail ? new Response("failed", { status: 500 }) : Response.json({ enabled: body.enabled, epoch: ++epoch }) : base(path, method, body);
  await act(async () => root.render(<History onBack={() => {}} onOpen={() => {}} />));
  await click("记录观看历史"); expect(box.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("true");
  fail = false; await click("记录观看历史");
  expect(box.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("false"); expect(getHistorySettings()).toEqual({ enabled: false, epoch });
});

it("creates a named dynamic channel with distinct include/exclude tags and bounded filter fields", async () => {
  const base = serve;
  serve = (path, method, body) => path === "/api/v1/channels" && method === "POST" ? Response.json({ ...channel, id: "new", name: body.name, filters: body.filters }) : base(path, method, body);
  await act(async () => root.render(<Channels onBack={() => {}} onOpen={() => {}} />));
  await click("新建频道"); await change("频道名称", "旅途"); await click("包含标签 风景"); await click("排除标签 旅行");
  await change("标签匹配", "any"); await change("观看状态", "unwatched"); await change("最短时长（秒）", "60"); await change("最长时长（秒）", "300");
  await click("只看精品"); await change("视频分类", "short"); await change("频道排序", "longest"); await click("保存频道");
  const write = calls.find(c => c.method === "POST" && c.path === "/api/v1/channels")!;
  expect(write.body).toEqual({ name: "旅途", filters: { include_tags: [1], exclude_tags: [2], match: "any", watched: "unwatched", min_seconds: 60, max_seconds: 300, category: "short", premium_only: true, sort: "longest" } });
  expect(box.textContent).toContain("旅途");
});

it("queries built-in premium without saving a channel and opens the entire loaded page", async () => {
  const open = vi.fn(); const base = serve;
  serve = (path, method, body) => path === "/api/v1/channels/query" ? Response.json({ items: [media("a"), media("b")], has_more: false }) : base(path, method, body);
  await act(async () => root.render(<Channels premiumOnly onBack={() => {}} onOpen={open} />));
  expect(calls.find(c => c.path === "/api/v1/channels/query")?.body.filters.premium_only).toBe(true);
  await click("播放第 2 个视频"); expect(open.mock.calls[0][0].map((m: Media) => m.id)).toEqual(["a", "b"]); expect(open.mock.calls[0][1]).toBe(1);
});

it("requires an explicit channel retry after an error and ignores responses after selecting another channel", async () => {
  const base = serve; let resolve!: (value: Response) => void, first = true;
  serve = (path, method, body) => {
    if (path.includes("/one/items?")) return new Promise(r => { resolve = r; });
    if (path === "/api/v1/channels/query") { if (first) { first = false; return new Response("fail", { status: 500 }); } return Response.json({ items: [media("fresh")], has_more: false }); }
    return base(path, method, body);
  };
  await act(async () => root.render(<Channels onBack={() => {}} onOpen={() => {}} />));
  await click("打开频道 风景频道"); await click("返回频道列表"); await click("浏览精品");
  await act(async () => resolve(Response.json({ items: [media("stale")], has_more: false })));
  expect(box.querySelector("img")).toBeNull(); await click("重试加载"); expect(box.querySelectorAll("img")).toHaveLength(1);
});

it("keeps tag edits after failure, saves aliases and an explicit parent, and confirms destructive deletion", async () => {
  const base = serve; let fail = true;
  serve = (path, method, body) => {
    if (method === "PATCH") return fail ? new Response("conflict", { status: 409 }) : Response.json({ ...tags[0], ...body });
    if (method === "DELETE") return Response.json({ deleted: true });
    return base(path, method, body);
  };
  await act(async () => root.render(<TagManager onBack={() => {}} />));
  await click("编辑标签 风景"); await change("标签名称", "山野"); await change("标签别名", "自然\n户外"); await change("父标签", "2"); await click("保存标签");
  expect(box.querySelector<HTMLInputElement>('[aria-label="标签名称"]')?.value).toBe("山野");
  fail = false; await click("保存标签");
  expect(calls.find(c => c.method === "PATCH")?.body).toEqual({ name: "山野", aliases: ["自然", "户外"], parent_id: 2 });
  await click("编辑标签 山野"); await click("删除标签"); expect(calls.filter(c => c.method === "DELETE")).toHaveLength(0);
  await click("确认删除标签"); expect(calls.at(-1)?.path).toBe("/api/v1/tags/1");
});

it("merges only after choosing a different destination and confirming the source and target", async () => {
  const base = serve;
  serve = (path, method, body) => path === "/api/v1/tag-catalog/merge" ? Response.json({ items: [tags[1]] }) : base(path, method, body);
  await act(async () => root.render(<TagManager onBack={() => {}} />));
  await click("编辑标签 风景"); await click("合并标签");
  expect(box.querySelector<HTMLButtonElement>('[aria-label="继续合并标签"]')?.disabled).toBe(true);
  await change("合并到标签", "2"); await click("继续合并标签");
  expect(box.querySelector('[role="dialog"]')?.textContent).toContain("风景"); expect(box.querySelector('[role="dialog"]')?.textContent).toContain("旅行");
  await click("确认合并标签");
  expect(calls.find(c => c.path === "/api/v1/tag-catalog/merge")?.body).toEqual({ source_ids: [1], target_id: 2 });
});

it("retries history from the failed offset and reloads from zero after deleting a record in Strict Mode", async () => {
  const base = serve; let removed = false, fail = true;
  serve = (path, method, body) => {
    if (method === "DELETE") { removed = true; return Response.json({ enabled: true, epoch: ++epoch }); }
    if (path.startsWith("/api/v1/history?")) {
      if (fail) return new Response("failed", { status: 500 });
      return Response.json({ items: removed ? [] : [historyItem("first")], has_more: false });
    }
    return base(path, method, body);
  };
  await act(async () => root.render(<StrictMode><History onBack={() => {}} onOpen={() => {}} /></StrictMode>));
  expect(box.querySelector('[role="alert"]')).not.toBeNull(); fail = false; await click("重试历史列表");
  expect(box.querySelectorAll("img")).toHaveLength(1); await click("删除第 1 条历史");
  expect(box.querySelector("img")).toBeNull(); expect(calls.at(-1)?.path).toContain("offset=0");
});

it("retains channel edits after a save failure and deletes only after confirmation", async () => {
  const base = serve; let fail = true;
  serve = (path, method, body) => method === "PATCH" ? fail ? new Response("failed", { status: 500 }) : Response.json({ ...channel, ...body })
    : method === "DELETE" ? Response.json({ deleted: true }) : base(path, method, body);
  await act(async () => root.render(<Channels onBack={() => {}} onOpen={() => {}} />));
  await click("编辑频道 风景频道"); await change("频道名称", "新频道"); await change("最短时长（秒）", "100"); await change("最长时长（秒）", "50");
  await click("保存频道"); expect(calls.filter(c => c.method === "PATCH")).toHaveLength(0);
  await change("最长时长（秒）", "200"); await click("保存频道");
  expect(box.querySelector<HTMLInputElement>('[aria-label="频道名称"]')?.value).toBe("新频道");
  fail = false; await click("保存频道"); await click("编辑频道 新频道"); await click("删除频道");
  expect(calls.filter(c => c.method === "DELETE")).toHaveLength(0); await click("确认删除频道");
  expect(calls.find(c => c.method === "DELETE")?.path).toBe("/api/v1/channels/one");
  expect(box.querySelector('[aria-label="打开频道 新频道"]')).toBeNull();
});

it("caps each channel tag group independently at twenty selections", async () => {
  const base = serve;
  serve = (path, method, body) => path === "/api/v1/tags" ? Response.json({ items: Array.from({ length: 21 }, (_, index) => ({ id: index + 1, name: `标签${index + 1}`, count: 1 })) }) : base(path, method, body);
  await act(async () => root.render(<Channels onBack={() => {}} onOpen={() => {}} />)); await click("新建频道");
  for (let index = 1; index <= 20; index++) await click(`包含标签 标签${index}`);
  expect(box.querySelector<HTMLInputElement>('[aria-label="包含标签 标签21"]')?.disabled).toBe(true);
  expect(box.querySelector<HTMLInputElement>('[aria-label="排除标签 标签21"]')?.disabled).toBe(false);
  await click("包含标签 标签1"); expect(box.querySelector<HTMLInputElement>('[aria-label="包含标签 标签21"]')?.disabled).toBe(false);
});

it("excludes descendants from parent choices and rejects more than ten aliases without discarding edits", async () => {
  const base = serve;
  serve = (path, method, body) => path === "/api/v1/tag-catalog" ? Response.json({ items: [tags[0], { ...tags[1], parent_id: 1 }] }) : base(path, method, body);
  await act(async () => root.render(<TagManager onBack={() => {}} />)); await click("编辑标签 风景");
  expect([...box.querySelectorAll<HTMLOptionElement>('[aria-label="父标签"] option')].map(option => option.value)).toEqual([""]);
  await change("标签别名", Array.from({ length: 11 }, (_, index) => `别名${index}`).join("\n")); await click("保存标签");
  expect(calls.filter(c => c.method === "PATCH")).toHaveLength(0); expect(box.querySelector<HTMLTextAreaElement>('[aria-label="标签别名"]')?.value).toContain("别名10");
});

it("creates a tag through the existing endpoint and keeps a failed name available to retry", async () => {
  const base = serve; let fail = true;
  serve = (path, method, body) => path === "/api/v1/tags" && method === "POST" ? fail ? new Response("failed", { status: 500 }) : Response.json({ id: 3, name: body.name, count: 0 }) : base(path, method, body);
  await act(async () => root.render(<TagManager onBack={() => {}} />)); await click("新建标签"); await change("标签名称", "自然"); await click("保存标签");
  expect(box.querySelector<HTMLInputElement>('[aria-label="标签名称"]')?.value).toBe("自然"); fail = false; await click("保存标签");
  expect(calls.find(c => c.path === "/api/v1/tags" && c.method === "POST")?.body).toEqual({ name: "自然" });
  expect(box.querySelector('[aria-label="编辑标签 自然"]')).not.toBeNull();
});

it("does not let an earlier channel-list retry overwrite a newly saved edit", async () => {
  const base = serve; let rereading = false, resolve!: (value: Response) => void;
  serve = (path, method, body) => {
    if (path === "/api/v1/tags") return new Response("failed", { status: 500 });
    if (path === "/api/v1/channels" && rereading) return new Promise(r => { resolve = r; });
    if (method === "PATCH") return Response.json({ ...channel, ...body });
    return base(path, method, body);
  };
  await act(async () => root.render(<Channels onBack={() => {}} onOpen={() => {}} />));
  rereading = true; await click("重试频道列表");
  await act(async () => { serve = ((previous) => (path: string, method: string, body: any) => path === "/api/v1/tags" ? Response.json({ items: tags }) : previous(path, method, body))(serve); });
  await act(async () => resolve(Response.json({ items: [channel] })));
  // A second list refresh is in flight while the retained row is edited.
  await click("重试频道列表");
  await click("编辑频道 风景频道"); await change("频道名称", "保留的新名称"); await click("保存频道");
  await act(async () => resolve(Response.json({ items: [channel] })));
  expect(box.querySelector('[aria-label="打开频道 保留的新名称"]')).not.toBeNull();
});
