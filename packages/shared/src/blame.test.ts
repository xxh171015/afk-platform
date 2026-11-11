import { describe, expect, it } from "vitest";
import { committedShasFromBlame, UNCOMMITTED_SHA } from "./blame.ts";

const COMMITTED = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

describe("committedShasFromBlame", () => {
  it("keeps unique committed SHAs and skips working-tree lines", () => {
    const porcelain = [
      `${COMMITTED} 1 1 1`,
      "author A",
      "filename src/a.ts",
      "\texport const x = 1;",
      `${UNCOMMITTED_SHA} 2 2 1`,
      "author Not Committed Yet",
      "filename src/a.ts",
      "\texport const y = 2;",
      `${COMMITTED} 3 3`,
      "\texport const z = 3;",
    ].join("\n");
    expect(committedShasFromBlame(porcelain)).toEqual([COMMITTED]);
  });
});
