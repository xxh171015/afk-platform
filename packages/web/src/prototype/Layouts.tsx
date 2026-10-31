// PROTOTYPE (prototype/spec-ticket-body-display): three layouts each of the spec page and the ticket page, to
// decide how the spec body, the ticket body, the spec ⇄ ticket relation and the content versions should show.
// Switch with `?variant=A|B|C` (before the `#`) or the floating bar / ← →. Throwaway: the winner gets rewritten.
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { describeError, useApi } from "../api.tsx";
import { headings, Markdown, slug } from "./Markdown.tsx";
import { PrototypeSwitcher, useVariant } from "./Switcher.tsx";

interface SpecLike {
  displayId: string;
  title: string;
  body: string;
}
interface TicketRow {
  id: number;
  displayId: string;
  title: string;
  state: string;
  repo: string;
  type?: string;
}
interface EdgeRow {
  from: string;
  to: string;
  kind: string;
}

function SpecBody({ spec, toc }: { spec: SpecLike; toc?: boolean }) {
  if (!spec.body.trim())
    return (
      <p className="note">
        这份需求没有正文（创建时没带 <code>--file</code>）。
      </p>
    );
  const sections = headings(spec.body).filter((h) => h.level === 2);
  return (
    <>
      {toc && sections.length > 0 ? (
        <nav className="proto-toc">
          {sections.map((h) => (
            <button
              key={h.text}
              type="button"
              className="link"
              onClick={() =>
                document
                  .getElementById(`md-${slug(h.text)}`)
                  ?.scrollIntoView({ behavior: "smooth" })
              }
            >
              {h.text}
            </button>
          ))}
        </nav>
      ) : null}
      <article className="proto-doc">
        <Markdown source={spec.body} />
      </article>
    </>
  );
}

function TicketTree({
  spec,
  tickets,
  edges,
}: {
  spec: SpecLike;
  tickets: TicketRow[];
  edges: EdgeRow[];
}) {
  return (
    <div className="proto-tree">
      <strong>
        {spec.displayId} {spec.title}
      </strong>
      <ul>
        {tickets.map((t) => {
          const waits = edges.filter((e) => e.to === t.displayId);
          return (
            <li key={t.id}>
              <span className={`badge ticket-${t.state}`}>{t.state}</span>{" "}
              <a href={`#/tickets/${t.id}`}>{t.displayId}</a> {t.title}
              <div className="note">
                {t.repo}
                {waits.length > 0
                  ? ` · 等 ${waits.map((e) => `${e.from}（${e.kind}）`).join("、")}`
                  : " · 不等别的票"}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

type SpecParts = Record<
  | "header"
  | "confirmBlock"
  | "prs"
  | "pack"
  | "warnings"
  | "graph"
  | "ticketList"
  | "overall",
  ReactNode
>;

export function SpecLayout({
  spec,
  tickets,
  edges,
  parts,
}: {
  spec: SpecLike;
  tickets: TicketRow[];
  edges: EdgeRow[];
  parts: SpecParts;
}) {
  const variant = useVariant();
  const [tab, setTab] = useState<"doc" | "tickets" | "delivery">("doc");
  let page: ReactNode;
  if (variant === "A") {
    page = (
      <>
        {parts.header}
        {parts.confirmBlock}
        <h3>需求说明</h3>
        <SpecBody spec={spec} />
        {parts.prs}
        {parts.pack}
        {parts.warnings}
        {parts.graph}
        {parts.ticketList}
        {parts.overall}
      </>
    );
  } else if (variant === "B") {
    const tabs = [
      ["doc", "需求说明"],
      ["tickets", `票（${tickets.length}）`],
      ["delivery", "交付"],
    ] as const;
    page = (
      <>
        {parts.header}
        {parts.confirmBlock}
        <div className="proto-tabs" role="tablist">
          {tabs.map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              onClick={() => setTab(key)}
            >
              {label}
            </button>
          ))}
        </div>
        {tab === "doc" ? <SpecBody spec={spec} /> : null}
        {tab === "tickets" ? (
          <>
            {parts.warnings}
            {parts.graph}
            {parts.ticketList}
          </>
        ) : null}
        {tab === "delivery" ? (
          <>
            {parts.prs}
            {parts.pack}
            {parts.overall}
            <p className="note">还没有 PR 和验收包时这一页是空的。</p>
          </>
        ) : null}
      </>
    );
  } else {
    page = (
      <>
        {parts.header}
        <div className="proto-columns">
          <div>
            <SpecBody spec={spec} toc />
          </div>
          <aside>
            {parts.confirmBlock}
            <TicketTree spec={spec} tickets={tickets} edges={edges} />
            {parts.prs}
          </aside>
        </div>
        {parts.graph}
        {parts.warnings}
        {parts.pack}
        {parts.overall}
      </>
    );
  }
  return (
    <section className="spec-detail" data-variant={variant}>
      {page}
      <PrototypeSwitcher />
    </section>
  );
}

interface TicketLike {
  id: number;
  displayId: string;
  title: string;
  type: string;
  repo: string;
  specId: number;
  specDisplayId: string;
  body: string;
  acceptanceCriteria: string[];
  modules: string[];
  contentVersion: number;
}
interface Neighbour {
  id: number;
  displayId: string;
  kind: string;
  state: string;
}

// what the agent reads as /context/ticket.md (packages/pipeline/src/context.ts)
function agentTicketMarkdown(t: TicketLike): string {
  return [
    `# ${t.displayId} ${t.title}`,
    "",
    `Type: ${t.type}`,
    "",
    "## Acceptance criteria",
    ...t.acceptanceCriteria.map((item) => `- ${item}`),
    "",
    "## Modules",
    ...t.modules.map((glob) => `- ${glob}`),
    "",
    t.body ? `## Details\n\n${t.body}` : "",
  ].join("\n");
}

function useSpecTitle(specId: number) {
  const api = useApi();
  return useQuery({
    queryKey: ["spec", specId],
    queryFn: async () => {
      const { data, error } = await api.GET("/specs/{id}", {
        params: { path: { id: specId } },
      });
      if (!data) throw new Error(describeError(error));
      return data;
    },
  });
}

function useTicketVersion(id: number, version: number | undefined) {
  const api = useApi();
  return useQuery({
    queryKey: ["ticket", id, "version", version],
    enabled: version !== undefined,
    queryFn: async () => {
      const { data, error } = await api.GET("/tickets/{id}", {
        params: { path: { id }, query: { version } },
      });
      if (!data) throw new Error(describeError(error));
      return data.ticket as TicketLike;
    },
  });
}

function Relations({
  ticket,
  specTitle,
  upstream,
  downstream,
}: {
  ticket: TicketLike;
  specTitle?: string;
  upstream: Neighbour[];
  downstream: Neighbour[];
}) {
  return (
    <div className="proto-relations">
      <div>
        所属需求：
        <a href={`#/specs/${ticket.specId}`}>
          {ticket.specDisplayId} {specTitle ?? ""}
        </a>
      </div>
      <div>
        等：
        {upstream.length === 0
          ? "无"
          : upstream.map((e) => (
              <span key={`${e.id}-${e.kind}`}>
                <a href={`#/tickets/${e.id}`}>{e.displayId}</a>（{e.kind}，
                {e.state}）{" "}
              </span>
            ))}
      </div>
      <div>
        挡住：
        {downstream.length === 0
          ? "无"
          : downstream.map((e) => (
              <span key={`${e.id}-${e.kind}`}>
                <a href={`#/tickets/${e.id}`}>{e.displayId}</a>（{e.kind}，
                {e.state}）{" "}
              </span>
            ))}
      </div>
    </div>
  );
}

type TicketParts = Record<
  "header" | "e2e" | "acceptance" | "runsBlock" | "gates" | "findingsBlock",
  ReactNode
>;

export function TicketLayout({
  ticket,
  upstream,
  downstream,
  versions,
  parts,
}: {
  ticket: TicketLike;
  upstream: Neighbour[];
  downstream: Neighbour[];
  versions: { version: number; createdAt: string }[];
  parts: TicketParts;
}) {
  const variant = useVariant();
  const spec = useSpecTitle(ticket.specId);
  const [tab, setTab] = useState<"doc" | "runs">("doc");
  const [raw, setRaw] = useState(false);
  const [picked, setPicked] = useState<number | undefined>();
  const older = useTicketVersion(
    ticket.id,
    picked !== undefined && picked !== ticket.contentVersion
      ? picked
      : undefined,
  );
  const shown = older.data ?? ticket;
  const specTitle = spec.data?.spec.title;

  const body = ticket.body.trim() ? (
    <article className="proto-doc">
      <Markdown source={ticket.body} />
    </article>
  ) : (
    <p className="note">这张票没有正文。</p>
  );
  const modules = (
    <p className="note">
      模块：
      {ticket.modules.map((m) => (
        <code key={m}>{m}</code>
      ))}
    </p>
  );

  let page: ReactNode;
  if (variant === "A") {
    page = (
      <>
        {parts.header}
        <Relations
          ticket={ticket}
          specTitle={specTitle}
          upstream={upstream}
          downstream={downstream}
        />
        <h3>票的说明</h3>
        {body}
        {parts.acceptance}
        {modules}
        {parts.e2e}
        {parts.runsBlock}
        {parts.gates}
        {parts.findingsBlock}
      </>
    );
  } else if (variant === "B") {
    page = (
      <>
        {parts.header}
        <div className="proto-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "doc"}
            onClick={() => setTab("doc")}
          >
            说明
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "runs"}
            onClick={() => setTab("runs")}
          >
            运行与门禁
          </button>
        </div>
        {tab === "doc" ? (
          <>
            <Relations
              ticket={ticket}
              specTitle={specTitle}
              upstream={upstream}
              downstream={downstream}
            />
            {body}
            {parts.acceptance}
            {modules}
          </>
        ) : (
          <>
            {parts.e2e}
            {parts.runsBlock}
            {parts.gates}
            {parts.findingsBlock}
          </>
        )}
      </>
    );
  } else {
    page = (
      <>
        {parts.header}
        <div className="proto-columns">
          <div>
            <div className="proto-doc-bar">
              <label>
                <input
                  type="checkbox"
                  checked={raw}
                  onChange={(e) => setRaw(e.target.checked)}
                />{" "}
                显示 agent 读到的原文（/context/ticket.md）
              </label>
              {versions.length > 1 ? (
                <select
                  value={picked ?? ticket.contentVersion}
                  onChange={(e) => setPicked(Number(e.target.value))}
                >
                  {versions.map((v) => (
                    <option key={v.version} value={v.version}>
                      v{v.version}（{v.createdAt.slice(0, 10)}）
                    </option>
                  ))}
                </select>
              ) : (
                <span className="note">v{ticket.contentVersion}，没改过</span>
              )}
            </div>
            {raw ? (
              <pre className="proto-raw">{agentTicketMarkdown(shown)}</pre>
            ) : (
              <article className="proto-doc">
                <Markdown source={agentTicketMarkdown(shown)} />
              </article>
            )}
          </div>
          <aside>
            <Relations
              ticket={ticket}
              specTitle={specTitle}
              upstream={upstream}
              downstream={downstream}
            />
            {spec.data ? (
              <TicketTree
                spec={spec.data.spec}
                tickets={spec.data.tickets}
                edges={spec.data.edges}
              />
            ) : null}
          </aside>
        </div>
        {parts.e2e}
        {parts.runsBlock}
        {parts.gates}
        {parts.findingsBlock}
      </>
    );
  }
  return (
    <section className="ticket-detail" data-variant={variant}>
      {page}
      <PrototypeSwitcher />
    </section>
  );
}
