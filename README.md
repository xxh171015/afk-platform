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
docker compose up -d postgres
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

The API never migrates on its own. `assertMigrated()` (`packages/api/src/db/migrate.ts`) is the startup guard: the API entry point must call it so the server refuses to start while migrations are pending. It is not wired in yet because the API server does not exist.

Columns with a closed vocabulary (ticket and spec states and types, blocked reasons, edge kinds) are CHECK-constrained from the constants in `@afk/shared`, so the database and the zod schemas cannot drift apart. `drizzle.config.ts` has no database credentials: it only serves `db:generate`; use `pnpm db:migrate` to apply.

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
