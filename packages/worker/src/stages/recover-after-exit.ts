import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  AFK_OUT_RESULT_FILE,
  AFK_OUT_RESULT_MAX_BYTES,
  type AgentRunResult,
  git,
  recoverStructuredOutput,
  resultBlock,
} from "@afk/pipeline";

type OutputSchema = Parameters<typeof recoverStructuredOutput>[0];

export const RECOVERED_AFTER_EXIT = "recovered-after-exit" as const;
export const RECOVERED_AFTER_EXIT_NOTE =
  "agent 进程异常退出，平台按它已写好的结果收下";

export const RECOVER_AFTER_EXIT_STAGES = new Set([
  "implement",
  "gate-fix",
  "review-fix",
  "merge-fix",
  "final-fix",
  "final-tidy",
  "update-branch",
]);

function slotWorktreeClean(slotDir: string): boolean {
  const places = [slotDir];
  const worktrees = join(slotDir, ".sandcastle", "worktrees");
  if (existsSync(worktrees)) {
    for (const name of readdirSync(worktrees))
      places.push(join(worktrees, name));
  }
  return places.every((place) => {
    const status = git(place, ["status", "--porcelain"]);
    return status.code === 0 && status.stdout.trim() === "";
  });
}

function commitsOnBranch(
  slotDir: string,
  baseSha: string,
  branch: string,
): string[] {
  if (git(slotDir, ["rev-parse", "--verify", "--quiet", branch]).code !== 0)
    return [];
  return git(slotDir, ["rev-list", "--reverse", `${baseSha}..${branch}`])
    .stdout.split("\n")
    .filter(Boolean);
}

function parseResultFile(resultDir: string): unknown | undefined {
  const path = join(resultDir, AFK_OUT_RESULT_FILE);
  if (!existsSync(path)) return undefined;
  const info = statSync(path);
  if (!info.isFile() || info.size > AFK_OUT_RESULT_MAX_BYTES) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function outputOf<Output>(
  schema: OutputSchema,
  resultDir: string,
  lastAssistant: string | undefined,
): Output | undefined {
  const fromFile = parseResultFile(resultDir);
  if (fromFile !== undefined) {
    const recovered = recoverStructuredOutput(schema, { output: fromFile });
    if (recovered.ok) return recovered.output as Output;
  }
  if (!lastAssistant) return undefined;
  const tagged = resultBlock(lastAssistant, "result");
  const recovered = recoverStructuredOutput(schema, {
    ...(tagged !== undefined ? { rawMatched: tagged } : { lastAssistant }),
  });
  return recovered.ok ? (recovered.output as Output) : undefined;
}

export function recoverAfterAbnormalExit<Output>(input: {
  result: AgentRunResult<Output>;
  schema: OutputSchema;
  resultDir: string;
  lastAssistant?: string;
  slotDir: string;
  branch: string;
  baseSha: string;
  inherited: boolean;
  requireCommit: boolean;
}):
  | { kind: "skip" }
  | {
      kind: "recovered";
      result: AgentRunResult<Output>;
      originalError: string;
    }
  | { kind: "job-failure" } {
  const { result } = input;
  if (!result.error || result.errorKind !== "other") return { kind: "skip" };

  const output = outputOf<Output>(
    input.schema,
    input.resultDir,
    input.lastAssistant,
  );
  if (output === undefined) return { kind: "job-failure" };
  if (!slotWorktreeClean(input.slotDir)) return { kind: "job-failure" };

  const status =
    output && typeof output === "object" && "status" in output
      ? (output as { status?: unknown }).status
      : undefined;
  if (status !== "done" && status !== "cannot-proceed") {
    return { kind: "job-failure" };
  }
  if (status === "cannot-proceed") {
    const blocked = output as {
      blockedReason?: unknown;
      detail?: unknown;
    };
    if (
      typeof blocked.blockedReason !== "string" ||
      blocked.blockedReason.length === 0 ||
      typeof blocked.detail !== "string" ||
      blocked.detail.length === 0
    ) {
      return { kind: "job-failure" };
    }
  }
  const commits = commitsOnBranch(input.slotDir, input.baseSha, input.branch);
  const hasCommits = commits.length > 0 || input.inherited;
  if (status === "done" && input.requireCommit && !hasCommits) {
    return { kind: "job-failure" };
  }
  const originalError = result.error;
  return {
    kind: "recovered",
    originalError,
    result: {
      ...result,
      output,
      commits,
      resultFix: RECOVERED_AFTER_EXIT,
      error: undefined,
      errorKind: undefined,
    },
  };
}
