// PROTOTYPE (prototype/spec-ticket-body-display): a tiny markdown renderer, just enough for the to-spec and
// to-tickets templates (headings, paragraphs, lists, checkboxes, code fences, inline code, bold, links). Throwaway.
import type { ReactNode } from "react";

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(pattern)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const token = m[0];
    const k = `${key}-${i++}`;
    if (token.startsWith("`")) out.push(<code key={k}>{token.slice(1, -1)}</code>);
    else if (token.startsWith("**")) out.push(<strong key={k}>{token.slice(2, -2)}</strong>);
    else {
      const [, label, href] = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token) ?? [];
      out.push(
        <a key={k} href={href}>
          {label}
        </a>,
      );
    }
    last = m.index + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export const slug = (text: string) =>
  text.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-");

export function headings(source: string): { level: number; text: string }[] {
  return source
    .replace(/\r\n/g, "\n")
    .split("\n")
    .flatMap((line) => {
      const m = /^(#{1,4})\s+(.*)$/.exec(line);
      return m ? [{ level: m[1].length, text: m[2] }] : [];
    });
}

export function Markdown({ source }: { source: string }) {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const key = `b${i}`;
    if (line.startsWith("```")) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) body.push(lines[i++]);
      i++;
      blocks.push(<pre key={key}>{body.join("\n")}</pre>);
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      const level = Math.min(h[1].length + 2, 6);
      const Tag = `h${level}` as "h3";
      blocks.push(
        <Tag key={key} id={`md-${slug(h[2])}`}>
          {inline(h[2], key)}
        </Tag>,
      );
      i++;
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items: ReactNode[] = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) {
        let text = lines[i].replace(/^\s*([-*]|\d+\.)\s+/, "");
        const k = `${key}-${i}`;
        const box = /^\[( |x)\]\s+/.exec(text);
        if (box) text = text.slice(box[0].length);
        items.push(
          <li key={k}>
            {box ? <input type="checkbox" readOnly checked={box[1] === "x"} /> : null}{" "}
            {inline(text, k)}
          </li>,
        );
        i++;
      }
      blocks.push(ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>);
      continue;
    }
    if (line.trim() === "") {
      i++;
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^(#{1,4}\s|```|\s*([-*]|\d+\.)\s+)/.test(lines[i])
    )
      para.push(lines[i++]);
    blocks.push(<p key={key}>{inline(para.join(" "), key)}</p>);
  }
  return <div className="markdown">{blocks}</div>;
}
