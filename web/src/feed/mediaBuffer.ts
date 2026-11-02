type BufferProbe = Pick<HTMLVideoElement, "buffered" | "currentTime" | "duration" | "playbackRate" | "readyState">;

/** Policy inspired by 91: reserve current playback before preloading another clip. */
export function preloadHighWater(bytesPerSecond: number): number {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return 12;
  return Math.min(12, Math.max(4, 4 * 1024 ** 2 / bytesPerSecond));
}

export function bufferedAhead(video: BufferProbe): number {
  for (let i = 0; i < video.buffered.length; i++) {
    if (video.buffered.start(i) <= video.currentTime && video.buffered.end(i) > video.currentTime) {
      return video.buffered.end(i) - video.currentTime;
    }
  }
  return 0;
}

export function allowNextPreload(video: BufferProbe, wasAllowed: boolean, bytesPerSecond = 0): boolean {
  if (video.readyState < 3 || !Number.isFinite(video.duration) || video.duration <= 0) return false;
  const ahead = bufferedAhead(video);
  const remaining = Math.max(0, video.duration - video.currentTime);
  if (remaining > 0 && ahead >= remaining - 0.1) return true;
  const high = preloadHighWater(bytesPerSecond);
  const reserve = wasAllowed ? Math.max(1.5, high / 3) : high;
  return ahead / Math.max(1, video.playbackRate) >= reserve;
}
