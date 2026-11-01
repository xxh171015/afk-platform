import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { describeError, useApi } from "./api.tsx";
import { useResourcePoll } from "./EventsProvider.tsx";
import { DETAIL_POLL_MS } from "./live.ts";
import { paths } from "./paths.ts";
import { RunLog } from "./RunLog.tsx";

// One Run: the four facts first, then the log split by action
// (docs/specs/experience-platform.md「Run 日志」).

const seconds = (ms: number | null) =>
  ms === null ? "—" : `${Math.round(ms / 1000)} s`;

export function RunDetail({
  runId,
  logPollMs,
}: {
  runId: number;
  logPollMs?: number;
}) {
  const api = useApi();
  const poll = useResourcePoll(DETAIL_POLL_MS);
  const view = useQuery({
    queryKey: ["run", runId],
    queryFn: async () => {
      const { data, error } = await api.GET("/runs/{id}", {
        params: { path: { id: runId } },
      });
      if (!data) throw new Error(describeError(error));
      return data;
    },
    refetchInterval: poll,
    placeholderData: keepPreviousData,
  });

  if (view.isPending) return <p className="note">Loading the run…</p>;
  if (view.isError && !view.data)
    return (
      <p className="error" role="alert">
        Could not load the run: {view.error.message}
      </p>
    );
  const run = view.data;
  if (!run) return null;

  const back = run.ticketId
    ? { href: paths.ticket(run.ticketId), label: run.ticketDisplayId }
    : { href: paths.spec(run.specId), label: run.specDisplayId };

  return (
    <section className="run-detail">
      <p>
        <a href={back.href}>← {back.label}</a>
      </p>
      <h1>{run.displayId}</h1>
      <dl className="mt-4 grid grid-cols-[6rem_1fr] gap-2 text-sm">
        <dt>阶段</dt>
        <dd>
          {run.stage}
          {run.axis ? ` (${run.axis})` : ""}
        </dd>
        <dt>次数</dt>
        <dd>{run.attempt}</dd>
        <dt>结果</dt>
        <dd>{run.result ?? "running"}</dd>
        <dt>耗时</dt>
        <dd>{seconds(run.durationMs)}</dd>
      </dl>
      <h2 className="mt-6 text-base font-semibold">日志</h2>
      <RunLog runId={runId} pollMs={logPollMs} />
    </section>
  );
}
