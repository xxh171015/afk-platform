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

describe("the afk-setup skill", () => {
  it("does not stop at the first step when gh is missing on a GitLab-only project", () => {
    // the machine check is plat setup's, which asks for gh only when a repo is on GitHub (plat-setup.test.ts)
    const plat = readFileSync(
      fileURLToPath(new URL("./index.ts", import.meta.url)),
      "utf8",
    );
    expect(plat).toMatch(
      /hostKindOfUrl\(url\) === "github"\)\)[\s\S]{0,80}"gh", \["auth", "status"\]/,
    );
    const prepare = section(readAfkSetupSkill(), "## 1. Prepare", "## 2.");
    expect(prepare).toContain("plat setup --json");
    expect(prepare).not.toMatch(/\bgh\b/);
  });

  it("stops a GitHub project that is not logged into gh, and names the login command", () => {
    // plat setup's machine check names `gh auth login` for a repo on GitHub; the skill passes each problem on and stops
    const plat = readFileSync(
      fileURLToPath(new URL("./index.ts", import.meta.url)),
      "utf8",
    );
    expect(plat).toContain(
      "gh is not logged in, and a repo is on GitHub: gh auth login",
    );
    const prepare = section(readAfkSetupSkill(), "## 1. Prepare", "## 2.");
    expect(prepare).toMatch(
      /"error": "not-ready"[\s\S]*?each line of `problems`[\s\S]*?stop/,
    );
    expect(prepare).toContain("Do not install anything or log in for them");
  });

  it("runs plat doctor before the report", () => {
    // plat setup --finish ends with plat doctor
    const skill = readAfkSetupSkill();
    const finish = skill.indexOf("plat setup --finish --json");
    const report = skill.indexOf("## 4. Report");
    expect(finish).toBeGreaterThan(0);
    expect(finish).toBeLessThan(report);
    expect(skill.slice(report)).toMatch(/plat doctor/);
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
