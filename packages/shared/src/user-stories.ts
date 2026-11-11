/** Numbered User Stories in the spec body, in the order they are written. */
export function userStoriesOf(
  body: string,
): { number: number; text: string }[] {
  const heading = [...body.matchAll(/^## (.+?)\s*$/gm)]
    .map((m) => m[1] as string)
    .find((name) => /^user stories$/i.test(name));
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

/** User Story numbers no ticket's `stories` names. Empty when no ticket wrote `stories`; that list would have no information. */
export function uncoveredUserStories(
  specBody: string,
  ticketsStories: readonly (readonly number[])[],
): number[] {
  if (!ticketsStories.some((stories) => stories.length > 0)) return [];
  const covered = new Set(ticketsStories.flat());
  return userStoriesOf(specBody)
    .filter((story) => !covered.has(story.number))
    .map((story) => story.number);
}
