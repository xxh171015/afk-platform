import { basename, join } from "node:path";
import { git } from "@afk/pipeline";

// The folder a repo's gates keep their package downloads in (pnpm store, Go modules, ...), so a gate does not fetch
// every package again (docs/optimization-plan.md 2.8). A slot's clone comes from the worker's main clone of its repo,
// whose name already tells two repos of one name on different hosts apart: the folder is named after it.
export function depsCacheDirOf(root: string, cloneDir: string): string {
  const origin = git(cloneDir, ["config", "--get", "remote.origin.url"]);
  const name =
    origin.code === 0
      ? basename(origin.stdout.trim()).replace(/\.git$/, "")
      : "";
  return join(root, name || "default");
}
