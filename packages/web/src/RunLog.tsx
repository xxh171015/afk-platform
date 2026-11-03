import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { describeError, useApi } from "./api.tsx";
import { cn } from "./lib/utils.ts";
import { classifyLog, type LogAction } from "./log-actions.ts";

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
}: {
  runId: number;
  pollMs?: number;
}) {
  const api = useApi();
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
  const lines = classifyLog(position.text);
  return (
    <section
      aria-label="日志查看器"
      className="overflow-hidden rounded-md border bg-background"
    >
      <div className="border-b bg-surface px-3 py-2">
        <h2 className="text-sm font-semibold">日志</h2>
      </div>
      <ol
        className="run-log min-h-0 overflow-auto bg-terminal px-3 py-3 font-mono text-[11px] leading-6 text-terminal-foreground"
        data-testid="run-log"
      >
        {lines.map((line) => (
          <li key={line.seq} className="flex gap-3 py-0.5">
            <span className="w-7 shrink-0 select-none text-right text-terminal-muted">
              {line.seq}
            </span>
            <div className="min-w-0 flex-1">
              {line.raw ? (
                <details>
                  <summary className="flex cursor-pointer items-start gap-3">
                    <span
                      className={cn(
                        "mt-0.5 inline-flex h-5 shrink-0 items-center rounded-sm border px-1.5 font-sans text-[11px]",
                        actionClass[line.action],
                      )}
                    >
                      {line.action}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{line.text}</span>
                  </summary>
                  <pre className="mt-1 overflow-x-auto whitespace-pre-wrap text-terminal-foreground">
                    {line.raw}
                  </pre>
                </details>
              ) : (
                <div className="flex items-start gap-3">
                  <span
                    className={cn(
                      "mt-0.5 inline-flex h-5 shrink-0 items-center rounded-sm border px-1.5 font-sans text-[11px]",
                      actionClass[line.action],
                    )}
                  >
                    {line.action}
                  </span>
                  <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">
                    {line.text}
                  </span>
                </div>
              )}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
