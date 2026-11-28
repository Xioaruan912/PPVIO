import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { useGSAP } from "@gsap/react";
import { useEffect, type RefObject } from "react";

let registered = false;
export function ensureGsap(): typeof gsap {
  if (!registered && typeof window !== "undefined" && typeof window.matchMedia === "function") {
    gsap.registerPlugin(ScrollTrigger, useGSAP);
    gsap.defaults({ ease: "power3.out", duration: 0.38 });
    registered = true;
    // Calibrate ScrollTrigger markers once webfonts settle (Apple Cinematic Workflow Stage 4)
    if (document.fonts?.ready) {
      void document.fonts.ready.then(() => {
        try { ScrollTrigger.refresh(); } catch { /* jsdom / unmounted */ }
      });
    }
  }
  return gsap;
}

/**
 * Cinema aperture curtain reveal for full-screen video stages (actuel-img / goonsdesign inspired).
 * Respects prefers-reduced-motion via gsap.matchMedia() and clears inline clipPath after settle.
 */
export function useApertureReveal(ref: RefObject<HTMLElement | null>, deps: readonly unknown[] = []): void {
  ensureGsap();
  useGSAP(() => {
    const el = ref.current;
    if (!el || typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mm = gsap.matchMedia();
    mm.add(
      {
        desktop: "(min-width: 768px) and (prefers-reduced-motion: no-preference)",
        mobile: "(max-width: 767px) and (prefers-reduced-motion: no-preference)",
        reduce: "(prefers-reduced-motion: reduce)",
      },
      ctx => {
        const { desktop, reduce } = ctx.conditions ?? {};
        if (reduce) {
          gsap.fromTo(el, { opacity: 0 }, { opacity: 1, duration: 0.16, ease: "power1.out", clearProps: "opacity" });
          return;
        }
        const inset = desktop ? "inset(4% 3% 4% 3% round 24px)" : "inset(2% 1.5% 2% 1.5% round 18px)";
        gsap.fromTo(
          el,
          { clipPath: inset, scale: desktop ? 1.035 : 1.02, opacity: 0.72 },
          {
            clipPath: "inset(0% 0% 0% 0% round 0px)",
            scale: 1,
            opacity: 1,
            duration: desktop ? 0.42 : 0.32,
            ease: "power3.out",
            clearProps: "clipPath,transform,opacity",
          },
        );
      },
    );
    return () => mm.revert();
  }, { scope: ref, dependencies: [...deps], revertOnUpdate: true });
}

/**
 * Batched ScrollTrigger entrance for Library & Archive grids.
 * Animates newly entered cards smoothly without hiding offscreen content permanently or re-hiding on scroll back.
 */
export function useGridBatchReveal(container: RefObject<HTMLElement | null>, count: number): void {
  ensureGsap();
  useEffect(() => {
    const root = container.current;
    if (!root || count === 0 || typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const cards = Array.from(root.querySelectorAll<HTMLElement>("[data-grid-card]:not([data-revealed='1'])"));
    if (!cards.length) return;
    const desktop = window.matchMedia("(min-width: 768px)").matches;
    gsap.set(cards, { opacity: 0, y: desktop ? 18 : 12, scale: 0.97 });
    const triggers = ScrollTrigger.batch(cards, {
      start: "top 94%",
      once: true,
      batchMax: desktop ? 8 : 6,
      onEnter: batch => {
        batch.forEach(node => (node as HTMLElement).setAttribute("data-revealed", "1"));
        gsap.to(batch, {
          opacity: 1,
          y: 0,
          scale: 1,
          duration: 0.38,
          stagger: { each: 0.028, amount: 0.18 },
          ease: "power3.out",
          overwrite: true,
          clearProps: "transform,opacity",
        });
      },
    });
    ScrollTrigger.refresh();
    return () => {
      triggers.forEach(t => t.kill());
      cards.forEach(card => {
        if (card.getAttribute("data-revealed") !== "1") {
          gsap.set(card, { clearProps: "transform,opacity" });
        }
      });
    };
  }, [container, count]);
}

/**
 * Codrops-inspired horizontal folio page transition (clip-path unmask + gentle depth slide).
 * Respects prefers-reduced-motion via gsap.matchMedia().
 */
export function useFolioTransition(
  ref: RefObject<HTMLElement | null>,
  key: string | number,
  direction: 1 | -1 = 1,
): void {
  ensureGsap();
  useGSAP(
    () => {
      const el = ref.current;
      if (!el || typeof window === "undefined" || typeof window.matchMedia !== "function") return;
      const mm = gsap.matchMedia();
      mm.add(
        {
          motion: "(prefers-reduced-motion: no-preference)",
          reduce: "(prefers-reduced-motion: reduce)",
        },
        ctx => {
          if (ctx.conditions?.reduce) {
            gsap.fromTo(el, { opacity: 0.25 }, { opacity: 1, duration: 0.14, ease: "power1.out", clearProps: "opacity" });
            return;
          }
          const fromClip = direction > 0 ? "inset(0% 0% 0% 10% round 14px)" : "inset(0% 10% 0% 0% round 14px)";
          gsap.fromTo(
            el,
            {
              x: direction * 44,
              scale: 0.985,
              opacity: 0.35,
              clipPath: fromClip,
            },
            {
              x: 0,
              scale: 1,
              opacity: 1,
              clipPath: "inset(0% 0% 0% 0% round 0px)",
              duration: 0.42,
              ease: "power3.out",
              clearProps: "transform,opacity,clipPath",
            },
          );
        },
      );
      return () => mm.revert();
    },
    { scope: ref, dependencies: [key, direction], revertOnUpdate: true },
  );
}

export { gsap, ScrollTrigger, useGSAP };
