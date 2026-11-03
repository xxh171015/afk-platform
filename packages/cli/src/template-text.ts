import { readFileSync } from "node:fs";

// The raw text of a template under packages/cli/templates/. A module of its own so that the plat the platform hands
// out (packages/api/src/cli-bundle.ts) carries the templates inside it.
export const readTemplateText = (name: string): string =>
  readFileSync(new URL(`../templates/${name}.md`, import.meta.url), "utf8");
