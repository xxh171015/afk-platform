import { describe, expect, it } from "vitest";
import {
  generatedCommandsNote,
  generatedConflictShare,
  generatedGroupsFor,
  generatedOnlyConflicts,
} from "./generated.ts";

const api = { paths: ["packages/shared/src/api/**"], run: "pnpm gen:api" };
const drizzle = {
  paths: ["packages/api/drizzle/*.sql", "packages/api/drizzle/meta/**"],
  run: "scripts/rebase-migrations.sh",
};

describe("generatedOnlyConflicts", () => {
  it("is true when every conflict file matches a declared group", () => {
    expect(
      generatedOnlyConflicts(
        [
          "packages/shared/src/api/openapi.json",
          "packages/api/drizzle/0073_x.sql",
        ],
        [api, drizzle],
      ),
    ).toBe(true);
  });

  it("is false when a source file is also in conflict, or when nothing conflicts", () => {
    expect(
      generatedOnlyConflicts(
        ["packages/shared/src/api/openapi.json", "src/gate.ts"],
        [api, drizzle],
      ),
    ).toBe(false);
    expect(generatedOnlyConflicts([], [api])).toBe(false);
  });
});

describe("generatedGroupsFor", () => {
  it("keeps declaration order and drops groups that do not cover a conflict", () => {
    expect(
      generatedGroupsFor(["packages/api/drizzle/0073_x.sql"], [api, drizzle]),
    ).toEqual([drizzle]);
    expect(
      generatedGroupsFor(
        [
          "packages/api/drizzle/0073_x.sql",
          "packages/shared/src/api/schema.d.ts",
        ],
        [api, drizzle],
      ),
    ).toEqual([api, drizzle]);
  });
});

describe("generatedCommandsNote", () => {
  it("lists each command so merge-fix can see them", () => {
    expect(generatedCommandsNote([api, drizzle])).toContain("pnpm gen:api");
    expect(generatedCommandsNote([api, drizzle])).toContain(
      "scripts/rebase-migrations.sh",
    );
    expect(generatedCommandsNote([])).toBe("");
  });
});

describe("generatedConflictShare", () => {
  it("is the share of recorded merge conflicts that were generated-only", () => {
    expect(
      generatedConflictShare([
        { generatedOnlyConflict: true },
        { generatedOnlyConflict: false },
        {},
        { generatedOnlyConflict: true },
      ]),
    ).toBe(2 / 3);
    expect(generatedConflictShare([{}])).toBeUndefined();
  });
});
