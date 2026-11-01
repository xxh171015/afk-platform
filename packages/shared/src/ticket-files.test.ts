import { describe, expect, it } from "vitest";
import { readTicketFiles, type TicketFile } from "./ticket-files.ts";

const front = (extra = "") =>
  `---\ntitle: 导出按钮\nrepo: backend\ntype: implementation\nmodules: ["src/orders/**"]\n${extra}---\n`;

const template = (acceptance: string, extra = "") =>
  `## Parent\n\nS-7\n\n## What to build\n\n做一个导出按钮。\n\n## Acceptance criteria\n\n${acceptance}${extra}`;

const file = (name: string, text: string): TicketFile => ({ name, text });
const errorsOf = (files: TicketFile[]) => {
  const result = readTicketFiles(files, 7);
  if (result.ok) throw new Error("expected the files to be refused");
  return result.errors;
};
const bodyOf = (text: string) => {
  const result = readTicketFiles([file("a.md", text)], 7);
  if (!result.ok) throw new Error(result.errors.join("\n"));
  return result.input.tickets[0];
};

describe("a ticket file", () => {
  it("keeps the body as written, whatever markdown it holds", () => {
    const body = [
      "## Parent",
      "",
      "S-7",
      "",
      "## What to build",
      "",
      "导出订单为 CSV。  ", // trailing spaces are kept
      "",
      "```md",
      "## Blocked by",
      "```",
      "",
      "| 列 | 说明 |",
      "| --- | --- |",
      "| id | 订单号 |",
      "",
      "- 外层",
      "  - 内层",
      "    - 更内层",
      "",
      "## Acceptance criteria",
      "",
      "- [ ] 下载的文件有表头  ",
      "- [ ] 中文 `代码` **粗体**",
      "",
    ].join("\n");
    const ticket = bodyOf(front() + body);
    expect(ticket?.body).toBe(body);
    expect(ticket?.acceptance).toEqual([
      "下载的文件有表头  ",
      "中文 `代码` **粗体**",
    ]);
  });

  it("changes only CRLF and the blank lines at the end", () => {
    const text = `${front()}${template("- [ ] a\n")}\n\n\n`.replace(
      /\n/g,
      "\r\n",
    );
    expect(bodyOf(text)?.body).toBe(template("- [ ] a\n"));
  });

  it("takes its key from the file name and its fields from the front matter", () => {
    const result = readTicketFiles(
      [
        file(
          "be-export.md",
          `${front("blocked_by: [contract]\nblocks: [T-5]\ncontract: c\nrefs: [frontend]\n")}${template("- [ ] a\n")}`,
        ),
      ],
      7,
    );
    expect(result).toMatchObject({
      ok: true,
      input: {
        tickets: [
          {
            key: "be-export",
            title: "导出按钮",
            repo: "backend",
            type: "implementation",
            modules: ["src/orders/**"],
            blocked_by: ["contract"],
            contract: ["c"],
            refs: ["frontend"],
          },
        ],
        edges: [{ from: "be-export", to: "T-5", kind: "blocks" }],
      },
    });
  });
});

describe("a refused directory", () => {
  it("names the ticket and the line of a criterion that is not a single-line checkbox", () => {
    const errors = errorsOf([
      file(
        "a.md",
        // front matter is 6 lines, the body starts on line 7: the stray line is line 18
        front() + template("- [ ] fine\n- [x] done already\n"),
      ),
    ]);
    expect(errors).toEqual([
      expect.stringMatching(
        /^a\.md:18: every line of `## Acceptance criteria`/,
      ),
    ]);
  });

  it("refuses a missing, an empty and a mixed acceptance section", () => {
    const errors = errorsOf([
      file("missing.md", `${front()}## Parent\n\nS-7\n`),
      file("empty.md", front() + template("")),
      file("mixed.md", front() + template("- [ ] a\nsome prose\n")),
    ]);
    expect(errors).toEqual([
      expect.stringMatching(/^missing\.md: no `## Acceptance criteria`/),
      expect.stringMatching(/^empty\.md:\d+: .*is empty/),
      expect.stringMatching(/^mixed\.md:\d+: .*"some prose"/),
    ]);
  });

  it("refuses a Parent that is missing or is another spec", () => {
    const errors = errorsOf([
      file("none.md", `${front()}## Acceptance criteria\n\n- [ ] a\n`),
      file("other.md", front() + template("- [ ] a\n").replace("S-7", "S-8")),
    ]);
    expect(errors).toEqual([
      expect.stringMatching(/^none\.md: no `## Parent` section/),
      expect.stringMatching(/^other\.md:\d+: `## Parent` must be S-7/),
    ]);
  });

  it("refuses a Blocked by section: dependencies go in the front matter", () => {
    const errors = errorsOf([
      file(
        "a.md",
        front() + template("- [ ] a\n", "\n## Blocked by\n\n- #3\n"),
      ),
    ]);
    expect(errors).toEqual([
      expect.stringMatching(/^a\.md:\d+: `## Blocked by` is not allowed/),
    ]);
  });

  it("lists every error of every file at once", () => {
    const errors = errorsOf([
      file("a.md", "no front matter"),
      file("b.md", front("colour: red\n") + template("")),
      file("c.md", front() + template("junk\n")),
    ]);
    expect(errors.length).toBeGreaterThanOrEqual(3);
    expect(errors.filter((e) => e.startsWith("b.md")).length).toBe(2);
  });

  it("says plainly that tickets.yaml is no longer accepted", () => {
    expect(errorsOf([file("tickets.yaml", "tickets: []")])).toEqual([
      expect.stringContaining("tickets.yaml is no longer accepted"),
    ]);
  });

  it("refuses an empty directory", () => {
    expect(errorsOf([])).toEqual(["the directory has no ticket file (.md)"]);
  });
});
