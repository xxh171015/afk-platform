<!-- tracker-doc template for mattpocock/skills@59db609eb1e18aaf59b63284d0e52255aff0c63c -->
### Integration tickets

- An integration ticket runs one repo's end-to-end tests against the real services of others: `type: integration`,
  in the consuming repo, `environment: [<repo>]` naming the repos it needs (not its own), blocked by both sides'
  implementation tickets. The platform starts the `environment` repos from the spec's integration branches and runs
  `npm run e2e` in the consuming repo's sandbox, on the same network.
- Write one only when the spec needs it. What it needs and the repos lack is part of the same spec: tickets for it,
  each blocking the integration ticket.
  - Each `environment` repo: `.sandcastle/integration/compose.yaml`, built from the repo (`build.context: ../..`),
    with its service and a `healthcheck`; a one-off service named `seed-<repo>` that writes the sample data the tests
    rely on (`depends_on` the service healthy, `restart: "no"`); and a top-level `x-afk-env:` map of the addresses the
    consumer gets as environment variables (for example `BACKEND_URL: http://backend:8080`). Leave the default
    network as it is: the sandbox reaches the model through it. The repo needs a `Dockerfile` that runs the service
    and a health endpoint; the same ticket adds them when they are missing.
  - The consuming repo: `npm run e2e` runs the end-to-end tests against the addresses in `x-afk-env` and writes JUnit
    XML to `reports/e2e-junit.xml`. Keep them out of `.sandcastle/gates.yaml`: the gate runs without the other repos.
- `plat tickets import` warns when an `environment` repo has no compose file on its default branch and no ticket file
  of that repo mentions `.sandcastle/integration/compose.yaml`.
