---
id: T-cal
version: 1
title: originHost follows host-lib
repo: afk-platform
type: implementation
stories:
  - 14
modules:
  - packages/shared/src/origin-host.ts
---

## Parent

S-60

## What to build

Add `packages/shared/src/origin-host.ts` following `/refs/host-lib/origin-host.ts`. Do not substitute a different parser.

## Acceptance criteria

- [ ] originHost matches `/refs/host-lib/origin-host.ts` for ssh and https remotes
