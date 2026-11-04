import { useEffect, useRef, useState, type RefObject } from "react";
import { type Media } from "../api";
import { Sheet, SheetButton } from "../ui/Sheet";
import { toast } from "../ui/toast";
import { ManualCoverPicker } from "../ui/ManualCoverPicker";
import { QuickTagPanel } from "../ui/QuickTags";
import { announce } from "../ui/Grid";
import { addToQueue, getQueue } from "../queue";

type Step = "menu" | "tags" | "cover";
export function MediaActions({ media, open, onClose, onRemove, video }: {
  media: Media; open: boolean; onClose: () => void; onRemove?: (media: Media) => void; video?: RefObject<HTMLVideoElement | null>;
}) {
  const [step, setStep] = useState<Step>("menu");
  const [premium, setPremium] = useState(!!media.premium), [saving, setSaving] = useState(false);
  const generation = useRef(0);
  useEffect(() => { if (open) setStep("menu"); }, [open]);
  useEffect(() => { generation.current++; setPremium(!!media.premium); return () => { generation.current++; }; }, [media.id, media.premium]);
  const togglePremium = async () => {
    if (saving) return;
    const token = generation.current; setSaving(true);
    try {
      const response = await fetch(`/api/v1/media/${media.id}/premium`, { method: "PUT", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ premium: !premium }) });
      if (!response.ok) throw new Error();
      announce({ id: media.id, premium: !premium });
      if (generation.current === token) { setPremium(!premium); toast(premium ? "已改为普通" : "已标为精品"); }
    } catch { if (generation.current === token) toast("精品状态未保存，请重试"); }
    finally { if (generation.current === token) setSaving(false); }
  };
  return <Sheet open={open} onClose={onClose} title={step === "tags" ? "标签收藏" : step === "cover" ? "选择封面" : undefined}>
    {step === "menu" && <>
      <SheetButton onClick={() => setStep("tags")}>标签收藏</SheetButton>
      <SheetButton onClick={() => { toast(addToQueue(media) ? "已加入待播队列" : getQueue().length >= 100 ? "队列已满，最多100个" : "已在待播队列中"); onClose(); }}>加入待播队列</SheetButton>
      {video && <SheetButton onClick={() => setStep("cover")}>选择封面</SheetButton>}
      <SheetButton onClick={() => void togglePremium()}>{saving ? "保存中…" : premium ? "改为普通" : "标为精品"}</SheetButton>
      {onRemove && <SheetButton danger onClick={() => { onClose(); onRemove(media); }}>删除（网盘里的文件也会删掉）</SheetButton>}
    </>}
    {step === "tags" && <QuickTagPanel media={media} onDone={onClose} />}
    {step === "cover" && video && <ManualCoverPicker embedded media={media} video={video} onClose={onClose} onSaved={updated => { announce({ id: media.id, cover_url: updated.cover_url }); toast("封面已更新"); onClose(); }} />}
  </Sheet>;
}
