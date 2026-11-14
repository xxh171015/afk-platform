import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// The platform's skills package (skills/: afk-setup and the planning skills), every file by its path under skills/,
// such as "to-spec/SKILL.md". Files at the top of skills/ (VENDORED.md) are not part of any skill. A module of its own
// so that the plat the platform hands out (packages/api/src/cli/cli-bundle.ts) carries the files inside it: plat writes
// the skills from itself, and nothing on the planning machine fetches them from anywhere else.
export const readSkillsPackage = (): Record<string, string> => {
  const root = fileURLToPath(new URL("../../../skills", import.meta.url));
  const files: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        const path = relative(root, full);
        if (path.includes("/")) files[path] = readFileSync(full, "utf8");
      }
    }
  };
  walk(root);
  return files;
};
