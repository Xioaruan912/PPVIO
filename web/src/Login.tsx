import { LockSimpleIcon, PlayCircleIcon } from "@phosphor-icons/react";
import { motion } from "motion/react";
import { useState } from "react";
import { api } from "./api";
import { SPRING_STAGE, SPRING_TAP } from "./ui/motion";

export function Login({ onDone }: { onDone: () => void }) {
  const [secret, setSecret] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <main className="cinema-aura relative grid min-h-dvh place-items-center overflow-hidden bg-bg px-5">
      <div aria-hidden="true"
        className="animate-aura pointer-events-none absolute -top-24 left-1/2 h-96 w-96 rounded-full bg-gold/14 blur-[120px]" />
      <div aria-hidden="true"
        className="pointer-events-none absolute bottom-12 right-1/4 h-72 w-72 rounded-full bg-accent/10 blur-[110px]" />

      <motion.form initial={{ opacity: 0, y: 24, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={SPRING_STAGE}
        className="glass-dock relative w-full max-w-[392px] rounded-[30px] p-7"
        onSubmit={async event => {
          event.preventDefault();
          setBusy(true); setError("");
          try { await api.login(secret); onDone(); }
          catch { setError("口令不对，或尝试太频繁，请稍后再试"); }
          finally { setBusy(false); }
        }}>
        <div className="mb-7 flex items-center gap-4">
          <div className="glass-pill-gold grid size-13 place-items-center rounded-[18px]">
            <PlayCircleIcon size={30} weight="fill" />
          </div>
          <div>
            <h1 className="text-[30px] font-semibold leading-tight tracking-[-0.035em] text-ink">PPVIO</h1>
            <p className="mt-0.5 text-[13px] text-muted">输入访问口令</p>
          </div>
        </div>

        <label className="block text-[13px] font-medium text-muted" htmlFor="secret">访问口令</label>
        <div className="relative mt-2">
          <LockSimpleIcon size={18} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-gold/75" />
          <input id="secret" type="password" autoComplete="current-password" value={secret} onChange={event => setSecret(event.target.value)}
            placeholder="请输入口令"
            className="h-12 w-full rounded-[16px] border border-line bg-black/55 pl-10 pr-4 text-[16px] text-ink placeholder:text-faint outline-none transition focus:border-gold/60 focus:bg-black/75" />
        </div>
        {error && <p className="mt-3 text-[13px] leading-snug text-accent" role="alert">{error}</p>}
        <motion.button type="submit" disabled={busy || !secret} whileTap={{ scale: 0.96 }} transition={SPRING_TAP}
          className="glass-pill-gold sheen-overlay mt-6 h-12 w-full rounded-full text-[15px] font-semibold transition hover:brightness-105 disabled:opacity-40 disabled:shadow-none">
          {busy ? "正在登录…" : "进入"}
        </motion.button>
      </motion.form>
    </main>
  );
}
