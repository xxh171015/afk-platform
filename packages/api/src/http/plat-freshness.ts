import {
  CLIENT_HEADER,
  PLAT_DEV,
  PLAT_HEADER,
  PLAT_OUTDATED,
} from "@afk/shared";
import type { MiddlewareHandler } from "hono";
import { platFingerprint } from "../cli/cli-bundle.ts";

// What plat publishes (a spec, ticket files, a confirm) must come from the plat the platform hands out now: the
// skills copies, tracker-doc templates and checks inside it are what this platform plans with. An older plat gets
// 409 PLAT_OUTDATED before anything is stored; plat then replaces itself with the platform's and runs the command
// again (packages/cli/src/self-update.ts). The page, and a plat run from a checkout of the platform, are not asked.
const PUBLISHING = [
  /^\/specs$/,
  /^\/specs\/\d+\/tickets\/import$/,
  /^\/specs\/\d+\/confirm$/,
];

export const refuseOutdatedPlat: MiddlewareHandler = async (c, next) => {
  if (
    c.req.method !== "POST" ||
    c.req.header(CLIENT_HEADER) !== "cli" ||
    !PUBLISHING.some((path) => path.test(c.req.path))
  )
    return next();
  const sent = c.req.header(PLAT_HEADER);
  if (sent === PLAT_DEV) return next();
  // a platform that cannot build plat has nothing newer to hand out
  const current = await platFingerprint().catch(() => undefined);
  if (current === undefined || sent === current) return next();
  return c.json(
    {
      error:
        "this plat is older than the one the platform hands out: run plat update, then the command again",
      code: PLAT_OUTDATED,
    },
    409,
  );
};
