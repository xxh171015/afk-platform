# Issue tracker: afk-platform (`plat`)

Specs and tickets for this repo live in the afk-platform, not in GitHub issues. Use the `plat` CLI for all operations.
`plat` is a command on this machine; run it from this repo, so file paths are relative to here. Add `--json` for
machine output.

This repo is the project's `backend` repo (`repo: backend` in a ticket file).

The platform has no labels and no comments. A draft spec is what a skill means by `ready-for-agent`: apply no label.

## Conventions

- **Read a spec** (what a skill means by "fetch the issue and read its body and comments"): `plat spec show S-7`. A
  spec has no comments.
- **Publish tickets** (to-tickets step 5). On this tracker publishing is four steps, in this order:
  1. Write one markdown file per ticket into a directory, e.g. `tickets/01-contract.md`, numbered in dependency order
     (format below).
  2. `plat tickets import S-7 tickets/`. The import is all or nothing and lists every problem at once; fix the files
     and run it again.
  3. Show the person the import's warnings exactly as printed (or say there were none), then ask once:
     "开工吗？" (start the work now?).
  4. If they say yes, run `plat spec confirm S-7`. Then tell them that from here they only wait for the acceptance
     pack, merge the pull requests, and look at `plat blocked`. If they say no, stop; they can confirm later in the
     platform's page.

  Confirming is the last step of publishing tickets on this tracker. It does not change the spec's body and does not
  close the spec, so it is **not** what a skill means by "modify a parent issue".
- **Fetch a ticket**: `plat ticket view T-8 --md`.
- **See what waits for a person**: `plat blocked`.

Numbers are global and never reused. Always use the number a command printed.

## Ticket file

Front matter holds the title and the platform's fields; after it comes the issue template exactly as to-tickets
writes it. The file name without `.md` is the ticket's key.

```markdown
---
title: 订单增加备注字段
repo: backend
type: implementation          # contract | implementation | integration
modules: ["src/orders/**", "test/**"]
blocked_by: [01-contract]     # keys of other files; these are the native blocking edges
---

## Parent

S-7

## What to build

...

## Acceptance criteria

- [ ] POST /orders 接受可选的 note，超长返回 400
```

- `## Parent` must be the spec being imported into.
- Blocking edges go only in `blocked_by`. Do not write a `## Blocked by` section: the import rejects it.
- Each acceptance line is a single `- [ ] ` line; the section holds nothing else.
- Every ticket needs at least one glob in `modules`.
