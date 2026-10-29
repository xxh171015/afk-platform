# Issue tracker: afk-platform (`plat`)

Specs and tickets for this repo live in the afk-platform, not in GitHub issues. Use the `plat` CLI for all operations.
`plat` is a command on this machine (a wrapper around the afk-platform CLI); run it from this repo, so file paths are
relative to here. It talks to `$AFK_API_URL`, default `http://127.0.0.1:3000`.
Add `--json` for machine output. The platform's API must be running; a worker must be running for tickets to be worked.

This repo is the project's `backend` repo (`repo: backend` in the ticket file). One spec can only change one repo in M1.

## Conventions

- **Publish a spec** (what a skill means by "publish to the issue tracker" for a PRD):
  `plat spec create --project <id> --type feature --title "<title>" --slug <english-slug> --file <spec.md>`
  It prints the spec number, e.g. `S-7`. Pass `--slug` (lowercase letters, digits, hyphens) whenever the title has no
  Latin words: a Chinese-only title cannot be turned into a slug.
- **Publish tickets** (to-tickets): write a `tickets.yaml` (format below), then
  `plat tickets import S-7 tickets.yaml`. The import is all or nothing and lists every problem at once. Tickets
  can only be imported into a draft spec, and only once.
- **Confirm the split**: `plat spec confirm S-7` starts the pipeline. A person does this, after reading the tickets
  and the overlap warnings. A skill never confirms.
- **Read a spec**: `plat spec show S-7` (tickets, edges, warnings; after the run, the acceptance pack).
- **Fetch a ticket** (a skill's "fetch the relevant ticket"): `plat ticket view T-8`.
- **See what waits for a person**: `plat blocked`. Read a run's log: `plat run logs R-25`.
- **Unblock**: `plat ticket retry T-8`, `plat ticket approve-protected T-8` (only after the gate found a
  protected-path change), `plat ticket allow-path T-8 .github/CODEOWNERS` (a blocked ticket that needs a protected path
  the file did not approve; then retry it), `plat ticket cancel T-8`. Ticket commands live under `ticket`, not at the top level.

Numbers are global and are never reused, and a failed `spec create` may still take one. Always use the number the
command printed.

## tickets.yaml

```yaml
spec: S-7                  # optional; if present it must equal the spec being imported into
tickets:
  - key: contract          # a name for this file only, used by blocked_by and contract
    repo: backend          # the repo's role in the project
    type: contract         # contract | implementation | integration
    title: 契约：订单备注字段
    modules: ["openapi/**"]            # globs of the files the ticket may touch; at least one
    protected_paths_ok: ["openapi/openapi.yaml"]   # see below
    acceptance:                        # at least one; each line is checked against the tests the agent names
      - "openapi.yaml 的 Order 里有可选字符串字段 note"
    body: |                            # the brief for the agent
      只改契约，不改代码。
  - key: note-field
    repo: backend
    type: implementation
    title: 订单增加备注字段
    modules: ["src/orders/**", "test/**"]
    blocked_by: [contract]             # runs after these tickets are merged
    contract: contract                 # optional: gets the contract as it was when `contract` was merged
    acceptance:
      - "POST /orders 接受可选的 note，超长返回 400"
external_blocked_by: []                # must be empty in M1
```

Rules the importer enforces, and mistakes seen in practice:

- Every ticket needs `repo`, `title`, at least one glob in `modules` and at least one `acceptance` line. Unknown keys
  are rejected.
- **Quote every `acceptance` line and every `title`** that contains `: ` or starts with a special character, or the
  YAML will not parse. Quoting them all is the safe habit.
- A ticket that changes a **protected path** (project setting, `.github/**` by default, plus the contract file) must
  list the exact files in `protected_paths_ok`. Without it the agent stops before changing anything and the ticket is
  blocked; fix it with `plat ticket allow-path` and `plat ticket retry`.
- `type: contract` is for a ticket that only edits the contract file. A ticket using `contract: <key>` must point at a
  contract ticket. The project needs a contract path (`plat project create --contract-path backend:openapi/openapi.yaml`, or `plat project edit <id> --contract-path …` on an existing project);
  the import is refused without it.
- Two tickets that touch overlapping `modules` but do not depend on each other get an overlap warning. That is not an
  error: say so in the ticket if it is intended, otherwise add a `blocked_by`.
- Dependencies must not form a cycle, and a ticket cannot depend on itself.
- Acceptance lines should be testable through HTTP or the public interface: the pack marks a line `verified` only when
  the tests the agent named for it exist in the merge gate's JUnit report and passed.
