import { describe, expect, it } from "vitest";
import { planImport } from "./ticket-import.ts";

const repos = new Map([
  ["backend", 1],
  ["frontend", 2],
]);

const ticket = (key: string, extra: Record<string, unknown> = {}) => ({
  key,
  repo: "backend",
  type: "implementation",
  title: `Ticket ${key}`,
  modules: [`src/${key}/**`],
  acceptance: ["it works"],
  ...extra,
});

const file = (...tickets: Record<string, unknown>[]): unknown => ({
  tickets,
});

const plan = (input: unknown) => planImport(input, repos);
const errorsOf = (input: unknown) => {
  const result = plan(input);
  if (result.ok) throw new Error("expected the import to be rejected");
  return result.errors;
};

describe("a valid import", () => {
  it("resolves repos, keeps order, and turns blocked_by and contract into edges", () => {
    const result = plan(
      file(
        ticket("contract", {
          type: "contract",
          protected_paths_ok: ["openapi/openapi.yaml"],
          body: "details",
        }),
        ticket("be", { blocked_by: ["contract"] }),
        ticket("fe", { repo: "frontend", contract: "contract" }),
      ),
    );
    expect(result).toMatchObject({ ok: true, warnings: [] });
    if (!result.ok) return;
    expect(result.tickets.map((t) => [t.key, t.repoId, t.type])).toEqual([
      ["contract", 1, "contract"],
      ["be", 1, "implementation"],
      ["fe", 2, "implementation"],
    ]);
    expect(result.tickets[0]).toMatchObject({
      allowedProtectedPaths: ["openapi/openapi.yaml"],
      body: "details",
    });
    expect(result.tickets[1]?.body).toBe("");
    expect(result.edges).toEqual([
      { from: "contract", to: "be", kind: "blocks" },
      { from: "contract", to: "fe", kind: "contract" },
    ]);
  });

  it("accepts the optional spec field and an empty external_blocked_by", () => {
    const input = {
      spec: "S-12",
      tickets: [ticket("a")],
      external_blocked_by: [],
    };
    expect(plan(input).ok).toBe(true);
  });
});

describe("rejections", () => {
  it("rejects a file that is not the import shape, naming the field", () => {
    expect(errorsOf({ tickets: "nope" })[0]).toMatch(/tickets/);
    expect(errorsOf(null)[0]).toMatch(/./);
  });

  it("rejects an empty ticket list", () => {
    expect(errorsOf({ tickets: [] })[0]).toMatch(/tickets/);
  });

  it("requires acceptance criteria and a non-empty module glob on every ticket", () => {
    const errors = errorsOf(
      file(
        ticket("a", { acceptance: [] }),
        ticket("b", { modules: [] }),
        ticket("c", { modules: [""] }),
      ),
    );
    expect(errors.some((e) => /a.*acceptance/.test(e))).toBe(true);
    expect(errors.some((e) => /b.*modules/.test(e))).toBe(true);
    expect(errors.some((e) => /c.*modules/.test(e))).toBe(true);
  });

  it("rejects a repo that is not in the project", () => {
    const errors = errorsOf(file(ticket("a", { repo: "mobile" })));
    expect(errors).toEqual([expect.stringMatching(/a.*mobile/)]);
  });

  it("rejects duplicate keys and unknown references", () => {
    expect(errorsOf(file(ticket("a"), ticket("a")))[0]).toMatch(/duplicate.*a/);
    expect(errorsOf(file(ticket("a", { blocked_by: ["ghost"] })))[0]).toMatch(
      /ghost/,
    );
    expect(errorsOf(file(ticket("a", { contract: "ghost" })))[0]).toMatch(
      /ghost/,
    );
  });

  it("rejects a ticket that depends on itself", () => {
    expect(errorsOf(file(ticket("a", { blocked_by: ["a"] })))[0]).toMatch(
      /itself/,
    );
  });

  it("rejects a dependency cycle and names the tickets in it", () => {
    const errors = errorsOf(
      file(
        ticket("a", { blocked_by: ["c"] }),
        ticket("b", { blocked_by: ["a"] }),
        ticket("c", { blocked_by: ["b"] }),
        ticket("d"),
      ),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/cycle/);
    for (const key of ["a", "b", "c"]) expect(errors[0]).toContain(key);
    expect(errors[0]).not.toMatch(/\bd\b/);
  });

  it("requires the upstream of a contract edge to be a contract ticket", () => {
    const errors = errorsOf(
      file(ticket("impl"), ticket("fe", { contract: "impl" })),
    );
    expect(errors).toEqual([
      expect.stringMatching(/fe.*impl.*contract ticket/),
    ]);
  });

  it("rejects the whole file when external_blocked_by is not empty", () => {
    const errors = errorsOf({
      tickets: [ticket("a")],
      external_blocked_by: ["T-9"],
    });
    expect(errors).toEqual([expect.stringMatching(/external_blocked_by/)]);
  });

  it("reports every problem at once", () => {
    const errors = errorsOf(
      file(
        ticket("a", { blocked_by: ["ghost"] }),
        ticket("b", { repo: "mobile" }),
      ),
    );
    expect(errors).toHaveLength(2);
  });

  it("only allows contract, implementation and integration tickets", () => {
    expect(errorsOf(file(ticket("a", { type: "fix" })))[0]).toMatch(/type/);
  });
});

describe("module overlap warnings", () => {
  const warningsOf = (input: unknown) => {
    const result = plan(input);
    if (!result.ok) throw new Error(result.errors.join("; "));
    return result.warnings;
  };

  it("warns about overlapping modules in the same repo without a dependency path", () => {
    const warnings = warningsOf(
      file(
        ticket("a", { modules: ["src/orders/**"] }),
        ticket("b", { modules: ["src/orders/export.ts"] }),
      ),
    );
    expect(warnings).toEqual([
      {
        type: "module-overlap",
        tickets: ["a", "b"],
        repoId: 1,
        message: expect.stringContaining("a"),
      },
    ]);
  });

  it("does not warn when the tickets are connected, directly or transitively", () => {
    const modules = ["src/orders/**"];
    expect(
      warningsOf(
        file(
          ticket("a", { modules }),
          ticket("b", { modules, blocked_by: ["a"] }),
        ),
      ),
    ).toEqual([]);
    expect(
      warningsOf(
        file(
          ticket("a", { modules }),
          ticket("mid", { modules: ["docs/**"], blocked_by: ["a"] }),
          ticket("c", { modules, blocked_by: ["mid"] }),
        ),
      ),
    ).toEqual([]);
  });

  it("does not warn across repos or for disjoint modules", () => {
    expect(
      warningsOf(
        file(
          ticket("a", { modules: ["src/**"] }),
          ticket("b", { repo: "frontend", modules: ["src/**"] }),
          ticket("c", { modules: ["lib/**"] }),
        ),
      ),
    ).toEqual([]);
  });

  it("matches globs conservatively: wildcards, ** and shared directories", () => {
    const overlap = (x: string, y: string) =>
      warningsOf(
        file(ticket("a", { modules: [x] }), ticket("b", { modules: [y] })),
      ).length === 1;
    expect(overlap("src/**", "src/orders/a.ts")).toBe(true);
    expect(overlap("src/orders", "src/orders/**")).toBe(true);
    expect(overlap("src/*.ts", "src/a.ts")).toBe(true);
    expect(overlap("src/*.ts", "src/a/b.ts")).toBe(false);
    expect(overlap("src/orders/**", "src/pages/**")).toBe(false);
    expect(overlap("**/*.test.ts", "src/a.test.ts")).toBe(true);
    expect(overlap("**/*.test.ts", "src/a.ts")).toBe(false);
    expect(overlap("src/a.ts", "src/b.ts")).toBe(false);
  });

  it("reports one warning per pair even when several globs overlap", () => {
    const warnings = warningsOf(
      file(
        ticket("a", { modules: ["src/**", "lib/**"] }),
        ticket("b", { modules: ["src/x.ts", "lib/y.ts"] }),
      ),
    );
    expect(warnings).toHaveLength(1);
  });
});
