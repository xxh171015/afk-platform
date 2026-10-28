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

## Run the checks

```sh
pnpm install
pnpm check      # typecheck + test + lint
```

Single steps: `pnpm typecheck`, `pnpm test`, `pnpm lint`. Tests write JUnit XML to `reports/junit.xml`.

## Gate config

`.sandcastle/gates.yaml` lists `setup`, `typecheck`, `test` (with JUnit path) and `lint`, in the M0 draft format from design.md.
