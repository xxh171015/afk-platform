import { describe, expect, it } from "vitest";
import { PAGE_PATHS, paths } from "./paths.ts";

describe("shareable addresses", () => {
  it("lists the control-tower paths, none of them a hash", () => {
    expect(PAGE_PATHS).toEqual([
      "/",
      "/waiting",
      "/specs",
      "/specs/$specId",
      "/specs/$specId/description",
      "/specs/$specId/tickets",
      "/specs/$specId/delivery",
      "/specs/$specId/timeline",
      "/tickets/$ticketId",
    ]);
    expect(paths.spec(3)).toBe("/specs/3");
    expect(paths.specDescription(3)).toBe("/specs/3/description");
    expect(paths.specTickets(3)).toBe("/specs/3/tickets");
    expect(paths.specDelivery(3)).toBe("/specs/3/delivery");
    expect(paths.specTimeline(3)).toBe("/specs/3/timeline");
    expect(paths.ticket(9)).toBe("/tickets/9");
    expect(paths.run(4)).toBe("/runs/4");
    expect(PAGE_PATHS.every((path) => !path.startsWith("#"))).toBe(true);
  });
});
