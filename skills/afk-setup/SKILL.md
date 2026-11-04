---
name: afk-setup
description: Set a project's repos up for the AFK platform, or bring that setup up to date. Use when a repo is not on the platform yet, including mid-planning when plat says a ticket's repo does not belong to the project; when plat says to run the afk-setup skill; or after the platform was upgraded.
---

# AFK setup

Gets every repo of a project ready for the AFK platform, so the person can go straight to grill-with-docs, to-spec and to-tickets. You run every command and decide everything the repos themselves answer; the person reviews the result in the pull requests. Ask only for what nothing on this machine says: the platform's address when it does not answer, and a repo's local path when it is not among the workspace folders. Running it again is safe: each step finds what is already done and only fills the gaps.

Speak the person's language in chat. Show command output when it carries a problem; otherwise summarise it in a line.

**Called mid-planning** (plat said a ticket's repo does not belong to the project): set up that repo, with the planning repo for its tracker doc, and nothing else; then go back to the planning where it stopped and import again. The planning repo's tracker doc changes in its `afk/setup` pull request, so plat says the doc in the person's checkout is out of date until that is merged: expected, carry on.

## 1. Tools on this machine

The platform's address is `$AFK_API_URL`, default `http://127.0.0.1:3000`; it answers `curl -fsS "$AFK_API_URL/version"`.

1. `node --version` is 20 or newer; `git` and `gh` work (`gh auth status`).
2. **plat**: `plat version` prints the same `platformVersion` as `/version`. When it is missing or different, install the platform's copy:
   `mkdir -p ~/.local/bin && curl -fsSL "$AFK_API_URL/cli/plat.mjs" -o ~/.local/bin/plat && chmod +x ~/.local/bin/plat`
   and make sure `~/.local/bin` is on `PATH`.
3. **Planning skills**: grill-with-docs, grilling, domain-modeling, to-spec and to-tickets come in the same package as this skill, at the commit the platform pins. Look for them beside `afk-setup`; when any is missing, install the whole package at the level `afk-setup` is at:
   - **Project level** (`afk-setup` is in the planning repo's `.agents/skills`): in the planning repo's worktree once step 3 made it, `npx skills@latest add xxh171015/afk-platform --skill '*' -y`.
   - **Global** (`afk-setup` is under `~/.agents/skills` or another home skills directory): now, `npx skills@latest add xxh171015/afk-platform --skill '*' -g -y`.

   At project level, the skills under `.agents/skills` (and their links) and `skills-lock.json` go into the `afk/setup` pull request, so everyone who plans in the repo has the same versions.

Done when `plat version` matches the platform and the six skills are installed at that level.

## 2. The repos

The repos are the git checkouts among the workspace folders; read each one's `origin` and default branch. A repo added to the workspace later is set up when planning first needs it (see "Called mid-planning").

The **planning repo** is where the person plans, decided in this order:
1. the repo whose `docs/agents/issue-tracker.md` the platform wrote (its first line is `<!-- plat tracker-doc …`): the project already has it;
2. the only repo;
3. the only repo with an `openapi` file (the one that owns the API contract);
4. the first workspace folder that is a git checkout.

Done when every repo has a path and the planning repo is decided; the report names it and why.

## 3. A setup branch per repo

All changes go through an `afk/setup` branch and a pull request, in a worktree beside each checkout, so the person's own branch and files stay as they are:

`git -C <checkout> fetch origin && git -C <checkout> worktree add <checkout>-afk-setup -B afk/setup origin/afk/setup` (when origin has no `afk/setup` yet, start it from `origin/<default branch>`)

The platform only reads what is pushed: the files reach it when the pull request is merged.

## 4. Register

In the planning repo's worktree:

1. `plat init --yes --with <worktree of each other repo> ...`. It registers what is not registered yet and writes the agent docs; a registered repo keeps its name and settings.
2. Each repo's GitHub App line comes back. When it is not "can work here", give the person the link from that line and say it is for whoever runs the platform; carry on with the next steps.
3. Create the triage labels the planning repo's GitHub lacks: compare `gh label list` with the five in `docs/agents/triage-labels.md` and `gh label create` each missing one.

Done when `plat init` printed the project and every repo is registered.

## 5. Ready each repo

For every repo, in its worktree:

- **Gate**: write `.sandcastle/gates.yaml` following [gates.md](gates.md), unless one is there already.
- **AGENTS.md**: the agent that implements tickets reads it. When the repo has one (or a `CLAUDE.md`), keep it and add only what is missing: how to run the tests, and the section "Running unattended": nobody answers questions during a run; when a decision only a person can make comes up, the agent reports `cannot-proceed` and ends. Without one, write it from the code: what the repo is, where things live, how to run it, its conventions.

End-to-end tests against other repos are not set up here: a spec that needs them adds what they need as tickets (the tracker doc's "Integration tickets").

Then commit (in the planning repo, with the project-level skills when that is where they are), `git push -u origin afk/setup`, and run, from the planning repo's worktree:

`plat repo check <repo name> --branch afk/setup`

It runs the gate in the platform's sandbox, exactly as tickets will be gated. When it fails, read the failing command's output, fix the cause, push, and check again. When a command is missing from the sandbox itself (`command not found` for a toolchain the repo needs), stop for that repo and tell the person: the platform's sandbox image lacks it, and whoever runs the platform has to add it.

Last, open the pull request, or push to the one already open:
`gh pr create --head afk/setup --title "Set up for the AFK platform" --body "<what was added and why>"`
The body names every file that was replaced rather than added (for example an `issue-tracker.md` that pointed at another tracker), so the reviewer sees it.

Done when every repo has its pull request and a passing `plat repo check`, or a named reason it cannot pass.

## 6. Report

A short table: repo, pull request, gate check, GitHub App; and which repo is the planning repo. Then the next steps: merge the pull requests (a spec cannot start in a repo until its pull request is merged; `plat spec confirm` says so); after that, plan with `/grill-with-docs` in the planning repo. Called mid-planning, the report is one line: the repo and its pull request. Remove the worktrees once their branches are pushed (`git worktree remove`).
