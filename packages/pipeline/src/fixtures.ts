import type { Bundle } from "@afk/shared";

// A bundle as GET /worker/jobs/:id/bundle returns it, for tests.
export function bundleFor(
  over: Partial<Bundle> & { stage?: string } = {},
): Bundle {
  const { stage = "implement", ...rest } = over;
  return {
    job: { id: 7, stage, attempt: 1 },
    run: { id: 9, displayId: "R-9" },
    ticket: {
      id: 123,
      displayId: "T-123",
      type: "implementation",
      title: "Export orders as CSV",
      body: "Add GET /orders/export.",
      acceptanceCriteria: ["returns text/csv", "includes a header row"],
      modules: ["src/orders/**"],
      state: "running",
      contentVersion: 1,
      fixCounts: { "gate-fix": 0, "review-fix": 0, "merge-fix": 0 },
      reviewed: false,
      restart: false,
    },
    specTickets: [],
    spec: {
      id: 12,
      displayId: "S-12",
      slug: "order-export",
      title: "Order export",
      body: "# Order export\n\nCustomers want CSV.",
      type: "feature",
    },
    repo: {
      id: 1,
      role: "backend",
      url: "git@x:backend",
      defaultBranch: "main",
    },
    integrationBranch: "spec/order-export",
    protectedPaths: ["openapi/**", ".github/"],
    allowedProtectedPaths: [],
    contract: null,
    failureLog: null,
    review: null,
    ...rest,
  };
}
