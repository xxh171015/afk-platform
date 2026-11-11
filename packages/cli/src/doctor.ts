import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  type DoctorItem,
  type DoctorReport,
  hostKindOfUrl,
  SETUP_BRANCH,
  SKILLS_PACKAGE,
} from "@afk/shared";
import { PLATFORM_VERSION } from "@afk/shared/platform-version";
import { CLAUDE_RULES_PATH, CURSOR_RULES_PATH } from "./agent-docs.ts";
import { TRACKER_DOC_PATH } from "./init.ts";
import {
  skillsWarnings,
  trackerDocWarnings,
  versionWarnings,
} from "./planning-checks.ts";
import { type TrackerDocProject, trackerDocTarget } from "./tracker-doc.ts";

const GATES_PATH = ".sandcastle/gates.yaml";
const AGENTS_MD = "AGENTS.md";
const SETUP = "run the afk-setup skill";
const SKILLS_INSTALL = `npx skills@latest add ${SKILLS_PACKAGE}`;
const NODE_MAJOR_MIN = 20;

export interface DoctorInput {
  cwd: string;
  home: string | undefined;
  readFile: (path: string) => Promise<string>;
  loadVersion: () => Promise<{ platformVersion: string } | undefined>;
  loadProject: (id: number) => Promise<TrackerDocProject>;
  projectId?: number;
  now?: Date;
  machine?: string;
}

function git(cwd: string, args: string[]): { ok: boolean; out: string } {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 15_000,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o ConnectTimeout=5",
    },
  });
  return { ok: result.status === 0, out: (result.stdout ?? "").trim() };
}

function stripWarning(line: string): string {
  return line.replace(/^warning: /, "");
}

function item(
  id: string,
  title: string,
  warnings: string[],
  command: string | undefined,
): DoctorItem {
  if (warnings.length === 0) return { id, title, status: "ok" };
  return {
    id,
    title,
    status: "fail",
    detail: warnings.map(stripWarning).join("; "),
    command,
  };
}

function fileOnDefaultOrSetup(cwd: string, path: string): boolean {
  const refs: string[] = [];
  const head = git(cwd, ["rev-parse", "--abbrev-ref", "origin/HEAD"]);
  if (head.ok && head.out) refs.push(head.out);
  if (
    git(cwd, ["rev-parse", "--verify", "--quiet", `origin/${SETUP_BRANCH}`]).ok
  )
    refs.push(`origin/${SETUP_BRANCH}`);
  if (refs.length === 0) return existsSync(join(cwd, path));
  return refs.some((ref) => git(cwd, ["cat-file", "-e", `${ref}:${path}`]).ok);
}

async function projectIdOf(
  input: DoctorInput,
  read: (path: string) => Promise<string>,
): Promise<number | undefined> {
  if (input.projectId !== undefined) return input.projectId;
  try {
    return trackerDocTarget(await read(TRACKER_DOC_PATH))?.project;
  } catch {
    return undefined;
  }
}

export async function collectDoctorReport(
  input: DoctorInput,
): Promise<DoctorReport & { projectId: number | undefined }> {
  const cwd = input.cwd;
  const read = (path: string) =>
    input.readFile(isAbsolute(path) ? path : join(cwd, path));
  const projectId = await projectIdOf(input, read);
  const items: DoctorItem[] = [];

  const nodeMajor = Number(process.version.slice(1).split(".")[0]);
  items.push(
    nodeMajor >= NODE_MAJOR_MIN
      ? { id: "node", title: "Node", status: "ok" }
      : {
          id: "node",
          title: "Node",
          status: "fail",
          detail: `this Node is ${process.version}; the platform wants ${NODE_MAJOR_MIN}+`,
          command: "brew install node",
        },
  );

  const gitVersion = spawnSync("git", ["--version"], { encoding: "utf8" });
  items.push(
    gitVersion.status === 0
      ? { id: "git", title: "git", status: "ok" }
      : {
          id: "git",
          title: "git",
          status: "fail",
          detail: "git is not on PATH",
          command: "xcode-select --install",
        },
  );

  const version = await input.loadVersion();
  items.push(
    version
      ? { id: "platform", title: "platform", status: "ok" }
      : {
          id: "platform",
          title: "platform",
          status: "fail",
          detail: "the platform did not answer GET /version",
          command: "plat connect <address>",
        },
  );

  if (version) {
    items.push(
      item(
        "plat",
        "plat",
        await versionWarnings(async () => version),
        "plat update",
      ),
    );
  } else {
    items.push({
      id: "plat",
      title: "plat",
      status: "fail",
      detail: `this plat is from platform ${PLATFORM_VERSION}; the platform did not answer`,
      command: "plat update",
    });
  }

  items.push(
    item(
      "skills",
      "skills",
      input.home
        ? await skillsWarnings(read, input.home, cwd)
        : ["warning: HOME is not set; cannot look for skills"],
      SKILLS_INSTALL,
    ),
  );

  const tracker =
    projectId === undefined
      ? await trackerDocWarnings(read, input.loadProject, undefined)
      : await trackerDocWarnings(read, input.loadProject, projectId);
  items.push(item("tracker-doc", "Tracker doc", tracker, SETUP));

  const rules = [CLAUDE_RULES_PATH, CURSOR_RULES_PATH].filter((path) =>
    existsSync(join(cwd, path)),
  );
  items.push(
    rules.length > 0
      ? { id: "local-rules", title: "local rules", status: "ok" }
      : {
          id: "local-rules",
          title: "local rules",
          status: "fail",
          detail: `${CLAUDE_RULES_PATH} and ${CURSOR_RULES_PATH} are missing`,
          command: SETUP,
        },
  );

  const inGit = git(cwd, ["rev-parse", "--show-toplevel"]).ok;
  if (inGit) {
    items.push(
      fileOnDefaultOrSetup(cwd, AGENTS_MD)
        ? { id: "agents-md", title: "AGENTS.md", status: "ok" }
        : {
            id: "agents-md",
            title: "AGENTS.md",
            status: "fail",
            detail: `${AGENTS_MD} is not on the default branch or origin/${SETUP_BRANCH}`,
            command: SETUP,
          },
    );
    items.push(
      fileOnDefaultOrSetup(cwd, GATES_PATH)
        ? { id: "gates", title: "gates.yaml", status: "ok" }
        : {
            id: "gates",
            title: "gates.yaml",
            status: "fail",
            detail: `${GATES_PATH} is not on the default branch or origin/${SETUP_BRANCH}`,
            command: SETUP,
          },
    );
    const origin = git(cwd, ["config", "--get", "remote.origin.url"]).out;
    if (origin && hostKindOfUrl(origin) === "github") {
      const gh = spawnSync("gh", ["auth", "status"], {
        encoding: "utf8",
        timeout: 10_000,
      });
      items.push(
        gh.status === 0
          ? { id: "gh", title: "gh", status: "ok" }
          : {
              id: "gh",
              title: "gh",
              status: "fail",
              detail: "gh is missing or not logged in (this origin is GitHub)",
              command: "gh auth login",
            },
      );
    }
  } else {
    items.push({
      id: "agents-md",
      title: "AGENTS.md",
      status: "fail",
      detail: "this directory is not a git checkout",
      command: SETUP,
    });
    items.push({
      id: "gates",
      title: "gates.yaml",
      status: "fail",
      detail: "this directory is not a git checkout",
      command: SETUP,
    });
  }

  return {
    machine: input.machine ?? hostname(),
    projectId,
    checkedAt: (input.now ?? new Date()).toISOString(),
    items,
  };
}

export function formatDoctorText(
  report: DoctorReport & { projectId?: number },
): string {
  const lines = [`${report.machine}  ${report.checkedAt}`];
  for (const entry of report.items) {
    const detail = entry.detail ? `  ${entry.detail}` : "";
    lines.push(`${entry.title.padEnd(14)} ${entry.status}${detail}`);
    if (entry.command) lines.push(`${"".padEnd(14)} ${entry.command}`);
  }
  return lines.join("\n");
}
