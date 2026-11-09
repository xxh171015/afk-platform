import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

// A stand-in for the GitLab CE REST calls the adapter uses (17.3.1: create returns 201, a second
// create for the same source branch is 409 in Chinese, close is state_event, a missing branch is 404).

interface FakeMr {
  iid: number;
  source: string;
  target: string;
  title: string;
  description: string;
  state: "opened" | "closed" | "merged";
  sha: string;
}

export class FakeGitLab {
  readonly requests: string[] = [];
  refuseBranchDeletes = false;
  private readonly mrs: FakeMr[] = [];
  private readonly branchNames = new Set<string>();
  private readonly protectedBranches = new Set<string>();
  private server: Server | undefined;
  url = "";
  private readonly options: { owner: string; repo: string; token: string };

  constructor(options: { owner: string; repo: string; token: string }) {
    this.options = options;
  }

  projectPath(): string {
    return encodeURIComponent(`${this.options.owner}/${this.options.repo}`);
  }

  async start(): Promise<void> {
    const server = createServer((req, res) => void this.handle(req, res));
    this.server = server;
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    this.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v4`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) =>
      this.server ? this.server.close(() => resolve()) : resolve(),
    );
  }

  mergeRequests(): readonly FakeMr[] {
    return this.mrs;
  }

  branches(): string[] {
    return [...this.branchNames].sort();
  }

  addBranch(name: string): void {
    this.branchNames.add(name);
  }

  protectBranch(name: string): void {
    this.protectedBranches.add(name);
  }

  mergeMr(iid: number): void {
    this.mr(iid).state = "merged";
  }

  closeMr(iid: number): void {
    this.mr(iid).state = "closed";
  }

  private mr(iid: number): FakeMr {
    const found = this.mrs.find((m) => m.iid === iid);
    if (!found) throw new Error(`no merge request ${iid}`);
    return found;
  }

  private draft(title: string): boolean {
    return /^draft:/i.test(title.trim());
  }

  private render(mr: FakeMr) {
    const draft = this.draft(mr.title);
    return {
      iid: mr.iid,
      web_url: `https://gitlab.example/${this.options.owner}/${this.options.repo}/-/merge_requests/${mr.iid}`,
      state: mr.state,
      draft,
      work_in_progress: draft,
      title: mr.title,
      description: mr.description,
      sha: mr.sha,
      source_branch: mr.source,
      target_branch: mr.target,
      merged_by: null,
      merge_user: null,
      head_pipeline: null,
      reviewers: [],
    };
  }

  private json(
    res: import("node:http").ServerResponse,
    status: number,
    body: unknown,
  ) {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  }

  private async handle(
    req: IncomingMessage,
    res: import("node:http").ServerResponse,
  ) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString();
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    this.requests.push(`${req.method} ${req.url}`);

    if (req.headers["private-token"] !== this.options.token)
      return this.json(res, 401, { message: "401 Unauthorized" });

    const url = new URL(req.url ?? "/", "http://gitlab.example");
    const prefix = `/api/v4/projects/${this.projectPath()}`;
    if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`))
      return this.json(res, 404, { message: "404 Project Not Found" });
    const rest = url.pathname.slice(prefix.length);

    if (req.method === "POST" && rest === "/merge_requests") {
      const source = String(body.source_branch ?? "");
      const open = this.mrs.find(
        (m) => m.source === source && m.state === "opened",
      );
      if (open)
        return this.json(res, 409, {
          message: [`此源分支已存在另一个开放的合并请求：!${open.iid}`],
        });
      const mr: FakeMr = {
        iid: this.mrs.length + 1,
        source,
        target: String(body.target_branch ?? ""),
        title: String(body.title ?? ""),
        description: String(body.description ?? ""),
        state: "opened",
        sha: createHash("sha1").update(source).digest("hex"),
      };
      this.mrs.push(mr);
      return this.json(res, 201, this.render(mr));
    }

    if (req.method === "GET" && rest === "/merge_requests") {
      const source = url.searchParams.get("source_branch");
      const state = url.searchParams.get("state");
      const listed = this.mrs.filter((m) => {
        if (source !== null && m.source !== source) return false;
        if (state === "opened") return m.state === "opened";
        if (state === "closed") return m.state === "closed";
        if (state === "merged") return m.state === "merged";
        return true;
      });
      return this.json(
        res,
        200,
        listed.map((m) => this.render(m)),
      );
    }

    const one = /^\/merge_requests\/(\d+)$/.exec(rest);
    if (one) {
      const mr = this.mrs.find((m) => m.iid === Number(one[1]));
      if (!mr) return this.json(res, 404, { message: "404 Not found" });
      if (req.method === "GET") return this.json(res, 200, this.render(mr));
      if (req.method === "PUT") {
        if (typeof body.title === "string") mr.title = body.title;
        if (typeof body.description === "string")
          mr.description = body.description;
        if (body.state_event === "close" && mr.state === "opened")
          mr.state = "closed";
        return this.json(res, 200, this.render(mr));
      }
    }

    const branch = /^\/repository\/branches\/(.+)$/.exec(rest);
    if (req.method === "DELETE" && branch) {
      if (this.refuseBranchDeletes)
        return this.json(res, 403, { message: "403 Forbidden" });
      const name = decodeURIComponent(branch[1] as string);
      if (this.protectedBranches.has(name))
        return this.json(res, 403, { message: "403 Forbidden" });
      if (!this.branchNames.delete(name))
        return this.json(res, 404, { message: "404 Branch Not Found" });
      res.writeHead(204);
      return res.end();
    }

    return this.json(res, 404, { message: "404 Not Found" });
  }
}
