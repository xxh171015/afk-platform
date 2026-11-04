import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SKILLS_SHA } from "./skills-sha.ts";
import {
  PLANNING_SKILLS,
  readSkillSnapshot,
  SNAPSHOT_FILES,
  snapshotHeader,
} from "./skills-snapshot.ts";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

describe("the skills snapshot", () => {
  it("holds the five skills the platform runs and the seed templates plat init writes", () => {
    expect(SNAPSHOT_FILES).toEqual([
      "to-spec/SKILL.md",
      "to-tickets/SKILL.md",
      "implement/SKILL.md",
      "tdd/SKILL.md",
      "code-review/SKILL.md",
      "setup-matt-pocock-skills/issue-tracker-github.md",
      "setup-matt-pocock-skills/issue-tracker-gitlab.md",
      "setup-matt-pocock-skills/domain.md",
      "setup-matt-pocock-skills/triage-labels.md",
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

// `npx skills@latest add xxh171015/afk-platform` installs these beside afk-setup; plat compares to-spec and to-tickets
// on the planning machine with the snapshot, so the copies under skills/ must be that text.
describe("the planning skills under skills/", () => {
  it.each(["to-spec", "to-tickets"] as const)(
    "%s is the snapshot's text",
    (name) => {
      expect(readFileSync(`${repoRoot}skills/${name}/SKILL.md`, "utf8")).toBe(
        readSkillSnapshot(`${name}/SKILL.md`).content,
      );
    },
  );

  it.each(Object.keys(PLANNING_SKILLS))(
    "%s is there, with the upstream license",
    (name) => {
      const skill = readFileSync(`${repoRoot}skills/${name}/SKILL.md`, "utf8");
      expect(skill.startsWith(`---\nname: ${name}\n`)).toBe(true);
      expect(
        readFileSync(`${repoRoot}skills/${name}/LICENSE`, "utf8"),
      ).toContain("MIT License");
    },
  );

  it("were copied at the pinned SHA", () => {
    expect(readFileSync(`${repoRoot}skills/VENDORED.md`, "utf8")).toContain(
      SKILLS_SHA,
    );
  });
});

it("reads back the SHA that snapshotHeader wrote", () => {
  const header = snapshotHeader(SKILLS_SHA, "tdd/SKILL.md");
  expect(header).toBe(
    `<!-- mattpocock/skills@${SKILLS_SHA} skills/engineering/tdd/SKILL.md -->\n`,
  );
  expect(header).toMatch(/^<!-- mattpocock\/skills@[0-9a-f]{40} \S+ -->\n$/);
});

describe("the pinned SHA", () => {
  it("is written down in one place: the constant (snapshot headers name the SHA they were taken at)", () => {
    const tracked = execFileSync("git", ["grep", "-l", SKILLS_SHA], {
      cwd: repoRoot,
      encoding: "utf8",
    })
      .trim()
      .split("\n")
      // the snapshot headers, and the overlay, which says which skills it was written for (a test in the pipeline
      // package holds that SHA to the constant), and the tracker-doc templates (a test in the cli package does the same),
      // and the note on the planning skills under skills/ (held to it above)
      .filter(
        (file) =>
          !file.startsWith("packages/shared/skills-snapshot/") &&
          file !== "skills/VENDORED.md" &&
          !file.startsWith("packages/cli/templates/") &&
          file !== "packages/pipeline/prompts/overlay.md",
      );
    expect(tracked).toEqual(["packages/shared/src/skills-sha.ts"]);
  });

  it("is what up.sh checks out", () => {
    const upSh = readFileSync(`${repoRoot}scripts/up.sh`, "utf8");
    expect(upSh).toContain("packages/shared/src/skills-sha.ts");
  });
});
