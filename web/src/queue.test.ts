import { beforeEach, expect, it } from "vitest";
import type { Media } from "./api";
import { addToQueue, clearQueue, getQueue, moveQueue, readQueue, removeFromQueue } from "./queue";

const media = (n: number) => ({ id: n.toString(16).padStart(64, "0"), cover_url: null, duration_seconds: 16, category: "short" }) as Media;
beforeEach(() => { localStorage.clear(); clearQueue(); });
it("keeps at most100 distinct originals and supports reordering/removing", () => {
  expect(addToQueue(media(1))).toBe(true); expect(addToQueue(media(1))).toBe(false);
  for (let n = 2; n <= 101; n++) addToQueue(media(n));
  expect(getQueue()).toHaveLength(100);
  moveQueue(media(2).id, -1); expect(getQueue()[0].id).toBe(media(2).id);
  removeFromQueue(media(2).id); expect(getQueue()).toHaveLength(99);
  clearQueue(); expect(getQueue()).toEqual([]);
});
it("rejects corrupt stored entries and tolerates inaccessible storage", () => {
  expect(readQueue("{")).toEqual([]);
  const entries = [media(1), media(1), { id: "../secret" }, { ...media(2), cover_url: "https://external.test/image" }];
  expect(readQueue(JSON.stringify(entries)).map(item => item.id)).toEqual([media(1).id, media(2).id]);
  expect(readQueue(JSON.stringify(entries))[1].cover_url).toBeNull();
});
