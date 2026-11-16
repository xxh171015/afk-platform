// What became of a Finding (docs/design.md「领域模型」: 已修复 / 未处理 / 进验收包).
// `fixed` means the fix stage finished and reported done with the gate passing; it is not a
// claim that anyone re-checked the problem. The acceptance pack and PR description phrase
// that as 「已交给 fix 处理」.
export const FINDING_RESOLUTIONS = [
  "unhandled",
  "fixed",
  "acceptance-pack",
  "refactored",
] as const;
export type FindingResolution = (typeof FINDING_RESOLUTIONS)[number];

export function findingResolutionPhrase(resolution: string): string {
  if (resolution === "fixed") return "已交给 fix 处理";
  if (resolution === "refactored") return "已由 Tidy 整理";
  return resolution;
}
