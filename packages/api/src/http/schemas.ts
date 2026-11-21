import { z } from "@hono/zod-openapi";

// Ids, attempts and sizes are Postgres integers: anything larger is a bad request, not a database error.
export const INT4_MAX = 2_147_483_647;
export const ErrorReply = z.object({ error: z.string() });

// GET /specs and PUT /specs/{id}/refs both return this shape.
export const SpecRefView = z.object({
  repoId: z.number().int().min(1).max(INT4_MAX),
  name: z.string(),
  url: z.string(),
  reference: z.boolean(),
  sha: z.string().nullable(),
});
