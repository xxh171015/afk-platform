import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AppCredentials } from "./github-app.ts";

// The App's credentials live in ~/.afk/secrets/github-app/ (docs/design.md「代码托管」): the private key as
// private-key.pem (mode 600) and the two ids in app.json: { "appId": "...", "installationId": "..." }.
export const defaultCredentialsDir = () =>
  join(homedir(), ".afk", "secrets", "github-app");

export function loadAppCredentials(
  dir: string = defaultCredentialsDir(),
): AppCredentials {
  const ids = JSON.parse(readFileSync(join(dir, "app.json"), "utf8")) as {
    appId?: unknown;
    installationId?: unknown;
  };
  if (typeof ids.appId !== "string" || typeof ids.installationId !== "string")
    throw new Error(
      `${join(dir, "app.json")} must hold { "appId": "...", "installationId": "..." } as strings`,
    );
  const keyPath = join(dir, "private-key.pem");
  // a key other users can read is not a secret any more
  if (statSync(keyPath).mode & 0o077)
    throw new Error(`${keyPath} must only be readable by you: chmod 600 it`);
  return {
    appId: ids.appId,
    installationId: ids.installationId,
    privateKey: readFileSync(keyPath, "utf8"),
  };
}
