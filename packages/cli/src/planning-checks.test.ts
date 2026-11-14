import { PLATFORM_VERSION } from "@afk/shared/platform-version";
import { describe, expect, it } from "vitest";
import {
  integrationWarnings,
  skillsWarnings,
  trackerDocWarnings,
  unreadyRepos,
  versionWarnings,
} from "./planning-checks.ts";
import { packageSkillFiles, packageSkills } from "./skills-install.ts";
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
  // The platform's skills, as plat sync writes them into the planning repo.
  const repo = "/work/plan";
  const home = "/home/dev";
  const platformsIn = (dir: string, over: Record<string, string> = {}) => ({
    ...Object.fromEntries(
      packageSkills().map((skill) => [
        `${repo}/${dir}/${skill}/SKILL.md`,
        packageSkillFiles(skill)["SKILL.md"] as string,
      ]),
    ),
    ...over,
  });

  it("is quiet when to-spec and to-tickets are what the snapshot holds", async () => {
    expect(
      await skillsWarnings(files(platformsIn(".agents/skills")), repo),
    ).toEqual([]);
    expect(
      await skillsWarnings(files(platformsIn(".claude/skills")), repo),
    ).toEqual([]);
  });

  it("warns about the one that differs, with the command that brings the repo's skills up", async () => {
    const warnings = await skillsWarnings(
      files(
        platformsIn(".agents/skills", {
          [`${repo}/.agents/skills/to-tickets/SKILL.md`]: "older",
        }),
      ),
      repo,
    );
    expect(warnings).toEqual([
      "warning: to-tickets in this repo not the version this platform uses: bring them up with plat sync (in the planning repo; a copy git tracks is left as it is: take it out of git first)",
    ]);
  });

  it("is quiet when one directory has a stale copy but another has the pinned one", async () => {
    const both = files(
      platformsIn(".agents/skills", {
        [`${repo}/.claude/skills/to-spec/SKILL.md`]: "older",
      }),
    );
    expect(await skillsWarnings(both, repo)).toEqual([]);
  });

  it("warns about each when none is installed, with the command that installs afk-setup", async () => {
    const warnings = await skillsWarnings(files({}), repo);
    expect(warnings).toEqual([
      "warning: afk-setup, domain-modeling, grill-with-docs, grilling, to-spec, to-tickets not found in this repo: put the platform's skills here with plat sync (in the planning repo)",
    ]);
  });

  describe("installed in the planning repo (project level)", () => {
    it("is quiet with nothing installed for the user", async () => {
      expect(
        await skillsWarnings(files(platformsIn(".agents/skills")), repo),
      ).toEqual([]);
    });

    it("judges the repo's copy over the user's: the agent uses the repo's", async () => {
      const warnings = await skillsWarnings(
        files(
          platformsIn(".agents/skills", {
            [`${repo}/.agents/skills/to-spec/SKILL.md`]: "older",
            [`${home}/.agents/skills/to-spec/SKILL.md`]: packageSkillFiles(
              "to-spec",
            )["SKILL.md"] as string,
          }),
        ),
        repo,
      );
      expect(warnings).toEqual([
        expect.stringContaining("to-spec in this repo not the version"),
      ]);
    });

    it("updates a stale afk-setup in the repo, not for the user", async () => {
      const warnings = await skillsWarnings(
        files(
          platformsIn(".agents/skills", {
            [`${repo}/.agents/skills/afk-setup/SKILL.md`]: "older",
          }),
        ),
        repo,
      );
      expect(warnings).toEqual([
        expect.stringContaining("afk-setup in this repo not the version"),
      ]);
    });

    it("does not count skills only the user has: the platform's go in the planning repo", async () => {
      const userOnly = Object.fromEntries(
        Object.entries(platformsIn(".agents/skills")).map(([path, text]) => [
          path.replace(repo, home),
          text,
        ]),
      );
      const warnings = await skillsWarnings(files(userOnly), repo);
      expect(warnings).toEqual([
        expect.stringContaining("not found in this repo"),
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
      `warning: this plat is from platform ${PLATFORM_VERSION}, the platform is 99.0.0: update it with plat update`,
    ]);
  });
});

describe("unreadyRepos", () => {
  const backend = {
    name: "backend",
    url: "https://github.com/acme/backend.git",
  };

  it("names a repo with no gates.yaml on its default branch or afk/setup, and how to set it up", () => {
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
      "backend has no .sandcastle/gates.yaml on its default branch or on afk/setup, so its tickets cannot pass a gate: set it up with the afk-setup skill, then confirm again",
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

  it("names a GitLab repo whose token user is not a member, with the same fix confirm shows", () => {
    expect(
      unreadyRepos([
        {
          name: "web",
          url: "https://gitlab.com/acme/web.git",
          access: {
            state: "not-member",
            username: "alice",
            fix: "请项目 Maintainer 把〈alice〉加为 Developer",
          },
        },
      ]),
    ).toEqual(["web: 请项目 Maintainer 把〈alice〉加为 Developer"]);
  });

  it("names a GitLab repo whose PAT check failed, so confirm cannot start", () => {
    expect(
      unreadyRepos([
        {
          name: "backend",
          url: "https://gitlab.example/acme/backend.git",
          access: {
            state: "error",
            hostKind: "gitlab",
            message: "GitLab did not describe the token's user: HTTP 401",
          },
        },
      ]),
    ).toEqual([
      "backend: 托管无法检查：GitLab did not describe the token's user: HTTP 401",
    ]);
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
      'T-3 runs its e2e against backend, which has no .sandcastle/integration/compose.yaml on its default branch or on afk/setup, and no ticket here in backend adds it: add one (see "Integration tickets" in docs/agents/issue-tracker.md)',
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
