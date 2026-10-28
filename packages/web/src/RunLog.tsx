import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { describeError, useApi } from "./api.tsx";

// The log of one run (render it with key={runId}: a different run starts a log of its own), read in slices from where the last one ended. While the run is going it asks again every
// few seconds; once the run is finished and everything is read it stops. A new attempt of the job starts a new
// log, so the text begins again from the top.

export const LOG_POLL_MS = 3_000;

interface Position {
  attempt: number | undefined;
  offset: number;
  text: string;
}

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
        // no attempt: the API answers for the job's current one, which is how a retry shows up here
        params: { path: { id: runId }, query: { offset: position.offset } },
      });
      if (!data) throw new Error(describeError(error));
      return data;
    },
    // keep asking until the run is over and we have everything it wrote
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
        return { attempt: data.attempt, offset: 0, text: "" }; // a new attempt: its log is a different file
      }
      if (data.offset !== current.offset) return current; // an answer to an older question
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

  if (slice.isError)
    return (
      <p className="error" role="alert">
        Could not load the log: {slice.error.message}
      </p>
    );
  if (position.text === "") {
    return (
      <p className="note">
        {slice.isPending ? "Loading the log…" : "Nothing logged yet."}
      </p>
    );
  }
  return (
    <pre className="run-log" data-testid="run-log">
      {position.text}
    </pre>
  );
}
