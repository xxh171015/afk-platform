import { describe, expect, it } from "vitest";
import { createSeed } from "@/api/mock/seed";
import { structuredBrief, ticketToBriefInput } from "@/lib/view-map";

describe("ticket brief evidence", () => {
  it("extracts T-103 failures, command and stage from the ticket DTO", () => {
    const ticket = createSeed().tickets.find(t => t.id === "tkt_103");
    if (!ticket) throw new Error("Missing T-103");
    const input = ticketToBriefInput(ticket);
    if (!input) throw new Error("Missing brief");
    expect(input.reason).toBe("gate-failed");
    expect(input.stage).toBe(ticket.blockedRun?.stage);
    expect(input.failingTests).toHaveLength(2);
    expect(input.command).toBe("pnpm vitest run --reporter=dot");
    expect(input.lastLogLines?.split("\n").length).toBeLessThanOrEqual(30);
    expect(structuredBrief(input).evidence).not.toHaveProperty("conflictFiles");
  });
  it("preserves T-105 protected paths and positive unhandled finding count", () => {
    const ticket = createSeed().tickets.find(t => t.id === "tkt_105");
    if (!ticket) throw new Error("Missing T-105");
    const input = ticketToBriefInput(ticket, { findingsCount: 2 });
    if (!input) throw new Error("Missing brief");
    expect(structuredBrief(input).evidence.conflictFiles).toEqual(["config/security/sensitive-words.yaml", "migrations/**"]);
    expect(structuredBrief(input).evidence.findingsCount).toBe(2);
    expect(input.conflictFiles).not.toBe(ticket.protectedPaths);
  });
  it("returns no brief for an unblocked ticket and omits zero finding evidence", () => {
    const ticket = createSeed().tickets.find(t => t.id === "tkt_103");
    if (!ticket) throw new Error("Missing T-103");
    expect(ticketToBriefInput({ ...ticket, blockedReason: null })).toBeNull();
    expect(structuredBrief({ reason: "timeout", stage: "implement", findingsCount: 0 }).evidence).toEqual({});
  });
});