import {
  DoctorItemSchema,
  DoctorReportPutSchema,
  HOST_KINDS,
  type HostKind,
  LimitOverridesSchema,
  MAX_PLANNING_PATCH_BYTES,
  PLANNING_STATES,
  PlanningDocsAtImportSchema,
  SPEC_STATES,
  SPEC_TYPES,
  tryParseRepoUrl,
} from "@afk/shared";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppContext } from "../app.ts";
import { aroundSpec } from "../events/announce.ts";
import { listHosts } from "../host/code-hosts.ts";
import {
  readRepoAccess,
  repoIdByName,
  requestRepoAccess,
} from "../host/repo-access.ts";
import { getDoctorReport, putDoctorReport } from "../planning/doctor.ts";
import {
  addRepo,
  createProject,
  createSpec,
  editProject,
  editRepo,
  importTickets,
} from "../planning/planning.ts";
import { actOnBlockedPlanning } from "../planning/planning-commit.ts";
import {
  enqueueReadinessGate,
  readReadinessGate,
} from "../planning/readiness-gate.ts";
import { confirmSpec } from "../scheduling/scheduler.ts";
import { ErrorReply, INT4_MAX } from "./schemas.ts";

const Id = z.number().int().min(1).max(INT4_MAX);
const Text = z.string().min(1).max(500);
const SUPPORTED_DEFAULT_AGENT = "cursor";
const UNSUPPORTED_DEFAULT_AGENT = "目前只支持 Cursor";
const unsupportedDefaultAgent = (value: string | undefined) =>
  value !== undefined && value !== SUPPORTED_DEFAULT_AGENT;
const json = <T extends z.ZodType>(schema: T) => ({
  "application/json": { schema },
});
const reply = (description: string, schema: z.ZodType) => ({
  description,
  content: json(schema),
});

// A path in the repo that owns the contract, e.g. openapi/openapi.yaml; empty clears it.
const ContractPath = z
  .string()
  .max(500)
  .regex(
    /^$|^[^\s/:][^\s:]*$/,
    "must be a path in the repo, like openapi/openapi.yaml, or empty to clear it",
  );

// The settings both project create and project edit take, checked the same way.
const projectSettings = {
  protectedPaths: z.array(Text).max(200).optional(),
  maxConcurrency: Id.optional(),
  budgetLimit: Id.optional(),
  limits: LimitOverridesSchema.optional(),
};

// Empty clears the project's Feishu group. Not on create: set it with plat project edit --feishu-chat.
const FeishuChatId = z.string().max(200);

const projectRoute = createRoute({
  method: "post",
  path: "/projects",
  request: {
    body: {
      content: json(
        z
          .object({
            name: Text,
            defaultAgent: Text.optional(),
            defaultModel: Text.optional(),
            mergePolicy: Text.optional(),
            ...projectSettings,
          })
          .strict(),
      ),
    },
  },
  responses: {
    201: reply("Created", z.object({ id: Id, name: z.string() })),
    400: reply("The default agent is not supported", ErrorReply),
  },
});

const projectViewRoute = createRoute({
  method: "get",
  path: "/projects/{projectId}",
  request: {
    params: z.object({
      projectId: z.coerce.number().int().min(1).max(INT4_MAX),
    }),
  },
  responses: {
    200: reply(
      "The project with its repos",
      z.object({
        id: Id,
        name: z.string(),
        defaultAgent: z.string().nullable(),
        feishuChatId: z.string().nullable(),
        repos: z.array(
          z.object({
            name: z.string(),
            url: z.string(),
            defaultBranch: z.string(),
            contractPath: z.string().nullable(),
            hostKind: z.enum(HOST_KINDS),
          }),
        ),
      }),
    ),
    404: reply("No such project", ErrorReply),
  },
});

// `plat init` finds the project a planning repo already belongs to by its address, whatever way it is spelt
// (https, ssh, with or without .git).
const projectListRoute = createRoute({
  method: "get",
  path: "/projects",
  request: {
    query: z.object({ repoUrl: Text.optional() }),
  },
  responses: {
    200: reply(
      "The projects, or with repoUrl the ones that have a repo at that address",
      z.object({
        projects: z.array(z.object({ id: Id, name: z.string() })),
      }),
    ),
  },
});

const projectEditRoute = createRoute({
  method: "patch",
  path: "/projects/{projectId}",
  request: {
    params: z.object({
      projectId: z.coerce.number().int().min(1).max(INT4_MAX),
    }),
    body: {
      content: json(
        z
          .object({
            defaultAgent: Text.optional(),
            defaultModel: Text.optional(),
            feishuChatId: FeishuChatId.optional(),
            ...projectSettings,
          })
          .strict(),
      ),
    },
  },
  responses: {
    200: reply("Updated", z.object({ id: Id })),
    400: reply("The default agent is not supported", ErrorReply),
    404: reply("No such project", ErrorReply),
  },
});

const projectFeishuTestRoute = createRoute({
  method: "post",
  path: "/projects/{projectId}/feishu-test",
  request: {
    params: z.object({
      projectId: z.coerce.number().int().min(1).max(INT4_MAX),
    }),
  },
  responses: {
    200: reply(
      "A test card was sent to the project's group or the default group",
      z.object({ sent: z.literal(true), chatId: z.string() }),
    ),
    404: reply("No such project", ErrorReply),
    409: reply("Feishu is closed or no chat is configured", ErrorReply),
    502: reply("Feishu send failed", ErrorReply),
  },
});

const repoRoute = createRoute({
  method: "post",
  path: "/projects/{projectId}/repos",
  request: {
    params: z.object({
      projectId: z.coerce.number().int().min(1).max(INT4_MAX),
    }),
    body: {
      content: json(
        z
          .object({
            url: Text,
            // How a ticket file names the repo. `role` is the older word for it, kept as an alias for a version.
            name: Text.optional(),
            role: Text.optional(),
            defaultBranch: Text.optional(),
            // Default: worked out from the url.
            hostKind: z.enum(HOST_KINDS).optional(),
          })
          .refine(
            (body) => (body.name === undefined) !== (body.role === undefined),
            {
              message: "give the repo's name (role is an older word for it)",
            },
          ),
      ),
    },
  },
  responses: {
    201: reply("Created", z.object({ id: Id, name: z.string() })),
    404: reply("No such project", ErrorReply),
    409: reply(
      "The project already has a repo with this name, or has repos on another kind of code host",
      ErrorReply,
    ),
  },
});

const hostsRoute = createRoute({
  method: "get",
  path: "/hosts",
  responses: {
    200: reply(
      "The code hosts the workers have credentials for, as they last reported them",
      z.object({
        hosts: z.array(
          z.object({
            host: z.string(),
            kind: z.enum(HOST_KINDS),
            workerId: z.string(),
            reportedAt: z.string(),
            tokenExpiresAt: z.string().optional(),
            daysLeft: z.number().int().optional(),
          }),
        ),
      }),
    ),
  },
});

const RepoAccessView = z.object({
  state: z.enum([
    "unchecked",
    "pending",
    "ok",
    "not-installed",
    "missing-permissions",
    "not-member",
    "error",
  ]),
  hostKind: z.enum(HOST_KINDS),
  missing: z.array(z.string()).optional(),
  fixUrl: z.string().optional(),
  username: z.string().optional(),
  fix: z.string().optional(),
  hints: z.array(z.enum(["personal-token", "developers-can-merge"])).optional(),
  // When the App or PAT can work on the repo: which of its setup files the default branch has.
  files: z
    .object({ gates: z.boolean(), integrationCompose: z.boolean() })
    .optional(),
  message: z.string().optional(),
  requestedAt: z.string().optional(),
  checkedAt: z.string().optional(),
  checking: z.boolean().optional(),
});

const repoAccessParams = z.object({
  projectId: z.coerce.number().int().min(1).max(INT4_MAX),
  name: Text,
});

const repoAccessRoute = createRoute({
  method: "get",
  path: "/projects/{projectId}/repos/{name}/access",
  request: { params: repoAccessParams },
  responses: {
    200: reply(
      "What the last check of the bot's access to the repo found",
      RepoAccessView,
    ),
    404: reply("No such project or repo", ErrorReply),
  },
});

const repoAccessCheckRoute = createRoute({
  method: "post",
  path: "/projects/{projectId}/repos/{name}/access-check",
  request: { params: repoAccessParams },
  responses: {
    200: reply(
      "A worker with the code host's credentials will check the repo",
      RepoAccessView,
    ),
    404: reply("No such project or repo", ErrorReply),
  },
});

const gateCheckRoute = createRoute({
  method: "post",
  path: "/projects/{projectId}/repos/{name}/gate-check",
  request: {
    params: repoAccessParams,
    body: {
      content: json(
        z.object({ branch: Text.regex(/^[A-Za-z0-9._/-]+$/) }).strict(),
      ),
    },
  },
  responses: {
    202: reply(
      "A worker will run the repo's gate on the branch in the platform's sandbox",
      z.object({ id: Id }),
    ),
    404: reply("No such project or repo", ErrorReply),
  },
});

const ReadinessGateResult = z.object({
  stage: z.literal("readiness-gate").optional(),
  pass: z.boolean(),
  reasons: z.array(z.string()),
  steps: z.array(z.string()),
  failedStep: z.string().optional(),
  tests: z.number().int().optional(),
  skipped: z.number().int().optional(),
  log: z.string().optional(),
});

const gateCheckViewRoute = createRoute({
  method: "get",
  path: "/projects/{projectId}/repos/{name}/gate-checks/{id}",
  request: {
    params: repoAccessParams.extend({
      id: z.coerce.number().int().min(1).max(INT4_MAX),
    }),
  },
  responses: {
    200: reply(
      "Where the check is, and the worker's answer once it is done",
      z.object({
        state: z.enum(["queued", "running", "done", "failed"]),
        branch: z.string(),
        result: ReadinessGateResult.optional(),
        error: z.string().optional(),
      }),
    ),
    404: reply("No such project, repo or check", ErrorReply),
  },
});

const repoEditRoute = createRoute({
  method: "patch",
  path: "/projects/{projectId}/repos/{name}",
  request: {
    params: z.object({
      projectId: z.coerce.number().int().min(1).max(INT4_MAX),
      name: Text,
    }),
    body: {
      content: json(
        z
          .object({
            contractPath: ContractPath.optional(),
            // Which code host the repo is on; it picks the seed template of the tracker doc.
            hostKind: z.enum(HOST_KINDS).optional(),
          })
          .strict(),
      ),
    },
  },
  responses: {
    200: reply("Updated", z.object({ id: Id, name: z.string() })),
    404: reply("No such project or repo", ErrorReply),
  },
});

const specRoute = createRoute({
  method: "post",
  path: "/specs",
  request: {
    body: {
      content: json(
        z.object({
          projectId: Id,
          type: z.enum(SPEC_TYPES),
          slug: z
            .string()
            .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
            .max(100),
          title: Text,
          body: z.string().max(1_000_000).optional(),
          // the repo the spec is made in, which holds its planning docs (ADR 0005)
          planningRepo: Text.optional(),
          // a bug may point at the spec it came from; omitted means none
          sourceSpecId: Id.optional(),
        }),
      ),
    },
  },
  responses: {
    201: reply("Created", z.object({ id: Id, displayId: z.string() })),
    404: reply("No such project", ErrorReply),
    409: reply("The project already has a spec with this slug", ErrorReply),
    422: reply(
      "The project has no repo of that name, or the source spec is not allowed",
      ErrorReply,
    ),
  },
});

const ImportWarning = z.object({
  type: z.enum([
    "module-overlap",
    "old-contract-pending",
    "old-contract-started",
  ]),
  tickets: z.tuple([z.string(), z.string()]),
  repoId: Id,
  message: z.string(),
});

const DoctorReportView = z.object({
  machine: z.string(),
  checkedAt: z.string(),
  items: z.array(DoctorItemSchema),
});

const doctorReportPutRoute = createRoute({
  method: "put",
  path: "/projects/{projectId}/doctor-report",
  request: {
    params: z.object({
      projectId: z.coerce.number().int().min(1).max(INT4_MAX),
    }),
    body: { content: json(DoctorReportPutSchema) },
  },
  responses: {
    200: reply("Stored", DoctorReportView),
    404: reply("No such project", ErrorReply),
  },
});

const doctorReportGetRoute = createRoute({
  method: "get",
  path: "/projects/{projectId}/doctor-report",
  request: {
    params: z.object({
      projectId: z.coerce.number().int().min(1).max(INT4_MAX),
    }),
  },
  responses: {
    200: reply(
      "The newest report for this project, or null when none has been stored",
      z.object({ report: DoctorReportView.nullable() }),
    ),
    404: reply("No such project", ErrorReply),
  },
});

const importRoute = createRoute({
  method: "post",
  path: "/specs/{specId}/tickets/import",
  request: {
    params: z.object({ specId: z.coerce.number().int().min(1).max(INT4_MAX) }),
    // append=true adds the file to a confirmed spec, and the new tickets are scheduled at once
    query: z.object({ append: z.enum(["true", "false"]).optional() }),
    // The ticket files of a directory, as written. readTicketFiles and planImport report every problem, not this schema.
    body: {
      content: json(
        z.object({
          files: z
            .array(
              z.object({
                name: z.string().min(1).max(255),
                text: z.string().max(1_000_000),
              }),
            )
            .max(500),
          // Filenames of planning-doc changes in the planning checkout; the page confirm precheck names them.
          planningDocsAtImport: PlanningDocsAtImportSchema.optional(),
        }),
      ),
    },
  },
  responses: {
    200: reply(
      "Imported",
      z.object({
        tickets: z.array(
          z.object({ key: z.string(), id: Id, displayId: z.string() }),
        ),
        warnings: z.array(ImportWarning),
      }),
    ),
    404: reply("No such spec", ErrorReply),
    409: reply(
      "The spec cannot take this import (not a draft, already has tickets, or not appendable)",
      ErrorReply,
    ),
    422: reply(
      "Rejected; nothing was written",
      z.object({ errors: z.array(z.string()) }),
    ),
  },
});

const ConfirmBody = z
  .object({
    // the planning docs patch from the planning repo ("" when nothing changed); ADR 0005
    planningPatch: z
      .string()
      .max(MAX_PLANNING_PATCH_BYTES * 2)
      .optional(),
  })
  .strict();

const planningRetryRoute = createRoute({
  method: "post",
  path: "/specs/{specId}/planning/retry",
  request: {
    params: z.object({ specId: z.coerce.number().int().min(1).max(INT4_MAX) }),
    body: {
      content: json(
        z
          .object({
            planningPatch: z.string().max(MAX_PLANNING_PATCH_BYTES * 2),
          })
          .strict(),
      ),
    },
  },
  responses: {
    200: reply(
      "The planning docs are sent again and the planning commit is queued",
      z.object({ ok: z.literal(true) }),
    ),
    404: reply("No such spec", ErrorReply),
    409: reply("The planning docs are not blocked", ErrorReply),
    422: reply("The patch is too large", ErrorReply),
  },
});

const planningWaiveRoute = createRoute({
  method: "post",
  path: "/specs/{specId}/planning/waive",
  request: {
    params: z.object({ specId: z.coerce.number().int().min(1).max(INT4_MAX) }),
  },
  responses: {
    200: reply(
      "The planning docs are given up; the planning commit is queued as the default branch's head",
      z.object({ ok: z.literal(true) }),
    ),
    404: reply("No such spec", ErrorReply),
    409: reply("The planning docs are not blocked", ErrorReply),
  },
});

const confirmRoute = createRoute({
  method: "post",
  path: "/specs/{specId}/confirm",
  request: {
    params: z.object({ specId: z.coerce.number().int().min(1).max(INT4_MAX) }),
    body: {
      content: { "application/json": { schema: ConfirmBody } },
      required: false,
    },
  },
  responses: {
    200: reply(
      "Confirmed; the spec is running and the tickets that can start are queued",
      z.object({
        state: z.enum(SPEC_STATES),
        integrationBranches: z.array(
          z.object({ repoId: Id, branch: z.string() }),
        ),
        enqueued: z.array(
          z.object({ ticketId: Id, displayId: z.string(), jobId: Id }),
        ),
        planningRepo: z.string().nullable(),
        planningState: z.enum(PLANNING_STATES).nullable(),
      }),
    ),
    404: reply("No such spec", ErrorReply),
    409: reply("The spec is not a draft, or has no tickets", ErrorReply),
    422: reply(
      "The planning commit is incomplete or names no such repo",
      ErrorReply,
    ),
  },
});

export function registerPlanningRoutes(
  app: OpenAPIHono,
  context: AppContext,
): void {
  const { pool } = context;

  app.openapi(projectRoute, async (c) => {
    const body = c.req.valid("json");
    if (unsupportedDefaultAgent(body.defaultAgent)) {
      return c.json({ error: UNSUPPORTED_DEFAULT_AGENT }, 400);
    }
    const project = await createProject(pool, body);
    return c.json(project, 201);
  });

  app.openapi(projectViewRoute, async (c) => {
    const { projectId } = c.req.valid("param");
    const project = await pool.query(
      "SELECT id, name, default_agent, feishu_chat_id FROM projects WHERE id = $1",
      [projectId],
    );
    if (!project.rows[0]) return c.json({ error: "no such project" }, 404);
    const repos = await pool.query(
      "SELECT name, url, default_branch, contract_path, host_kind FROM repos WHERE project_id = $1 ORDER BY id",
      [projectId],
    );
    return c.json(
      {
        id: project.rows[0].id as number,
        name: project.rows[0].name as string,
        defaultAgent: (project.rows[0].default_agent as string | null) ?? null,
        feishuChatId: (project.rows[0].feishu_chat_id as string | null) ?? null,
        repos: repos.rows.map((r) => ({
          name: r.name as string,
          url: r.url as string,
          defaultBranch: r.default_branch as string,
          contractPath: (r.contract_path as string | null) ?? null,
          hostKind: r.host_kind as HostKind,
        })),
      },
      200,
    );
  });

  app.openapi(doctorReportPutRoute, async (c) => {
    const { projectId } = c.req.valid("param");
    const body = c.req.valid("json");
    const result = await putDoctorReport(
      pool,
      projectId,
      body.machine,
      body.items,
    );
    if (!result.ok) return c.json({ error: "no such project" }, 404);
    return c.json(result.report, 200);
  });

  app.openapi(doctorReportGetRoute, async (c) => {
    const { projectId } = c.req.valid("param");
    const result = await getDoctorReport(pool, projectId);
    if (result.status === "no-project") {
      return c.json({ error: "no such project" }, 404);
    }
    return c.json({ report: result.report }, 200);
  });

  app.openapi(projectListRoute, async (c) => {
    const { repoUrl } = c.req.valid("query");
    const projects = await pool.query(
      "SELECT id, name FROM projects ORDER BY id",
    );
    let ids: Set<number> | null = null;
    if (repoUrl !== undefined) {
      const wanted = tryParseRepoUrl(repoUrl);
      const repos = await pool.query("SELECT project_id, url FROM repos");
      ids = new Set(
        repos.rows
          .filter((r) => {
            const ref = tryParseRepoUrl(r.url as string);
            return wanted && ref
              ? ref.owner === wanted.owner && ref.name === wanted.name
              : r.url === repoUrl;
          })
          .map((r) => r.project_id as number),
      );
    }
    return c.json(
      {
        projects: projects.rows
          .filter((p) => ids === null || ids.has(p.id as number))
          .map((p) => ({ id: p.id as number, name: p.name as string })),
      },
      200,
    );
  });

  app.openapi(projectEditRoute, async (c) => {
    const { projectId } = c.req.valid("param");
    const body = c.req.valid("json");
    if (unsupportedDefaultAgent(body.defaultAgent)) {
      return c.json({ error: UNSUPPORTED_DEFAULT_AGENT }, 400);
    }
    const result = await editProject(pool, projectId, body);
    if (result.status === "no-project") {
      return c.json({ error: "no such project" }, 404);
    }
    return c.json({ id: projectId }, 200);
  });

  app.openapi(projectFeishuTestRoute, async (c) => {
    const { projectId } = c.req.valid("param");
    const project = await pool.query("SELECT 1 FROM projects WHERE id = $1", [
      projectId,
    ]);
    if (project.rowCount === 0) {
      return c.json({ error: "no such project" }, 404);
    }
    const result = await context.feishu.sendTest(projectId);
    if (result.sent) return c.json({ sent: true, chatId: result.chatId }, 200);
    if (result.reason === "channel-closed") {
      return c.json({ error: "feishu channel is closed" }, 409);
    }
    if (result.reason === "no-chat") {
      return c.json({ error: "no Feishu chat configured" }, 409);
    }
    return c.json({ error: "feishu send failed" }, 502);
  });

  app.openapi(hostsRoute, async (c) =>
    c.json({ hosts: await listHosts(pool, context.clock()) }, 200),
  );

  app.openapi(repoRoute, async (c) => {
    const { projectId } = c.req.valid("param");
    const { name, role, url, defaultBranch, hostKind } = c.req.valid("json");
    const result = await addRepo(pool, {
      projectId,
      url,
      name: (name ?? role) as string,
      defaultBranch,
      hostKind,
    });
    if (result.status === "no-project") {
      return c.json({ error: "no such project" }, 404);
    }
    if (result.status === "name-taken") {
      return c.json(
        { error: "the project already has a repo with this name" },
        409,
      );
    }
    if (result.status === "mixed-hosts")
      return c.json({ error: result.message }, 409);
    return c.json(result.repo, 201);
  });

  app.openapi(gateCheckRoute, async (c) => {
    const { projectId, name } = c.req.valid("param");
    const repoId = await repoIdByName(pool, projectId, name);
    if (repoId === undefined) return c.json({ error: "no such repo" }, 404);
    const id = await enqueueReadinessGate(pool, {
      repoId,
      branch: c.req.valid("json").branch,
    });
    return c.json({ id }, 202);
  });

  app.openapi(gateCheckViewRoute, async (c) => {
    const { projectId, name, id } = c.req.valid("param");
    const repoId = await repoIdByName(pool, projectId, name);
    const check =
      repoId === undefined
        ? undefined
        : await readReadinessGate(pool, repoId, id);
    if (!check) return c.json({ error: "no such check" }, 404);
    const parsed = ReadinessGateResult.safeParse(check.result);
    return c.json(
      {
        state: check.state,
        branch: check.branch,
        ...(parsed.success ? { result: parsed.data } : {}),
        ...(check.error ? { error: check.error } : {}),
      },
      200,
    );
  });

  app.openapi(repoAccessRoute, async (c) => {
    const { projectId, name } = c.req.valid("param");
    const access = await readRepoAccess(pool, projectId, name);
    if (access === "no-repo") return c.json({ error: "no such repo" }, 404);
    return c.json(access, 200);
  });

  app.openapi(repoAccessCheckRoute, async (c) => {
    const { projectId, name } = c.req.valid("param");
    const repoId = await repoIdByName(pool, projectId, name);
    if (repoId === undefined) return c.json({ error: "no such repo" }, 404);
    await requestRepoAccess(pool, repoId, context.clock());
    const access = await readRepoAccess(pool, projectId, name);
    return c.json(
      access === "no-repo" ? { state: "unchecked" as const } : access,
      200,
    );
  });

  app.openapi(repoEditRoute, async (c) => {
    const { projectId, name } = c.req.valid("param");
    const result = await editRepo(pool, projectId, name, c.req.valid("json"));
    if (result.status === "no-project") {
      return c.json({ error: "no such project" }, 404);
    }
    if (result.status === "no-repo") {
      return c.json({ error: "no such repo" }, 404);
    }
    return c.json(result.repo, 200);
  });

  app.openapi(specRoute, async (c) => {
    const result = await createSpec(pool, c.req.valid("json"));
    if (result.status === "no-project") {
      return c.json({ error: "no such project" }, 404);
    }
    if (result.status === "no-repo" || result.status === "invalid-source") {
      return c.json({ error: result.message }, 422);
    }
    if (result.status === "slug-taken") {
      return c.json(
        { error: "the project already has a spec with this slug" },
        409,
      );
    }
    return c.json(result.spec, 201);
  });

  app.openapi(importRoute, async (c) => {
    const { specId } = c.req.valid("param");
    const body = c.req.valid("json");
    const result = await aroundSpec(context, specId, () =>
      importTickets(pool, specId, body.files, {
        append: c.req.valid("query").append === "true",
        planningDocsAtImport: body.planningDocsAtImport,
      }),
    );
    switch (result.status) {
      case "no-spec":
        return c.json({ error: "no such spec" }, 404);
      case "not-importable":
        return c.json({ error: result.message }, 409);
      case "invalid":
        return c.json({ errors: result.errors }, 422);
      case "ok":
        return c.json(
          { tickets: result.tickets, warnings: result.warnings },
          200,
        );
    }
  });

  const planningAction = async (
    specId: number,
    action: Parameters<typeof actOnBlockedPlanning>[2],
  ) =>
    aroundSpec(context, specId, () =>
      actOnBlockedPlanning(pool, specId, action),
    );

  app.openapi(planningRetryRoute, async (c) => {
    const { specId } = c.req.valid("param");
    const result = await planningAction(specId, {
      kind: "retry",
      patch: c.req.valid("json").planningPatch,
    });
    if (result.status === "no-spec")
      return c.json({ error: "no such spec" }, 404);
    if (result.status === "not-blocked")
      return c.json({ error: result.message }, 409);
    if (result.status === "invalid")
      return c.json({ error: result.message }, 422);
    return c.json({ ok: true as const }, 200);
  });

  app.openapi(planningWaiveRoute, async (c) => {
    const { specId } = c.req.valid("param");
    const result = await planningAction(specId, { kind: "waive" });
    if (result.status === "no-spec")
      return c.json({ error: "no such spec" }, 404);
    if (result.status !== "ok")
      return c.json({ error: (result as { message: string }).message }, 409);
    return c.json({ ok: true as const }, 200);
  });

  app.openapi(confirmRoute, async (c) => {
    const { specId } = c.req.valid("param");
    let body: { planningPatch?: string } = {};
    try {
      body = c.req.valid("json") ?? {};
    } catch {
      body = {};
    }
    const planning =
      body.planningPatch === undefined
        ? undefined
        : { patch: body.planningPatch };
    const result = await aroundSpec(context, specId, () =>
      confirmSpec(pool, specId, planning),
    );
    if (result.status === "no-spec")
      return c.json({ error: "no such spec" }, 404);
    if (result.status === "not-confirmable") {
      return c.json({ error: result.message }, 409);
    }
    if (result.status === "invalid") {
      return c.json({ error: result.message }, 422);
    }
    return c.json(
      {
        state: result.state,
        integrationBranches: result.integrationBranches,
        enqueued: result.enqueued,
        planningRepo: result.planningRepo,
        planningState: result.planningState,
      },
      200,
    );
  });
}
