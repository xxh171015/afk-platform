import { PLATFORM_VERSION } from "@afk/shared/platform-version";
import { SKILLS_SHA } from "@afk/shared/skills-sha";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { cliBundle } from "../cli/cli-bundle.ts";

// What a planning machine fetches from the platform: plat itself, and which version the platform is.

const versionRoute = createRoute({
  method: "get",
  path: "/version",
  responses: {
    200: {
      description:
        "The platform's version and the mattpocock/skills commit it pins",
      content: {
        "application/json": {
          schema: z.object({
            platformVersion: z.string(),
            skillsSha: z.string(),
          }),
        },
      },
    },
  },
});

export function registerCliRoutes(app: OpenAPIHono) {
  app.openapi(versionRoute, (c) =>
    c.json({ platformVersion: PLATFORM_VERSION, skillsSha: SKILLS_SHA }, 200),
  );
  // plat as one JavaScript file for node; not in the OpenAPI document, it is not JSON
  app.get("/cli/plat.mjs", async (c) => {
    const text = await cliBundle();
    return c.body(text, 200, {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-store",
    });
  });
}
