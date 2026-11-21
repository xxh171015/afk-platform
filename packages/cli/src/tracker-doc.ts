import { type HostKind, pullPhrase } from "@afk/shared";
import { PLATFORM_VERSION } from "@afk/shared/platform-version";
import { SKILLS_SHA } from "@afk/shared/skills-sha";
import {
  readSkillSnapshot,
  type SnapshotFile,
} from "@afk/shared/skills-snapshot";
import { readTemplateText } from "./template-text.ts";

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
    reference?: boolean;
  }[];
}

const HOSTS: Record<
  HostKind,
  {
    name: string;
    cli: string;
    seed: SnapshotFile;
    protectedPath: string;
    protectedExample: string;
  }
> = {
  github: {
    name: "GitHub",
    cli: "gh",
    seed: "setup-matt-pocock-skills/issue-tracker-github.md",
    protectedPath: ".github/**",
    protectedExample: ".github/CODEOWNERS",
  },
  gitlab: {
    name: "GitLab",
    cli: "glab",
    seed: "setup-matt-pocock-skills/issue-tracker-gitlab.md",
    protectedPath: ".gitlab-ci.yml",
    protectedExample: ".gitlab-ci.yml",
  },
};

// A template's first line is the comment naming the skills SHA it was written for (a test holds it to the constant);
// it is not part of the document.
const template = (name: string): string => {
  const text = readTemplateText(name);
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

export function withRepoReferenceFlags(
  project: TrackerDocProject,
  repos: { projectId: number; name: string; reference: boolean }[],
): TrackerDocProject {
  const flags = new Map(
    repos
      .filter((repo) => repo.projectId === project.id)
      .map((repo) => [repo.name, repo.reference]),
  );
  return {
    ...project,
    repos: project.repos.map((repo) => ({
      ...repo,
      reference: repo.reference ?? flags.get(repo.name) ?? false,
    })),
  };
}

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
  const ticketRepos = project.repos.filter((r) => r.reference !== true);
  const values = {
    PROJECT: String(project.id),
    REPO: repo.name,
    REPOS: names(ticketRepos),
    CONTRACT_REPOS: names(ticketRepos.filter((r) => r.contractPath)),
    HOST_NAME: host.name,
    HOST_CLI: host.cli,
    HOST_PR: pullPhrase(repo.hostKind),
    HOST_PRS: `${pullPhrase(repo.hostKind)}s`,
    PROTECTED_PATH: host.protectedPath,
    PROTECTED_EXAMPLE: host.protectedExample,
  };
  const crossRepo =
    ticketRepos.length > 1 && ticketRepos.some((r) => r.contractPath);
  const parts = [
    `<!-- plat tracker-doc ${PLATFORM_VERSION} skills mattpocock/skills@${SKILLS_SHA} project ${project.id} repo ${repo.name} -->`,
    fill(template("routing"), values).trim(),
    fill(template("platform"), values).trim(),
    ...(crossRepo ? [fill(template("multi-repo"), values).trim()] : []),
    ...(ticketRepos.length > 1
      ? [fill(template("integration"), values).trim()]
      : []),
    `## On ${host.name} (\`${host.cli}\`)\n\n${readSkillSnapshot(host.seed).trim()}`,
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
