import { spawnSync } from "node:child_process";
import { PLATFORM_VERSION } from "@afk/shared/platform-version";
import { SKILLS_SHA } from "@afk/shared/skills-sha";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { cliBundle, platFingerprint } from "../cli/cli-bundle.ts";

// What a planning machine fetches from the platform: plat itself, and which version the platform is.

// The commit of the platform's repo that `plat update` and the control tower's install command pin the skills
// package to (xxh171015/afk-platform#<commit>): the newest commit this platform's checkout runs that a remote has,
// since GitHub cannot resolve one only this checkout has. $AFK_PLATFORM_COMMIT when the platform does not run from
// a git checkout; null when neither says.
let commit: string | null | undefined;
export function platformCommit(
  env: Record<string, string | undefined> = process.env,
): string | null {
  if (env.AFK_PLATFORM_COMMIT) return env.AFK_PLATFORM_COMMIT;
  if (commit === undefined) commit = pushedHead();
  return commit;
}

function pushedHead(): string | null {
  const git = (args: string[]) => {
    const result = spawnSync("git", args, {
      cwd: new URL("../../../..", import.meta.url).pathname,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    return result.status === 0
      ? result.stdout.split("\n").filter(Boolean)
      : null;
  };
  const unpushed = git(["rev-list", "HEAD", "--not", "--remotes"]);
  const line = git(["rev-list", "--first-parent", "HEAD"]);
  if (!unpushed || !line) return null;
  const local = new Set(unpushed);
  return line.find((sha) => !local.has(sha)) ?? null;
}

const versionRoute = createRoute({
  method: "get",
  path: "/version",
  responses: {
    200: {
      description:
        "The platform's version, the mattpocock/skills commit it pins, the commit of the platform's repo it runs (null when unknown), and the sha256 of the plat it hands out (null when it cannot build one)",
      content: {
        "application/json": {
          schema: z.object({
            platformVersion: z.string(),
            skillsSha: z.string(),
            platformCommit: z.string().nullable(),
            platFingerprint: z.string().nullable(),
          }),
        },
      },
    },
  },
});

export function registerCliRoutes(app: OpenAPIHono) {
  app.openapi(versionRoute, async (c) =>
    c.json(
      {
        platformVersion: PLATFORM_VERSION,
        skillsSha: SKILLS_SHA,
        platformCommit: platformCommit(),
        platFingerprint: await platFingerprint().catch(() => null),
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
