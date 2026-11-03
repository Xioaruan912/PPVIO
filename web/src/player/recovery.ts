export type FailureKind = "auth" | "access" | "throttled" | "network" | "codec" | "unknown";
export interface PlaybackFailure { kind: FailureKind; message: string; retryable: boolean }

export function classifyFailure(status: number | undefined, mediaErrorCode?: number): PlaybackFailure {
  if (status === 401) return { kind: "auth", message: "登录已失效，请重新登录", retryable: false };
  if (status === 403 || status === 404 || status === 410) return { kind: "access", message: "视频暂时无法访问，请检查来源或权限", retryable: false };
  if (status === 429) return { kind: "throttled", message: "请求过于频繁，请稍后重试", retryable: false };
  if (status === 0 || (status !== undefined && status >= 300 && status < 400)) {
    return { kind: "unknown", message: "视频来源发生变化，请稍后重试", retryable: false };
  }
  if (status === 408 || status === 502 || status === 503 || status === 504) {
    return { kind: "network", message: "网络连接中断，请重试", retryable: true };
  }
  if (mediaErrorCode === 3 || mediaErrorCode === 4) {
    return { kind: "codec", message: "浏览器无法解码这个视频，可尝试兼容副本", retryable: false };
  }
  if (status === undefined || mediaErrorCode === 2) {
    return { kind: "network", message: "网络连接中断，请重试", retryable: true };
  }
  return { kind: "unknown", message: "视频暂时无法播放", retryable: false };
}

/** Diagnosis never consumes media or follows redirects. Caller cancellation rejects with AbortError. */
export async function diagnoseFailure(src: string, mediaErrorCode: number | undefined, signal: AbortSignal): Promise<PlaybackFailure> {
  if (signal.aborted) throw new DOMException("诊断已取消", "AbortError");
  let url: URL;
  try {
    url = new URL(src, window.location.href);
    if (!src || !["http:", "https:"].includes(url.protocol) || url.origin !== window.location.origin || url.username || url.password) {
      return classifyFailure(200);
    }
  } catch { return classifyFailure(200); }

  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  const timeout = window.setTimeout(abort, 5000);
  let response: Response | undefined;
  try {
    response = await fetch(url.href, { method: "GET", headers: { Range: "bytes=0-0" }, credentials: "same-origin",
      mode: "same-origin", redirect: "manual", cache: "no-store", signal: controller.signal });
    if (signal.aborted) throw new DOMException("诊断已取消", "AbortError");
    return classifyFailure(response.status, mediaErrorCode);
  } catch {
    if (signal.aborted) throw new DOMException("诊断已取消", "AbortError");
    return classifyFailure(undefined, mediaErrorCode);
  } finally {
    window.clearTimeout(timeout);
    signal.removeEventListener("abort", abort);
    void response?.body?.cancel().catch(() => undefined);
    controller.abort();
  }
}
