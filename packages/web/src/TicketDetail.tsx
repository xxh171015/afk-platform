import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { describeError, useApi } from "./api.tsx";
import { useResourcePoll } from "./EventsProvider.tsx";
import { DETAIL_POLL_MS } from "./live.ts";
import { Markdown } from "./Markdown.tsx";
import { paths } from "./paths.ts";
import { RelativeTime } from "./RelativeTime.tsx";
import { Sha } from "./Sha.tsx";
import { StatusBadge } from "./StatusBadge.tsx";

// One ticket: its runs as a thin table into /runs/:id, what the gates measured, and what the reviews found.

const seconds = (ms: number | null) =>
  ms === null ? "—" : `${Math.round(ms / 1000)} s`;

export function TicketDetail({ ticketId }: { ticketId: number }) {
  const api = useApi();
  const poll = useResourcePoll(DETAIL_POLL_MS);
  // the content version shown in the left column; undefined is the newest
  const [version, setVersion] = useState<number | undefined>();
  const [showAgentText, setShowAgentText] = useState(false);
  const view = useQuery({
    queryKey: ["ticket", ticketId],
    queryFn: async () => {
      const { data, error } = await api.GET("/tickets/{id}", {
        params: { path: { id: ticketId } },
      });
      if (!data) throw new Error(describeError(error));
      return data;
    },
    refetchInterval: poll,
    placeholderData: keepPreviousData,
  });
  const current = view.data?.ticket.contentVersion;
  const older = version !== undefined && version !== current;
  // the content of an older version: its body and the text the agent read then
  const past = useQuery({
    queryKey: ["ticket", ticketId, "version", version],
    enabled: older,
    queryFn: async () => {
      const { data, error } = await api.GET("/tickets/{id}", {
        params: { path: { id: ticketId }, query: { version } },
      });
      if (!data) throw new Error(describeError(error));
      return data;
    },
  });
  // the other tickets of the same spec, for the side column
  const specId = view.data?.ticket.specId;
  const spec = useQuery({
    queryKey: ["spec", specId],
    enabled: specId !== undefined,
    queryFn: async () => {
      const { data, error } = await api.GET("/specs/{id}", {
        params: { path: { id: specId as number } },
      });
      if (!data) throw new Error(describeError(error));
      return data;
    },
    refetchInterval: poll,
    placeholderData: keepPreviousData,
  });

  if (view.isPending) return <p className="note">Loading the ticket…</p>;
  if (view.isError && !view.data)
    return (
      <p className="error" role="alert">
        Could not load the ticket: {view.error.message}
      </p>
    );
  const loaded = view.data;
  if (!loaded) return null;
  const {
    ticket,
    versions,
    runs,
    findings,
    gateResults,
    upstream,
    downstream,
    integration,
  } = loaded;
  const shownTicket = older && past.data ? past.data.ticket : ticket;

  return (
    <section className="ticket-detail">
      <p>
        <a href={paths.spec(ticket.specId)}>← {ticket.specDisplayId}</a>
      </p>
      <h2>
        {ticket.displayId} {ticket.title}{" "}
        <StatusBadge kind="ticket" code={ticket.state} />
      </h2>
      <p className="note">
        {ticket.type}, repo {ticket.repo}, version {ticket.contentVersion}
        {ticket.blockedReason ? (
          <>
            {", "}
            <StatusBadge kind="blocked" code={ticket.blockedReason} />
          </>
        ) : (
          ""
        )}
      </p>
      {ticket.brief ? (
        <div className="brief" role="note">
          <strong>
            {ticket.brief.stage} ended {ticket.brief.result ?? "?"}
          </strong>{" "}
          in {ticket.brief.run.displayId}
          <pre>{JSON.stringify(ticket.brief.output, null, 2)}</pre>
        </div>
      ) : null}

      <div className="two-columns">
        <div className="main-column">
          <div className="body-controls">
            {versions.length > 1 ? (
              <label>
                Version{" "}
                <select
                  value={version ?? ticket.contentVersion}
                  onChange={(event) => setVersion(Number(event.target.value))}
                >
                  {versions.map((v) => (
                    <option key={v.version} value={v.version}>
                      v{v.version} ({v.createdAt.slice(0, 10)})
                      {v.version === ticket.contentVersion ? " · current" : ""}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}{" "}
            <label>
              <input
                type="checkbox"
                checked={showAgentText}
                onChange={(event) => setShowAgentText(event.target.checked)}
              />{" "}
              agent 读到的原文
            </label>
          </div>
          {older && past.isError ? (
            <p className="error" role="alert">
              Could not load version {version}: {past.error.message}
            </p>
          ) : older && !past.data ? (
            <p className="note">Loading version {version}…</p>
          ) : showAgentText ? (
            <pre className="ticket-original" data-testid="ticket-original">
              {shownTicket.file}
            </pre>
          ) : (
            <Markdown source={shownTicket.body} />
          )}
        </div>

        <aside className="side-column">
          <h3>Spec</h3>
          <p>
            <a href={paths.spec(ticket.specId)}>{ticket.specDisplayId}</a>
            {spec.data?.spec ? ` ${spec.data.spec.title}` : ""}
          </p>
          {(
            [
              ["Waits for", upstream],
              ["Blocks", downstream],
            ] as const
          ).map(([heading, related]) =>
            related.length > 0 ? (
              <div key={heading}>
                <h3>{heading}</h3>
                <ul className="related">
                  {related.map((e) => (
                    <li key={e.id}>
                      <a href={paths.ticket(e.id)}>{e.displayId}</a> ({e.kind},{" "}
                      {e.state})
                    </li>
                  ))}
                </ul>
              </div>
            ) : null,
          )}
          {spec.data ? (
            <>
              <h3>Tickets of {ticket.specDisplayId}</h3>
              <ul className="related spec-tickets">
                {spec.data.tickets.map((t) => (
                  <li key={t.id} className={t.id === ticket.id ? "picked" : ""}>
                    <StatusBadge kind="ticket" code={t.state} />{" "}
                    <a href={paths.ticket(t.id)}>{t.displayId}</a> {t.title}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </aside>
      </div>

      {integration ? (
        <>
          <h3>E2E tries</h3>
          <p className="note">
            {integration.rounds} of 2 fix rounds used.
            {integration.attempts.length === 0 ? " No e2e has run yet." : ""}
          </p>
          <ol className="attempts">
            {integration.attempts.map((attempt) => (
              <li key={attempt.e2e.id}>
                <strong>
                  {attempt.e2e.displayId} {attempt.e2e.result ?? "running"}
                </strong>
                {attempt.e2e.testsTotal === null
                  ? ""
                  : `, ${attempt.e2e.testsFailed ?? 0} of ${attempt.e2e.testsTotal} tests failed`}
                {attempt.e2e.refShas
                  ? Object.entries(attempt.e2e.refShas).map(([name, sha]) => (
                      <span key={name}>
                        {`, built from ${name}@`}
                        <Sha value={sha} />
                      </span>
                    ))
                  : ""}
                {attempt.diagnosis ? (
                  <div className="diagnosis">
                    Diagnosis: {attempt.diagnosis.failingRepo ?? "no repo"}
                    <pre>{attempt.diagnosis.evidence}</pre>
                    {attempt.diagnosis.failingTests.length > 0 ? (
                      <p className="note">
                        Failing: {attempt.diagnosis.failingTests.join(", ")}
                      </p>
                    ) : null}
                  </div>
                ) : null}
                {attempt.fixTicket ? (
                  <p className="note">
                    Fix ticket{" "}
                    <a href={paths.ticket(attempt.fixTicket.id)}>
                      {attempt.fixTicket.displayId}
                    </a>{" "}
                    ({attempt.fixTicket.state}, {attempt.fixTicket.repo})
                  </p>
                ) : null}
              </li>
            ))}
          </ol>
        </>
      ) : null}

      <h3>Runs</h3>
      {runs.length === 0 ? (
        <p className="note">No runs yet.</p>
      ) : (
        <table className="runs">
          <thead>
            <tr>
              <th>编号</th>
              <th>阶段</th>
              <th>结果</th>
              <th>耗时</th>
              <th>开始时间</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => (
              <tr key={run.id} className="relative">
                <td>
                  <a
                    href={paths.run(run.id)}
                    className="after:absolute after:inset-0"
                  >
                    {run.displayId}
                  </a>
                </td>
                <td>
                  {run.stage}
                  {run.axis ? ` (${run.axis})` : ""} #{run.attempt}
                </td>
                <td>{run.result ?? "running"}</td>
                <td>{seconds(run.durationMs)}</td>
                <td>
                  {run.startedAt ? <RelativeTime iso={run.startedAt} /> : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3>Gate results</h3>
      {gateResults.length === 0 ? (
        <p className="note">No gate has run on this ticket.</p>
      ) : (
        <ul className="gates">
          {gateResults.map((gate) => (
            <li key={gate.commitSha}>
              <Sha value={gate.commitSha} />{" "}
              {gate.testsTotal === null
                ? "no JUnit"
                : `${gate.testsTotal} tests, ${gate.testsSkipped ?? 0} skipped`}
              <ul>
                {gate.commandResults.map((step) => {
                  const s = step as { name?: string; exitCode?: number };
                  return (
                    <li key={s.name ?? JSON.stringify(step)}>
                      {`${s.name ?? "command"}: exit ${s.exitCode ?? "?"}`}
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ul>
      )}

      <h3>Findings</h3>
      {findings.length === 0 ? (
        <p className="note">No findings.</p>
      ) : (
        <ul className="findings">
          {findings.map((finding) => (
            <li key={finding.id}>
              <span className="badge">{finding.resolution}</span>{" "}
              {finding.axis ? (
                <span className={`badge axis-${finding.axis}`}>
                  {finding.axis}
                </span>
              ) : null}{" "}
              {finding.kind}: {finding.body}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
