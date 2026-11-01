export type {
  AgentRunner,
  AgentRunOptions,
  AgentRunResult,
  Classification,
  DiagnoseOutcome,
  DiagnoseOutput,
  ImplementOutput,
  ReviewOutput,
} from "./agent.ts";
export {
  CANNOT_PROCEED_REASONS,
  classifyAgentRun,
  classifyDiagnoseRun,
  classifyReviewRun,
  combineReviewRuns,
  composePrompt,
  DiagnoseOutputSchema,
  ImplementOutputSchema,
  OVERLAY_FILE,
  overlaySkillsSha,
  PROMPTS,
  promptFor,
  ReviewOutputSchema,
  reviewFindings,
  writePrompt,
} from "./agent.ts";
export type { ContextInput, RunFacts } from "./context.ts";
export { readContract, renderContext } from "./context.ts";
export type { ContractCopyProblem, ProvidedContract } from "./contract-copy.ts";
export { checkContractCopies, copyPathOf } from "./contract-copy.ts";
export type {
  E2eCounts,
  E2eOutcome,
  RunE2eInput,
} from "./e2e.ts";
export {
  E2E_COMMAND,
  E2E_JUNIT_PATH,
  E2E_TIMEOUT_SECONDS,
  runE2e,
} from "./e2e.ts";
export type { ExecAsyncOptions, ExecOptions, ExecResult } from "./exec.ts";
export { exec, execAsync, git, gitOrThrow, gitOut } from "./exec.ts";
export type {
  GateConfig,
  GateOutcome,
  GateSandbox,
  RunGateInput,
  SandboxPlacement,
  SandboxSession,
  TestCase,
  TestCaseStatus,
  TestCounts,
} from "./gate.ts";
export {
  GateCache,
  junitCases,
  junitCounts,
  readGateConfig,
  runGate,
} from "./gate.ts";
export type {
  DockerCli,
  DockerResult,
  Environment,
  EnvironmentRepo,
  StartEnvironmentInput,
} from "./integration-env.ts";
export {
  COMPOSE_FRAGMENT_PATH,
  EnvironmentError,
  projectOf,
  realDocker,
  reclaimEnvironments,
  startEnvironment,
} from "./integration-env.ts";
export type { MergeCandidate } from "./merge.ts";
export { hasRef, isAncestor, mergeCandidate } from "./merge.ts";
export type { ProtectedPathCheck } from "./protected-paths.ts";
export {
  changedFiles,
  checkProtectedPaths,
  globMatches,
} from "./protected-paths.ts";
export type { SandcastleConfig } from "./sandcastle.ts";
export {
  agentEnv,
  CONTEXT_SANDBOX_PATH,
  classifyAgentError,
  SandcastleAgentRunner,
  SandcastleGateSandbox,
  SKILLS_SANDBOX_PATH,
  sandboxMounts,
} from "./sandcastle.ts";
export type { StampRequest, StampResult, TrailerIds } from "./trailers.ts";
export { stampTrailers } from "./trailers.ts";
