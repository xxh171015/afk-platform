import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type Io, run } from "./index.ts";
import { resolveSpecRef } from "./spec-refs.ts";

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "a@b.c",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "a@b.c",
    },
  });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${result.stderr || result.stdout}`,
    );
  }
  return (result.stdout ?? "").trim();
}

function bareAndClone(): { root: string; bare: string; clone: string } {
  const root = mkdtempSync(join(tmpdir(), "afk-spec-ref-"));
  const bare = join(root, "origin.git");
  const clone = join(root, "payments");
  git(root, ["init", "--bare", "-b", "main", "origin.git"]);
  git(root, ["clone", bare, clone]);
  writeFileSync(join(clone, "README.md"), "x\n");
  git(clone, ["add", "README.md"]);
  git(clone, ["commit", "-m", "init"]);
  git(clone, ["push", "origin", "HEAD:main"]);
  git(clone, ["remote", "set-head", "origin", "main"]);
  return { root, bare, clone };
}

function captureBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      resolve(raw === "" ? undefined : JSON.parse(raw));
    });
  });
}

function ioOf(over: Partial<Io> = {}): Io & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    env: { HOME: "/nonexistent-home" },
    readFile: async () => {
      throw new Error("ENOENT");
    },
    readDirectory: async () => [],
    ...over,
  };
}

describe("plat spec create --ref a local directory", () => {
  const temps: string[] = [];
  let server: Server | undefined;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((done) => server?.close(() => done()));
      server = undefined;
    }
    for (const dir of temps.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sends that directory's origin address and default branch, and warns about unpushed commits", async () => {
    const { root, clone } = bareAndClone();
    temps.push(root);
    writeFileSync(join(clone, "local.txt"), "ahead\n");
    git(clone, ["add", "local.txt"]);
    git(clone, ["commit", "-m", "unpushed"]);
    const originUrl = git(clone, ["remote", "get-url", "origin"]);

    const posted: unknown[] = [];
    server = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      void (async () => {
        const body = await captureBody(req);
        if (req.method === "POST" && req.url === "/specs") {
          posted.push(body);
          res.statusCode = 201;
          res.end(JSON.stringify({ id: 7, displayId: "S-7" }));
          return;
        }
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "no" }));
      })();
    });
    await new Promise<void>((done) => server?.listen(0, "127.0.0.1", done));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const machine = ioOf({ cwd: clone });
    const code = await run(
      [
        "--api-url",
        url,
        "spec",
        "create",
        "--project",
        "3",
        "--type",
        "feature",
        "--title",
        "Export",
        "--slug",
        "export",
        "--ref",
        clone,
      ],
      machine,
    );

    expect(code).toBe(0);
    expect(posted).toEqual([
      expect.objectContaining({
        projectId: 3,
        refs: [{ url: originUrl, defaultBranch: "main" }],
      }),
    ]);
    expect(machine.err.join("")).toContain("the agent will see origin");
    expect(machine.err.join("")).toContain(
      "1 commit(s) ahead of origin/main (unpushed local commits)",
    );
  });
});

function specView(over: Record<string, unknown> = {}) {
  return {
    spec: {
      id: 7,
      projectId: 3,
      displayId: "S-7",
      planning: { repo: null, state: null, sha: null, conflict: [] },
      prechecks: [],
      refs: [],
      ...over,
    },
    tickets: [],
    finalizations: [],
    edges: [],
  };
}

describe("plat spec confirm refPins", () => {
  const temps: string[] = [];
  let server: Server | undefined;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((done) => server?.close(() => done()));
      server = undefined;
    }
    for (const dir of temps.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sends git ls-remote SHAs as refPins", async () => {
    const { root, bare } = bareAndClone();
    temps.push(root);
    const sha = git(bare, ["rev-parse", "HEAD"]);
    const confirmed: unknown[] = [];
    server = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      void (async () => {
        const body = await captureBody(req);
        if (req.method === "GET" && req.url === "/specs/7") {
          res.statusCode = 200;
          res.end(
            JSON.stringify(
              specView({
                refs: [
                  {
                    repoId: 9,
                    name: "payments",
                    url: bare,
                    reference: true,
                    sha: null,
                  },
                ],
              }),
            ),
          );
          return;
        }
        if (req.method === "GET" && req.url === "/projects/3") {
          res.statusCode = 200;
          res.end(
            JSON.stringify({
              id: 3,
              name: "shop",
              repos: [
                {
                  name: "payments",
                  url: bare,
                  defaultBranch: "main",
                  contractPath: null,
                  hostKind: "github",
                },
              ],
            }),
          );
          return;
        }
        if (req.method === "POST" && req.url === "/specs/7/confirm") {
          confirmed.push(body);
          res.statusCode = 200;
          res.end(
            JSON.stringify({
              state: "running",
              integrationBranches: [],
              enqueued: [],
            }),
          );
          return;
        }
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "no" }));
      })();
    });
    await new Promise<void>((done) => server?.listen(0, "127.0.0.1", done));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const machine = ioOf();
    const code = await run(
      ["--api-url", url, "spec", "confirm", "S-7"],
      machine,
    );
    expect(code).toBe(0);
    expect(confirmed).toEqual([
      expect.objectContaining({
        refPins: [{ repoId: 9, sha }],
      }),
    ]);
  });

  it("pins through the origin of a sibling checkout when the registered address cannot be read", async () => {
    const { root, bare } = bareAndClone();
    temps.push(root);
    const sha = git(bare, ["rev-parse", "HEAD"]);
    // The planning repo, and next to it a checkout of the reference repo whose origin is an ssh address that only
    // this checkout can reach (insteadOf stands in for the person's ssh key).
    const planning = join(root, "planning");
    git(root, ["init", "-b", "main", "planning"]);
    const sibling = join(root, "web-ui");
    git(root, ["clone", bare, sibling]);
    const sshOrigin = "git@example.invalid:team/web-ui.git";
    git(sibling, ["remote", "set-url", "origin", sshOrigin]);
    git(sibling, ["config", `url.${bare}.insteadOf`, sshOrigin]);
    const registered = "https://example.invalid/team/web-ui.git";
    const confirmed: unknown[] = [];
    server = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      void (async () => {
        const body = await captureBody(req);
        if (req.method === "GET" && req.url === "/specs/7") {
          res.statusCode = 200;
          res.end(
            JSON.stringify(
              specView({
                refs: [
                  {
                    repoId: 9,
                    name: "web-ui",
                    url: registered,
                    reference: true,
                    sha: null,
                  },
                ],
              }),
            ),
          );
          return;
        }
        if (req.method === "GET" && req.url === "/projects/3") {
          res.statusCode = 200;
          res.end(
            JSON.stringify({
              id: 3,
              name: "shop",
              repos: [
                {
                  name: "web-ui",
                  url: registered,
                  defaultBranch: "main",
                  contractPath: null,
                  hostKind: "gitlab",
                },
              ],
            }),
          );
          return;
        }
        if (req.method === "POST" && req.url === "/specs/7/confirm") {
          confirmed.push(body);
          res.statusCode = 200;
          res.end(
            JSON.stringify({
              state: "running",
              integrationBranches: [],
              enqueued: [],
            }),
          );
          return;
        }
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "no" }));
      })();
    });
    await new Promise<void>((done) => server?.listen(0, "127.0.0.1", done));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const machine = ioOf({ cwd: planning });
    const code = await run(
      ["--api-url", url, "spec", "confirm", "S-7"],
      machine,
    );
    expect(machine.err.join("")).toContain(
      "这个需求没有规划仓库，没有带任何本地改动；要带上，在规划仓库的 checkout 里运行 plat spec confirm",
    );
    expect(code).toBe(0);
    expect(confirmed).toEqual([
      expect.objectContaining({
        refPins: [{ repoId: 9, sha }],
      }),
    ]);
  });

  it("fails and names the reference repo when git ls-remote cannot read it", async () => {
    server = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      void (async () => {
        await captureBody(req);
        if (req.method === "GET" && req.url === "/specs/7") {
          res.statusCode = 200;
          res.end(
            JSON.stringify(
              specView({
                refs: [
                  {
                    repoId: 9,
                    name: "payments",
                    url: "/no-such-origin.git",
                    reference: true,
                    sha: null,
                  },
                ],
              }),
            ),
          );
          return;
        }
        if (req.method === "GET" && req.url === "/projects/3") {
          res.statusCode = 200;
          res.end(
            JSON.stringify({
              id: 3,
              name: "shop",
              repos: [
                {
                  name: "payments",
                  url: "/no-such-origin.git",
                  defaultBranch: "main",
                  contractPath: null,
                  hostKind: "github",
                },
              ],
            }),
          );
          return;
        }
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "no" }));
      })();
    });
    await new Promise<void>((done) => server?.listen(0, "127.0.0.1", done));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const machine = ioOf();
    const code = await run(
      ["--api-url", url, "spec", "confirm", "S-7"],
      machine,
    );
    expect(code).toBe(1);
    expect(machine.err.join("")).toMatch(/payments/);
  });
});

describe("plat spec edit", () => {
  const temps: string[] = [];
  let server: Server | undefined;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((done) => server?.close(() => done()));
      server = undefined;
    }
    for (const dir of temps.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("adds a reference repo with --ref", async () => {
    const { root, clone } = bareAndClone();
    temps.push(root);
    const originUrl = git(clone, ["remote", "get-url", "origin"]);
    const edited: unknown[] = [];
    server = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      void (async () => {
        const body = await captureBody(req);
        if (req.method === "GET" && req.url === "/specs/7") {
          res.statusCode = 200;
          res.end(
            JSON.stringify(
              specView({
                state: "draft",
                refs: [],
              }),
            ),
          );
          return;
        }
        if (req.method === "GET" && req.url === "/projects/3") {
          res.statusCode = 200;
          res.end(
            JSON.stringify({
              id: 3,
              name: "shop",
              repos: [
                {
                  name: "backend",
                  url: "https://github.com/acme/backend.git",
                  defaultBranch: "main",
                  contractPath: null,
                  hostKind: "github",
                },
              ],
            }),
          );
          return;
        }
        if (req.method === "PUT" && req.url === "/specs/7/refs") {
          edited.push(body);
          res.statusCode = 200;
          res.end(
            JSON.stringify({
              refs: [
                {
                  repoId: 9,
                  name: "payments",
                  url: originUrl,
                  reference: true,
                  sha: null,
                },
              ],
            }),
          );
          return;
        }
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "no" }));
      })();
    });
    await new Promise<void>((done) => server?.listen(0, "127.0.0.1", done));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const machine = ioOf({ cwd: clone });
    const code = await run(
      ["--api-url", url, "spec", "edit", "S-7", "--ref", clone],
      machine,
    );
    expect(code).toBe(0);
    expect(edited).toEqual([
      { add: [{ url: originUrl, defaultBranch: "main" }] },
    ]);
  });

  it("removes a reference repo with --remove-ref", async () => {
    const edited: unknown[] = [];
    server = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      void (async () => {
        const body = await captureBody(req);
        if (req.method === "GET" && req.url === "/specs/7") {
          res.statusCode = 200;
          res.end(
            JSON.stringify(
              specView({
                state: "draft",
                refs: [
                  {
                    repoId: 9,
                    name: "payments",
                    url: "https://github.com/acme/payments.git",
                    reference: true,
                    sha: null,
                  },
                ],
              }),
            ),
          );
          return;
        }
        if (req.method === "GET" && req.url === "/projects/3") {
          res.statusCode = 200;
          res.end(
            JSON.stringify({
              id: 3,
              name: "shop",
              repos: [],
            }),
          );
          return;
        }
        if (req.method === "PUT" && req.url === "/specs/7/refs") {
          edited.push(body);
          res.statusCode = 200;
          res.end(JSON.stringify({ refs: [] }));
          return;
        }
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "no" }));
      })();
    });
    await new Promise<void>((done) => server?.listen(0, "127.0.0.1", done));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const machine = ioOf();
    const code = await run(
      ["--api-url", url, "spec", "edit", "S-7", "--remove-ref", "payments"],
      machine,
    );
    expect(code).toBe(0);
    expect(edited).toEqual([{ remove: [{ repoId: 9 }] }]);
  });

  it("refreshes a reference repo SHA with --refresh", async () => {
    const { root, bare } = bareAndClone();
    temps.push(root);
    const sha = git(bare, ["rev-parse", "HEAD"]);
    const edited: unknown[] = [];
    server = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      void (async () => {
        const body = await captureBody(req);
        if (req.method === "GET" && req.url === "/specs/7") {
          res.statusCode = 200;
          res.end(
            JSON.stringify(
              specView({
                state: "running",
                refs: [
                  {
                    repoId: 9,
                    name: "payments",
                    url: bare,
                    reference: true,
                    sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                  },
                ],
              }),
            ),
          );
          return;
        }
        if (req.method === "GET" && req.url === "/projects/3") {
          res.statusCode = 200;
          res.end(
            JSON.stringify({
              id: 3,
              name: "shop",
              repos: [
                {
                  name: "payments",
                  url: bare,
                  defaultBranch: "main",
                  contractPath: null,
                  hostKind: "github",
                },
              ],
            }),
          );
          return;
        }
        if (req.method === "PUT" && req.url === "/specs/7/refs") {
          edited.push(body);
          res.statusCode = 200;
          res.end(
            JSON.stringify({
              refs: [
                {
                  repoId: 9,
                  name: "payments",
                  url: bare,
                  reference: true,
                  sha,
                },
              ],
            }),
          );
          return;
        }
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "no" }));
      })();
    });
    await new Promise<void>((done) => server?.listen(0, "127.0.0.1", done));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const machine = ioOf();
    const code = await run(
      ["--api-url", url, "spec", "edit", "S-7", "--refresh", "payments"],
      machine,
    );
    expect(code).toBe(0);
    expect(edited).toEqual([{ refresh: [{ repoId: 9, sha }] }]);
  });
});

describe("plat spec create and show with no reference repos", () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((done) => server?.close(() => done()));
      server = undefined;
    }
  });

  it("prints 参考仓库：无 after create and on show", async () => {
    server = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      void (async () => {
        await captureBody(req);
        if (req.method === "POST" && req.url === "/specs") {
          res.statusCode = 201;
          res.end(JSON.stringify({ id: 7, displayId: "S-7" }));
          return;
        }
        if (req.method === "GET" && req.url === "/specs/7") {
          res.statusCode = 200;
          res.end(
            JSON.stringify(
              specView({
                title: "Export",
                state: "draft",
                body: "",
                warnings: [],
                refs: [],
              }),
            ),
          );
          return;
        }
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "no" }));
      })();
    });
    await new Promise<void>((done) => server?.listen(0, "127.0.0.1", done));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const created = ioOf();
    expect(
      await run(
        [
          "--api-url",
          url,
          "spec",
          "create",
          "--project",
          "3",
          "--type",
          "feature",
          "--title",
          "Export",
          "--slug",
          "export",
        ],
        created,
      ),
    ).toBe(0);
    expect(created.out.join("")).toContain("参考仓库：无");
    const shown = ioOf();
    expect(await run(["--api-url", url, "spec", "show", "S-7"], shown)).toBe(0);
    expect(shown.out.join("")).toContain("参考仓库：无");
  });
});

describe("plat spec create missing-ref reminder", () => {
  const temps: string[] = [];
  let server: Server | undefined;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((done) => server?.close(() => done()));
      server = undefined;
    }
    for (const dir of temps.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reminds about a registered repo name and a sibling checkout in backticks, not a bare word, and still exits 0", async () => {
    const { root, clone } = bareAndClone();
    temps.push(root);
    const sibling = join(root, "ledger");
    git(root, ["clone", git(clone, ["remote", "get-url", "origin"]), sibling]);
    const specFile = join(clone, "spec.md");
    writeFileSync(
      specFile,
      [
        "# Export",
        "",
        "Follow `payments` and `ledger`. The word secret is also a repo.",
        "",
      ].join("\n"),
    );
    server = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      void (async () => {
        await captureBody(req);
        if (req.method === "POST" && req.url === "/specs") {
          res.statusCode = 201;
          res.end(JSON.stringify({ id: 7, displayId: "S-7" }));
          return;
        }
        if (req.method === "GET" && req.url === "/specs/7") {
          res.statusCode = 200;
          res.end(JSON.stringify(specView({ refs: [] })));
          return;
        }
        if (req.method === "GET" && req.url === "/repos") {
          res.statusCode = 200;
          res.end(
            JSON.stringify({
              repos: [
                {
                  projectId: 1,
                  name: "payments",
                  url: "https://github.com/acme/payments.git",
                  reference: true,
                },
                {
                  projectId: 1,
                  name: "secret",
                  url: "https://github.com/acme/secret.git",
                  reference: false,
                },
              ],
            }),
          );
          return;
        }
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "no" }));
      })();
    });
    await new Promise<void>((done) => server?.listen(0, "127.0.0.1", done));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const { readFile } = await import("node:fs/promises");
    const machine = ioOf({
      cwd: clone,
      readFile: (path) => readFile(path, "utf8"),
    });
    const code = await run(
      [
        "--api-url",
        url,
        "spec",
        "create",
        "--project",
        "3",
        "--type",
        "feature",
        "--title",
        "Export",
        "--slug",
        "export",
        "--file",
        specFile,
      ],
      machine,
    );
    expect(code).toBe(0);
    const err = machine.err.join("");
    expect(err).toContain("plat spec edit S-7 --ref payments");
    expect(err).toContain(`plat spec edit S-7 --ref ${realpathSync(sibling)}`);
    expect(err).not.toMatch(/--ref secret/);
  });
});

describe("plat tracker-doc with a reference repo", () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((done) => server?.close(() => done()));
      server = undefined;
    }
  });

  it("does not print integration or contract sections for one ticket repo plus a reference repo", async () => {
    server = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      void (async () => {
        await captureBody(req);
        if (req.method === "GET" && req.url === "/projects/3") {
          res.statusCode = 200;
          res.end(
            JSON.stringify({
              id: 3,
              name: "shop",
              repos: [
                {
                  name: "backend",
                  url: "https://github.com/acme/backend.git",
                  defaultBranch: "main",
                  contractPath: null,
                  hostKind: "github",
                },
                {
                  name: "payments",
                  url: "https://github.com/acme/payments.git",
                  defaultBranch: "main",
                  contractPath: "openapi.json",
                  hostKind: "github",
                },
              ],
            }),
          );
          return;
        }
        if (req.method === "GET" && req.url === "/repos") {
          res.statusCode = 200;
          res.end(
            JSON.stringify({
              repos: [
                {
                  projectId: 3,
                  name: "backend",
                  url: "https://github.com/acme/backend.git",
                  reference: false,
                },
                {
                  projectId: 3,
                  name: "payments",
                  url: "https://github.com/acme/payments.git",
                  reference: true,
                },
              ],
            }),
          );
          return;
        }
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "no" }));
      })();
    });
    await new Promise<void>((done) => server?.listen(0, "127.0.0.1", done));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const machine = ioOf();
    const code = await run(
      ["--api-url", url, "tracker-doc", "--project", "3", "--repo", "backend"],
      machine,
    );
    expect(code).toBe(0);
    const doc = machine.out.join("");
    expect(doc).not.toContain("Integration tickets");
    expect(doc).not.toContain("Several repos");
    expect(doc).toMatch(/reference repo/i);
  });
});

describe("--ref a local directory that is not at origin's default branch", () => {
  const temps: string[] = [];

  afterEach(() => {
    for (const dir of temps.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function pushFromSecondClone(root: string, bare: string, file: string) {
    const other = join(root, `other-${file}`);
    git(root, ["clone", bare, other]);
    writeFileSync(join(other, file), "origin\n");
    git(other, ["add", file]);
    git(other, ["commit", "-m", `origin ${file}`]);
    git(other, ["push", "origin", "HEAD:main"]);
  }

  it("says a checkout behind origin is older than origin, not that it has unpushed commits", () => {
    const { root, bare, clone } = bareAndClone();
    temps.push(root);
    pushFromSecondClone(root, bare, "a.txt");
    pushFromSecondClone(root, bare, "b.txt");
    git(clone, ["fetch", "origin"]);

    const resolved = resolveSpecRef(clone, root, []);

    expect(resolved.originMismatchWarning).toContain(
      "2 commit(s) behind origin/main (this checkout is older than origin)",
    );
    expect(resolved.originMismatchWarning).not.toContain("unpushed");
  });

  it("says a checkout with local commits and newer origin commits has diverged", () => {
    const { root, bare, clone } = bareAndClone();
    temps.push(root);
    pushFromSecondClone(root, bare, "a.txt");
    git(clone, ["fetch", "origin"]);
    writeFileSync(join(clone, "local.txt"), "local\n");
    git(clone, ["add", "local.txt"]);
    git(clone, ["commit", "-m", "local"]);

    const resolved = resolveSpecRef(clone, root, []);

    expect(resolved.originMismatchWarning).toContain(
      "diverged from origin/main (1 local, 1 on origin",
    );
  });

  it("gives no warning when HEAD is origin's default branch", () => {
    const { root, clone } = bareAndClone();
    temps.push(root);

    expect(
      resolveSpecRef(clone, root, []).originMismatchWarning,
    ).toBeUndefined();
  });
});
