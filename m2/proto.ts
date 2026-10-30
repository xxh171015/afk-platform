// PROTOTYPE, throwaway (wayfinder #70「联调环境原型在 Mac 上跑通」). Not platform code; lives only on the
// prototype/m2-integration branch. Answers: can the worker stand up a compose environment for the backend, put a
// Sandcastle sandbox of the frontend on its network with read-only /context and /refs, and get a real Cursor agent
// to run the e2e tests and report an integration result?
//
//   node proto.ts run [--bug]   one integration run (--bug: the backend's history comes back in reverse order)
//   node proto.ts checks        the seven Docker facts #64 left to measure, no agent
//
// Needs: PROTO_HOME (scratch dir holding backend.git and frontend.git bare clones), CURSOR_API_KEY, AFK_MODEL.
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createSandbox, cursor, Output, run } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { z } from "zod";

const HOME = process.env.PROTO_HOME ?? resolve("work");
const IMAGE = "afk-pilot-frontend-sandbox:m2";
const here = import.meta.dirname;
const t0 = Date.now();
const log = (step: string, detail: unknown = "") =>
  console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${step}`, typeof detail === "string" ? detail : JSON.stringify(detail));

function sh(cmd: string, args: string[], opts: { cwd?: string; allowFail?: boolean; input?: string } = {}) {
  const r = spawnSync(cmd, args, { cwd: opts.cwd, encoding: "utf8", input: opts.input, maxBuffer: 64 << 20 });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
  if (r.status !== 0 && !opts.allowFail) throw new Error(`${cmd} ${args.join(" ")} -> ${r.status}\n${out}`);
  return { code: r.status ?? -1, out };
}
const git = (dir: string, ...args: string[]) => sh("git", args, { cwd: dir }).out;
const timed = <T>(f: () => T): [T, number] => {
  const s = Date.now();
  const v = f();
  return [v, Date.now() - s];
};

function untar(buf: Buffer, into: string) {
  const r = spawnSync("tar", ["-x", "-C", into], { input: buf });
  if (r.status !== 0) throw new Error(`tar -x failed: ${r.stderr}`);
}

const IntegrationResult = z.object({
  result: z.enum(["pass", "fail"]),
  failingSide: z.enum(["backend", "frontend", "unknown"]).nullable(),
  evidence: z.array(z.string()),
  failingTests: z.array(z.string()),
});

async function integrationRun(bug: boolean) {
  const runId = `p${Date.now().toString(36)}`;
  const project = `afk-${runId}`;
  log("docker", sh("docker", ["version", "--format", "{{.Server.Version}}"]).out);

  const backendBare = join(HOME, "backend.git");
  const frontendBare = join(HOME, "frontend.git");
  const backendSha = git(backendBare, "rev-parse", "main");
  const frontendSha = git(frontendBare, "rev-parse", "main");
  log("shas", { backend: backendSha.slice(0, 7), frontend: frontendSha.slice(0, 7) });

  // 1. read-only snapshot of the backend: what /refs/afk-pilot-backend shows, and the build context
  const snapDir = join(HOME, "snapshots");
  rmSync(snapDir, { recursive: true, force: true });
  mkdirSync(snapDir, { recursive: true });
  // export-ignore / export-subst switched off through info/attributes, the highest-priority attributes file
  mkdirSync(join(backendBare, "info"), { recursive: true });
  writeFileSync(join(backendBare, "info", "attributes"), "* -export-ignore -export-subst\n");
  const tarBuf = execFileSync("git", ["-C", backendBare, "archive", "--format=tar", backendSha], { maxBuffer: 256 << 20 });
  const snap = join(snapDir, `afk-pilot-backend@${backendSha.slice(0, 12)}`);
  const tmp = `${snap}.tmp`;
  mkdirSync(tmp);
  const [, snapMs] = timed(() => untar(tarBuf, tmp));
  renameSync(tmp, snap);
  log("snapshot", { dir: snap, ms: snapMs, bytes: tarBuf.length });

  // the build context is a copy: the --bug variant changes it, /refs keeps showing the commit
  const buildCtx = join(HOME, "build", runId);
  cpSync(snap, buildCtx, { recursive: true });
  if (bug) {
    const store = join(buildCtx, "src/orders/store.ts");
    const src = readFileSync(store, "utf8");
    const patched = src.replace("return entries.map((entry) => ({ ...entry }));", "return entries.map((entry) => ({ ...entry })).reverse();");
    if (patched === src) throw new Error("bug patch did not apply: look at src/orders/store.ts history()");
    writeFileSync(store, patched);
    log("bug", "history() now returns newest first");
  }

  // 2. backend image + compose environment (docker build, then compose up --no-build: compose build cannot reach
  //    Docker Hub on this Mac)
  const [, buildMs] = timed(() => sh("docker", ["build", "--pull=false", "-q", "-t", `${project}-backend`, buildCtx]));
  const compose = ["compose", "-p", project, "-f", join(buildCtx, ".sandcastle/integration/compose.yaml")];
  const [, upMs] = timed(() => sh("docker", [...compose, "up", "--no-build", "-d", "--wait", "backend"]));
  const [seed, seedMs] = timed(() => sh("docker", [...compose, "run", "--rm", "seed"]));
  const network = sh("docker", [
    "network", "ls", "--filter", `label=com.docker.compose.project=${project}`,
    "--filter", "label=com.docker.compose.network=default", "--format", "{{.Name}}",
  ]).out;
  log("environment", { buildMs, upMs, seedMs, seed: seed.out.split("\n").pop(), network });

  let outcome: unknown;
  try {
    // 3. slot clone of the frontend and the /context the agent reads
    const slot = join(HOME, "slots", runId, "afk-pilot-frontend");
    sh("git", ["clone", "-q", "--no-hardlinks", frontendBare, slot]);
    const ctx = join(HOME, "context", runId);
    mkdirSync(ctx, { recursive: true });
    cpSync(join(here, "ticket.md"), join(ctx, "ticket.md"));
    writeFileSync(join(ctx, "run.json"), JSON.stringify({
      stage: "integration",
      backend: { repo: "afk-pilot-backend", sha: backendSha, url: "http://backend:8080" },
      refs: [{ name: "afk-pilot-backend", sha: backendSha, path: "/refs/afk-pilot-backend" }],
      frontend: { sha: frontendSha },
    }, null, 2));

    // 4. the agent, on the compose network, with /context and /refs read-only
    const started = Date.now();
    const result = await run({
      agent: cursor(process.env.AFK_MODEL ?? "auto", { env: { CURSOR_API_KEY: process.env.CURSOR_API_KEY ?? "" } }),
      sandbox: docker({
        imageName: IMAGE,
        network,
        env: { BACKEND_URL: "http://backend:8080" },
        mounts: [
          { hostPath: ctx, sandboxPath: "/context", readonly: true },
          { hostPath: snap, sandboxPath: "/refs/afk-pilot-backend", readonly: true },
        ],
      }),
      cwd: slot,
      branchStrategy: { type: "branch", branch: `proto/integration-${runId}`, baseBranch: "main" },
      promptFile: join(here, "afk-integration.md"),
      output: Output.object({ tag: "result", schema: IntegrationResult }),
      idleTimeoutSeconds: 600,
      logging: { type: "file", path: join(HOME, "logs", `${runId}.log`), verbose: true },
    });
    outcome = { output: result.output, commits: result.commits.map((c) => c.sha), agentMs: Date.now() - started };
    log("agent", outcome);
  } catch (error) {
    outcome = { error: error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 600) : String(error) };
    log("agent FAILED", outcome);
  } finally {
    // 5. clean up: the sandbox is gone once run() returns, so compose down can remove the network
    const down = sh("docker", [...compose, "down", "-v"], { allowFail: true });
    sh("docker", ["rmi", "-f", `${project}-backend`], { allowFail: true });
    const leftNet = sh("docker", ["network", "ls", "--filter", `name=${project}`, "--format", "{{.Name}}"]).out;
    const leftBox = sh("docker", ["ps", "-a", "--filter", "name=sandcastle-", "--format", "{{.Names}} {{.Status}}"]).out;
    log("cleanup", { downExit: down.code, networksLeft: leftNet || "none", sandboxesLeft: leftBox || "none" });
  }
  log("done", { totalSeconds: Math.round((Date.now() - t0) / 1000) });
}

async function checks() {
  const box = (network: string, mounts: { hostPath: string; sandboxPath: string; readonly: boolean }[] = []) =>
    docker({ imageName: IMAGE, network, mounts });
  const dir = join(HOME, "checks");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  // a throwaway repo for createSandbox's worktree
  const repo = join(dir, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "README.md"), "check\n");
  git(repo, "add", ".");
  git(repo, "-c", "user.name=p", "-c", "user.email=p@p", "commit", "-q", "-m", "init");

  // 7. engine version (several --network flags need 25.0+)
  log("7 docker engine", sh("docker", ["version", "--format", "{{.Server.Version}}"]).out);

  // 1. a network that does not exist: does a Created container stay behind?
  const before = sh("docker", ["ps", "-a", "-q", "--filter", "name=sandcastle-"]).out.split("\n").filter(Boolean);
  try {
    const s = await createSandbox({ branch: "c1", sandbox: box("afk-no-such-net_default"), cwd: repo });
    await s.close();
    log("1 missing network", "UNEXPECTED: sandbox started");
  } catch (error) {
    const after = sh("docker", ["ps", "-a", "--filter", "name=sandcastle-", "--format", "{{.ID}} {{.Names}} {{.Status}}"]).out
      .split("\n").filter((l) => l && !before.some((id) => l.startsWith(id)));
    log("1 missing network", { error: String(error).slice(0, 200), leftBehind: after });
    for (const l of after) sh("docker", ["rm", "-f", l.split(" ")[0] ?? ""], { allowFail: true });
  }

  // 3. --filter network= substring match: afk-pc1_default vs afk-pc12_default
  sh("docker", ["network", "create", "afk-pc1_default"], { allowFail: true });
  sh("docker", ["network", "create", "afk-pc12_default"], { allowFail: true });
  const c12 = sh("docker", ["run", "-d", "--network", "afk-pc12_default", "node:22-bookworm-slim", "sleep", "60"]).out;
  const matched = sh("docker", ["ps", "-q", "--filter", "network=afk-pc1_default"]).out;
  log("3 network filter", { containerOnPc12: c12.slice(0, 12), matchedByPc1: matched || "none", substring: matched !== "" });
  sh("docker", ["rm", "-f", c12]);

  // 2 + 4 + 5. a sandbox on a compose network: reach the service and the internet; /refs read-only; compose down
  // while the sandbox is still attached
  const compose = ["compose", "-p", "afk-pc4", "-f", "-"];
  const composeYaml = "services:\n  web:\n    image: node:22-bookworm-slim\n    command: [\"node\", \"-e\", \"require('http').createServer((q,s)=>s.end('hi')).listen(8080)\"]\n";
  sh("docker", [...compose, "up", "-d"], { input: composeYaml });
  const refs = join(dir, "refs");
  mkdirSync(refs);
  writeFileSync(join(refs, "file.txt"), "read only\n");
  const s = await createSandbox({
    branch: "c4",
    sandbox: box("afk-pc4_default", [{ hostPath: refs, sandboxPath: "/refs/x", readonly: true }]),
    cwd: repo,
  });
  const ex = async (c: string) => {
    const r = await s.exec(c);
    return `${r.exitCode}: ${(r.stdout + r.stderr).trim().slice(0, 160)}`;
  };
  log("2 service by name", await ex("curl -s -m 5 http://web:8080"));
  log("2 public internet (cursor api)", await ex("curl -s -m 10 -o /dev/null -w '%{http_code}' https://api2.cursor.sh"));
  log("5 /refs write as agent", await ex("touch /refs/x/new 2>&1; echo > /refs/x/file.txt 2>&1; id -un"));
  log("5 /refs owner and sudo", await ex("ls -ld /refs /refs/x; command -v sudo || echo no-sudo"));
  log("5 /refs remount", await ex("mount -o remount,rw /refs/x 2>&1 | head -1"));
  const down = sh("docker", [...compose, "down"], { input: composeYaml, allowFail: true });
  const netLeft = sh("docker", ["network", "ls", "--filter", "name=afk-pc4_default", "--format", "{{.Name}}"]).out;
  log("4 compose down with sandbox attached", { exit: down.code, networkLeft: netLeft || "none", tail: down.out.split("\n").slice(-2) });
  await s.close();
  const down2 = sh("docker", [...compose, "down"], { input: composeYaml, allowFail: true });
  const netLeft2 = sh("docker", ["network", "ls", "--filter", "name=afk-pc4_default", "--format", "{{.Name}}"]).out;
  log("4 compose down again after sandbox closed", { exit: down2.code, networkLeft: netLeft2 || "none" });
  sh("docker", ["network", "rm", "afk-pc1_default", "afk-pc12_default", "afk-pc4_default"], { allowFail: true });

  // 6. git archive: timing on the real backend, export-ignore with and without the info/attributes override,
  //    and macOS tar (bsdtar) unpacking it
  const bare = join(HOME, "backend.git");
  const work = join(dir, "attr");
  sh("git", ["clone", "-q", bare, work]);
  writeFileSync(join(work, ".gitattributes"), "README.md export-ignore\n");
  git(work, "add", ".gitattributes");
  git(work, "-c", "user.name=p", "-c", "user.email=p@p", "commit", "-q", "-m", "export-ignore README");
  const sha = git(work, "rev-parse", "HEAD");
  const plain = join(dir, "plain");
  mkdirSync(plain);
  untar(execFileSync("git", ["-C", work, "archive", sha], { maxBuffer: 256 << 20 }), plain);
  writeFileSync(join(work, ".git", "info", "attributes"), "* -export-ignore -export-subst\n");
  const over = join(dir, "override");
  mkdirSync(over);
  const [buf, archiveMs] = timed(() => execFileSync("git", ["-C", work, "archive", sha], { maxBuffer: 256 << 20 }));
  const [, untarMs] = timed(() => untar(buf, over));
  log("6 git archive", {
    tarBytes: buf.length,
    archiveMs,
    untarMs,
    tar: sh("tar", ["--version"]).out.split("\n")[0],
    readmeWithoutOverride: existsSync(join(plain, "README.md")),
    readmeWithOverride: existsSync(join(over, "README.md")),
  });
  rmSync(dir, { recursive: true, force: true });
}

const [mode, flag] = process.argv.slice(2);
if (mode === "run") await integrationRun(flag === "--bug");
else if (mode === "checks") await checks();
else console.log("usage: node proto.ts run [--bug] | checks");
