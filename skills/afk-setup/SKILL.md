---
name: afk-setup
description: Set a project's repos up for the AFK platform, or bring that setup up to date. Use when a repo is not on the platform yet, when plat says to run /afk-setup, or after the platform was upgraded.
---

# AFK setup

Gets every repo of a project ready for the AFK platform, so the person can go straight to grill-with-docs, to-spec and to-tickets. The person answers questions in chat; you run every command. Running it again is safe: each step finds what is already done and only fills the gaps.

Speak the person's language in chat. Show command output when it carries a decision or a problem; otherwise summarise it in a line.

## 1. Tools on this machine

The platform's address is `$AFK_API_URL`, default `http://127.0.0.1:3000`. Ask for it only when that address does not answer `curl -fsS "$AFK_API_URL/version"`.

1. `node --version` is 20 or newer; `git` and `gh` work (`gh auth status`).
2. **plat**: `plat version` prints the same `platformVersion` as `/version`. When it is missing or different, install the platform's copy:
   `mkdir -p ~/.local/bin && curl -fsSL "$AFK_API_URL/cli/plat.mjs" -o ~/.local/bin/plat && chmod +x ~/.local/bin/plat`
   and make sure `~/.local/bin` is on `PATH`.
3. **Planning skills** at the commit the platform pins (`skillsSha` from `/version`):
   `npx skills@latest add https://github.com/mattpocock/skills/tree/<skillsSha> --skill grill-with-docs --skill grilling --skill domain-modeling --skill to-spec --skill to-tickets -g -y`

Done when `plat version` matches the platform and the five skills are installed.

## 2. The repos

The repos are the git checkouts among the workspace folders. With only one, ask once: "Does this project have other repos? Give me their local paths." Read each one's `origin` and default branch.

The **planning repo** is where the person will plan; it is usually the one that owns the API contract (an `openapi.yaml`). When no repo or more than one fits, ask which.

Done when every repo has a path and you know which one is the planning repo.

## 3. A setup branch per repo

All changes go through an `afk/setup` branch and a pull request, in a worktree beside each checkout, so the person's own branch and files stay as they are:

`git -C <checkout> fetch origin && git -C <checkout> worktree add <checkout>-afk-setup -B afk/setup origin/afk/setup` (when origin has no `afk/setup` yet, start it from `origin/<default branch>`)

The platform only reads what is pushed: the files reach it when the pull request is merged.

## 4. Register

In the planning repo's worktree:

1. `plat init --dry-run --with <worktree of each other repo> ...` and show the plan: project, repo names, what each repo lacks.
2. Ask once: "Register these repos and write the agent docs?" On yes, run the same command with `--yes` instead of `--dry-run`.
3. Each repo's GitHub App line comes back. When it is not "can work here", give the person the link from that line and say it is for whoever runs the platform; carry on with the next steps.
4. Create the triage labels the planning repo's GitHub lacks: compare `gh label list` with the five in `docs/agents/triage-labels.md` and `gh label create` each missing one.

Done when `plat init` printed the project and every repo is registered.

## 5. Ready each repo

For every repo, in its worktree:

- **Gate**: write `.sandcastle/gates.yaml` following [gates.md](gates.md), unless one is there already.
- **AGENTS.md**: the agent that implements tickets reads it. When the repo has one (or a `CLAUDE.md`), keep it and add only what is missing: how to run the tests, and the section "Running unattended": nobody answers questions during a run; when a decision only a person can make comes up, the agent reports `cannot-proceed` and ends. Without one, write it from the code: what the repo is, where things live, how to run it, its conventions.
- **Integration**: ask once per project: "Will frontend tickets run end-to-end tests against the real backend?" On yes, follow [integration.md](integration.md).

Then commit, `git push -u origin afk/setup`, and run, from the planning repo's worktree:

`plat repo check <repo name> --branch afk/setup`

It runs the gate in the platform's sandbox, exactly as tickets will be gated. When it fails, read the failing command's output, fix the cause, push, and check again. When a command is missing from the sandbox itself (`command not found` for a toolchain the repo needs), stop for that repo and tell the person: the platform's sandbox image lacks it, and whoever runs the platform has to add it.

Last, open the pull request, or push to the one already open:
`gh pr create --head afk/setup --title "Set up for the AFK platform" --body "<what was added and why>"`

Done when every repo has its pull request and a passing `plat repo check`, or a named reason it cannot pass.

## 6. Report

A short table: repo, pull request, gate check, GitHub App. Then the next steps: merge the pull requests; after that, plan with `/grill-with-docs` in the planning repo. Remove the worktrees once their branches are pushed (`git worktree remove`).
