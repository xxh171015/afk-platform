import { LINK_KINDS } from "@afk/shared";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppContext } from "../app.ts";
import { contextFor } from "../links/context.ts";
import { linksBySha, linksBySpec } from "../links/view.ts";
import { ErrorReply, INT4_MAX } from "./schemas.ts";

const json = <T extends z.ZodType>(schema: T) => ({
  "application/json": { schema },
});
const reply = (description: string, schema: z.ZodType) => ({
  description,
  content: json(schema),
});

const Sha = z
  .string()
  .regex(/^[0-9a-f]{40}$/, "a commit SHA is 40 lowercase hex characters");
const PathId = z.coerce.number().int().min(1).max(INT4_MAX);

const LinkRow = z.object({
  kind: z.enum(LINK_KINDS),
  repo: z.string(),
  sha: z.string(),
  specId: z.number().int(),
  specDisplayId: z.string(),
  ticketId: z.number().int().nullable(),
  ticketDisplayId: z.string().nullable(),
  runId: z.number().int().nullable(),
  runDisplayId: z.string().nullable(),
  pullNumber: z.number().int().nullable(),
});

const LinksReply = z.object({ links: z.array(LinkRow) });

const byShaRoute = createRoute({
  method: "get",
  path: "/links",
  request: {
    query: z.object({ sha: Sha }),
  },
  responses: {
    200: reply("ticket (and later pr) Links for this commit SHA", LinksReply),
  },
});

const bySpecRoute = createRoute({
  method: "get",
  path: "/specs/{id}/links",
  request: { params: z.object({ id: PathId }) },
  responses: {
    200: reply("Links recorded for this spec", LinksReply),
    404: reply("No such spec", ErrorReply),
  },
});

const ContextCommit = z.object({
  sha: Sha,
  spec: z.string().optional(),
  ticket: z.string().optional(),
  run: z.string().optional(),
});

const ContextFile = z.object({
  path: z.string().min(1).max(500),
  specs: z.array(z.object({ id: z.number().int(), displayId: z.string() })),
  tickets: z.array(z.object({ id: z.number().int(), displayId: z.string() })),
  pullRequests: z.array(
    z.object({ number: z.number().int(), url: z.string() }),
  ),
  decisions: z.array(
    z.object({ specDisplayId: z.string(), heading: z.string() }),
  ),
  outOfScope: z.array(
    z.object({ specDisplayId: z.string(), heading: z.string() }),
  ),
  adrs: z.array(z.object({ path: z.string() })),
});

const contextRoute = createRoute({
  method: "post",
  path: "/context",
  request: {
    body: {
      content: json(
        z.object({
          repo: z.string().min(1).max(200).optional(),
          repoUrl: z.string().min(1).max(500).optional(),
          files: z.array(
            z.object({
              path: z.string().min(1).max(500),
              commits: z.array(ContextCommit),
            }),
          ),
        }),
      ),
    },
  },
  responses: {
    200: reply(
      "Pointers from blamed commits to specs, tickets, pull requests, and planning headings; never the file or spec bodies",
      z.object({ files: z.array(ContextFile) }),
    ),
    400: reply(
      "Repo is missing or matches more than one registered repo",
      ErrorReply,
    ),
    404: reply("No registered repo matches", ErrorReply),
  },
});

export function registerLinkRoutes(
  app: OpenAPIHono,
  context: AppContext,
): void {
  const { pool } = context;

  app.openapi(byShaRoute, async (c) => {
    const links = await linksBySha(pool, c.req.valid("query").sha);
    return c.json({ links }, 200);
  });

  app.openapi(bySpecRoute, async (c) => {
    const links = await linksBySpec(pool, c.req.valid("param").id);
    return links
      ? c.json({ links }, 200)
      : c.json({ error: "no such spec" }, 404);
  });

  app.openapi(contextRoute, async (c) => {
    const result = await contextFor(pool, c.req.valid("json"));
    if (result.status === "ok") return c.json({ files: result.files }, 200);
    if (result.status === "no-repo") {
      return c.json({ error: result.error }, 404);
    }
    return c.json({ error: result.error }, 400);
  });
}
