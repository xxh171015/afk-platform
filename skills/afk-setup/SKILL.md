---
name: afk-setup
description: Set a project's repos up for the AFK platform, or bring that setup up to date. Use when a repo is not on the platform yet, including mid-planning when plat says a ticket's repo does not belong to the project; when plat says to run the afk-setup skill; or after the platform was upgraded.
---

# AFK setup

Gets every repo of a project ready for the AFK platform, so the person can go straight to grill-with-docs, to-spec and to-tickets. You run every command and decide everything the repos themselves answer. Nothing is merged on its own: each repo's setup goes to an `afk/setup` branch, the platform starts every spec's integration branch with it, and the person reviews it in the spec's pull request, beside the code that needed it. Ask only for what nothing on this machine says: the platform's address when it does not answer, and a repo's local path when it is not among the workspace folders. Running it again is safe: each step finds what is already done and only fills the gaps.

Speak the person's language in chat. Show command output when it carries a problem; otherwise summarise it in a line.

**Called mid-planning** (plat said a ticket's repo does not belong to the project): set up that repo, with the planning repo for its tracker doc, and nothing else; then go back to the planning where it stopped and import again. The planning is done in the planning repo's `afk/setup` worktree, so the tracker doc it rewrites is the one the planning reads; commit and push it to `afk/setup` with the new repo's setup.

## 1. Tools on this machine

The platform's address is `$AFK_API_URL`, default `http://127.0.0.1:3000`; it answers `curl -fsS "$AFK_API_URL/version"`.

1. `node --version` is 20 or newer; `git` and `gh` work (`gh auth status`).
2. **plat**: when there is none, install the platform's copy:
   `mkdir -p ~/.local/bin && curl -fsSL "$AFK_API_URL/cli/plat.mjs" -o ~/.local/bin/plat && chmod +x ~/.local/bin/plat`
   and make sure `~/.local/bin` is on `PATH`. When `plat version` differs from the `platformVersion` of `/version`, run `plat update`.
3. **Planning skills**: grill-with-docs, grilling, domain-modeling, to-spec and to-tickets come in the same package as this skill, at the commit the platform pins. Look for them beside `afk-setup`; when any is missing, run `plat update`: it installs the whole package again at the level `afk-setup` is at. At project level (`afk-setup` is in the planning repo's `.agents/skills`), run it in the planning repo's worktree once step 3 made it; the skills under `.agents/skills` (and their links) and `skills-lock.json` then go to `afk/setup` and reach the default branch with the first spec, so everyone who plans in the repo has the same versions.

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

All changes go to an `afk/setup` branch, in a worktree beside each checkout, so the person's own branch and files stay as they are:

`git -C <checkout> fetch origin && git -C <checkout> worktree add <checkout>-afk-setup -B afk/setup origin/afk/setup` (when origin has no `afk/setup` yet, start it from `origin/<default branch>`; when the worktree is there already, use it and `git pull` in it)

When `afk/setup` was there already, merge `origin/<default branch>` into it (`git merge origin/<default branch>`), so that it still merges into the default branch: the platform refuses to start a spec's tickets on a setup that does not. When the default branch has everything `afk/setup` has (a spec that carried it was merged), the merge brings it up to date and the steps below only fill what is missing.

The platform only reads what is pushed. It never merges `afk/setup` into the default branch: every spec's integration branch starts with it until the default branch has it, so it reaches the default branch with the first spec's pull request. Open no pull request for it.

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

The commit message says what was added and why, and names every file that was replaced rather than added (for example an `issue-tracker.md` that pointed at another tracker): the reviewer of the spec's pull request reads it there.

Done when every repo has `afk/setup` pushed and a passing `plat repo check`, or a named reason it cannot pass.

## 6. Report

A short table: repo, `afk/setup` pushed, gate check, GitHub App; and which repo is the planning repo. Then the next step: plan with `/grill-with-docs` in the planning repo's worktree, `<checkout>-afk-setup`, which has the tracker doc and the agent docs the planning reads. Nothing needs merging first: the setup reaches each default branch with the first spec's pull request, and once it has, planning can go back to the person's own checkout. Called mid-planning, the report is one line: the repo and its gate check. Keep the planning repo's worktree; remove the others once their branches are pushed (`git worktree remove`).
