// Map one Run log file (Cursor NDJSON mixed with worker stageLog lines) onto the cards the page shows
// (docs/specs/experience-platform.md「Run 日志」). Wrapping keys, not the prototype's top-level name / writeToolCall.
// groupLog is the view mapping: thinking is merged, tool_call started/completed are paired, system/user are dropped,
// and review axes that share one file are split by session_id.

export const LOG_ACTIONS = ["读取", "修改", "运行命令", "agent 说明"] as const;
export type LogAction = (typeof LOG_ACTIONS)[number];

export const LOG_OUTPUT_MAX_LINES = 20;
export const LOG_THOUGHT_MAX_LINES = 8;

export interface LogLine {
  action: LogAction;
  text: string;
  raw: string | null;
  seq: number;
}

export type LogBlockKind =
  | "thought"
  | "tool"
  | "assistant"
  | "command"
  | "output";

export interface LogBlock {
  key: string;
  kind: LogBlockKind;
  action: LogAction;
  title: string;
  body: string;
  extra: string | null;
  durationMs: number | null;
  completed: boolean;
  raw: string | null;
}

export interface LogSession {
  id: string;
  label: string;
  durationMs: number | null;
  blocks: LogBlock[];
}

export interface GroupedLog {
  remainder: string;
  before: LogBlock[];
  sessions: LogSession[];
  after: LogBlock[];
}

const WORKER_PREFIX =
  /^(gate-fix|review-fix|merge-fix|final-review|final-fix|final-e2e|update-branch|gate|implement|e2e|merge|environment|result|review|restart|failed|diagnose):/;

const DUMP_HEADER = /^--- (.+) ---$/;

const TOOL_META = new Set([
  "hookAdditionalContexts",
  "toolCallId",
  "startedAtMs",
  "completedAtMs",
]);

const HIDDEN_TYPES = new Set([
  "system",
  "user",
  "retry",
  "connection",
  "interaction_query",
]);

const HIDDEN_WRAP = new Set(["getMcpToolsToolCall"]);

const READ_WRAP = new Set([
  "readToolCall",
  "globToolCall",
  "grepToolCall",
  "lsToolCall",
  "semSearchToolCall",
  "deleteToolCall",
]);

const WORKSPACE = "/home/agent/workspace/";
const AGENT_HOME = "/home/agent/";

export function displayPath(path: string): string {
  if (path.startsWith(WORKSPACE)) return path.slice(WORKSPACE.length);
  if (path.startsWith(AGENT_HOME)) return path.slice(AGENT_HOME.length);
  return path;
}

export function displayGrepPattern(pattern: string): string {
  return pattern
    .replace(/\\[bB]/g, "")
    .replace(/\\([\\/.*+?^${}()|[\]-])/g, "$1");
}

export function truncateLines(
  text: string,
  max: number,
): { visible: string; hidden: number } {
  if (text === "") return { visible: "", hidden: 0 };
  const lines = text.split("\n");
  if (lines.length <= max) return { visible: text, hidden: 0 };
  return {
    visible: lines.slice(0, max).join("\n"),
    hidden: lines.length - max,
  };
}

export function classifyLogLine(line: string): Omit<LogLine, "seq"> {
  if (WORKER_PREFIX.test(line)) {
    return { action: "运行命令", text: line, raw: null };
  }
  const parsed = parseJsonObject(line);
  if (!parsed) {
    return { action: "agent 说明", text: line, raw: null };
  }
  const wrap = wrappingKey(parsed.tool_call);
  if (wrap === "readToolCall" || READ_WRAP.has(wrap ?? "")) {
    return {
      action: "读取",
      text: toolSummary(
        wrapValue(parsed.tool_call, wrap),
        preferredFields(wrap),
      ),
      raw: line,
    };
  }
  if (wrap === "editToolCall") {
    return {
      action: "修改",
      text: toolSummary(wrapValue(parsed.tool_call, wrap), ["path"]),
      raw: line,
    };
  }
  if (wrap === "shellToolCall") {
    return {
      action: "运行命令",
      text: toolSummary(wrapValue(parsed.tool_call, wrap), ["command"]),
      raw: line,
    };
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

export function groupLog(
  text: string,
  options: { flushRemainder?: boolean } = {},
): GroupedLog {
  const { lines, remainder } = completeLines(text, options.flushRemainder);
  const sessions = new Map<string, SessionState>();
  const sessionOrder: string[] = [];
  const before: LogBlock[] = [];
  const after: LogBlock[] = [];
  let seenCursor = false;
  let dump: { title: string; body: string[] } | null = null;
  let nextKey = 0;
  const key = (prefix: string) => {
    nextKey += 1;
    return `${prefix}-${nextKey}`;
  };

  const bucket = () => (seenCursor ? after : before);

  const flushDump = () => {
    if (!dump) return;
    bucket().push({
      key: key("output"),
      kind: "output",
      action: "运行命令",
      title: dump.title,
      body: dump.body.join("\n").replace(/\n+$/, ""),
      extra: null,
      durationMs: null,
      completed: true,
      raw: null,
    });
    dump = null;
  };

  for (const line of lines) {
    const parsed = parseJsonObject(line);
    if (parsed) {
      flushDump();
      seenCursor = true;
      ingestCursor(parsed, line, sessions, sessionOrder, key);
      continue;
    }
    if (line === "") {
      if (dump) dump.body.push("");
      continue;
    }
    const dumpTitle = DUMP_HEADER.exec(line)?.[1];
    if (dumpTitle !== undefined) {
      flushDump();
      dump = { title: dumpTitle, body: [] };
      continue;
    }
    if (WORKER_PREFIX.test(line)) {
      flushDump();
      bucket().push({
        key: key("command"),
        kind: "command",
        action: "运行命令",
        title: line,
        body: "",
        extra: null,
        durationMs: null,
        completed: true,
        raw: null,
      });
      continue;
    }
    if (dump) {
      dump.body.push(line);
      continue;
    }
    // A raw line cut at 16 KiB is not valid JSON; don't put the blob in the title.
    if (line.startsWith("{") || line.startsWith("[")) {
      bucket().push({
        key: key("cut"),
        kind: "assistant",
        action: "agent 说明",
        title: "截断的事件",
        body: "",
        extra: null,
        durationMs: null,
        completed: true,
        raw: line,
      });
      continue;
    }
    bucket().push({
      key: key("note"),
      kind: "assistant",
      action: "agent 说明",
      title: line,
      body: "",
      extra: null,
      durationMs: null,
      completed: true,
      raw: null,
    });
  }
  flushDump();
  for (const session of sessions.values()) flushThought(session, key);

  return {
    remainder,
    before,
    sessions: sessionOrder.map((id) => {
      const session = sessions.get(id) as SessionState;
      return {
        id,
        label: session.label,
        durationMs: session.durationMs,
        blocks: session.blocks,
      };
    }),
    after,
  };
}

interface SessionState {
  id: string;
  label: string;
  durationMs: number | null;
  blocks: LogBlock[];
  openThought: {
    text: string;
    startMs: number | null;
    endMs: number | null;
    raw: string[];
  } | null;
  tools: Map<string, LogBlock>;
}

function ingestCursor(
  parsed: Record<string, unknown>,
  line: string,
  sessions: Map<string, SessionState>,
  sessionOrder: string[],
  key: (prefix: string) => string,
): void {
  const sessionId =
    typeof parsed.session_id === "string" && parsed.session_id !== ""
      ? parsed.session_id
      : "_";
  const session = sessionOf(sessions, sessionOrder, sessionId);
  const type = typeof parsed.type === "string" ? parsed.type : "";

  if (type === "user") {
    const text = textInMessage(parsed.message) ?? "";
    const label = axisLabelFromPrompt(text);
    if (label && session.label === "") session.label = label;
    return;
  }
  if (HIDDEN_TYPES.has(type)) return;

  if (type === "result") {
    flushThought(session, key);
    const duration = numberish(parsed.duration_ms);
    if (duration !== null) session.durationMs = duration;
    return;
  }

  if (type === "thinking") {
    appendThought(session, parsed, line);
    if (parsed.subtype === "completed") flushThought(session, key);
    return;
  }

  const wrap = wrappingKey(parsed.tool_call);
  if (wrap && HIDDEN_WRAP.has(wrap)) return;
  if (wrap === undefined && parsed.tool_call) return;

  flushThought(session, key);

  if (wrap) {
    ingestTool(session, parsed, wrap, line, key);
    return;
  }

  if (type === "assistant" || parsed.role === "assistant") {
    const text = textInMessage(parsed.message);
    if (text !== undefined) {
      session.blocks.push({
        key: key("assistant"),
        kind: "assistant",
        action: "agent 说明",
        title: text,
        body: "",
        extra: null,
        durationMs: null,
        completed: true,
        raw: line,
      });
    }
    return;
  }

  session.blocks.push({
    key: key("other"),
    kind: "assistant",
    action: "agent 说明",
    title: line,
    body: "",
    extra: null,
    durationMs: null,
    completed: true,
    raw: line,
  });
}

function ingestTool(
  session: SessionState,
  parsed: Record<string, unknown>,
  wrap: string,
  line: string,
  key: (prefix: string) => string,
): void {
  const callId =
    typeof parsed.call_id === "string" && parsed.call_id !== ""
      ? parsed.call_id
      : key("call");
  const inner = wrapValue(parsed.tool_call, wrap);
  const fields = toolFields(wrap, inner);
  const started = parsed.subtype === "started";
  const completed = parsed.subtype === "completed" || parsed.subtype == null;
  const existing = session.tools.get(callId);
  if (existing) {
    existing.raw = joinRaw(existing.raw, line);
    if (fields.title) existing.title = fields.title;
    if (fields.extra) existing.extra = fields.extra;
    if (fields.body) existing.body = fields.body;
    if (completed) existing.completed = true;
    return;
  }
  const block: LogBlock = {
    key: key("tool"),
    kind: wrap === "updateTodosToolCall" ? "assistant" : "tool",
    action: actionForWrap(wrap),
    title: fields.title,
    body: fields.body,
    extra: fields.extra,
    durationMs: toolDurationMs(inner),
    completed,
    raw: line,
  };
  session.tools.set(callId, block);
  session.blocks.push(block);
  if (started && !completed) block.completed = false;
}

function sessionOf(
  sessions: Map<string, SessionState>,
  sessionOrder: string[],
  id: string,
): SessionState {
  const existing = sessions.get(id);
  if (existing) return existing;
  const created: SessionState = {
    id,
    label: "",
    durationMs: null,
    blocks: [],
    openThought: null,
    tools: new Map(),
  };
  sessions.set(id, created);
  sessionOrder.push(id);
  return created;
}

function appendThought(
  session: SessionState,
  parsed: Record<string, unknown>,
  line: string,
): void {
  const ts = numberish(parsed.timestamp_ms);
  if (!session.openThought) {
    session.openThought = {
      text: "",
      startMs: ts,
      endMs: ts,
      raw: [],
    };
  }
  const thought = session.openThought;
  thought.raw.push(line);
  if (typeof parsed.text === "string") thought.text += parsed.text;
  if (ts !== null) {
    if (thought.startMs === null) thought.startMs = ts;
    thought.endMs = ts;
  }
}

function flushThought(
  session: SessionState,
  key: (prefix: string) => string,
): void {
  const thought = session.openThought;
  if (!thought) return;
  session.openThought = null;
  if (thought.text === "" && thought.raw.length === 0) return;
  const durationMs =
    thought.startMs !== null && thought.endMs !== null
      ? Math.max(0, thought.endMs - thought.startMs)
      : null;
  session.blocks.push({
    key: key("thought"),
    kind: "thought",
    action: "agent 说明",
    title: "思考",
    body: thought.text,
    extra: null,
    durationMs,
    completed: true,
    raw: thought.raw.join("\n"),
  });
}

function toolFields(
  wrap: string,
  inner: unknown,
): { title: string; body: string; extra: string | null } {
  const record = asRecord(inner) ?? {};
  const args = asRecord(record.args);
  const result = asRecord(record.result);
  const success = asRecord(result?.success);
  const errorText = errorMessage(result?.error ?? result);
  const description =
    str(record.description) ?? (args ? str(args.description) : undefined);

  if (wrap === "shellToolCall") {
    const command = str(args?.command) ?? "";
    const body =
      str(success?.interleavedOutput) ??
      [str(success?.stdout), str(success?.stderr)].filter(Boolean).join("\n") ??
      errorText ??
      "";
    return {
      title: description || command || "运行命令",
      body,
      extra: command || null,
    };
  }
  if (wrap === "editToolCall") {
    const path = displayPath(str(args?.path) ?? str(success?.path) ?? "");
    const added = numberish(success?.linesAdded);
    const removed = numberish(success?.linesRemoved);
    const extra =
      added !== null || removed !== null
        ? `+${added ?? 0} −${removed ?? 0}`
        : null;
    return {
      title: path || "修改",
      body: str(success?.diffString) ?? errorText ?? "",
      extra,
    };
  }
  if (wrap === "updateTodosToolCall") {
    return {
      title: "待办",
      body: todosText(args?.todos ?? success?.todos),
      extra: null,
    };
  }
  if (wrap === "globToolCall") {
    const pattern = str(args?.globPattern) ?? "";
    const files = success?.files;
    const body = Array.isArray(files)
      ? files.map((item) => String(item)).join("\n")
      : (errorText ?? "");
    return { title: pattern || "glob", body, extra: null };
  }
  if (wrap === "grepToolCall") {
    const pattern = str(args?.pattern) ?? "";
    return {
      title: (pattern ? displayGrepPattern(pattern) : "") || "grep",
      body: str(success?.content) ?? errorText ?? "",
      extra: args ? displayPath(str(args.path) ?? "") || null : null,
    };
  }
  const path = displayPath(
    str(args?.path) ?? str(args?.query) ?? str(success?.path) ?? "",
  );
  return {
    title: path || wrappingTitle(wrap),
    body: str(success?.content) ?? errorText ?? "",
    extra: description ?? null,
  };
}

function actionForWrap(wrap: string): LogAction {
  if (READ_WRAP.has(wrap)) return "读取";
  if (wrap === "editToolCall") return "修改";
  if (wrap === "shellToolCall") return "运行命令";
  return "agent 说明";
}

function wrappingTitle(wrap: string): string {
  return wrap.replace(/ToolCall$/, "");
}

function toolDurationMs(inner: unknown): number | null {
  const record = asRecord(inner);
  const args = asRecord(record?.args);
  const started =
    numberish(record?.startedAtMs) ?? numberish(args?.startedAtMs);
  const completed =
    numberish(record?.completedAtMs) ?? numberish(args?.completedAtMs);
  if (started === null || completed === null) return null;
  return Math.max(0, completed - started);
}

function todosText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((item) => {
      const todo = asRecord(item);
      if (!todo) return String(item);
      const status = str(todo.status) ?? "";
      const content = str(todo.content) ?? "";
      return [status, content].filter(Boolean).join(" ");
    })
    .join("\n");
}

function axisLabelFromPrompt(text: string): string | undefined {
  // The heading is authoritative. Spec-axis prompts also mention "Standards 轴" in passing.
  const heading = /阶段：(?:final-)?review，(Standards|Spec) 轴/.exec(text);
  if (heading) return heading[1];
  return undefined;
}

function splitCompleteLines(text: string): {
  lines: string[];
  remainder: string;
} {
  if (text === "") return { lines: [], remainder: "" };
  const lastNl = text.lastIndexOf("\n");
  if (lastNl === -1) return { lines: [], remainder: text };
  return {
    lines: text.slice(0, lastNl).split("\n"),
    remainder: text.slice(lastNl + 1),
  };
}

function completeLines(
  text: string,
  flushRemainder = false,
): { lines: string[]; remainder: string } {
  const split = splitCompleteLines(text);
  if (split.remainder === "") return split;
  // A slice can end on the last character of a JSON line; the newline arrives in the next
  // chunk. If the remainder is already one object, it is a complete event.
  if (parseJsonObject(split.remainder) || flushRemainder) {
    return {
      lines: [...split.lines, split.remainder],
      remainder: "",
    };
  }
  return split;
}

function wrappingKey(tool: unknown): string | undefined {
  const record = asRecord(tool);
  if (!record) return undefined;
  return Object.keys(record).find(
    (name) => name.endsWith("ToolCall") && !TOOL_META.has(name),
  );
}

function wrapValue(tool: unknown, wrap: string | undefined): unknown {
  if (!wrap) return undefined;
  return asRecord(tool)?.[wrap];
}

function preferredFields(wrap: string | undefined): readonly string[] {
  switch (wrap) {
    case "globToolCall":
      return ["globPattern", "targetDirectory"];
    case "grepToolCall":
      return ["pattern", "path"];
    case "semSearchToolCall":
      return ["query", "pattern"];
    case "shellToolCall":
      return ["command"];
    default:
      return ["path"];
  }
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
  for (const field of preferred) {
    const value = record[field] ?? args?.[field];
    if (typeof value === "string" && value !== "") {
      return field === "pattern"
        ? displayGrepPattern(value)
        : displayPath(value);
    }
  }
  return JSON.stringify(call);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function numberish(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function errorMessage(value: unknown): string | undefined {
  if (typeof value === "string" && value !== "") return value;
  const record = asRecord(value);
  return str(record?.errorMessage) ?? str(record?.message);
}

function joinRaw(existing: string | null, line: string): string {
  return existing ? `${existing}\n${line}` : line;
}
