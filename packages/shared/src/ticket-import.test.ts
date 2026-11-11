import { describe, expect, it } from "vitest";
import { planImport } from "./ticket-import.ts";

const repos = new Map([
  ["backend", { id: 1, contractPath: "openapi.yaml" }],
  ["frontend", { id: 2, contractPath: "fe.yaml" }],
  ["docs", { id: 4, contractPath: null }],
  ["payments", { id: 3, contractPath: "pay.yaml" }],
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

const plan = (input: unknown) => planImport(input, repos, 12);
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

  it("records stories that exist in the spec", () => {
    const specBody = [
      "## User Stories",
      "",
      "1. As a splitter, I want to name the User Stories a ticket is for.",
      "2. As an importer, I want unknown numbers rejected.",
      "3. As a reviewer, I want the assigned stories as counterparts.",
      "4. As an author of an infrastructure ticket, I want to omit stories.",
      "",
    ].join("\n");
    const result = planImport(
      file(ticket("a", { stories: [1, 4] })),
      repos,
      12,
      undefined,
      specBody,
    );
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.tickets[0]?.stories).toEqual([1, 4]);
  });
});

describe("rejections", () => {
  it("rejects a file that is not the import shape, naming the field", () => {
    expect(errorsOf({ tickets: "nope" })[0]).toMatch(/tickets/);
    expect(errorsOf(null)[0]).toMatch(/./);
  });

  it("rejects a file that names another spec, together with other problems", () => {
    const errors = errorsOf({
      spec: "S-13",
      tickets: [ticket("a", { repo: "mobile" })],
    });
    expect(errors).toHaveLength(2);
    expect(errors.join("\n")).toMatch(/S-13.*S-12/);
  });

  it("rejects a misspelt field instead of silently dropping it", () => {
    const errors = errorsOf(file(ticket("a", { blocked_bye: ["b"] })));
    expect(errors).toEqual([expect.stringMatching(/ticket a.*blocked_bye/)]);
    expect(errorsOf({ tickets: [ticket("a")], extra: 1 })[0]).toMatch(/extra/);
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

  it("rejects the whole import when stories lists numbers the spec does not have, naming those numbers", () => {
    const specBody = [
      "## User Stories",
      "",
      "1. As a splitter, I want to name the User Stories a ticket is for.",
      "2. As an importer, I want unknown numbers rejected.",
      "",
    ].join("\n");
    const result = planImport(
      file(
        ticket("ok", { stories: [1, 2] }),
        ticket("a", { stories: [1, 4] }),
        ticket("b", { stories: [2, 9, 4] }),
      ),
      repos,
      12,
      undefined,
      specBody,
    );
    if (result.ok) throw new Error("expected the import to be rejected");
    const listed = result.errors.join("\n");
    expect(listed).toMatch(/ticket a:.*stories.*\b4\b/);
    expect(listed).toMatch(/ticket b:.*stories.*\b9\b/);
    expect(listed).toMatch(/ticket b:.*stories.*\b4\b/);
    expect(result.errors.some((e) => /ticket ok/.test(e))).toBe(false);
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

describe("tickets across repos", () => {
  const contractTicket = (key: string, extra: Record<string, unknown> = {}) =>
    ticket(key, { type: "contract", ...extra });

  it("takes contract and blocks edges that cross repos", () => {
    const result = plan(
      file(
        contractTicket("c"),
        ticket("fe", { repo: "frontend", contract: "c" }),
        ticket("pay", { repo: "payments", blocked_by: ["fe"] }),
      ),
    );
    expect(result).toMatchObject({
      ok: true,
      edges: [
        { from: "c", to: "fe", kind: "contract" },
        { from: "fe", to: "pay", kind: "blocks" },
      ],
    });
  });

  it("refuses a contract upstream whose repo has no contract path, naming the ticket", () => {
    const errors = errorsOf(
      file(
        contractTicket("c", { repo: "docs" }),
        ticket("be", { contract: "c" }),
      ),
    );
    expect(errors).toEqual([
      expect.stringMatching(/ticket be: .*c .*repo docs.*no contract path/),
    ]);
  });

  it("takes several contract upstreams, and refuses two in one repo that do not depend on each other", () => {
    const apart = file(
      contractTicket("c1"),
      contractTicket("c2"),
      ticket("fe", { repo: "frontend", contract: ["c1", "c2"] }),
    );
    expect(errorsOf(apart)).toEqual([
      expect.stringMatching(/ticket fe: .*c1.*c2.*repo backend.*chain/),
    ]);
    const chained = file(
      contractTicket("c1"),
      contractTicket("c2", { blocked_by: ["c1"] }),
      ticket("fe", { repo: "frontend", contract: ["c1", "c2"] }),
    );
    expect(plan(chained).ok).toBe(true);
    const otherRepos = file(
      contractTicket("c1"),
      contractTicket("c2", { repo: "payments" }),
      ticket("fe", { repo: "frontend", contract: ["c1", "c2"] }),
    );
    expect(plan(otherRepos).ok).toBe(true);
  });

  it("refuses a contract upstream listed twice", () => {
    expect(
      errorsOf(
        file(contractTicket("c"), ticket("fe", { contract: ["c", "c"] })),
      ),
    ).toEqual([
      expect.stringMatching(/ticket fe: contract lists the same ticket twice/),
    ]);
  });

  it("refuses contract relations between repos that go round, and takes three repos that do not", () => {
    // payments uses backend's contract, backend uses frontend's, frontend uses payments'
    const ring = file(
      contractTicket("cb"),
      contractTicket("cf", { repo: "frontend" }),
      contractTicket("cp", { repo: "payments" }),
      ticket("p", { repo: "payments", contract: "cb" }),
      ticket("b", { repo: "backend", contract: "cf" }),
      ticket("f", { repo: "frontend", contract: "cp" }),
    );
    expect(errorsOf(ring).join("\n")).toMatch(
      /repo.*cycle.*(backend|frontend|payments)/,
    );
    const line = file(
      contractTicket("cb"),
      contractTicket("cp", { repo: "payments" }),
      ticket("p", { repo: "payments", contract: "cb" }),
      ticket("f", { repo: "frontend", contract: "cp" }),
    );
    expect(plan(line).ok).toBe(true);
  });

  it("keeps refs and environment, and refuses names outside the project", () => {
    const result = plan(
      file(
        ticket("fe", { repo: "frontend", refs: ["backend"] }),
        ticket("e2e", {
          repo: "frontend",
          type: "integration",
          environment: ["backend", "payments"],
        }),
      ),
    );
    expect(result).toMatchObject({
      ok: true,
      tickets: [
        { key: "fe", refs: ["backend"], environment: [] },
        { key: "e2e", refs: [], environment: ["backend", "payments"] },
      ],
    });
    expect(errorsOf(file(ticket("a", { refs: ["nope"] })))).toEqual([
      expect.stringMatching(/ticket a: refs.*nope.*does not belong/),
    ]);
    expect(
      errorsOf(
        file(ticket("e", { type: "integration", environment: ["nope"] })),
      ),
    ).toEqual([
      expect.stringMatching(/ticket e: environment.*nope.*does not belong/),
    ]);
  });

  it("allows environment only on an integration ticket, without its own repo", () => {
    expect(errorsOf(file(ticket("a", { environment: ["frontend"] })))).toEqual([
      expect.stringMatching(/ticket a: environment.*integration/),
    ]);
    expect(
      errorsOf(
        file(
          ticket("e", {
            type: "integration",
            environment: ["frontend", "backend"],
          }),
        ),
      ),
    ).toEqual([
      expect.stringMatching(/ticket e: environment.*its own repo backend/),
    ]);
  });
});

describe("appending to a spec that already has tickets", () => {
  const existing = {
    tickets: [
      {
        key: "T-1",
        repo: "backend",
        repoId: 1,
        type: "contract",
        state: "done",
        modules: ["api/**"],
      },
      {
        key: "T-2",
        repo: "frontend",
        repoId: 2,
        type: "implementation",
        state: "pending",
        modules: ["web/**"],
      },
      {
        key: "T-3",
        repo: "backend",
        repoId: 1,
        type: "implementation",
        state: "running",
        modules: ["lib/**"],
      },
      {
        key: "T-5",
        repo: "frontend",
        repoId: 2,
        type: "implementation",
        state: "blocked",
        modules: ["web2/**"],
      },
    ],
    cancelled: ["T-4"],
    edges: [{ from: "T-1", to: "T-2", kind: "contract" as const }],
  };
  const appendPlan = (input: unknown) => planImport(input, repos, 12, existing);
  const appendErrors = (input: unknown) => {
    const result = appendPlan(input);
    if (result.ok) throw new Error("expected the append to be rejected");
    return result.errors;
  };

  it("lets new tickets name existing ones by T-n in blocked_by and contract, and returns only the new edges", () => {
    const result = appendPlan(
      file(
        ticket("adapt", {
          repo: "frontend",
          blocked_by: ["T-3"],
          contract: ["T-1"],
        }),
      ),
    );
    expect(result).toMatchObject({
      ok: true,
      tickets: [{ key: "adapt" }],
      edges: [
        { from: "T-3", to: "adapt", kind: "blocks" },
        { from: "T-1", to: "adapt", kind: "contract" },
      ],
    });
  });

  it("takes an edge from a new ticket to an existing pending or blocked one, and refuses one to a running ticket", () => {
    const ok = appendPlan({
      tickets: [ticket("c2", { type: "contract", blocked_by: ["T-1"] })],
      edges: [
        { from: "c2", to: "T-2", kind: "contract" },
        { from: "c2", to: "T-5", kind: "contract" },
      ],
    });
    expect(ok).toMatchObject({
      ok: true,
      edges: expect.arrayContaining([
        { from: "c2", to: "T-2", kind: "contract" },
        { from: "c2", to: "T-5", kind: "contract" },
      ]),
    });
    expect(
      appendErrors({
        tickets: [ticket("n")],
        edges: [{ from: "n", to: "T-3" }],
      }),
    ).toEqual([expect.stringMatching(/T-3 is running.*cannot be blocked/)]);
  });

  it("refuses an edge between two existing tickets", () => {
    expect(
      appendErrors({
        tickets: [ticket("n")],
        edges: [{ from: "T-3", to: "T-5" }],
      }),
    ).toEqual([expect.stringMatching(/T-3 -> T-5.*two existing tickets/)]);
  });

  it("refuses a cancelled ticket on either end, and unknown T-n", () => {
    expect(appendErrors(file(ticket("n", { blocked_by: ["T-4"] })))).toEqual([
      expect.stringMatching(/ticket n: T-4 is cancelled/),
    ]);
    expect(appendErrors(file(ticket("n", { blocked_by: ["T-99"] })))).toEqual([
      expect.stringMatching(/ticket n: unknown ticket T-99/),
    ]);
  });

  it("refuses a new key that looks like a ticket id", () => {
    expect(appendErrors(file(ticket("T-7")))).toEqual([
      expect.stringMatching(/key T-7 .*T-<n>/),
    ]);
  });

  it("checks the whole merged graph: a cycle through existing tickets is refused", () => {
    expect(
      appendErrors({
        tickets: [ticket("n", { blocked_by: ["T-2"] })],
        edges: [{ from: "n", to: "T-2" }],
      }).join("\n"),
    ).toMatch(/dependency cycle/);
  });

  it("applies the cross-repo rules to the merged graph: contract chain", () => {
    // T-1 is a done contract in backend; a second backend contract not chained after it, used by a new ticket with T-1
    expect(
      appendErrors(
        file(
          ticket("c2", { type: "contract" }),
          ticket("fe", { repo: "frontend", contract: ["T-1", "c2"] }),
        ),
      ).join("\n"),
    ).toMatch(/chain/);
  });

  it("rejects blocks in a file that is not an append", () => {
    expect(
      errorsOf({
        tickets: [ticket("a"), ticket("b")],
        edges: [{ from: "a", to: "b" }],
      }),
    ).toEqual([expect.stringMatching(/blocks.*--append/)]);
  });

  it("warns, for a new contract ticket, about tickets of the old one that it does not feed, by their state", () => {
    const result = appendPlan(
      file(ticket("c2", { type: "contract", blocked_by: ["T-1"] })),
    );
    expect(result).toMatchObject({
      ok: true,
      warnings: [{ type: "old-contract-pending", tickets: ["T-2", "c2"] }],
    });
    const started = planImport(
      file(ticket("c2", { type: "contract", blocked_by: ["T-1"] })),
      repos,
      12,
      {
        ...existing,
        tickets: existing.tickets.map((t) =>
          t.key === "T-2" ? { ...t, state: "running" } : t,
        ),
      },
    );
    expect(started).toMatchObject({
      ok: true,
      warnings: [{ type: "old-contract-started", tickets: ["T-2", "c2"] }],
    });
  });

  it("does not warn when the new contract ticket feeds the old downstream, or when no contract ticket is added", () => {
    const fed = appendPlan({
      tickets: [ticket("c2", { type: "contract", blocked_by: ["T-1"] })],
      edges: [{ from: "c2", to: "T-2", kind: "contract" }],
    });
    expect(fed).toMatchObject({ ok: true, warnings: [] });
    expect(appendPlan(file(ticket("plain")))).toMatchObject({
      ok: true,
      warnings: [],
    });
  });
});
