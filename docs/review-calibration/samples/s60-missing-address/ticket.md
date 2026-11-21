---
id: T-cal
version: 1
title: notifyProject posts to the project webhook
repo: afk-platform
type: implementation
stories:
  - 14
modules:
  - packages/api/src/notify/project-webhook.ts
---

## Parent

S-60

## What to build

Add `notifyProject` that POSTs JSON to the project's Feishu webhook URL. The URL is an external address, not in this repository.

## Acceptance criteria

- [ ] notifyProject POSTs JSON to the project's Feishu webhook URL
