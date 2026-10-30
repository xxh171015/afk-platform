import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type DockerResult,
  EnvironmentError,
  reclaimEnvironments,
  startEnvironment,
} from "./integration-env.ts";
import { FakeDocker } from "./testing/fakes.ts";

// The Docker steps of an integration environment, with a docker that only writes down what it is asked
// (docs/specs/m2-platform.md「联调环境」).

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "afk-env-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

// A repo snapshot with a compose fragment (and a Dockerfile for the services that build).
function snapshot(name: string, fragment: string): string {
  const dir = join(root, `${name}@abc`);
  const file = join(dir, ".sandcastle/integration/compose.yaml");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, fragment);
  writeFileSync(join(dir, "Dockerfile"), "FROM scratch\n");
  return dir;
}

const BACKEND = `
x-afk-env:
  BACKEND_URL: http://backend:8080
services:
  backend:
    build:
      context: ../..
    healthcheck: { test: ["CMD", "true"] }
  seed-afk-pilot-backend:
    image: afk-pilot-backend-seed
    profiles: [seed]
`;
const SEARCH = `
services:
  search:
    image: search:1
  seed-search:
    image: search-seed
`;

function fakeDocker(
  answer: (args: string[]) => Partial<DockerResult> | undefined = () =>
    undefined,
) {
  const fake = new FakeDocker();
  fake.answer = answer;
  return Object.assign(fake, { docker: fake.cli, leave: fake });
}

const repos = () => [
  {
    name: "afk-pilot-backend",
    dir: snapshot("afk-pilot-backend", BACKEND),
    sha: "b1",
  },
  { name: "search", dir: snapshot("search", SEARCH), sha: "s1" },
];

describe("starting an environment", () => {
  it("builds the services that build, in their own snapshot, without pulling", async () => {
    const fake = fakeDocker();
    const [backend] = repos();
    await startEnvironment({
      docker: fake.docker,
      runId: "R-9",
      repos: [backend as never],
    });
    const [build] = fake.only("build");
    expect(build).toEqual([
      "build",
      "--pull=false",
      "-t",
      "afk-r-9-backend",
      "-f",
      join((backend as { dir: string }).dir, "Dockerfile"),
      (backend as { dir: string }).dir,
    ]);
  });

  it("reads the Dockerfile relative to the build context, as compose does", async () => {
    const fake = fakeDocker();
    const dir = snapshot(
      "api",
      "services:\n  api:\n    build:\n      context: ../..\n      dockerfile: docker/Api.Dockerfile\n",
    );
    await startEnvironment({
      docker: fake.docker,
      runId: "R-9",
      repos: [{ name: "api", dir, sha: "a1" }],
    });
    const [build] = fake.only("build");
    expect(build?.slice(-3)).toEqual([
      "-f",
      join(dir, "docker/Api.Dockerfile"),
      dir,
    ]);
  });

  it("merges the fragments in the order of the environment and brings them up without building", async () => {
    const fake = fakeDocker();
    const list = repos();
    const env = await startEnvironment({
      docker: fake.docker,
      runId: "R-9",
      repos: list,
    });
    const [up] = fake.only("compose", "-p", "afk-r-9");
    expect(up?.slice(0, 7)).toEqual([
      "compose",
      "-p",
      "afk-r-9",
      "-f",
      join(list[0]?.dir as string, ".sandcastle/integration/compose.yaml"),
      "-f",
      join(list[1]?.dir as string, ".sandcastle/integration/compose.yaml"),
    ]);
    expect(up?.slice(7)).toEqual([
      "up",
      "--no-build",
      "-d",
      "--wait",
      "backend",
      "search",
    ]);
    expect(env.project).toBe("afk-r-9");
  });

  it("runs the seed services one after the other, in the order of the environment", async () => {
    const fake = fakeDocker();
    await startEnvironment({
      docker: fake.docker,
      runId: "R-9",
      repos: repos(),
    });
    const seeds = fake.calls
      .filter((c) => c.includes("run"))
      .map((c) => c.slice(c.indexOf("run")));
    expect(seeds).toEqual([
      ["run", "--rm", "seed-afk-pilot-backend"],
      ["run", "--rm", "seed-search"],
    ]);
    const lastUp = fake.calls.findIndex((c) => c.includes("up"));
    const firstSeed = fake.calls.findIndex((c) => c.includes("run"));
    expect(firstSeed).toBeGreaterThan(lastUp);
  });

  it("finds the network by the compose labels and the service addresses in the fragments", async () => {
    const fake = fakeDocker();
    const env = await startEnvironment({
      docker: fake.docker,
      runId: "R-9",
      repos: repos(),
    });
    expect(fake.only("network", "ls")[0]).toEqual([
      "network",
      "ls",
      "--filter",
      "label=com.docker.compose.project=afk-r-9",
      "--filter",
      "label=com.docker.compose.network=default",
      "--format",
      "{{.Name}}",
    ]);
    expect(env.network).toBe("afk-r-9_default");
    expect(env.env).toEqual({ BACKEND_URL: "http://backend:8080" });
    expect(env.shas).toEqual({ "afk-pilot-backend": "b1", search: "s1" });
  });

  it("refuses two services of the same name before anything is built or started", async () => {
    const fake = fakeDocker();
    const list = repos();
    list.push({
      name: "other",
      dir: snapshot("other", "services:\n  search:\n    image: x\n"),
      sha: "o1",
    });
    await expect(
      startEnvironment({ docker: fake.docker, runId: "R-9", repos: list }),
    ).rejects.toThrow(/service "search" is in both search and other/);
    expect(fake.calls).toEqual([]);
  });

  it("refuses a repo without a fragment", async () => {
    const fake = fakeDocker();
    const dir = join(root, "bare@abc");
    mkdirSync(dir);
    await expect(
      startEnvironment({
        docker: fake.docker,
        runId: "R-9",
        repos: [{ name: "bare", dir, sha: "x" }],
      }),
    ).rejects.toThrow(/bare has no .sandcastle\/integration\/compose.yaml/);
  });

  it("takes everything down again when the environment does not come up, and says why with the log tail", async () => {
    const fake = fakeDocker((args) =>
      args.includes("up")
        ? { code: 1, out: "line 1\nservice backend is unhealthy" }
        : undefined,
    );
    const failure = await startEnvironment({
      docker: fake.docker,
      runId: "R-9",
      repos: repos(),
    }).catch((error) => error);
    expect(failure).toBeInstanceOf(EnvironmentError);
    expect(failure.message).toContain("service backend is unhealthy");
    expect(fake.only("compose")[fake.only("compose").length - 1]).toContain(
      "down",
    );
    expect(fake.only("rmi").length).toBe(1);
  });
});

describe("stopping an environment", () => {
  it("takes it down with its volumes and removes the images it built", async () => {
    const fake = fakeDocker();
    const env = await startEnvironment({
      docker: fake.docker,
      runId: "R-9",
      repos: repos(),
    });
    fake.calls.length = 0;
    await env.stop();
    expect(fake.calls[0]?.slice(0, 3)).toEqual(["compose", "-p", "afk-r-9"]);
    expect(fake.calls[0]?.slice(-3)).toEqual([
      "down",
      "-v",
      "--remove-orphans",
    ]);
    expect(fake.only("rmi")).toEqual([["rmi", "-f", "afk-r-9-backend"]]);
  });

  it("looks for the network once more and takes the project down again when it is still there", async () => {
    const fake = fakeDocker();
    const env = await startEnvironment({
      docker: fake.docker,
      runId: "R-9",
      repos: repos(),
    });
    fake.calls.length = 0;
    fake.leaveNetworkAfterDown = true;
    await env.stop();
    const kinds = fake.calls.map((c) => (c[0] === "compose" ? "down" : c[0]));
    expect(kinds).toEqual(["down", "network", "down", "rmi"]);
  });

  it("does not take it down a second time when the network is gone", async () => {
    const fake = fakeDocker();
    const env = await startEnvironment({
      docker: fake.docker,
      runId: "R-9",
      repos: repos(),
    });
    fake.calls.length = 0;
    await env.stop();
    expect(fake.calls.map((c) => c[0])).toEqual(["compose", "network", "rmi"]);
  });

  it("can be called twice", async () => {
    const fake = fakeDocker();
    const env = await startEnvironment({
      docker: fake.docker,
      runId: "R-9",
      repos: repos(),
    });
    await env.stop();
    fake.calls.length = 0;
    await env.stop();
    expect(fake.calls).toEqual([]);
  });
});

describe("reclaiming the environments of workers that were killed", () => {
  const listing = (projects: string[]) => (args: string[]) =>
    args[0] === "ps" ? { stdout: projects.join("\n") } : undefined;

  it("takes down every afk project that is not one this worker is running", async () => {
    const fake = fakeDocker(
      listing(["afk-r-3", "afk-r-9", "other-app", "afk-r-3", ""]),
    );
    const reclaimed = await reclaimEnvironments({
      docker: fake.docker,
      keep: new Set(["afk-r-9"]),
    });
    expect(reclaimed).toEqual(["afk-r-3"]);
    expect(fake.only("compose")).toEqual([
      ["compose", "-p", "afk-r-3", "down", "-v", "--remove-orphans"],
    ]);
    expect(fake.only("ps")[0]).toEqual([
      "ps",
      "-a",
      "--filter",
      "label=com.docker.compose.project",
      "--format",
      '{{.Label "com.docker.compose.project"}}',
    ]);
  });

  it("never touches a project that only looks like one of ours: a person's own compose project may be called afk-<something>", async () => {
    // afk-platform is what compose names the platform's own repo (and its Postgres); `down -v` on it deletes the data
    const fake = fakeDocker(
      listing([
        "afk-platform",
        "afk-pilot-backend",
        "afk-r-",
        "afk-r-3x",
        "afk-r-0007-old",
        "afk-R-3",
        "afk-r-3",
      ]),
    );
    const reclaimed = await reclaimEnvironments({
      docker: fake.docker,
      keep: new Set(),
    });
    expect(reclaimed).toEqual(["afk-r-3"]);
    expect(fake.only("compose")).toEqual([
      ["compose", "-p", "afk-r-3", "down", "-v", "--remove-orphans"],
    ]);
  });

  it("leaves everything alone when docker cannot be asked", async () => {
    const fake = fakeDocker((args) =>
      args[0] === "ps" ? { code: 1 } : undefined,
    );
    expect(
      await reclaimEnvironments({ docker: fake.docker, keep: new Set() }),
    ).toEqual([]);
    expect(fake.only("compose")).toEqual([]);
  });
});
