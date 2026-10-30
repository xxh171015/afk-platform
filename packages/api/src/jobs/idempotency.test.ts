import { describe, expect, it } from "vitest";
import { ticketJobKey } from "./idempotency.ts";

describe("ticketJobKey", () => {
  const base = {
    ticketId: 1,
    contentVersion: 2,
    stage: "implement",
    sequence: 1,
  };

  it("spells the (ticket, content version, stage, sequence) tuple with the ticket's display id", () => {
    expect(ticketJobKey(base)).toBe("T-1:2:implement:1");
  });

  it.each([
    { ticketId: 2 },
    { contentVersion: 3 },
    { stage: "gate-fix" },
    { sequence: 2 },
  ])("changing %j makes a different key", (change) => {
    expect(ticketJobKey({ ...base, ...change })).not.toBe(ticketJobKey(base));
  });

  it("refuses parts that would make two different tuples collide", () => {
    expect(() => ticketJobKey({ ...base, stage: "a:b" })).toThrow();
    expect(() => ticketJobKey({ ...base, contentVersion: 0 })).toThrow();
    expect(() => ticketJobKey({ ...base, sequence: 1.5 })).toThrow();
  });
});
