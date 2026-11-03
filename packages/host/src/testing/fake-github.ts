import { createHash, createVerify } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

// A stand-in for the parts of GitHub's API the adapter uses, with a real check of the App's JWT (RS256 against
// the public key) and of the bearer token on every repository call, so a wrong header or an expired token fails
// the way it would for real. Conditional requests work (ETag / If-None-Match) and are counted.

interface FakePull {
  number: number;
  head: string;
  base: string;
  title: string;
  body: string;
  draft: boolean;
  state: "open" | "closed";
  merged: boolean;
  sha: string;
}

export interface FakeReview {
  user: string;
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED";
}

export interface FakeCheck {
  status: "queued" | "in_progress" | "completed";
  conclusion: "success" | "failure" | "neutral" | "skipped" | null;
}

export interface TokenIssued {
  repositories: string[];
  permissions: Record<string, string>;
  token: string;
}

export class FakeGitHub {
  readonly tokensIssued: TokenIssued[] = [];
  readonly requests: string[] = [];
  notModified = 0;
  tokenLifetimeMs = 60 * 60 * 1000;
  refuseReady: "status" | "error" | false = false; // how a mark-ready is refused: HTTP 403, or a GraphQL error
  refuseBranchDeletes = false; // answer 403 to a branch delete, as a token without contents:write would get
  // The App's installation: false when the App is installed nowhere for this owner; the repositories it was given
  // (any, unless a test names them) and the permissions it was granted.
  installed = true;
  installedRepos: string[] | undefined;
  installationPermissions: Record<string, string> = {
    contents: "write",
    pull_requests: "write",
    checks: "read",
    statuses: "read",
    metadata: "read",
  };
  now: () => number = () => Date.now();
  private readonly pulls: FakePull[] = [];
  private readonly branchNames = new Set<string>();
  private readonly protectedBranches = new Set<string>();
  private readonly reviews = new Map<number, FakeReview[]>();
  private readonly checks = new Map<string, FakeCheck[]>();
  private readonly statuses = new Map<string, string>();
  private readonly live = new Map<string, number>(); // token -> expiry
  private server: Server | undefined;
  url = "";

  private readonly options: {
    appId: string;
    installationId: string;
    publicKey: string;
    owner: string;
    repo: string;
  };

  constructor(options: {
    appId: string;
    installationId: string;
    publicKey: string;
    owner: string;
    repo: string;
  }) {
    this.options = options;
  }

  async start(): Promise<void> {
    const server = createServer((req, res) => void this.handle(req, res));
    this.server = server;
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    this.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) =>
      this.server ? this.server.close(() => resolve()) : resolve(),
    );
  }

  // --- what a test does to "GitHub"
  mergePull(number: number): void {
    const pull = this.pull(number);
    pull.merged = true;
    pull.state = "closed";
  }
  closePull(number: number): void {
    this.pull(number).state = "closed";
  }
  reopenPull(number: number): void {
    this.pull(number).state = "open";
  }
  pushCommit(number: number, sha: string): void {
    this.pull(number).sha = sha;
  }
  addReview(number: number, review: FakeReview): void {
    this.reviews.set(number, [...(this.reviews.get(number) ?? []), review]);
  }
  setChecks(sha: string, checks: FakeCheck[]): void {
    this.checks.set(sha, checks);
  }
  setStatus(sha: string, state: "success" | "failure" | "pending"): void {
    this.statuses.set(sha, state);
  }
  addBranch(name: string): void {
    this.branchNames.add(name);
  }
  protectBranch(name: string): void {
    this.protectedBranches.add(name);
  }
  branches(): string[] {
    return [...this.branchNames].sort();
  }
  pullRequests(): readonly FakePull[] {
    return this.pulls;
  }
  expireTokens(): void {
    this.live.clear();
  }

  private pull(number: number): FakePull {
    const found = this.pulls.find((p) => p.number === number);
    if (!found) throw new Error(`no pull request ${number}`);
    return found;
  }

  private json(
    res: import("node:http").ServerResponse,
    status: number,
    body: unknown,
    etag = false,
  ) {
    const text = JSON.stringify(body);
    res.writeHead(status, {
      "content-type": "application/json",
      ...(etag
        ? { etag: `"${createHash("sha1").update(text).digest("hex")}"` }
        : {}),
    });
    res.end(text);
  }

  private verifyJwt(header: string | undefined): boolean {
    const token = header?.replace(/^Bearer /, "");
    const [head, payload, signature] = token?.split(".") ?? [];
    if (!head || !payload || !signature) return false;
    const valid = createVerify("RSA-SHA256")
      .update(`${head}.${payload}`)
      .verify(this.options.publicKey, Buffer.from(signature, "base64url"));
    if (!valid) return false;
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString()) as {
      iss: string;
      exp: number;
    };
    return claims.iss === this.options.appId && claims.exp * 1000 > this.now();
  }

  private async handle(
    req: IncomingMessage,
    res: import("node:http").ServerResponse,
  ) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString();
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const url = new URL(req.url ?? "/", this.url);
    const path = url.pathname;
    this.requests.push(`${req.method} ${path}${url.search}`);

    const exchange = new RegExp(
      `^/app/installations/${this.options.installationId}/access_tokens$`,
    );
    const installation = new RegExp(
      `^/app/installations/${this.options.installationId}$`,
    );
    if (req.method === "GET" && (path === "/app" || installation.test(path))) {
      if (!this.verifyJwt(req.headers.authorization))
        return this.json(res, 401, { message: "bad JWT" });
      if (path === "/app")
        return this.json(res, 200, {
          slug: "afk-bot",
          html_url: "https://github.com/apps/afk-bot",
        });
      if (!this.installed) return this.json(res, 404, { message: "Not Found" });
      return this.json(res, 200, {
        id: Number(this.options.installationId),
        permissions: this.installationPermissions,
        html_url: `https://github.com/settings/installations/${this.options.installationId}`,
      });
    }
    if (req.method === "POST" && exchange.test(path)) {
      if (!this.verifyJwt(req.headers.authorization))
        return this.json(res, 401, { message: "bad JWT" });
      if (!this.installed) return this.json(res, 404, { message: "Not Found" });
      const given = this.installedRepos;
      if (
        given &&
        ((body.repositories as string[] | undefined) ?? []).some(
          (name) => !given.includes(name),
        )
      )
        return this.json(res, 422, {
          message:
            "There is at least one repository that does not exist or is not accessible to the parent installation.",
        });
      const token = `ghs_${this.tokensIssued.length + 1}`;
      this.live.set(token, this.now() + this.tokenLifetimeMs);
      this.tokensIssued.push({
        repositories: body.repositories as string[],
        permissions: body.permissions as Record<string, string>,
        token,
      });
      return this.json(res, 201, {
        token,
        expires_at: new Date(this.now() + this.tokenLifetimeMs).toISOString(),
      });
    }

    const bearer = req.headers.authorization?.replace(/^(Bearer|token) /, "");
    const expiry = bearer ? this.live.get(bearer) : undefined;
    if (!expiry || expiry <= this.now())
      return this.json(res, 401, { message: "Bad credentials" });

    if (req.method === "POST" && path === "/graphql") {
      const query = String(body.query ?? "");
      const id = (body.variables as { id?: string } | undefined)?.id;
      const pull = this.pulls.find((p) => `PR_${p.number}` === id);
      if (!query.includes("markPullRequestReadyForReview") || !pull)
        return this.json(res, 200, {
          errors: [{ message: "Could not resolve" }],
        });
      if (this.refuseReady === "status")
        return this.json(res, 403, {
          message: "Resource not accessible by integration",
        });
      if (this.refuseReady === "error")
        return this.json(res, 200, {
          errors: [{ message: "Resource not accessible by integration" }],
        });
      pull.draft = false;
      return this.json(res, 200, {
        data: {
          markPullRequestReadyForReview: { pullRequest: { isDraft: false } },
        },
      });
    }

    const base = `/repos/${this.options.owner}/${this.options.repo}`;
    if (!path.startsWith(`${base}/`))
      return this.json(res, 404, { message: "Not Found" });
    const rest = path.slice(base.length);

    if (req.method === "POST" && rest === "/pulls") {
      if (this.pulls.some((p) => p.head === body.head && p.state === "open"))
        return this.json(res, 422, {
          message: "Validation Failed",
          errors: [
            {
              message: `A pull request already exists for ${this.options.owner}:${String(body.head)}.`,
            },
          ],
        });
      const pull: FakePull = {
        number: this.pulls.length + 1,
        head: String(body.head),
        base: String(body.base),
        title: String(body.title),
        body: String(body.body ?? ""),
        draft: body.draft === true,
        state: "open",
        merged: false,
        sha: createHash("sha1").update(String(body.head)).digest("hex"),
      };
      this.pulls.push(pull);
      return this.json(res, 201, this.render(pull));
    }
    if (req.method === "GET" && rest === "/pulls") {
      const head = url.searchParams.get("head")?.split(":")[1];
      return this.json(
        res,
        200,
        this.pulls.filter((p) => p.head === head).map((p) => this.render(p)),
      );
    }
    const one = /^\/pulls\/(\d+)$/.exec(rest);
    if (req.method === "GET" && one) {
      const pull = this.pulls.find((p) => p.number === Number(one[1]));
      if (!pull) return this.json(res, 404, { message: "Not Found" });
      return this.conditional(req, res, this.render(pull));
    }
    if (req.method === "PATCH" && one) {
      const pull = this.pulls.find((p) => p.number === Number(one[1]));
      if (!pull) return this.json(res, 404, { message: "Not Found" });
      if (body.state === "closed" && !pull.merged) pull.state = "closed";
      if (typeof body.body === "string") pull.body = body.body;
      return this.json(res, 200, this.render(pull));
    }
    const ref = /^\/git\/refs\/heads\/(.+)$/.exec(rest);
    if (req.method === "DELETE" && ref) {
      if (this.refuseBranchDeletes)
        return this.json(res, 403, { message: "Resource not accessible" });
      const branch = decodeURIComponent(ref[1] as string);
      if (this.protectedBranches.has(branch))
        return this.json(res, 422, {
          message: "Cannot delete a protected branch",
        });
      if (!this.branchNames.delete(branch))
        return this.json(res, 422, { message: "Reference does not exist" });
      res.writeHead(204);
      return res.end();
    }
    const reviews = /^\/pulls\/(\d+)\/reviews$/.exec(rest);
    if (req.method === "GET" && reviews)
      return this.conditional(
        req,
        res,
        this.page(
          url,
          (this.reviews.get(Number(reviews[1])) ?? []).map((r) => ({
            user: { login: r.user },
            state: r.state,
          })),
        ),
      );
    const checkRuns = /^\/commits\/([0-9a-f]+)\/check-runs$/.exec(rest);
    if (req.method === "GET" && checkRuns) {
      const all = (this.checks.get(checkRuns[1] as string) ?? []).map((c) => ({
        status: c.status,
        conclusion: c.conclusion,
      }));
      return this.conditional(req, res, {
        total_count: all.length,
        check_runs: this.page(url, all),
      });
    }
    const status = /^\/commits\/([0-9a-f]+)\/status$/.exec(rest);
    if (req.method === "GET" && status) {
      const state = this.statuses.get(status[1] as string);
      return this.conditional(req, res, {
        state: state ?? "pending",
        total_count: state ? 1 : 0,
      });
    }
    return this.json(res, 404, { message: "Not Found" });
  }

  // One page of a list, the way GitHub cuts it: 30 to a page unless per_page says otherwise, at most 100.
  private page<T>(url: URL, all: T[]): T[] {
    const perPage = Math.min(
      Number(url.searchParams.get("per_page") ?? 30) || 30,
      100,
    );
    const page = Math.max(Number(url.searchParams.get("page") ?? 1) || 1, 1);
    return all.slice((page - 1) * perPage, page * perPage);
  }

  private conditional(
    req: IncomingMessage,
    res: import("node:http").ServerResponse,
    body: unknown,
  ) {
    const etag = `"${createHash("sha1").update(JSON.stringify(body)).digest("hex")}"`;
    if (req.headers["if-none-match"] === etag) {
      this.notModified += 1;
      res.writeHead(304, { etag });
      return res.end();
    }
    return this.json(res, 200, body, true);
  }

  private render(pull: FakePull) {
    return {
      number: pull.number,
      node_id: `PR_${pull.number}`,
      html_url: `https://github.example/${this.options.owner}/${this.options.repo}/pull/${pull.number}`,
      state: pull.state,
      draft: pull.draft,
      merged: pull.merged,
      head: { sha: pull.sha, ref: pull.head },
      base: { ref: pull.base },
      title: pull.title,
      body: pull.body,
    };
  }
}
