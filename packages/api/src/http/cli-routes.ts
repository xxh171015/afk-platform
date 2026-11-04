import { spawnSync } from "node:child_process";
import { PLATFORM_VERSION } from "@afk/shared/platform-version";
import { SKILLS_SHA } from "@afk/shared/skills-sha";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { cliBundle } from "../cli/cli-bundle.ts";

// What a planning machine fetches from the platform: plat itself, and which version the platform is.

// The commit of the platform's repo this platform runs from: what `plat update` and the control tower's install
// command pin the skills package to (xxh171015/afk-platform#<commit>). $AFK_PLATFORM_COMMIT when the platform does
// not run from a git checkout; null when neither says.
let commit: string | null | undefined;
export function platformCommit(
  env: Record<string, string | undefined> = process.env,
): string | null {
  if (env.AFK_PLATFORM_COMMIT) return env.AFK_PLATFORM_COMMIT;
  if (commit === undefined) {
    const head = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: new URL("../../../..", import.meta.url).pathname,
      encoding: "utf8",
    });
    commit = head.status === 0 ? head.stdout.trim() : null;
  }
  return commit;
}

const versionRoute = createRoute({
  method: "get",
  path: "/version",
  responses: {
    200: {
      description:
        "The platform's version, the mattpocock/skills commit it pins, and the commit of the platform's repo it runs (null when unknown)",
      content: {
        "application/json": {
          schema: z.object({
            platformVersion: z.string(),
            skillsSha: z.string(),
            platformCommit: z.string().nullable(),
          }),
        },
      },
    },
  },
});

export function registerCliRoutes(app: OpenAPIHono) {
  app.openapi(versionRoute, (c) =>
    c.json(
      {
        platformVersion: PLATFORM_VERSION,
        skillsSha: SKILLS_SHA,
        platformCommit: platformCommit(),
      },
      200,
    ),
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
