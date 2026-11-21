---
id: T-cal
version: 1
title: sendBuildNotice builds and sends a build notice
repo: afk-platform
type: implementation
stories:
  - 1
  - 2
  - 3
modules:
  - packages/shared/src/build-notice.ts
---

## Parent

S-60

## What to build

`sendBuildNotice(build, deps)` turns a finished build into one notice (title from the id and the result, body the link) and sends it like the other systems' notices.

## Acceptance criteria

- [ ] A passed build sends one notice titled `Build <id> passed` whose body is the build link
- [ ] A failed build sends one notice titled `Build <id> failed`
- [ ] A non-2xx answer throws an error naming the status
