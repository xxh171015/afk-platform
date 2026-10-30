// What became of a Finding (docs/design.md「领域模型」: 已修复 / 未处理 / 进验收包).
export const FINDING_RESOLUTIONS = [
  "unhandled",
  "fixed",
  "acceptance-pack",
] as const;
export type FindingResolution = (typeof FINDING_RESOLUTIONS)[number];
