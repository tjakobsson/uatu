## Context

The persistent permission choice is already transported as `approved-session`
and mapped to OpenCode's `always` reply. See `proposal.md` for the measured
scope and lifetime that the current user-facing label fails to communicate.

## Goals / Non-Goals

**Goals:**
- Make the persistent choice and its consequences clear before selection.
- Preserve the existing API and provider behavior.

**Non-Goals:**
- Rename the `approved-session` wire value or change permission handling.
- Add confirmation, revocation, or pattern-display features.

## Decisions

Keep `approved-session` as the wire value and change only the rendered label,
scope text, and supporting styles. Renaming the wire value was rejected because
it would create a breaking API change without changing provider behavior.

## Risks / Trade-offs

- [Internal and user-facing names differ] -> Keep tests around both the visible
  wording and the unchanged `approved-session` to prevent accidental drift.
