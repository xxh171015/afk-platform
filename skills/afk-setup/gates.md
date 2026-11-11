# The gate: `.sandcastle/gates.yaml`

The platform accepts a ticket's change only when its gate passes. The gate runs in a fresh sandbox (Debian, Node 22, npm, pnpm, a PostgreSQL server that is not started) on a clone of the repo, with network access.

```yaml
version: 1
# runs first, in every fresh sandbox
setup: npm ci
commands:
  - name: typecheck
    run: npm run typecheck
    timeoutSeconds: 300
  - name: test
    run: npm test
    timeoutSeconds: 600
    # where the test runner writes JUnit XML: the number of tests may not shrink from one change to the next
    junit: reports/junit.xml
  - name: lint
    run: npm run lint
    timeoutSeconds: 300
```

- Take each command from what the repo already runs: `package.json` scripts, its CI workflow, its README. Name commands after what they check; keep the order cheap to expensive, since the first failure stops the gate.
- One command must write JUnit XML and name the file in `junit`. When the test runner writes none yet, configure its JUnit reporter in the repo (vitest: `reporters: ["default", "junit"]` with `outputFile: { junit: "reports/junit.xml" }`; jest: `jest-junit`) as part of the same pull request.
- A repo that owns an API contract adds a command that validates it; a repo with a copy of another repo's contract adds one that checks the generated client still matches the copy.
- Tests that need a database start a throwaway one from `setup` or the test command, inside the sandbox; nothing else runs beside the sandbox during a gate.
- The gate reads this file from the branch a ticket merges into: changing it later takes a pull request too.
- `setup` is the place for what can fail for reasons outside the change: installing dependencies, starting a database. A failing `setup` is not handed to an agent to fix: the job is tried again (three times, a minute or two apart), then the ticket waits for a person. Put real checks in `commands`, never in `setup`.
- When the worker has `AFK_NPM_REGISTRIES` set (registries separated by spaces, e.g. a public mirror and the company one), every sandbox gets it as an environment variable. A Node repo can install from them in order, moving on when one fails, like this repo's `scripts/install-deps.sh` does:
  ```sh
  for registry in ${AFK_NPM_REGISTRIES:-https://registry.npmjs.org}; do
    pnpm install --frozen-lockfile --registry "$registry" && exit 0
  done
  exit 1
  ```
  Registry addresses stay in the worker's configuration (`~/.afk/env`), not in the repo.
