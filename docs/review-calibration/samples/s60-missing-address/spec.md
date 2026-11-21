# S-60 Project webhook

## Problem Statement

Review calibration needs a public-repo sample where implement kept the specified approach and only lacked an external address.

## Solution

`notifyProject` POSTs JSON to the project's Feishu webhook. The webhook URL is an external address, not something stored in this repository.

## User Stories

14. As a 平台维护人, I want notifyProject to POST to the project webhook, so that a missing URL is only a missing address.

## Implementation Decisions

**webhook.** Add `packages/api/src/notify/project-webhook.ts` with `notifyProject(body)` that POSTs JSON to the project's Feishu webhook URL. The URL itself is an external address for the project; do not invent a host or path. Leaving the URL empty when it is not in this repository is the same approach, not a substitute.
