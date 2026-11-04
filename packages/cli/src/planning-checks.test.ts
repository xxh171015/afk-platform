import { PLATFORM_VERSION } from "@afk/shared/platform-version";
import { readSkillSnapshot } from "@afk/shared/skills-snapshot";
import { describe, expect, it } from "vitest";
import { readAfkSetupSkill } from "./afk-setup-text.ts";
import {
  integrationWarnings,
  skillsWarnings,
  trackerDocWarnings,
  unreadyRepos,
  versionWarnings,
} from "./planning-checks.ts";
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

  it("warns, and points at the afk-setup skill, when the document differs in any way", async () => {
    const warnings = await trackerDocWarnings(
      docs(`${current}\nhand edited\n`),
      load,
      undefined,
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("out of date");
    expect(warnings[0]).toContain("run the afk-setup skill again");
  });

  it("warns that the repo is not set up when the document does not exist", async () => {
    const warnings = await trackerDocWarnings(files({}), load, 3);
    expect(warnings[0]).toContain("docs/agents/issue-tracker.md");
    expect(warnings[0]).toContain("run the afk-setup skill");
  });

  it("warns when the document has no version line to regenerate it from", async () => {
    const warnings = await trackerDocWarnings(
      docs("# Issue tracker\n"),
      load,
      3,
    );
    expect(warnings[0]).toContain("run the afk-setup skill to replace it");
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
    readSkillSnapshot(`${name}/SKILL.md`);
  const home = "/home/dev";
  const installed = (dir: string, over: Record<string, string> = {}) =>
    files({
      [`${home}/${dir}/to-spec/SKILL.md`]: snapshot("to-spec"),
      [`${home}/${dir}/to-tickets/SKILL.md`]: snapshot("to-tickets"),
      [`${home}/${dir}/afk-setup/SKILL.md`]: readAfkSetupSkill(),
      ...over,
    });

  it("is quiet when to-spec and to-tickets are what the snapshot holds", async () => {
    expect(await skillsWarnings(installed(".claude/skills"), home)).toEqual([]);
    expect(await skillsWarnings(installed(".cursor/skills"), home)).toEqual([]);
  });

  it("warns about the one that differs, with the command that updates the package for the user", async () => {
    const warnings = await skillsWarnings(
      installed(".claude/skills", {
        [`${home}/.claude/skills/to-tickets/SKILL.md`]: "older",
      }),
      home,
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("to-tickets");
    expect(warnings[0]).toContain(
      "npx skills@latest add xxh171015/afk-platform --skill '*' -g -y",
    );
  });

  it("is quiet when one directory has a stale copy but another has the pinned one", async () => {
    const both = files({
      [`${home}/.claude/skills/to-spec/SKILL.md`]: "older",
      [`${home}/.claude/skills/to-tickets/SKILL.md`]: snapshot("to-tickets"),
      [`${home}/.cursor/skills/to-spec/SKILL.md`]: snapshot("to-spec"),
      [`${home}/.agents/skills/afk-setup/SKILL.md`]: readAfkSetupSkill(),
    });
    expect(await skillsWarnings(both, home)).toEqual([]);
  });

  it("warns about each when none is installed, with the command that installs afk-setup", async () => {
    const warnings = await skillsWarnings(files({}), home);
    expect(warnings).toHaveLength(3);
    expect(warnings.join("\n")).toContain("not found");
    expect(warnings[2]).toContain(
      "npx skills@latest add xxh171015/afk-platform",
    );
  });

  it("warns, with the command that updates it globally, when the user-level afk-setup is not this platform's", async () => {
    const warnings = await skillsWarnings(
      installed(".agents/skills", {
        [`${home}/.agents/skills/afk-setup/SKILL.md`]: "older",
      }),
      home,
    );
    expect(warnings).toEqual([
      expect.stringContaining(
        "npx skills@latest add xxh171015/afk-platform --skill '*' -g -y",
      ),
    ]);
  });

  describe("installed in the planning repo (project level)", () => {
    const repo = "/work/plan";
    const inRepo = (over: Record<string, string> = {}) => ({
      [`${repo}/.agents/skills/to-spec/SKILL.md`]: snapshot("to-spec"),
      [`${repo}/.agents/skills/to-tickets/SKILL.md`]: snapshot("to-tickets"),
      [`${repo}/.agents/skills/afk-setup/SKILL.md`]: readAfkSetupSkill(),
      ...over,
    });

    it("is quiet with nothing installed for the user", async () => {
      expect(await skillsWarnings(files(inRepo()), home, repo)).toEqual([]);
    });

    it("judges the repo's copy over the user's: the agent uses the repo's", async () => {
      const warnings = await skillsWarnings(
        files({
          ...inRepo({ [`${repo}/.agents/skills/to-spec/SKILL.md`]: "older" }),
          [`${home}/.agents/skills/to-spec/SKILL.md`]: snapshot("to-spec"),
        }),
        home,
        repo,
      );
      expect(warnings).toEqual([
        expect.stringContaining("the to-spec skill in this repo"),
      ]);
    });

    it("updates a stale afk-setup in the repo, not for the user", async () => {
      const warnings = await skillsWarnings(
        files(
          inRepo({ [`${repo}/.agents/skills/afk-setup/SKILL.md`]: "older" }),
        ),
        home,
        repo,
      );
      expect(warnings).toEqual([
        expect.stringContaining(
          "update them in this repo: npx skills@latest add xxh171015/afk-platform --skill '*' -y",
        ),
      ]);
    });
  });
});

describe("versionWarnings", () => {
  it("is quiet when plat is the platform's version", async () => {
    expect(
      await versionWarnings(async () => ({
        platformVersion: PLATFORM_VERSION,
      })),
    ).toEqual([]);
  });

  it("points at the afk-setup skill when the platform has moved on", async () => {
    const warnings = await versionWarnings(async () => ({
      platformVersion: "99.0.0",
    }));
    expect(warnings).toEqual([
      `warning: this plat is from platform ${PLATFORM_VERSION}, the platform is 99.0.0: run the afk-setup skill to update it`,
    ]);
  });
});

describe("unreadyRepos", () => {
  const backend = {
    name: "backend",
    url: "https://github.com/acme/backend.git",
  };

  it("names a repo whose default branch has no gates.yaml, with where its setup pull request is", () => {
    expect(
      unreadyRepos([
        {
          ...backend,
          access: {
            state: "ok",
            files: { gates: false, integrationCompose: false },
          },
        },
      ]),
    ).toEqual([
      "backend has no .sandcastle/gates.yaml on its default branch, so its tickets cannot pass a gate: merge its setup pull request (https://github.com/acme/backend/pulls?q=is%3Apr+head%3Aafk%2Fsetup), then confirm again",
    ]);
  });

  it("lets through a repo that has one, and one nobody could check", () => {
    expect(
      unreadyRepos([
        {
          ...backend,
          access: {
            state: "ok",
            files: { gates: true, integrationCompose: false },
          },
        },
        { ...backend, name: "web", access: { state: "pending" } },
        { ...backend, name: "app", access: { state: "not-installed" } },
        { ...backend, name: "lab", access: undefined },
      ]),
    ).toEqual([]);
  });
});

describe("integrationWarnings", () => {
  const ticket = {
    displayId: "T-3",
    type: "integration",
    repo: "web",
    environment: ["backend"],
  };
  const withoutCompose = new Map([
    [
      "backend",
      {
        state: "ok",
        files: { gates: true, integrationCompose: false },
      },
    ],
  ]);

  it("warns when the environment's repo has no compose file and no ticket here adds one", () => {
    expect(integrationWarnings([ticket], [], withoutCompose)).toEqual([
      'T-3 runs its e2e against backend, which has no .sandcastle/integration/compose.yaml on its default branch, and no ticket here in backend adds it: add one (see "Integration tickets" in docs/agents/issue-tracker.md)',
    ]);
  });

  it("is quiet when a ticket file of that repo adds it", () => {
    const file = {
      name: "02-backend-env.md",
      text: "---\nkey: backend-env\nrepo: backend\n---\n## What to build\n\nAdd .sandcastle/integration/compose.yaml ...\n",
    };
    expect(integrationWarnings([ticket], [file], withoutCompose)).toEqual([]);
  });

  it("is quiet when the default branch has one, or nobody could check", () => {
    expect(
      integrationWarnings(
        [ticket],
        [],
        new Map([
          [
            "backend",
            { state: "ok", files: { gates: true, integrationCompose: true } },
          ],
        ]),
      ),
    ).toEqual([]);
    expect(
      integrationWarnings(
        [ticket],
        [],
        new Map([["backend", { state: "pending" }]]),
      ),
    ).toEqual([]);
  });
});
