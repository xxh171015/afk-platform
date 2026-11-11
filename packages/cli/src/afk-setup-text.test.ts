import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readAfkSetupSkill } from "./afk-setup-text.ts";

// The afk-setup skill is what `/afk-setup` follows. GitLab-only projects must not be stopped for gh at step 1.

const section = (skill: string, heading: string, next: string): string => {
  const start = skill.indexOf(heading);
  const end = skill.indexOf(next);
  return skill.slice(start, end);
};

const firstNumberedItem = (text: string): string => {
  const match = text.match(/1\. \*\*[^*]+\*\*:[\s\S]*?(?=\n2\. |\nDone )/);
  if (!match) throw new Error("no first numbered item");
  return match[0];
};

describe("the afk-setup skill", () => {
  it("does not stop at the first step when gh is missing on a GitLab-only project", () => {
    const tools = section(
      readAfkSetupSkill(),
      "## 1. Tools on this machine",
      "## 2. The repos",
    );
    const prerequisites = firstNumberedItem(tools);
    expect(prerequisites).toContain("node --version");
    expect(prerequisites).toContain("git --version");
    expect(prerequisites).not.toMatch(/\bgh\b/);
  });

  it("stops a GitHub project that is not logged into gh, and names the login command", () => {
    const skill = readAfkSetupSkill();
    expect(skill).toMatch(/GitHub[\s\S]*?`gh auth status`/);
    expect(skill).toContain("`gh auth login`");
  });

  it("runs plat doctor before the report", () => {
    const skill = readAfkSetupSkill();
    const report = skill.slice(skill.indexOf("## 6. Report"));
    expect(report).toMatch(/plat doctor/);
    const table = report.search(/short table/);
    expect(table).toBeGreaterThan(0);
    expect(report.indexOf("plat doctor")).toBeLessThan(table);
  });

  it("tells planning skills to run /afk-setup when there is no tracker, not /setup-matt-pocock-skills", () => {
    const root = fileURLToPath(new URL("../../../skills", import.meta.url));
    for (const name of ["to-spec", "to-tickets"]) {
      const text = readFileSync(`${root}/${name}/SKILL.md`, "utf8");
      expect(text).toContain("/afk-setup");
      expect(text).not.toMatch(/\/setup-matt-pocock-skills/);
    }
  });

  it("tells a non-Node repo to change every run: in the gates example", () => {
    const gates = readFileSync(
      fileURLToPath(
        new URL("../../../skills/afk-setup/gates.md", import.meta.url),
      ),
      "utf8",
    );
    expect(gates).toMatch(/commands the repo already runs/);
    expect(gates).toMatch(/not Node must change every `run:`/);
    expect(gates).toMatch(/command not found/);
  });

  it("no longer creates triage labels, and no skill still depends on those GitHub labels", () => {
    expect(readAfkSetupSkill()).not.toMatch(/gh label/);
    const roots = [
      fileURLToPath(new URL("../../../skills", import.meta.url)),
      fileURLToPath(new URL("../../pipeline/skills", import.meta.url)),
    ];
    const hits: string[] = [];
    for (const root of roots) {
      for (const name of readdirSync(root)) {
        let text: string;
        try {
          text = readFileSync(`${root}/${name}/SKILL.md`, "utf8");
        } catch {
          continue;
        }
        if (/gh label/.test(text)) hits.push(name);
      }
    }
    expect(hits).toEqual([]);
  });
});
