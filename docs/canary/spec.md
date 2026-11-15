# Canary: write a stamp

A fixed improvement the platform runs against itself after an upgrade, so token usage, decisions and gate test names are recorded once before real work starts.

## Problem Statement

There is no small, repeatable spec that proves the main path still writes token usage, implement decisions and gate test names.

## Solution

One implementation ticket overwrites `docs/canary/stamp.txt` with a datetime stamp unique to this run.

## User Stories

1. As a platform maintainer, I want a canary ticket that only writes a stamp into docs/canary/stamp.txt, so that each upgrade run has a real change to implement without touching product code.

## Implementation Decisions

- Only `docs/canary/stamp.txt` changes. The stamp is the datetime string in the ticket body.

## Testing Decisions

- Test at the file contents: after the ticket, `docs/canary/stamp.txt` is exactly the stamp string. Seam: the public file in this repo.

## Out of Scope

- Opening a pull request (the canary script cancels before that unless asked).
