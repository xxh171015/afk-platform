import { describe, expect, it } from "vitest";
import { classifyLogLine, runDetailHref } from "@/lib/view-map";

describe("log action mapping", () => {
  it("maps read_file tool calls to 读取", () => {
    expect(classifyLogLine(JSON.stringify({
      type: "tool_call",
      name: "read_file",
      arguments: { path: "src/checkout/CheckoutNote.tsx" },
      summary: "读取结算页备注组件",
    }))).toEqual({
      action: "读取",
      summary: "读取结算页备注组件",
    });
  });

  it("maps write and strreplace tool calls to 修改", () => {
    expect(classifyLogLine(JSON.stringify({ type: "tool_call", name: "write", arguments: { path: "a.ts" }, summary: "写入 a.ts" })).action).toBe("修改");
    expect(classifyLogLine(JSON.stringify({ type: "tool_call", name: "strreplace", summary: "替换 CheckoutNote" })).action).toBe("修改");
  });

  it("maps shell lines and bash tool calls to 运行命令", () => {
    expect(classifyLogLine("$ pnpm vitest run --reporter=dot").action).toBe("运行命令");
    expect(classifyLogLine(JSON.stringify({ type: "tool_call", name: "bash", summary: "pnpm test" })).action).toBe("运行命令");
  });

  it("maps assistant text to agent 说明", () => {
    expect(classifyLogLine(JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "开始实现" }] },
    })).action).toBe("agent 说明");
  });
});

describe("Run deep links", () => {
  it("sends R-n searches to the Run page, not the ticket page", () => {
    expect(runDetailHref("run_480")).toBe("/runs/run_480");
  });
});