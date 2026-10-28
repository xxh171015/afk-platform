import { readFile } from "node:fs/promises";
import { type ApiClient, createApiClient, parseDisplayId } from "@afk/shared";
import { Command, CommanderError, InvalidArgumentError } from "commander";
import { parse as parseYaml } from "yaml";

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
const collect = (value: string, previous: string[] = []) => [
  ...previous,
  value,
];

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

  program
    .command("project")
    .description("projects")
    .command("create <name>")
    .description("register a project")
    .option("--default-agent <agent>")
    .option("--default-model <model>")
    .option("--contract-path <path>", "e.g. backend:openapi/openapi.yaml")
    .option("--protected-path <glob>", "repeatable", collect)
    .option("--max-concurrency <n>", "tickets running at once", toInt)
    .option("--budget-limit <n>", "", toInt)
    .option("--merge-policy <policy>")
    .option(
      "--limit <name=value>",
      "override a concurrency or budget default, e.g. repoConcurrency=3 (repeatable)",
      collect,
    )
    .action(async (name: string, options) => {
      const { data, response, error } = await api().POST("/projects", {
        body: {
          name,
          defaultAgent: options.defaultAgent,
          defaultModel: options.defaultModel,
          contractPath: options.contractPath,
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

  program
    .command("repo")
    .description("repos")
    .command("add")
    .description("add a repo to a project")
    .requiredOption("--project <id>", "project id", toInt)
    .requiredOption("--role <role>", "how tickets.yaml names it, e.g. backend")
    .requiredOption("--url <url>", "clone URL")
    .option("--default-branch <branch>", "default: main")
    .action(async (options) => {
      const { data, response, error } = await api().POST(
        "/projects/{projectId}/repos",
        {
          params: { path: { projectId: options.project } },
          body: {
            url: options.url,
            role: options.role,
            defaultBranch: options.defaultBranch,
          },
        },
      );
      if (!data) throw failureFrom(response, error);
      print(data, `repo ${data.id} ${data.role}`);
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
    .action(async (spec: string, file: string) => {
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
          params: { path: { specId } },
          body: document as Record<string, unknown>,
        },
      );
      if (!data) throw failureFrom(response, error);
      const lines = [
        `imported ${data.tickets.length} tickets into ${spec}`,
        ...data.tickets.map((t) => `  ${t.displayId}  ${t.key}`),
        ...data.warnings.map((w) => `warning: ${w.message}`),
      ];
      print(data, lines.join("\n"));
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
