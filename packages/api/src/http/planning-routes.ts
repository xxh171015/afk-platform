import {
  HOST_KINDS,
  type HostKind,
  LimitOverridesSchema,
  SPEC_STATES,
  SPEC_TYPES,
} from "@afk/shared";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppContext } from "../app.ts";
import {
  addRepo,
  createProject,
  createSpec,
  editProject,
  editRepo,
  importTickets,
} from "../planning/planning.ts";
import { confirmSpec } from "../scheduling/scheduler.ts";
import { ErrorReply, INT4_MAX } from "./schemas.ts";

const Id = z.number().int().min(1).max(INT4_MAX);
const Text = z.string().min(1).max(500);
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
  responses: { 201: reply("Created", z.object({ id: Id, name: z.string() })) },
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
          .object({ defaultModel: Text.optional(), ...projectSettings })
          .strict(),
      ),
    },
  },
  responses: {
    200: reply("Updated", z.object({ id: Id })),
    404: reply("No such project", ErrorReply),
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
    409: reply("The project already has a repo with this name", ErrorReply),
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
        }),
      ),
    },
  },
  responses: {
    201: reply("Created", z.object({ id: Id, displayId: z.string() })),
    404: reply("No such project", ErrorReply),
    409: reply("The project already has a spec with this slug", ErrorReply),
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

const PlanningSha = z
  .string()
  .regex(
    /^[0-9a-f]{40}$/,
    "must be a 40-character lowercase hex git SHA",
  );

const ConfirmBody = z
  .object({
    planningSha: PlanningSha.optional(),
    planningRepo: z.string().min(1).max(200).optional(),
  })
  .strict();

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
        planningSha: PlanningSha.nullable(),
        planningRepo: z.string().nullable(),
      }),
    ),
    404: reply("No such spec", ErrorReply),
    409: reply("The spec is not a draft, or has no tickets", ErrorReply),
    422: reply("The planning commit is incomplete or names no such repo", ErrorReply),
  },
});

export function registerPlanningRoutes(
  app: OpenAPIHono,
  context: AppContext,
): void {
  const { pool } = context;

  app.openapi(projectRoute, async (c) => {
    const project = await createProject(pool, c.req.valid("json"));
    return c.json(project, 201);
  });

  app.openapi(projectViewRoute, async (c) => {
    const { projectId } = c.req.valid("param");
    const project = await pool.query(
      "SELECT id, name FROM projects WHERE id = $1",
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

  app.openapi(projectEditRoute, async (c) => {
    const { projectId } = c.req.valid("param");
    const result = await editProject(pool, projectId, c.req.valid("json"));
    if (result.status === "no-project") {
      return c.json({ error: "no such project" }, 404);
    }
    return c.json({ id: projectId }, 200);
  });

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
    return c.json(result.repo, 201);
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
    const result = await importTickets(
      pool,
      specId,
      c.req.valid("json").files,
      {
        append: c.req.valid("query").append === "true",
      },
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

  app.openapi(confirmRoute, async (c) => {
    const { specId } = c.req.valid("param");
    let body: { planningSha?: string; planningRepo?: string } = {};
    try {
      body = c.req.valid("json") ?? {};
    } catch {
      body = {};
    }
    const planning =
      body.planningSha || body.planningRepo
        ? {
            sha: body.planningSha as string,
            repoName: body.planningRepo as string,
          }
        : undefined;
    const result = await confirmSpec(pool, specId, planning);
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
        planningSha: result.planningSha,
        planningRepo: result.planningRepo,
      },
      200,
    );
  });
}
