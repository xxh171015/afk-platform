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

**Once**

1. Docker Desktop running, and the sandbox image built: `scripts/verify-sandbox-image.sh` (tags `sandcastle:afk-platform`).
2. GitHub App credentials in `~/.afk/secrets/github-app/`: `private-key.pem` (mode 600) and `app.json` = `{"appId":"…","installationId":"…"}`. Check them with `node scripts/check-github-app.ts <owner>/<repo>`.
3. The Cursor key in `~/.afk/env` as `CURSOR_API_KEY=…` (or exported). The worker reads nothing else from that file.
4. A checkout of [mattpocock/skills](https://github.com/mattpocock/skills) at the pinned commit `59db609eb1e18aaf59b63284d0e52255aff0c63c`; the worker mounts its `skills/engineering` directory read-only:

```sh
git clone https://github.com/mattpocock/skills.git ~/.afk/skills
git -C ~/.afk/skills switch --detach 59db609eb1e18aaf59b63284d0e52255aff0c63c
```

**Each time** (one terminal each)

```sh
docker compose up -d --wait postgres
export DATABASE_URL=postgres://afk:afk@localhost:5432/afk
pnpm db:migrate
pnpm api                      # http://127.0.0.1:3000 ($PORT to change); run logs go to ~/.afk/logs/<instance id>/ ($AFK_LOG_DIR to change; give each database its own)
pnpm web                      # http://127.0.0.1:5173

export AFK_MODEL=<cursor model>
export AFK_SKILLS_DIR=~/.afk/skills/skills/engineering
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
| `CURSOR_API_KEY`, `AFK_MODEL`, `AFK_SKILLS_DIR` | required                                             |

A worker that is missing any of these, or cannot reach the API, says what is wrong and exits before taking a job. A worker with GitHub App credentials also does the jobs for the code host: opening and following a spec's pull requests, and, once a spec is cancelled or merged, closing its pull requests that are still open and deleting its `spec/*` and `agent/*` branches on the remote (closing a pull request needs the App's `pull_requests: write`, deleting a branch `contents: write`; the App already has both). A worker that was killed leaves its sandbox container running on its slot; the next worker to reuse that slot (after the lease runs out) removes the containers that still mount it before it salvages the slot.

How a run is carried out comes from the project, per job, not from the worker: `--limit runIdleSeconds=…` (an agent silent for that long is stopped; default 600) and `--limit runWallclockSeconds=…` (a run's total time; default 3600) on `plat project create` or `plat project edit`, and the project's default model (`--default-model` on the same commands; `AFK_MODEL` is what a project without one gets; the Run records the model it used). Cursor's raw event lines go to the run's log (`plat run logs R-…`) with the worker's `CURSOR_API_KEY` replaced by `***`; a line is cut at 16 KB, and a stage uploads at most 8 MB of them. The full stream also stays on the worker, unredacted, under `$AFK_HOME/sandbox-logs/` (keep that folder private: a tool that echoed the key puts it there).

Branch names carry the database's id (six hex digits, made once by the migration, kept in the `instance` table) so that two databases working on one repository never make the same branch: `spec/<id>/<slug>`, `agent/<id>/T-<n>`, `agent/<id>/S-<n>-final`. A spec made before the ids existed keeps `spec/<slug>`, `agent/T-<n>`, `agent/S-<n>-final`. Upgrade the API and its workers together: a worker and an API from before and after this change do not understand each other's bundles.

**A first spec** (`pnpm plat …` talks to `$AFK_API_URL`; add `--json` for machine output)

```sh
pnpm plat project create shop --protected-path ".github/**"
pnpm plat repo add --project 1 --name backend --url https://github.com/<owner>/afk-pilot-backend.git
pnpm plat repo edit backend --project 1 --contract-path openapi/openapi.yaml
pnpm plat spec create --project 1 --type feature --title "订单备注" --file spec.md
pnpm plat tickets import S-1 tickets.yaml
pnpm plat spec confirm S-1     # the scheduler starts; watch it on the page or with: pnpm plat spec show S-1
```

A repo is known by its name (`--role` still works as another word for `--name`); the name is what `repo:` in the ticket file says. The contract path belongs to the repo that owns the contract: set it with `plat repo edit <name> --project <id> --contract-path <path>`, change it the same way, or pass `--contract-path ""` to clear it. Other project settings are edited in place with `pnpm plat project edit 1 --max-concurrency 3`. Only the options given change (`--protected-path` replaces the whole list, `--limit name=value` is merged with the limits already set; `--budget-limit` too). Tickets already made keep what they have; bundles built afterwards use the new values. `plat project create/edit --contract-path` is refused with a pointer to `plat repo edit`.

**Adding to a confirmed spec**: `pnpm plat tickets import S-1 more.yaml --append` adds tickets and edges to a spec that is running (or planned, or paused); they take effect at once and nothing is asked again. The file may name existing tickets as `T-<n>` in `blocked_by` / `contract`, and may carry a top-level `edges: [{ from, to, kind }]` list for an edge that runs from a new ticket to an existing pending or blocked one (an edge between two existing tickets is refused). The whole merged graph is checked, cancelled tickets left out. Appending a contract ticket prints which tickets still stand on the old contract. A finished ticket is never reopened. **To split a ticket**: append the new tickets, then `pnpm plat ticket cancel T-n` on the old one.

**Editing a ticket**: `pnpm plat ticket edit T-3 --file t.yaml` changes the content of a pending or blocked ticket (`title`, `body`, `acceptance`, `modules`, `protected_paths_ok`, in the format of one ticket of the import file); the content version goes up by one and the ticket keeps its state, so a blocked ticket is still retried by hand. The repo, type, dependency edges, `refs` and `environment` cannot be changed: cancel the ticket and append a new one. Every version is kept: `pnpm plat ticket view T-3 --version 1` shows the content the ticket had then.

**Merge order and draft pull requests**: all of a spec's pull requests are opened together, but the repo that uses another repo's contract (a contract edge from X's ticket to Y's) is opened as a **draft** until X's pull request is merged. Repos with no contract relation have no order and no draft. When a look at the host sees X merged, a `pr-ready` job turns Y's draft ready (the host's pull-request write permission must allow GraphQL `markPullRequestReadyForReview`; if it does not, the job fails three times, a minute apart, and `plat blocked` lists the pull request: turn it ready by hand and the next look at the host takes note). `plat spec show` and the spec page list the pull requests in merge order, each with draft/ready and what it waits for.

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
