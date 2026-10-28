import { useEffect, useState } from "react";
import { SpecDetail } from "./SpecDetail.tsx";
import { SpecList } from "./SpecList.tsx";

// Two views for now, picked by the part of the address after the "#": the list, and one spec.

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
  return (
    <main>
      <header>
        <h1>
          <a href="#/">AFK platform</a>
        </h1>
      </header>
      {spec ? <SpecDetail specId={Number(spec[1])} /> : <SpecList />}
    </main>
  );
}
