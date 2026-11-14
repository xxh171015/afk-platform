import { readSkillsPackage } from "./skills-package-text.ts";

// The afk-setup skill as this version of the platform has it (skills/afk-setup/SKILL.md), from the skills package plat
// carries.
export const readAfkSetupSkill = (): string => {
  const text = readSkillsPackage()["afk-setup/SKILL.md"];
  if (text === undefined) throw new Error("plat does not carry afk-setup");
  return text;
};
