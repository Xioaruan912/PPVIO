import type { Tag } from "../api";

const MACRO_KEY = "ppvio-web:curation-tag-groups";
const MAX_MACROS = 6;

const normalize = (ids: number[], valid: Set<number>) =>
  [...new Set(ids)].filter(id => Number.isSafeInteger(id) && id > 0 && valid.has(id)).slice(0, 20);

/**
 * Read recently used multi-tag curation combos (shared with Curation.tsx so macros learned
 * anywhere in Feed, Library Batch Console, or Curation Studio appear everywhere instantly).
 */
export function readTriageMacros(tags: Tag[]): { ids: number[]; label: string }[] {
  const valid = new Set(tags.map(t => t.id));
  const byId = new Map(tags.map(t => [t.id, t.name]));
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(MACRO_KEY) ?? "[]");
    if (!Array.isArray(raw)) return [];
    const seen = new Set<string>();
    const macros: { ids: number[]; label: string }[] = [];
    for (const entry of raw) {
      if (!Array.isArray(entry)) continue;
      const ids = normalize(entry as number[], valid);
      const key = ids.join(",");
      if (!ids.length || seen.has(key)) continue;
      seen.add(key);
      macros.push({ ids, label: ids.map(id => byId.get(id)).filter(Boolean).join(" + ") });
      if (macros.length >= MAX_MACROS) break;
    }
    return macros;
  } catch {
    return [];
  }
}

export function rememberTriageMacro(ids: number[], tags: Tag[]): void {
  const valid = new Set(tags.map(t => t.id));
  const clean = normalize(ids, valid);
  if (!clean.length) return;
  const existing = readTriageMacros(tags).map(m => m.ids).filter(g => g.join(",") !== clean.join(","));
  const next = [clean, ...existing].slice(0, MAX_MACROS);
  try {
    localStorage.setItem(MACRO_KEY, JSON.stringify(next));
  } catch {
    /* Storage may be unavailable in private mode. */
  }
}
