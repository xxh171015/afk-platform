<!-- tracker-doc template for mattpocock/skills@59db609eb1e18aaf59b63284d0e52255aff0c63c -->

## On the platform (`plat`)

Specs and tickets live in the afk-platform, not on the code host. Use the `plat` CLI for all of it.
`plat` is a command on this machine; run it from this repo, so file paths are relative to here. It finds the
platform at `--api-url`, `$AFK_API_URL`, the address `plat connect` remembered, else `http://127.0.0.1:3000`.
Add `--json` for machine output. Before guessing a subcommand, run `plat --help` and
`plat <command> --help`. When this checkout is the **afk-platform** source tree, use `pnpm plat` so the CLI matches the code here (not another `plat` on `PATH`).

`plat repo check <repo name> --branch afk/setup` runs from the **planning repo checkout** where `plat init` registered the project (same place you run `plat spec create`).

This repo is the project's `{{REPO}}` repo (`repo: {{REPO}}` in a ticket file); the project is `{{PROJECT}}` on the platform.

The platform has no labels and no comments. A draft spec is what a skill means by `ready-for-agent`: apply no label.

### Conventions

- **Publish a spec** (what a skill means by "publish to the issue tracker" for a spec):
  Write the spec markdown **outside this repo** (do not commit it), then:
  `plat spec create --project {{PROJECT}} --type feature --title "<title>" --slug <english-slug> --file ~/.afk/planning/draft/spec.md`
  It prints the spec number, e.g. `S-7`. Pass `--slug` (lowercase letters, digits, hyphens) whenever the title has no
  Latin words: a Chinese-only title cannot be turned into a slug. The spec is stored as written. `plat` warns, on
  stderr, about a section of the to-spec template that is missing or renamed, and about a Testing Decisions section
  that names no seams; it still creates the spec. The seams check looks for `seam`/`seams` (case-insensitive) or the
  character 缝 in that section's body. After it prints `S-7`, keep process files under `~/.afk/planning/S-7/`.
- **Planning docs** (`GLOSSARY.md`, `docs/adr/`, `AGENTS.md` in this repo, as grill-with-docs and domain-modeling
  write them): leave the changes **uncommitted and unpushed**. `plat spec confirm` sends them and the platform
  commits them onto the spec's integration branch, so they reach the default branch with the spec's {{HOST_PR}}.
  The same goes for the repo's setup on `afk/setup` (gates.yaml, this doc, the agent docs): the platform starts
  each spec's integration branch with it, so it is not merged on its own.
- **A repo the project does not have yet** (a ticket would name a repo in `repo`, `refs` or `environment` that
  `plat tickets import` says does not belong to the project): set it up yourself with the afk-setup skill, from its
  checkout among this workspace's folders, without asking the person; then import again. Tell the person in one
  line, with its `afk/setup` gate check. Nothing is merged first: the setup on `afk/setup` reaches the default
  branch with the spec's {{HOST_PR}}.
- **Read a spec** (what a skill means by "fetch the issue and read its body and comments"): `plat spec show S-7`.
  It prints the spec's body, its tickets, edges and warnings (after the run, the acceptance pack). A spec has no comments.
- **Publish tickets** (to-tickets step 5). On this tracker publishing is four steps, in this order:
  1. Write one markdown file per ticket into `~/.afk/planning/S-7/` (create the directory; it is outside git), e.g.
     `~/.afk/planning/S-7/01-contract.md`, numbered in dependency order (format below). Do not put these files in
     this repository.
  2. `plat tickets import S-7 ~/.afk/planning/S-7/`. The import is all or nothing and lists every problem at once; fix
     the files and run it again. A spec takes one import while it is a draft. The platform is then the only source of
     the spec and its tickets.
  3. Show the person the import's warnings exactly as printed (or say there were none), then ask once:
     "开工吗？" (start the work now?).
  4. If they say yes, run `plat spec confirm S-7` here, in this repo. It sends the planning docs (below) as they are in
     this checkout, and the platform commits them before any ticket starts. Then tell them that from here they only
     wait for the acceptance pack, merge the {{HOST_PRS}}, and look at `plat blocked`. If they say no, stop; they can
     confirm later here (the platform's page cannot send the planning docs).

  Confirming is the last step of publishing tickets on this tracker. It does not change the spec's body and does not
  close the spec, so it is **not** what a skill means by "modify a parent issue".

- **Fetch a ticket** (a skill's "fetch the relevant ticket"): `plat ticket view T-8 --md` prints the ticket file, the
  same text the agent reads; `plat ticket view T-8` shows its runs, findings and neighbours as well.
- **Change a ticket that has not started**: `plat ticket view T-8 --md > t.md`, edit the file, `plat ticket edit T-8 --file t.md`.
  Only the title, the body, `modules` and `protected_paths_ok` can change; the other front matter fields may be left out,
  and written they must equal the ticket's. To change those, cancel the ticket and append a new one with
  `plat tickets import S-7 <dir> --append`.
- **See what waits for a person**: `plat blocked` (blocked tickets, paused specs, and {{HOST_PRS}} that were closed
  without merge or could not be read; the platform never touches a {{HOST_PR}}, so reopen it on the host, rework the
  spec, or `plat spec cancel S-7`). Read a run's log: `plat run logs R-25`.
- **Unblock**: `plat ticket retry T-8`, `plat ticket approve-protected T-8` (only after the gate found a
  protected-path change), `plat ticket allow-path T-8 {{PROTECTED_EXAMPLE}}` (a blocked ticket that needs a protected path
  the file did not approve; then retry it), `plat ticket cancel T-8`. Ticket commands live under `ticket`, not at the
  top level. To give up a whole spec, `plat spec cancel S-7`.
- **Give up or clean up a spec**: run `plat spec show S-n` first (state, tickets, branches). **`plat spec cancel`** stops work and cancels open tickets; there is no `plat spec delete`—cancelled specs stay visible as history. On a cancelled spec, `plat spec cleanup S-n` can remove leftover host branches or {{HOST_PRS}}. Asking to 「删除」a spec usually means cancel (or cleanup), not erasing the row.

Numbers are global and are never reused, and a failed `spec create` may still take one. Always use the number the
command printed.

### Ticket file

Front matter holds the title and the platform's fields; after it comes the issue template exactly as to-tickets
writes it. The file name without `.md` is the ticket's key.

```markdown
---
title: 订单增加备注字段
repo: { { REPO } }
type: implementation # contract | implementation | integration
modules: ["src/orders/**", "test/**"]
stories: [1, 4] # optional: User Story numbers in the spec this ticket is for; omit on infrastructure tickets
blocked_by: [01-contract] # keys of other files; these are the native blocking edges
---

## Parent

S-7

## What to build

...

## Acceptance criteria

- [ ] POST /orders 接受可选的 note，超长返回 400
```

- `## Parent` must be the spec being imported into.
- Blocking edges go only in `blocked_by`. Do not write a `## Blocked by` section: the import rejects it. When you
  append to a confirmed spec, `blocks: [T-3]` makes a new ticket block an existing one.
- Each acceptance line is a single `- [ ] ` line; the section holds nothing else. The acceptance criteria are read
  from this section, never written twice.
- Every ticket needs `repo`, `type`, a `title` and at least one glob in `modules`. Other optional fields:
  `protected_paths_ok`, `contract`, `refs`, `environment`, `stories`. Unknown keys are rejected.
- `stories: [1, 4]` names the User Story numbers in the spec this ticket is responsible for. The import checks
  those numbers exist in the spec's User Stories and refuses the whole directory if any do not, listing the
  missing numbers. Omit the field on infrastructure tickets; that is normal and is not a warning.
- **Quote** a `title` that contains `: ` or starts with a special character, or the YAML will not parse.
- A ticket that changes a **protected path** (project setting, `{{PROTECTED_PATH}}` by default, plus the contract file) must
  list the exact files in `protected_paths_ok`. Without it the ticket is blocked; fix it with `plat ticket allow-path`
  and `plat ticket retry`.
- `type: contract` is for a ticket that only edits the contract file. A ticket using `contract: <key>` must point at
  a contract ticket.
- List in `modules` only globs for paths **this ticket edits**, not an entire package (for example `packages/api/src/planning/**` instead of `packages/api/src/**`) unless the ticket truly touches the whole tree—wide globs overlap and make parallel merges noisier.
- When the same behaviour is enforced both on the **ticket pipeline** and in **spec finalization** (for example integration or e2e), name **both** paths in acceptance criteria so review can catch a fix that only lands on one path.
- Two tickets that touch overlapping `modules` but do not depend on each other get an overlap warning. That is not an
  error: say so in the ticket if it is intended, otherwise add a `blocked_by`.
- Dependencies must not form a cycle, and a ticket cannot depend on itself.
- Acceptance lines should be testable through HTTP or the public interface: the pack marks a line verified only when
  the tests the agent named for it exist in the merge gate's JUnit report and passed.
