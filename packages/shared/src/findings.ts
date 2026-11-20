// What became of a Finding (docs/design.md「领域模型」: 已修复 / 未处理 / 进验收包 / 已由 Tidy 整理 / 人已批准 / 审查确认已解决).
// `fixed` means the fix stage finished and reported done with the gate passing; it is not a
// claim that anyone re-checked the problem. The acceptance pack and PR description phrase
// that as 「已交给 fix 处理」. `approved` means a person let the Recheck conclusion stand;
// it is not a claim that the problem was fixed. `resolved` means the wrap-up Spec axis
// confirmed a ticket-review uncertainty is no longer a problem.
export const FINDING_RESOLUTIONS = [
  "unhandled",
  "fixed",
  "acceptance-pack",
  "refactored",
  "approved",
  "resolved",
] as const;
export type FindingResolution = (typeof FINDING_RESOLUTIONS)[number];

export function findingResolutionPhrase(resolution: string): string {
  if (resolution === "unhandled") return "未处理";
  if (resolution === "fixed") return "已交给 fix 处理";
  if (resolution === "acceptance-pack") return "进验收包，留给你看";
  if (resolution === "refactored") return "已由 Tidy 整理";
  if (resolution === "approved") return "人已批准";
  if (resolution === "resolved") return "审查确认已解决";
  return resolution;
}
