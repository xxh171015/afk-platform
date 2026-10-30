import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { describeError, useApi } from "./api.tsx";
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

  if (view.isPending) return <p className="note">Loading the ticket…</p>;
  if (view.isError)
    return (
      <p className="error" role="alert">
        Could not load the ticket: {view.error.message}
      </p>
    );
  const { ticket, runs, findings, gateResults, upstream, downstream } =
    view.data;
  // by default the newest run, which is the one that is going or that went wrong last
  const shown = picked ?? runs.at(-1)?.id;

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

      <h3>Acceptance criteria</h3>
      <ul>
        {ticket.acceptanceCriteria.map((criterion) => (
          <li key={criterion}>{criterion}</li>
        ))}
      </ul>

      {upstream.length + downstream.length > 0 ? (
        <p className="note">
          {upstream.length > 0
            ? `Waits for ${upstream.map((e) => `${e.displayId} (${e.state})`).join(", ")}. `
            : ""}
          {downstream.length > 0
            ? `Blocks ${downstream.map((e) => `${e.displayId} (${e.state})`).join(", ")}.`
            : ""}
        </p>
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
                  {run.stage} #{run.attempt}
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
              <span className="badge">{finding.resolution}</span> {finding.kind}
              : {finding.body}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
