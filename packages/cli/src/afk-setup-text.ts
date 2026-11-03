import { readFileSync } from "node:fs";

// The afk-setup skill as this version of the platform has it (skills/afk-setup/SKILL.md). A module of its own so
// that the plat the platform hands out (packages/api/src/cli-bundle.ts) carries it inside.
export const readAfkSetupSkill = (): string =>
  readFileSync(
    new URL("../../../skills/afk-setup/SKILL.md", import.meta.url),
    "utf8",
  );
