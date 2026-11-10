import { readSkillSnapshot } from "./skills-snapshot.ts";

const h2Names = (text: string): string[] =>
  [...text.matchAll(/^## (.+?)\s*$/gm)].map((m) => m[1] as string);

/** The `## ` section names of the to-spec template, in order, read from the snapshot of the skill. */
export function specTemplateSections(): string[] {
  const content = readSkillSnapshot("to-spec/SKILL.md");
  const template = /<spec-template>([\s\S]*?)<\/spec-template>/.exec(content);
  if (!template?.[1]) throw new Error("to-spec has no <spec-template>");
  return [...template[1].matchAll(/^## (.+?)\s*$/gm)].map(
    (m) => m[1] as string,
  );
}

/** Line endings as LF and exactly one final newline: the only change a spec body undergoes on its way in. */
export function normalizeSpecBody(text: string): string {
  return `${text.replace(/\r\n?/g, "\n").replace(/\n+$/, "")}\n`;
}

const TESTING_DECISIONS = "Testing Decisions";

/** Numbered User Stories in the spec body, in the order they are written. */
export function userStoriesOf(
  body: string,
): { number: number; text: string }[] {
  const heading = specTemplateSections().find((name) =>
    /^user stories$/i.test(name),
  );
  if (!heading) return [];
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const section = new RegExp(
    `^## ${escaped}\\s*$([\\s\\S]*?)(?=^## |(?![\\s\\S]))`,
    "m",
  ).exec(body);
  if (!section?.[1]) return [];
  const stories: { number: number; text: string }[] = [];
  const seen = new Set<number>();
  for (const line of section[1].split("\n")) {
    const start = /^(\d+)\.\s+(\S.*)$/.exec(line);
    if (start) {
      const number = Number(start[1]);
      if (seen.has(number)) continue;
      seen.add(number);
      stories.push({ number, text: start[2] as string });
    } else if (line.trim() !== "" && stories.at(-1)) {
      const last = stories.at(-1);
      if (last) last.text += `\n${line}`;
    }
  }
  return stories;
}

/**
 * Notes on a spec body that do not follow the to-spec template: a section missing or renamed, and no seams in
 * Testing Decisions. They are only advice; the spec is stored as written.
 */
export function specTemplateWarnings(body: string): string[] {
  const headings = new Set(h2Names(body));
  const warnings = specTemplateSections()
    .filter((name) => !headings.has(name))
    .map(
      (name) =>
        `the spec has no ## ${name} section, as to-spec's template names it`,
    );
  if (headings.has(TESTING_DECISIONS)) {
    const section = new RegExp(
      `^## ${TESTING_DECISIONS}\\s*$([\\s\\S]*?)(?=^## |(?![\\s\\S]))`,
      "m",
    ).exec(body);
    if (!/seam/i.test(section?.[1] ?? "")) {
      warnings.push(
        "## Testing Decisions does not name the seams: unattended tdd writes tests only at seams that were confirmed",
      );
    }
  }
  return warnings;
}
