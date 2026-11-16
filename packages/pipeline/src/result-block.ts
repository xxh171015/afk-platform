// The <result> block of an agent's last message, read the way the prompts ask for it: each tag on a line of its
// own, the JSON in between. Sandcastle cuts at the tag wherever it appears, so a result whose JSON mentions
// <result> in a string (a summary, an acceptance criterion copied word for word) came back cut in the middle
// (Runs 684, 688, 691). A string inside the JSON never spans lines, so it cannot end or start one with a tag.

const FENCE = /^```[a-z]*\s*\n([\s\S]*?)\n```\s*$/i;

// The lines between the last line that starts with `</tag>` and the last line before it that ends with `<tag>`,
// or undefined when there is no such pair. Cursor joins the agent's messages without a newline, so prose can
// sit on the same lines, outside the tags. A ```json fence around the JSON is dropped.
export function resultBlock(text: string, tag: string): string | undefined {
  const lines = text.split(/\r?\n/);
  const close = lines.findLastIndex((line) =>
    line.trimStart().startsWith(`</${tag}>`),
  );
  if (close < 0) return undefined;
  const open = lines
    .slice(0, close)
    .findLastIndex((line) => line.trimEnd().endsWith(`<${tag}>`));
  if (open < 0) return undefined;
  const body = lines
    .slice(open + 1, close)
    .join("\n")
    .trim();
  return body.match(FENCE)?.[1]?.trim() ?? body;
}
