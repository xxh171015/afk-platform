import { parseDisplayId } from "@afk/shared";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { describeError, useApi } from "./api.tsx";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "./components/ui/command.tsx";
import { SEARCH_DEBOUNCE_MS } from "./SearchBox.tsx";
import { StatusBadge } from "./StatusBadge.tsx";

// ⌘K: search specs and tickets, or jump to a Run by typing R-n.

export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const api = useApi();
  const navigate = useNavigate();
  const [typed, setTyped] = useState("");
  const [asked, setAsked] = useState("");

  useEffect(() => {
    if (!open) {
      setTyped("");
      setAsked("");
      return;
    }
    const text = typed.trim();
    const timer = setTimeout(
      () => setAsked(text),
      text === "" ? 0 : SEARCH_DEBOUNCE_MS,
    );
    return () => clearTimeout(timer);
  }, [typed, open]);

  const parsed = parseDisplayId(asked.toUpperCase());

  const results = useQuery({
    queryKey: ["search", asked],
    enabled: open && asked !== "" && parsed?.kind !== "run",
    queryFn: async () => {
      const { data, error } = await api.GET("/search", {
        params: { query: { q: asked } },
      });
      if (!data) throw new Error(describeError(error));
      return data;
    },
  });

  const go = (params: {
    specId?: string;
    ticketId?: string;
    runId?: string;
  }) => {
    onOpenChange(false);
    if (params.specId)
      void navigate({
        to: "/specs/$specId",
        params: { specId: params.specId },
      });
    else if (params.ticketId)
      void navigate({
        to: "/tickets/$ticketId",
        params: { ticketId: params.ticketId },
      });
    else if (params.runId)
      void navigate({
        to: "/runs/$runId",
        params: { runId: params.runId },
      });
  };

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput
        value={typed}
        onValueChange={setTyped}
        placeholder="搜索需求与票"
        aria-label="搜索需求与票"
      />
      <CommandList>
        {asked === "" ? (
          <CommandEmpty>输入编号、标题或正文</CommandEmpty>
        ) : parsed?.kind === "run" ? (
          <CommandGroup heading="Run">
            <CommandItem
              value={`R-${parsed.id}`}
              onSelect={() => go({ runId: String(parsed.id) })}
            >
              R-{parsed.id}
            </CommandItem>
          </CommandGroup>
        ) : results.isPending ? (
          <CommandEmpty>搜索中…</CommandEmpty>
        ) : results.isError ? (
          <CommandEmpty>搜索失败: {results.error.message}</CommandEmpty>
        ) : (results.data?.specs.length ?? 0) +
            (results.data?.tickets.length ?? 0) ===
          0 ? (
          <CommandEmpty>没有找到 “{asked}”</CommandEmpty>
        ) : (
          <>
            {(results.data?.specs.length ?? 0) > 0 ? (
              <CommandGroup heading="需求">
                {results.data?.specs.map((spec) => (
                  <CommandItem
                    key={spec.id}
                    value={`${spec.displayId} ${spec.title}`}
                    onSelect={() => go({ specId: String(spec.id) })}
                  >
                    {spec.displayId} {spec.title}{" "}
                    <StatusBadge kind="spec" code={spec.state} />
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}
            {(results.data?.tickets.length ?? 0) > 0 ? (
              <CommandGroup heading="票">
                {results.data?.tickets.map((ticket) => (
                  <CommandItem
                    key={ticket.id}
                    value={`${ticket.displayId} ${ticket.title}`}
                    onSelect={() => go({ ticketId: String(ticket.id) })}
                  >
                    {ticket.displayId} {ticket.title}{" "}
                    <StatusBadge kind="ticket" code={ticket.state} />
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}
          </>
        )}
      </CommandList>
    </CommandDialog>
  );
}
