import { describe, expect, it } from "vitest";
import {
  classifyLog,
  classifyLogLine,
  displayGrepPattern,
  displayPath,
  emptyLogCheckpoint,
  groupedLogFrom,
  groupLog,
  ingestLog,
  truncateLines,
} from "./log-actions.ts";

describe("classifyLogLine", () => {
  it("maps wrapping keys on a Cursor tool_call to 读取 / 修改 / 运行命令", () => {
    expect(
      classifyLogLine(
        JSON.stringify({
          type: "tool_call",
          tool_call: { readToolCall: { args: { path: "src/orders.ts" } } },
        }),
      ),
    ).toEqual({
      action: "读取",
      text: "src/orders.ts",
      raw: expect.stringContaining("readToolCall"),
    });
    expect(
      classifyLogLine(
        JSON.stringify({
          tool_call: { editToolCall: { args: { path: "src/a.ts" } } },
        }),
      ),
    ).toMatchObject({ action: "修改", text: "src/a.ts" });
    expect(
      classifyLogLine(
        JSON.stringify({
          tool_call: { shellToolCall: { args: { command: "pnpm test" } } },
        }),
      ),
    ).toMatchObject({ action: "运行命令", text: "pnpm test" });
    expect(
      classifyLogLine(
        JSON.stringify({
          tool_call: {
            globToolCall: { args: { globPattern: "**/*.ts" } },
          },
        }),
      ),
    ).toMatchObject({ action: "读取", text: "**/*.ts" });
    expect(
      classifyLogLine(
        JSON.stringify({
          tool_call: { grepToolCall: { args: { pattern: "batch-ship" } } },
        }),
      ),
    ).toMatchObject({ action: "读取", text: "batch-ship" });
    expect(
      classifyLogLine(
        JSON.stringify({
          tool_call: {
            grepToolCall: {
              args: { pattern: String.raw`it\.skip|describe\.only` },
            },
          },
        }),
      ),
    ).toMatchObject({ action: "读取", text: "it.skip|describe.only" });
  });

  it("maps an assistant event whose text is in message.content to agent 说明", () => {
    expect(
      classifyLogLine(
        JSON.stringify({
          type: "assistant",
          message: { content: "I will read the ticket first." },
        }),
      ),
    ).toMatchObject({
      action: "agent 说明",
      text: "I will read the ticket first.",
    });
    expect(
      classifyLogLine(
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text: "next I will edit" }] },
        }),
      ),
    ).toMatchObject({
      action: "agent 说明",
      text: "next I will edit",
    });
  });

  it("maps worker prefix lines to 运行命令", () => {
    for (const line of [
      "gate: test exit 1 (20 ms)",
      "implement: running the agent on agent/T-1",
      "e2e: compose up",
      "merge: conflict in src/a.ts",
      "environment: compose up backend",
      "result: implement done",
    ]) {
      expect(classifyLogLine(line)).toEqual({
        action: "运行命令",
        text: line,
        raw: null,
      });
    }
  });

  it("maps anything else to agent 说明, and keeps original JSON expandable", () => {
    const json = JSON.stringify({ type: "result", duration_ms: 12 });
    expect(classifyLogLine(json)).toEqual({
      action: "agent 说明",
      text: json,
      raw: json,
    });
    expect(classifyLogLine("plain thought")).toEqual({
      action: "agent 说明",
      text: "plain thought",
      raw: null,
    });
  });

  it("does not treat writeToolCall or a top-level name as a tool", () => {
    expect(
      classifyLogLine(
        JSON.stringify({
          name: "read_file",
          tool_call: { writeToolCall: { args: { path: "x" } } },
        }),
      ),
    ).toMatchObject({ action: "agent 说明" });
  });
});

describe("classifyLog", () => {
  it("splits the mixed file into one action per line and skips blanks", () => {
    const text = [
      "implement: running the agent on agent/T-1",
      JSON.stringify({
        tool_call: { readToolCall: { args: { path: "GLOSSARY.md" } } },
      }),
      "",
      JSON.stringify({
        type: "assistant",
        message: { content: "next I will edit" },
      }),
    ].join("\n");
    expect(
      classifyLog(text).map((line) => `${line.action}:${line.text}`),
    ).toEqual([
      "运行命令:implement: running the agent on agent/T-1",
      "读取:GLOSSARY.md",
      "agent 说明:next I will edit",
    ]);
  });
});

describe("groupLog", () => {
  it("merges thinking deltas into one thought and drops system and user events", () => {
    const text = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "s1" }),
      JSON.stringify({
        type: "user",
        session_id: "s1",
        message: { content: [{ type: "text", text: "the overlay prompt" }] },
      }),
      JSON.stringify({
        type: "thinking",
        subtype: "delta",
        text: "The",
        session_id: "s1",
        timestamp_ms: 1000,
      }),
      JSON.stringify({
        type: "thinking",
        subtype: "delta",
        text: " user",
        session_id: "s1",
        timestamp_ms: 1400,
      }),
      JSON.stringify({
        type: "thinking",
        subtype: "completed",
        session_id: "s1",
        timestamp_ms: 5000,
      }),
      JSON.stringify({
        type: "assistant",
        session_id: "s1",
        message: { content: "I will read the ticket first." },
      }),
      "",
    ].join("\n");
    const grouped = groupLog(text);
    expect(grouped.remainder).toBe("");
    expect(grouped.sessions).toHaveLength(1);
    expect(grouped.sessions[0]?.blocks.map((block) => block.kind)).toEqual([
      "thought",
      "assistant",
    ]);
    expect(grouped.sessions[0]?.blocks[0]).toMatchObject({
      title: "思考",
      body: "The user",
      durationMs: 4000,
    });
    expect(grouped.sessions[0]?.blocks[1]?.title).toBe(
      "I will read the ticket first.",
    );
    expect(JSON.stringify(grouped)).not.toContain("the overlay prompt");
    expect(JSON.stringify(grouped)).not.toContain('"type":"system"');
  });

  it("pairs tool_call started and completed by call_id and maps glob as 读取", () => {
    const text = [
      JSON.stringify({
        type: "tool_call",
        subtype: "started",
        call_id: "c1",
        session_id: "s1",
        tool_call: {
          readToolCall: {
            args: { path: "/home/agent/workspace/src/a.ts" },
          },
        },
      }),
      JSON.stringify({
        type: "tool_call",
        subtype: "completed",
        call_id: "c1",
        session_id: "s1",
        tool_call: {
          readToolCall: {
            args: { path: "/home/agent/workspace/src/a.ts" },
            result: { success: { content: "export const a = 1;\n" } },
          },
        },
      }),
      JSON.stringify({
        type: "tool_call",
        subtype: "completed",
        call_id: "c2",
        session_id: "s1",
        tool_call: {
          globToolCall: {
            args: { globPattern: "**/*", targetDirectory: "/context" },
            result: { success: { files: ["run.json", "spec.md"] } },
          },
        },
      }),
      JSON.stringify({
        type: "tool_call",
        subtype: "completed",
        call_id: "c3",
        session_id: "s1",
        tool_call: {
          shellToolCall: {
            description: "Check git history",
            args: { command: "git status" },
            result: { success: { stdout: "clean\n", stderr: "" } },
          },
        },
      }),
      "",
    ].join("\n");
    const blocks = groupLog(text).sessions[0]?.blocks ?? [];
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toMatchObject({
      kind: "tool",
      action: "读取",
      title: "src/a.ts",
      body: "export const a = 1;\n",
      completed: true,
    });
    expect(blocks[1]).toMatchObject({
      action: "读取",
      title: "**/*",
      body: "run.json\nspec.md",
    });
    expect(blocks[2]).toMatchObject({
      action: "运行命令",
      title: "Check git history",
      extra: "git status",
      body: "clean\n",
    });
  });

  it("shows a grep card title without regex escapes", () => {
    const text = `${JSON.stringify({
      type: "tool_call",
      subtype: "completed",
      call_id: "g1",
      session_id: "s1",
      tool_call: {
        grepToolCall: {
          args: {
            pattern: String.raw`\bany\b|@ts-ignore`,
            path: "/home/agent/workspace",
          },
          result: { success: { content: "src/a.ts:1:any" } },
        },
      },
    })}\n`;
    expect(groupLog(text).sessions[0]?.blocks[0]).toMatchObject({
      action: "读取",
      title: "any|@ts-ignore",
      extra: "workspace",
      body: "src/a.ts:1:any",
    });
  });

  function snapshot(grouped: ReturnType<typeof groupLog>) {
    return {
      remainder: grouped.remainder,
      before: grouped.before.map((block) => ({
        key: block.key,
        kind: block.kind,
        title: block.title,
        body: block.body,
        completed: block.completed,
      })),
      sessions: grouped.sessions.map((session) => ({
        id: session.id,
        blocks: session.blocks.map((block) => ({
          key: block.key,
          kind: block.kind,
          title: block.title,
          body: block.body,
          completed: block.completed,
        })),
      })),
      after: grouped.after.map((block) => ({
        key: block.key,
        kind: block.kind,
        title: block.title,
        body: block.body,
      })),
    };
  }

  it("groups the same blocks and keys when the log is fed in slices including a half line", () => {
    const started = JSON.stringify({
      type: "tool_call",
      subtype: "started",
      call_id: "c1",
      session_id: "s1",
      tool_call: {
        readToolCall: { args: { path: "/home/agent/workspace/src/a.ts" } },
      },
    });
    const completed = JSON.stringify({
      type: "tool_call",
      subtype: "completed",
      call_id: "c1",
      session_id: "s1",
      tool_call: {
        readToolCall: {
          args: { path: "/home/agent/workspace/src/a.ts" },
          result: { success: { content: "export const a = 1;\n" } },
        },
      },
    });
    const text = `${started}\n${completed}\n`;
    const full = groupLog(text);
    let checkpoint = emptyLogCheckpoint();
    const mid = Math.floor(text.length / 2);
    checkpoint = ingestLog(checkpoint, text.slice(0, mid));
    checkpoint = ingestLog(checkpoint, text.slice(mid), {
      flushRemainder: true,
    });
    expect(snapshot(groupedLogFrom(checkpoint))).toEqual(snapshot(full));
  });

  it("updates an existing tool card when the tool completes instead of adding another", () => {
    const started = `${JSON.stringify({
      type: "tool_call",
      subtype: "started",
      call_id: "c1",
      session_id: "s1",
      tool_call: {
        shellToolCall: { args: { command: "pnpm test" } },
      },
    })}\n`;
    const completed = `${JSON.stringify({
      type: "tool_call",
      subtype: "completed",
      call_id: "c1",
      session_id: "s1",
      tool_call: {
        shellToolCall: {
          args: { command: "pnpm test" },
          result: { success: { stdout: "ok\n" } },
        },
      },
    })}\n`;
    let checkpoint = emptyLogCheckpoint();
    checkpoint = ingestLog(checkpoint, started);
    const first = groupedLogFrom(checkpoint).sessions[0]?.blocks ?? [];
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      key: "tool-1",
      completed: false,
      title: "pnpm test",
    });
    checkpoint = ingestLog(checkpoint, completed);
    const next = groupedLogFrom(checkpoint).sessions[0]?.blocks ?? [];
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({
      key: "tool-1",
      completed: true,
      body: "ok\n",
    });
  });

  it("holds back a trailing incomplete line", () => {
    expect(groupLog('{"type":"assistant"').remainder).toBe(
      '{"type":"assistant"',
    );
    expect(groupLog('{"type":"assistant"').sessions).toEqual([]);
    const complete = JSON.stringify({
      type: "assistant",
      session_id: "s1",
      message: { content: "done" },
    });
    expect(groupLog(complete).sessions[0]?.blocks[0]?.title).toBe("done");
    expect(groupLog(complete, { flushRemainder: true }).remainder).toBe("");
    const grouped = groupLog(
      `${JSON.stringify({
        type: "assistant",
        session_id: "s1",
        message: { content: "hi" },
      })}\n{"partial`,
    );
    expect(grouped.remainder).toBe('{"partial');
    expect(grouped.sessions[0]?.blocks[0]?.title).toBe("hi");
  });

  it("folds gate dumps under --- name --- and keeps prefix lines as commands", () => {
    const text = [
      "gate: setup exit 0 (20 ms)",
      "--- setup ---",
      "added 96 packages",
      "npm notice",
      "--- test ---",
      "all tests passed",
      "result: gate passed",
      "",
    ].join("\n");
    const grouped = groupLog(text);
    expect(
      grouped.before.map((block) => `${block.kind}:${block.title}`),
    ).toEqual([
      "command:gate: setup exit 0 (20 ms)",
      "output:setup",
      "output:test",
      "command:result: gate passed",
    ]);
    expect(grouped.before[1]?.body).toContain("added 96 packages");
    expect(grouped.before[1]?.body).toContain("npm notice");
    expect(grouped.before[2]?.body).toBe("all tests passed");
  });

  it("splits review axes that share one file into Standards and Spec sessions", () => {
    const text = [
      JSON.stringify({
        type: "user",
        session_id: "std",
        message: {
          content: [
            { type: "text", text: "阶段：final-review，Standards 轴\n" },
          ],
        },
      }),
      JSON.stringify({
        type: "user",
        session_id: "spec",
        message: {
          content: [
            {
              type: "text",
              text: "阶段：final-review，Spec 轴\n只做 Spec 轴；编码规范是另一个审查者（Standards 轴）的事。\n",
            },
          ],
        },
      }),
      JSON.stringify({
        type: "thinking",
        subtype: "delta",
        text: "std-think",
        session_id: "std",
        timestamp_ms: 1,
      }),
      JSON.stringify({
        type: "thinking",
        subtype: "delta",
        text: "spec-think",
        session_id: "spec",
        timestamp_ms: 2,
      }),
      JSON.stringify({
        type: "thinking",
        subtype: "completed",
        session_id: "std",
        timestamp_ms: 3,
      }),
      JSON.stringify({
        type: "thinking",
        subtype: "completed",
        session_id: "spec",
        timestamp_ms: 4,
      }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        session_id: "std",
        duration_ms: 12_000,
      }),
      "",
    ].join("\n");
    const grouped = groupLog(text);
    expect(grouped.sessions.map((session) => session.label)).toEqual([
      "Standards",
      "Spec",
    ]);
    expect(grouped.sessions[0]?.blocks[0]?.body).toBe("std-think");
    expect(grouped.sessions[1]?.blocks[0]?.body).toBe("spec-think");
    expect(grouped.sessions[0]?.durationMs).toBe(12_000);
  });

  it("does not put a cut JSON line in the title", () => {
    const grouped = groupLog(
      'implement: running\n{"type":"tool_call", [line cut]\n',
    );
    expect(
      grouped.before.map((block) => `${block.title}:${block.raw !== null}`),
    ).toEqual(["implement: running:false", "截断的事件:true"]);
  });
});

describe("displayPath and truncateLines", () => {
  it("strips the sandbox workspace prefix", () => {
    expect(displayPath("/home/agent/workspace/src/a.ts")).toBe("src/a.ts");
    expect(displayPath("/home/agent/.cursor/skills/x/SKILL.md")).toBe(
      ".cursor/skills/x/SKILL.md",
    );
  });

  it("drops regex escapes from a grep title", () => {
    expect(
      displayGrepPattern(
        String.raw`it\.skip|describe\.skip|it\.only|describe\.only`,
      ),
    ).toBe("it.skip|describe.skip|it.only|describe.only");
    expect(
      displayGrepPattern(String.raw`\bany\b|@ts-ignore|@ts-expect-error`),
    ).toBe("any|@ts-ignore|@ts-expect-error");
  });

  it("counts hidden lines past the cap", () => {
    expect(truncateLines("a\nb\nc", 2)).toEqual({
      visible: "a\nb",
      hidden: 1,
    });
  });
});
