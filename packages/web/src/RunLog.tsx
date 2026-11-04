import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { describeError, useApi } from "./api.tsx";
import { cn } from "./lib/utils.ts";
import {
  groupLog,
  LOG_OUTPUT_MAX_LINES,
  LOG_THOUGHT_MAX_LINES,
  type LogAction,
  type LogBlock,
  type LogSession,
  truncateLines,
} from "./log-actions.ts";
import { Markdown } from "./Markdown.tsx";
import { formatCompactDuration } from "./time.ts";

export const LOG_POLL_MS = 3_000;

interface Position {
  attempt: number | undefined;
  offset: number;
  text: string;
}

const actionClass: Record<LogAction, string> = {
  读取: "text-terminal-cyan border-terminal-cyan/30",
  修改: "text-terminal-magenta border-terminal-magenta/30",
  运行命令: "text-terminal-warning border-terminal-warning/30",
  "agent 说明": "text-terminal-success border-terminal-success/30",
};

export function RunLog({
  runId,
  pollMs = LOG_POLL_MS,
  durationMs = null,
}: {
  runId: number;
  pollMs?: number;
  durationMs?: number | null;
}) {
  const api = useApi();
  const scroller = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  const [position, setPosition] = useState<Position>({
    attempt: undefined,
    offset: 0,
    text: "",
  });

  const slice = useQuery({
    queryKey: ["log", runId, position.attempt, position.offset],
    queryFn: async () => {
      const { data, error } = await api.GET("/runs/{id}/logs", {
        params: { path: { id: runId }, query: { offset: position.offset } },
      });
      if (!data) throw new Error(describeError(error));
      return data;
    },
    refetchInterval: (query) => {
      const data = query.state.data;
      return data?.finished && data.nextOffset >= data.size ? false : pollMs;
    },
  });

  const data = slice.data;
  useEffect(() => {
    if (!data) return;
    setPosition((current) => {
      if (current.attempt !== undefined && data.attempt !== current.attempt) {
        return { attempt: data.attempt, offset: 0, text: "" };
      }
      if (data.offset !== current.offset) return current;
      if (
        data.nextOffset === current.offset &&
        current.attempt === data.attempt
      )
        return current;
      return {
        attempt: data.attempt,
        offset: data.nextOffset,
        text: current.text + data.text,
      };
    });
  }, [data]);

  const caughtUp = Boolean(data?.finished && data.nextOffset >= data.size);
  const grouped = groupLog(position.text, { flushRemainder: caughtUp });

  useEffect(() => {
    const el = scroller.current;
    if (!follow || !el || position.text === "") return;
    el.scrollTop = el.scrollHeight;
  }, [follow, position.text]);

  if (slice.isError && position.text === "")
    return (
      <p className="text-sm text-state-blocked" role="alert">
        无法加载日志: {slice.error.message}
      </p>
    );
  if (position.text === "") {
    return (
      <section
        aria-label="日志查看器"
        className="overflow-hidden rounded-md border bg-terminal"
      >
        <p className="px-3 py-3 font-mono text-[11px] text-terminal-muted">
          {slice.isPending ? "加载日志…" : "还没有日志。"}
        </p>
      </section>
    );
  }

  const sessions = grouped.sessions.map((session) =>
    grouped.sessions.length === 1 && session.durationMs === null
      ? { ...session, durationMs }
      : session,
  );

  return (
    <section
      aria-label="日志查看器"
      className="overflow-hidden rounded-md border bg-background"
    >
      <div className="flex items-center justify-between gap-3 border-b bg-surface px-3 py-2">
        <h2 className="text-sm font-semibold">日志</h2>
        {!follow && !caughtUp ? (
          <button
            type="button"
            className="text-xs text-primary hover:underline"
            onClick={() => {
              setFollow(true);
              const el = scroller.current;
              if (el) el.scrollTop = el.scrollHeight;
            }}
          >
            跳到最新
          </button>
        ) : null}
      </div>
      <div
        ref={scroller}
        className="run-log max-h-[min(60vh,36rem)] min-h-0 overflow-auto bg-terminal px-3 py-3 font-mono text-[11px] leading-6 text-terminal-foreground"
        data-testid="run-log"
        onScroll={(event) => {
          const el = event.currentTarget;
          const atBottom =
            el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          setFollow(atBottom);
        }}
      >
        <div className="space-y-2">
          {grouped.before.map((block) => (
            <LogBlockView key={block.key} block={block} />
          ))}
          {sessions.map((session) => (
            <SessionView key={session.id} session={session} />
          ))}
          {grouped.after.map((block) => (
            <LogBlockView key={block.key} block={block} />
          ))}
        </div>
      </div>
    </section>
  );
}

function SessionView({ session }: { session: LogSession }) {
  const duration = formatCompactDuration(session.durationMs);
  const heading = [
    session.label,
    duration ? `工作了 ${duration}` : session.blocks.length > 0 ? "工作中" : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <details
      open
      className="group rounded-md border border-white/10 bg-white/[0.04]"
    >
      <summary className="cursor-pointer list-none px-3 py-2 font-sans text-xs text-terminal-muted marker:content-none [&::-webkit-details-marker]:hidden">
        <span className="inline-flex items-center gap-2">
          <Chevron />
          {heading || "会话"}
        </span>
      </summary>
      <div className="space-y-2 border-t border-white/10 px-3 py-2">
        {session.blocks.map((block) => (
          <LogBlockView key={block.key} block={block} />
        ))}
      </div>
    </details>
  );
}

function LogBlockView({ block }: { block: LogBlock }) {
  if (block.kind === "assistant" && block.body === "" && !block.raw) {
    return (
      <div className="flex items-start gap-3">
        <ActionBadge action={block.action} />
        <div className="min-w-0 flex-1 font-sans text-[13px] leading-6">
          <Markdown source={block.title} />
        </div>
      </div>
    );
  }
  if (block.kind === "thought") {
    const { visible, hidden } = truncateLines(
      block.body,
      LOG_THOUGHT_MAX_LINES,
    );
    const duration = formatCompactDuration(block.durationMs);
    return (
      <details open={hidden === 0} className="group min-w-0">
        <summary className="flex cursor-pointer list-none items-start gap-3 marker:content-none [&::-webkit-details-marker]:hidden">
          <Chevron />
          <span className="font-sans text-[13px] text-terminal-muted">
            思考{duration ? ` ${duration}` : ""}
          </span>
        </summary>
        <pre className="mt-1 whitespace-pre-wrap break-words font-sans text-[13px] leading-6">
          {visible}
        </pre>
        {hidden > 0 ? (
          <p className="mt-1 font-sans text-[11px] text-terminal-muted">
            还有 {hidden} 行
          </p>
        ) : null}
        <RawEvent raw={block.raw} />
      </details>
    );
  }

  const max =
    block.kind === "tool" || block.kind === "output"
      ? LOG_OUTPUT_MAX_LINES
      : LOG_THOUGHT_MAX_LINES;
  const { visible, hidden } = truncateLines(block.body, max);
  const hasFold = block.body !== "" || Boolean(block.raw);
  if (!hasFold) {
    return (
      <div className="flex items-start gap-3">
        <ActionBadge action={block.action} />
        <span className="min-w-0 flex-1 truncate">{block.title}</span>
      </div>
    );
  }
  return (
    <details
      open={!block.completed}
      className="group rounded-md border border-white/10 bg-black/25"
    >
      <summary className="flex cursor-pointer list-none items-start gap-3 px-2 py-1.5 marker:content-none [&::-webkit-details-marker]:hidden">
        <Chevron />
        <ActionBadge action={block.action} />
        <span className="min-w-0 flex-1 truncate font-sans text-[12px] text-terminal-foreground">
          {block.title}
        </span>
        {block.extra ? (
          <span className="max-w-[40%] truncate text-terminal-muted">
            {block.extra}
          </span>
        ) : null}
      </summary>
      {block.body !== "" ? (
        <pre className="overflow-x-auto whitespace-pre-wrap break-words border-t border-white/10 px-2 py-2 text-terminal-foreground">
          {visible}
        </pre>
      ) : null}
      {hidden > 0 ? (
        <p className="px-2 pb-1 font-sans text-[11px] text-terminal-muted">
          还有 {hidden} 行
        </p>
      ) : null}
      <RawEvent raw={block.raw} />
    </details>
  );
}

function ActionBadge({ action }: { action: LogAction }) {
  return (
    <span
      className={cn(
        "mt-0.5 inline-flex h-5 shrink-0 items-center rounded-sm border bg-black/35 px-1.5 font-sans text-[11px]",
        actionClass[action],
      )}
    >
      {action}
    </span>
  );
}

function RawEvent({ raw }: { raw: string | null }) {
  if (!raw) return null;
  return (
    <details className="px-2 pb-2">
      <summary className="cursor-pointer font-sans text-[11px] text-terminal-muted">
        原始事件
      </summary>
      <pre className="mt-1 overflow-x-auto whitespace-pre-wrap text-terminal-muted">
        {prettyRaw(raw)}
      </pre>
    </details>
  );
}

function Chevron() {
  return (
    <span
      aria-hidden
      className="mt-0.5 inline-block text-terminal-muted transition-transform group-open:rotate-90"
    >
      ▸
    </span>
  );
}

function prettyRaw(raw: string): string {
  return raw
    .split("\n")
    .map((line) => {
      try {
        return JSON.stringify(JSON.parse(line), null, 2);
      } catch {
        return line;
      }
    })
    .join("\n\n");
}
