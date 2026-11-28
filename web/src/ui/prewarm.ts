import { chooseStream, type Media } from "../api";

const preparedAt = new Map<string, number>();
const warmedRangeAt = new Map<string, number>();
const COOLDOWN_MS = 60_000;

/**
 * Extract the opaque media ID targeted by a resolved stream URL (handles 480p variants too).
 */
export function targetIdForStream(media: Media, preferLow: boolean): { id: string; src: string } {
  const src = chooseStream(media, preferLow);
  const variant = media.variants.find(v => v.stream_url === src);
  return { id: variant?.id ?? media.id, src };
}

/**
 * Ask the server to warm faststart + head disk-cache chunks for an upcoming or hovered clip.
 * Cost-bounded and deduplicated so rapid scrolling or hovering never floods upstream.
 */
export function prewarmMedia(
  media: Media | undefined,
  preferLow: boolean,
  options: { rangeHead?: boolean; tail?: boolean } = {},
): void {
  if (!media || typeof fetch !== "function" || document.hidden) return;
  const { id, src } = targetIdForStream(media, preferLow);
  const now = Date.now();
  const key = `${id}:${options.tail ? "t" : "h"}`;
  if ((preparedAt.get(key) ?? 0) + COOLDOWN_MS <= now) {
    preparedAt.set(key, now);
    const qs = options.tail ? "?head=1&tail=1" : "?head=1";
    void fetch(`/api/v1/media/${id}/prepare${qs}`, {
      method: "POST",
      credentials: "same-origin",
      keepalive: true,
    }).catch(() => {
      preparedAt.delete(key);
    });
  }
  // Optional lightweight browser-cache head warm (first 512KB) using server's low-priority preload header
  if (options.rangeHead && src && (warmedRangeAt.get(src) ?? 0) + COOLDOWN_MS <= now) {
    warmedRangeAt.set(src, now);
    void fetch(src, {
      credentials: "same-origin",
      headers: {
        Range: "bytes=0-524287",
        "X-PPVIO-Preload": "1",
      },
    })
      .then(res => {
        if (res.body) void res.body.cancel().catch(() => undefined);
      })
      .catch(() => {
        warmedRangeAt.delete(src);
      });
  }
}
