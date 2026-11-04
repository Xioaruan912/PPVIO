import { CaretLeftIcon, PencilSimpleIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { experienceApi, type CatalogTag } from "../experienceApi";
import { useLocked } from "../ui/privacy";
import { Sheet } from "../ui/Sheet";

const field = "min-h-11 w-full min-w-0 rounded-lg bg-bg px-3 text-sm disabled:opacity-50";
const button = "min-h-11 rounded-full bg-raised px-4 text-sm disabled:opacity-50";
const clean = (name: string) => name.trim().replace(/\s+/gu, " ");
const key = (name: string) => clean(name).replace(/[A-Z]/g, value => value.toLowerCase());

/** Check the entire tree because moving a parent can also make a child's chain too deep. */
function acceptsParent(tags: CatalogTag[], edited: number, parent: number | null): boolean {
  const parents = new Map(tags.map(tag => [tag.id, tag.id === edited ? parent : tag.parent_id]));
  return tags.every(tag => {
    const seen = new Set<number>(); let id: number | null = tag.id;
    while (id !== null) {
      if (seen.has(id) || !parents.has(id) || seen.size >= 8) return false;
      seen.add(id); id = parents.get(id) ?? null;
    }
    return true;
  });
}

export function TagManager({ onBack }: { onBack: () => void }) {
  const [tags, setTags] = useState<CatalogTag[]>([]), [selected, setSelected] = useState<CatalogTag | "new" | null>(null);
  const [loading, setLoading] = useState(false), [failed, setFailed] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const alive = useRef(true), generation = useRef(0), mutation = useRef(false), locked = useLocked();
  const load = async () => {
    const version = ++generation.current; setLoading(true); setFailed(false);
    try { const result = await experienceApi.tagCatalog(); if (alive.current && version === generation.current) setTags(result.items); }
    catch { if (alive.current && version === generation.current) setFailed(true); }
    finally { if (alive.current && version === generation.current) setLoading(false); }
  };
  useEffect(() => { alive.current = true; void load(); return () => { alive.current = false; ++generation.current; }; }, []);
  useEffect(() => { if (locked && !busy) setSelected(null); }, [locked, busy]);
  const close = () => { if (!mutation.current) { setSelected(null); setError(""); } };
  const mutate = async (kind: "save" | "delete" | "merge", value?: { name: string; aliases: string[]; parent_id: number | null }, target?: number) => {
    if (!selected || mutation.current || locked) return;
    mutation.current = true; setLoading(false); setBusy(true); setError(""); ++generation.current;
    try {
      if (kind === "save" && value) {
        if (selected === "new") {
          const created = await api.createTag(value.name);
          if (!alive.current) return;
          setTags(list => list.some(tag => tag.id === created.id) ? list : [...list, { ...created, aliases: [], parent_id: null }]);
        } else {
          const updated = await experienceApi.updateTag(selected.id, value);
          if (!alive.current) return;
          setTags(list => list.map(tag => tag.id === updated.id ? updated : tag));
        }
      } else if (selected !== "new") {
        if (kind === "merge" && target !== undefined) {
          const result = await experienceApi.mergeTags([selected.id], target); if (!alive.current) return; setTags(result.items);
        } else if (kind === "delete") {
          await experienceApi.deleteTag(selected.id); if (!alive.current) return;
          setTags(list => list.filter(tag => tag.id !== selected.id).map(tag => tag.parent_id === selected.id ? { ...tag, parent_id: null } : tag));
        }
      }
      if (alive.current) setSelected(null);
    } catch { if (alive.current) setError("更改未保存。请检查名称、别名或父级是否冲突，然后重试。"); }
    finally { mutation.current = false; if (alive.current) setBusy(false); }
  };
  return <main className="mx-auto min-h-dvh max-w-3xl px-3 pb-28 pt-[max(1rem,env(safe-area-inset-top))]">
    <header className="mb-4 flex items-center gap-2"><button type="button" aria-label="返回片库" onClick={onBack} className="grid size-11 shrink-0 place-items-center"><CaretLeftIcon size={22} /></button><h1 className="min-w-0 flex-1 text-2xl font-semibold">标签管理</h1><button type="button" aria-label="新建标签" disabled={loading || failed || tags.length >= 200} onClick={() => { setError(""); setSelected("new"); }} className={button}>新建</button></header>
    <p className="mb-4 px-1 text-sm leading-relaxed text-muted">别名指向同一个标签；父级用于整理标签。合并会迁移已有绑定和频道条件。</p>
    {loading && <p role="status" className="py-12 text-center text-sm text-muted">正在读取标签…</p>}
    {failed && <div role="alert" className="py-6 text-center"><button type="button" aria-label="重试标签列表" onClick={() => void load()} className={button}>标签读取失败，点击重试</button></div>}
    {!loading && !failed && !tags.length && <p className="py-16 text-center text-sm text-muted">还没有标签</p>}
    {tags.map(tag => <button key={tag.id} type="button" aria-label={`编辑标签 ${tag.name}`} onClick={() => { setError(""); setSelected(tag); }} className="mb-2 flex min-h-16 w-full min-w-0 items-center gap-3 rounded-xl bg-surface px-4 py-3 text-left"><span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{tag.name}<span className="ml-2 text-xs tabular-nums text-muted">{tag.count}</span></span>{tag.parent_id !== null && <span className="mt-1 block truncate text-xs text-muted">父级：{tags.find(parent => parent.id === tag.parent_id)?.name ?? "未分组"}</span>}{tag.aliases.length > 0 && <span className="mt-1 block truncate text-xs text-muted">别名：{tag.aliases.join("、")}</span>}</span><PencilSimpleIcon size={19} className="shrink-0 text-muted" /></button>)}
    <Sheet open={!!selected && !locked} onClose={close} title={selected === "new" ? "新建标签" : "管理标签"}>{selected && <TagEditor key={selected === "new" ? "new" : selected.id} tag={selected === "new" ? undefined : selected} tags={tags} busy={busy} error={error} onClose={close} onSave={value => void mutate("save", value)} onDelete={() => void mutate("delete")} onMerge={target => void mutate("merge", undefined, target)} />}</Sheet>
  </main>;
}

function TagEditor({ tag, tags, busy, error, onClose, onSave, onDelete, onMerge }: { tag?: CatalogTag; tags: CatalogTag[]; busy: boolean; error: string; onClose: () => void; onSave: (value: { name: string; aliases: string[]; parent_id: number | null }) => void; onDelete: () => void; onMerge: (target: number) => void }) {
  const [name, setName] = useState(tag?.name ?? ""), [aliases, setAliases] = useState(tag?.aliases.join("\n") ?? "");
  const [parent, setParent] = useState(tag?.parent_id?.toString() ?? ""), [target, setTarget] = useState("");
  const [mode, setMode] = useState<"edit" | "merge" | "confirmMerge" | "confirmDelete">("edit"), [invalid, setInvalid] = useState("");
  const destination = tags.find(item => item.id === Number(target));
  const submit = () => {
    const normalized = clean(name), names = aliases.split(/\r?\n/u).map(clean).filter(Boolean);
    if (!normalized || Array.from(normalized).length > 20 || names.length > 10 || names.some(alias => Array.from(alias).length > 20)) { setInvalid("名称需为 1–20 个字符；最多 10 个别名，每行一个。"); return; }
    const chosen = [normalized, ...names].map(key), occupied = tags.filter(item => item.id !== tag?.id).flatMap(item => [item.name, ...item.aliases]).map(key);
    if (new Set(chosen).size !== chosen.length || chosen.some(item => occupied.includes(item))) { setInvalid("名称或别名与已有标签冲突，请修改后重试。"); return; }
    setInvalid(""); onSave({ name: normalized, aliases: names, parent_id: parent ? Number(parent) : null });
  };
  return <div className="space-y-3 px-2 pb-2"><div hidden={mode !== "edit"}><fieldset disabled={busy} className="min-w-0 space-y-3 disabled:opacity-60"><label className="block text-xs text-muted">标签名称<input aria-label="标签名称" autoFocus maxLength={40} value={name} onChange={event => setName(event.target.value)} className={`${field} mt-1`} /></label>{tag && <><label className="block text-xs text-muted">别名（最多 10 个，每行一个）<textarea aria-label="标签别名" rows={4} maxLength={419} value={aliases} onChange={event => setAliases(event.target.value)} className={`${field} mt-1 py-3`} /></label><label className="block text-xs text-muted">父标签<select aria-label="父标签" value={parent} onChange={event => setParent(event.target.value)} className={`${field} mt-1`}><option value="">无父级</option>{tags.filter(item => acceptsParent(tags, tag.id, item.id)).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><p className="text-xs leading-relaxed text-muted">每个标签最多一个父级，层级最多 8 层。不可选择自己或会造成循环的标签。</p></>}</fieldset><div className="mt-3 flex gap-2"><button type="button" disabled={busy} onClick={onClose} className={`${button} flex-1`}>取消</button><button type="button" aria-label="保存标签" disabled={busy || !name.trim()} onClick={submit} className="min-h-11 flex-1 rounded-full bg-accent text-sm text-white disabled:opacity-50">{busy ? "正在保存…" : "保存标签"}</button></div>{tag && <div className="mt-2 flex gap-2"><button type="button" aria-label="合并标签" disabled={busy || tags.length < 2} onClick={() => { setInvalid(""); setMode("merge"); }} className={`${button} flex-1`}>合并到…</button><button type="button" aria-label="删除标签" disabled={busy} onClick={() => { setInvalid(""); setMode("confirmDelete"); }} className="min-h-11 flex-1 rounded-full bg-raised px-4 text-sm text-accent disabled:opacity-50">删除标签</button></div>}</div>
    {mode === "merge" && <><p className="text-sm leading-relaxed text-muted">将“{tag?.name}”合并到另一个标签，保留目标标签。</p><label className="block text-xs text-muted">合并到标签<select aria-label="合并到标签" disabled={busy} value={target} onChange={event => setTarget(event.target.value)} className={`${field} mt-1`}><option value="">请选择目标标签</option>{tags.filter(item => item.id !== tag?.id).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><div className="flex gap-2"><button type="button" disabled={busy} onClick={() => setMode("edit")} className={`${button} flex-1`}>返回编辑</button><button type="button" aria-label="继续合并标签" disabled={busy || !destination} onClick={() => setMode("confirmMerge")} className={`${button} flex-1`}>继续</button></div></>}
    {(mode === "confirmMerge" || mode === "confirmDelete") && <><p className="text-sm leading-relaxed">{mode === "confirmMerge" ? `确认将“${tag?.name}”合并到“${destination?.name}”？视频、片段和频道中的引用将迁移到目标标签，无法直接撤销。` : `确认删除“${tag?.name}”？视频和片段不会删除，相关标签绑定、别名和频道条件将移除，子标签将取消分组。`}</p><div className="flex gap-2"><button type="button" disabled={busy} onClick={() => setMode(mode === "confirmMerge" ? "merge" : "edit")} className={`${button} flex-1`}>取消</button><button type="button" aria-label={mode === "confirmMerge" ? "确认合并标签" : "确认删除标签"} disabled={busy || (mode === "confirmMerge" && !destination)} onClick={() => mode === "confirmMerge" && destination ? onMerge(destination.id) : onDelete()} className="min-h-11 flex-1 rounded-full bg-accent text-sm text-white disabled:opacity-50">{busy ? "正在保存…" : mode === "confirmMerge" ? "确认合并" : "确认删除"}</button></div></>}
    {(invalid || error) && <p role="alert" className="text-sm leading-relaxed text-accent">{invalid || error}</p>}
  </div>;
}
