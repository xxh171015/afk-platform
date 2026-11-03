# Integration: end-to-end tests against the real backend

An integration ticket lives in the consuming repo (say the frontend). The platform starts the repos it names under `environment:` from the spec's integration branches, puts the consumer's sandbox on the same network, and runs its end-to-end tests there.

## In each repo that is started (the backend)

`.sandcastle/integration/compose.yaml`, built from the repo itself:

```yaml
# addresses the consumer's sandbox gets as environment variables (compose ignores x- keys)
x-afk-env:
  BACKEND_URL: http://backend:8080
services:
  backend:
    build:
      context: ../..
      dockerfile: Dockerfile
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://localhost:8080/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
      interval: 2s
      timeout: 3s
      retries: 15
  # writes the sample data the end-to-end tests rely on, then exits; named seed-<repo name>
  seed-backend:
    image: node:22-bookworm-slim
    working_dir: /seed
    volumes:
      - ../../scripts:/seed:ro
    environment:
      BACKEND_URL: http://backend:8080
    command: ["node", "--experimental-strip-types", "seed.ts"]
    depends_on:
      backend:
        condition: service_healthy
    restart: "no"
```

- The service needs a `Dockerfile` that runs it and a health endpoint; add them when the repo has none.
- The seed service is named `seed-<repo name>` exactly as the repo is registered on the platform.
- Leave the default network as it is: the sandbox reaches the model API through it.

## In the consuming repo (the frontend)

- `npm run e2e` runs the end-to-end tests against the addresses in `x-afk-env` and writes JUnit XML to `reports/e2e-junit.xml`.
- End-to-end tests stay out of `gates.yaml`: the gate runs without the backend.
- When the backend owns the contract: keep a copy of it (for example `contract/openapi.yaml`), generate the client from the copy, and gate that the generated client matches it ([gates.md](gates.md)). Tickets that change the contract update the copy.
