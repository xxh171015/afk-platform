import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { describeError, useApi } from "./api.tsx";

// The search box at the top of every page: type a number (S-12, T-5), part of a title or of a body. Results come
// grouped as specs and tickets; choosing one goes to its page.

export const SEARCH_DEBOUNCE_MS = 250;

export function SearchBox({
  debounceMs = SEARCH_DEBOUNCE_MS,
}: {
  debounceMs?: number;
}) {
  const api = useApi();
  const [typed, setTyped] = useState("");
  const [asked, setAsked] = useState("");

  // ask once the typing pauses, not on every key
  useEffect(() => {
    const text = typed.trim();
    const timer = setTimeout(
      () => setAsked(text),
      text === "" ? 0 : debounceMs,
    );
    return () => clearTimeout(timer);
  }, [typed, debounceMs]);

  const results = useQuery({
    queryKey: ["search", asked],
    enabled: asked !== "",
    queryFn: async () => {
      const { data, error } = await api.GET("/search", {
        params: { query: { q: asked } },
      });
      if (!data) throw new Error(describeError(error));
      return data;
    },
  });

  const close = () => {
    setTyped("");
    setAsked("");
  };

  return (
    <search className="search">
      <input
        type="search"
        value={typed}
        placeholder="Search specs and tickets"
        aria-label="Search specs and tickets"
        onChange={(event) => setTyped(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") close();
        }}
      />
      {asked !== "" ? (
        <div className="search-results" data-testid="search-results">
          {results.isPending ? <p className="note">Searching…</p> : null}
          {results.isError ? (
            <p className="error" role="alert">
              Search failed: {results.error.message}
            </p>
          ) : null}
          {results.data ? (
            results.data.specs.length + results.data.tickets.length === 0 ? (
              <p className="note">Nothing found for “{asked}”.</p>
            ) : (
              <>
                {results.data.specs.length > 0 ? (
                  <>
                    <h4>Specs</h4>
                    <ul>
                      {results.data.specs.map((spec) => (
                        <li key={spec.id}>
                          <a href={`#/specs/${spec.id}`} onClick={close}>
                            {spec.displayId} {spec.title}
                          </a>{" "}
                          <span className={`badge spec-${spec.state}`}>
                            {spec.state}
                          </span>{" "}
                          <span className="note">
                            in {spec.matched.join(", ")}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </>
                ) : null}
                {results.data.tickets.length > 0 ? (
                  <>
                    <h4>Tickets</h4>
                    <ul>
                      {results.data.tickets.map((ticket) => (
                        <li key={ticket.id}>
                          <a href={`#/tickets/${ticket.id}`} onClick={close}>
                            {ticket.displayId} {ticket.title}
                          </a>{" "}
                          <span className={`badge ticket-${ticket.state}`}>
                            {ticket.state}
                          </span>{" "}
                          <span className="note">
                            of {ticket.specDisplayId}, in{" "}
                            {ticket.matched.join(", ")}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </>
                ) : null}
              </>
            )
          ) : null}
        </div>
      ) : null}
    </search>
  );
}
