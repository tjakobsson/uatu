# Add project identity

## Why

Running several uatu instances side by side — one per project, which the sandboxed-container workflow makes routine — produces browser tabs that are visually identical ([issue #101](https://github.com/tjakobsson/uatu/issues/101)) and app windows with no fixed marker saying which project they show ([issue #102](https://github.com/tjakobsson/uatu/issues/102)). The title is a hardcoded `uatu`, there is no favicon, and the in-app chrome renders the same brand block for every project, so the user's eyes have nothing to lock onto.

## What Changes

- **Tab title**: `document.title` becomes `<project> — uatu`, where the project label is the single root's label, or `<first-label> +N` when the session watches multiple roots. Derived client-side from the `StatePayload.roots` the client already receives — no server changes.
- **Per-project favicon**: a favicon is introduced (there is none today), tinted with a hue derived from a stable hash of the session's root paths, so tabs are distinguishable by color before text. Injected as a dynamic SVG `link rel="icon"` at boot.
- **In-app marker**: the repository name already shown in the Change Overview pane becomes a badge tinted with the same hue as the favicon, so the tab color and the in-app marker reinforce each other. A tooltip carries the full root path(s). The brand block stays untouched.

## Capabilities

### New Capabilities

- `project-identity`: how a uatu session derives its project label and identity hue, and where they surface (tab title, favicon, sidebar marker).

### Modified Capabilities

None — no existing spec's requirements change. (`sidebar-shell` covers pane chrome, not how the Change Overview names repositories; the badge is a new concern owned by the new capability.)

## Impact

- New `src/shell/identity.ts` (+ colocated test): pure helpers for label derivation, hue hashing, favicon SVG, title string; one `applyProjectIdentity(roots)` entry point.
- `src/shell/boot.ts` / `src/shell/events.ts`: apply identity when a state payload lands (idempotent, re-applied on refresh).
- `src/sidebar/change-overview.ts` + `src/styles.css`: the repository-name badge and its styling.
- No server, API, or `.uatu.json` changes. PWA manifest naming/icons are explicitly out of scope (noted in design).
