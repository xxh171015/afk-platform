// The branches the platform makes on a code host, and the one place that knows their shape. Ticket numbers and
// spec slugs are only unique inside one database, so a spec made now carries its database's id (six hex digits)
// in every branch name; a spec made before the ids existed keeps the flat names its branches were pushed under.
//   spec/<id>/<slug>   agent/<id>/T-<n>   agent/<id>/S-<n>-final   agent/<id>/S-<n>-update   agent/<id>/S-<n>-locate
//   spec/<slug>        agent/T-<n>        agent/S-<n>-final        agent/S-<n>-update        agent/S-<n>-locate

// The branch afk-setup pushes a repo's setup to (ADR 0006). It is a person's, not the platform's: the platform
// reads it, merges it onto each spec's integration branch, and never pushes to it or deletes it.
export const SETUP_BRANCH = "afk/setup";

const ID = "[0-9a-f]{6}";
const TICKET = "(T-[1-9][0-9]*|S-[1-9][0-9]*-(?:final|update|locate))";
const SLUG = "[a-z0-9]+(?:-[a-z0-9]+)*";

export function branchNames(id: string | null) {
  const scope = id ? `${id}/` : "";
  return {
    integration: (slug: string) => `spec/${scope}${slug}`,
    ticket: (ticketDisplayId: string) => `agent/${scope}${ticketDisplayId}`,
    final: (specDisplayId: string) => `agent/${scope}${specDisplayId}-final`,
    update: (specDisplayId: string) => `agent/${scope}${specDisplayId}-update`,
    locate: (specDisplayId: string) => `agent/${scope}${specDisplayId}-locate`,
  };
}

const TICKET_BRANCH = new RegExp(`^agent/(?:${ID}/)?${TICKET}$`);
const SPEC_BRANCH = new RegExp(`^spec/(?:${ID}/)?${SLUG}$`);

// "T-12", "S-3-final", "S-3-update", or "S-3-locate" for a ticket, overall-fix, update-branch, or Locate temp.
export const parseTicketBranch = (branch: string): string | undefined =>
  TICKET_BRANCH.exec(branch)?.[1];

// Whether a name is one the platform makes: the only branches a worker will delete.
export const isPlatformBranch = (branch: string): boolean =>
  TICKET_BRANCH.test(branch) || SPEC_BRANCH.test(branch);
