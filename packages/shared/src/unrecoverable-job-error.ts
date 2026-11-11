// Job errors that will not recover by running the same job again: Cursor auth, a bad model
// name, a spent quota, a failed integration image build. The worker classifies them; the API
// fails the job once and puts the human sentence in the brief.

export const CURSOR_AUTH_BRIEF =
  "Cursor 密钥失效或没有权限，更新 `~/.afk/env` 里的 `CURSOR_API_KEY` 后重试";
export const INVALID_MODEL_BRIEF = "模型名无效，检查项目的默认模型或 AFK_MODEL";
export const QUOTA_EXHAUSTED_BRIEF = "Cursor 额度用完，充值或换模型后再试";
export const IMAGE_BUILD_BRIEF =
  "联调镜像构建失败，修好 Dockerfile 或基础镜像后再试";

const CASES: { pattern: string; brief: string }[] = [
  {
    // Cursor says "You're out of usage. … Increase limits" inside an ActionRequiredError: a quota, not a dead key.
    pattern:
      "out of usage|increase limits|usage limit|quota[ _]?(exceeded|exhausted)|insufficient (quota|credits)|resource.?exhausted",
    brief: QUOTA_EXHAUSTED_BRIEF,
  },
  {
    // ActionRequiredError: Unauthorized request is what Cursor returns when the key is dead.
    pattern:
      "actionrequirederror|authentication required|not authenticated|cursor-agent login|unauthorized request",
    brief: CURSOR_AUTH_BRIEF,
  },
  {
    pattern:
      "invalid model|unknown model|model not found|model does not exist|no such model",
    brief: INVALID_MODEL_BRIEF,
  },
  {
    pattern: "docker build of .+ failed",
    brief: IMAGE_BUILD_BRIEF,
  },
];

// Of those, the ones that stop every agent job alike, whatever the project: the provider's quota is spent or it
// refuses the key. They pause all agent jobs until a person resumes them (agents-pause.ts in the api) instead of
// blocking one ticket after another.
export function isAgentProviderUnavailable(error: string): boolean {
  const brief = unrecoverableJobError(error);
  return brief === QUOTA_EXHAUSTED_BRIEF || brief === CURSOR_AUTH_BRIEF;
}

export function unrecoverableJobError(error: string): string | undefined {
  const trimmed = error.trim();
  for (const { pattern, brief } of CASES) {
    if (trimmed === brief || new RegExp(pattern, "i").test(error)) return brief;
  }
  return undefined;
}
