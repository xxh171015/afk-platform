import { useEffect, useState } from "react";
import { SpecDetail } from "./SpecDetail.tsx";
import { SpecList } from "./SpecList.tsx";
import { TicketDetail } from "./TicketDetail.tsx";

// Three views, picked by the part of the address after the "#": the list, one spec, one ticket.

function currentHash(): string {
  return window.location.hash.replace(/^#/, "") || "/";
}

export function App() {
  const [path, setPath] = useState(currentHash());
  useEffect(() => {
    const onChange = () => setPath(currentHash());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);

  const spec = /^\/specs\/([1-9][0-9]*)$/.exec(path);
  const ticket = /^\/tickets\/([1-9][0-9]*)$/.exec(path);
  return (
    <main>
      <header>
        <h1>
          <a href="#/">AFK platform</a>
        </h1>
      </header>
      {spec ? (
        <SpecDetail specId={Number(spec[1])} />
      ) : ticket ? (
        <TicketDetail ticketId={Number(ticket[1])} />
      ) : (
        <SpecList />
      )}
    </main>
  );
}
