// Spec / Ticket / Run trailers (docs/design.md「上下文沉淀与缺陷回流」): taken with a regex
// from anywhere in the message, not git's trailer parser, so a line moved into the body still counts.

export interface ParsedTrailers {
  spec?: string;
  ticket?: string;
  run?: string;
}

const KEYS = {
  spec: /(?:^|\n)Spec:\s*(S-[1-9][0-9]*)(?=\s|$)/g,
  ticket: /(?:^|\n)Ticket:\s*(T-[1-9][0-9]*)(?=\s|$)/g,
  run: /(?:^|\n)Run:\s*(R-[1-9][0-9]*)(?=\s|$)/g,
} as const;

function lastId(text: string, pattern: RegExp): string | undefined {
  const re = new RegExp(pattern.source, pattern.flags);
  let last: string | undefined;
  let match = re.exec(text);
  while (match) {
    last = match[1];
    match = re.exec(text);
  }
  return last;
}

export function parseTrailers(text: string): ParsedTrailers {
  const spec = lastId(text, KEYS.spec);
  const ticket = lastId(text, KEYS.ticket);
  const run = lastId(text, KEYS.run);
  return {
    ...(spec ? { spec } : {}),
    ...(ticket ? { ticket } : {}),
    ...(run ? { run } : {}),
  };
}
