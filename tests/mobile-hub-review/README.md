# Isolated mobile Hub reviewer

**Mock backend; do not enter real credentials.** The actual mobile frontend and
workspace clients run against test-owned protocols. This is not live-backend
correctness, visual approval or authorization to expose a remote endpoint.

## Start and inspect

```sh
bun tests/mobile-hub-review/manage.ts start
bun tests/mobile-hub-review/manage.ts status
bun tests/mobile-hub-review/manage.ts reset
bun tests/mobile-hub-review/manage.ts stop
```

Startup is local-only on `127.0.0.1:4703` by default and refuses an occupied port.
The manager verifies process/instance/build ownership before lifecycle operations.
Do not reset/stop another owner or replace a stale record. Unconfigured restart
preserves the verified existing port and optional origin; remote origin settings
are explicit runtime configuration, never committed private addresses. See
[hosting.md](hosting.md) for exact lifecycle and security rules.

Routes:

- `/`: actual Hub viewport
- `/review/controller`: separate simulation controls
- `/review/design-system`: interactive examples using actual product primitives
- `/review/evidence`: fixed 20-image gallery and current verification/known issues
- `/s/atlas/README.md`: actual workspace clients

Open **Atlas → Files → examples → START-HERE.md** for linked Markdown/AsciiDoc,
local images, diagrams, tables and code. `examples/operations/` has mixed-format
siblings for Previous/Next, including an image and a binary fallback. Notes uses
the same example corpus after synthetic Start. The reference's folder chooser is
the actual read-only picker with a static local tree, not another mock UI.

## Maintainable checks and local capture output

```sh
bun test src/hub/mobile tests/mobile-hub-review
bunx --no-install tsc --noEmit --pretty false -p tests/mobile-hub-review/tsconfig.json
bunx --no-install playwright test --config tests/mobile-hub-review/navigation-recovery.config.ts
bunx --no-install playwright test --config tests/mobile-hub-review/preview-boundary.config.ts
bunx --no-install playwright test --config tests/mobile-hub-review/design-system.config.ts
bunx --no-install playwright test --config tests/mobile-hub-review/compact-gallery.config.ts
```

These focused browser configurations own disposable test ports, not the published
reviewer. Run one suite at a time against shared fixtures. The older top-level
`playwright.mobile-hub-review.config.ts` expects port 4703 and must not run while
the interactive reviewer owns it; it includes historical/opt-in workflows and is
not a claim of a currently complete full-app matrix.

Generated screenshots and native JSON reports stay in ignored local outputs:
`results/artifacts/`, ordinary Playwright output directories, or legacy `evidence/`
run directories. Responsive history copies also remain local. No raw report or
screenshot is automatically promoted or approved.

The explicitly reviewed promotion command updates only the 20 named gallery files:

```sh
UATU_PROMOTE_COMPACT_GALLERY=1 bunx --no-install playwright test --config tests/mobile-hub-review/compact-gallery.config.ts
```

Inspect those images and update the compact verification record before committing.
Raw JSON can contain personal paths and is not publication-safe by default.
`privacy.test.ts` checks the actual compact public package and access documentation;
`artifact-output.test.ts` guards raw reporter destinations. Other explicit output
overrides remain available for deliberate diagnostics, not routine publication.

## Assembly and controls

`startReviewServer({ port?, assets?, evidenceAssets? })` bundles the real
`src/index.html` graph with `browser-entry.ts` as its test entry. The mobile Hub
and resident workspace share one document. `transport.ts` has an explicit typed
`MobileHubBackend` operation allowlist backed by the same server-side fixture;
there is no second browser model. Invalidations/clone events use SSE and the real
xterm client consumes a synthetic WebSocket protocol, not an executable shell.

The controller offers nine scenarios and bounded typed controls for pending,
failure, reset, tools/credentials, devices, folder/onboarding outcomes, clone jobs,
uploads and stream output. Use accepted job IDs from synthetic public state.
See [backend-guide.md](backend-guide.md) for exact controls and protocol limitations.

No live cookies/Authorization are consumed or forwarded. Unknown routes/operations
fail closed; only explicit assets are served, with no request-selected filesystem
read, CORS proxy or fallback to a live Hub. Reset changes only synthetic state.

## Current package and unresolved work

The active change's [review guide](../../openspec/changes/restore-refined-mobile-hub-experience/review-evidence/README.md)
and [verification/known issues](../../openspec/changes/restore-refined-mobile-hub-experience/review-evidence/verification.md)
are the current entry points. Canonical visual references, baseline fixtures,
behavioral tests and useful written findings remain. Older generated report trees
and archive-rendering scripts are available in Git history, not required to start
the reviewer. The product design-system guide is
[`design/hub-mobile/design-system.md`](../../design/hub-mobile/design-system.md).

Retained diagnostic tools remain explicitly diagnostic. Isolation tools compare
the unchanged canonical references/baselines and write local output. The historical
drawer-era visual runner remains opt-in rather than being mistaken for current
golden coverage. Legacy evidence-copy utilities require their original local
source captures and fail if absent; they cannot reconstruct old UI states.

Visual approval, approved goldens, the complete current app matrix, physical-device
accessibility and live integration remain open. No cleanup or passing capture
automatically completes those gates.
