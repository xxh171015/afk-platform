import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  type ApiClient,
  CLI_HEADERS,
  createApiClient,
  formatDisplayId,
  HOST_HEADER,
  HOST_KINDS,
  MAX_PLANNING_PATCH_BYTES,
  parseDisplayId,
  SETUP_BRANCH,
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
import { blockedText, specText, ticketText } from "./format.ts";
import { excludeLocally, isTracked, missingExcludes } from "./git-exclude.ts";
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
import { rememberApiUrl, rememberedApiUrl } from "./plat-config.ts";
import { type RunCommand, runCommand, updateSkills } from "./skills-install.ts";
import { renderTrackerDoc, trackerDocTarget } from "./tracker-doc.ts";

// `plat`: the developer's and the planning agent's way into the platform API (docs/specs/m1-platform.md「plat CLI」).
// Output is for people by default and a single JSON document with --json (for skills and scripts).

// Every call says it is plat, and from which machine: the API records a person's actions with both.
const cliHeaders = () => ({ ...CLI_HEADERS, [HOST_HEADER]: hostname() });

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
  // The file plat runs from, which `plat update` replaces; process.argv[1] when omitted, "" for none.
  platPath?: string;
}

// How long plat init waits for a worker to say whether the GitHub App can work on the repos.
const ACCESS_WAIT_SECONDS = 20;

function accessLine(
  name: string,
  access:
    | {
        state: string;
        missing?: string[];
        fixUrl?: string;
        message?: string;
      }
    | undefined,
): string {
  const whoever = "(whoever runs the platform)";
  switch (access?.state) {
    case "ok":
      return `${name}: the GitHub App can work here`;
    case "not-installed":
      return `${name}: the GitHub App is not installed on this repo; install it ${whoever}: ${access.fixUrl ?? ""}`.trimEnd();
    case "missing-permissions":
      return `${name}: the GitHub App lacks ${(access.missing ?? []).join(", ")}; grant it ${whoever}: ${access.fixUrl ?? ""}`.trimEnd();
    case "error":
      return `${name}: the GitHub App could not be checked: ${access.message ?? "unknown error"}`;
    case "pending":
      return `${name}: the GitHub App is not checked yet (no worker has answered)`;
    default:
      return `${name}: not checked (only GitHub is)`;
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
  const api = (): ApiClient =>
    createApiClient(apiUrl(), undefined, cliHeaders());

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
    .action(async (id: string, options) => {
      if (options.contractPath !== undefined) throw contractPathMoved();
      const body = {
        defaultModel: options.defaultModel,
        protectedPaths: options.protectedPath,
        maxConcurrency: options.maxConcurrency,
        budgetLimit: options.budgetLimit,
        limits: parseLimits(options.limit),
      };
      if (Object.values(body).every((value) => value === undefined)) {
        throw new Failure(
          "nothing to change: pass --default-model, --protected-path, --max-concurrency, --budget-limit or --limit",
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
    .command("update")
    .description(
      "replace this plat with the platform's, and install the afk-setup and planning skills again where they are (in this repo, or yours)",
    )
    .action(async () => {
      const base = apiUrl();
      const lines: string[] = [];

      // plat: the platform's copy, written next to this one and moved over it.
      const path = io.platPath ?? process.argv[1];
      const self = path ? realpathSync(path) : "";
      if (!self || self.endsWith(".ts")) {
        lines.push(
          "plat: runs from a checkout of the platform, so it is as new as that checkout (git pull there)",
        );
      } else {
        const response = await fetch(`${base}/cli/plat.mjs`).catch(() => null);
        if (!response?.ok)
          throw new Failure(
            `could not download plat from ${base}/cli/plat.mjs (${response ? `HTTP ${response.status}` : "the platform does not answer"})`,
          );
        const text = await response.text();
        if (text === readFileSync(self, "utf8")) {
          lines.push(`plat: up to date (${PLATFORM_VERSION})`);
        } else {
          const next = `${self}.next`;
          writeFileSync(next, text, { mode: 0o755 });
          renameSync(next, self);
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
      const platform = await createApiClient(base, undefined, cliHeaders())
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
        const doc = renderTrackerDoc(after.data, plan.repos[0]?.name as string);
        const state =
          before === null ? "new" : before === doc ? "unchanged" : "updated";
        if (state !== "unchanged") {
          mkdirSync(dirname(docPath), { recursive: true });
          writeFileSync(docPath, doc);
        }
        const written =
          state === "unchanged" || !trackerDocTracked ? [] : [TRACKER_DOC_PATH];
        const docStates: Record<string, string> = {};
        for (const agentDoc of agentDocs) {
          const docState =
            agentDoc.before === null
              ? "new"
              : agentDoc.before === agentDoc.after
                ? "unchanged"
                : "updated";
          docStates[agentDoc.path] = docState;
          if (docState === "unchanged") continue;
          const target = join(planning.dir, agentDoc.path);
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, agentDoc.after);
          if (agentDoc.tracked) written.push(agentDoc.path);
        }
        excludeLocally(planning.dir, localPaths);
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

  const spec = program.command("spec").description("specs");
  spec
    .command("create")
    .description("create a spec; prints its S-<n> id")
    .requiredOption("--project <id>", "project id", toInt)
    .requiredOption("--type <type>", "feature | bug | improvement")
    .requiredOption("--title <title>")
    .option("--slug <slug>", "default: derived from the title")
    .option("--file <path>", "markdown body")
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
      const { data, response, error } = await api().POST("/specs", {
        body: {
          projectId: options.project,
          type: options.type,
          slug,
          title: options.title,
          body,
          planningRepo,
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
      for (const check of view.data.spec.prechecks) {
        if (check.code === "page-confirm-without-planning-docs") {
          if (docs.status === "ok") continue;
          if (docs.status === "elsewhere" && docs.checkout) {
            io.stderr(
              `yellow: ${docs.checkout} is not a repo of this project, so no planning docs were sent; if it should be, set it up with the afk-setup skill\n`,
            );
            continue;
          }
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
      const { data, response, error } = await api().POST(
        "/specs/{specId}/tickets/import",
        {
          params: {
            path: { specId },
            query: options.append ? { append: "true" } : {},
          },
          body: { files },
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
    .command("resume <spec>")
    .description("let a paused spec go on, with more agent time")
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
      "change a pending or blocked ticket from a ticket file (what plat ticket view --md prints): its title, body, modules and approved protected paths; the acceptance criteria are read from the body. The content version goes up by one if anything changed",
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
      "continue (keep the branch) or restart (start from the integration branch)",
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
      "cancel a pending or blocked ticket; the tickets behind it go to blocked unless --cascade",
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
