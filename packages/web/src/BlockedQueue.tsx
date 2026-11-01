import {
  keepPreviousData,
  type QueryClient,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { describeError, useApi } from "./api.tsx";
import { useResourcePoll } from "./EventsProvider.tsx";
import { LIST_POLL_MS } from "./live.ts";
import { paths } from "./paths.ts";
import {
  RetryNoteField,
  retryFinalBody,
  retryTicketBody,
} from "./RetryNote.tsx";
import { StatusBadge } from "./StatusBadge.tsx";
import { StructuredBriefView } from "./StructuredBriefView.tsx";
import { structuredBrief } from "./structured-brief.ts";
import { WaitingTicketEdit } from "./TicketEdit.tsx";
import { WORKBENCH_KEY } from "./Workbench.tsx";

// Everything that waits for a person: blocked tickets with the reason and what went wrong, specs the platform
// paused, overall reviews that stopped, and pull requests that were closed or cannot be read. Each has the actions
// that apply; after one succeeds the lists are fetched again.

export const BLOCKED_KEY = ["blocked"] as const;

// Resolves when the lists have been fetched again, so a button stays disabled until the card is gone.
function refreshAll(queryClient: QueryClient) {
  return Promise.all(
    [BLOCKED_KEY, WORKBENCH_KEY, ["specs"], ["spec"], ["ticket"]].map(
      (queryKey) => queryClient.invalidateQueries({ queryKey }),
    ),
  );
}

type Queue = NonNullable<ReturnType<typeof useBlocked>["data"]>;

export function useBlocked() {
  const api = useApi();
  const poll = useResourcePoll(LIST_POLL_MS);
  return useQuery({
    queryKey: BLOCKED_KEY,
    queryFn: async () => {
      const { data, error } = await api.GET("/blocked");
      if (!data) throw new Error(describeError(error));
      return data;
    },
    refetchInterval: poll,
    placeholderData: keepPreviousData,
  });
}

// One action button with its own busy state and error: the reason it failed shows next to it.
function useAction<Action>(run: (action: Action) => Promise<unknown>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: run,
    onSuccess: () => refreshAll(queryClient),
  });
}

function Brief({
  reason,
  brief,
}: {
  reason: string | null;
  brief: Queue["tickets"][number]["brief"];
}) {
  if (!brief || !reason) return null;
  return (
    <StructuredBriefView
      brief={structuredBrief(reason, brief)}
      runId={brief.run.id}
    />
  );
}

function Problem({ error }: { error: unknown }) {
  return error ? (
    <p className="error" role="alert">
      {(error as Error).message}
    </p>
  ) : null;
}

type TicketAction =
  | { kind: "retry"; mode: "continue" | "restart" }
  | { kind: "approve" }
  | { kind: "cancel"; cascade: boolean };

function TicketCard({ ticket }: { ticket: Queue["tickets"][number] }) {
  const api = useApi();
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [confirmRestart, setConfirmRestart] = useState(false);
  const [cascade, setCascade] = useState(false);
  const [note, setNote] = useState("");
  const id = ticket.id;

  // One mutation for the card: only one action at a time, and the message shown is that of the latest one.
  const act = useAction(async (action: TicketAction) => {
    const { data, error } =
      action.kind === "retry"
        ? await api.POST("/tickets/{id}/retry", {
            params: { path: { id } },
            body: retryTicketBody(action.mode, note),
          })
        : action.kind === "approve"
          ? await api.POST("/tickets/{id}/approve-protected", {
              params: { path: { id } },
            })
          : await api.POST("/tickets/{id}/cancel", {
              params: { path: { id } },
              body: { cascade: action.cascade },
            });
    if (!data) throw new Error(describeError(error));
  });
  const busy = act.isPending;
  // retrying cannot help a ticket that waits for one that was cancelled
  const canRetry = ticket.blockedReason !== "upstream-cancelled";

  return (
    <li className="blocked-card" data-testid={`blocked-${ticket.displayId}`}>
      <h3>
        <a href={paths.ticket(id)}>{ticket.displayId}</a> {ticket.title}
      </h3>
      <p className="note">
        <a href={paths.spec(ticket.specId)}>{ticket.specDisplayId}</a>, repo{" "}
        {ticket.repo}
      </p>
      <p>
        <StatusBadge kind="blocked" code={ticket.blockedReason ?? "blocked"} />
      </p>
      <Brief reason={ticket.blockedReason} brief={ticket.brief} />
      <WaitingTicketEdit ticketId={id} />
      {canRetry ? (
        <RetryNoteField
          id={`retry-note-${ticket.displayId}`}
          value={note}
          onChange={setNote}
        />
      ) : null}
      {canRetry ? null : (
        <p className="note">
          A ticket it waited for was cancelled, so trying again would only wait
          for ever. Cancel this one too, or import a replacement.
        </p>
      )}

      <div className="actions">
        {canRetry ? (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={() => act.mutate({ kind: "retry", mode: "continue" })}
            >
              Retry, keep the work
            </button>
            {confirmRestart ? (
              <>
                <button
                  type="button"
                  className="danger"
                  disabled={busy}
                  onClick={() => act.mutate({ kind: "retry", mode: "restart" })}
                >
                  Retry {ticket.displayId} from scratch
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setConfirmRestart(false)}
                >
                  Keep the work
                </button>
              </>
            ) : (
              <button
                type="button"
                disabled={busy}
                onClick={() => setConfirmRestart(true)}
              >
                Retry from scratch
              </button>
            )}
          </>
        ) : null}
        {ticket.blockedReason === "protected-path-changed" ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => act.mutate({ kind: "approve" })}
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
              onClick={() => act.mutate({ kind: "cancel", cascade })}
            >
              Cancel {ticket.displayId} for good
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setConfirmCancel(false);
                setCascade(false);
              }}
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
      <Problem error={act.error} />
    </li>
  );
}

const MAX_EXTRA_HOURS = 168; // what the API accepts: seven days

function PausedSpec({ spec }: { spec: Queue["specs"][number] }) {
  const api = useApi();
  // kept as typed, so the field can be emptied and retyped
  const [hours, setHours] = useState("1");
  const seconds = Math.round(Number(hours) * 3600);
  const valid =
    hours.trim() !== "" &&
    Number.isFinite(seconds) &&
    seconds >= 1 &&
    Number(hours) <= MAX_EXTRA_HOURS;
  const resume = useAction(async (extraSeconds: number) => {
    const { data, error } = await api.POST("/specs/{id}/resume", {
      params: { path: { id: spec.id } },
      body: { extraSeconds },
    });
    if (!data) throw new Error(describeError(error));
  });
  return (
    <li className="blocked-card" data-testid={`paused-${spec.displayId}`}>
      <h3>
        <a href={paths.spec(spec.id)}>{spec.displayId}</a> {spec.title}
      </h3>
      <p>
        <StatusBadge kind="spec" code="paused" /> {spec.reason}
      </p>
      <div className="actions">
        <label>
          Add{" "}
          <input
            type="number"
            min={0}
            max={MAX_EXTRA_HOURS}
            step={0.5}
            value={hours}
            aria-label={`extra agent hours for ${spec.displayId}`}
            onChange={(event) => setHours(event.target.value)}
          />{" "}
          agent hours
        </label>
        <button
          type="button"
          disabled={resume.isPending || !valid}
          onClick={() => resume.mutate(seconds)}
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
  const [note, setNote] = useState("");
  const retry = useAction(async () => {
    const { data, error } = await api.POST("/specs/{id}/final/retry", {
      params: { path: { id: item.specId } },
      body: retryFinalBody(note),
    });
    if (!data) throw new Error(describeError(error));
  });
  const waive = useAction(async () => {
    const { data, error } = await api.POST("/specs/{id}/final/waive", {
      params: { path: { id: item.specId } },
    });
    if (!data) throw new Error(describeError(error));
  });
  const beforePullRequests = item.step === "final-e2e";
  return (
    <li
      className="blocked-card"
      data-testid={`final-${item.specDisplayId}-${item.repo}`}
    >
      <h3>
        <a href={paths.spec(item.specId)}>{item.specDisplayId}</a>{" "}
        {beforePullRequests
          ? "e2e before the pull requests"
          : `overall review of ${item.repo}`}
      </h3>
      <p>
        {item.step}{" "}
        <StatusBadge kind="blocked" code={item.blockedReason ?? "blocked"} />
      </p>
      <Brief reason={item.blockedReason} brief={item.brief} />
      <RetryNoteField
        id={`retry-note-final-${item.specDisplayId}-${item.repo}`}
        value={note}
        onChange={setNote}
      />
      <div className="actions">
        <button
          type="button"
          disabled={retry.isPending}
          onClick={() => retry.mutate()}
        >
          Run {item.step} again
        </button>
        {beforePullRequests ? (
          <button
            type="button"
            disabled={waive.isPending}
            onClick={() => waive.mutate()}
          >
            Open the pull requests anyway
          </button>
        ) : null}
      </div>
      <Problem error={retry.error} />
      <Problem error={waive.error} />
    </li>
  );
}

// Nothing here is done by a button: the platform never touches a pull request. A person reopens it on the host, or
// reworks the spec, or cancels it (plat spec cancel).
function StuckPullRequest({ item }: { item: Queue["pullRequests"][number] }) {
  return (
    <li
      className="blocked-card"
      data-testid={`pull-${item.specDisplayId}-${item.repo}`}
    >
      <h3>
        <a href={paths.spec(item.specId)}>{item.specDisplayId}</a>{" "}
        <a href={item.url}>
          {item.repo} #{item.number}
        </a>
      </h3>
      <p>
        {item.state === "closed" ? (
          <StatusBadge kind="pr" code={item.state} />
        ) : null}
        {item.syncError ? (
          <span className="error"> could not be read: {item.syncError}</span>
        ) : null}
      </p>
      {item.state === "closed" ? (
        <p className="note">
          Reopen it on the host, rework the spec, or cancel it (plat spec cancel{" "}
          {item.specDisplayId}).
        </p>
      ) : null}
    </li>
  );
}

function StuckCleanup({ item }: { item: Queue["cleanups"][number] }) {
  return (
    <li className="blocked-card" data-testid={`cleanup-${item.specDisplayId}`}>
      <h3>
        <a href={paths.spec(item.specId)}>{item.specDisplayId}</a>
      </h3>
      <p className="error">Clean-up did not finish: {item.error}</p>
      <p className="note">
        Branches or pull requests may be left on the code host. Try again with
        plat spec cleanup {item.specDisplayId}.
      </p>
    </li>
  );
}

function StuckReady({ item }: { item: Queue["readyFailures"][number] }) {
  return (
    <li
      className="blocked-card"
      data-testid={`ready-${item.specDisplayId}-${item.repo}`}
    >
      <h3>
        <a href={paths.spec(item.specId)}>{item.specDisplayId}</a>{" "}
        <a href={item.url}>
          {item.repo} #{item.number}
        </a>
      </h3>
      <p className="error">Could not be turned ready: {item.error}</p>
      <p className="note">
        It is still a draft. Turn it ready on the code host once the pull
        requests it follows are merged; the platform sees that at its next look.
      </p>
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
  // one failed poll must not wipe a page that is being worked on: the error only replaces it when there is
  // nothing to show
  if (queue.isError && !queue.data)
    return (
      <p className="error" role="alert">
        Could not load the queue: {queue.error.message}
      </p>
    );
  const {
    tickets,
    finalizations,
    pullRequests,
    cleanups,
    readyFailures,
    specs,
  } = queue.data as NonNullable<typeof queue.data>;
  if (
    tickets.length +
      finalizations.length +
      pullRequests.length +
      cleanups.length +
      readyFailures.length +
      specs.length ===
    0
  ) {
    return <p className="note">Nothing is waiting for you.</p>;
  }
  return (
    <section className="blocked-queue">
      {tickets.length > 0 ? (
        <Section title="Blocked tickets">
          {tickets.map((ticket) => (
            <TicketCard
              key={`${ticket.id}-${ticket.blockedReason}`}
              ticket={ticket}
            />
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
      {pullRequests.length > 0 ? (
        <Section title="Pull requests that need a look">
          {pullRequests.map((item) => (
            <StuckPullRequest key={`${item.specId}-${item.repo}`} item={item} />
          ))}
        </Section>
      ) : null}
      {cleanups.length > 0 ? (
        <Section title="Clean-ups that did not finish">
          {cleanups.map((item) => (
            <StuckCleanup key={item.specId} item={item} />
          ))}
        </Section>
      ) : null}
      {readyFailures.length > 0 ? (
        <Section title="Draft pull requests that could not be turned ready">
          {readyFailures.map((item) => (
            <StuckReady key={`${item.specId}-${item.repo}`} item={item} />
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
