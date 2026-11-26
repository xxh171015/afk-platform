import { describe, expect, it } from "vitest";
import {
  blameLinesFromPorcelain,
  committedShasFromBlame,
  UNCOMMITTED_SHA,
} from "./blame.ts";

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

describe("blameLinesFromPorcelain", () => {
  it("maps final line numbers and marks boundary commits", () => {
    const other = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const porcelain = [
      `${COMMITTED} 1 1 1`,
      "author A",
      "boundary",
      "filename src/a.ts",
      "\told",
      `${other} 2 2 1`,
      "author B",
      "filename src/a.ts",
      "\tnew",
      `${COMMITTED} 3 3`,
      "\talso-old",
    ].join("\n");
    const lines = blameLinesFromPorcelain(porcelain);
    expect(lines.get(1)).toEqual({ sha: COMMITTED, boundary: true });
    expect(lines.get(2)).toEqual({ sha: other, boundary: false });
    expect(lines.get(3)).toEqual({ sha: COMMITTED, boundary: true });
  });
});
