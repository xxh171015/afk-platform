import { ShaChip } from "./components/afk/badges.tsx";

// First seven characters on the face; click copies the full SHA.

export function Sha({ value, href }: { value: string; href?: string | null }) {
  return <ShaChip sha={value} href={href} />;
}
