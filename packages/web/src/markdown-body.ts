export interface MarkdownSection {
  title: string;
  id: string;
  body: string;
  startLine: number;
}

const sectionId = (line: number) => `body-section-${line}`;

export const SPEC_SECTION_LABELS: Record<string, string> = {
  "Problem Statement": "问题",
  Solution: "方案",
  "User Stories": "用户故事",
  "Implementation Decisions": "实现决策",
  "Testing Decisions": "测试决策",
  "Out of Scope": "不在范围内",
  "Further Notes": "补充说明",
};

export const TICKET_SECTION_LABELS: Record<string, string> = {
  Parent: "所属需求",
  "What to build": "要做的事",
  "Acceptance criteria": "验收标准",
  "Blocked by": "依赖",
};

export function sectionLabel(
  title: string,
  labels: Record<string, string>,
): string {
  return labels[title] ?? title;
}

// The `##` sections of a markdown text, including the lines under each heading.
// A heading inside a code fence is text. Leading lines before the first heading are a section with no title.
export function splitMarkdownSections(source: string): MarkdownSection[] {
  const sections: MarkdownSection[] = [];
  let fence: string | undefined;
  let current: MarkdownSection | null = null;
  const start = (title: string, line: number) => {
    current = { title, id: sectionId(line), body: "", startLine: line };
    sections.push(current);
  };
  source.split("\n").forEach((text, index) => {
    const line = index + 1;
    const marker = /^\s*(```+|~~~+)/.exec(text)?.[1];
    if (marker) {
      if (fence === undefined) fence = marker[0];
      else if (marker[0] === fence) fence = undefined;
    }
    const heading = fence === undefined ? /^## (.+?)\s*$/.exec(text) : null;
    if (heading) {
      start(heading[1] as string, line);
      return;
    }
    if (!current) {
      if (text.trim() === "") return;
      start("", line);
    }
    if (current) {
      current.body = current.body ? `${current.body}\n${text}` : text;
    }
  });
  return sections.map((section) => ({
    ...section,
    body: section.body.replace(/^\n+/, "").replace(/\n+$/, ""),
  }));
}

export function specExcerpt(body: string): string | null {
  const problem = splitMarkdownSections(body).find(
    (section) => section.title === "Problem Statement",
  );
  const text = (problem?.body || splitMarkdownSections(body)[0]?.body || body)
    .replace(/[#*_`]/g, "")
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!text) return null;
  return text.length > 180 ? `${text.slice(0, 177)}…` : text;
}
