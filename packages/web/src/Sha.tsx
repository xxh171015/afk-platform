import { ShaChip } from "./components/afk/badges.tsx";

// First seven characters on the face; click copies the full SHA.

export function Sha({ value }: { value: string }) {
  return <ShaChip sha={value} />;
}
