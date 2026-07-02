---
name: do-work
description: Land a piece of work end-to-end - plan, implement, drive the gates green, commit. Use for any coding task in this repo, feature or fix.
---

# Do work

Land one piece of work.
A change is not landed until it is committed with both gates green.

## 1. Plan

Before touching code, write the plan: what changes, file by file, and how each change will be proven.
Name things with the vocabulary in `CONTEXT.md` at the repo root - it is canonical for code, tests, and docs.
The plan is done when every change is named down to the file and each has a test or gate that will prove it.

## 2. Implement

Work the plan.
When the code teaches you the plan was wrong, revise the plan first and then keep building - never drift from it silently.
Implementation is done when every plan item is built and none was quietly dropped or deferred.

## 3. Gates

Two gates:

- `pnpm typecheck`
- `pnpm test`

Loop: run both, fix what is red, run both again.
Go green by fixing the code, never by weakening a gate - no skipped tests, loosened assertions, or suppressed type errors.
The gates are passed only when both are green in the same run against the final state of the code - a fix made after a green typecheck can break types again, so earlier passes count for nothing.

## 4. Commit

Commit the work as the final step.
The work is landed when the tree that passed the gates is exactly the tree committed, and `git status` is clean afterward.
