import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readTicketFiles } from "./ticket-files.ts";

const docs = fileURLToPath(new URL("../../../docs/", import.meta.url));

// The spec a directory's tickets are written for: the number under their `## Parent`.
const specOf = (text: string) => {
  const number = /## Parent\s+S-(\d+)/.exec(text)?.[1];
  if (!number) throw new Error("a ticket file has no `## Parent` with a spec");
  return Number(number);
};

function expectImportable(files: { name: string; text: string }[]) {
  const first = files[0];
  if (!first) throw new Error("no ticket files");
  expect(readTicketFiles(files, specOf(first.text))).toMatchObject({
    ok: true,
  });
}

describe("the ticket directories in docs/specs", () => {
  const specs = `${docs}specs/`;
  const dirs = readdirSync(specs, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .flatMap((e) =>
      readdirSync(`${specs}${e.name}`, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .flatMap((d) =>
          readdirSync(`${specs}${e.name}/${d.name}`).some((f) =>
            f.endsWith(".md"),
          )
            ? [`${e.name}/${d.name}`]
            : [
                // m1-acceptance and m2-acceptance keep theirs one level down
                ...readdirSync(`${specs}${e.name}/${d.name}`, {
                  withFileTypes: true,
                })
                  .filter((x) => x.isDirectory())
                  .map((x) => `${e.name}/${d.name}/${x.name}`),
              ],
        ),
    );

  it("finds the drill and acceptance directories", () => {
    expect(dirs).toEqual(
      expect.arrayContaining([
        "m1-drill/serial",
        "m1-drill/parallel",
        "m1-drill/single",
        "m2-drill/e2e",
        "m2-drill/contract",
        "m1-acceptance/tickets",
        "m2-acceptance/tickets",
      ]),
    );
  });

  it.each(dirs)("%s imports as written", (dir) => {
    const path = `${specs}${dir}`;
    expectImportable(
      readdirSync(path)
        .filter((name) => name.endsWith(".md"))
        .map((name) => ({
          name,
          text: readFileSync(`${path}/${name}`, "utf8"),
        })),
    );
  });
});

describe("the operations manual's ticket directories", () => {
  const manual = readFileSync(`${docs}operations-manual.md`, "utf8");

  // Each appendix shows its files as **`name.md`** followed by a fenced markdown block.
  const filesOf = (heading: string) => {
    const start = manual.indexOf(heading);
    const end = manual.indexOf("\n## 附录", start + 1);
    const section = manual.slice(start, end < 0 ? undefined : end);
    return [
      ...section.matchAll(
        /\*\*`([^`]+\.md)`\*\*\n\n```markdown\n([\s\S]*?)\n```/g,
      ),
    ].map((m) => ({ name: m[1] as string, text: `${m[2]}\n` }));
  };

  it.each(["## 附录 A", "## 附录 B"])("%s imports as written", (heading) => {
    const files = filesOf(heading);
    expect(files.length).toBeGreaterThan(1);
    expectImportable(files);
  });

  it("no longer teaches tickets.yaml", () => {
    expect(manual).not.toContain("tickets.yaml");
  });
});

describe("the docs no longer teach the yaml import", () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));

  it.each([
    "README.md",
    "docs/operations-manual.md",
    "docs/design.md",
    "docs/specs/m1-platform.md",
    "docs/specs/m2-platform.md",
  ])("%s imports directories, not yaml files", (file) => {
    const text = readFileSync(`${root}${file}`, "utf8");
    expect(text).not.toMatch(/tickets import \S+ \S+\.ya?ml/);
    expect(text).not.toContain("edges: [{");
  });
});
