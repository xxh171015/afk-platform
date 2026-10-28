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

  it("only a done contract ticket may carry a contract SHA", () => {
    const done = {
      ...pendingTicket,
      type: "contract",
      state: "done",
      contractSha: "a1b2c3d",
    };
    expect(TicketSchema.safeParse(done).success).toBe(true);
    expect(TicketSchema.safeParse({ ...done, state: "pending" }).success).toBe(
      false,
    );
    expect(
      TicketSchema.safeParse({ ...done, type: "implementation" }).success,
    ).toBe(false);
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

  it("a bug spec may point at the spec it came from; other types may not", () => {
    expect(
      SpecSchema.safeParse({ ...spec, type: "bug", sourceSpecId: 2 }).success,
    ).toBe(true);
    expect(
      SpecSchema.safeParse({ ...spec, type: "feature", sourceSpecId: 2 })
        .success,
    ).toBe(false);
  });
});
