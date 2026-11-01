// Map one Run log file (Cursor NDJSON mixed with worker stageLog lines) onto the four actions
// the page shows (docs/specs/experience-platform.md「Run 日志」). Wrapping keys, not the prototype's
// top-level name / writeToolCall.

export const LOG_ACTIONS = ["读取", "修改", "运行命令", "agent 说明"] as const;
export type LogAction = (typeof LOG_ACTIONS)[number];

export interface LogLine {
  action: LogAction;
  text: string;
  raw: string | null;
  seq: number;
}

const WORKER_PREFIX =
  /^(gate|implement|e2e|merge|environment|result|review|restart|failed):/;

export function classifyLogLine(line: string): Omit<LogLine, "seq"> {
  if (WORKER_PREFIX.test(line)) {
    return { action: "运行命令", text: line, raw: null };
  }
  const parsed = parseJsonObject(line);
  if (!parsed) {
    return { action: "agent 说明", text: line, raw: null };
  }
  const tool = parsed.tool_call;
  if (tool && typeof tool === "object") {
    const call = tool as Record<string, unknown>;
    if ("readToolCall" in call) {
      return {
        action: "读取",
        text: toolSummary(call.readToolCall, ["path"]),
        raw: line,
      };
    }
    if ("editToolCall" in call) {
      return {
        action: "修改",
        text: toolSummary(call.editToolCall, ["path"]),
        raw: line,
      };
    }
    if ("shellToolCall" in call) {
      return {
        action: "运行命令",
        text: toolSummary(call.shellToolCall, ["command"]),
        raw: line,
      };
    }
  }
  if (parsed.type === "assistant" || parsed.role === "assistant") {
    const text = textInMessage(parsed.message);
    if (text !== undefined) {
      return { action: "agent 说明", text, raw: line };
    }
  }
  return { action: "agent 说明", text: line, raw: line };
}

export function classifyLog(text: string): LogLine[] {
  if (text === "") return [];
  let seq = 0;
  return text.split("\n").flatMap((line) => {
    if (line === "") return [];
    seq += 1;
    return [{ ...classifyLogLine(line), seq }];
  });
}

function textInMessage(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string" && content !== "") return content;
  if (!Array.isArray(content)) return undefined;
  const chunks: string[] = [];
  for (const part of content) {
    if (typeof part === "string") chunks.push(part);
    else if (
      part &&
      typeof part === "object" &&
      typeof (part as { text?: unknown }).text === "string"
    ) {
      chunks.push((part as { text: string }).text);
    }
  }
  const text = chunks.join("");
  return text === "" ? undefined : text;
}

function parseJsonObject(line: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(line);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function toolSummary(call: unknown, preferred: readonly string[]): string {
  if (!call || typeof call !== "object") return "";
  const record = call as Record<string, unknown>;
  const args =
    record.args &&
    typeof record.args === "object" &&
    !Array.isArray(record.args)
      ? (record.args as Record<string, unknown>)
      : undefined;
  for (const key of preferred) {
    const value = record[key] ?? args?.[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return JSON.stringify(call);
}
