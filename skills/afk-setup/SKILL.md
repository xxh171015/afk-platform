---
name: afk-setup
description: Set a project's repos up for the AFK platform, or bring that setup up to date. Use when a repo is not on the platform yet, including mid-planning when plat says a ticket's repo does not belong to the project; when plat says to run the afk-setup skill; or after the platform was upgraded.
---

# AFK setup

Gets every repo of a project ready for the AFK platform, so the person can go straight to grill-with-docs, to-spec and to-tickets. `plat setup` does every fixed step: it checks this machine, registers the repos, writes this machine's planning files, and makes a temporary setup worktree for each repo that needs one; `plat setup --finish` commits, pushes to the repo's `afk/setup` branch, has the platform run the gate, and cleans up. Your part is what needs reading the code: the gate and `AGENTS.md`. Nothing is merged and no pull request is opened: the setup reaches each default branch with the first spec's pull request. Running this again is safe: plat only fills the gaps.

Speak the person's language in chat. Show plat's output when it carries a problem; otherwise summarise it in a line. Run plat in the person's own checkout of the planning repo: the repo this skill is installed in.

## 1. Prepare

`plat setup --json --with <path> ...`, with a `--with` for each other git checkout among the workspace folders.

- **It exits non-zero with `"error": "not-ready"`**: tell the person each line of `problems` (each names the command they run) and stop. Do not install anything or log in for them.
- **`ready` is true**: the project is set up already (on another machine, or by an earlier run). Report one line, 本机已就绪 (or the same in the person's language), and stop.
- **A repo has a `problem`**: with a `worktree` (a merge with conflicts there), resolve the conflicts in that worktree, commit, and run `plat setup --json` again with the same `--with`s. Without one (origin could not be fetched), tell the person the problem and leave that repo for now.
- **It exits non-zero with any other `error`**: tell the person the error and stop.
- **`hostingOk` is false for a repo**: pass on its `hosting` line (who to ask for the GitHub App or GitLab membership), and carry on.

**Called mid-planning** (plat said a ticket's repo does not belong to the project): run `plat setup --json --with <that repo's checkout>`. Ask for its local path only when it is not among the workspace folders. Then carry on as below, and go back to the planning where it stopped and import again.

## 2. Write what each worktree lacks

For each repo with a `worktree`, work in that worktree, never in the person's checkout. `missing` lists what plat could tell is not there:

- **`.sandcastle/gates.yaml`**: write it following [gates.md](gates.md). When test uses a filtered package list, vet/build must use the same set (gates.md「Same package set in every command」).
- **AGENTS.md**: the agent that implements tickets reads it. Write it from the code: what the repo is, where things live, how to run it, its conventions, how to run the tests and a single test file, the repo's existing standards documents (`CONTRIBUTING.md`, `CODING_STANDARDS.md`, files under `docs/` that say how to write code) as a fallback for Standards review, and the section "Running unattended": nobody answers questions during a run; when a decision only a person can make comes up, the agent reports `cannot-proceed` and ends.
- **`AGENTS.md#Running unattended`**: add that section to the `AGENTS.md` (or `CLAUDE.md`) that is there.

When `AGENTS.md` (or `CLAUDE.md`) is there, also check it says how to run the tests, how to run a single test file, and which standards documents exist; add only what is missing and keep the rest as it is. Do not commit: `--finish` does.

End-to-end tests against other repos are not set up here: a spec that needs them adds what they need as tickets (the tracker doc's "Integration tickets").

## 3. Finish

`plat setup --finish --json`. It runs each repo's gate in the platform's sandbox, exactly as tickets will be gated, and waits for the answers.

For each repo that did not pass, in this order:

- **`sandboxLacksTool` is true** (`command not found` for a toolchain the repo needs): do not try to fix it in the repo. Stop for that repo and tell the person: the platform's sandbox image lacks it, and whoever runs the platform has to add it.
- **`gate` is `failed`**: read `gateOutput`, fix the cause in that repo's `worktree`, and run `plat setup --finish --json` again; it only handles the repos that have not passed.
- **`problem` is set** (a commit or push refused, a merge with conflicts, a gate check that could not run): fix what is in the worktree (resolve conflicts) and run `--finish` again; when the cause is outside the repo (push refused, no worker answering), tell the person and stop for that repo.

## 4. Report

Relay `--finish`'s report: per repo, whether `afk/setup` was pushed, the gate check, 托管 (with the fix and who to ask when it is not fine), and where the worktree of a repo that did not pass is kept; plat doctor's lines; and which repo is the planning repo. Then the next step: plan with `/grill-with-docs` in the person's own checkout of the planning repo, on any branch. Called mid-planning, the report is one line: the repo and its gate check.
