import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeRepo, type TestRepo } from "@afk/pipeline/testing";
import { afterEach, describe, expect, it } from "vitest";
import { fetchContracts } from "./contracts.ts";
import { RepoStore } from "./repos.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function origin(files: Record<string, string>): TestRepo {
  const repo = makeRepo(files);
  cleanups.push(() => repo.cleanup());
  return repo;
}

function store(): RepoStore {
  const root = mkdtempSync(join(tmpdir(), "afk-worker-repos-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return new RepoStore(root);
}

describe("fetchContracts", () => {
  it("clones the repo that provides each contract when the worker has no clone of it yet, and reads the file at the SHA", () => {
    const backend = origin({ "openapi/openapi.yaml": "version: 1\n" });
    const sha = backend.commit(
      { "openapi/openapi.yaml": "version: 2\n" },
      "contract",
    );
    backend.commit({ "openapi/openapi.yaml": "version: 3\n" }, "later");
    const payments = origin({ "pay.yaml": "pay: 1\n" });
    const paymentsSha = payments.commit({ "pay.yaml": "pay: 2\n" }, "contract");
    const repos = store();

    const contracts = fetchContracts(repos, [
      {
        repo: "backend",
        url: backend.dir,
        defaultBranch: "main",
        sha,
        path: "openapi/openapi.yaml",
      },
      {
        repo: "payments",
        url: payments.dir,
        defaultBranch: "main",
        sha: paymentsSha,
        path: "pay.yaml",
      },
    ]);

    expect(contracts).toEqual([
      {
        repo: "backend",
        path: "openapi/openapi.yaml",
        content: "version: 2\n",
      },
      { repo: "payments", path: "pay.yaml", content: "pay: 2\n" },
    ]);
  });

  it("gives nothing for a ticket without contract upstreams", () => {
    expect(fetchContracts(store(), [])).toEqual([]);
  });
});
