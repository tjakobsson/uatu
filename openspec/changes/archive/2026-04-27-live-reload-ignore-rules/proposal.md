## Why

The existing `.uatuignore` and `.gitignore` requirements describe what to filter
but not when filtering decisions are taken. In practice the matcher was cached
once at startup and never refreshed, so editing either file mid-session left
the tree out of sync with the user's rules until restart. The PR review for the
"view all non-binary files" branch flagged this as a behavioural gap, and the
fix has shipped — but the spec still doesn't pin the live-reload guarantee.

## What Changes

- Add a scenario to the existing `.uatuignore` requirement asserting that
  edits to the file mid-session take effect on the next refresh, in both
  directions (rule added → file disappears; rule removed → file reappears).
- Add the equivalent scenario to the existing `.gitignore` requirement.
- Tighten the requirement prose to explicitly state that filtering reflects
  the *current* contents of the file, not a startup snapshot.

No new capabilities. No breaking changes — this codifies behaviour the
implementation already provides.

## Capabilities

### New Capabilities
<!-- None -->

### Modified Capabilities
- `document-watch-browser`: tightens the `.uatuignore` and `.gitignore`
  filtering requirements with live-reload scenarios.

## Impact

- Spec only: `openspec/specs/document-watch-browser/spec.md`.
- Implementation already shipped on branch `view-all-non-binary-files`
  (`src/server.ts` evicts `matcherCache` on `.uatuignore`/`.gitignore` events).
- Coverage already exists: `src/server.test.ts` —
  "editing .uatuignore at runtime reapplies the new patterns".
