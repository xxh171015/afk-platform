import { z } from "@hono/zod-openapi";

// Ids, attempts and sizes are Postgres integers: anything larger is a bad request, not a database error.
export const INT4_MAX = 2_147_483_647;
export const ErrorReply = z.object({ error: z.string() });
