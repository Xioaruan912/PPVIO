import { CaretLeftIcon, CaretRightIcon, FolderIcon, PlusIcon, XIcon } from "@phosphor-icons/react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { api, type StorageSettings } from "../api";
import { toast } from "../ui/toast";
import { EASE_HUD, SPRING_SHEET } from "../ui/motion";
import { normalizeFolder, SettingsHeader, SettingsSection } from "./shared";

const input = "h-11 w-full rounded-[13px] border border-line bg-black/55 px-3.5 text-[15px] text-ink placeholder:text-faint outline-none transition focus:border-gold/60 focus:bg-black/75";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block px-4 py-3"><span className="mb-1.5 block text-[13px] font-medium text-muted">{label}</span>{children}</label>;
}

export function StoragePage({ onBack, onSaved }: { onBack: () => void; onSaved?: (s: StorageSettings) => void }) {
  const [loaded, setLoaded] = useState<StorageSettings | null>(null);
  const [endpoint, setEndpoint] = useState("");
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");
  const [folders, setFolders] = useState<string[]>([]);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);

  useEffect(() => {
    void api.storage().then(s => {
      setLoaded(s);
      if (s.storage_configured) setEndpoint(s.endpoint_url);
      setFolders(s.libraries.length ? s.libraries : [s.archive_root].filter(Boolean));
    }).catch(() => setMessage({ text: "读取设置失败，请刷新重试", error: true }));
  }, []);

  const save = async () => {
    if (!/^https:\/\/[^/\s]+/i.test(endpoint.trim())) return setMessage({ text: "请填写 https:// 开头的 WebDAV 地址", error: true });
    if (!folders.length) return setMessage({ text: "至少添加一个视频目录", error: true });
    if (Boolean(user) !== Boolean(password)) return setMessage({ text: "用户名和密码要一起填", error: true });
    setBusy(true); setMessage({ text: "正在连接并检查每个视频目录…" });
    try {
      const saved = await api.saveStorage({ endpoint_url: endpoint.trim(), libraries: folders, ...(user ? { username: user, password } : {}) });
      setLoaded(saved); setUser(""); setPassword(""); setFolders(saved.libraries);
      onSaved?.(saved);
      setMessage({ text: "已保存，视频库会在一分钟内更新" });
    } catch {
      setMessage({ text: "保存失败：连不上，或账号不对，或某个视频目录不存在", error: true });
    } finally { setBusy(false); }
  };

  const configured = loaded?.credentials_configured;
  return (
    <div>
      <SettingsHeader title="网盘与视频目录" subtitle="OpenList / WebDAV 连接与媒体根目录" onBack={onBack} />
      <SettingsSection title="连接凭据">
        <Field label="WebDAV 地址"><input className={input} value={endpoint} onChange={e => setEndpoint(e.target.value)} placeholder="https://你的域名/dav" spellCheck={false} /></Field>
        <Field label="用户名"><input className={input} value={user} onChange={e => setUser(e.target.value)} autoComplete="username" placeholder={configured ? "已保存，不改可留空" : "OpenList 用户名"} /></Field>
        <Field label="密码"><input className={input} type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" placeholder={configured ? "已保存，不改可留空" : "OpenList 密码"} /></Field>
      </SettingsSection>

      <SettingsSection title="媒体目录">
        <div className="px-4 py-3.5">
          <span className="mb-2.5 block text-[13px] leading-relaxed text-muted">短视频与长视频目录均可添加；第一个目录同时用于存放收藏备份。</span>
          <ul className="flex flex-col gap-2">
            {folders.map(folder => (
              <li key={folder} className="flex h-11 items-center gap-2.5 rounded-[13px] border border-line bg-black/45 px-3">
                <FolderIcon size={18} weight="duotone" className="shrink-0 text-gold" />
                <span className="min-w-0 flex-1 truncate text-[14px] text-ink">{folder}</span>
                <button type="button" aria-label={`移除 ${folder}`} onClick={() => setFolders(folders.filter(f => f !== folder))}
                  className="pressable grid size-8 place-items-center rounded-full text-faint hover:bg-white/[0.06] hover:text-ink"><XIcon size={15} /></button>
              </li>
            ))}
          </ul>
          <button type="button" onClick={() => setPicking(true)} disabled={!configured}
            className="pressable mt-3 flex h-11 w-full items-center justify-center gap-2 rounded-[13px] border border-dashed border-gold/30 text-[14px] font-medium text-gold/90 hover:border-gold/55 disabled:opacity-45">
            <PlusIcon size={16} />{configured ? "浏览并添加文件夹" : "先保存地址和账号，再选文件夹"}
          </button>
        </div>
        <div className="px-4 py-3.5">
          {message && <p className={`mb-3 text-[13px] ${message.error ? "text-accent" : "text-gold-bright"}`} role="status">{message.text}</p>}
          <button type="button" onClick={() => void save()} disabled={busy}
            className="glass-pill-gold sheen-overlay pressable h-11 w-full rounded-full text-[15px] font-semibold disabled:opacity-50 disabled:shadow-none">
            {busy ? "正在保存…" : "保存并验证连接"}
          </button>
        </div>
      </SettingsSection>

      <AnimatePresence>
        {picking && <FolderPicker onClose={() => setPicking(false)}
          onPick={path => { setPicking(false); if (path && !folders.includes(path)) setFolders([...folders, path]); }} />}
      </AnimatePresence>
    </div>
  );
}

function FolderPicker({ onPick, onClose }: { onPick: (path: string) => void; onClose: () => void }) {
  const [path, setPath] = useState("");
  const [names, setNames] = useState<string[] | null>(null);
  useEffect(() => {
    setNames(null);
    void api.folders(path).then(r => setNames(r.folders)).catch(() => { setNames([]); toast("读取文件夹失败"); });
  }, [path]);
  const up = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  return (
    <motion.div className="fixed inset-0 z-40 flex items-end bg-black/65 backdrop-blur-[5px] sm:items-center sm:justify-center" onClick={onClose}
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={EASE_HUD}>
      <motion.div className="glass-sheet flex max-h-[80dvh] w-full flex-col rounded-t-[28px] sm:max-w-md sm:rounded-[28px] sm:border sm:border-white/[0.16]" onClick={e => e.stopPropagation()}
        initial={{ y: 40, opacity: 0.9 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 40, opacity: 0 }} transition={SPRING_SHEET} role="dialog" aria-label="选择文件夹">
        <div className="mx-auto mt-2.5 h-1 w-10 rounded-full bg-gold/35 sm:hidden" aria-hidden="true" />
        <div className="flex items-center gap-2 border-b border-line px-3 py-3">
          <button type="button" disabled={!path} onClick={() => setPath(up)} aria-label="上一级" className="pressable grid size-9 place-items-center rounded-full hover:bg-white/[0.06] disabled:opacity-30"><CaretLeftIcon size={18} weight="bold" /></button>
          <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-muted">/{path}</span>
          <button type="button" onClick={onClose} aria-label="关闭" className="pressable grid size-9 place-items-center rounded-full hover:bg-white/[0.06]"><XIcon size={18} /></button>
        </div>
        <ul className="min-h-40 flex-1 overflow-y-auto p-2">
          {names === null ? <li className="p-6 text-center text-muted">正在读取…</li>
            : names.length === 0 ? <li className="p-6 text-center text-muted">这里没有子文件夹</li>
            : names.map(name => (
              <li key={name}>
                <button type="button" onClick={() => setPath(normalizeFolder(`${path}/${name}`))} className="pressable flex h-12 w-full items-center gap-3 rounded-[13px] px-3 text-left hover:bg-white/[0.05] active:bg-white/[0.09]">
                  <FolderIcon size={20} weight="duotone" className="text-gold" /><span className="min-w-0 flex-1 truncate text-[15px]">{name}</span><CaretRightIcon size={14} className="text-faint" />
                </button>
              </li>
            ))}
        </ul>
        <div className="border-t border-line p-3 pb-[max(0.9rem,env(safe-area-inset-bottom))]">
          <button type="button" disabled={!path} onClick={() => onPick(path)}
            className="glass-pill-gold pressable h-11 w-full rounded-full text-[15px] font-semibold disabled:opacity-40">{path ? `选这个文件夹：${path.split("/").pop()}` : "先点进一个文件夹"}</button>
        </div>
      </motion.div>
    </motion.div>
  );
}
