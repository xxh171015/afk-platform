import { readSkillSnapshot } from "@afk/shared/skills-snapshot";
import { describe, expect, it } from "vitest";
import { skillsWarnings, trackerDocWarnings } from "./planning-checks.ts";
import { renderTrackerDoc } from "./tracker-doc.ts";

const project = {
  id: 3,
  name: "shop",
  repos: [
    {
      name: "backend",
      url: "https://github.com/acme/backend",
      defaultBranch: "main",
      contractPath: null,
      hostKind: "github" as const,
    },
  ],
};
const current = renderTrackerDoc(project, "backend");

const files = (entries: Record<string, string>) => async (path: string) => {
  const text = entries[path];
  if (text === undefined) throw new Error("ENOENT");
  return text;
};
const load = async () => project;

describe("trackerDocWarnings", () => {
  const docs = (text: string) =>
    files({ "docs/agents/issue-tracker.md": text });

  it("is quiet when the document is what plat tracker-doc prints now", async () => {
    expect(await trackerDocWarnings(docs(current), load, undefined)).toEqual(
      [],
    );
  });

  it("warns, and prints the exact update command, when the document differs in any way", async () => {
    const warnings = await trackerDocWarnings(
      docs(`${current}\nhand edited\n`),
      load,
      undefined,
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("out of date");
    expect(warnings[0]).toContain(
      "plat tracker-doc --project 3 --repo backend > docs/agents/issue-tracker.md",
    );
  });

  it("warns when the document does not exist, with the project it was asked about", async () => {
    const warnings = await trackerDocWarnings(files({}), load, 3);
    expect(warnings[0]).toContain("docs/agents/issue-tracker.md");
    expect(warnings[0]).toContain("plat tracker-doc --project 3 --repo <name>");
  });

  it("warns when the document has no version line to regenerate it from", async () => {
    const warnings = await trackerDocWarnings(
      docs("# Issue tracker\n"),
      load,
      3,
    );
    expect(warnings[0]).toContain("plat tracker-doc --project 3 --repo <name>");
  });

  it("warns that it could not compare when the project cannot be read", async () => {
    const failing = async () => {
      throw new Error("down");
    };
    const warnings = await trackerDocWarnings(
      docs(current),
      failing,
      undefined,
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("could not compare");
  });
});

describe("skillsWarnings", () => {
  const snapshot = (name: "to-spec" | "to-tickets") =>
    readSkillSnapshot(`${name}/SKILL.md`).content;
  const home = "/home/dev";
  const installed = (dir: string, over: Record<string, string> = {}) =>
    files({
      [`${home}/${dir}/to-spec/SKILL.md`]: snapshot("to-spec"),
      [`${home}/${dir}/to-tickets/SKILL.md`]: snapshot("to-tickets"),
      ...over,
    });

  it("is quiet when to-spec and to-tickets are what the snapshot holds", async () => {
    expect(await skillsWarnings(installed(".claude/skills"), home)).toEqual([]);
    expect(await skillsWarnings(installed(".cursor/skills"), home)).toEqual([]);
  });

  it("warns about the one that differs, and says how to link the pinned checkout", async () => {
    const warnings = await skillsWarnings(
      installed(".claude/skills", {
        [`${home}/.claude/skills/to-tickets/SKILL.md`]: "older",
      }),
      home,
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("to-tickets");
    expect(warnings[0]).toMatch(/git -C .* checkout [0-9a-f]{40}/);
    expect(warnings[0]).toContain("ln -sfn");
  });

  it("is quiet when one directory has a stale copy but another has the pinned one", async () => {
    const both = files({
      [`${home}/.claude/skills/to-spec/SKILL.md`]: "older",
      [`${home}/.claude/skills/to-tickets/SKILL.md`]: snapshot("to-tickets"),
      [`${home}/.cursor/skills/to-spec/SKILL.md`]: snapshot("to-spec"),
    });
    expect(await skillsWarnings(both, home)).toEqual([]);
  });

  it("is quiet when one directory has a stale copy but another has the pinned one", async () => {
    const both = files({
      [`${home}/.claude/skills/to-spec/SKILL.md`]: "older",
      [`${home}/.claude/skills/to-tickets/SKILL.md`]: snapshot("to-tickets"),
      [`${home}/.cursor/skills/to-spec/SKILL.md`]: snapshot("to-spec"),
    });
    expect(await skillsWarnings(both, home)).toEqual([]);
  });

  it("warns about both when neither is installed", async () => {
    const warnings = await skillsWarnings(files({}), home);
    expect(warnings).toHaveLength(2);
    expect(warnings.join("\n")).toContain("not found");
  });
});
