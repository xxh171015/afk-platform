import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { type ExecAsyncOptions, type ExecResult, execAsync } from "./exec.ts";

// The Docker steps of an integration environment: services of several repos, built from snapshots at pinned
// SHAs and put on one compose network (docs/specs/m2-platform.md「联调环境」). Every docker call goes through a
// `DockerCli`, so the order of the steps is tested with a docker that only writes them down.

export type DockerResult = Pick<ExecResult, "code" | "out" | "stdout"> & {
  timedOut?: boolean;
};
export type DockerCli = (
  args: string[],
  options?: Pick<ExecAsyncOptions, "timeoutMs" | "signal" | "input">,
) => Promise<DockerResult>;

export const realDocker: DockerCli = (args, options) =>
  execAsync("docker", args, options);

// Where a repo keeps its part of the environment, relative to its root.
export const COMPOSE_FRAGMENT_PATH = ".sandcastle/integration/compose.yaml";
const COMPOSE_PROJECT_LABEL = "com.docker.compose.project";
const COMPOSE_NETWORK_LABEL = "com.docker.compose.network";

const BUILD_TIMEOUT_MS = 10 * 60_000;
const UP_TIMEOUT_MS = 5 * 60_000;
const SEED_TIMEOUT_MS = 5 * 60_000;
const LOOK_TIMEOUT_MS = 30_000;
const DOWN_TIMEOUT_MS = 2 * 60_000;
const LOG_TAIL_LINES = 40;

// The environment could not be made: a build failed, a service is not healthy, two repos use the same service
// name. The worker reports the job as failed with this message, which carries the tail of the log.
export class EnvironmentError extends Error {}

export interface EnvironmentRepo {
  name: string;
  dir: string; // the read-only snapshot of the repo at `sha`
  sha: string;
}

export interface Environment {
  project: string; // the compose project, `afk-<run-id>`
  network: string; // the compose default network: where the sandbox joins
  env: Record<string, string>; // service addresses for the sandbox, from the fragments' `x-afk-env`
  shas: Record<string, string>; // repo name -> SHA the services were built from
  upMs: number; // build, up and seeds
  // Takes the environment down. The sandbox must be closed before: a network with a container still attached
  // survives `compose down`.
  stop(): Promise<void>;
}

// The names that docker (images) and compose (projects) accept: lowercase letters, digits, - and _.
const slug = (runId: string) =>
  runId.toLowerCase().replaceAll(/[^a-z0-9_-]/g, "-");
export const projectOf = (runId: string) => `afk-${slug(runId)}`;

// The compose projects the platform makes are `afk-r-<number>`, one per Run. Only those are ever taken down by
// the platform: a person's own project may well start with `afk-` (the platform's own compose project is
// `afk-platform`, and `down -v` of it deletes its database).
const isEnvironmentProject = (project: string) =>
  /^afk-r-[0-9]+$/.test(project);

interface Fragment {
  repo: EnvironmentRepo;
  file: string;
  services: Map<string, ServiceSpec>;
  env: Record<string, string>;
}
interface ServiceSpec {
  image?: string;
  build?: string | { context?: string; dockerfile?: string };
}

function readFragment(repo: EnvironmentRepo): Fragment {
  const file = join(repo.dir, COMPOSE_FRAGMENT_PATH);
  if (!existsSync(file))
    throw new EnvironmentError(`${repo.name} has no ${COMPOSE_FRAGMENT_PATH}`);
  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(file, "utf8"));
  } catch (error) {
    throw new EnvironmentError(
      `${repo.name}: ${COMPOSE_FRAGMENT_PATH} is not YAML (${error instanceof Error ? error.message : error})`,
    );
  }
  const root = (parsed ?? {}) as {
    services?: Record<string, ServiceSpec | null>;
    "x-afk-env"?: Record<string, unknown>;
  };
  const services = new Map(
    Object.entries(root.services ?? {}).map(([name, spec]) => [
      name,
      spec ?? {},
    ]),
  );
  const env = Object.fromEntries(
    Object.entries(root["x-afk-env"] ?? {}).map(([key, value]) => [
      key,
      String(value),
    ]),
  );
  return { repo, file, services, env };
}

const seedServiceOf = (repoName: string) => `seed-${repoName}`;
const isSeed = (service: string) => service.startsWith("seed-");

const composeDown = (docker: DockerCli, project: string) =>
  docker(
    [
      "compose",
      "-p",
      project,
      "down",
      "-v",
      "--rmi",
      "local",
      "--remove-orphans",
    ],
    {
      timeoutMs: DOWN_TIMEOUT_MS,
    },
  );

const tail = (text: string) =>
  text.trimEnd().split("\n").slice(-LOG_TAIL_LINES).join("\n");

export interface StartEnvironmentInput {
  docker: DockerCli;
  runId: string;
  repos: EnvironmentRepo[]; // in the order of the ticket's `environment:`, which is the order the seeds run in
  signal?: AbortSignal;
  log?: (line: string) => void;
}

export async function startEnvironment(
  input: StartEnvironmentInput,
): Promise<Environment> {
  const { docker, signal } = input;
  const log = input.log ?? (() => {});
  const project = projectOf(input.runId);

  // Everything that can be wrong with the fragments is found before anything is built or started.
  const fragments = input.repos.map(readFragment);
  const owner = new Map<string, string>();
  const env: Record<string, string> = {};
  for (const fragment of fragments) {
    for (const [service, spec] of fragment.services) {
      const other = owner.get(service);
      if (other)
        throw new EnvironmentError(
          `service "${service}" is in both ${other} and ${fragment.repo.name}: service names must be unique across the fragments`,
        );
      owner.set(service, fragment.repo.name);
      if (spec.build && spec.image)
        throw new EnvironmentError(
          `service "${service}" of ${fragment.repo.name} has both build and image: the built image is named ${project}-${service}`,
        );
    }
    for (const [key, value] of Object.entries(fragment.env)) {
      if (env[key] !== undefined && env[key] !== value)
        throw new EnvironmentError(
          `x-afk-env ${key} is set to different values by the fragments`,
        );
      env[key] = value;
    }
  }

  const started = Date.now();
  const built: string[] = [];
  const compose = [
    "compose",
    "-p",
    project,
    ...fragments.flatMap((f) => ["-f", f.file]),
  ];
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    const down = () => composeDown(docker, project);
    await down();
    // A network that is still there (a sandbox was attached while compose took the project down) goes with a
    // second down.
    if ((await networkOf(docker, project)) !== undefined) {
      await down();
    }
    // --rmi local only drops untagged compose images. This run also `docker build -t ${project}-${service}`,
    // which --rmi local will not remove; those tags are this run's, not the sandbox or a FROM image.
    if (built.length > 0)
      await docker(["rmi", "-f", ...built], { timeoutMs: DOWN_TIMEOUT_MS });
  };

  const run = async (
    what: string,
    args: string[],
    timeoutMs: number,
  ): Promise<DockerResult> => {
    const result = await docker(args, { timeoutMs, signal });
    if (result.code !== 0) {
      const extra =
        what === "compose up"
          ? await docker([...compose, "logs", "--no-color", "--tail", "30"], {
              timeoutMs: LOOK_TIMEOUT_MS,
            })
          : undefined;
      throw new EnvironmentError(
        `${what} failed (${result.timedOut ? "timed out" : `exit ${result.code}`}):\n${tail(result.out)}${extra?.out ? `\n--- compose logs ---\n${tail(extra.out)}` : ""}`,
      );
    }
    return result;
  };

  try {
    // The project is this run's alone. If it is up, an attempt before this one (its worker was killed, or lost its
    // lease) left it, with whatever its e2e wrote into the services: a new attempt starts from nothing, so that its
    // result does not depend on the one before.
    await composeDown(docker, project);
    for (const fragment of fragments) {
      for (const [service, spec] of fragment.services) {
        if (!spec.build) continue;
        const tag = `${project}-${service}`;
        const build =
          typeof spec.build === "string" ? { context: spec.build } : spec.build;
        // relative paths are the fragment's, as compose reads them
        const base = dirname(fragment.file);
        const context = resolve(base, build.context ?? ".");
        // as compose reads it, the Dockerfile is relative to the build context
        const dockerfile = resolve(context, build.dockerfile ?? "Dockerfile");
        log(`environment: building ${service} of ${fragment.repo.name}`);
        built.push(tag);
        await run(
          `docker build of ${service} (${fragment.repo.name})`,
          ["build", "--pull=false", "-t", tag, "-f", dockerfile, context],
          BUILD_TIMEOUT_MS,
        );
      }
    }
    const services = [...owner.keys()].filter((s) => !isSeed(s));
    log(`environment: compose up ${services.join(" ")}`);
    await run(
      "compose up",
      [...compose, "up", "--no-build", "-d", "--wait", ...services],
      UP_TIMEOUT_MS,
    );
    for (const fragment of fragments) {
      const seed = seedServiceOf(fragment.repo.name);
      if (!fragment.services.has(seed)) continue;
      log(`environment: ${seed}`);
      await run(seed, [...compose, "run", "--rm", seed], SEED_TIMEOUT_MS);
    }
    const network = await networkOf(docker, project);
    if (!network)
      throw new EnvironmentError(
        `the compose project ${project} has no default network`,
      );
    return {
      project,
      network,
      env,
      shas: Object.fromEntries(input.repos.map((r) => [r.name, r.sha])),
      upMs: Date.now() - started,
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}

// By label, not by name: the name is compose's to make. undefined when there is none.
async function networkOf(
  docker: DockerCli,
  project: string,
): Promise<string | undefined> {
  const listed = await docker(
    [
      "network",
      "ls",
      "--filter",
      `label=${COMPOSE_PROJECT_LABEL}=${project}`,
      "--filter",
      `label=${COMPOSE_NETWORK_LABEL}=default`,
      "--format",
      "{{.Name}}",
    ],
    { timeoutMs: LOOK_TIMEOUT_MS },
  );
  return listed.code === 0
    ? listed.stdout
        .split("\n")
        .find((line) => line.trim())
        ?.trim()
    : undefined;
}

// A worker that was killed leaves its environment running (its containers carry the compose project label).
// Takes down every `afk-r-<number>` project that is not one of `keep`, and removes the images built for it. Returns the
// projects it took down. If docker cannot be asked nothing is touched.
export async function reclaimEnvironments(input: {
  docker: DockerCli;
  keep: ReadonlySet<string>;
  log?: (line: string) => void;
}): Promise<string[]> {
  const { docker } = input;
  const listed = await docker(
    [
      "ps",
      "-a",
      "--filter",
      `label=${COMPOSE_PROJECT_LABEL}`,
      "--format",
      `{{.Label "${COMPOSE_PROJECT_LABEL}"}}`,
    ],
    { timeoutMs: LOOK_TIMEOUT_MS },
  );
  if (listed.code !== 0) return [];
  const orphans = [
    ...new Set(listed.stdout.split("\n").map((line) => line.trim())),
  ].filter(
    (project) => isEnvironmentProject(project) && !input.keep.has(project),
  );
  for (const project of orphans) {
    input.log?.(
      `environment: taking down ${project}, left by a worker that stopped`,
    );
    await composeDown(docker, project);
    const images = await docker(
      [
        "image",
        "ls",
        "--filter",
        `reference=${project}-*`,
        "--format",
        "{{.Repository}}:{{.Tag}}",
      ],
      { timeoutMs: LOOK_TIMEOUT_MS },
    );
    const names = images.stdout.split("\n").filter((line) => line.trim());
    if (names.length > 0)
      await docker(["rmi", "-f", ...names], { timeoutMs: DOWN_TIMEOUT_MS });
  }
  return orphans;
}
