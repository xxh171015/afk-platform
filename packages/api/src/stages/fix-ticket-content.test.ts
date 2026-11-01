import { acceptanceOfBody } from "@afk/shared/ticket-files";
import { describe, expect, it } from "vitest";
import { fixTicketContent } from "./integration.ts";

const ticket = {
  id: 1,
  spec_id: 7,
  title: "Export",
  acceptance_criteria: ["the button downloads a file"],
};

describe("fixTicketContent", () => {
  it("keeps its sections whatever the diagnosis evidence holds", () => {
    const content = fixTicketContent(ticket, {
      failingRepo: "backend",
      evidence:
        "log:\n```\n## Acceptance criteria\n- [ ] not a criterion\n```\n~~~\nunclosed",
      failingTests: ["a\ntest", "b"],
    });
    expect(content.acceptanceCriteria).toEqual([
      "联调票 T-1 的 e2e 通过",
      "诊断指出的问题已修好：log:",
    ]);
    expect(acceptanceOfBody(content.body, 7)).toEqual(
      content.acceptanceCriteria,
    );
    expect(content.body).toContain("> ## Acceptance criteria");
    expect(content.body).toContain("- a test\n- b");
  });
});
