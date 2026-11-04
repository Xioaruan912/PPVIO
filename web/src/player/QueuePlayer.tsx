import { CaretLeftIcon, SkipBackIcon, SkipForwardIcon, ShuffleIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { api, type Media } from "../api";
import { FeedItem } from "../feed/FeedItem";
import { LongPlayer } from "./LongPlayer";
import { announce } from "../ui/Grid";

export function QueuePlayer({ ids, start, onClose }: { ids: string[]; start: number; onClose: () => void }) {
  const [index, setIndex] = useState(Math.max(0, Math.min(start, ids.length - 1)));
  const [loaded, setLoaded] = useState<{ index: number; media: Media; next?: Media } | null>(null);
  const [failed, setFailed] = useState(false), [retry, setRetry] = useState(0), [finished, setFinished] = useState(false);
  useEffect(() => {
    const controller = new AbortController(); setFailed(false); setFinished(false);
    if (!ids[index]) { setFailed(true); return; }
    void Promise.all([api.media(ids[index], controller.signal), ids[index + 1] ? api.media(ids[index + 1], controller.signal).catch(() => undefined) : undefined])
      .then(([media, next]) => { if (!controller.signal.aborted) setLoaded({ index, media, next }); })
      .catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [ids, index, retry]);
  const current = loaded?.index === index ? loaded : null;
  const next = () => { if (index < ids.length - 1) setIndex(index + 1); else setFinished(true); };
  const setFavorite = (id: string, favorite: boolean) => {
    setLoaded(value => value && value.media.id === id ? { ...value, media: { ...value.media, favorite } } : value);
    announce({ id, favorite });
  };
  return <div className="fixed inset-0 z-30 bg-black text-white">
    {current ? current.media.category === "long" ? <LongPlayer key={current.media.id} media={current.media} next={current.next} continueNext={index < ids.length - 1} onNext={next} onClose={onClose} />
      : <FeedItem key={current.media.id} media={current.media} active mounted onFavorite={setFavorite} onEnded={next} />
      : <div className="grid h-dvh place-items-center px-6 text-center text-sm"><div>{failed ? "这个视频暂时无法播放，可以重试或跳过。" : "正在读取视频…"}{failed && <button type="button" onClick={() => setRetry(value => value + 1)} className="mx-auto mt-4 block min-h-11 rounded-full bg-white/15 px-5">重试</button>}</div></div>}
    <div className="fixed inset-x-3 top-[calc(3.5rem+env(safe-area-inset-top))] z-40 mx-auto flex max-w-md items-center gap-1 rounded-full bg-black/70 px-2 backdrop-blur-md">
      <button type="button" aria-label="关闭队列播放" onClick={onClose} className="grid size-11 shrink-0 place-items-center"><CaretLeftIcon size={20} /></button><span className="flex-1 text-center text-xs">{finished ? "本次已播完" : "待播"} {index + 1}/{ids.length}</span>
      <button type="button" aria-label="上一条" disabled={index <= 0} onClick={() => setIndex(index - 1)} className="grid size-11 place-items-center disabled:opacity-30"><SkipBackIcon size={20} /></button>
      <button type="button" aria-label="随机一条" disabled={ids.length < 2} onClick={() => setIndex((index + 1 + Math.floor(Math.random() * (ids.length - 1))) % ids.length)} className="grid size-11 place-items-center disabled:opacity-30"><ShuffleIcon size={20} /></button>
      <button type="button" aria-label="下一条" disabled={index >= ids.length - 1} onClick={next} className="grid size-11 place-items-center disabled:opacity-30"><SkipForwardIcon size={20} /></button>
    </div>
  </div>;
}
