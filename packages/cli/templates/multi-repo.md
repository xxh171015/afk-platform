<!-- tracker-doc template for mattpocock/skills@4ae2317ddb22b046e26455e4f9c9b3aaaf62212d -->
### Several repos

- One spec can change several repos; every ticket's `repo:` is the repo's name on the platform ({{REPOS}}).
- The contract belongs to the repo that provides it ({{CONTRACT_REPOS}}); a ticket that uses it writes
  `contract: <key of the contract ticket>`, and may do so across repos.
- To read another repo's code without changing it, a ticket writes `refs: [<repo>]`.
- Each repo's tickets only change that repo's `modules`; field names and interface shapes that cross repos go in the spec.
