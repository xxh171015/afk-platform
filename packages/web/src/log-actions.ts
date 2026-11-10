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

export interface LogCheckpoint {
  remainder: string;
  before: LogBlock[];
  after: LogBlock[];
  sessions: Map<string, SessionState>;
  sessionOrder: string[];
  seenCursor: boolean;
  dump: { title: string; body: string[] } | null;
  nextKey: number;
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

export function emptyLogCheckpoint(): LogCheckpoint {
  return {
    remainder: "",
    before: [],
    after: [],
    sessions: new Map(),
    sessionOrder: [],
    seenCursor: false,
    dump: null,
    nextKey: 0,
  };
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
  from: "start" | "end" = "start",
): { visible: string; hidden: number; rest: string } {
  if (text === "") return { visible: "", hidden: 0, rest: "" };
  const lines = text.split("\n");
  if (lines.length <= max) return { visible: text, hidden: 0, rest: "" };
  if (from === "end") {
    return {
      visible: lines.slice(-max).join("\n"),
      hidden: lines.length - max,
      rest: lines.slice(0, -max).join("\n"),
    };
  }
  return {
    visible: lines.slice(0, max).join("\n"),
    hidden: lines.length - max,
    rest: lines.slice(max).join("\n"),
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

function nextKeyOf(checkpoint: LogCheckpoint): (prefix: string) => string {
  return (prefix: string) => {
    checkpoint.nextKey += 1;
    return `${prefix}-${checkpoint.nextKey}`;
  };
}

function cloneSession(session: SessionState): SessionState {
  const blocks = session.blocks.map((block) => ({ ...block }));
  const tools = new Map<string, LogBlock>();
  for (const [callId, block] of session.tools) {
    const copy = blocks.find((item) => item.key === block.key);
    if (copy) tools.set(callId, copy);
  }
  return {
    ...session,
    blocks,
    tools,
    openThought: session.openThought
      ? { ...session.openThought, raw: [...session.openThought.raw] }
      : null,
  };
}

function cloneCheckpoint(checkpoint: LogCheckpoint): LogCheckpoint {
  const sessions = new Map<string, SessionState>();
  for (const [id, session] of checkpoint.sessions) {
    sessions.set(id, cloneSession(session));
  }
  return {
    remainder: checkpoint.remainder,
    before: checkpoint.before.map((block) => ({ ...block })),
    after: checkpoint.after.map((block) => ({ ...block })),
    sessions,
    sessionOrder: [...checkpoint.sessionOrder],
    seenCursor: checkpoint.seenCursor,
    dump: checkpoint.dump
      ? { title: checkpoint.dump.title, body: [...checkpoint.dump.body] }
      : null,
    nextKey: checkpoint.nextKey,
  };
}

function flushDump(checkpoint: LogCheckpoint, key: (prefix: string) => string) {
  if (!checkpoint.dump) return;
  const bucket = checkpoint.seenCursor ? checkpoint.after : checkpoint.before;
  bucket.push({
    key: key("output"),
    kind: "output",
    action: "运行命令",
    title: checkpoint.dump.title,
    body: checkpoint.dump.body.join("\n").replace(/\n+$/, ""),
    extra: null,
    durationMs: null,
    completed: true,
    raw: null,
  });
  checkpoint.dump = null;
}

export function ingestLog(
  checkpoint: LogCheckpoint,
  chunk: string,
  options: { flushRemainder?: boolean } = {},
): LogCheckpoint {
  const { lines, remainder } = completeLines(
    checkpoint.remainder + chunk,
    options.flushRemainder,
  );
  checkpoint.remainder = remainder;
  const key = nextKeyOf(checkpoint);
  const bucket = () =>
    checkpoint.seenCursor ? checkpoint.after : checkpoint.before;

  for (const line of lines) {
    const parsed = parseJsonObject(line);
    if (parsed) {
      flushDump(checkpoint, key);
      checkpoint.seenCursor = true;
      ingestCursor(
        parsed,
        line,
        checkpoint.sessions,
        checkpoint.sessionOrder,
        key,
      );
      continue;
    }
    if (line === "") {
      if (checkpoint.dump) checkpoint.dump.body.push("");
      continue;
    }
    const dumpTitle = DUMP_HEADER.exec(line)?.[1];
    if (dumpTitle !== undefined) {
      flushDump(checkpoint, key);
      checkpoint.dump = { title: dumpTitle, body: [] };
      continue;
    }
    if (WORKER_PREFIX.test(line)) {
      flushDump(checkpoint, key);
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
    if (checkpoint.dump) {
      checkpoint.dump.body.push(line);
      continue;
    }
    // A raw line cut at 16 KiB is not valid JSON. Recover type/call_id/args from the
    // prefix and fold it into the matching tool card when we can.
    if (line.startsWith("{") || line.startsWith("[")) {
      const recovered = recoverCutEvent(line);
      if (recovered) {
        flushDump(checkpoint, key);
        checkpoint.seenCursor = true;
        ingestCursor(
          recovered,
          line,
          checkpoint.sessions,
          checkpoint.sessionOrder,
          key,
        );
        continue;
      }
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
  return checkpoint;
}

export function groupedLogFrom(checkpoint: LogCheckpoint): GroupedLog {
  const view = cloneCheckpoint(checkpoint);
  const key = nextKeyOf(view);
  flushDump(view, key);
  for (const session of view.sessions.values()) {
    flushThought(session, key, false);
  }
  return {
    remainder: view.remainder,
    before: view.before,
    sessions: view.sessionOrder.map((id) => {
      const session = view.sessions.get(id) as SessionState;
      return {
        id,
        label: session.label,
        durationMs: session.durationMs,
        blocks: session.blocks,
      };
    }),
    after: view.after,
  };
}

export function groupLog(
  text: string,
  options: { flushRemainder?: boolean } = {},
): GroupedLog {
  return groupedLogFrom(ingestLog(emptyLogCheckpoint(), text, options));
}

function ingestCursor(
  parsed: Record<string, unknown>,
  line: string,
  sessions: Map<string, SessionState>,
  sessionOrder: string[],
  key: (prefix: string) => string,
): void {
  let sessionId =
    typeof parsed.session_id === "string" && parsed.session_id !== ""
      ? parsed.session_id
      : "_";
  const callId =
    typeof parsed.call_id === "string" && parsed.call_id !== ""
      ? parsed.call_id
      : undefined;
  if (sessionId === "_" && callId) {
    for (const [id, session] of sessions) {
      if (session.tools.has(callId)) {
        sessionId = id;
        break;
      }
    }
  }
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
        title: firstLine(text),
        body: text,
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
    title: otherTitle(parsed),
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
  const cut = line.includes("[line cut]");
  const cutBody = cut && completed ? "输出过长，未完整上传" : "";
  const existing = session.tools.get(callId);
  if (existing) {
    existing.raw = joinRaw(existing.raw, line);
    if (fields.title) existing.title = fields.title;
    if (fields.extra) existing.extra = fields.extra;
    if (fields.body) existing.body = fields.body;
    else if (cutBody && existing.body === "") existing.body = cutBody;
    if (completed) existing.completed = true;
    return;
  }
  const block: LogBlock = {
    key: key("tool"),
    kind: wrap === "updateTodosToolCall" ? "assistant" : "tool",
    action: actionForWrap(wrap),
    title: fields.title,
    body: fields.body || cutBody,
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
  completed = true,
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
    completed,
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

function firstLine(text: string): string {
  const nl = text.indexOf("\n");
  return nl === -1 ? text : text.slice(0, nl);
}

function otherTitle(parsed: Record<string, unknown>): string {
  const wrap = wrappingKey(parsed.tool_call);
  if (wrap) return wrappingTitle(wrap);
  if (typeof parsed.type === "string" && parsed.type !== "") return parsed.type;
  return "未知事件";
}

function recoverCutEvent(line: string): Record<string, unknown> | undefined {
  const cutAt = line.lastIndexOf(" [line cut]");
  const source = cutAt >= 0 ? line.slice(0, cutAt) : line;
  if (!source.startsWith("{")) return undefined;
  const type = readJsonStringField(source, "type");
  const subtype = readJsonStringField(source, "subtype");
  const callId = readJsonStringField(source, "call_id");
  const sessionId = readJsonStringField(source, "session_id");
  const wrap = wrappingKeyFromPrefix(source);
  if (!wrap && !callId) return undefined;
  const parsed: Record<string, unknown> = {};
  if (type) parsed.type = type;
  if (subtype) parsed.subtype = subtype;
  if (callId) parsed.call_id = callId;
  if (sessionId) parsed.session_id = sessionId;
  if (wrap) {
    const args = readArgsObject(source);
    parsed.tool_call = { [wrap]: args ? { args } : {} };
  }
  return parsed;
}

function wrappingKeyFromPrefix(source: string): string | undefined {
  const matches = [...source.matchAll(/"(\w+ToolCall)"/g)].map((m) => m[1]);
  return matches.find((name) => !TOOL_META.has(name));
}

function readJsonStringField(source: string, key: string): string | undefined {
  const needle = `"${key}":"`;
  const start = source.indexOf(needle);
  if (start < 0) return undefined;
  return readJsonStringAt(source, start + needle.length - 1);
}

function readJsonStringAt(
  source: string,
  quoteIndex: number,
): string | undefined {
  if (source[quoteIndex] !== '"') return undefined;
  let i = quoteIndex + 1;
  let out = "";
  while (i < source.length) {
    const ch = source[i];
    if (ch === '"') return out;
    if (ch === "\\") {
      const next = source[i + 1];
      if (next === undefined) return out;
      if (next === "u") {
        const hex = source.slice(i + 2, i + 6);
        if (hex.length < 4) return out;
        out += String.fromCharCode(Number.parseInt(hex, 16));
        i += 6;
        continue;
      }
      const escaped: Record<string, string> = {
        n: "\n",
        t: "\t",
        r: "\r",
        b: "\b",
        f: "\f",
        '"': '"',
        "\\": "\\",
        "/": "/",
      };
      out += escaped[next] ?? next;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function readArgsObject(source: string): Record<string, unknown> | undefined {
  const idx = source.indexOf('"args":');
  if (idx < 0) return undefined;
  const brace = source.indexOf("{", idx);
  if (brace < 0) return undefined;
  const balanced = readBalancedJson(source, brace);
  if (balanced) {
    const parsed = parseJsonObject(balanced);
    if (parsed) return parsed;
  }
  const args: Record<string, string> = {};
  const window = source.slice(idx);
  for (const field of [
    "path",
    "command",
    "pattern",
    "globPattern",
    "query",
    "description",
  ]) {
    const value = readJsonStringField(window, field);
    if (value !== undefined) args[field] = value;
  }
  return Object.keys(args).length > 0 ? args : undefined;
}

function readBalancedJson(source: string, start: number): string | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return undefined;
}
