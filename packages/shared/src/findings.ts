// What became of a Finding (docs/design.md「领域模型」: 已修复 / 未处理 / 进验收包).
// `fixed` means the fix stage finished and reported done with the gate passing; it is not a
// claim that anyone re-checked the problem. The acceptance pack and PR description phrase
// that as 「已交给 fix 处理」.
export const FINDING_RESOLUTIONS = [
  "unhandled",
  "fixed",
  "acceptance-pack",
] as const;
export type FindingResolution = (typeof FINDING_RESOLUTIONS)[number];

export function findingResolutionPhrase(resolution: string): string {
  return resolution === "fixed" ? "已交给 fix 处理" : resolution;
}
