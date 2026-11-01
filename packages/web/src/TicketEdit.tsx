import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { describeError, useApi } from "./api.tsx";

// Edit a pending or blocked ticket from its file (the same text plat ticket edit --file takes).
// Content version only goes up when the file actually changed.

export function TicketEdit({
  ticketId,
  file,
}: {
  ticketId: number;
  file?: string;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const loaded = useQuery({
    queryKey: ["ticket", ticketId, "file"],
    enabled: file === undefined,
    queryFn: async () => {
      const { data, error } = await api.GET("/tickets/{id}", {
        params: { path: { id: ticketId } },
      });
      if (!data) throw new Error(describeError(error));
      return data.ticket.file as string;
    },
  });
  const source = file ?? loaded.data ?? "";
  const [draft, setDraft] = useState(source);
  useEffect(() => {
    setDraft(source);
  }, [source]);
  const save = useMutation({
    mutationFn: async () => {
      const { data, error } = await api.POST("/tickets/{id}/edit", {
        params: { path: { id: ticketId } },
        body: { file: draft },
      });
      if (!data) throw new Error(describeError(error));
      return data;
    },
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ["ticket", ticketId] }),
        queryClient.invalidateQueries({ queryKey: ["blocked"] }),
      ]),
  });
  if (file === undefined && loaded.isPending) {
    return <p className="note">Loading the ticket…</p>;
  }
  if (file === undefined && loaded.isError) {
    return (
      <p className="error" role="alert">
        {loaded.error.message}
      </p>
    );
  }
  return (
    <div className="ticket-edit">
      <label htmlFor={`ticket-file-${ticketId}`}>
        票正文
        <textarea
          id={`ticket-file-${ticketId}`}
          value={draft}
          rows={12}
          onChange={(event) => setDraft(event.target.value)}
        />
      </label>
      <div className="actions">
        <button
          type="button"
          disabled={save.isPending || draft === source}
          onClick={() => save.mutate()}
        >
          保存正文
        </button>
      </div>
      {save.error ? (
        <p className="error" role="alert">
          {save.error.message}
        </p>
      ) : null}
    </div>
  );
}

export function WaitingTicketEdit({ ticketId }: { ticketId: number }) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)}>
        改正文
      </button>
    );
  }
  return <TicketEdit ticketId={ticketId} />;
}
