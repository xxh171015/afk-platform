import { type ReactNode, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// A spec or ticket body as the reader sees it: GitHub-flavoured markdown (task lists, tables, code blocks) turned
// into React elements. Raw HTML in the text is not rendered, so a body can not put markup on the page.

export interface BodySection {
  id: string;
  title: string;
}

const sectionId = (line: number) => `body-section-${line}`;

// The `##` sections of a markdown text, for a table of contents. A heading inside a code fence is text.
export function bodySections(source: string): BodySection[] {
  const sections: BodySection[] = [];
  let fence: string | undefined;
  source.split("\n").forEach((text, index) => {
    const marker = /^\s*(```+|~~~+)/.exec(text)?.[1];
    if (marker) {
      if (fence === undefined) fence = marker[0];
      else if (marker[0] === fence) fence = undefined;
    }
    const heading = fence === undefined ? /^## (.+?)\s*$/.exec(text) : null;
    if (heading)
      sections.push({
        id: sectionId(index + 1),
        title: heading[1] as string,
      });
  });
  return sections;
}

export function Markdown({
  source,
  contents = false,
}: {
  source: string;
  // a table of contents of the `##` sections above the text
  contents?: boolean;
}) {
  const sections = useMemo(() => bodySections(source), [source]);
  return (
    <div className="markdown">
      {contents && sections.length > 0 ? (
        <nav className="contents" aria-label="目录">
          <ul>
            {sections.map((section) => (
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
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h2: ({
            node,
            children,
          }: {
            node?: unknown;
            children?: ReactNode;
          }) => {
            const line = (node as { position?: { start: { line: number } } })
              ?.position?.start.line;
            return (
              <h2 id={line === undefined ? undefined : sectionId(line)}>
                {children}
              </h2>
            );
          },
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
