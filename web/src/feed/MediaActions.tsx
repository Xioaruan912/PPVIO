import { useEffect, useState, type RefObject } from "react";
import { type Media } from "../api";
import { Sheet, SheetButton } from "../ui/Sheet";
import { toast } from "../ui/toast";
import { ManualCoverPicker } from "../ui/ManualCoverPicker";
import { QuickTagPanel } from "../ui/QuickTags";
import { announce } from "../ui/Grid";

type Step = "menu" | "tags" | "cover";

/** Pure minimal action sheet: Tags, Cover picker, Delete — zero duplicate ratings or bloat. */
export function MediaActions({ media, open, onClose, onRemove, video }: {
  media: Media; open: boolean; onClose: () => void; onRemove?: (media: Media) => void; video?: RefObject<HTMLVideoElement | null>;
}) {
  const [step, setStep] = useState<Step>("menu");
  useEffect(() => { if (open) setStep("menu"); }, [open]);

  return (
    <Sheet open={open} onClose={onClose} title={step === "tags" ? "标签收藏" : step === "cover" ? "选择封面" : undefined}>
      {step === "menu" && (
        <>
          <SheetButton onClick={() => setStep("tags")}>标签收藏</SheetButton>
          {video && <SheetButton onClick={() => setStep("cover")}>选择封面</SheetButton>}
          {onRemove && <SheetButton danger onClick={() => { onClose(); onRemove(media); }}>删除（网盘里的文件也会删掉）</SheetButton>}
        </>
      )}
      {step === "tags" && <QuickTagPanel media={media} onDone={onClose} />}
      {step === "cover" && video && (
        <ManualCoverPicker
          embedded
          media={media}
          video={video}
          onClose={onClose}
          onSaved={updated => { announce({ id: media.id, cover_url: updated.cover_url }); toast("封面已更新"); onClose(); }}
        />
      )}
    </Sheet>
  );
}
