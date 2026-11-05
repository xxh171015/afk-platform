import { afterEach, describe, expect, it } from "vitest";
import { checkContractCopies, copyPathOf } from "./contract-copy.ts";
import { makeRepo, type TestRepo } from "./testing/repo.ts";

let repo: TestRepo | undefined;
afterEach(() => repo?.cleanup());

const backend = {
  repo: "backend",
  path: "openapi/openapi.yaml",
  content: "openapi: 3.1.0\npaths: {}\n",
};
const payments = {
  repo: "payments",
  path: "api/openapi.yaml",
  content: "pay: 1\n",
};

// A repo whose last commit is the ticket's work; the base is the commit before it.
function branch(files: Record<string, string>) {
  repo = makeRepo({ "README.md": "# fe\n" });
  repo.commit(files, "work");
  return { dir: repo.dir, ref: "HEAD", base: "HEAD~1" };
}

describe("where a copy lives", () => {
  it("is contract/<file> for one providing repo and contract/<repo>/<file> for several", () => {
    expect(copyPathOf(backend, 1)).toBe("contract/openapi.yaml");
    expect(copyPathOf(backend, 2)).toBe("contract/backend/openapi.yaml");
  });
});

describe("a ticket with contract edges", () => {
  it("passes when the copy is exactly the contract at the SHA", () => {
    const { dir, ref, base } = branch({
      "contract/openapi.yaml": backend.content,
    });
    expect(
      checkContractCopies({
        repoDir: dir,
        repo: "frontend",
        ref,
        base,
        contracts: [backend],
      }),
    ).toEqual([]);
  });

  it("is refused when one byte differs, naming the file and where it differs", () => {
    const { dir, ref, base } = branch({
      "contract/openapi.yaml": "openapi: 3.1.1\npaths: {}\n",
    });
    const problems = checkContractCopies({
      repoDir: dir,
      repo: "frontend",
      ref,
      base,
      contracts: [backend],
    });
    expect(problems).toEqual([
      {
        file: "contract/openapi.yaml",
        detail: expect.stringMatching(
          /differs from backend's contract.*line 1.*openapi: 3\.1\.0.*openapi: 3\.1\.1/,
        ),
      },
    ]);
  });

  it("is refused when the copy is missing, and when only the trailing newline differs", () => {
    const missing = branch({ "src/a.ts": "x\n" });
    expect(
      checkContractCopies({
        repoDir: missing.dir,
        repo: "frontend",
        ref: missing.ref,
        base: missing.base,
        contracts: [backend],
      }),
    ).toEqual([
      {
        file: "contract/openapi.yaml",
        detail: expect.stringMatching(/missing/),
      },
    ]);
    repo?.cleanup();
    const newline = branch({
      "contract/openapi.yaml": backend.content.trimEnd(),
    });
    expect(
      checkContractCopies({
        repoDir: newline.dir,
        repo: "frontend",
        ref: newline.ref,
        base: newline.base,
        contracts: [backend],
      }),
    ).toHaveLength(1);
  });

  it("checks one copy per providing repo, in its own directory", () => {
    const { dir, ref, base } = branch({
      "contract/backend/openapi.yaml": backend.content,
      "contract/payments/openapi.yaml": "pay: 2\n",
    });
    expect(
      checkContractCopies({
        repoDir: dir,
        repo: "frontend",
        ref,
        base,
        contracts: [backend, payments],
      }),
    ).toEqual([
      {
        file: "contract/payments/openapi.yaml",
        detail: expect.stringMatching(/payments/),
      },
    ]);
  });
});

describe("a ticket without contract edges", () => {
  it("may not change a copy", () => {
    const { dir, ref, base } = branch({
      "contract/openapi.yaml": "anything\n",
    });
    expect(
      checkContractCopies({
        repoDir: dir,
        repo: "frontend",
        ref,
        base,
        contracts: [],
      }),
    ).toEqual([
      {
        file: "contract/openapi.yaml",
        detail: expect.stringMatching(/no contract edge/),
      },
    ]);
  });

  it("is not checked when it leaves the copies alone", () => {
    const { dir, ref, base } = branch({ "src/a.ts": "x\n" });
    expect(
      checkContractCopies({
        repoDir: dir,
        repo: "frontend",
        ref,
        base,
        contracts: [],
      }),
    ).toEqual([]);
  });
});

// The manual's own example has a backend implementation ticket with `contract:` on a backend contract ticket:
// the agent gets the pinned contract in /context/contract/, but a repo keeps no copy of its own contract.
describe("a contract edge from the ticket's own repo", () => {
  it("asks for no copy of the repo's own contract", () => {
    const { dir, ref, base } = branch({ "src/a.ts": "x\n" });
    expect(
      checkContractCopies({
        repoDir: dir,
        repo: "backend",
        ref,
        base,
        contracts: [backend],
      }),
    ).toEqual([]);
  });

  it("does not count towards the copies of other repos' contracts", () => {
    const { dir, ref, base } = branch({
      "contract/openapi.yaml": payments.content,
    });
    expect(
      checkContractCopies({
        repoDir: dir,
        repo: "backend",
        ref,
        base,
        contracts: [backend, payments],
      }),
    ).toEqual([]);
  });

  it("does not let the ticket change a copy when no other repo's contract is pinned", () => {
    const { dir, ref, base } = branch({
      "contract/openapi.yaml": "anything\n",
    });
    expect(
      checkContractCopies({
        repoDir: dir,
        repo: "backend",
        ref,
        base,
        contracts: [backend],
      }),
    ).toEqual([
      {
        file: "contract/openapi.yaml",
        detail: expect.stringMatching(/no contract edge from another repo/),
      },
    ]);
  });
});
