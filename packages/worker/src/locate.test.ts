import { gitOrThrow } from "@afk/pipeline";
import { makeRepo } from "@afk/pipeline/testing";
import { afterEach, describe, expect, it } from "vitest";
import { blameLocateFiles } from "./locate.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe("blameLocateFiles", () => {
  it("reads Spec, Ticket and Run trailers from the named files and skips missing ones", () => {
    const repo = makeRepo({ "README.md": "# shop\n" });
    cleanups.push(() => repo.cleanup());
    const sha = repo.commit(
      {
        "src/orders.ts":
          "export function exportOrders() { throw new TypeError('id') }\n",
      },
      "export orders\n\nSpec: S-1\nTicket: T-1\nRun: R-1\n",
    );

    expect(blameLocateFiles(repo.dir, ["src/orders.ts", "missing.ts"])).toEqual(
      [{ sha, spec: "S-1", ticket: "T-1", run: "R-1" }],
    );
  });

  it("blames a bare clone at a named revision, as the worker's main clones are bare", () => {
    const repo = makeRepo({ "README.md": "# shop\n" });
    cleanups.push(() => repo.cleanup());
    const sha = repo.commit(
      { "src/orders.ts": "export const exportOrders = 1;\n" },
      "export orders\n\nSpec: S-4\n",
    );
    const bare = `${repo.dir}.git`;
    gitOrThrow(repo.dir, ["clone", "--quiet", "--bare", repo.dir, bare]);

    expect(blameLocateFiles(bare, ["src/orders.ts"], "main")).toEqual([
      { sha, spec: "S-4" },
    ]);
  });
});
