import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SKILLS_SHA } from "./skills-sha.ts";
import { readSkillSnapshot, SNAPSHOT_FILES } from "./skills-snapshot.ts";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

describe("the skills snapshot", () => {
  it("holds the five skills the platform runs and the two tracker seed templates", () => {
    expect(SNAPSHOT_FILES).toEqual([
      "to-spec/SKILL.md",
      "to-tickets/SKILL.md",
      "implement/SKILL.md",
      "tdd/SKILL.md",
      "code-review/SKILL.md",
      "setup-matt-pocock-skills/issue-tracker-github.md",
      "setup-matt-pocock-skills/issue-tracker-gitlab.md",
    ]);
  });

  // Guard: bumping SKILLS_SHA without refreshing the snapshot (or the other way round) fails `pnpm check`.
  it.each(SNAPSHOT_FILES)("%s was taken at the pinned SHA", (file) => {
    expect(readSkillSnapshot(file).sha).toBe(SKILLS_SHA);
  });

  it("gives back the file as written in the skills repo, without its header", () => {
    const toSpec = readSkillSnapshot("to-spec/SKILL.md").content;
    expect(toSpec.startsWith("---\nname: to-spec\n")).toBe(true);
    expect(toSpec).toContain("## Problem Statement");
  });
});

describe("the pinned SHA", () => {
  it("is written down in one place: the constant (snapshot headers name the SHA they were taken at)", () => {
    const tracked = execFileSync("git", ["grep", "-l", SKILLS_SHA], {
      cwd: repoRoot,
      encoding: "utf8",
    })
      .trim()
      .split("\n")
      .filter((file) => !file.startsWith("packages/shared/skills-snapshot/"));
    expect(tracked).toEqual(["packages/shared/src/skills-sha.ts"]);
  });

  it("is what up.sh checks out", () => {
    const upSh = readFileSync(`${repoRoot}scripts/up.sh`, "utf8");
    expect(upSh).toContain("packages/shared/src/skills-sha.ts");
  });
});
