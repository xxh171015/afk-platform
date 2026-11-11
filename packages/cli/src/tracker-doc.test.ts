import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PLATFORM_VERSION } from "@afk/shared/platform-version";
import { SKILLS_SHA } from "@afk/shared/skills-sha";
import { readSkillSnapshot } from "@afk/shared/skills-snapshot";
import { readTicketFiles } from "@afk/shared/ticket-files";
import { describe, expect, it } from "vitest";
import { renderTrackerDoc } from "./tracker-doc.ts";

const repo = (
  name: string,
  url: string,
  contractPath: string | null = null,
  hostKind: "github" | "gitlab" = "github",
) => ({
  name,
  url,
  defaultBranch: "main",
  contractPath,
  hostKind,
});

const single = {
  id: 3,
  name: "shop",
  repos: [repo("backend", "https://github.com/acme/backend.git")],
};
const several = {
  id: 4,
  name: "shop",
  repos: [
    repo("backend", "https://github.com/acme/backend", "openapi.json"),
    repo("frontend", "https://github.com/acme/frontend"),
  ],
};

describe("renderTrackerDoc", () => {
  it("starts with a version line naming the platform version and the skills SHA", () => {
    const first = renderTrackerDoc(single, "backend").split("\n")[0];
    expect(first).toMatch(
      /^<!-- plat tracker-doc \S+ skills mattpocock\/skills@/,
    );
    expect(first).toContain(` ${PLATFORM_VERSION} skills `);
    expect(first).toContain(`mattpocock/skills@${SKILLS_SHA}`);
  });

  it("opens with the routing table, then the platform part, then the code host part", () => {
    const doc = renderTrackerDoc(single, "backend");
    const routing = doc.indexOf("| A skill says");
    const platform = doc.indexOf("## On the platform (`plat`)");
    const host = doc.indexOf("## On GitHub");
    expect(routing).toBeGreaterThan(0);
    expect(platform).toBeGreaterThan(routing);
    expect(host).toBeGreaterThan(platform);
    expect(doc).toMatch(
      /wayfinder: the map and its tickets\s*\| GitHub\s*\| `gh`/,
    );
  });

  it("fills in the project and the repo", () => {
    const doc = renderTrackerDoc(single, "backend");
    expect(doc).toContain("plat spec create --project 3");
    expect(doc).toContain("`backend` repo");
    expect(doc).not.toContain("{{");
  });

  it("puts the GitHub seed template in, byte for byte, for a GitHub repo", () => {
    const seed = readSkillSnapshot(
      "setup-matt-pocock-skills/issue-tracker-github.md",
    );
    expect(renderTrackerDoc(single, "backend")).toContain(seed);
  });

  it("takes the host from what the repo is registered as, not from its address", () => {
    const doc = renderTrackerDoc(
      {
        id: 5,
        name: "shop",
        repos: [
          repo("backend", "https://gitlab.com/acme/backend", null, "github"),
        ],
      },
      "backend",
    );
    expect(doc).toContain("## On GitHub");
    expect(doc).not.toContain("## On GitLab");
  });

  it("puts the GitLab seed template in, and routes to glab, for a GitLab repo", () => {
    const seed = readSkillSnapshot(
      "setup-matt-pocock-skills/issue-tracker-gitlab.md",
    );
    const doc = renderTrackerDoc(
      {
        id: 5,
        name: "shop",
        repos: [
          repo(
            "backend",
            "https://git.example.org/acme/backend.git",
            null,
            "gitlab",
          ),
        ],
      },
      "backend",
    );
    expect(doc).toContain(seed);
    expect(doc).toMatch(
      /wayfinder: the map and its tickets\s*\| GitLab\s*\| `glab`/,
    );
    expect(doc).not.toContain("issue-tracker-github");
  });

  it("does not put GitHub-only steps in a GitLab project's tracker doc", () => {
    const doc = renderTrackerDoc(
      {
        id: 5,
        name: "shop",
        repos: [
          repo(
            "backend",
            "https://git.example.org/acme/backend.git",
            null,
            "gitlab",
          ),
        ],
      },
      "backend",
    );
    const platform = doc.slice(0, doc.indexOf("## On GitLab"));
    expect(platform).not.toContain(".github/");
    expect(platform).not.toMatch(/`gh`/);
    expect(platform).not.toMatch(/pull request/i);
    expect(platform).toMatch(
      /merge requests treated as requests\s*\|\s*GitLab\s*\|\s*`glab`/,
    );
  });

  it("states the four publishing steps and that confirm is not modify parent", () => {
    const doc = renderTrackerDoc(single, "backend");
    expect(doc).toContain("开工吗");
    expect(doc).toContain("plat spec confirm S-7");
    expect(doc).toContain("~/.afk/planning/S-7/");
    expect(doc).toContain("outside git");
    expect(doc).toMatch(
      /not\*\* what a skill means by "modify a parent issue"/,
    );
    expect(doc).not.toContain("A skill never confirms");
  });

  it("adds the cross-repo rules for several repos with a contract path, and not for one repo", () => {
    const many = renderTrackerDoc(several, "frontend");
    expect(many).toContain("### Several repos");
    expect(many).toContain("backend, frontend");
    expect(many).toContain("(backend)");
    expect(renderTrackerDoc(single, "backend")).not.toContain("Several repos");
    const noContract = renderTrackerDoc(
      {
        ...several,
        repos: several.repos.map((r) => ({ ...r, contractPath: null })),
      },
      "frontend",
    );
    expect(noContract).not.toContain("Several repos");
  });

  it("adds the integration rules for any project of several repos, contract or not", () => {
    const noContract = renderTrackerDoc(
      {
        ...several,
        repos: several.repos.map((r) => ({ ...r, contractPath: null })),
      },
      "frontend",
    );
    expect(noContract).toContain("### Integration tickets");
    expect(noContract).toContain("seed-<repo>");
    expect(renderTrackerDoc(single, "backend")).not.toContain(
      "Integration tickets",
    );
  });

  it("rejects a repo the project does not have, naming the ones it has", () => {
    expect(() => renderTrackerDoc(single, "mobile")).toThrow(/backend/);
  });
});

describe("the template sources", () => {
  const dir = new URL("../templates/", import.meta.url);

  // Guard: a template written for other skills than the pinned ones fails `pnpm check`.
  it.each(readdirSync(fileURLToPath(dir)))(
    "%s was written for the pinned skills SHA",
    (name) => {
      const first = readFileSync(new URL(name, dir), "utf8").split("\n")[0];
      expect(first).toBe(
        `<!-- tracker-doc template for mattpocock/skills@${SKILLS_SHA} -->`,
      );
    },
  );
});

describe("the ticket file in the platform part", () => {
  it("documents the optional stories field as User Story numbers in the spec", () => {
    const doc = renderTrackerDoc(single, "backend");
    expect(doc).toMatch(/stories:\s*\[1,\s*4\]/);
    expect(doc).toMatch(/stories[\s\S]{0,200}User Story/);
    expect(doc).toMatch(/omit|不写|optional/i);
  });

  // Guard: the example a skill copies must be a file the importer accepts.
  it("is imported by the real ticket file reader", () => {
    const doc = renderTrackerDoc(single, "backend");
    const example = /```markdown\n([\s\S]*?)\n```/.exec(doc)?.[1];
    if (!example) throw new Error("no ticket file example in the document");
    const dependency = example
      .replace(/^title: .*$/m, "title: 契约")
      .replace(/^type: .*$/m, "type: contract")
      .replace(/^blocked_by: .*\n/m, "");
    const result = readTicketFiles(
      [
        { name: "01-contract.md", text: dependency },
        { name: "02-orders.md", text: example },
      ],
      7,
    );
    expect(result).toMatchObject({ ok: true });
  });
});
