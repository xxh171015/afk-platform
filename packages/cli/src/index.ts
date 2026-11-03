import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  type ApiClient,
  createApiClient,
  HOST_KINDS,
  parseDisplayId,
} from "@afk/shared";
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
import { blockedText, specText, ticketText } from "./format.ts";
import {
  hasRegistrations,
  InitError,
  inspectCheckout,
  parseWith,
  planInit,
  planText,
  TRACKER_DOC_PATH,
} from "./init.ts";
import { skillsWarnings, trackerDocWarnings } from "./planning-checks.ts";
import { inspectPlanningCommit } from "./planning-commit.ts";
import { renderTrackerDoc, trackerDocTarget } from "./tracker-doc.ts";

// `plat`: the developer's and the planning agent's way into the platform API (docs/specs/m1-platform.md「plat CLI」).
// Output is for people by default and a single JSON document with --json (for skills and scripts).

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
    .option("--api-url <url>", "platform API (default $AFK_API_URL)")
    .exitOverride()
    .configureOutput({
      writeOut: io.stdout,
      writeErr: io.stderr,
    });

  const json = () => Boolean(program.opts().json);
  const api = (): ApiClient =>
    createApiClient(
      program.opts().apiUrl ?? io.env.AFK_API_URL ?? DEFAULT_API_URL,
    );
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
        ...(io.env.HOME ? await skillsWarnings(io.readFile, io.env.HOME) : []),
      ];
      for (const warning of warnings) io.stderr(`${warning}\n`);
    } catch {
      // A check that cannot run is not worth failing a command that worked.
    }
  };

  program
    .command("init")
    .description(
      "run in the planning repo: register its project and repos (this one and each --with) and write its tracker doc; asks first, never commits",
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
    .action(async (options) => {
      const client = api();
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
        const planning = inspectCheckout(".", cwd);
        const others = (options.with as string[]).map((value) => {
          const { path, name } = parseWith(value);
          return { checkout: inspectCheckout(path, cwd), name };
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
        if (!json()) io.stdout(`${planText(plan)}\n`);

        const registering = hasRegistrations(plan);
        if (!registering && found) {
          const doc = renderTrackerDoc(found, plan.repos[0]?.name as string);
          if (doc === before) {
            print(
              { project: found.id, registered: [], trackerDoc: "unchanged" },
              "nothing to register and the tracker doc is up to date",
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
          if (!(await io.confirm("Register and write the tracker doc?"))) {
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
        const lines = [
          `project ${projectId} ${after.data.name}${plan.project.kind === "new" ? " (new)" : ""}`,
          ...(registered.length > 0
            ? [`registered: ${registered.join(", ")}`]
            : []),
          `tracker doc ${TRACKER_DOC_PATH}: ${state}`,
          ...(state === "unchanged"
            ? []
            : [
                `next, in ${planning.dir}: git add ${TRACKER_DOC_PATH} && git commit -m "Generate the tracker doc with plat init" && git push`,
              ]),
        ];
        print(
          { project: projectId, registered, trackerDoc: state },
          lines.join("\n"),
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
      const { data, response, error } = await api().POST("/specs", {
        body: {
          projectId: options.project,
          type: options.type,
          slug,
          title: options.title,
          body,
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
      "confirm the split: the spec runs and ready tickets are queued",
    )
    .option(
      "--force",
      "confirm even if GLOSSARY.md, docs/adr or AGENTS.md still have uncommitted changes",
    )
    .action(async (id: string, options: { force?: boolean }) => {
      const specId = specIdOf(id);
      const view = await api().GET("/specs/{id}", {
        params: { path: { id: specId } },
      });
      if (!view.data) throw failureFrom(view.response, view.error);
      const project = await api().GET("/projects/{projectId}", {
        params: { path: { projectId: view.data.spec.projectId } },
      });
      const inspected = project.data
        ? inspectPlanningCommit(io.cwd ?? process.cwd(), project.data.repos)
        : ({ status: "skip" } as const);
      const dirty =
        inspected.status === "ok" || inspected.status === "reject"
          ? inspected.dirty
          : false;
      const planning =
        inspected.status === "ok" ||
        (options.force === true &&
          inspected.status === "reject" &&
          inspected.reason === "dirty")
          ? {
              planningSha: inspected.sha,
              planningRepo: inspected.repoName,
            }
          : undefined;
      if (inspected.status === "reject" && planning === undefined) {
        for (const line of yellowLines(view.data.spec.prechecks, dirty, false))
          io.stderr(`${line}\n`);
        throw new Failure(inspected.message);
      }
      for (const line of yellowLines(
        view.data.spec.prechecks,
        dirty,
        planning !== undefined,
      ))
        io.stderr(`${line}\n`);
      const { data, response, error } = await api().POST(
        "/specs/{specId}/confirm",
        {
          params: { path: { specId } },
          ...(planning ? { body: planning } : {}),
        },
      );
      if (!data) throw failureFrom(response, error);
      const lines = [
        `${id} is ${data.state}`,
        ...(data.planningSha
          ? [`  planning ${data.planningSha} (${data.planningRepo})`]
          : []),
        ...data.integrationBranches.map(
          (b) => `  repo ${b.repoId}: ${b.branch}`,
        ),
        ...data.enqueued.map((t) => `  queued ${t.displayId}`),
      ];
      print(data, lines.join("\n"));
    });

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

function yellowLines(
  prechecks: { code: string; message: string }[],
  dirty: boolean,
  recordingPlanning: boolean,
): string[] {
  return [
    ...prechecks
      .filter(
        (p) => !(recordingPlanning && p.code === "missing-planning-commit"),
      )
      .map((p) => `yellow: ${p.message}`),
    ...(dirty ? ["yellow: 规划仓库工作区相对规划提交不干净"] : []),
  ];
}

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
