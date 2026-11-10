---
name: afk-setup
description: Set a project's repos up for the AFK platform, or bring that setup up to date. Use when a repo is not on the platform yet, including mid-planning when plat says a ticket's repo does not belong to the project; when plat says to run the afk-setup skill; or after the platform was upgraded.
---

# AFK setup

Gets every repo of a project ready for the AFK platform, so the person can go straight to grill-with-docs, to-spec and to-tickets. You run every command and decide everything the repos themselves answer. Nothing is merged on its own: each repo's setup goes to an `afk/setup` branch, the platform starts every spec's integration branch with it, and the person reviews it in the spec's pull request, beside the code that needed it. What only the planning reads (the tracker doc, `docs/agents`, the `## Agent skills` section) is not part of it: `plat init` writes it into the person's own checkout of the planning repo, for this machine only, so the person plans there on any branch with a clean `git status`. Ask only for what nothing on this machine says: the platform's address when it does not answer, and a repo's local path when it is not among the workspace folders. Running it again is safe: each step finds what is already done and only fills the gaps.

Speak the person's language in chat. Show command output when it carries a problem; otherwise summarise it in a line.

**Called mid-planning** (plat said a ticket's repo does not belong to the project): set up that repo and nothing else: register it with `plat init` in the planning repo's checkout, which rewrites the tracker doc there on this machine (not through `afk/setup`), then ready the new repo (sections 3 and 5); then go back to the planning where it stopped and import again.

**A project already set up, on another machine** (`plat init --dry-run` in the planning repo's checkout shows every repo registered, and each repo has `.sandcastle/gates.yaml` on `origin/afk/setup` or its default branch): do only this machine's part: sections 1 and 2, and step 1 of section 4. Push nothing, create no labels and run no gate check; the report is one line saying this machine is ready (in Chinese: 本机已就绪).

## 1. Tools on this machine

1. **Prerequisites**: `node --version` is 20 or newer, `git --version` works, and `gh auth status` says logged in. For each one missing, say in one line the command the person runs (for example "Node 20+: `brew install node`, or the installer from nodejs.org"; "gh: `gh auth login`"), and stop until they are there. Do not install them or log in for the person.
2. **The platform's address**: `$AFK_API_URL` when it is set; else, when plat is installed, the one `plat connect` (no address) prints; else `http://127.0.0.1:3000`. It is right when `curl -fsS "<address>/version"` answers. When it does not, ask the person once for the address and check it the same way; when `$AFK_API_URL` is set to an address that does not answer, also tell the person to remove it from their shell configuration, since it comes before the address plat remembers.
3. **plat**: when there is none, install the platform's copy into a directory already on `PATH` that the person can write to (prefer `~/.local/bin`, then `~/bin`, when on `PATH`; any other directory on `PATH` under the home directory will do):
   `curl -fsSL "<address>/cli/plat.mjs" -o <dir>/plat && chmod +x <dir>/plat`
   Only when no such directory is on `PATH`: make `~/.local/bin`, install there, and add one line `export PATH="$HOME/.local/bin:$PATH"` to the configuration of the shell the person uses (`~/.zshrc` for zsh, `~/.bashrc` for bash); say in the report which file got the line. When `plat version` differs from the `platformVersion` of `/version`, run `plat --api-url <address> update`. Then run `plat connect <address>`: plat remembers the address on this machine, so nothing goes in the shell's configuration.
4. **Planning skills**: grill-with-docs, grilling, domain-modeling, to-spec and to-tickets come in the same package as this skill. Whether a copy is the platform's is what plat's skill warnings check; do not only look whether one is there, since the person may have Matt's skills of the same names. Once section 2 has decided the planning repo, run `plat update` in its checkout: it installs the package at the platform's commit, at the level afk-setup is at, and prints a `skills:` line for each thing it did. Its rules, so you can explain them: afk-setup in this repo → the whole package here; afk-setup for the user, with planning skills of the person's own for the user → afk-setup for the user and the planning skills in this repo, never over theirs; afk-setup for the user and no such skills → the whole package for the user; copies in this repo that are not the platform's are replaced, and named. Skills installed in a repo stay on this machine: plat adds them and `skills-lock.json` to the repo's `.git/info/exclude` so they never reach a commit. A `skills-lock.json` the repo tracks stays tracked: commit its change with the repo's setup (section 3) and name the entries it gained in the commit message. Put its `skills:` lines in the report.

Done when `plat version` matches the platform and `plat connect` (no address) says the platform answers; the skills are done once `plat update` ran without a failure in the planning repo (after section 2).

## 2. The repos

The repos are the git checkouts among the workspace folders; read each one's `origin` and default branch. A repo added to the workspace later is set up when planning first needs it (see "Called mid-planning").

The **planning repo** is where the person plans, decided in this order:
1. the repo afk-setup is installed in (project level): that is where the person chose to plan; the report says so;
2. the repo whose `docs/agents/issue-tracker.md` the platform wrote (its first line is `<!-- plat tracker-doc …`): the project already has it;
3. the only repo;
4. the only repo with an `openapi` file (the one that owns the API contract);
5. the first workspace folder that is a git checkout.

Done when every repo has a path and the planning repo is decided; the report names it and why.

## 3. A setup worktree per repo

All changes go to `afk/setup` on origin, made in a temporary worktree outside the person's checkout, so their branches and files stay as they are and nothing is left behind. `<setups>` is `~/.afk/setup/<project>` (`$AFK_HOME/setup/<project>` when `$AFK_HOME` is set), where `<project>` is the planning repo's name, so every run finds the same folder; a repo's `<setup>` is `<setups>/<repo name>`. For each repo, first `git -C <checkout> fetch origin`, then:

- When `<setup>` is there already (an earlier run stopped): if it has uncommitted changes (`git -C <setup> status --porcelain`) or commits origin's `afk/setup` lacks (`git -C <setup> log origin/afk/setup..HEAD`, or against `origin/<default branch>` when origin has no `afk/setup`), carry on in it; otherwise remove it (`git -C <checkout> worktree remove --force <setup>`) and make it again as below.
- Otherwise: `git -C <checkout> worktree add --detach <setup> origin/afk/setup` (when origin has no `afk/setup` yet, start from `origin/<default branch>`). Detached: no local branch is made.

Either way, when origin has `afk/setup`, merge `origin/<default branch>` into it in `<setup>` (`git merge origin/<default branch>`), so that it still merges into the default branch: the platform refuses to start a spec's tickets on a setup that does not. When the default branch has everything `afk/setup` has (a spec that carried it was merged), the merge brings it up to date and the steps below only fill what is missing.

**Left over from an older afk-setup**: a `<checkout>-afk-setup` worktree or a local `afk/setup` branch. They go together: remove them when the worktree has no uncommitted changes (`git -C <checkout>-afk-setup status --porcelain` is empty) and the branch's commits are all on origin (`git -C <checkout> log afk/setup --not --remotes` is empty): `git -C <checkout> worktree remove <checkout>-afk-setup`, then `git -C <checkout> branch -D afk/setup` (`-D`: the check above is what makes it safe, and `-d` refuses a branch whose upstream is gone). Say so in one line of the report. When either check finds something, leave both alone and say in one line which and why (for example "backend-afk-setup kept: 2 uncommitted files").

The platform only reads what is pushed. It never merges `afk/setup` into the default branch: every spec's integration branch starts with it until the default branch has it, so it reaches the default branch with the first spec's pull request. Open no pull request for it.

Done when every repo has its `<setup>`, up to date with origin, and every leftover is removed or named.

## 4. Register

In the person's own checkout of the planning repo (not a worktree; whatever branch it is on):

1. `plat init --yes --with <checkout of each other repo> ...`. It registers what is not registered yet; a registered repo keeps its name and settings. It writes the tracker doc, `docs/agents/domain.md`, `docs/agents/triage-labels.md` and the local rule files `CLAUDE.local.md` (Claude Code) and `.cursor/rules/afk-platform.mdc` (Cursor), which hold the `## Agent skills` section and the planning conventions. It adds them to the repo's `.git/info/exclude`: they stay on this machine and are never committed. Do not move them into `AGENTS.md` or `CLAUDE.md`. A repo that already tracks one of these files (an older setup committed it) keeps it there: plat updates the tracked file and its `next:` line names it; copy that change into the planning repo's `<setup>` and commit it with the setup (section 5), then `git restore` it in the person's checkout.
2. Each repo's 托管 line comes back. When it is not "can work here" / 「托管正常」, give the person the fix from that line (GitHub: the install/permissions link, for whoever runs the platform; GitLab: who to add as Developer, or the personal-token / Developers-can-merge hint) and carry on with the next steps.
3. Create the triage labels the planning repo's GitHub lacks: compare `gh label list` with the five in `docs/agents/triage-labels.md` and `gh label create` each missing one.

Done when `plat init` printed the project and every repo is registered.

## 5. Ready each repo

For every repo, in its `<setup>`:

- **Gate**: write `.sandcastle/gates.yaml` following [gates.md](gates.md), unless one is there already.
- **AGENTS.md**: the agent that implements tickets reads it. When the repo has one (or a `CLAUDE.md`), keep it and add only what is missing: how to run the tests, how to run a single test file, and the section "Running unattended": nobody answers questions during a run; when a decision only a person can make comes up, the agent reports `cannot-proceed` and ends. Without one, write it from the code: what the repo is, where things live, how to run it, its conventions, and how to run a single test file.

End-to-end tests against other repos are not set up here: a spec that needs them adds what they need as tickets (the tracker doc's "Integration tickets").

Then commit, `git -C <setup> push origin HEAD:afk/setup`, and run, from the planning repo's checkout:

`plat repo check <repo name> --branch afk/setup`

It runs the gate in the platform's sandbox, exactly as tickets will be gated. When it fails, read the failing command's output, fix the cause, push, and check again. When a command is missing from the sandbox itself (`command not found` for a toolchain the repo needs), stop for that repo and tell the person: the platform's sandbox image lacks it, and whoever runs the platform has to add it.

The commit message says what was added and why, and names every file that was replaced rather than added (for example an `issue-tracker.md` that pointed at another tracker): the reviewer of the spec's pull request reads it there.

Once a repo's check passes, remove its worktree: `git -C <checkout> worktree remove <setup> && git -C <checkout> worktree prune`. A repo that fails keeps its `<setup>`, and the report says where it is and where it got stuck; running afk-setup again carries on there. Only when every repo passed, remove `<setups>`; while one failed, it stays with that repo's `<setup>` in it.

Done when every repo has `afk/setup` pushed and a passing `plat repo check` with its worktree removed, or a named reason it cannot pass.

## 6. Report

A short table: repo, `afk/setup` pushed, gate check, 托管, and for a repo that did not pass, where its `<setup>` is and the 托管 fix (who to ask); and which repo is the planning repo. Then the next step: plan with `/grill-with-docs` in the person's own checkout of the planning repo, on any branch: the planning files are there, on this machine only. Nothing needs merging first: the setup reaches each default branch with the first spec's pull request. Called mid-planning, the report is one line: the repo and its gate check. Add a line for each leftover from an older afk-setup that was removed or kept (section 3).
