import { QueryClient } from "@tanstack/react-query";
import { createRouter, rootRouteId } from "@tanstack/react-router";
import { describe, expect, it } from "vitest";

import { routeTree } from "@/routeTree.gen";

// Match routes without running loaders or rendering: loaders may need a server or
// network the test run lacks, and jsdom never loads the stylesheets React waits on.
describe("App routing", () => {
  it("matches the standalone failed implement Run page", () => {
    const router = createRouter({ routeTree, context: { queryClient: new QueryClient() } });
    expect(router.matchRoutes("/runs/run_t103_impl_fail").at(-1)?.routeId).toBe("/runs/$id");
  });
  it("matches all five shareable spec sections beneath the spec layout", () => {
    const router = createRouter({ routeTree, context: { queryClient: new QueryClient() } });
    for (const [url, leaf] of [
      ["/specs/spec_12", "/specs/$id/"],
      ["/specs/spec_12/description", "/specs/$id/description"],
      ["/specs/spec_12/tickets", "/specs/$id/tickets"],
      ["/specs/spec_12/delivery", "/specs/$id/delivery"],
      ["/specs/spec_12/timeline", "/specs/$id/timeline"],
    ]) {
      const matches = router.matchRoutes(url ?? "");
      expect(matches.at(-1)?.routeId).toBe(leaf);
      expect(matches.some(m => m.routeId === "/specs/$id")).toBe(true);
    }
  });
  it("matches a page for / instead of falling back to not found", () => {
    const router = createRouter({ routeTree, context: { queryClient: new QueryClient() } });

    const matches = router.matchRoutes("/");

    expect(matches.at(-1)?.routeId).not.toBe(rootRouteId);
  });
});
