import { describe, expect, it } from "vitest";
import { classifyLog, classifyLogLine } from "./log-actions.ts";

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
