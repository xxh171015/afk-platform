import { describe, expect, it } from "vitest";
import { PAGE_PATHS, paths } from "./paths.ts";

describe("shareable addresses", () => {
  it("lists the control-tower paths, none of them a hash", () => {
    expect(PAGE_PATHS).toEqual([
      "/",
      "/waiting",
      "/specs",
      "/specs/$specId",
      "/tickets/$ticketId",
    ]);
    expect(paths.spec(3)).toBe("/specs/3");
    expect(paths.ticket(9)).toBe("/tickets/9");
    expect(PAGE_PATHS.every((path) => !path.startsWith("#"))).toBe(true);
  });
});
