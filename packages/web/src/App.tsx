import { useEffect, useState } from "react";
import { BlockedQueue, useBlocked } from "./BlockedQueue.tsx";
import { SearchBox } from "./SearchBox.tsx";
import { SpecDetail } from "./SpecDetail.tsx";
import { SpecList } from "./SpecList.tsx";
import { TicketDetail } from "./TicketDetail.tsx";

// The views, picked by the part of the address after the "#": the list, one spec, one ticket, and the queue of
// what waits for a person.

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

  const queue = useBlocked();
  const waiting = queue.data
    ? queue.data.tickets.length +
      queue.data.finalizations.length +
      queue.data.specs.length
    : 0;
  const spec = /^\/specs\/([1-9][0-9]*)$/.exec(path);
  const ticket = /^\/tickets\/([1-9][0-9]*)$/.exec(path);
  return (
    <main>
      <header>
        <h1>
          <a href="#/">AFK platform</a>
        </h1>
        <SearchBox />
        <nav>
          <a href="#/">Specs</a>{" "}
          <a href="#/blocked">
            Waiting for you{waiting > 0 ? ` (${waiting})` : ""}
          </a>
        </nav>
      </header>
      {path === "/blocked" ? (
        <BlockedQueue />
      ) : spec ? (
        <SpecDetail specId={Number(spec[1])} />
      ) : ticket ? (
        <TicketDetail ticketId={Number(ticket[1])} />
      ) : (
        <SpecList />
      )}
    </main>
  );
}
