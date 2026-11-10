import { describe, expect, it } from "vitest";
import {
  branchNames,
  isPlatformBranch,
  parseTicketBranch,
} from "./branches.ts";

describe("branch names", () => {
  it("puts the database's id in the names of a new spec, so two databases never make the same branch", () => {
    const a = branchNames("a1b2c3");
    const b = branchNames("0f9e8d");
    expect(a.integration("export")).toBe("spec/a1b2c3/export");
    expect(a.ticket("T-5")).toBe("agent/a1b2c3/T-5");
    expect(a.final("S-2")).toBe("agent/a1b2c3/S-2-final");
    expect(a.update("S-2")).toBe("agent/a1b2c3/S-2-update");
    expect(b.ticket("T-5")).not.toBe(a.ticket("T-5"));
    expect(b.integration("export")).not.toBe(a.integration("export"));
  });

  it("keeps the old names for a spec that was made before the ids existed", () => {
    const old = branchNames(null);
    expect(old.integration("export")).toBe("spec/export");
    expect(old.ticket("T-5")).toBe("agent/T-5");
    expect(old.final("S-2")).toBe("agent/S-2-final");
    expect(old.update("S-2")).toBe("agent/S-2-update");
  });
});

describe("isPlatformBranch", () => {
  it.each([
    "spec/export",
    "spec/stale-worker-drill-3",
    "spec/a1b2c3/export",
    "agent/T-5",
    "agent/S-2-final",
    "agent/S-2-update",
    "agent/a1b2c3/T-5",
    "agent/a1b2c3/S-2-final",
    "agent/a1b2c3/S-2-update",
  ])("accepts %s", (name) => {
    expect(isPlatformBranch(name)).toBe(true);
  });

  it.each([
    "main",
    "release/1.0",
    "docs/agent-setup",
    "spec/",
    "spec/Export",
    "spec/a1b2c3/",
    "spec/a1b2c3/a/b",
    "agent/T-0",
    "agent/T-05",
    "agent/a1b2c/T-5", // an id is six hex digits
    "agent/a1b2c3d/T-5",
    "agent/A1B2C3/T-5",
    "agent/a1b2c3/T-5/extra",
    "agent/x/T-5",
    "refs/heads/spec/export",
    "../spec/export",
  ])("refuses %s", (name) => {
    expect(isPlatformBranch(name)).toBe(false);
  });
});

describe("parseTicketBranch", () => {
  it("names the ticket or the overall fix a branch belongs to, with or without the id", () => {
    expect(parseTicketBranch("agent/T-12")).toBe("T-12");
    expect(parseTicketBranch("agent/a1b2c3/T-12")).toBe("T-12");
    expect(parseTicketBranch("agent/S-3-final")).toBe("S-3-final");
    expect(parseTicketBranch("agent/a1b2c3/S-3-final")).toBe("S-3-final");
    expect(parseTicketBranch("agent/S-3-update")).toBe("S-3-update");
    expect(parseTicketBranch("agent/a1b2c3/S-3-update")).toBe("S-3-update");
  });

  it("is undefined for anything else", () => {
    expect(parseTicketBranch("spec/export")).toBeUndefined();
    expect(parseTicketBranch("agent/T-0")).toBeUndefined();
    expect(parseTicketBranch("main")).toBeUndefined();
  });
});
