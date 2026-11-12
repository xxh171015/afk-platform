import { describe, expect, it } from "vitest";
import { structuredBrief } from "./structured-brief.ts";
import { readTicketFiles } from "./ticket-files.ts";
import { BLOCKED_REASONS } from "./ticket-state.ts";

const source = (
  stage: string,
  output: unknown,
  over: Record<string, unknown> = {},
) => ({
  stage,
  result: null,
  output,
  run: { id: 7, displayId: "R-7" },
  ...over,
});

const ids = { specDisplayId: "S-19", ticketDisplayId: "T-12" };

describe("structuredBrief", () => {
  it("fills summary, step and recommended action from the reason code, without dumping JSON", () => {
    const brief = structuredBrief({
      reason: "agent-gave-up",
      ...ids,
      brief: source("implement", {
        status: "cannot-proceed",
        detail: "needs a decision",
      }),
    });
    expect(brief).toEqual({
      reason: "agent-gave-up",
      step: "implement",
      summary: "模型放弃",
      evidence: { lastLogLines: "needs a decision" },
      recommendedAction: "看它卡住的地方，带一句话说明后继续",
      commands: [
        {
          label: "带说明继续",
          command: 'plat ticket retry T-12 --mode continue --note "…"',
        },
      ],
    });
    expect(JSON.stringify(brief)).not.toContain("cannot-proceed");
  });

  it("omits evidence keys that have no value", () => {
    expect(
      structuredBrief({
        reason: "timeout",
        ...ids,
        brief: source("implement", null),
      }).evidence,
    ).toEqual({});
  });

  it("takes failing tests, command, conflict files and findings when they are present", () => {
    expect(
      structuredBrief({
        reason: "gate-failed",
        ...ids,
        brief: source("gate", {
          failureLog: "# test failed\nboom",
          reasons: ["test failed (exit 1)"],
          failingTests: ["exports csv"],
        }),
      }).evidence,
    ).toEqual({
      failingTests: ["exports csv"],
      command: "test failed (exit 1)",
      lastLogLines: "# test failed\nboom",
    });
    expect(
      structuredBrief({
        reason: "merge-conflict",
        ...ids,
        brief: source("merge", {
          failureLog: "# merge conflict\n\n- src/a.ts\n- src/b.ts\n",
        }),
      }).evidence,
    ).toEqual({
      lastLogLines: "# merge conflict\n\n- src/a.ts\n- src/b.ts\n",
      conflictFiles: ["src/a.ts", "src/b.ts"],
    });
    expect(
      structuredBrief({
        reason: "protected-path-changed",
        ...ids,
        brief: source("gate", { unapproved: [".github/ci.yml"] }),
      }).evidence,
    ).toEqual({ lastLogLines: ".github/ci.yml" });
    expect(
      structuredBrief({
        reason: "agent-gave-up",
        ...ids,
        brief: source("review", { findings: [{}, {}] }),
      }).evidence,
    ).toEqual({ findingsCount: 2 });
  });

  it("picks failing tests off an integration diagnosis when the output has none", () => {
    expect(
      structuredBrief({
        reason: "integration-loop-exceeded",
        ...ids,
        brief: source("e2e", null, {
          attempts: [
            {
              diagnosis: {
                failingTests: ["downloads the export"],
                evidence: "GET /orders 404",
              },
            },
          ],
        }),
      }).evidence,
    ).toEqual({
      failingTests: ["downloads the export"],
      lastLogLines: "GET /orders 404",
    });
  });

  it("gives gate-failed a continue retry with the ticket display id and a note placeholder", () => {
    expect(
      structuredBrief({
        reason: "gate-failed",
        ...ids,
        brief: source("gate", { failureLog: "boom" }),
      }).commands,
    ).toEqual([
      {
        label: "带说明继续",
        command: 'plat ticket retry T-12 --mode continue --note "…"',
      },
    ]);
  });

  it("gives tests-removed an approve command and no retry", () => {
    expect(
      structuredBrief({
        reason: "tests-removed",
        ...ids,
        brief: source("gate", {
          removedTests: [{ classname: "suite", name: "gone" }],
        }),
      }).commands,
    ).toEqual([
      {
        label: "批准删掉的测试",
        command: "plat ticket approve-removed-tests T-12",
      },
    ]);
  });

  it("gives wrap-up tests-removed a spec approve command", () => {
    expect(
      structuredBrief({
        reason: "tests-removed",
        specDisplayId: "S-19",
        wrapUpStep: "final-merge",
        brief: source("final-merge", null),
      }).commands,
    ).toEqual([
      {
        label: "批准删掉的测试",
        command: "plat spec approve-removed-tests S-19",
      },
    ]);
  });

  it("gives protected-path-changed an approve command and a retry", () => {
    expect(
      structuredBrief({
        reason: "protected-path-changed",
        ...ids,
        brief: source("gate", { unapproved: [".github/ci.yml"] }),
      }).commands,
    ).toEqual([
      {
        label: "批准保护路径",
        command: "plat ticket approve-protected T-12",
      },
      {
        label: "再重试",
        command: "plat ticket retry T-12 --mode continue",
      },
    ]);
  });

  it("gives contract-change-needed an import command and a ticket draft filled from the agent detail", () => {
    const brief = structuredBrief({
      reason: "contract-change-needed",
      ...ids,
      repo: "backend",
      contractBlockedBy: ["T-3"],
      brief: source("implement", {
        status: "cannot-proceed",
        blockedReason: "contract-change-needed",
        detail: "needs a new field on Order",
      }),
    });
    expect(brief.commands).toEqual([
      {
        label: "追加契约票",
        command:
          "plat tickets import S-19 ~/.afk/planning/S-19/append/ --append",
      },
    ]);
    expect(brief.ticketDraft).toBe(`---
title: 改契约以继续 T-12
repo: backend
type: contract
modules: ["**"]
blocked_by: [T-3]
blocks: [T-12]
---

## Parent

S-19

## What to build

needs a new field on Order

## Acceptance criteria

- [ ] 按 What to build 改契约，使 T-12 能继续
`);
  });

  it("fills a contract-change-needed draft from the Chinese summary when the agent left no detail", () => {
    const brief = structuredBrief({
      reason: "contract-change-needed",
      ...ids,
      repo: "backend",
      brief: source("implement", null),
    });
    expect(brief.ticketDraft).toContain("## What to build\n\n需要改契约\n");
    expect(brief.ticketDraft).not.toContain("blocked_by:");
  });

  it("produces a contract-change-needed draft the ticket-file reader accepts, with blocks on the stuck ticket", () => {
    const brief = structuredBrief({
      reason: "contract-change-needed",
      ...ids,
      repo: "backend",
      contractBlockedBy: ["T-3"],
      brief: source("implement", {
        status: "cannot-proceed",
        blockedReason: "contract-change-needed",
        detail: "needs a new field on Order",
      }),
    });
    const result = readTicketFiles(
      [{ name: "amend-contract.md", text: brief.ticketDraft ?? "" }],
      19,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.errors.join("\n"));
    expect(result.input.tickets[0]).toMatchObject({
      key: "amend-contract",
      type: "contract",
      title: "改契约以继续 T-12",
      repo: "backend",
      blocked_by: ["T-3"],
    });
    expect(result.input.tickets[0]?.body).toContain(
      "## What to build\n\nneeds a new field on Order\n",
    );
    expect(result.input.edges).toEqual([
      { from: "amend-contract", to: "T-12", kind: "blocks" },
    ]);
  });

  it("covers every blocked reason with a Chinese summary, recommended action and a command that names the ticket", () => {
    for (const reason of BLOCKED_REASONS) {
      const brief = structuredBrief({
        reason,
        ...ids,
        repo: "backend",
        brief: source("implement", null),
      });
      expect(brief.reason).toBe(reason);
      expect(brief.summary.length).toBeGreaterThan(0);
      expect(brief.summary).not.toBe(reason);
      expect(brief.recommendedAction.length).toBeGreaterThan(0);
      expect(brief.commands.length).toBeGreaterThan(0);
      expect(
        brief.commands.some(
          (item) =>
            item.command.includes("T-12") || item.command.includes("S-19"),
        ),
      ).toBe(true);
      for (const item of brief.commands) {
        expect(item.label.length).toBeGreaterThan(0);
        expect(item.command.length).toBeGreaterThan(0);
      }
    }
  });

  it("still builds a brief when there is no run, with empty evidence", () => {
    expect(
      structuredBrief({
        reason: "upstream-cancelled",
        ...ids,
        brief: null,
      }),
    ).toEqual({
      reason: "upstream-cancelled",
      step: "",
      summary: "上游已取消",
      evidence: {},
      recommendedAction: "取消这张票，或导入替代票",
      commands: [{ label: "取消这张票", command: "plat ticket cancel T-12" }],
    });
  });

  it("puts the remote tip and this round's start in the branch-moved brief", () => {
    expect(
      structuredBrief({
        reason: "branch-moved",
        ...ids,
        brief: source("implement", {
          error:
            "运行期间票分支被推过了\n远端 tip: aaa111\n本轮起点: bbb222\n! [rejected] (non-fast-forward)",
        }),
      }),
    ).toMatchObject({
      summary: "运行期间票分支被推过了",
      evidence: {
        lastLogLines:
          "运行期间票分支被推过了\n远端 tip: aaa111\n本轮起点: bbb222\n! [rejected] (non-fast-forward)",
      },
      commands: [
        {
          label: "从远端继续",
          command: "plat ticket retry T-12 --mode continue",
        },
      ],
    });
  });

  it("tells a person to raise the sandbox memory for sandbox-oom", () => {
    expect(
      structuredBrief({
        reason: "sandbox-oom",
        ...ids,
        brief: source("implement", {
          error: "sandbox-oom: container OOMKilled",
        }),
      }),
    ).toMatchObject({
      summary: "沙箱内存不足",
      recommendedAction: "把沙箱内存调大后再试",
      commands: [
        {
          label: "调大内存后重试",
          command: "plat ticket retry T-12 --mode continue",
        },
      ],
    });
  });

  it("gives a wrap-up step retry-final named with the spec", () => {
    expect(
      structuredBrief({
        reason: "job-failed",
        specDisplayId: "S-19",
        wrapUpStep: "final-review",
        brief: source("final-review", { error: "three" }),
      }).commands,
    ).toEqual([{ label: "再跑收尾", command: "plat spec retry-final S-19" }]);
  });

  it("gives a blocked final-e2e both retry-final and waive-final", () => {
    expect(
      structuredBrief({
        reason: "integration-loop-exceeded",
        specDisplayId: "S-19",
        wrapUpStep: "final-e2e",
        brief: source("e2e", null),
      }).commands,
    ).toEqual([
      { label: "再跑收尾", command: "plat spec retry-final S-19" },
      {
        label: "跳过联调仍然开 PR",
        command: "plat spec waive-final S-19",
      },
    ]);
  });
});
