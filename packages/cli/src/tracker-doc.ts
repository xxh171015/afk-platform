import { readFileSync } from "node:fs";
import type { HostKind } from "@afk/shared";
import { SKILLS_SHA } from "@afk/shared/skills-sha";
import {
  readSkillSnapshot,
  type SnapshotFile,
} from "@afk/shared/skills-snapshot";
import pkg from "../package.json" with { type: "json" };

// The planning repo's docs/agents/issue-tracker.md, generated per project and repo from the templates under
// packages/cli/templates/ and the seed template of the repo's code host in the skills snapshot. Pure: it prints, it
// never writes a file or runs git (docs/specs/m1-platform.md「plat tracker-doc」).

export interface TrackerDocProject {
  id: number;
  name: string;
  repos: {
    name: string;
    url: string;
    defaultBranch: string;
    contractPath: string | null;
    hostKind: HostKind;
  }[];
}

const HOSTS: Record<
  HostKind,
  { name: string; cli: string; seed: SnapshotFile }
> = {
  github: {
    name: "GitHub",
    cli: "gh",
    seed: "setup-matt-pocock-skills/issue-tracker-github.md",
  },
  gitlab: {
    name: "GitLab",
    cli: "glab",
    seed: "setup-matt-pocock-skills/issue-tracker-gitlab.md",
  },
};

// A template's first line is the comment naming the skills SHA it was written for (a test holds it to the constant);
// it is not part of the document.
const template = (name: string): string => {
  const text = readFileSync(
    new URL(`../templates/${name}.md`, import.meta.url),
    "utf8",
  );
  return text.slice(text.indexOf("\n") + 1);
};

const names = (repos: TrackerDocProject["repos"]) =>
  repos.map((r) => r.name).join(", ");

const fill = (text: string, values: Record<string, string>): string =>
  text.replace(/\{\{([A-Z_]+)\}\}/g, (_, key: string) => {
    const value = values[key];
    if (value === undefined) throw new Error(`no value for {{${key}}}`);
    return value;
  });

export function renderTrackerDoc(
  project: TrackerDocProject,
  repoName: string,
): string {
  const repo = project.repos.find((r) => r.name === repoName);
  if (!repo) {
    const have = names(project.repos) || "none";
    throw new Error(
      `project ${project.id} has no repo ${repoName} (it has: ${have})`,
    );
  }
  const host = HOSTS[repo.hostKind];
  const values = {
    PROJECT: String(project.id),
    REPO: repo.name,
    REPOS: names(project.repos),
    CONTRACT_REPOS: names(project.repos.filter((r) => r.contractPath)),
    HOST_NAME: host.name,
    HOST_CLI: host.cli,
  };
  const crossRepo =
    project.repos.length > 1 && project.repos.some((r) => r.contractPath);
  const parts = [
    `<!-- plat tracker-doc ${pkg.version} skills mattpocock/skills@${SKILLS_SHA} project ${project.id} repo ${repo.name} -->`,
    fill(template("routing"), values).trim(),
    fill(template("platform"), values).trim(),
    ...(crossRepo ? [fill(template("multi-repo"), values).trim()] : []),
    `## On ${host.name} (\`${host.cli}\`)\n\n${readSkillSnapshot(host.seed).content.trim()}`,
  ];
  return `${parts.join("\n\n")}\n`;
}

// The project and repo a document was generated for, read from its first line; null when it has no such line.
export function trackerDocTarget(
  doc: string,
): { project: number; repo: string } | null {
  const match =
    /^<!-- plat tracker-doc \S+ skills \S+ project (\d+) repo (\S+) -->/.exec(
      doc,
    );
  return match?.[1] && match[2]
    ? { project: Number(match[1]), repo: match[2] }
    : null;
}
