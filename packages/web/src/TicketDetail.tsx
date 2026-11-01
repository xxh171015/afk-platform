import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { describeError, useApi } from "./api.tsx";
import { Markdown } from "./Markdown.tsx";
import { RunLog } from "./RunLog.tsx";

// One ticket, for finding out what happened to it: its runs (stage, result, time, model and skills version), the
// log of the one you pick, what the gates measured, and what the reviews found.

const seconds = (ms: number | null) =>
  ms === null ? "—" : `${Math.round(ms / 1000)} s`;

export function TicketDetail({
  ticketId,
  logPollMs,
}: {
  ticketId: number;
  logPollMs?: number;
}) {
  const api = useApi();
  const [picked, setPicked] = useState<number | undefined>();
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
    refetchInterval: 3_000,
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
  });

  if (view.isPending) return <p className="note">Loading the ticket…</p>;
  if (view.isError)
    return (
      <p className="error" role="alert">
        Could not load the ticket: {view.error.message}
      </p>
    );
  const {
    ticket,
    versions,
    runs,
    findings,
    gateResults,
    upstream,
    downstream,
    integration,
  } = view.data;
  // by default the newest run, which is the one that is going or that went wrong last
  const shown = picked ?? runs.at(-1)?.id;
  const shownTicket = older && past.data ? past.data.ticket : ticket;

  return (
    <section className="ticket-detail">
      <p>
        <a href={`#/specs/${ticket.specId}`}>← {ticket.specDisplayId}</a>
      </p>
      <h2>
        {ticket.displayId} {ticket.title}{" "}
        <span className={`badge ticket-${ticket.state}`}>{ticket.state}</span>
      </h2>
      <p className="note">
        {ticket.type}, repo {ticket.repo}, version {ticket.contentVersion}
        {ticket.blockedReason ? `, blocked: ${ticket.blockedReason}` : ""}
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
            <a href={`#/specs/${ticket.specId}`}>{ticket.specDisplayId}</a>
            {spec.data ? ` ${spec.data.spec.title}` : ""}
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
                      <a href={`#/tickets/${e.id}`}>{e.displayId}</a> ({e.kind},{" "}
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
                    <span className={`badge ticket-${t.state}`}>{t.state}</span>{" "}
                    <a href={`#/tickets/${t.id}`}>{t.displayId}</a> {t.title}
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
                  ? `, built from ${Object.entries(attempt.e2e.refShas)
                      .map(([name, sha]) => `${name}@${sha.slice(0, 8)}`)
                      .join(", ")}`
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
                    <a href={`#/tickets/${attempt.fixTicket.id}`}>
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
              <th>Run</th>
              <th>Stage</th>
              <th>Result</th>
              <th>Time</th>
              <th>Model</th>
              <th>Skills</th>
              <th>Contracts</th>
              <th>Refs</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => (
              <tr
                key={run.id}
                className={run.id === shown ? "picked" : undefined}
              >
                <td>
                  <button
                    type="button"
                    className="link"
                    onClick={() => setPicked(run.id)}
                  >
                    {run.displayId}
                  </button>
                </td>
                <td>
                  {run.stage}
                  {run.axis ? ` (${run.axis})` : ""} #{run.attempt}
                </td>
                <td>{run.result ?? "running"}</td>
                <td>{seconds(run.durationMs)}</td>
                <td>{run.model ?? "—"}</td>
                <td>{run.skillsSha ?? "—"}</td>
                <td>
                  {run.contractShas
                    ? Object.entries(run.contractShas)
                        .map(([repo, sha]) => `${repo}@${sha.slice(0, 8)}`)
                        .join(", ")
                    : "—"}
                </td>
                <td>
                  {run.refShas
                    ? Object.entries(run.refShas)
                        .map(([repo, sha]) => `${repo}@${sha.slice(0, 8)}`)
                        .join(", ")
                    : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {shown !== undefined ? (
        <>
          <h3>Log of {runs.find((r) => r.id === shown)?.displayId}</h3>
          <RunLog key={shown} runId={shown} pollMs={logPollMs} />
        </>
      ) : null}

      <h3>Gate results</h3>
      {gateResults.length === 0 ? (
        <p className="note">No gate has run on this ticket.</p>
      ) : (
        <ul className="gates">
          {gateResults.map((gate) => (
            <li key={gate.commitSha}>
              <code>{gate.commitSha.slice(0, 7)}</code>{" "}
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
