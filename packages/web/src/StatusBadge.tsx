import {
  blockedReasonLabel,
  prStateLabel,
  specStateLabel,
  ticketStateLabel,
} from "./status.ts";

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
  const label =
    kind === "spec"
      ? specStateLabel(code)
      : kind === "ticket"
        ? ticketStateLabel(code)
        : kind === "blocked"
          ? blockedReasonLabel(code)
          : prStateLabel(code);
  const tone =
    kind === "spec"
      ? `spec-${code}`
      : kind === "ticket"
        ? `ticket-${code}`
        : kind === "pr"
          ? `pr-${code}`
          : "ticket-blocked";
  return (
    <span
      className={`badge ${tone} rounded-full px-2 text-xs${className ? ` ${className}` : ""}`}
      title={code}
    >
      {label}
    </span>
  );
}
