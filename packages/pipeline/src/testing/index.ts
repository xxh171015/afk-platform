// Helpers for tests in this and other packages: a throwaway repo, a fake agent, a fake gate sandbox.
export { bundleFor } from "../fixtures.ts";
export type { FakeAgentContext, FakeAgentStep } from "./fakes.ts";
export { FakeAgentRunner, FakeDocker, FakeGateSandbox } from "./fakes.ts";
export type { TestRepo } from "./repo.ts";
export { makeRepo, tmpPath } from "./repo.ts";
