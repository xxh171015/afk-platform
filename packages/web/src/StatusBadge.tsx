import { Pill, ReasonBadge, StateBadge } from "./components/afk/badges.tsx";
import { prStateLabel } from "./status.ts";

// Chinese on the face, English code in title — colour is not the only signal
// (docs/specs/experience-platform.md「状态徽标」).

export function StatusBadge({
  kind,
  code,
  className,
}: {
  kind: "spec" | "ticket" | "blocked" | "pr";
  code: string;
  className?: string;
}) {
  if (kind === "spec" || kind === "ticket") {
    return <StateBadge kind={kind} state={code} className={className} />;
  }
  if (kind === "blocked") {
    return <ReasonBadge reason={code} className={className} />;
  }
  const tone =
    code === "merged" ? "done" : code === "closed" ? "blocked" : "review";
  return (
    <Pill tone={tone} title={code} className={className}>
      {prStateLabel(code)}
    </Pill>
  );
}
