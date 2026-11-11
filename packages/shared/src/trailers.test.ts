import { describe, expect, it } from "vitest";
import { parseTrailers } from "./trailers.ts";

describe("parseTrailers", () => {
  it("reads Spec, Ticket and Run from anywhere in the message", () => {
    expect(
      parseTrailers(
        "work\n\nSpec: S-12\nTicket: T-123\nRun: R-456\nCo-authored-by: Cursor <c@x>",
      ),
    ).toEqual({ spec: "S-12", ticket: "T-123", run: "R-456" });
  });

  it("still finds a trailer moved into the middle of the body", () => {
    expect(parseTrailers("Spec: S-1\n\n## Tickets\n- T-1 done")).toEqual({
      spec: "S-1",
    });
  });

  it("takes the last Spec, Ticket or Run when more than one is present", () => {
    expect(
      parseTrailers("Spec: S-1\nTicket: T-1\n\nSpec: S-2\nTicket: T-2"),
    ).toEqual({ spec: "S-2", ticket: "T-2" });
  });
});
