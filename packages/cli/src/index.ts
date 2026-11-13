import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  type ApiClient,
  CLI_HEADERS,
  createApiClient,
  formatDisplayId,
  HOST_HEADER,
  HOST_KINDS,
  MAX_PLANNING_PATCH_BYTES,
  PLAT_HEADER,
  PLAT_OUTDATED,
  parseDisplayId,
  purgedLogMessage,
  SETUP_BRANCH,
  STAGE_MODEL_KEYS,
  type StageModels,
  TICKET_REVIEW_MODES,
  type TicketReviewMode,
} from "@afk/shared";
import { PLATFORM_VERSION } from "@afk/shared/platform-version";
import {
  normalizeSpecBody,
  specTemplateWarnings,
} from "@afk/shared/spec-template";
import {
  Command,
  CommanderError,
  InvalidArgumentError,
  Option,
} from "commander";
import { afkHome } from "./afk-home.ts";
import { planAgentDocs } from "./agent-docs.ts";
import { inspectContextCheckout } from "./context.ts";
import { collectDoctorReport, formatDoctorText } from "./doctor.ts";
import {
  blockedText,
  contextText,
  projectText,
  specText,
  ticketText,
} from "./format.ts";
import { isTracked, missingExcludes } from "./git-exclude.ts";
import {
  codeHostProblems,
  hasRegistrations,
  InitError,
  inspectCheckout,
  parseWith,
  planInit,
  planText,
  TRACKER_DOC_PATH,
  unknownHostProblem,
  withKnownHostKind,
} from "./init.ts";
import {
  dropBackup,
  dropFinishedSpecs,
  readBackup,
  saveBackup,
  specPlanningDir,
} from "./planning-backup.ts";
import {
  integrationWarnings,
  skillsWarnings,
  staleSkills,
  trackerDocWarnings,
  unreadyRepos,
  versionWarnings,
} from "./planning-checks.ts";
import {
  type PlanningDocs,
  putPlanningDocsAside,
  putPlanningDocsBack,
  readPlanningDocs,
  uncommittedPlanningDocs,
  unresolvedPlanningDocs,
} from "./planning-docs.ts";
import { writePlanningFiles } from "./planning-files.ts";
import { rememberApiUrl, rememberedApiUrl } from "./plat-config.ts";
import {
  fingerprintOf,
  PlatOutdated,
  platFile,
  type Rerun,
  replacePlat,
  rerunPlat,
  UPDATED_FROM,
} from "./self-update.ts";
import { type RunCommand, runCommand, updateSkills } from "./skills-install.ts";
import { renderTrackerDoc, trackerDocTarget } from "./tracker-doc.ts";

// `plat`: the developer's and the planning agent's way into the platform API (docs/specs/m1-platform.md「plat CLI」).
// Output is for people by default and a single JSON document with --json (for skills and scripts).

// Every call says it is plat, from which machine, and which plat (self-update.ts): the API records a person's
// actions with the first two and refuses to publish from an older plat.
const cliHeaders = (plat = fingerprintOf("")) => ({
  ...CLI_HEADERS,
  [HOST_HEADER]: hostname(),
  [PLAT_HEADER]: plat,
});

export interface Io {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: Record<string, string | undefined>;
  readFile: (path: string) => Promise<string>;
  // The regular files of a directory (not the hidden ones), with their text. Rejects when it is not a directory.
  readDirectory: (path: string) => Promise<{ name: string; text: string }[]>;
  cwd?: string; // git inspect for `plat spec confirm`; process.cwd() when omitted
  // Asks the person a yes/no question (`plat init`); absent when nobody can answer, e.g. stdin is not a terminal.
  confirm?: (question: string) => Promise<boolean>;
  // Runs a command such as the skills CLI (`plat update`); runCommand (skills-install.ts) when omitted.
  run?: RunCommand;
  // The file plat runs from, which `plat update` and the self-update replace; when omitted, process.argv[1] if it is
  // the platform's bundle, else none (""). See self-update.ts.
  platPath?: string;
  // Runs plat again after it replaced itself (self-update.ts); rerunPlat when omitted.
  rerun?: Rerun;
}

// How long plat init waits for a worker to say whether the GitHub App or GitLab PAT can work on the repos.
const ACCESS_WAIT_SECONDS = 20;

function accessLine(
  name: string,
  access:
    | {
        state: string;
        hostKind?: string;
        missing?: string[];
        fixUrl?: string;
        message?: string;
        username?: string;
        fix?: string;
        hints?: string[];
      }
    | undefined,
): string {
  const whoever = "(whoever runs the platform)";
  const gitlab = access?.hostKind === "gitlab";
  switch (access?.state) {
    case "ok": {
      if (!gitlab) return `${name}: the GitHub App can work here`;
      const extra: string[] = [];
      if (access.hints?.includes("personal-token"))
        extra.push(
          `平台用的是个人令牌：推送和 MR 显示为〈${access.username ?? "令牌用户"}〉，平台不调合并接口，但合并者是不是平台检测不出；换 bot 账号放 M4`,
        );
      if (access.hints?.includes("developers-can-merge"))
        extra.push("Developers 能合并默认分支");
      return extra.length > 0
        ? `${name}: 托管正常（${extra.join("；")}）`
        : `${name}: 托管正常`;
    }
    case "not-installed":
      return `${name}: the GitHub App is not installed on this repo; install it ${whoever}: ${access.fixUrl ?? ""}`.trimEnd();
    case "missing-permissions":
      return `${name}: the GitHub App lacks ${(access.missing ?? []).join(", ")}; grant it ${whoever}: ${access.fixUrl ?? ""}`.trimEnd();
    case "not-member":
      return `${name}: ${access.fix ?? `请项目 Maintainer 把${access.username ? `〈${access.username}〉` : "令牌用户"}加为 Developer`}`;
    case "error":
      return gitlab
        ? `${name}: 托管无法检查：${access.message ?? "unknown error"}`
        : `${name}: the GitHub App could not be checked: ${access.message ?? "unknown error"}`;
    case "pending":
      return gitlab
        ? `${name}: 托管尚未检查（还没有 worker 回答）`
        : `${name}: the GitHub App is not checked yet (no worker has answered)`;
    default:
      return gitlab
        ? `${name}: 托管尚未检查`
        : `${name}: the GitHub App is not checked yet (no worker has answered)`;
  }
}

async function askOnTerminal(question: string): Promise<boolean> {
  const prompt = createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  try {
    return /^y(es)?$/i.test(
      (await prompt.question(`${question} [y/N] `)).trim(),
    );
  } finally {
    prompt.close();
  }
}

export const defaultIo: Io = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  env: process.env,
  readFile: (path) => readFile(path, "utf8"),
  readDirectory: async (path) => {
    if (!(await stat(path)).isDirectory()) throw new Error("not a directory");
    const entries = await readdir(path, { withFileTypes: true });
    return await Promise.all(
      entries
        .filter((e) => e.isFile() && !e.name.startsWith("."))
        .map(async (e) => ({
          name: e.name,
          text: await readFile(join(path, e.name), "utf8"),
        })),
    );
  },
  confirm: process.stdin.isTTY ? askOnTerminal : undefined,
};

const DEFAULT_API_URL = "http://127.0.0.1:3000";

const toInt = (value: string): number => {
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new InvalidArgumentError("must be a positive integer");
  }
  return Number(value);
};
const toOffset = (value: string): number => {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new InvalidArgumentError("must be a non-negative integer");
  }
  return Number(value);
};
const toTicketReview = (value: string): TicketReviewMode => {
  if (!(TICKET_REVIEW_MODES as readonly string[]).includes(value)) {
    throw new InvalidArgumentError("must be spec or both");
  }
  return value as TicketReviewMode;
};
const collect = (value: string, previous: string[] = []) => [
  ...previous,
  value,
];

const hostKindOption = () =>
  new Option(
    "--host-kind <kind>",
    "the code host: github or gitlab (default when adding: from the url)",
  ).choices(HOST_KINDS);

const contractPathMoved = () =>
  new Failure(
    "the contract path now belongs to a repo, not the project: use plat repo edit <name> --project <id> --contract-path <path>",
  );

class Failure extends Error {
  readonly body: unknown;
  constructor(message: string, body: unknown = { error: message }) {
    super(message);
    this.body = body;
  }
}

// Returns the process exit code.
export async function run(argv: string[], io: Io = defaultIo): Promise<number> {
  const program = new Command("plat")
    .description("AFK platform command line")
    .option("--json", "print one JSON document instead of text")
    .option(
      "--api-url <url>",
      "platform API (default $AFK_API_URL, else the address plat connect remembered, else http://127.0.0.1:3000)",
    )
    .exitOverride()
    .configureOutput({
      writeOut: io.stdout,
      writeErr: io.stderr,
    });

  const json = () => Boolean(program.opts().json);
  // Where the platform is: --api-url, $AFK_API_URL, the address `plat connect` remembered, the default.
  // An empty setting counts as none, as the worker has it.
  const apiUrl = (): string =>
    withoutTrailingSlash(
      program.opts().apiUrl ||
        io.env.AFK_API_URL ||
        rememberedApiUrl(afkHome(io.env)) ||
        DEFAULT_API_URL,
    );
  // Which plat this is (self-update.ts); a new plat that just replaced an older one is run with UPDATED_FROM.
  const self = platFile(io.platPath);
  const plat = fingerprintOf(self);
  const updatedFrom = io.env[UPDATED_FROM];
  const api = (): ApiClient => {
    const client = createApiClient(apiUrl(), undefined, cliHeaders(plat));
    // the API refuses to publish from an older plat: run() replaces this one and runs the command again
    client.use({
      async onResponse({ response }) {
        if (response.status !== 409) return undefined;
        const body = await response
          .clone()
          .json()
          .catch(() => null);
        if ((body as { code?: unknown } | null)?.code === PLAT_OUTDATED)
          throw new PlatOutdated();
        return undefined;
      },
    });
    return client;
  };

  // Before a command: an older plat than the platform hands out replaces itself and runs the command again (run()
  // catches PlatOutdated); the new plat brings this machine up first and says what changed.
  const topCommand = (command: Command): string => {
    let at = command;
    while (at.parent && at.parent !== program) at = at.parent;
    return at.name();
  };
  program.hook("preAction", async (_program, action) => {
    const top = topCommand(action);
    if (NO_SELF_UPDATE.has(top)) return;
    if (self && !updatedFrom) {
      const latest = await createApiClient(
        apiUrl(),
        undefined,
        cliHeaders(plat),
      )
        .GET("/version")
        .then((r) => r.data?.platFingerprint)
        .catch(() => undefined);
      if (latest && latest !== plat) throw new PlatOutdated();
    }
    if (updatedFrom && top !== "sync") {
      const lines = await syncMachine(true);
      io.stderr(
        `${[`plat: updated itself to the platform's (${updatedFrom} -> ${PLATFORM_VERSION})`, ...lines].join("\n")}\n`,
      );
    }
  });

  // Brings this planning machine up to the platform's (`plat sync`, and after a self-update): the planning skills
  // when they are not the platform's (always after a self-update: plat carries only some of their text), and the
  // planning files plat writes in this repo. The lines say what changed; nothing here fails the command.
  const syncMachine = async (afterUpdate: boolean): Promise<string[]> => {
    const lines: string[] = [];
    const cwd = io.cwd ?? process.cwd();
    const top = spawnSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
    });
    const repo = top.status === 0 ? top.stdout.trim() : undefined;
    const home = io.env.HOME ?? homedir();
    const client = api();
    const version = await client
      .GET("/version")
      .then((r) => r.data)
      .catch(() => undefined);

    // absolute paths: the home directory and the repo's top, wherever plat runs
    const readAbsolute = async (path: string) => readFileSync(path, "utf8");
    const stale =
      afterUpdate ||
      (await staleSkills(readAbsolute, home, repo ?? cwd)).length > 0;
    if (stale) {
      try {
        lines.push(
          ...updateSkills({
            home,
            repo,
            commit: version?.platformCommit ?? null,
            run: io.run ?? runCommand,
          }),
        );
      } catch (error) {
        lines.push(
          `skills: could not update them: ${(error as Error).message}; run plat update`,
        );
      }
    } else {
      lines.push("skills: nothing to update");
    }

    const doc = repo
      ? await readAbsolute(join(repo, TRACKER_DOC_PATH)).catch(() => null)
      : null;
    const target = doc ? trackerDocTarget(doc) : null;
    if (!repo || !target) {
      lines.push(
        "planning files: none here (this is not a planning repo set up with afk-setup)",
      );
      return lines;
    }
    const project = await client.GET("/projects/{projectId}", {
      params: { path: { projectId: target.project } },
    });
    if (!project.data) {
      lines.push(
        `planning files: could not load project ${target.project}, so they were left as they are`,
      );
      return lines;
    }
    const written = writePlanningFiles(
      repo,
      afkHome(io.env),
      project.data,
      target.repo,
    );
    const changed = [
      ...(written.trackerDoc === "unchanged"
        ? []
        : [`${TRACKER_DOC_PATH} ${written.trackerDoc}`]),
      ...Object.entries(written.docs)
        .filter(([, state]) => state !== "unchanged")
        .map(([path, state]) => `${path} ${state}`),
    ];
    lines.push(
      changed.length === 0
        ? "planning files: up to date"
        : `planning files: ${changed.join(", ")}`,
    );
    if (written.tracked.length > 0)
      lines.push(
        `planning files: git tracks ${written.tracked.join(", ")} here, so the change shows in git status: commit it`,
      );
    return lines;
  };

  // The planning docs kept for specs that are merged or cancelled by now go, whatever the command.
  program.hook("preAction", async () => {
    try {
      await dropFinishedSpecs(afkHome(io.env), apiUrl(), async (id) => {
        const { data } = await api().GET("/specs/{id}", {
          params: { path: { id } },
        });
        return data?.spec.state;
      });
    } catch {
      // a clean-up that cannot run is not worth failing the command
    }
  });
  const print = (value: unknown, text: string) =>
    io.stdout(json() ? `${JSON.stringify(value)}\n` : `${text}\n`);

  const projectCommands = program.command("project").description("projects");
  projectCommands
    .command("create <name>")
    .description("register a project")
    .option("--default-agent <agent>")
    .option(
      "--default-model <model>",
      "the Cursor model for its agent runs (the worker's AFK_MODEL when unset)",
    )
    .option(
      "--contract-path <path>",
      "moved to plat repo edit <name> --contract-path",
    )
    .option("--protected-path <glob>", "repeatable", collect)
    .option("--max-concurrency <n>", "tickets running at once", toInt)
    .option("--budget-limit <n>", "budget limit", toInt)
    .option("--merge-policy <policy>")
    .option(
      "--limit <name=value>",
      "override a concurrency or budget default, e.g. repoConcurrency=3 (repeatable)",
      collect,
    )
    .option(
      "--ticket-review <mode>",
      "ticket-level review: spec (default, Spec axis only) or both",
      toTicketReview,
    )
    .option(
      "--stage-model <name=model>",
      "model for standards, update-branch, or merge-fix (repeatable; empty clears)",
      collect,
    )
    .action(async (name: string, options) => {
      if (options.contractPath !== undefined) throw contractPathMoved();
      const { data, response, error } = await api().POST("/projects", {
        body: {
          name,
          defaultAgent: options.defaultAgent,
          defaultModel: options.defaultModel,
          protectedPaths: options.protectedPath,
          maxConcurrency: options.maxConcurrency,
          budgetLimit: options.budgetLimit,
          mergePolicy: options.mergePolicy,
          limits: parseLimits(options.limit),
          ticketReview: options.ticketReview,
          stageModels: stageModelsFromPairs(options.stageModel),
        },
      });
      if (!data) throw failureFrom(response, error);
      print(data, `project ${data.id} ${data.name}`);
    });

  projectCommands
    .command("edit <project>")
    .description(
      "change settings of an existing project; only the given ones change (tickets already made keep theirs)",
    )
    .option("--default-agent <agent>")
    .option(
      "--default-model <model>",
      "the Cursor model for its agent runs (the worker's AFK_MODEL when unset)",
    )
    .option(
      "--contract-path <path>",
      "moved to plat repo edit <name> --contract-path",
    )
    .option(
      "--protected-path <glob>",
      "repeatable; replaces the whole list",
      collect,
    )
    .option("--max-concurrency <n>", "tickets running at once", toInt)
    .option("--budget-limit <n>", "budget limit", toInt)
    .option(
      "--limit <name=value>",
      "override a concurrency or budget default, merged with the ones already set (repeatable)",
      collect,
    )
    .option(
      "--feishu-chat <chat_id>",
      "Feishu group chat_id for this project's notifications (empty clears it)",
    )
    .option(
      "--ticket-review <mode>",
      "ticket-level review: spec (Spec axis only) or both",
      toTicketReview,
    )
    .option(
      "--stage-model <name=model>",
      "model for standards, update-branch, or merge-fix (repeatable; empty clears that key)",
      collect,
    )
    .action(async (id: string, options) => {
      if (options.contractPath !== undefined) throw contractPathMoved();
      const body = {
        defaultAgent: options.defaultAgent,
        defaultModel: options.defaultModel,
        protectedPaths: options.protectedPath,
        maxConcurrency: options.maxConcurrency,
        budgetLimit: options.budgetLimit,
        limits: parseLimits(options.limit),
        feishuChatId: options.feishuChat as string | undefined,
        ticketReview: options.ticketReview,
        stageModels: stageModelsFromPairs(options.stageModel),
      };
      if (Object.values(body).every((value) => value === undefined)) {
        throw new Failure(
          "nothing to change: pass --default-agent, --default-model, --protected-path, --max-concurrency, --budget-limit, --limit, --feishu-chat, --ticket-review or --stage-model",
        );
      }
      const projectId = toInt(id);
      const { data, response, error } = await api().PATCH(
        "/projects/{projectId}",
        { params: { path: { projectId } }, body },
      );
      if (!data) throw failureFrom(response, error);
      print(data, `project ${data.id} updated`);
    });

  projectCommands
    .command("show <project>")
    .description("a project and its default agent")
    .action(async (id: string) => {
      const projectId = toInt(id);
      const { data, response, error } = await api().GET(
        "/projects/{projectId}",
        { params: { path: { projectId } } },
      );
      if (!data) throw failureFrom(response, error);
      print(data, projectText(data));
    });

  const repoCommands = program.command("repo").description("repos");
  repoCommands
    .command("add")
    .description("add a repo to a project")
    .requiredOption("--project <id>", "project id", toInt)
    .option(
      "--name <name>",
      "how a ticket file names it (its repo field), e.g. backend",
    )
    .option("--role <role>", "older word for --name; still works")
    .requiredOption("--url <url>", "clone URL")
    .option("--default-branch <branch>", "default: main")
    .addOption(hostKindOption())
    .action(async (options) => {
      if ((options.name === undefined) === (options.role === undefined)) {
        throw new Failure("give the repo's --name (--role is the older word)");
      }
      const hosts = await api().GET("/hosts");
      if (!hosts.data) throw failureFrom(hosts.response, hosts.error);
      const unknown = unknownHostProblem(
        options.name ?? options.role,
        options.url,
        hosts.data.hosts,
      );
      if (unknown) throw new Failure(unknown);
      const { data, response, error } = await api().POST(
        "/projects/{projectId}/repos",
        {
          params: { path: { projectId: options.project } },
          body: {
            url: options.url,
            name: options.name,
            role: options.role,
            defaultBranch: options.defaultBranch,
            hostKind: options.hostKind,
          },
        },
      );
      if (!data) throw failureFrom(response, error);
      // a worker checks whether the GitHub App can work on it; plat init shows the answer
      await api().POST("/projects/{projectId}/repos/{name}/access-check", {
        params: { path: { projectId: options.project, name: data.name } },
      });
      print(data, `repo ${data.id} ${data.name}`);
    });

  repoCommands
    .command("edit <name>")
    .description("change settings of a repo; only the given ones change")
    .requiredOption("--project <id>", "project id", toInt)
    .option(
      "--contract-path <path>",
      'where the repo keeps its contract file, e.g. openapi/openapi.yaml; pass "" to clear',
    )
    .addOption(hostKindOption())
    .action(async (name: string, options) => {
      if (
        options.contractPath === undefined &&
        options.hostKind === undefined
      ) {
        throw new Failure(
          "nothing to change: pass --contract-path or --host-kind",
        );
      }
      const { data, response, error } = await api().PATCH(
        "/projects/{projectId}/repos/{name}",
        {
          params: { path: { projectId: options.project, name } },
          body: {
            contractPath: options.contractPath,
            hostKind: options.hostKind,
          },
        },
      );
      if (!data) throw failureFrom(response, error);
      print(data, `repo ${data.id} ${data.name} updated`);
    });

  repoCommands
    .command("check <name>")
    .description(
      "have the platform run the repo's gate on a pushed branch, in its own sandbox, with that branch's .sandcastle/gates.yaml; waits for the answer",
    )
    .option("--branch <branch>", "the pushed branch to gate", SETUP_BRANCH)
    .option(
      "--project <id>",
      "the project (default: the one this checkout's tracker doc names)",
      toInt,
    )
    .action(async (name: string, options) => {
      let projectId: number | undefined = options.project;
      if (projectId === undefined) {
        const target = await io
          .readFile(TRACKER_DOC_PATH)
          .then(trackerDocTarget)
          .catch(() => null);
        projectId = target?.project;
      }
      if (projectId === undefined)
        throw new Failure(
          "which project? run this in the planning repo (its tracker doc names the project), or give --project",
        );
      const client = api();
      const queued = await client.POST(
        "/projects/{projectId}/repos/{name}/gate-check",
        {
          params: { path: { projectId, name } },
          body: { branch: options.branch },
        },
      );
      if (!queued.data) throw failureFrom(queued.response, queued.error);
      const pollMs = Number(io.env.AFK_POLL_SECONDS ?? 3) * 1000;
      const deadline = Date.now() + 60 * 60 * 1000;
      for (;;) {
        const { data, response, error } = await client.GET(
          "/projects/{projectId}/repos/{name}/gate-checks/{id}",
          { params: { path: { projectId, name, id: queued.data.id } } },
        );
        if (!data) throw failureFrom(response, error);
        const label = `${name} ${data.branch}`;
        if (data.state === "failed")
          throw new Failure(
            `${label}: the check could not run: ${data.error ?? "unknown error"}`,
          );
        if (data.state === "done") {
          const result = data.result;
          if (!result)
            throw new Failure(
              `${label}: the worker's answer was not understood`,
            );
          if (result.pass) {
            print(
              data,
              `${label}: the gate passed in the platform's sandbox (${result.steps.join(", ")}${result.tests === undefined ? "" : `; ${result.tests} tests`})`,
            );
            return;
          }
          print(
            data,
            [
              `${label}: the gate failed: ${result.reasons.join("; ")}`,
              ...(result.log
                ? [
                    `--- the end of ${result.failedStep ?? "its"} output ---`,
                    result.log,
                  ]
                : []),
            ].join("\n"),
          );
          throw new Failure("the gate failed");
        }
        if (Date.now() > deadline)
          throw new Failure(
            `${label}: no answer after an hour (is a worker running?)`,
          );
        await new Promise((done) => setTimeout(done, pollMs));
      }
    });

  // The warnings `spec create` and `tickets import` print about this planning machine; they never change the exit code.
  const warnAboutPlanningMachine = async (project?: number) => {
    try {
      const warnings = [
        ...(await trackerDocWarnings(
          io.readFile,
          async (id) => {
            const { data } = await api().GET("/projects/{projectId}", {
              params: { path: { projectId: id } },
            });
            if (!data) throw new Error("no such project");
            return data;
          },
          project,
        )),
        ...(io.env.HOME
          ? await skillsWarnings(io.readFile, io.env.HOME, ".")
          : []),
      ];
      for (const warning of warnings) io.stderr(`${warning}\n`);
    } catch {
      // A check that cannot run is not worth failing a command that worked.
    }
    await warnAboutVersion();
  };

  // Asks the workers again about each repo (whether the GitHub App can work there, and which setup files its default
  // branch has) and waits up to AFK_ACCESS_WAIT_SECONDS for the answers; a repo nobody answered for comes back as
  // the API last knew it.
  const accessWaitSeconds = () =>
    Number(io.env.AFK_ACCESS_WAIT_SECONDS ?? ACCESS_WAIT_SECONDS);
  const checkRepos = async (projectId: number, names: string[]) => {
    const client = api();
    for (const name of names) {
      await client.POST("/projects/{projectId}/repos/{name}/access-check", {
        params: { path: { projectId, name } },
      });
    }
    const deadline = Date.now() + accessWaitSeconds() * 1000;
    const read = async () =>
      Promise.all(
        names.map(async (name) => {
          const { data } = await client.GET(
            "/projects/{projectId}/repos/{name}/access",
            { params: { path: { projectId, name } } },
          );
          return { name, access: data };
        }),
      );
    let found = await read();
    while (
      Date.now() < deadline &&
      found.some(
        ({ access }) => access?.state === "pending" || access?.checking,
      )
    ) {
      await new Promise((done) => setTimeout(done, 1000));
      found = await read();
    }
    return found;
  };

  // An older plat than the platform it talks to: /afk-setup fetches the platform's.
  const warnAboutVersion = async () => {
    try {
      for (const warning of await versionWarnings(async () => {
        const { data } = await api().GET("/version");
        if (!data) throw new Error("no version");
        return data;
      }))
        io.stderr(`${warning}\n`);
    } catch {}
  };

  program
    .command("version")
    .description("print the platform version this plat comes from")
    .action(() => {
      io.stdout(`${PLATFORM_VERSION}\n`);
    });

  program
    .command("connect [url]")
    .description(
      "remember the platform's address on this machine, once the platform answers there; --api-url and $AFK_API_URL still come first. Without an address: the address plat uses now, and whether the platform answers there",
    )
    .action(async (url: string | undefined) => {
      if (url === undefined) {
        const address = apiUrl();
        const version = await platformVersionAt(address);
        if (!version)
          throw new Failure(
            `plat uses ${address}, and no platform answers there`,
          );
        print(
          { apiUrl: address, platformVersion: version },
          `plat: the platform is at ${address} (${version})`,
        );
        return;
      }
      const address = withoutTrailingSlash(url);
      const version = await platformVersionAt(address);
      if (!version)
        throw new Failure(
          `no platform answers at ${address} (GET ${address}/version); nothing remembered`,
        );
      const file = rememberApiUrl(afkHome(io.env), address);
      print(
        { apiUrl: address, platformVersion: version, file },
        `plat: the platform is at ${address} (${version}); remembered in ${file}`,
      );
    });

  program
    .command("doctor")
    .description(
      "check this planning machine (Node, git, the platform, plat, skills, tracker doc, local rules, AGENTS.md, gates) and store the result for the control tower",
    )
    .option("--project <id>", "project to store the report on", toInt)
    .action(async (options: { project?: number }) => {
      const cwd = io.cwd ?? process.cwd();
      const client = api();
      const report = await collectDoctorReport({
        cwd,
        home: io.env.HOME,
        readFile: io.readFile,
        loadVersion: async () => {
          const { data } = await client.GET("/version");
          return data ?? undefined;
        },
        loadProject: async (id) => {
          const { data } = await client.GET("/projects/{projectId}", {
            params: { path: { projectId: id } },
          });
          if (!data) throw new Error("no such project");
          return data;
        },
        projectId: options.project,
      });
      let stored = {
        machine: report.machine,
        checkedAt: report.checkedAt,
        items: report.items,
        projectId: report.projectId,
      };
      if (report.projectId !== undefined) {
        const { data, response, error } = await client.PUT(
          "/projects/{projectId}/doctor-report",
          {
            params: { path: { projectId: report.projectId } },
            body: { machine: report.machine, items: report.items },
          },
        );
        if (data) {
          stored = { ...data, projectId: report.projectId };
        } else {
          io.stderr(
            `warning: could not store the report: ${failureFrom(response, error).message}\n`,
          );
        }
      }
      print(stored, formatDoctorText(stored));
    });

  program
    .command("update")
    .description(
      "replace this plat with the platform's, and install the afk-setup and planning skills again where they are (in this repo, or yours)",
    )
    .action(async () => {
      const base = apiUrl();
      const lines: string[] = [];

      // plat: the platform's copy, written next to this one and moved over it.
      if (!self) {
        lines.push(
          "plat: runs from a checkout of the platform, so it is as new as that checkout (git pull there)",
        );
      } else {
        const replaced = await replacePlat(self, base).catch((error) => {
          throw new Failure((error as Error).message);
        });
        if (!replaced) {
          lines.push(`plat: up to date (${PLATFORM_VERSION})`);
        } else {
          const version = await platformVersionAt(base);
          lines.push(
            `plat: replaced with the platform's${version ? ` (${version})` : ""}`,
          );
        }
      }

      // The skills: installed again at the platform's commit, at the levels afk-setup is at.
      const top = spawnSync("git", ["rev-parse", "--show-toplevel"], {
        cwd: io.cwd ?? process.cwd(),
        encoding: "utf8",
      });
      const platform = await createApiClient(base, undefined, cliHeaders(plat))
        .GET("/version")
        .then((r) => r.data)
        .catch(() => undefined);
      try {
        lines.push(
          ...updateSkills({
            home: io.env.HOME ?? homedir(),
            repo: top.status === 0 ? top.stdout.trim() : undefined,
            commit: platform?.platformCommit ?? null,
            run: io.run ?? runCommand,
          }),
        );
      } catch (error) {
        throw new Failure(`${lines.join("\n")}\n${(error as Error).message}`);
      }
      print({ lines }, lines.join("\n"));
    });

  program
    .command("sync")
    .description(
      "bring this planning machine up to the platform's: plat itself, the planning skills and the planning files plat writes in this repo. plat does it by itself when the platform hands out a newer plat; the planning conventions say to run it before planning",
    )
    .action(async () => {
      const lines = await syncMachine(Boolean(updatedFrom));
      if (updatedFrom)
        lines.unshift(
          `plat: updated itself to the platform's (${updatedFrom} -> ${PLATFORM_VERSION})`,
        );
      print({ lines }, lines.join("\n"));
    });

  program
    .command("init")
    .description(
      "run in the planning repo: register its project and repos (this one and each --with) and write its tracker doc and agent docs, on this machine only unless the repo tracks them; asks first, never commits",
    )
    .option(
      "--with <path[=name]>",
      "another repo's local checkout, optionally with the name tickets use for it (repeatable)",
      collect,
      [],
    )
    .option(
      "--project <id>",
      "the project to add to (default: the one the tracker doc or this repo's address names, else a new one)",
      toInt,
    )
    .option(
      "--project-name <name>",
      "name of a new project (default: this repo's name)",
    )
    .option(
      "--contract-path <path>",
      "this repo's contract file, when it is new here (default: its only openapi file)",
    )
    .option("-y, --yes", "do not ask before registering")
    .option(
      "--dry-run",
      "only show the plan and what each repo lacks; register and write nothing",
    )
    .action(async (options) => {
      const client = api();
      await warnAboutVersion();
      const loadProject = async (projectId: number) => {
        const { data, response, error } = await client.GET(
          "/projects/{projectId}",
          { params: { path: { projectId } } },
        );
        return { data, response, error };
      };
      let plan: ReturnType<typeof planInit>;
      try {
        const cwd = io.cwd ?? process.cwd();
        const hosts = await client.GET("/hosts");
        if (!hosts.data) throw failureFrom(hosts.response, hosts.error);
        const known = hosts.data.hosts;
        const planning = withKnownHostKind(inspectCheckout(".", cwd), known);
        const others = (options.with as string[]).map((value) => {
          const { path, name } = parseWith(value);
          return {
            checkout: withKnownHostKind(inspectCheckout(path, cwd), known),
            name,
          };
        });
        const docPath = join(planning.dir, TRACKER_DOC_PATH);
        const before = existsSync(docPath)
          ? readFileSync(docPath, "utf8")
          : null;

        // The project: --project, else the one the tracker doc names, else the one this repo is registered in.
        let found: Awaited<ReturnType<typeof loadProject>>["data"];
        if (options.project !== undefined) {
          const loaded = await loadProject(options.project);
          if (!loaded.data) throw failureFrom(loaded.response, loaded.error);
          found = loaded.data;
        } else {
          const named = before ? trackerDocTarget(before) : null;
          if (named) found = (await loadProject(named.project)).data;
          if (!found) {
            const { data, response, error } = await client.GET("/projects", {
              params: { query: { repoUrl: planning.url } },
            });
            if (!data) throw failureFrom(response, error);
            if (data.projects.length > 1) {
              throw new Failure(
                `${planning.url} is in several projects (${data.projects.map((p) => `${p.id} ${p.name}`).join(", ")}); pick one with --project`,
              );
            }
            const only = data.projects[0];
            if (only) found = (await loadProject(only.id)).data;
          }
        }

        plan = planInit({
          project: found ?? {
            newName: options.projectName ?? planning.repoName,
          },
          planning,
          others,
          contractPath: options.contractPath,
        });
        // nothing is registered on a host the platform cannot work on, nor a project on two kinds of host
        const problems = codeHostProblems(plan, known);
        if (problems.length > 0) throw new Failure(problems.join("\n"));
        if (!json()) io.stdout(`${planText(plan)}\n`);

        const registering = hasRegistrations(plan);
        if (options.dryRun) {
          print(
            { dryRun: true, plan: planText(plan) },
            "dry run: nothing registered or written",
          );
          return;
        }
        // Every plat init asks the workers again whether the GitHub App can work on each registered repo.
        const accessLines = async (projectId: number, names: string[]) =>
          (await checkRepos(projectId, names)).map(({ name, access }) =>
            accessLine(name, access),
          );
        const agentDocs = planAgentDocs(planning.dir, afkHome(io.env));
        // what the repo does not track stays on this machine (ADR 0007)
        const trackerDocTracked = isTracked(planning.dir, TRACKER_DOC_PATH);
        const localPaths = [
          ...(trackerDocTracked ? [] : [TRACKER_DOC_PATH]),
          ...agentDocs.filter((d) => !d.tracked).map((d) => d.path),
        ];
        const agentDocsChange =
          agentDocs.some((d) => d.before !== d.after) ||
          missingExcludes(planning.dir, localPaths).length > 0;
        if (!registering && found && !agentDocsChange) {
          const doc = renderTrackerDoc(found, plan.repos[0]?.name as string);
          if (doc === before) {
            const access = await accessLines(
              found.id,
              plan.repos.map((r) => r.name),
            );
            print(
              {
                project: found.id,
                registered: [],
                trackerDoc: "unchanged",
                access,
              },
              [
                "nothing to register and the agent docs are up to date",
                ...access,
              ].join("\n"),
            );
            return;
          }
        }
        if (!options.yes) {
          if (!io.confirm) {
            throw new Failure(
              "plat init asks before it registers: run it in a terminal, or pass --yes",
            );
          }
          const question = registering
            ? "Register and write the agent docs?"
            : "Write the agent docs?";
          if (!(await io.confirm(question))) {
            print({ cancelled: true }, "nothing done");
            return;
          }
        }

        let projectId: number;
        if (plan.project.kind === "new") {
          const { data, response, error } = await client.POST("/projects", {
            body: {
              name: plan.project.name,
              protectedPaths: plan.project.protectedPaths,
            },
          });
          if (!data) throw failureFrom(response, error);
          projectId = data.id;
        } else {
          projectId = plan.project.id;
        }
        const registered: string[] = [];
        for (const repo of plan.repos) {
          if (repo.registered) continue;
          const added = await client.POST("/projects/{projectId}/repos", {
            params: { path: { projectId } },
            body: {
              url: repo.checkout.url,
              name: repo.name,
              defaultBranch: repo.checkout.defaultBranch,
              hostKind: repo.checkout.hostKind,
            },
          });
          if (!added.data) throw failureFrom(added.response, added.error);
          if (repo.contractPath) {
            const edited = await client.PATCH(
              "/projects/{projectId}/repos/{name}",
              {
                params: { path: { projectId, name: repo.name } },
                body: { contractPath: repo.contractPath },
              },
            );
            if (!edited.data) {
              throw failureFrom(edited.response, edited.error);
            }
          }
          registered.push(repo.name);
        }

        const after = await loadProject(projectId);
        if (!after.data) throw failureFrom(after.response, after.error);
        const {
          trackerDoc: state,
          docs: docStates,
          tracked: written,
        } = writePlanningFiles(
          planning.dir,
          afkHome(io.env),
          after.data,
          plan.repos[0]?.name as string,
        );
        const lines = [
          `project ${projectId} ${after.data.name}${plan.project.kind === "new" ? " (new)" : ""}`,
          ...(registered.length > 0
            ? [`registered: ${registered.join(", ")}`]
            : []),
          `tracker doc ${TRACKER_DOC_PATH}: ${state}`,
          ...Object.entries(docStates).map(([path, s]) => `${path}: ${s}`),
          ...(localPaths.length === 0
            ? []
            : [
                `on this machine only (in .git/info/exclude, never committed): ${localPaths.join(", ")}`,
              ]),
          ...(written.length === 0
            ? []
            : [
                `next, in ${planning.dir}: git add ${written.join(" ")} && git commit -m "Set the repo up for the AFK platform" && git push`,
              ]),
        ];
        const access = await accessLines(
          projectId,
          plan.repos.map((r) => r.name),
        );
        print(
          {
            project: projectId,
            registered,
            trackerDoc: state,
            agentDocs: docStates,
            access,
          },
          [...lines, ...access].join("\n"),
        );
      } catch (e) {
        if (e instanceof InitError) throw new Failure(e.message);
        throw e;
      }
    });

  program
    .command("tracker-doc")
    .description(
      "print the planning repo's docs/agents/issue-tracker.md (redirect it to the file; nothing is written)",
    )
    .requiredOption("--project <id>", "project id", toInt)
    .requiredOption("--repo <name>", "the planning repo's name on the platform")
    .action(async (options) => {
      const { data, response, error } = await api().GET(
        "/projects/{projectId}",
        { params: { path: { projectId: options.project } } },
      );
      if (!data) throw failureFrom(response, error);
      let doc: string;
      try {
        doc = renderTrackerDoc(data, options.repo);
      } catch (e) {
        throw new Failure(e instanceof Error ? e.message : String(e));
      }
      // The document itself, even with --json: it is meant to be redirected into a file.
      io.stdout(doc);
    });

  program
    .command("bug")
    .description(
      "create a bug draft from a report and locate the original spec",
    )
    .requiredOption("--project <id>", "project id", toInt)
    .requiredOption("--file <path>", "the report (stack, error, what you saw)")
    .option("--title <title>", "default: the first line of the report")
    .option("--slug <slug>", "default: derived from the title")
    .action(async (options) => {
      const body = await io.readFile(options.file);
      if (body.trim().length === 0) {
        throw new Failure("the report file is empty");
      }
      const target = await io
        .readFile(TRACKER_DOC_PATH)
        .then(trackerDocTarget)
        .catch(() => null);
      const planningRepo =
        target && target.project === options.project ? target.repo : undefined;
      const { data, response, error } = await api().POST("/bugs", {
        body: {
          projectId: options.project,
          body,
          ...(options.title ? { title: options.title } : {}),
          ...(options.slug ? { slug: options.slug } : {}),
          ...(planningRepo ? { planningRepo } : {}),
        },
      });
      if (!data) throw failureFrom(response, error);
      print(data, data.displayId);
      await warnAboutPlanningMachine(options.project);
    });

  const spec = program.command("spec").description("specs");
  spec
    .command("create")
    .description("create a spec; prints its S-<n> id")
    .requiredOption("--project <id>", "project id", toInt)
    .requiredOption("--type <type>", "feature | bug | improvement")
    .requiredOption("--title <title>")
    .option("--slug <slug>", "default: derived from the title")
    .option("--file <path>", "markdown body")
    .option("--source <spec>", "original spec (S-n) this bug points at")
    .action(async (options) => {
      const slug = options.slug ?? slugify(options.title);
      const body = options.file
        ? normalizeSpecBody(await io.readFile(options.file))
        : undefined;
      // Run in the planning repo, its tracker doc names it: the spec's planning docs live there (ADR 0005).
      const target = await io
        .readFile(TRACKER_DOC_PATH)
        .then(trackerDocTarget)
        .catch(() => null);
      const planningRepo =
        target && target.project === options.project ? target.repo : undefined;
      const sourceSpecId = options.source
        ? specIdOf(options.source)
        : undefined;
      const { data, response, error } = await api().POST("/specs", {
        body: {
          projectId: options.project,
          type: options.type,
          slug,
          title: options.title,
          body,
          planningRepo,
          ...(sourceSpecId !== undefined ? { sourceSpecId } : {}),
        },
      });
      if (!data) throw failureFrom(response, error);
      for (const warning of body === undefined
        ? []
        : specTemplateWarnings(body))
        io.stderr(`warning: ${warning}\n`);
      print(data, data.displayId);
      await warnAboutPlanningMachine(options.project);
    });

  spec
    .command("confirm <spec>")
    .description(
      "confirm the split: the spec runs. Run in the spec's planning repo, it also sends the planning docs (GLOSSARY.md, docs/adr, AGENTS.md, and a multi-context repo's GLOSSARY-MAP.md with each context's GLOSSARY.md and docs/adr) as they are, committed or not, for the platform to commit before any ticket starts",
    )
    .action(async (id: string) => {
      const specId = specIdOf(id);
      const view = await api().GET("/specs/{id}", {
        params: { path: { id: specId } },
      });
      if (!view.data) throw failureFrom(view.response, view.error);
      const planningRepo = view.data.spec.planning.repo;
      let docs: ReturnType<typeof readPlanningDocs> = { status: "elsewhere" };
      if (planningRepo !== null) {
        const project = await api().GET("/projects/{projectId}", {
          params: { path: { projectId: view.data.spec.projectId } },
        });
        if (project.data) {
          docs = readPlanningDocs(
            io.cwd ?? process.cwd(),
            project.data.repos,
            planningRepo,
          );
        }
      }
      if (docs.status === "other-repo") {
        throw new Failure(
          `${id}'s planning docs are in ${planningRepo}, not ${docs.repo}: run plat spec confirm in a checkout of ${planningRepo}`,
        );
      }
      if (docs.status === "ok")
        refuseUnresolved(docs, `plat spec confirm ${id}`);
      if (
        docs.status === "ok" &&
        Buffer.byteLength(docs.patch) > MAX_PLANNING_PATCH_BYTES
      ) {
        throw new Failure(
          `the planning docs patch (${docs.files.length} files) is over ${MAX_PLANNING_PATCH_BYTES} bytes; only the glossaries, ADRs and AGENTS.md belong in it`,
        );
      }
      // Stray checkout: no docs sent, even when import was clean (no page-confirm precheck).
      if (docs.status === "elsewhere" && docs.checkout) {
        io.stderr(
          `yellow: ${docs.checkout} is not a repo of this project, so no planning docs were sent; if it should be, set it up with the afk-setup skill\n`,
        );
      }
      for (const check of view.data.spec.prechecks) {
        if (check.code === "page-confirm-without-planning-docs") {
          if (docs.status === "ok") continue;
          if (docs.status === "elsewhere" && docs.checkout) continue;
        }
        io.stderr(`yellow: ${check.message}\n`);
      }
      // A repo without its gate on the default branch would fail every ticket it has: say so before anything starts.
      // Only when plat waits for the workers' answers (AFK_ACCESS_WAIT_SECONDS above 0), and only on a definite one.
      const ticketRepos = [
        ...new Map(view.data.tickets.map((t) => [t.repo, t.repoUrl])),
      ];
      if (accessWaitSeconds() > 0 && ticketRepos.length > 0) {
        const checked = await checkRepos(
          view.data.spec.projectId,
          ticketRepos.map(([name]) => name),
        );
        const problems = unreadyRepos(
          checked.map(({ name, access }) => ({
            name,
            url: ticketRepos.find(([repo]) => repo === name)?.[1] ?? "",
            access,
          })),
        );
        if (problems.length > 0) throw new Failure(problems.join("\n"));
      }
      const { data, response, error } = await api().POST(
        "/specs/{specId}/confirm",
        {
          params: { path: { specId } },
          ...(docs.status === "ok"
            ? { body: { planningPatch: docs.patch } }
            : {}),
        },
      );
      if (!data) throw failureFrom(response, error);
      const branch = data.integrationBranches[0]?.branch ?? "";
      const lines = [
        `${id} is ${data.state}`,
        ...(docs.status === "ok" && docs.files.length > 0
          ? [
              `  planning docs ${docs.files.join(", ")} go to the platform, which commits them onto ${branch} in ${planningRepo} before any ticket starts; they reach ${planningRepo}'s default branch with that pull request`,
              ...putAside(
                formatDisplayId("spec", specId),
                docs,
                planningRepo ?? "",
              ),
            ]
          : []),
        ...(data.planningState
          ? [
              `  planning commit: ${data.planningState} (no ticket starts before it is made)`,
            ]
          : []),
        ...data.integrationBranches.map(
          (b) => `  repo ${b.repoId}: ${b.branch}`,
        ),
        ...data.enqueued.map((t) => `  queued ${t.displayId}`),
      ];
      print(data, lines.join("\n"));
    });

  // An integration ticket's environment repos need their compose files; the spec can add them, or they are on the
  // default branch already. Only when plat waits for the workers' answers (AFK_ACCESS_WAIT_SECONDS above 0).
  const integrationLines = async (
    specId: number,
    files: { name: string; text: string }[],
  ): Promise<string[]> => {
    if (accessWaitSeconds() <= 0) return [];
    try {
      const view = await api().GET("/specs/{id}", {
        params: { path: { id: specId } },
      });
      if (!view.data) return [];
      const tickets = view.data.tickets;
      const repos = [
        ...new Set(
          tickets
            .filter((t) => t.type === "integration")
            .flatMap((t) => t.environment),
        ),
      ];
      if (repos.length === 0) return [];
      const checked = await checkRepos(view.data.spec.projectId, repos);
      return integrationWarnings(
        tickets,
        files,
        new Map(checked.map(({ name, access }) => [name, access])),
      ).map((w) => `warning: ${w}`);
    } catch {
      // A check that cannot run is not worth failing an import that worked.
      return [];
    }
  };

  // Filenames only: the page confirm precheck names what it would drop. Import still never uploads the bodies.
  const planningDocsAtImportOf = async (specId: number) => {
    try {
      const view = await api().GET("/specs/{id}", {
        params: { path: { id: specId } },
      });
      if (!view.data?.spec.planning.repo) {
        return { status: "unknown" as const };
      }
      const planningRepo = view.data.spec.planning.repo;
      const project = await api().GET("/projects/{projectId}", {
        params: { path: { projectId: view.data.spec.projectId } },
      });
      if (!project.data) return { status: "unknown" as const };
      const docs = readPlanningDocs(
        io.cwd ?? process.cwd(),
        project.data.repos,
        planningRepo,
      );
      if (docs.status !== "ok") return { status: "unknown" as const };
      return docs.files.length === 0
        ? { status: "clean" as const }
        : { status: "changed" as const, files: docs.files };
    } catch {
      return { status: "unknown" as const };
    }
  };

  program
    .command("tickets")
    .description("tickets")
    .command("import <spec> <directory>")
    .description(
      "import a directory of ticket files (one .md per ticket: a front matter, then the to-tickets issue template) into a spec, or nothing at all",
    )
    .option(
      "--append",
      "add the directory's tickets to a confirmed spec (planned, running or paused); they take effect at once. Their blocked_by and contract may name existing tickets as T-<n>, and blocks: [T-<n>] makes a new ticket block an existing one",
    )
    .action(async (spec: string, directory: string, options) => {
      const specId = specIdOf(spec);
      let files: { name: string; text: string }[];
      try {
        files = (await io.readDirectory(directory)).sort((a, b) =>
          a.name.localeCompare(b.name, undefined, { numeric: true }),
        );
      } catch (error) {
        throw new Failure(
          /\.ya?ml$/i.test(directory)
            ? `${directory}: tickets.yaml is no longer accepted; import a directory with one markdown file per ticket`
            : `cannot read the directory ${directory}: ${(error as Error).message}`,
        );
      }
      const planningDocsAtImport = await planningDocsAtImportOf(specId);
      const { data, response, error } = await api().POST(
        "/specs/{specId}/tickets/import",
        {
          params: {
            path: { specId },
            query: options.append ? { append: "true" } : {},
          },
          body: { files, planningDocsAtImport },
        },
      );
      if (!data) throw failureFrom(response, error);
      const lines = [
        `${options.append ? "appended" : "imported"} ${data.tickets.length} tickets ${options.append ? "to" : "into"} ${spec}`,
        ...data.tickets.map((t) => `  ${t.displayId}  ${t.key}`),
        ...data.warnings.map((w) => `warning: ${w.message}`),
        ...(await integrationLines(specId, files)),
      ];
      print(data, lines.join("\n"));
      await warnAboutPlanningMachine();
    });

  spec
    .command("show <spec>")
    .description(
      "a spec with its tickets, blocked briefs, dependency edges and import warnings",
    )
    .action(async (id: string) => {
      const { data, response, error } = await api().GET("/specs/{id}", {
        params: { path: { id: specIdOf(id) } },
      });
      if (!data) throw failureFrom(response, error);
      print(data, specText(data));
    });

  // Once the platform has the planning docs, the copies not committed here go to the spec's folder outside the
  // checkout, so that pulling the spec's pull request later finds nothing in the way. The lines that say so.
  // Nothing is kept when every planning doc is committed here: there is nothing to take out.
  const putAside = (
    spec: string,
    docs: Extract<PlanningDocs, { status: "ok" }>,
    repo: string,
  ): string[] => {
    if (uncommittedPlanningDocs(docs.dir, docs.paths).length === 0) return [];
    let kept: string;
    try {
      kept = saveBackup(afkHome(io.env), spec, {
        apiUrl: apiUrl(),
        repo,
        files: docs.files,
        patch: docs.patch,
      });
    } catch (error) {
      return [
        `  your copies here stay where they are: they could not be kept outside the checkout (${(error as Error).message})`,
      ];
    }
    const taken = putPlanningDocsAside(docs.dir, docs.paths);
    return [
      `  taken out of this checkout (back to HEAD): ${taken.join(", ")}; kept in ${kept}`,
    ];
  };

  // Planning docs still being merged, or with conflict markers in them, are not sent.
  const refuseUnresolved = (
    docs: Extract<PlanningDocs, { status: "ok" }>,
    rerun: string,
  ) => {
    const unresolved = unresolvedPlanningDocs(docs.dir, docs.paths);
    if (unresolved.length > 0)
      throw new Failure(
        `resolve the conflicts in ${unresolved.join(", ")} first, then run ${rerun} again`,
      );
  };

  // Planning docs that did not apply to the planning repo's default branch (ADR 0005).
  spec
    .command("retry-planning <spec>")
    .description(
      "in the spec's planning repo, with its default branch merged into your branch: the first run puts the planning docs confirm took back into the checkout, merged three ways (conflicts marked in the files); once they are resolved, the next run sends them again and makes the planning commit again",
    )
    .action(async (id: string) => {
      const specId = specIdOf(id);
      const view = await api().GET("/specs/{id}", {
        params: { path: { id: specId } },
      });
      if (!view.data) throw failureFrom(view.response, view.error);
      const planningRepo = view.data.spec.planning.repo;
      if (view.data.spec.planning.state !== "blocked" || planningRepo === null)
        throw new Failure(`${id}'s planning docs are not blocked`);
      const project = await api().GET("/projects/{projectId}", {
        params: { path: { projectId: view.data.spec.projectId } },
      });
      if (!project.data) throw failureFrom(project.response, project.error);
      const docs = readPlanningDocs(
        io.cwd ?? process.cwd(),
        project.data.repos,
        planningRepo,
      );
      if (docs.status !== "ok") {
        throw new Failure(
          `run plat spec retry-planning in a checkout of ${planningRepo}, where ${id}'s planning docs are`,
        );
      }
      const home = afkHome(io.env);
      const spec = formatDisplayId("spec", specId);
      const local = uncommittedPlanningDocs(docs.dir, docs.paths);
      const backup = readBackup(home, spec);
      if (local.length === 0 && backup) {
        const back = putPlanningDocsBack(docs.dir, backup.patch, docs.paths);
        if (!back.ok)
          throw new Failure(
            `could not put ${id}'s planning docs back from ${specPlanningDir(home, spec)}: ${back.error}`,
          );
      }
      // the docs put back are all in HEAD already: they are sent as they are
      if (
        local.length === 0 &&
        backup &&
        uncommittedPlanningDocs(docs.dir, docs.paths).length > 0
      ) {
        const conflicts = unresolvedPlanningDocs(docs.dir, docs.paths);
        print(
          { putBack: backup.files, conflicts },
          [
            `${id}: planning docs ${backup.files.join(", ")} put back in this checkout`,
            ...(conflicts.length > 0
              ? [`  resolve the conflicts marked in ${conflicts.join(", ")}`]
              : []),
            `  then run plat spec retry-planning ${id} again to send them`,
          ].join("\n"),
        );
        return;
      }
      refuseUnresolved(docs, `plat spec retry-planning ${id}`);
      const { data, response, error } = await api().POST(
        "/specs/{specId}/planning/retry",
        {
          params: { path: { specId } },
          body: { planningPatch: docs.patch },
        },
      );
      if (!data) throw failureFrom(response, error);
      print(
        data,
        [
          `${id}: planning docs ${docs.files.join(", ") || "(none)"} sent again; the planning commit is queued`,
          ...(docs.files.length > 0 ? putAside(spec, docs, planningRepo) : []),
        ].join("\n"),
      );
    });

  spec
    .command("retry-locate <spec>")
    .description("run locate again on a bug draft that could not be located")
    .action(async (id: string) => {
      const { data, response, error } = await api().POST(
        "/specs/{specId}/locate/retry",
        { params: { path: { specId: specIdOf(id) } } },
      );
      if (!data) throw failureFrom(response, error);
      print(data, `${id}: locate queued again`);
    });

  spec
    .command("waive-planning <spec>")
    .description(
      "give up the planning docs that did not apply: the planning commit is the default branch's head, the tickets start, and the acceptance pack says the docs were left out",
    )
    .action(async (id: string) => {
      const specId = specIdOf(id);
      const { data, response, error } = await api().POST(
        "/specs/{specId}/planning/waive",
        { params: { path: { specId } } },
      );
      if (!data) throw failureFrom(response, error);
      dropBackup(afkHome(io.env), formatDisplayId("spec", specId));
      print(
        data,
        `${id}: planning docs given up; the planning commit is queued as the default branch's head`,
      );
    });

  spec
    .command("retry-final <spec>")
    .description("run the blocked step of a spec's overall review again")
    .option(
      "--note <text>",
      "Retry note for the next Run only; not a ticket edit",
    )
    .action(async (id: string, options) => {
      const { data, response, error } = await api().POST(
        "/specs/{id}/final/retry",
        {
          params: { path: { id: specIdOf(id) } },
          body: options.note === undefined ? {} : { note: options.note },
        },
      );
      if (!data) throw failureFrom(response, error);
      print(data, `${id}: running again: ${data.retried.join(", ")}`);
    });

  spec
    .command("approve-recheck <spec>")
    .description(
      "accept the Recheck of a wrap-up or update-branch blocked by recheck-failed",
    )
    .action(async (id: string) => {
      const { data, response, error } = await api().POST(
        "/specs/{id}/approve-recheck",
        { params: { path: { id: specIdOf(id) } } },
      );
      if (!data) throw failureFrom(response, error);
      print(data, `${id}: approved ${data.sha}; wrap-up or update goes on`);
    });

  spec
    .command("approve-removed-tests <spec>")
    .description(
      "accept the missing test names of a wrap-up or update-branch blocked by tests-removed",
    )
    .action(async (id: string) => {
      const { data, response, error } = await api().POST(
        "/specs/{id}/approve-removed-tests",
        { params: { path: { id: specIdOf(id) } } },
      );
      if (!data) throw failureFrom(response, error);
      const names = data.approved
        .map((n) => (n.classname ? `${n.classname} ${n.name}` : n.name))
        .join(", ");
      print(data, `${id}: approved ${names}`);
    });

  spec
    .command("waive-final <spec>")
    .description(
      "open a spec's pull requests although the e2e before them failed (the acceptance pack says so)",
    )
    .action(async (id: string) => {
      const { data, response, error } = await api().POST(
        "/specs/{id}/final/waive",
        { params: { path: { id: specIdOf(id) } } },
      );
      if (!data) throw failureFrom(response, error);
      print(data, `${id}: the pull requests are being opened`);
    });

  spec
    .command("cleanup <spec>")
    .description(
      "close the open pull requests and delete the branches of a cancelled or merged spec again (after plat blocked said the clean-up did not finish)",
    )
    .action(async (id: string) => {
      const { data, response, error } = await api().POST(
        "/specs/{id}/cleanup",
        { params: { path: { id: specIdOf(id) } } },
      );
      if (!data) throw failureFrom(response, error);
      print(data, `${id}: clean-up queued`);
    });

  spec
    .command("retry <spec>")
    .alias("resume")
    .description(
      "let a paused spec go on, adding agent time when the budget ran out",
    )
    .option(
      "--extra-hours <n>",
      "agent hours to add to the spec's budget (default 1)",
      toInt,
    )
    .action(async (id: string, options) => {
      const { data, response, error } = await api().POST("/specs/{id}/resume", {
        params: { path: { id: specIdOf(id) } },
        body: { extraSeconds: (options.extraHours ?? 1) * 3600 },
      });
      if (!data) throw failureFrom(response, error);
      print(data, `${id} is ${data.state}`);
    });

  spec
    .command("allow <spec>")
    .description("let a paused spec go on without extra agent time")
    .action(async (id: string) => {
      const { data, response, error } = await api().POST("/specs/{id}/allow", {
        params: { path: { id: specIdOf(id) } },
      });
      if (!data) throw failureFrom(response, error);
      print(data, `${id} is ${data.state}`);
    });

  spec
    .command("cancel <spec>")
    .description(
      "give up a spec: its unfinished tickets are cancelled and its jobs stopped (merged work stays); a worker that has the code host then closes its open pull requests and deletes its spec/* and agent/* branches. A spec with a merged pull request cannot be cancelled",
    )
    .action(async (id: string) => {
      const { data, response, error } = await api().POST("/specs/{id}/cancel", {
        params: { path: { id: specIdOf(id) } },
      });
      if (!data) throw failureFrom(response, error);
      print(
        data,
        [
          `${id} is ${data.state}${data.cancelled.length ? `; cancelled ${data.cancelled.join(", ")}` : ""}`,
          "a worker that has the code host will close its open pull requests and delete its spec/* and agent/* branches",
          ...data.pullRequests.map((p) => `  ${p.repo} #${p.number}  ${p.url}`),
        ].join("\n"),
      );
    });

  const ticketCommands = program.command("ticket").description("tickets");
  ticketCommands
    .command("view <ticket>")
    .description(
      "a ticket with its body, runs, findings and, when blocked, its brief",
    )
    .option(
      "--version <n>",
      "show the content the ticket had at that version",
      toInt,
    )
    .option(
      "--md",
      "print the ticket file an agent reads (the same text plat ticket edit --file takes)",
    )
    .action(async (id: string, options) => {
      const { data, response, error } = await api().GET("/tickets/{id}", {
        params: {
          path: { id: ticketIdOf(id) },
          query:
            options.version === undefined ? {} : { version: options.version },
        },
      });
      if (!data) throw failureFrom(response, error);
      if (options.md) io.stdout(data.ticket.file);
      else print(data, ticketText(data));
    });
  ticketCommands
    .command("edit <ticket>")
    .description(
      "change a pending, blocked or taken-over ticket from a ticket file (what plat ticket view --md prints): its title, body, modules and approved protected paths; the acceptance criteria are read from the body. The content version goes up by one if anything changed",
    )
    .requiredOption("--file <file>", "the ticket file")
    .action(async (id: string, options) => {
      let file: string;
      try {
        file = await io.readFile(options.file);
      } catch (error) {
        throw new Failure(
          `cannot read ${options.file}: ${(error as Error).message}`,
        );
      }
      const { data, response, error } = await api().POST("/tickets/{id}/edit", {
        params: { path: { id: ticketIdOf(id) } },
        body: { file },
      });
      if (!data) throw failureFrom(response, error);
      print(
        data,
        data.changed
          ? `${id} is now at version ${data.contentVersion}`
          : `${id} is unchanged (version ${data.contentVersion})`,
      );
    });
  ticketCommands
    .command("retry <ticket>")
    .description("try a blocked ticket again")
    .requiredOption(
      "--mode <mode>",
      "continue (keep the branch; without --note it goes on from the gate when the agent had finished the branch) or restart (start from the integration branch)",
    )
    .option(
      "--note <text>",
      "Retry note for the next Run only; not a ticket edit",
    )
    .action(async (id: string, options) => {
      if (options.mode !== "continue" && options.mode !== "restart") {
        throw new Failure("--mode must be continue or restart");
      }
      const { data, response, error } = await api().POST(
        "/tickets/{id}/retry",
        {
          params: { path: { id: ticketIdOf(id) } },
          body: {
            mode: options.mode,
            ...(options.note === undefined ? {} : { note: options.note }),
          },
        },
      );
      if (!data) throw failureFrom(response, error);
      print(data, `${id} is ${data.state}`);
    });
  ticketCommands
    .command("takeover <ticket>")
    .description(
      "stop the ticket's jobs and hold it so a person can push the ticket branch; the scheduler leaves it alone until plat ticket handback",
    )
    .action(async (id: string) => {
      const { data, response, error } = await api().POST(
        "/tickets/{id}/takeover",
        { params: { path: { id: ticketIdOf(id) } } },
      );
      if (!data) throw failureFrom(response, error);
      print(data, `${id} is ${data.state}`);
    });
  ticketCommands
    .command("handback <ticket>")
    .description(
      "give a taken-over ticket back: the platform takes the remote tip and goes on from the gate (or implement / e2e), without rewriting the person's commits",
    )
    .action(async (id: string) => {
      const { data, response, error } = await api().POST(
        "/tickets/{id}/handback",
        { params: { path: { id: ticketIdOf(id) } } },
      );
      if (!data) throw failureFrom(response, error);
      print(data, `${id} is ${data.state}`);
    });
  ticketCommands
    .command("approve-protected <ticket>")
    .description(
      "accept the protected path changes of a ticket blocked by protected-path-changed",
    )
    .action(async (id: string) => {
      const { data, response, error } = await api().POST(
        "/tickets/{id}/approve-protected",
        {
          params: { path: { id: ticketIdOf(id) } },
        },
      );
      if (!data) throw failureFrom(response, error);
      print(
        data,
        `approved: ${data.approved.join(", ")}; ${id} goes on from the gate`,
      );
    });
  ticketCommands
    .command("approve-recheck <ticket>")
    .description("accept the Recheck of a ticket blocked by recheck-failed")
    .action(async (id: string) => {
      const { data, response, error } = await api().POST(
        "/tickets/{id}/approve-recheck",
        {
          params: { path: { id: ticketIdOf(id) } },
        },
      );
      if (!data) throw failureFrom(response, error);
      print(data, `approved ${data.sha}; ${id} goes on from the merge`);
    });
  ticketCommands
    .command("approve-removed-tests <ticket>")
    .description(
      "accept the missing test names of a ticket blocked by tests-removed",
    )
    .action(async (id: string) => {
      const { data, response, error } = await api().POST(
        "/tickets/{id}/approve-removed-tests",
        {
          params: { path: { id: ticketIdOf(id) } },
        },
      );
      if (!data) throw failureFrom(response, error);
      const names = data.approved
        .map((n) => (n.classname ? `${n.classname} ${n.name}` : n.name))
        .join(", ");
      print(data, `approved: ${names}; ${id} goes on from the gate`);
    });
  ticketCommands
    .command("allow-path <ticket> <paths...>")
    .description(
      "approve protected paths for a blocked ticket's next run (then: ticket retry)",
    )
    .action(async (id: string, paths: string[]) => {
      const { data, response, error } = await api().POST(
        "/tickets/{id}/allow-paths",
        { params: { path: { id: ticketIdOf(id) } }, body: { paths } },
      );
      if (!data) throw failureFrom(response, error);
      print(
        data,
        `approved for ${id}: ${data.allowed.join(", ")}; retry it with: plat ticket retry ${id} --mode continue|restart`,
      );
    });
  ticketCommands
    .command("cancel <ticket>")
    .description(
      "cancel a pending, blocked or taken-over ticket; the tickets behind it go to blocked unless --cascade",
    )
    .option("--cascade", "cancel everything downstream too")
    .action(async (id: string, options) => {
      const { data, response, error } = await api().POST(
        "/tickets/{id}/cancel",
        {
          params: { path: { id: ticketIdOf(id) } },
          body: { cascade: Boolean(options.cascade) },
        },
      );
      if (!data) throw failureFrom(response, error);
      const lines = [
        `cancelled: ${data.cancelled.join(", ")}`,
        ...(data.blocked.length
          ? [`blocked (upstream-cancelled): ${data.blocked.join(", ")}`]
          : []),
        ...(data.skipped.length
          ? [`left alone, already under way: ${data.skipped.join(", ")}`]
          : []),
      ];
      print(data, lines.join("\n"));
    });

  program
    .command("blocked")
    .description(
      "everything waiting for you: blocked tickets with their briefs, and paused specs",
    )
    .action(async () => {
      const { data, response, error } = await api().GET("/blocked");
      if (!data) throw failureFrom(response, error);
      print(data, blockedText(data));
    });

  program
    .command("context")
    .description(
      "pointers from blamed files in this checkout back to specs, tickets, pull requests and planning docs",
    )
    .requiredOption("--files <paths...>", "files to blame in this checkout")
    .option(
      "--repo <name>",
      "platform repo name when this checkout's origin does not match a registered repo",
    )
    .action(async (options: { files: string[]; repo?: string }) => {
      const cwd = io.cwd ?? process.cwd();
      const checkout = inspectContextCheckout(cwd, options.files);
      if ("error" in checkout) throw new Failure(checkout.error);
      let originMatches = false;
      if (checkout.origin) {
        const listed = await api().GET("/projects", {
          params: { query: { repoUrl: checkout.origin } },
        });
        if (!listed.data) throw failureFrom(listed.response, listed.error);
        originMatches = listed.data.projects.length > 0;
      }
      if (!originMatches && options.repo === undefined) {
        throw new Failure(
          checkout.origin
            ? "this checkout's origin does not match a registered repo; pass --repo <name>"
            : "this checkout has no origin remote; pass --repo <name>",
        );
      }
      const { data, response, error } = await api().POST("/context", {
        body: {
          ...(options.repo !== undefined ? { repo: options.repo } : {}),
          ...(originMatches && checkout.origin
            ? { repoUrl: checkout.origin }
            : {}),
          files: checkout.files,
        },
      });
      if (!data) throw failureFrom(response, error);
      print(data, contextText(data));
    });

  program
    .command("agents")
    .description("agent jobs, paused while the model provider refuses work")
    .command("resume")
    .description(
      "hand out agent jobs again, once the provider's usage or key is back",
    )
    .action(async () => {
      const { data, response, error } = await api().POST("/agents/resume");
      if (!data) throw failureFrom(response, error);
      print(
        data,
        data.resumed
          ? "agent jobs are handed out again"
          : "agent jobs were not paused",
      );
    });

  const feishuCommands = program
    .command("feishu")
    .description("Feishu notifications");
  feishuCommands
    .command("test")
    .description(
      "send a test card to the project's Feishu group, or the platform default group",
    )
    .requiredOption("--project <id>", "project id", toInt)
    .action(async (options: { project: number }) => {
      const { data, response, error } = await api().POST(
        "/projects/{projectId}/feishu-test",
        { params: { path: { projectId: options.project } } },
      );
      if (!data) throw failureFrom(response, error);
      print(data, `sent a test card to ${data.chatId}`);
    });

  program
    .command("run")
    .description("runs")
    .command("logs <run>")
    .description("print the log of a run, e.g. R-5")
    .option(
      "--attempt <n>",
      "an earlier attempt of the job (default: the latest)",
      toInt,
    )
    .option("--from <offset>", "start at this byte offset", toOffset)
    .action(async (run: string, options) => {
      const parsed = parseDisplayId(run);
      if (parsed?.kind !== "run") {
        throw new Failure(`${run} is not a run id like R-5`);
      }
      let offset: number = options.from ?? 0;
      let attempt: number | undefined = options.attempt;
      let text = "";
      let last: { size: number; finished: boolean } | undefined;
      // Pages until the end of what has been written so far.
      for (;;) {
        const { data, response, error } = await api().GET("/runs/{id}/logs", {
          params: { path: { id: parsed.id }, query: { offset, attempt } },
        });
        if (!data) throw failureFrom(response, error);
        if (data.purgedAt) {
          if (json()) {
            print(
              {
                run,
                attempt: data.attempt,
                size: data.size,
                finished: data.finished,
                text: data.text,
                purgedAt: data.purgedAt,
              },
              "",
            );
          } else {
            io.stdout(`${purgedLogMessage(data.purgedAt)}\n`);
          }
          return;
        }
        attempt = data.attempt;
        text += data.text;
        last = data;
        if (data.nextOffset >= data.size || data.nextOffset === offset) break;
        offset = data.nextOffset;
      }
      if (json()) {
        print(
          { run, attempt, size: last.size, finished: last.finished, text },
          "",
        );
      } else {
        io.stdout(text);
      }
    });

  try {
    await program.parseAsync(argv, { from: "user" });
    return 0;
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode;
    if (error instanceof PlatOutdated) {
      // a plat run from a checkout, or one that just replaced itself, does not try again
      if (!self || updatedFrom) {
        report(
          new Failure(`${error.message}: run plat update`, {
            error: `${error.message}: run plat update`,
            code: PLAT_OUTDATED,
          }),
          json(),
          io,
        );
        return 1;
      }
      try {
        await replacePlat(self, apiUrl());
      } catch (failure) {
        report(
          new Failure(
            `${error.message}, and it could not replace itself: ${(failure as Error).message}`,
          ),
          json(),
          io,
        );
        return 1;
      }
      io.stderr(
        `plat: replaced itself with the platform's plat (was ${PLATFORM_VERSION}); running the command again\n`,
      );
      return (io.rerun ?? rerunPlat)(self, argv, {
        [UPDATED_FROM]: PLATFORM_VERSION,
      });
    }
    if (error instanceof Failure) {
      report(error, json(), io);
      return 1;
    }
    // Network down, bad URL: say so, with the underlying reason.
    const reason = (error as Error).cause ?? error;
    report(
      new Failure(`cannot reach the API: ${(reason as Error).message}`),
      json(),
      io,
    );
    return 1;
  }
}

function ticketIdOf(text: string): number {
  const parsed = parseDisplayId(text);
  if (parsed?.kind !== "ticket") {
    throw new Failure(`${text} is not a ticket id like T-123`);
  }
  return parsed.id;
}

const withoutTrailingSlash = (url: string) => url.replace(/\/+$/, "");

// Commands that do not replace plat first: they look at or set plat itself.
const NO_SELF_UPDATE = new Set(["update", "version", "connect", "help"]);

// The platform version answering at `address`, or undefined when nothing does.
const platformVersionAt = (address: string): Promise<string | undefined> =>
  createApiClient(address, undefined, cliHeaders())
    .GET("/version")
    .then((r) => r.data?.platformVersion)
    .catch(() => undefined);

function specIdOf(text: string): number {
  const parsed = parseDisplayId(text);
  if (parsed?.kind !== "spec") {
    throw new Failure(`${text} is not a spec id like S-12`);
  }
  return parsed.id;
}

// --stage-model name=model; empty model clears that key. Other names are refused here so plat
// does not wait for the API's 400.
function stageModelsFromPairs(
  pairs: string[] | undefined,
): StageModels | undefined {
  if (!pairs) return undefined;
  const models: StageModels = {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq <= 0) {
      throw new Failure(
        `--stage-model ${pair}: expected name=model (standards, update-branch or merge-fix)`,
      );
    }
    const name = pair.slice(0, eq);
    const model = pair.slice(eq + 1);
    if (!(STAGE_MODEL_KEYS as readonly string[]).includes(name)) {
      throw new Failure(
        `--stage-model ${pair}: name must be standards, update-branch or merge-fix`,
      );
    }
    models[name as (typeof STAGE_MODEL_KEYS)[number]] = model;
  }
  return models;
}

// --limit name=value, validated by the API against the known limit names.
function parseLimits(
  pairs: string[] | undefined,
): Record<string, number> | undefined {
  if (!pairs) return undefined;
  const limits: Record<string, number> = {};
  for (const pair of pairs) {
    const [name, value] = pair.split("=");
    if (!name || !/^[1-9][0-9]*$/.test(value ?? "")) {
      throw new Failure(`--limit ${pair}: expected name=positive integer`);
    }
    limits[name] = Number(value);
  }
  return limits;
}

function failureFrom(response: Response, body: unknown): Failure {
  const text = describe(body) ?? `HTTP ${response.status}`;
  return new Failure(text, body);
}

function describe(body: unknown): string | undefined {
  const { error, errors } = (body ?? {}) as {
    error?: unknown;
    errors?: unknown;
  };
  if (Array.isArray(errors)) return errors.map(String).join("\n");
  if (typeof error === "string") return error;
  // zod-openapi's own 400: { success: false, error: { issues: [...] } }
  const issues = (
    error as { issues?: { path?: unknown[]; message?: string }[] }
  )?.issues;
  if (Array.isArray(issues)) {
    return issues
      .map((i) => `${(i.path ?? []).join(".")}: ${i.message}`)
      .join("\n");
  }
  return undefined;
}

function report(problem: Failure, asJson: boolean, io: Io): void {
  if (asJson) io.stdout(`${JSON.stringify(problem.body)}\n`);
  else io.stderr(`error: ${problem.message}\n`);
}

function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) {
    throw new Failure("cannot derive a slug from the title; pass --slug");
  }
  return slug;
}

export { renderTrackerDoc } from "./tracker-doc.ts";
