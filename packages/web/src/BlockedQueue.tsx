import {
  type QueryClient,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { describeError, useApi } from "./api.tsx";

// Everything that waits for a person: blocked tickets with the reason and what went wrong, specs the platform
// paused, and overall reviews that stopped. Each has the actions that apply; after one succeeds the lists are
// fetched again.

export const BLOCKED_KEY = ["blocked"] as const;

function refreshAll(queryClient: QueryClient) {
  for (const key of [BLOCKED_KEY, ["specs"], ["spec"], ["ticket"]]) {
    void queryClient.invalidateQueries({ queryKey: key });
  }
}

type Queue = NonNullable<ReturnType<typeof useBlocked>["data"]>;

export function useBlocked() {
  const api = useApi();
  return useQuery({
    queryKey: BLOCKED_KEY,
    queryFn: async () => {
      const { data, error } = await api.GET("/blocked");
      if (!data) throw new Error(describeError(error));
      return data;
    },
    refetchInterval: 5_000,
  });
}

// One action button with its own busy state and error: the reason it failed shows next to it.
function useAction<Args extends unknown[]>(
  run: (...args: Args) => Promise<unknown>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: Args) => run(...args),
    onSuccess: () => refreshAll(queryClient),
  });
}

function Brief({ brief }: { brief: Queue["tickets"][number]["brief"] }) {
  if (!brief) return null;
  const output = brief.output as {
    detail?: unknown;
    failureLog?: unknown;
    unapproved?: unknown;
  } | null;
  const detail =
    typeof output?.detail === "string"
      ? output.detail
      : Array.isArray(output?.unapproved)
        ? `Protected paths: ${output.unapproved.join(", ")}`
        : typeof output?.failureLog === "string"
          ? output.failureLog
          : output
            ? JSON.stringify(output)
            : "";
  return (
    <div className="brief" role="note">
      <strong>
        {brief.stage} ended {brief.result ?? "?"}
      </strong>{" "}
      in {brief.run.displayId}
      {detail ? <pre>{detail}</pre> : null}
    </div>
  );
}

function Problem({ error }: { error: unknown }) {
  return error ? (
    <p className="error" role="alert">
      {(error as Error).message}
    </p>
  ) : null;
}

function TicketCard({ ticket }: { ticket: Queue["tickets"][number] }) {
  const api = useApi();
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [cascade, setCascade] = useState(false);
  const id = ticket.id;

  const retry = useAction(async (mode: "continue" | "restart") => {
    const { data, error } = await api.POST("/tickets/{id}/retry", {
      params: { path: { id } },
      body: { mode },
    });
    if (!data) throw new Error(describeError(error));
  });
  const approve = useAction(async () => {
    const { data, error } = await api.POST("/tickets/{id}/approve-protected", {
      params: { path: { id } },
    });
    if (!data) throw new Error(describeError(error));
  });
  const cancel = useAction(async () => {
    const { data, error } = await api.POST("/tickets/{id}/cancel", {
      params: { path: { id } },
      body: { cascade },
    });
    if (!data) throw new Error(describeError(error));
  });
  const busy = retry.isPending || approve.isPending || cancel.isPending;
  // retrying cannot help a ticket that waits for one that was cancelled
  const canRetry = ticket.blockedReason !== "upstream-cancelled";

  return (
    <li className="blocked-card" data-testid={`blocked-${ticket.displayId}`}>
      <h3>
        <a href={`#/tickets/${id}`}>{ticket.displayId}</a> {ticket.title}
      </h3>
      <p className="note">
        <a href={`#/specs/${ticket.specId}`}>{ticket.specDisplayId}</a>, repo{" "}
        {ticket.repo}
      </p>
      <p>
        <span className="badge ticket-blocked">{ticket.blockedReason}</span>
      </p>
      <Brief brief={ticket.brief} />

      <div className="actions">
        {canRetry ? (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={() => retry.mutate(["continue"])}
            >
              Retry, keep the work
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => retry.mutate(["restart"])}
            >
              Retry from scratch
            </button>
          </>
        ) : null}
        {ticket.blockedReason === "protected-path-changed" ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => approve.mutate([])}
          >
            Approve protected paths
          </button>
        ) : null}
        {confirmCancel ? (
          <>
            <label>
              <input
                type="checkbox"
                checked={cascade}
                onChange={(event) => setCascade(event.target.checked)}
              />{" "}
              also cancel everything downstream
            </label>
            <button
              type="button"
              className="danger"
              disabled={busy}
              onClick={() => cancel.mutate([])}
            >
              Cancel {ticket.displayId} for good
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setConfirmCancel(false)}
            >
              Keep it
            </button>
          </>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={() => setConfirmCancel(true)}
          >
            Cancel…
          </button>
        )}
      </div>
      <Problem error={retry.error ?? approve.error ?? cancel.error} />
    </li>
  );
}

function PausedSpec({ spec }: { spec: Queue["specs"][number] }) {
  const api = useApi();
  const [hours, setHours] = useState(1);
  const resume = useAction(async () => {
    const { data, error } = await api.POST("/specs/{id}/resume", {
      params: { path: { id: spec.id } },
      body: { extraSeconds: Math.round(hours * 3600) },
    });
    if (!data) throw new Error(describeError(error));
  });
  return (
    <li className="blocked-card" data-testid={`paused-${spec.displayId}`}>
      <h3>
        <a href={`#/specs/${spec.id}`}>{spec.displayId}</a> {spec.title}
      </h3>
      <p>
        <span className="badge spec-paused">paused</span> {spec.reason}
      </p>
      <div className="actions">
        <label>
          Add{" "}
          <input
            type="number"
            min={0.1}
            step={0.5}
            value={hours}
            aria-label={`extra agent hours for ${spec.displayId}`}
            onChange={(event) => setHours(Number(event.target.value))}
          />{" "}
          agent hours
        </label>
        <button
          type="button"
          disabled={resume.isPending || !(hours > 0)}
          onClick={() => resume.mutate([])}
        >
          Resume
        </button>
      </div>
      <Problem error={resume.error} />
    </li>
  );
}

function BlockedFinalization({
  item,
}: {
  item: Queue["finalizations"][number];
}) {
  const api = useApi();
  const retry = useAction(async () => {
    const { data, error } = await api.POST("/specs/{id}/final/retry", {
      params: { path: { id: item.specId } },
    });
    if (!data) throw new Error(describeError(error));
  });
  return (
    <li
      className="blocked-card"
      data-testid={`final-${item.specDisplayId}-${item.repo}`}
    >
      <h3>
        <a href={`#/specs/${item.specId}`}>{item.specDisplayId}</a> overall
        review of {item.repo}
      </h3>
      <p>
        {item.step}{" "}
        <span className="badge ticket-blocked">{item.blockedReason}</span>
      </p>
      <Brief brief={item.brief} />
      <div className="actions">
        <button
          type="button"
          disabled={retry.isPending}
          onClick={() => retry.mutate([])}
        >
          Run {item.step} again
        </button>
      </div>
      <Problem error={retry.error} />
    </li>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <>
      <h2>{title}</h2>
      <ul className="blocked-list">{children}</ul>
    </>
  );
}

export function BlockedQueue() {
  const queue = useBlocked();
  if (queue.isPending)
    return <p className="note">Loading what is waiting for you…</p>;
  if (queue.isError)
    return (
      <p className="error" role="alert">
        Could not load the queue: {queue.error.message}
      </p>
    );
  const { tickets, finalizations, specs } = queue.data;
  if (tickets.length + finalizations.length + specs.length === 0) {
    return <p className="note">Nothing is waiting for you.</p>;
  }
  return (
    <section className="blocked-queue">
      {tickets.length > 0 ? (
        <Section title="Blocked tickets">
          {tickets.map((ticket) => (
            <TicketCard key={ticket.id} ticket={ticket} />
          ))}
        </Section>
      ) : null}
      {finalizations.length > 0 ? (
        <Section title="Overall reviews that stopped">
          {finalizations.map((item) => (
            <BlockedFinalization
              key={`${item.specId}-${item.repo}`}
              item={item}
            />
          ))}
        </Section>
      ) : null}
      {specs.length > 0 ? (
        <Section title="Paused specs">
          {specs.map((spec) => (
            <PausedSpec key={spec.id} spec={spec} />
          ))}
        </Section>
      ) : null}
    </section>
  );
}
