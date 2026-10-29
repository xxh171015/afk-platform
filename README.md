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
4. A checkout of the skills repo at the pinned commit; the worker mounts its `skills/engineering` directory read-only.

**Each time** (one terminal each)

```sh
docker compose up -d --wait postgres
export DATABASE_URL=postgres://afk:afk@localhost:5432/afk
pnpm db:migrate
pnpm api                      # http://127.0.0.1:3000 ($PORT to change)
pnpm web                      # http://127.0.0.1:5173

export AFK_MODEL=<cursor model>
export AFK_SKILLS_DIR=<skills checkout>/skills/engineering
pnpm worker                   # Ctrl-C aborts the runs in hand and stops; those jobs are dispatched again when their lease runs out (Ctrl-C twice: exit at once)
```

| Worker setting | Default |
| --- | --- |
| `AFK_API_URL` | `http://127.0.0.1:3000` |
| `AFK_HOME` | `~/.afk` (slots, main clones, salvage, sandbox logs) |
| `AFK_SLOTS` | 2 (jobs at once) |
| `AFK_SANDBOX_IMAGE` | `sandcastle:afk-platform` |
| `AFK_WORKER_ID` | the host name |
| `AFK_GITHUB_APP_DIR` | `~/.afk/secrets/github-app` |
| `CURSOR_API_KEY`, `AFK_MODEL`, `AFK_SKILLS_DIR` | required |

A worker that is missing any of these, or cannot reach the API, says what is wrong and exits before taking a job.

**A first spec** (`pnpm plat …` talks to `$AFK_API_URL`; add `--json` for machine output)

```sh
pnpm plat project create shop --protected-path ".github/**"
pnpm plat repo add --project 1 --role backend --url https://github.com/<owner>/afk-pilot-backend.git
pnpm plat spec create --project 1 --type feature --title "订单备注" --file spec.md
pnpm plat tickets import S-1 tickets.yaml
pnpm plat spec confirm S-1     # the scheduler starts; watch it on the page or with: pnpm plat spec show S-1
```

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
