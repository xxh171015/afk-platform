# S-60 Build notices through the shared notice service

## Problem Statement

Several teams send build notices. Each one formats and posts them in its own way, so the department cannot change the channel or the format in one place. The department already runs a shared notice service that every other system posts through.

## Solution

Add a `sendBuildNotice` helper that builds a notice from a finished build and sends it the same way the other systems do. Callers only pass the build; they do not know which channel the notice goes to.

## User Stories

1. As a developer, I want a finished build to produce one notice, so that the team hears about it once.
2. As a developer, I want the notice to carry the build id, the result and the link, so that I can open the build from it.
3. As a developer, I want a failed build's notice to say it failed, so that I do not have to open it to find out.
4. As an operator, I want build notices to go out the same way as every other system's notices, so that I can change the channel in one place.

## Implementation Decisions

- **Shape.** `sendBuildNotice(build, deps)` in `packages/shared/src/build-notice.ts`. `build` is `{ id, ok, url }`. The title is `Build <id> passed` or `Build <id> failed`; the body is the link.
- **Sending.** Notices go through the shared notice service, as the other systems do: `POST <noticeServiceUrl>/v1/notices` with `{ channel: "builds", title, body }`. The service owns the channel and its webhook. Do not post to a chat webhook from here.
- **Dependencies.** `deps` carries `fetch` and `noticeServiceUrl`, so tests pass a fake fetch.
- **Errors.** A non-2xx answer throws an error naming the status. No retries here.

## Testing Decisions

The seam is `sendBuildNotice` with a fake `fetch`: assert the request it makes and what it does with the answer. Do not test the notice service itself.

## Out of Scope

- Retries and batching.
- Who calls `sendBuildNotice`.
