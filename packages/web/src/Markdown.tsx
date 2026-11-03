import { type ReactNode, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  type MarkdownSection,
  SPEC_SECTION_LABELS,
  sectionLabel,
  splitMarkdownSections,
  TICKET_SECTION_LABELS,
} from "./markdown-body.ts";
import { paths } from "./paths.ts";

// A spec or ticket body as the reader sees it: GitHub-flavoured markdown (task lists, tables, code blocks) turned
// into React elements. Raw HTML in the text is not rendered, so a body can not put markup on the page.

export { splitMarkdownSections } from "./markdown-body.ts";
export type { MarkdownSection };

function headingId(node: unknown): { id?: string; line?: number } {
  const line = (node as { position?: { start: { line: number } } })?.position
    ?.start.line;
  return {
    line,
    id: line === undefined ? undefined : `body-section-${line}`,
  };
}

function MarkdownSource({
  source,
  headingIds = false,
}: {
  source: string;
  headingIds?: boolean;
}) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        input: (props) =>
          props.type === "checkbox" ? (
            <input {...props} disabled readOnly />
          ) : (
            <input {...props} />
          ),
        ...(headingIds
          ? {
              h2: ({
                node,
                children,
              }: {
                node?: unknown;
                children?: ReactNode;
              }) => <h2 id={headingId(node).id}>{children}</h2>,
            }
          : {}),
      }}
    >
      {source}
    </ReactMarkdown>
  );
}

export function Markdown({
  source,
  contents = false,
}: {
  source: string;
  contents?: boolean;
}) {
  const sections = useMemo(() => splitMarkdownSections(source), [source]);
  const toc = sections.filter((section) => section.title);
  return (
    <div className="markdown">
      {contents && toc.length > 0 ? (
        <nav className="markdown-toc" aria-label="目录">
          <ul>
            {toc.map((section) => (
              <li key={section.id}>
                <button
                  type="button"
                  className="link"
                  onClick={() =>
                    document
                      .getElementById(section.id)
                      ?.scrollIntoView?.({ behavior: "smooth" })
                  }
                >
                  {section.title}
                </button>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}
      <MarkdownSource source={source} headingIds={contents} />
    </div>
  );
}

function SectionBlock({
  section,
  labels,
}: {
  section: MarkdownSection;
  labels: Record<string, string>;
}) {
  const zh = section.title ? sectionLabel(section.title, labels) : null;
  const translated = zh && zh !== section.title;
  return (
    <section
      className="markdown-section"
      aria-labelledby={section.id || undefined}
    >
      {section.title ? (
        <header className="markdown-section-head">
          <h2 id={section.id}>{zh}</h2>
          {translated ? (
            <p className="markdown-section-en">{section.title}</p>
          ) : null}
        </header>
      ) : null}
      {section.body ? <MarkdownSource source={section.body} /> : null}
    </section>
  );
}

export function SpecBody({ source }: { source: string }) {
  const sections = useMemo(() => splitMarkdownSections(source), [source]);
  const toc = sections.filter((section) => section.title);
  return (
    <div className="markdown">
      {toc.length > 0 ? (
        <nav className="markdown-toc" aria-label="目录">
          <ul>
            {toc.map((section) => (
              <li key={section.id}>
                <button
                  type="button"
                  className="link"
                  onClick={() =>
                    document
                      .getElementById(section.id)
                      ?.scrollIntoView?.({ behavior: "smooth" })
                  }
                >
                  {sectionLabel(section.title, SPEC_SECTION_LABELS)}
                </button>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}
      {sections.map((section) => (
        <SectionBlock
          key={`${section.id}-${section.title}`}
          section={section}
          labels={SPEC_SECTION_LABELS}
        />
      ))}
    </div>
  );
}

function linkedIds(text: string): ReactNode {
  return text.split(/(S-[1-9][0-9]*|T-[1-9][0-9]*)/g).map((part, offset) => {
    const key = `${offset}:${part}`;
    const spec = /^S-([1-9][0-9]*)$/.exec(part);
    if (spec)
      return (
        <a key={key} href={paths.spec(Number(spec[1]))}>
          {part}
        </a>
      );
    const ticket = /^T-([1-9][0-9]*)$/.exec(part);
    if (ticket)
      return (
        <a key={key} href={paths.ticket(Number(ticket[1]))}>
          {part}
        </a>
      );
    return <span key={key}>{part}</span>;
  });
}

export function TicketBody({ source }: { source: string }) {
  const sections = useMemo(() => splitMarkdownSections(source), [source]);
  return (
    <div className="markdown">
      {sections.map((section) => {
        if (section.title === "Parent" || section.title === "Blocked by") {
          return (
            <section
              key={section.id}
              className="markdown-section"
              aria-labelledby={section.id}
            >
              <header className="markdown-section-head">
                <h2 id={section.id}>
                  {sectionLabel(section.title, TICKET_SECTION_LABELS)}
                </h2>
                <p className="markdown-section-en">{section.title}</p>
              </header>
              <p>{linkedIds(section.body)}</p>
            </section>
          );
        }
        return (
          <SectionBlock
            key={section.id}
            section={section}
            labels={TICKET_SECTION_LABELS}
          />
        );
      })}
    </div>
  );
}
