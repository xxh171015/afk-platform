# afk-platform

pnpm monorepo for the AFK platform. Design: [docs/design.md](docs/design.md), stack: [docs/m1-tech-stack.md](docs/m1-tech-stack.md).

Packages: `shared`, `api`, `pipeline`, `worker`, `cli`, `web` (dependency direction is in the tech-stack doc; `worker` does not depend on `api`).

## Requirements

- Node ≥ 22.18 (runs `.ts` directly)
- pnpm (`corepack enable`)
- A Postgres to test against, reached through `DATABASE_URL`

## Start Postgres

Tests use a real Postgres, never a mock. Pick one:

**Docker (local machine)**

```sh
docker compose up -d --wait postgres
export DATABASE_URL=postgres://afk:afk@localhost:5432/afk   # see .env.example
```

Postgres keeps its data in the named volume `afk-platform_pgdata`, so removing the container does not lose it (`docker compose down -v` still does). A container made before the volume existed keeps its data in an anonymous volume; `docker compose up` would start the new one empty. To move over: `pg_dump` the database first (`docker compose exec -T postgres pg_dump -U afk afk > afk.sql`), recreate the container, and load the dump into it.

**No Docker (sandbox, CI)** — starts a throwaway instance from an installed PostgreSQL (`/tmp/afk-pg`, port 54329):

```sh
eval "$(scripts/pg-temp.sh start)"   # exports DATABASE_URL
scripts/pg-temp.sh stop
```

Override the location and port with `PGTEMP_DIR` and `PGTEMP_PORT`.

## Database migrations

Tables are defined in `packages/api/src/db/schema.ts` (Drizzle); the generated SQL lives in `packages/api/drizzle/` and is committed.

```sh
pnpm --filter @afk/api db:generate   # after editing schema.ts: writes a new migration file
pnpm db:migrate                      # applies pending migrations to $DATABASE_URL (safe to re-run)
```

The API never migrates on its own: `pnpm api` refuses to start while migrations are pending (`assertMigrated()` in `packages/api/src/db/migrate.ts`).

Columns with a closed vocabulary (ticket and spec states and types, blocked reasons, edge kinds) are CHECK-constrained from the constants in `@afk/shared`, so the database and the zod schemas cannot drift apart. `drizzle.config.ts` has no database credentials: it only serves `db:generate`; use `pnpm db:migrate` to apply.

## Job queue and worker API

Jobs live in the `jobs` table; `packages/api/src/jobs/queue.ts` holds the queue and `packages/api/src/http/worker-routes.ts` the worker-facing HTTP routes (`POST /worker/jobs/claim`, then `/{id}/heartbeat`, `/pre-push`, `/complete`, `/fail`, plus the read-only `GET /{id}/lease?attempt=` a worker asks before treating a slot lock as a zombie's). A claim takes a 2-minute lease (`FOR UPDATE SKIP LOCKED`); workers heartbeat every 30 seconds. Every call after the claim carries `(workerId, attempt)` and is refused with 409 unless it is the current lease holder; a lease that runs out puts the job back with `attempt + 1`. The first attempt is 1. Jobs are enqueued in-process with `enqueueJob`, keyed by `ticketJobKey(...)`; the same key returns the existing job. The routes have no authentication yet.

## Run it on this machine (Mac)

Four processes: Postgres, the API, the page and one worker. All of them listen on 127.0.0.1 only (compose binds Postgres there too).

**The first time, just run `scripts/up.sh`.** It checks everything under "Once" below (Docker, Node, dependencies, the sandbox image, `AFK_MODEL`, the Cursor key, the GitHub App files) and, in a terminal, offers to do each missing step for you: it saves the model and the key to `~/.afk/env` (mode 600). The GitHub App cannot be made for you; the script points at it and starts without. `scripts/up.sh --check` only checks. Settings come from the environment first, then `~/.afk/env`. The steps below are what it does, for doing them by hand.

**Once**

1. Docker Desktop running, and the sandbox image built: `scripts/verify-sandbox-image.sh` (tags `sandcastle:afk-platform`).
2. GitHub App credentials in `~/.afk/secrets/github-app/`: `private-key.pem` (mode 600) and `app.json` = `{"appId":"…","installationId":"…"}`. Check them with `node scripts/check-github-app.ts <owner>/<repo>`.
3. The Cursor key in `~/.afk/env` as `CURSOR_API_KEY=…` (or exported). The worker reads nothing else from that file.

The skills the agents run in the sandbox (implement, tdd, code-review, codebase-design) are in this repo, copied from mattpocock/skills at the pinned SHA: the worker mounts `packages/pipeline/skills/` read-only.

**Each time**: `AFK_MODEL=<cursor model> scripts/up.sh` starts all of the below in one terminal (output prefixed `[api]`, `[web]`, `[worker]`; Ctrl-C stops them; `WEB=0` / `WORKER=0` leave one out). Or by hand, one terminal each:

```sh
docker compose up -d --wait postgres
export DATABASE_URL=postgres://afk:afk@localhost:5432/afk
pnpm db:migrate
pnpm api                      # http://127.0.0.1:3000 ($PORT to change); run logs go to ~/.afk/logs/<instance id>/ ($AFK_LOG_DIR to change; give each database its own)
pnpm web                      # http://127.0.0.1:5173 （工作台）

export AFK_MODEL=<cursor model>
pnpm worker                   # Ctrl-C aborts the runs in hand and stops; those jobs are dispatched again when their lease runs out (Ctrl-C twice: exit at once)
```

| Worker setting                                  | Default                                              |
| ----------------------------------------------- | ---------------------------------------------------- |
| `AFK_API_URL`                                   | `http://127.0.0.1:3000`                              |
| `AFK_HOME`                                      | `~/.afk` (slots, main clones, salvage, sandbox logs) |
| `AFK_SLOTS`                                     | 2 (jobs at once)                                     |
| `AFK_SANDBOX_IMAGE`                             | `sandcastle:afk-platform`                            |
| `AFK_WORKER_ID`                                 | the host name                                        |
| `AFK_GITHUB_APP_DIR`                            | `~/.afk/secrets/github-app`                          |
| `CURSOR_API_KEY`, `AFK_MODEL`                   | required                                             |

A worker that is missing any of these, or cannot reach the API, says what is wrong and exits before taking a job. A worker with GitHub App credentials also does the jobs for the code host: opening and following a spec's pull requests, and, once a spec is cancelled or merged, closing its pull requests that are still open and deleting its `spec/*` and `agent/*` branches on the remote (closing a pull request needs the App's `pull_requests: write`, deleting a branch `contents: write`; the App already has both). A worker that was killed leaves its sandbox container running on its slot; the next worker to reuse that slot (after the lease runs out) removes the containers that still mount it before it salvages the slot.

How a run is carried out comes from the project, per job, not from the worker: `--limit runIdleSeconds=…` (an agent silent for that long is stopped; default 600) and `--limit runWallclockSeconds=…` (a run's total time; default 3600) on `plat project create` or `plat project edit`, and the project's default model (`--default-model` on the same commands; `AFK_MODEL` is what a project without one gets; the Run records the model it used). Cursor's raw event lines go to the run's log (`plat run logs R-…`) with the worker's `CURSOR_API_KEY` replaced by `***`; a line is cut at 16 KB, and a stage uploads at most 8 MB of them. The full stream also stays on the worker, unredacted, under `$AFK_HOME/sandbox-logs/` (keep that folder private: a tool that echoed the key puts it there).

Branch names carry the database's id (six hex digits, made once by the migration, kept in the `instance` table) so that two databases working on one repository never make the same branch: `spec/<id>/<slug>`, `agent/<id>/T-<n>`, `agent/<id>/S-<n>-final`. A spec made before the ids existed keeps `spec/<slug>`, `agent/T-<n>`, `agent/S-<n>-final`. Upgrade the API and its workers together: a worker and an API from before and after this change do not understand each other's bundles.

**Setting a project up**: on the planning machine, two steps. 1: in the planning repo, `npx skills@latest add xxh171015/afk-platform` (the control tower gives it pinned to the platform's commit, `#<commit>`): afk-setup and the planning skills (grill-with-docs, grilling, domain-modeling, to-spec, to-tickets, copied unchanged from mattpocock/skills at the pinned SHA under skills/). Choose all the skills, and the agents you use; in the project (on this machine only: plat keeps the files and `skills-lock.json` in `.git/info/exclude`) or globally is your choice. The risk table it shows is the skills CLI's general scan of every package. 2: open the project's repos in Cursor and run `/afk-setup`. It installs `plat` from the platform (`GET /cli/plat.mjs`; `GET /version` says which version and commit the platform is) and runs `plat update`, which brings the skills to the platform's commit at the level afk-setup is at (never over planning skills you have globally of your own), registers the repos with `plat init`, has a worker check the GitHub App on each repo, writes `.sandcastle/gates.yaml` and `AGENTS.md` where they are missing, has the platform run each repo's gate on an `afk/setup` branch (`plat repo check <repo> --branch afk/setup`), and leaves it there: no pull request (skills/afk-setup). Every spec's integration branch in a repo starts with the repo's `afk/setup` merged onto the default branch's head (the setup commit, ADR 0006), so the gate and the agents read the setup and it reaches the default branch with the spec's pull request; once the default branch has it, there is no setup commit. What only the planning reads (the tracker doc, `docs/agents`, and the `## Agent skills` section in the local rule files `CLAUDE.local.md` and `.cursor/rules/afk-platform.mdc`) stays on the planning machine, in the person's own checkout of the planning repo, kept out of git by `.git/info/exclude` (ADR 0007): the person plans there on any branch, and each planning machine runs `/afk-setup` once. It asks nothing it can work out itself. After the platform is upgraded, `plat update` replaces plat with the platform's and installs the skills at the platform's commit again at the levels they are at; plat says to run it when either is out of date. A repo added later is set up by the planning agent when a ticket first needs it (plat says the repo does not belong to the project, and the agent runs the skill); `plat spec confirm` refuses to start while a ticket's repo has no `.sandcastle/gates.yaml` on its default branch or on `afk/setup`. End-to-end environments are not set up here: a spec that needs one adds it as tickets (the tracker doc's "Integration tickets"), and `plat tickets import` warns when one is missing. The sandbox image is the platform's, shared by every repo.

**A first spec** (`pnpm plat …` talks to `$AFK_API_URL`, else the address `plat connect` remembered; add `--json` for machine output)

```sh
(cd <afk-pilot-backend checkout> && node <afk-platform>/packages/cli/src/bin.ts init)   # registers project and repo, writes docs/agents/issue-tracker.md; run it in the repo, not through pnpm, which changes directory
pnpm plat spec create --project 1 --type feature --title "订单备注" --file spec.md
pnpm plat tickets import S-1 docs/specs/m1-acceptance/tickets
pnpm plat spec confirm S-1     # the scheduler starts; watch it on the page or with: pnpm plat spec show S-1
```

`plat init` (run in the planning repo, `--with <path>[=<name>]` for each other repo) reads each repo's address, code host, default branch and, for the planning repo, its single openapi file from git; it shows the plan (`--dry-run` stops there), asks once, registers what is not registered yet (a registered repo is found by its address and keeps its name and settings), writes the tracker doc, what setup-matt-pocock-skills would write (`docs/agents/domain.md`, `docs/agents/triage-labels.md`, the `## Agent skills` section) and the planning conventions, on this machine only: files the repo does not track go to its `.git/info/exclude`, and the section goes into `CLAUDE.local.md` and `.cursor/rules/afk-platform.mdc`, not `AGENTS.md` (a repo that tracks them keeps them, updated in place), and prints whether the GitHub App can work on each repo. A repo is known by its name (`--role` still works as another word for `--name`); the name is what `repo:` in the ticket file says. The contract path belongs to the repo that owns the contract: set it with `plat repo edit <name> --project <id> --contract-path <path>`, change it the same way, or pass `--contract-path ""` to clear it. Other project settings are edited in place with `pnpm plat project edit 1 --max-concurrency 3`. Only the options given change (`--protected-path` replaces the whole list, `--limit name=value` is merged with the limits already set; `--budget-limit` too). Tickets already made keep what they have; bundles built afterwards use the new values. `plat project create/edit --contract-path` is refused with a pointer to `plat repo edit`.

**Adding to a confirmed spec**: `pnpm plat tickets import S-1 more --append` (`more` is a directory of ticket files) adds tickets and edges to a spec that is running (or planned, or paused); they take effect at once and nothing is asked again. The file may name existing tickets as `T-<n>` in `blocked_by` / `contract`, and `blocks: [T-<n>]` in a file makes the new ticket block an existing pending or blocked one (only a plain blocking edge: a contract edge cannot point at an existing ticket; an edge between two existing tickets is refused). The whole merged graph is checked, cancelled tickets left out. Appending a contract ticket prints which tickets still stand on the old contract. A finished ticket is never reopened. **To split a ticket**: append the new tickets, then `pnpm plat ticket cancel T-n` on the old one.

**Editing a ticket**: `pnpm plat ticket view T-3 --md > t.md` prints the ticket file (the same text the agent reads as `/context/ticket.md`), and `pnpm plat ticket edit T-3 --file t.md` changes the content of a pending or blocked ticket from such a file (`title`, the body, `modules`, `protected_paths_ok`; the acceptance criteria are read again from the body); the content version goes up by one if anything changed and the ticket keeps its state, so a blocked ticket is still retried by hand. The repo, type, dependencies, contract, `refs` and `environment` may be left out of the file, and written must equal the ticket's; they cannot be changed: cancel the ticket and append a new one. Every version is kept: `pnpm plat ticket view T-3 --version 1` shows the content the ticket had then.

**Merge order and draft pull requests**: all of a spec's pull requests are opened together, but the repo that uses another repo's contract (a contract edge from X's ticket to Y's) is opened as a **draft** until X's pull request is merged. Repos with no contract relation have no order and no draft. When a look at the host sees X merged, a `pr-ready` job turns Y's draft ready (GitHub lets the App turn a draft ready only with a token that writes both pull requests and contents, so the job asks for both; seen on the pilot repos with the App's `pull_requests: write` and `contents: write`. If the host refuses, the job fails three times, a minute apart, and `plat blocked` lists the pull request: turn it ready by hand and the next look at the host takes note). `plat spec show` and the spec page list the pull requests in merge order, each with draft/ready and what it waits for.

**Read-only snapshots (`refs:`)**: a ticket that lists `refs: [repo…]` gets each of those repos at `/refs/<repo>/` in the agent's sandbox, read-only, at the head of that repo's integration branch for the spec (the head of its default branch when nothing of the spec has merged there). The worker keeps them under `~/.afk/snapshots/<repo>@<sha>` and deletes the ones unused for 7 days when it starts. Known limits: submodules are not exported, and Git LFS files are not expanded (you get the pointer files).

## Run the checks

```sh
pnpm install
pnpm check      # typecheck + test + lint
```

Single steps: `pnpm typecheck`, `pnpm test`, `pnpm lint`. Tests write JUnit XML to `reports/junit.xml`.

## Gate config

`.sandcastle/gates.yaml` lists `setup`, `typecheck`, `test` (with JUnit path) and `lint`, in the M0 draft format from design.md.

## Sandbox image

`.sandcastle/Dockerfile` is the agent sandbox image: the pilot repo's Sandcastle template (Cursor CLI version pinned) plus the PostgreSQL server and pnpm, so the gate's `setup` can start a throwaway Postgres with `scripts/pg-temp.sh`. The sandbox has no Docker, so the image has to be built and checked on a machine that does:

```sh
scripts/verify-sandbox-image.sh   # build, time it, run the gate in a fresh container, read JUnit on the host
```

It tests the committed HEAD and writes the results (build time, image size, Cursor CLI and PostgreSQL versions, gate result) to `reports/sandbox-image.env`.
