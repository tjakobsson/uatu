# Web design-system reference examples

Canonical route: **`/review/design-system`**. The trailing slash redirects to
that route (308). The mock controller links here; product Settings does not.
This is a test-owned catalog, not another product surface or live-backend test.

## Example policy

- Import actual product `design-system.ts` primitives, `flow-ui.ts` advisory /
  dismissal / contextual error behavior, `createTaskView`, and mobile
  `styles.css` (which imports `tokens.css`). Do not copy control CSS or override
  tokens to make a screenshot pass. Catalog CSS owns only page/grid geometry
  and declares the existing licensed Hack Nerd Font Mono font file.
- Facts, long paths, positive/warning status, destination/object rows, actions,
  danger, labeled text/password/disabled/invalid fields, select, independent
  green switches and mutually exclusive radios are all represented. Review
  shows Current / After / Effect in a full-page region with Apply locally.
  Navigation opens read-only full-page details with Back and no commit or fields.
  Only Remove example opens a centered confirmation; there is no More action
  or duplicate editor/confirmation launch. The immediate local action updates
  status without opening a task, alongside a disabled action example.
  All presentations use the actual task owner, not screenshots or replicas.
- Input and choice changes stay in the DOM. Apply/confirm only completes a
  local demonstration; it never reports a real Save. Pending becomes a local
  simulated error after 700 ms. No example imports a backend client or issues
  HTTP mutations. Use dummy values, never real secrets.
- Credential notice dismissal uses a random `design-system-example:<uuid>`
  identity and immediately removes its storage key after the real dismissal
  recipe executes. It never uses the reviewer's identity.
- No initial autofocus. Task entry uses the actual heading/safe-Cancel focus
  policy; the test owner wires cancel/Escape, pending guard, background inertness
  and trigger restoration. OS dark mode, increased contrast and reduced motion
  use the product media queries. No fake product appearance preference exists.

## Build / HTTP API boundary

`buildDesignSystemAssets(): Promise<ReviewAssets>` uses a separate Bun HTML
entry and `/review/design-system/` public path. Its only allowed outputs are
explicitly mapped HTML, JS, CSS and WOFF2 files; there is no directory listing,
source map, repository static fallback or request-derived file read.

`startReviewServer({ designSystemAssets?: ReviewAssets, ... })` accepts that map
independently from workspace `assets`. Normal server startup builds both;
callers supplying fake workspace assets omit the reference build unless they
also supply a reference map. Tests can therefore use port 0 and tiny maps.

GET on the canonical route returns the mapped `design-system.html`. Exact GET
asset names below its prefix are served from the reference map only. Unknown
reference names, non-GET methods and workspace-prefixed reference routes fail.
Existing host/origin checks, query/encoding restrictions, CSP and no-store
headers remain authoritative. Unknown unrelated routes retain the existing
501 contract failure.

Workspace `/review/health.version` remains the fingerprint of **workspace
assets only**. Reference assets never alter it and never enter the workspace
viewport bundle. Reference JS/CSS/font names use Bun's content naming; HTML
and all responses are no-store. GET `/review/design-system/manifest.json`
exposes `{ kind: "reference-content-sha256", fingerprint }`, independently
computed over the reference build map before adding the manifest itself.
This is reference content identity, not a second product version claim.

## Verification

```sh
bun test tests/mobile-hub-review/design-system.test.ts tests/mobile-hub-review/server.test.ts
bunx --no-install playwright test --config tests/mobile-hub-review/design-system.config.ts
bunx --no-install tsc --noEmit -p tests/mobile-hub-review/tsconfig.json
```

The one Chromium test starts its own Bun listener on port 0; it never uses
4703. It checks all families, drafts/switch/radio interaction, full viewport
editor geometry at 390×844, real confirmation focus trapping and Escape,
pending/error, isolated dismissal, no mutations, and no horizontal overflow
at 320×568, short dark 390×400, and dark 390×844 with 200% root text sizing.
It additionally proves navigation and review are regions (not alert dialogs),
details have Back without fields/commit, review applies locally, and Remove
cancels through both Escape and Cancel. It captures both detail pages, the
full-page review, confirmation and the three responsive views in Playwright's
`evidence/design-system-results` output (generated evidence, not source).

Remaining native gaps: no Safari/WebKit run, physical iOS keyboard/safe-area
validation, VoiceOver audit, native increased-contrast verification, or native
browser zoom test. 200% root sizing is a text enlargement check, not a claim
of 200% browser zoom parity. These examples are Web, not UIKit.
