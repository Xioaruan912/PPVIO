import { useEffect, useRef, useState } from "react";

/** History holds only an entry key. Media and selections stay in this page's memory. */
export function useRouteState<T>(initial: T): [T, (next: T, replace?: boolean) => void, (next: T) => void, () => void] {
  const [value, setValue] = useState<T>(() => initial);
  const entry = useRef(crypto.randomUUID());
  const values = useRef(new Map<string, T>([[entry.current, initial]]));
  const depth = useRef(0);
  useEffect(() => {
    history.replaceState({ ...history.state, ppvioRoute: entry.current, ppvioDepth: 0 }, "");
    const pop = () => {
      const key = history.state?.ppvioRoute;
      if (key === entry.current) return;
      if (values.current.has(key)) {
        entry.current = key; depth.current = history.state.ppvioDepth ?? 0;
        setValue(values.current.get(key)!);
      }
    };
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, []);
  const go = (next: T, replace = false) => {
    const consumesLayer = !replace && !!history.state?.ppvioLayer;
    if (!replace) { entry.current = crypto.randomUUID(); depth.current++; }
    values.current.set(entry.current, next);
    // Keep navigation snapshots bounded; an old unavailable entry falls back to the current page.
    if (values.current.size > 100) values.current.delete(values.current.keys().next().value!);
    const state = { ...history.state, ppvioRoute: entry.current, ppvioDepth: depth.current };
    delete state.ppvioLayer;
    history[replace || consumesLayer ? "replaceState" : "pushState"](state, ""); setValue(next);
  };
  return [value, go, next => go(next, true), () => { if (depth.current > 0) history.back(); else go(initial, true); }];
}

/** Each visible menu owns one entry, so a native/browser Back closes one layer. */
export function useBackLayer(open: boolean, onClose: () => void) {
  const close = useRef(onClose); close.current = onClose;
  useEffect(() => {
    if (!open) return;
    const token = crypto.randomUUID(); let live = true, pushed = false, popped = false;
    const pop = () => {
      if (history.state?.ppvioLayer !== token) { popped = true; close.current(); }
    };
    // StrictMode's provisional effect is cleaned up before this can add an entry.
    queueMicrotask(() => {
      if (!live) return;
      history.pushState({ ...history.state, ppvioLayer: token }, ""); pushed = true;
      window.addEventListener("popstate", pop);
    });
    return () => {
      live = false; window.removeEventListener("popstate", pop);
      if (pushed && !popped && history.state?.ppvioLayer === token) history.back();
    };
  }, [open]);
}
