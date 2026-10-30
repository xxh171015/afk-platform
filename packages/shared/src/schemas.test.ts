import { describe, expect, it } from "vitest";
import { EdgeSchema, SpecSchema, TicketSchema } from "./schemas.ts";

const pendingTicket = {
  id: 7,
  specId: 3,
  repoId: 1,
  type: "implementation",
  title: "Add order notes endpoint",
  body: "Implement POST /orders/:id/notes",
  acceptanceCriteria: ["returns 201 with the created note"],
  modules: ["packages/api/src/orders/**"],
  state: "pending",
  contentVersion: 1,
};

describe("TicketSchema", () => {
  it("accepts a pending ticket without a blocked reason", () => {
    expect(TicketSchema.safeParse(pendingTicket).success).toBe(true);
  });

  it("requires a blocked reason when the ticket is blocked", () => {
    const blocked = { ...pendingTicket, state: "blocked" };
    expect(TicketSchema.safeParse(blocked).success).toBe(false);
    expect(
      TicketSchema.safeParse({ ...blocked, blockedReason: "gate-failed" })
        .success,
    ).toBe(true);
  });

  it("rejects a blocked reason on a ticket that is not blocked", () => {
    const result = TicketSchema.safeParse({
      ...pendingTicket,
      blockedReason: "gate-failed",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown state, an unknown blocked reason and an unknown type", () => {
    expect(
      TicketSchema.safeParse({ ...pendingTicket, state: "paused" }).success,
    ).toBe(false);
    expect(
      TicketSchema.safeParse({
        ...pendingTicket,
        state: "blocked",
        blockedReason: "oops",
      }).success,
    ).toBe(false);
    expect(
      TicketSchema.safeParse({ ...pendingTicket, type: "chore" }).success,
    ).toBe(false);
  });

  it.each([0, -1, 1.5])("rejects content version %s", (contentVersion) => {
    expect(
      TicketSchema.safeParse({ ...pendingTicket, contentVersion }).success,
    ).toBe(false);
  });

  it("only a contract ticket may carry a contract SHA", () => {
    const contract = {
      ...pendingTicket,
      type: "contract",
      contractSha: "a1b2c3d",
    };
    expect(TicketSchema.safeParse(contract).success).toBe(true);
    expect(
      TicketSchema.safeParse({ ...contract, type: "implementation" }).success,
    ).toBe(false);
  });

  it("carries the protected paths a person approved for this ticket", () => {
    const approved = [".github/workflows/ci.yml"];
    const parsed = TicketSchema.parse({
      ...pendingTicket,
      allowedProtectedPaths: approved,
    });
    expect(parsed.allowedProtectedPaths).toEqual(approved);
    expect(TicketSchema.parse(pendingTicket).allowedProtectedPaths).toEqual([]);
  });
});

describe("EdgeSchema", () => {
  it("accepts blocks and contract edges between two different tickets", () => {
    expect(
      EdgeSchema.safeParse({ from: 1, to: 2, kind: "blocks" }).success,
    ).toBe(true);
    expect(
      EdgeSchema.safeParse({ from: 1, to: 2, kind: "contract" }).success,
    ).toBe(true);
  });

  it("rejects an unknown kind and a ticket depending on itself", () => {
    expect(
      EdgeSchema.safeParse({ from: 1, to: 2, kind: "relates" }).success,
    ).toBe(false);
    expect(
      EdgeSchema.safeParse({ from: 4, to: 4, kind: "blocks" }).success,
    ).toBe(false);
  });
});

describe("SpecSchema", () => {
  const spec = {
    id: 3,
    projectId: 1,
    type: "feature",
    slug: "order-notes",
    title: "Order notes",
    body: "## Problem\n...",
    state: "draft",
  };

  it("accepts a draft spec", () => {
    expect(SpecSchema.safeParse(spec).success).toBe(true);
  });

  it("rejects an unknown type or state", () => {
    expect(SpecSchema.safeParse({ ...spec, type: "epic" }).success).toBe(false);
    expect(SpecSchema.safeParse({ ...spec, state: "blocked" }).success).toBe(
      false,
    );
  });

  it("a spec may point at the spec it came from", () => {
    expect(
      SpecSchema.safeParse({ ...spec, type: "bug", sourceSpecId: 2 }).success,
    ).toBe(true);
  });

  it("needs a slug, because the integration branch is spec/<slug>", () => {
    const { slug: _slug, ...withoutSlug } = spec;
    expect(SpecSchema.safeParse(withoutSlug).success).toBe(false);
    expect(SpecSchema.safeParse({ ...spec, slug: "" }).success).toBe(false);
  });

  it("records one integration branch per repo involved", () => {
    const branches = [{ repoId: 1, branch: "spec/order-notes" }];
    const parsed = SpecSchema.parse({ ...spec, integrationBranches: branches });
    expect(parsed.integrationBranches).toEqual(branches);
    expect(SpecSchema.parse(spec).integrationBranches).toEqual([]);
    expect(
      SpecSchema.safeParse({
        ...spec,
        integrationBranches: [{ repoId: 1, branch: "" }],
      }).success,
    ).toBe(false);
  });
});
