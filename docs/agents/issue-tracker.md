<!-- plat tracker-doc 0.3.0 skills mattpocock/skills@4ae2317ddb22b046e26455e4f9c9b3aaaf62212d project 4 repo afk-platform -->

# Issue tracker: the afk-platform and GitHub

This repo's specs and tickets live in the **afk-platform**; everything else stays on **GitHub**. Pick the side
by what the skill is working on:

| A skill says …                                        | Goes to      | Use    |
| ----------------------------------------------------- | ------------ | ------ |
| to-spec: publish the spec                             | the platform | `plat` |
| to-tickets: publish tickets                           | the platform | `plat` |
| implement: fetch the ticket                           | the platform | `plat` |
| code-review: find the spec                            | the platform | `plat` |
| wayfinder: the map and its tickets                    | GitHub       | `gh`   |
| triage: labels, needs-info, ready-for-agent on issues | GitHub       | `gh`   |
| pull requests treated as requests                     | GitHub       | `gh`   |

The platform has no labels and no comments, which is why triage and wayfinder stay on GitHub. Each part
below is complete for its side; do not look for either one elsewhere.

## On the platform (`plat`)

Specs and tickets live in the afk-platform, not on the code host. Use the `plat` CLI for all of it.
`plat` is a command on this machine; run it from this repo, so file paths are relative to here. It finds the
platform at `--api-url`, `$AFK_API_URL`, the address `plat connect` remembered, else `http://127.0.0.1:3000`.
Add `--json` for machine output. Before guessing a subcommand, run `plat --help` and
`plat <command> --help`. When this checkout is the **afk-platform** source tree, use `pnpm plat` so the CLI matches the code here (not another `plat` on `PATH`).

`plat repo check <repo name> --branch afk/setup` runs from the **planning repo checkout** where `plat init` registered the project (same place you run `plat spec create`).

This repo is the project's `afk-platform` repo (`repo: afk-platform` in a ticket file); the project is `4` on the platform.

The platform has no labels and no comments. A draft spec is what a skill means by `ready-for-agent`: apply no label.

### Conventions

- **Publish a spec** (what a skill means by "publish to the issue tracker" for a spec):
  Write the spec markdown **outside this repo** (do not commit it), then:
  `plat spec create --project 4 --type feature --title "<title>" --slug <english-slug> --file ~/.afk/planning/draft/spec.md`
  It prints the spec number, e.g. `S-7`. Pass `--slug` (lowercase letters, digits, hyphens) whenever the title has no
  Latin words: a Chinese-only title cannot be turned into a slug. In Testing Decisions, name the **seams** (the test
  boundaries) the tickets will test at: unattended tdd writes tests only there. The spec is stored as written. `plat` warns, on
  stderr, about a section of the to-spec template that is missing or renamed, and about a Testing Decisions section
  that names no seams; it still creates the spec. The seams check looks for `seam`/`seams` (case-insensitive) or the
  character 缝 in that section's body. After it prints `S-7`, keep process files under `~/.afk/planning/S-7/`.
- **Planning docs** (`GLOSSARY.md`, `docs/adr/`, `AGENTS.md` in this repo, as grill-with-docs and domain-modeling
  write them): leave the changes **uncommitted and unpushed**. `plat spec confirm` sends them and the platform
  commits them onto the spec's integration branch, so they reach the default branch with the spec's pull request.
  The same goes for the repo's setup on `afk/setup` (gates.yaml, this doc, the agent docs): the platform starts
  each spec's integration branch with it, so it is not merged on its own.
- **A repo the project does not have yet** (a ticket would name a repo in `repo`, `refs` or `environment` that
  `plat tickets import` says does not belong to the project): set it up yourself with the afk-setup skill, from its
  checkout among this workspace's folders, without asking the person; then import again. Tell the person in one
  line, with its `afk/setup` gate check. Nothing is merged first: the setup on `afk/setup` reaches the default
  branch with the spec's pull request.
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
     wait for the acceptance pack, merge the pull requests, and look at `plat blocked`. If they say no, stop; they can
     confirm later here (the platform's page cannot send the planning docs).

  Confirming is the last step of publishing tickets on this tracker. It does not change the spec's body and does not
  close the spec, so it is **not** what a skill means by "modify a parent issue".

- **Fetch a ticket** (a skill's "fetch the relevant ticket"): `plat ticket view T-8 --md` prints the ticket file, the
  same text the agent reads; `plat ticket view T-8` shows its runs, findings and neighbours as well.
- **Change a ticket that has not started**: `plat ticket view T-8 --md > t.md`, edit the file, `plat ticket edit T-8 --file t.md`.
  Only the title, the body, `modules` and `protected_paths_ok` can change; the other front matter fields may be left out,
  and written they must equal the ticket's. To change those, cancel the ticket and append a new one with
  `plat tickets import S-7 <dir> --append`.
- **See what waits for a person**: `plat blocked` (blocked tickets, paused specs, and pull requests that were closed
  without merge or could not be read; the platform never touches a pull request, so reopen it on the host, rework the
  spec, or `plat spec cancel S-7`). Read a run's log: `plat run logs R-25`.
- **Unblock**: `plat ticket retry T-8`, `plat ticket approve-protected T-8` (only after the gate found a
  protected-path change), `plat ticket allow-path T-8 .github/CODEOWNERS` (a blocked ticket that needs a protected path
  the file did not approve; then retry it), `plat ticket cancel T-8`. Ticket commands live under `ticket`, not at the
  top level. To give up a whole spec, `plat spec cancel S-7`.
- **Give up or clean up a spec**: run `plat spec show S-n` first (state, tickets, branches). **`plat spec cancel`** stops work and cancels open tickets; there is no `plat spec delete`—cancelled specs stay visible as history. On a cancelled spec, `plat spec cleanup S-n` can remove leftover host branches or pull requests. Asking to 「删除」a spec usually means cancel (or cleanup), not erasing the row.

Numbers are global and are never reused, and a failed `spec create` may still take one. Always use the number the
command printed.

### Ticket file

Front matter holds the title and the platform's fields; after it comes the issue template exactly as to-tickets
writes it. The file name without `.md` is the ticket's key.

```markdown
---
title: 订单增加备注字段
repo: afk-platform
type: implementation # contract | implementation | integration
modules: ["src/orders/**", "test/**"]
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
  `protected_paths_ok`, `contract`, `refs`, `environment`. Unknown keys are rejected.
- **Quote** a `title` that contains `: ` or starts with a special character, or the YAML will not parse.
- A ticket that changes a **protected path** (project setting, `.github/**` by default, plus the contract file) must
  list the exact files in `protected_paths_ok`. Without it the ticket is blocked; fix it with `plat ticket allow-path`
  and `plat ticket retry`.
- `type: contract` is for a ticket that only edits the contract file. A ticket using `contract: <key>` must point at
  a contract ticket.
- List in `modules` only globs for paths **this ticket edits**, not an entire package (for example `packages/api/src/planning/**` instead of `packages/api/src/**`) unless the ticket truly touches the whole tree—wide globs overlap and make parallel merges noisier.
- Two tickets that touch overlapping `modules` but do not depend on each other get an overlap warning. That is not an
  error: say so in the ticket if it is intended, otherwise add a `blocked_by`.
- Dependencies must not form a cycle, and a ticket cannot depend on itself.
- Acceptance lines should be testable through HTTP or the public interface: the pack marks a line verified only when
  the tests the agent named for it exist in the merge gate's JUnit report and passed.

## On GitHub (`gh`)

# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --json number,title,body,labels,comments`.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Make an issue a sub-issue of a parent**: `gh issue create --parent <parent> ...`, or `gh issue edit <parent> --add-sub-issue <child>` afterwards (`gh` 2.94+). Older `gh`: `gh api --method POST repos/<owner>/<repo>/issues/<parent>/sub_issues -F sub_issue_id=<child-db-id>` (database id, as in **Blocking** below). Without sub-issues, put `Part of #<parent>` at the top of the child body.
- **Blocking**: GitHub's **native issue dependencies**, the canonical, UI-visible representation. Add an edge with `gh issue create --blocked-by <n>,<n> ...` or `gh issue edit <child> --add-blocked-by <blocker>` (`gh` 2.94+). Older `gh`: `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`, where `<blocker-db-id>` is the blocker's numeric **database id** (`gh api repos/<owner>/<repo>/issues/<n> --jq .id`, _not_ the `#number` or `node_id`). Where dependencies aren't available, fall back to a `Blocked by: #<n>, #<n>` line at the top of the child body. A ticket is unblocked when every blocker is closed.
- **Count open blockers**: `gh api repos/<owner>/<repo>/issues/<n> --jq .issue_dependencies_summary.blocked_by` (open blockers only; 0 means startable). `gh issue view <n> --json blockedBy` also lists closed blockers, so filter it: `--jq '[.blockedBy.nodes[] | select(.state == "OPEN")] | length'`.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: post the explanation with `gh issue comment <number> --body "..."`, then `gh issue close <number>`. On an already-closed issue, `gh issue close --comment` drops the comment and still exits 0.

Infer the repo from `git remote -v`; `gh` does this automatically when run inside a clone.

File issues only into the user's own repo. Never file into `mattpocock/skills` (the repo these skills come from) unless the user owns it. In a fork, `gh` can default to the upstream parent, so before the first `gh issue create` of a session, check the target with `gh repo view --json nameWithOwner` and confirm it with the user if it is not their repo.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag.)_

When set to `yes`, PRs run through the same labels and states as issues, using the `gh pr` equivalents:

- **Read a PR**: `gh pr view <number>`, then `gh pr view <number> --comments` (off a TTY, `--comments` prints only the comments, not the body), and `gh pr diff <number>` for the diff.
- **List external PRs for triage**: `gh api --paginate 'repos/{owner}/{repo}/pulls?state=open' --jq '.[] | select(.author_association | IN("OWNER","MEMBER","COLLABORATOR") | not) | {number, title, author: .user.login, author_association, labels: [.labels[].name]}'`.
- **Comment / label / close**: `gh pr comment`, `gh pr edit --add-label`/`--remove-label`, `gh pr close`.

GitHub shares one number space across issues and PRs, so a bare `#42` may be either: resolve with `gh pr view 42` and fall back to `gh issue view 42`.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Read it as in **Read an issue** above.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue with **child** issues as tickets.

- **Map**: a single issue labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body. `gh issue create --label wayfinder:map`.
- **Child ticket**: an issue linked to the map as a GitHub sub-issue (see **Make an issue a sub-issue of a parent**). Where sub-issues aren't enabled, add the child to a task list in the map body and put `Part of #<map>` at the top of the child body. Labels: `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`). Once claimed, the ticket is assigned to the driving dev.
- **Blocking**: see **Blocking** under Conventions.
- **Frontier query**: list the map's open children (`gh issue list --state open`, scoped to the map's sub-issues / task list), drop any with an open blocker (see **Count open blockers**, or an open issue in the `Blocked by` line) or an assignee; first in map order wins.
- **Claim**: `gh issue edit <n> --add-assignee @me`, the session's first write.
- **Resolve**: `gh issue comment <n> --body "<answer>"`, then `gh issue close <n>`, then append a context pointer (gist + link) to the map's Decisions-so-far.
