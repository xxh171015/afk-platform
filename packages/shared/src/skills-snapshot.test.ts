import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SKILLS_SHA } from "./skills-sha.ts";
import {
  PLANNING_SKILLS,
  readSkillSnapshot,
  SANDBOX_SKILLS,
  SNAPSHOT_FILES,
  snapshotPath,
  VENDORED_DIRS,
} from "./skills-snapshot.ts";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

describe("what is copied from mattpocock/skills", () => {
  // Guard: bumping SKILLS_SHA without running the refresh script (or the other way round) fails `pnpm check`.
  it.each(VENDORED_DIRS)("%s was copied at the pinned SHA", (dir) => {
    expect(readFileSync(`${repoRoot}${dir}/VENDORED.md`, "utf8")).toContain(
      SKILLS_SHA,
    );
  });

  it.each([
    ...Object.keys(PLANNING_SKILLS).map((name) => `skills/${name}`),
    ...Object.keys(SANDBOX_SKILLS).map(
      (name) => `packages/pipeline/skills/${name}`,
    ),
  ])("%s is a whole skill, with the upstream license", (dir) => {
    const name = dir.split("/").at(-1);
    const skill = readFileSync(`${repoRoot}${dir}/SKILL.md`, "utf8");
    expect(skill).toMatch(new RegExp(`^---\\n(?:\\n)?name: ${name}\\n`));
    expect(readFileSync(`${repoRoot}${dir}/LICENSE`, "utf8")).toContain(
      "MIT License",
    );
  });

  it.each(SNAPSHOT_FILES)("%s is read from where it is kept", (file) => {
    expect(readSkillSnapshot(file)).toBe(
      readFileSync(`${repoRoot}${snapshotPath(file)}`, "utf8"),
    );
  });

  it("gives back the file as written in the skills repo", () => {
    const toSpec = readSkillSnapshot("to-spec/SKILL.md");
    expect(toSpec.startsWith("---\nname: to-spec\n")).toBe(true);
    expect(toSpec).toContain("## Problem Statement");
  });
});

describe("the pinned SHA", () => {
  it("is written down in one place: the constant", () => {
    const tracked = execFileSync("git", ["grep", "-l", SKILLS_SHA], {
      cwd: repoRoot,
      encoding: "utf8",
    })
      .trim()
      .split("\n")
      // the notes on the copies (held to it above), the overlay, which says which skills it was written for (a test
      // in the pipeline package holds that SHA to the constant), the tracker-doc templates (a test in the cli
      // package does the same), and the generated tracker doc in this repo
      .filter(
        (file) =>
          !VENDORED_DIRS.some((dir) => file === `${dir}/VENDORED.md`) &&
          !file.startsWith("packages/cli/templates/") &&
          file !== "packages/pipeline/prompts/overlay.md" &&
          file !== "docs/agents/issue-tracker.md",
      );
    expect(tracked).toEqual(["packages/shared/src/skills-sha.ts"]);
  });
});
