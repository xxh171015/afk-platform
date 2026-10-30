import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The page imports `@afk/shared`, and the dev server bundles everything that entry reaches for the browser. So
// nothing it reaches may use Node-only packages: a `pg` in there blanks the whole page ("Buffer is not defined").
// Code that needs the database imports `@afk/shared/db` instead.

const src = fileURLToPath(new URL("./", import.meta.url));
const NODE_ONLY = /from\s+["'](pg|node:[a-z/]+|fs|path|child_process)["']/;

describe("the entry the page imports", () => {
  it("reaches no Node-only package", () => {
    const entry = readFileSync(`${src}index.ts`, "utf8");
    const reached = [...entry.matchAll(/from\s+"\.\/([^"]+)"/g)].map(
      (m) => m[1] as string,
    );
    expect(reached.length).toBeGreaterThan(10);
    const offenders = reached.filter((file) =>
      NODE_ONLY.test(readFileSync(`${src}${file}`, "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  it("keeps the database connection out of the entry", () => {
    expect(readFileSync(`${src}index.ts`, "utf8")).not.toMatch(/db\.ts/);
    expect(readdirSync(src)).toContain("db.ts");
  });
});
