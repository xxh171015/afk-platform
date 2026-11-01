<!-- tracker-doc template for mattpocock/skills@59db609eb1e18aaf59b63284d0e52255aff0c63c -->
### Several repos

- One spec can change several repos; every ticket's `repo:` is the repo's name on the platform ({{REPOS}}).
- The contract belongs to the repo that provides it ({{CONTRACT_REPOS}}); a ticket that uses it writes
  `contract: <key of the contract ticket>`, and may do so across repos.
- To read another repo's code without changing it, a ticket writes `refs: [<repo>]`.
- An integration ticket is `type: integration`, lives in the consuming repo, lists the repos it needs in
  `environment: [<repo>]` (not its own), and is blocked by both sides' implementation tickets; its e2e is run by
  `npm run e2e`.
- Each repo's tickets only change that repo's `modules`; field names and interface shapes that cross repos go in the spec.
