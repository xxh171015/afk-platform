import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { describeError, useApi } from "./api.tsx";
import { Button } from "./components/ui/button.tsx";

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
    return <p className="text-sm text-muted-foreground">加载票正文…</p>;
  }
  if (file === undefined && loaded.isError) {
    return (
      <p className="text-sm text-state-blocked" role="alert">
        {loaded.error.message}
      </p>
    );
  }
  return (
    <div className="space-y-3">
      <label
        htmlFor={`ticket-file-${ticketId}`}
        className="grid gap-1.5 text-[13px]"
      >
        票正文
        <textarea
          id={`ticket-file-${ticketId}`}
          value={draft}
          rows={12}
          onChange={(event) => setDraft(event.target.value)}
          className="w-full rounded-md border bg-background px-3 py-2 font-mono text-[12px] leading-6"
        />
      </label>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          disabled={save.isPending || draft === source}
          onClick={() => save.mutate()}
        >
          保存正文
        </Button>
      </div>
      {save.error ? (
        <p className="text-sm text-state-blocked" role="alert">
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
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => setOpen(true)}
      >
        改正文
      </Button>
    );
  }
  return <TicketEdit ticketId={ticketId} />;
}
