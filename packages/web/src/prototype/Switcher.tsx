// PROTOTYPE (prototype/spec-ticket-body-display): the floating bar that flips between the layout variants of the
// spec page and the ticket page. The variant lives in `?variant=` before the `#`, so it survives moving between
// pages. Throwaway; never shipped (hidden outside the dev server).
import { useEffect, useState } from "react";

export const VARIANTS = [
  { key: "A", name: "文档在上（像 GitHub issue）" },
  { key: "B", name: "标签页：说明 / 票 / 交付" },
  { key: "C", name: "双栏：文档 + 侧栏" },
] as const;
export type VariantKey = (typeof VARIANTS)[number]["key"];

const read = (): VariantKey => {
  const v = new URLSearchParams(window.location.search).get("variant");
  return VARIANTS.some((x) => x.key === v) ? (v as VariantKey) : "A";
};

export function useVariant(): VariantKey {
  const [v, setV] = useState(read);
  useEffect(() => {
    const on = () => setV(read());
    window.addEventListener("variantchange", on);
    return () => window.removeEventListener("variantchange", on);
  }, []);
  return v;
}

function go(step: number) {
  const index = VARIANTS.findIndex((x) => x.key === read());
  const next = VARIANTS[(index + step + VARIANTS.length) % VARIANTS.length];
  const url = new URL(window.location.href);
  url.searchParams.set("variant", next.key);
  window.history.replaceState(null, "", url);
  window.dispatchEvent(new Event("variantchange"));
}

export function PrototypeSwitcher() {
  const v = useVariant();
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest("input, textarea, [contenteditable]")) return;
      if (e.key === "ArrowLeft") go(-1);
      if (e.key === "ArrowRight") go(1);
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);
  if (!import.meta.env.DEV) return null;
  const current = VARIANTS.find((x) => x.key === v);
  return (
    <div className="prototype-switcher">
      <button type="button" onClick={() => go(-1)}>
        ←
      </button>
      <span>
        原型 {current?.key}（{current?.name}）
      </span>
      <button type="button" onClick={() => go(1)}>
        →
      </button>
    </div>
  );
}
