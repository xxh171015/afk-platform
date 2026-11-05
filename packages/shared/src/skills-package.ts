// The skills package people install on a planning machine: afk-setup and the planning skills (skills/ in this
// repo), pinned to the platform's commit with the skills CLI's `<package>#<commit>` form.
export const SKILLS_PACKAGE = "xxh171015/afk-platform";

export const skillsPackageAt = (commit: string): string =>
  `${SKILLS_PACKAGE}#${commit}`;
