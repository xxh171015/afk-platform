import { readFile } from "node:fs/promises";
import { type ApiClient, createApiClient, parseDisplayId } from "@afk/shared";
import { Command, CommanderError, InvalidArgumentError } from "commander";
import { parse as parseYaml } from "yaml";
import { blockedText, specText, ticketText } from "./format.ts";

// `plat`: the developer's and the planning agent's way into the platform API (docs/specs/m1-platform.md「plat CLI」).
// Output is for people by default and a single JSON document with --json (for skills and scripts).

export interface Io {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: Record<string, string | undefined>;
  readFile: (path: string) => Promise<string>;
}

export const defaultIo: Io = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  env: process.env,
  readFile: (path) => readFile(path, "utf8"),
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
    .option("--name <name>", "how tickets.yaml names it, e.g. backend")
    .option("--role <role>", "older word for --name; still works")
    .requiredOption("--url <url>", "clone URL")
    .option("--default-branch <branch>", "default: main")
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
    .action(async (name: string, options) => {
      if (options.contractPath === undefined) {
        throw new Failure("nothing to change: pass --contract-path");
      }
      const { data, response, error } = await api().PATCH(
        "/projects/{projectId}/repos/{name}",
        {
          params: { path: { projectId: options.project, name } },
          body: { contractPath: options.contractPath },
        },
      );
      if (!data) throw failureFrom(response, error);
      print(data, `repo ${data.id} ${data.name} updated`);
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
      const body = options.file ? await io.readFile(options.file) : undefined;
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
      print(data, data.displayId);
    });

  spec
    .command("confirm <spec>")
    .description(
      "confirm the split: the spec runs and ready tickets are queued",
    )
    .action(async (id: string) => {
      const specId = specIdOf(id);
      const { data, response, error } = await api().POST(
        "/specs/{specId}/confirm",
        { params: { path: { specId } } },
      );
      if (!data) throw failureFrom(response, error);
      const lines = [
        `${id} is ${data.state}`,
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
    .command("import <spec> <file>")
    .description("import a whole tickets.yaml into a spec, or nothing at all")
    .option(
      "--append",
      "add the file's tickets and edges to a confirmed spec (planned, running or paused); they take effect at once. The file may name existing tickets as T-<n> and carry an edges list",
    )
    .action(async (spec: string, file: string, options) => {
      const specId = specIdOf(spec);
      let document: unknown;
      try {
        document = parseYaml(await io.readFile(file));
      } catch (error) {
        throw new Failure(`cannot read ${file}: ${(error as Error).message}`);
      }
      if (
        typeof document !== "object" ||
        document === null ||
        Array.isArray(document)
      ) {
        throw new Failure(`${file} must be a YAML mapping with a tickets list`);
      }
      const { data, response, error } = await api().POST(
        "/specs/{specId}/tickets/import",
        {
          params: {
            path: { specId },
            query: options.append ? { append: "true" } : {},
          },
          body: document as Record<string, unknown>,
        },
      );
      if (!data) throw failureFrom(response, error);
      const lines = [
        `${options.append ? "appended" : "imported"} ${data.tickets.length} tickets ${options.append ? "to" : "into"} ${spec}`,
        ...data.tickets.map((t) => `  ${t.displayId}  ${t.key}`),
        ...data.warnings.map((w) => `warning: ${w.message}`),
      ];
      print(data, lines.join("\n"));
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
    .action(async (id: string) => {
      const { data, response, error } = await api().POST(
        "/specs/{id}/final/retry",
        {
          params: { path: { id: specIdOf(id) } },
        },
      );
      if (!data) throw failureFrom(response, error);
      print(data, `${id}: running again: ${data.retried.join(", ")}`);
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
      "a ticket with its runs, findings and, when blocked, its brief",
    )
    .action(async (id: string) => {
      const { data, response, error } = await api().GET("/tickets/{id}", {
        params: { path: { id: ticketIdOf(id) } },
      });
      if (!data) throw failureFrom(response, error);
      print(data, ticketText(data));
    });
  ticketCommands
    .command("retry <ticket>")
    .description("try a blocked ticket again")
    .requiredOption(
      "--mode <mode>",
      "continue (keep the branch) or restart (start from the integration branch)",
    )
    .action(async (id: string, options) => {
      if (options.mode !== "continue" && options.mode !== "restart") {
        throw new Failure("--mode must be continue or restart");
      }
      const { data, response, error } = await api().POST(
        "/tickets/{id}/retry",
        {
          params: { path: { id: ticketIdOf(id) } },
          body: { mode: options.mode },
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
