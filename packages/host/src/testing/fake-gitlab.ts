import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

// A stand-in for the GitLab CE REST calls the adapter uses (17.3.1: create returns 201, a second
// create for the same source branch is 409 in Chinese, close is state_event, a missing branch is 404).
// getPullRequest also reads head_pipeline, approvals, reviewers, /user and can_push.

interface FakeMr {
  iid: number;
  source: string;
  target: string;
  title: string;
  description: string;
  state: "opened" | "closed" | "merged";
  sha: string;
  pipeline: string | null;
  mergedBy: string | null;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  squashCommitSha: string | null;
  approvedBy: string[];
  reviewers: { username: string; state: string }[];
  hasConflicts: boolean;
}

export class FakeGitLab {
  readonly requests: string[] = [];
  refuseBranchDeletes = false;
  hideApprovals = false;
  hideReviewers = false;
  rateLimitSeconds: number | null = null;
  username = "token-user";
  userId = 1;
  member = true;
  canPush = true;
  defaultBranch = "master";
  // Maintainers-only merge on a protected default branch; 30 is Developers; false means unprotected.
  protectDefault = true;
  mergeAccessLevel = 40;
  tokenExpiresAt: string | null = null;
  hideTokenExpiry = false;
  readonly files = new Set<string>();
  readonly branchFiles = new Map<string, Set<string>>();
  private readonly branchShas = new Map<string, string>();
  readonly missingBranches = new Set<string>();
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

  setBranchSha(name: string, sha: string): void {
    this.branchShas.set(name, sha);
  }

  addBranch(name: string): void {
    this.branchNames.add(name);
  }

  protectBranch(name: string): void {
    this.protectedBranches.add(name);
  }

  setPipeline(iid: number, status: string | null): void {
    this.mr(iid).pipeline = status;
  }

  approveMr(iid: number, username: string): void {
    const mr = this.mr(iid);
    if (!mr.approvedBy.includes(username)) mr.approvedBy.push(username);
  }

  setReviewer(iid: number, username: string, state: string): void {
    const mr = this.mr(iid);
    const existing = mr.reviewers.find((row) => row.username === username);
    if (existing) existing.state = state;
    else mr.reviewers.push({ username, state });
  }

  pushCommit(iid: number, sha: string): void {
    this.mr(iid).sha = sha;
  }

  mergeMr(
    iid: number,
    extra: {
      by?: string;
      at?: string;
      mergeSha?: string;
      squashSha?: string;
    } = {},
  ): void {
    const mr = this.mr(iid);
    mr.state = "merged";
    mr.mergedBy = extra.by ?? mr.mergedBy;
    mr.mergedAt = extra.at ?? mr.mergedAt ?? "2026-11-09T10:00:00.000Z";
    if (extra.mergeSha) mr.mergeCommitSha = extra.mergeSha;
    if (extra.squashSha) mr.squashCommitSha = extra.squashSha;
  }

  closeMr(iid: number): void {
    this.mr(iid).state = "closed";
  }

  setHasConflicts(iid: number, hasConflicts: boolean): void {
    this.mr(iid).hasConflicts = hasConflicts;
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
    const user = mr.mergedBy ? { username: mr.mergedBy } : null;
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
      merged_by: user,
      merge_user: user,
      merged_at: mr.mergedAt,
      merge_commit_sha: mr.mergeCommitSha,
      squash_commit_sha: mr.squashCommitSha,
      head_pipeline: mr.pipeline ? { status: mr.pipeline } : null,
      reviewers: mr.reviewers.map((row) => ({
        user: { username: row.username },
        state: row.state,
      })),
      has_conflicts: mr.hasConflicts,
    };
  }

  private json(
    res: import("node:http").ServerResponse,
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
  ) {
    res.writeHead(status, { "content-type": "application/json", ...headers });
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

    if (this.rateLimitSeconds !== null)
      return this.json(
        res,
        429,
        { message: "429 Too Many Requests" },
        { "retry-after": String(this.rateLimitSeconds) },
      );

    const url = new URL(req.url ?? "/", "http://gitlab.example");
    if (req.method === "GET" && url.pathname === "/api/v4/user")
      return this.json(res, 200, {
        id: this.userId,
        username: this.username,
      });
    if (
      req.method === "GET" &&
      url.pathname === "/api/v4/personal_access_tokens/self"
    ) {
      if (this.hideTokenExpiry)
        return this.json(res, 404, { message: "404 Not Found" });
      return this.json(res, 200, { expires_at: this.tokenExpiresAt });
    }

    const prefix = `/api/v4/projects/${this.projectPath()}`;
    if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`))
      return this.json(res, 404, { message: "404 Project Not Found" });
    const rest = url.pathname.slice(prefix.length);

    if (req.method === "GET" && rest === "")
      return this.json(res, 200, {
        default_branch: this.defaultBranch,
        permissions: {
          project_access: this.member ? { access_level: 30 } : null,
          group_access: null,
        },
      });

    const member = /^\/members\/all\/(\d+)$/.exec(rest);
    if (member && req.method === "GET") {
      if (!this.member || Number(member[1]) !== this.userId)
        return this.json(res, 404, { message: "404 Not found" });
      return this.json(res, 200, {
        id: this.userId,
        username: this.username,
        access_level: 30,
      });
    }

    const protectedBranch = /^\/protected_branches\/(.+)$/.exec(rest);
    if (protectedBranch && req.method === "GET") {
      const name = decodeURIComponent(protectedBranch[1] as string);
      if (!this.protectDefault || name !== this.defaultBranch)
        return this.json(res, 404, { message: "404 Not found" });
      return this.json(res, 200, {
        name,
        merge_access_levels: [{ access_level: this.mergeAccessLevel }],
      });
    }

    const file = /^\/repository\/files\/(.+)$/.exec(rest);
    if (file && req.method === "GET") {
      const path = decodeURIComponent(file[1] as string);
      const ref = url.searchParams.get("ref") ?? this.defaultBranch;
      const present =
        (ref === this.defaultBranch && this.files.has(path)) ||
        (this.branchFiles.get(ref)?.has(path) ?? false);
      if (!present)
        return this.json(res, 404, { message: "404 File Not Found" });
      return this.json(res, 200, { file_path: path });
    }

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
        pipeline: null,
        mergedBy: null,
        mergedAt: null,
        mergeCommitSha: null,
        squashCommitSha: null,
        approvedBy: [],
        reviewers: [],
        hasConflicts: false,
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

    const approvals = /^\/merge_requests\/(\d+)\/approvals$/.exec(rest);
    if (approvals && req.method === "GET") {
      if (this.hideApprovals)
        return this.json(res, 404, { message: "404 Not Found" });
      const mr = this.mrs.find((m) => m.iid === Number(approvals[1]));
      if (!mr) return this.json(res, 404, { message: "404 Not found" });
      return this.json(res, 200, {
        approved: mr.approvedBy.length > 0,
        approved_by: mr.approvedBy.map((username) => ({
          user: { username },
        })),
      });
    }

    const reviewers = /^\/merge_requests\/(\d+)\/reviewers$/.exec(rest);
    if (reviewers && req.method === "GET") {
      if (this.hideReviewers)
        return this.json(res, 404, { message: "404 Not Found" });
      const mr = this.mrs.find((m) => m.iid === Number(reviewers[1]));
      if (!mr) return this.json(res, 404, { message: "404 Not found" });
      return this.json(
        res,
        200,
        mr.reviewers.map((row) => ({
          user: { username: row.username },
          state: row.state,
        })),
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
    if (branch) {
      const name = decodeURIComponent(branch[1] as string);
      if (req.method === "GET") {
        if (this.missingBranches.has(name))
          return this.json(res, 404, { message: "404 Branch Not Found" });
        return this.json(res, 200, {
          name,
          can_push: this.canPush,
          commit: {
            id:
              this.branchShas.get(name) ??
              createHash("sha1").update(name).digest("hex"),
          },
        });
      }
      if (req.method === "DELETE") {
        if (this.refuseBranchDeletes)
          return this.json(res, 403, { message: "403 Forbidden" });
        if (this.protectedBranches.has(name))
          return this.json(res, 403, { message: "403 Forbidden" });
        if (!this.branchNames.delete(name))
          return this.json(res, 404, { message: "404 Branch Not Found" });
        res.writeHead(204);
        return res.end();
      }
    }

    return this.json(res, 404, { message: "404 Not Found" });
  }
}
