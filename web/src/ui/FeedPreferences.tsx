import { SlidersHorizontalIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { api, type Tag } from "../api";
import { curationApi, type FeedPreferences } from "../curationApi";
import { Sheet } from "./Sheet";

export function FeedPreferencesButton({ onSaved }: { onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [tags, setTags] = useState<Tag[]>([]);
  const [value, setValue] = useState<FeedPreferences | null>(null);
  const [error, setError] = useState(false);
  const [saving, setSaving] = useState(false);
  const session = useRef<{ controller: AbortController; saving: boolean } | null>(null);
  const cancel = () => { session.current?.controller.abort(); session.current = null; };
  useEffect(() => cancel, []);
  const close = () => { if (session.current?.saving) return; cancel(); setOpen(false); setSaving(false); };
  const load = async () => {
    cancel();
    const current = { controller: new AbortController(), saving: false }; session.current = current;
    setOpen(true); setValue(null); setError(false); setSaving(false);
    try {
      const [all, prefs] = await Promise.all([api.tags(), curationApi.preferences(current.controller.signal)]);
      if (session.current !== current) return;
      const valid = new Set(all.items.map(tag => tag.id));
      const preferred = [...new Set(prefs.preferred_tags)].filter(id => valid.has(id)).slice(0, 20);
      setTags(all.items);
      setValue({ preferred_tags: preferred, excluded_tags: [...new Set(prefs.excluded_tags)]
        .filter(id => valid.has(id) && !preferred.includes(id)).slice(0, 20), mode: prefs.mode });
    } catch { if (session.current === current) setError(true); }
  };
  const save = async () => {
    const current = session.current;
    if (!current || current.saving || !value || (value.mode === "only" && !value.preferred_tags.length)) return;
    current.saving = true; setSaving(true); setError(false);
    try {
      await curationApi.savePreferences(value, current.controller.signal);
      if (session.current !== current) return;
      current.saving = false; close(); onSaved();
    } catch { if (session.current === current) setError(true); }
    finally { if (session.current === current) { current.saving = false; setSaving(false); } }
  };
  const toggle = (field: "preferred_tags" | "excluded_tags", id: number) => {
    if (!value || saving) return;
    const other = field === "preferred_tags" ? "excluded_tags" : "preferred_tags";
    if (value[other].includes(id)) return;
    const selected = value[field];
    setValue({ ...value, [field]: selected.includes(id) ? selected.filter(tag => tag !== id)
      : selected.length < 20 ? [...selected, id] : selected });
  };
  return <>
    <button type="button" aria-label="刷流偏好" onClick={() => void load()}
      className="flex min-h-10 items-center justify-center gap-1.5 rounded-full bg-surface px-3 text-[13px]">
      <SlidersHorizontalIcon size={19} /><span>偏好</span>
    </button>
    <Sheet open={open} onClose={close} title="刷流偏好">
      <form className="space-y-4 px-3" onSubmit={event => { event.preventDefault(); void save(); }}>
        <p className="text-[13px] text-muted">偏好标签优先出现，排除标签不出现。每组最多 20 个。</p>
        {!value && !error && <p role="status" className="py-6 text-center text-muted">正在加载…</p>}
        {value && <>
          <fieldset disabled={saving} className="space-y-2">
            <legend className="mb-2 text-[14px] font-semibold">刷流方式</legend>
            {([["mixed", "偏好优先，混合其他内容"], ["only", "仅偏好标签"]] as const).map(([mode, label]) =>
              <label key={mode} className="flex min-h-10 items-center gap-3 text-[14px]">
                <input type="radio" name="feed-mode" aria-label={mode === "only" ? "仅偏好标签" : "混合模式"}
                  checked={value.mode === mode} onChange={() => setValue({ ...value, mode })} />{label}
              </label>)}
          </fieldset>
          {value.mode === "only" && !value.preferred_tags.length && <p className="text-[13px] text-accent">仅偏好模式至少选择一个偏好标签。</p>}
          {([["preferred_tags", "偏好", "excluded_tags"], ["excluded_tags", "排除", "preferred_tags"]] as const).map(([field, label, other]) =>
            <fieldset key={field} disabled={saving}>
              <legend className="mb-2 text-[14px] font-semibold">{label}标签 · {value[field].length}/20</legend>
              <div className="grid grid-cols-2 gap-x-3">
                {tags.map(tag => <label key={tag.id} className="flex min-h-10 min-w-0 items-center gap-2 text-[14px] has-disabled:text-faint">
                  <input type="checkbox" aria-label={`${label} ${tag.name}`} checked={value[field].includes(tag.id)}
                    disabled={value[other].includes(tag.id) || (!value[field].includes(tag.id) && value[field].length >= 20)}
                    onChange={() => toggle(field, tag.id)} /><span className="truncate">{tag.name}</span>
                </label>)}
              </div>
              {!tags.length && <p className="text-[13px] text-muted">还没有标签，可在播放器中添加。</p>}
            </fieldset>)}
        </>}
        {error && <div role="alert" className="text-[13px] text-accent">
          {value ? "保存失败，已保留选择，请重试。" : "偏好加载失败。"}
          {!value && <button type="button" aria-label="重试偏好设置" onClick={() => void load()} className="ml-3 min-h-10 underline">重试</button>}
        </div>}
        <div className="sticky bottom-0 flex gap-2 bg-surface py-2">
          <button type="button" aria-label="取消偏好设置" disabled={saving} onClick={close} className="min-h-11 flex-1 rounded-full bg-raised text-[14px] disabled:opacity-40">取消</button>
          <button type="submit" disabled={!value || saving || (value.mode === "only" && !value.preferred_tags.length)}
            className="min-h-11 flex-1 rounded-full bg-ink text-[14px] font-semibold text-bg disabled:opacity-40">{saving ? "保存中…" : "保存偏好"}</button>
        </div>
      </form>
    </Sheet>
  </>;
}
