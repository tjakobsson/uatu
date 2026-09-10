# Implementation Record

## Resumed Integration

The user approved all prerequisite corrections listed below. Implementation
resumed, was interrupted mid-flight, and has since been reconciled and verified.

30/42 tasks are checked. Sections 3.3, 4.3, 5.1 and all of 6 are complete
and verified; Hub presentation/Return/form work, the touch overlay and Preview
sibling navigation are all present. This is not yet a completed or release-ready
change: sections 8 and 9 remain. See
`hub-implementation.md` for focused Hub coverage.

### Interruption and reconciliation

The resumed work was written but never verified as a whole — the agents doing it
stopped on a usage limit before reporting. The code was therefore treated as
unverified on pickup and re-established from evidence rather than trusted. Two
real regressions surfaced and were fixed (see Reconciliation findings), and one
pre-existing accessibility defect was found and fixed with explicit approval.

The integrating owner connected `navigationWorkspaceReady()` to the existing
`loadInitialState` readiness callback in `src/app.ts`. After integration:

- `bun run typecheck`: passed.
- `bun run test:e2e tests/e2e/navigation-overlay.e2e.ts --workers=1 --reporter=dot`: all 16 passed.
- `git diff --check`: passed.

Task 4.3 is now checked: the Preview control group exists, and
`preview-file-navigation.e2e.ts:123` verifies it clears the selector without
overlapping it. Whole-change build/smoke, audit/licenses, complete test suites,
documentation and fresh final review remain outstanding.

Implementation had paused for approval of the prerequisite corrections below
rather than silently weakening the requirements. All four were approved and are
now resolved — see Prerequisite Correction Status:

1. Image URLs in `src/preview/image.ts` do not carry root identity; the static
   fallback resolves the first matching watched root. Duplicate relative image
   paths can therefore display the wrong image. Root-qualified resolution needs
   review against the no-server/wire-change boundary before section 6 proceeds.
2. `src/shell/history.ts` restores by relative path rather than stored document
   identity and excludes binary destinations. A narrow history-owner correction
   is required for exact-root image Back/Forward acceptance.
3. Interrupted workspace boot followed by stop and Forward can restore cached
   HTML without an available JavaScript bundle. Client-only Hub navigation cannot
   recover before it executes; document-cache policy or an early recovery hook
   needs approval. The regression is explicitly skipped, not counted as passing.
4. Denying all localStorage access exposes the existing unguarded Terminal storage
   fallback in `src/terminal/panel.ts`. New preference-specific storage failures
   are handled, but whole-workspace storage-denial acceptance needs a narrow
   existing-owner fix.

## Prerequisite Correction Status

The approved corrections above have landed. A session interruption during the
resumed work meant the code was written but never verified as a whole, so the
integrated state was reconciled afterwards:

1. **Root-qualified images — done.** `src/preview/image.ts` now requests
   `/api/document/resource?id=&rootId=`. `documentResourceResponse` in
   `src/server/static-files.ts` requires an exact single root and document
   match, refuses to widen a file pin, rejects non-images with 415, and
   rechecks ignore rules plus realpath containment. Ordinary relative-path
   static links are unchanged.
2. **History identity — done.** `src/shell/history.ts` records and restores the
   stored `documentId`, treats a recorded identity as authoritative even when
   the target disappeared, and never substitutes a same-named file from another
   root.
3. **Interrupted-boot recovery — done.** `src/hub/proxy.ts` serves workspace
   HTML as `no-store` and strips conditional-request headers for document
   navigations, so a stopped or forgotten workspace cannot be restored from
   cache before its bundle executes. The previously skipped regressions in
   `tests/e2e/hub-mobile-navigation.e2e.ts` are active.
4. **Storage denial — done.** The correction belongs to the storage owner, not
   the Terminal: `src/shell/presentation-storage.ts` previously guarded only the
   `window.localStorage` *getter*, leaving every caller exposed when the
   storage *methods* throw. Each operation now degrades to a client-local
   fallback shared per underlying store and workspace prefix, reads fall through
   to it when a denied write shadowed a working read, and key enumeration unions
   both. Workspace-scoped keys and PTY/credential policy are unchanged.

### Reconciliation findings

Verifying the unverified work surfaced two real regressions, both fixed:

- The proxy's `no-store` upgrade contradicted a `toBe("no-cache")` assertion in
  `src/hub/hub.integration.test.ts`. `openspec/specs/client-freshness/spec.md`
  requires `no-cache` **or stricter**, so the assertion was stricter than the
  capability it guards. It now accepts either value and states why the upgrade
  exists, preserving the revalidation guarantee.
- `workspaceGetDocumentResource` was documented in `api/openapi.yaml` without
  black-box coverage, failing the "every documented HTTP operation was
  black-box validated" gate. The hub fixture now indexes a real PNG, and the
  operation is asserted for success bytes/headers plus the 400, 404,
  foreign-root and non-image paths. The response also declared an `image/*`
  range that the contract harness cannot match, so the concrete media types it
  actually serves are now enumerated.

Verification after reconciliation:

- `bun run typecheck`: passed.
- `bun run api:validate`: passed with the pre-existing WorkspaceConflict warning.
- `bun test ./src/hub/hub.integration.test.ts`: 77 passed, 0 failed.
- `bun test ./src/shell/presentation-storage.test.ts`: 7 passed, including four
  new storage-denial cases.

No public API behavior beyond the documented additive resource operation, no
backend lifecycle change, and no spec sync, archive, commit, or PR has been made.
Unrelated `.local/` and nested worktree contents remain untouched.


## Verified State

Commands were run from a Hub-managed workspace; the four `credential-projection`
failures in a plain `bun test ./src/` run are the nested-projection artifact
`CLAUDE.md` describes, not regressions. Rerun in a clean tool environment
(`credential-runtime` off PATH, inherited `GIT_CONFIG*`/`GIT_SSH*`/`GIT_ASKPASS`/
`SSH_AUTH_SOCK` unset) `src/hub/credential-context.test.ts` is 28 passed. No
product behavior was changed to accommodate the nesting.

| Check | Result |
| --- | --- |
| `bun run typecheck` | passed |
| `bun run api:validate` | passed (pre-existing WorkspaceConflict warning) |
| `bun test ./src/` | 2826 passed, 10 skipped, 4 environment-artifact failures |
| `bun test ./src/hub/hub.integration.test.ts` | 77 passed |
| `bun test ./src/shell/presentation-storage.test.ts` | 7 passed |
| `test:e2e preview-file-navigation + navigation-overlay` | 38 passed |
| `test:e2e hub-mobile-{navigation,forms,lifecycle}` | 22 passed |
| `test:e2e mobile + ipad + touch-scroll + chat-touch` | 36 passed, 19 failed (all pre-existing; see below) |

The design realignment changed no failure count in the touch suites: the same
19 pre-existing failures remain, and the suites went from 35 to 36 passing. The
one regression the realignment did introduce — `chat-touch.e2e.ts` asserting a
bare `.touch-tab-label` list, which the new Hub destination also matches — was
found and fixed by scoping that assertion to `[role=tab]`.

### Pre-existing enlarged-text defect (fixed with approval)

`preview-file-navigation.e2e.ts:123` could not pass for a reason unrelated to
this change. At 200% text in a 320px viewport `#view-control` and
`.uatu-layout-toolbar` measured 339px wide. Both were `inline-flex` with no
wrapping and no width cap, so they forced a 373px minimum page width; Chromium
answered by zooming the page to 0.858, which re-resolved every `position: fixed`
overlay against a 373px containing block and pinned the Preview controls to
x=365. Neither rule is touched by this change, so the fix — `flex-wrap: wrap`
plus `max-width: 100%` on both — was approved as added scope before being made.
The zoom-out disappears, and the overlay's own measurement code was left on its
original visual-viewport basis, which is correct once the page is not zoomed.

A tab-bar `max-width` cap was tried during this investigation and reverted: it
changed no measured outcome, and the bar's 374px width at a 390px viewport is
the intended floating-pill inset, not an overflow.

### Design-reference alignment

The implementation had drifted from the approved reference in
`design/hub-mobile/screenshots-refined/`. Realigning it was prioritised over
finishing section 8. Before/after captures are in `design-gap/`.

| Aspect | Reference | Was | Now |
| --- | --- | --- | --- |
| Bar layout | One row: close, Hub, four surfaces | Two rows; `Preferences` row above the tabs | One row; `.navigation-surfaces` uses `display: contents` so the tablist keeps its role while its tabs join the bar's flex row |
| Hub item | Icon + label, first-class | Bare hidden text link | Icon + label, styled as the other destinations |
| Preferences | Not in the bar; a sheet from Hub → Settings | `Preferences` button opening a centred dialog | Button removed; sheet restyled as a bottom sheet with grabber, grouped controls and explanatory copy |
| Preview controls | Pill: folder icon + `Files` │ `‹` `›` | Wide text buttons `Back to Files` `Previous` `Next` | Pill matching the reference |
| Error state | Amber card above the pill with a `Retry` link | `Retry` button and status text inside the pill | Separate `.preview-nav-alert` card above the pill, toned `error` or `progress` |

The reference also settles a task 8.3 question: `10-terminal-expanded.png`
shows the bar floating over a full-height Terminal, so overlaying rather than
reserving a gutter is correct and `mobile.e2e.ts:291` is a stale assertion.

**Standalone preferences.** The reference reaches preferences through
Hub → Settings, which does not exist when uatu runs without a hub, while task
5.1 requires a reachable standalone path. Resolved with the user: hold the
navigation handle (500ms) to open the same sheet. `contextmenu` and the
`ContextMenu`/`Shift+F10` keys are equivalent routes so the affordance is not
pointer-only, and `#navigation-handle-help` documents it for screen readers.
The Hub Settings page already carried the same four controls, so no Hub-side
change was needed and the bar is now identical in both modes.

Accessible names were kept stable through the redesign: the Files control shows
`Files` but is named `Back to Files`, which contains the visible label, so
existing assertions and label-in-name both hold.

### Section 8 resolution

The 19 stale touch failures are resolved, and the full suite surfaced a further
set that the four-suite slice had hidden. Causes, and what each needed:

| Cause | Count | Resolution |
| --- | --- | --- |
| Tab clicked while the bar had idled away (it is `inert` when closed) | ~30 | `tests/e2e/navigation-helpers.ts`: `keepNavigationOpen()` pins the bar for suites that do not own the idle policy, `showSurface()` reopens it where they do |
| Superseded bar geometry (full-bleed width, reserved gutter, 4-button count) | 2 | Assertions updated to the approved design: inset pill, overlay, four tabs plus close |
| `#navigation-preferences` button removed by the design realignment | 2 | `openNavigationPreferences()` drives the real 500ms press |
| Keystrokes sent before a fresh PTY drew its prompt | 3 | A shared `waitForPrompt()` gate in `mobile.e2e.ts`, and the same gate in `navigation-overlay.e2e.ts` |
| Floating controls intercepting pointer events on content beneath them | 3 | Dismiss the navigation, or activate the target from the keyboard, where the obstruction is incidental to the assertion |

Two were real product defects rather than stale tests:

1. **Reveals landed under the floating bar.** `.app-shell` no longer reserves a
   gutter (correct per the design), so a find match in the last screenful had no
   scroll runway to lift it clear. `src/shell/tab-bar.ts` now publishes the
   covered height as `--navigation-occluded` and the scrollports consume it as
   `scroll-padding-bottom` — reveals stay clear without reintroducing the gutter.
2. **Back to a deleted document reported the wrong thing.** The approved history
   correction had added a branch that loaded a vanished identity, turning
   "Document not found" into "File unavailable". The branch was both redundant
   and harmful: the anti-substitution guarantee is already delivered where a
   recorded id is resolved by id alone and never by path. Removed;
   `url-routing.e2e.ts` and the duplicate-root identity test both pass.

A known consequence of the design, recorded rather than worked around: while the
bar is open it occludes and intercepts a strip of the surface beneath it, and the
Preview controls do the same at the bottom-left. Auto-hide is the mitigation for
the bar; the Preview pill is persistent by design.

### Task 6.2 closed

Previous/Next, Back to Files, reserved-character image URLs, duplicate-root
identity, history and Follow Rule A were already verified in
`preview-file-navigation.e2e.ts`. The remaining clause — *preservation of
Chat/Terminal resources during in-page selection* — is now covered by two
tests in the same file. Both step forward through two siblings and back to the
starting document, then re-enter the other surface:

- *in-page selection preserves an unsent Chat draft and its conversation*: the
  unsent draft is still in the composer afterwards.
- *in-page selection preserves the Terminal PTY and its output*: the pane keeps
  the same `data-session-id` and its scrollback still holds the command output,
  so selection neither reloaded the workspace nor reattached a new session.

Both surfaces sit behind the workspace token cookie, so the tests establish it
via `/?t=<token>` before navigating, and skip when the backend is unavailable.
`preview-file-navigation.e2e.ts`: 8 passed.

Writing them surfaced a test-authoring trap worth recording: a closed navigation
bar fades to `opacity: 0` rather than unmounting, and Playwright still reports
it visible. Gating a reopen on `isVisible()` silently does nothing and the tab
click is then intercepted by whatever sits above it. Gate on
`data-open="true"` instead, as `navigation-overlay.e2e.ts` does.

## Baseline

Implementation authorized by the user on 2026-09-08. After `git fetch origin main`,
local and remote main are `b697458f08b1cc1208836cd2db99a3d6f58b4216`, already an
ancestor of branch HEAD `0ba1dad3e96dc7ac8a81f8f820a5e0d9488ffd69`. No rebase is
needed. The nested `fix-chat-send-button/` worktree is preserved.

- `bun run typecheck`: passed.
- `bun run test:api`: 348 passed (Bun substring discovery also includes matching nested-worktree tests).
- `bun run api:validate`: passed with the existing WorkspaceConflict single-item allOf warning.
- Scoped clean-tool unit baseline: 2,136 passed, 8 skipped, no failures.
- `bun run test:e2e --workers=1 tests/e2e/desktop-inset.e2e.ts tests/e2e/mobile.e2e.ts tests/e2e/ipad.e2e.ts tests/e2e/chat-touch.e2e.ts`: 54 passed.
- `bun run test:e2e tests/e2e/hub-mobile-baseline.e2e.ts --workers=1`: 2 passed. Screenshots and limits are recorded in `tests/e2e/hub-mobile-baselines/README.md`.

The first unit invocation used substring paths, discovered the nested worktree,
and timed out. Credential tests also discovered projected Git/SSH wrappers.
The successful rerun used explicit `./src/` directory arguments, removed
credential-runtime PATH entries and inherited GIT_CONFIG*, GIT_SSH*, GIT_ASKPASS,
and SSH_AUTH_SOCK only in the spawned test environment. No product credential
behavior or Git configuration was changed.

## Final Validation (section 9)

| Gate | Command | Result |
| --- | --- | --- |
| 9.1 | `bun run typecheck` | passed |
| 9.1 | `bun audit --audit-level=moderate` | no vulnerabilities (670 packages) |
| 9.2 | `bun test ./src/` (clean tool env) | 2830 passed, 10 skipped, 0 failed |
| 9.2 | `bun run test:api` | 348 passed |
| 9.2 | `bun run api:validate` | valid (pre-existing WorkspaceConflict warning) |
| 9.3 | `bun run check:licenses` | 583 packages audited |
| 9.3 | `bun run build` + `bun run smoke` | binary built; smoke passed |
| 9.4 | `bunx playwright test --retries=2` | 4 failed, 10 flaky, rest passed |
| 9.4 | `bun run test:e2e:mobile` (Chromium + WebKit) | 75 passed |
| 9.4 | `bun run test:e2e:hub-mobile` (Chromium + WebKit) | 44 passed |

The unit suite must be run with a clean tool environment when developing inside
a Hub-managed workspace, or four `credential-projection` tests discover Uatu's
own projected Git/SSH wrappers. Drop `credential-runtime` from `PATH` and unset
the inherited `GIT_CONFIG*`, `GIT_SSH*`, `GIT_ASKPASS` and `SSH_AUTH_SOCK` for
the run only; no product behavior was changed to accommodate the nesting.

**On the four remaining e2e failures.** All four —
`chat-responsiveness.e2e.ts:144`, `mermaid.e2e.ts:121`, `outline.e2e.ts:61` and
`outline.e2e.ts:173` — pass in isolation (43/43 for those three files together),
and the failing set differs between runs. They are the parallel-worker
contention the repository already documents in `playwright.config.ts`, which is
why CI runs `retries: 2`. They are not regressions from this change: none is in
a touch surface, and the one plausible link — `scroll-padding-bottom` — was
measured inert on desktop (`--navigation-occluded: 0px`,
`scroll-padding-bottom: 0px`). The runs above were taken on a machine that had
been running back-to-back 30-minute suites, which inflates the flake rate.

**9.3 exclusion check.** `dist/uatu` contains the strings `hub-mobile` and
`__e2e`, both benign: the first is the `hub-mobile-*` CSS class family in the
Hub's own pages plus the build metadata's branch name, and the second is the
shared route table's e2e branch, which `deps.mode === "prod"` never selects.
Verified against the built binary: `/__e2e/reset`, `/__e2e/terminal-token` and
`/__e2e/chat` all return 404 while `/api/state` returns 200. No design fixture,
prototype page, or mock service is present.

**9.5 documentation.** `ARCHITECTURE.md` gains a *Touch navigation* section
(bar contents, overlay/no-gutter model, idle policy, preference scopes, the
occlusion contract and its two consequences). `CLAUDE.md`'s folder map now
names the four surfaces, `navigation-preferences`, and
`preview/file-navigation`. `docs/SELF-HOSTING.md` gains user-facing Day-2 notes
for the mobile navigation, where preferences live and their device scope, and
that Return validates the session without changing workspace lifetimes. All
examples use production routes; nothing implies the prototype iframe or a
live-client guarantee.

## Implementation Review (task 9.6)

A fresh review at `high` effort over the working-tree diff (~1,700 lines) raised
five findings; all five are fixed and re-verified.

| Finding | Fix |
| --- | --- |
| `preview/image.ts` — a failed image load left the *previous* document mounted under the new document's identity, and desktop surfaced nothing (the recovery card is touch-only) | Decode failure now renders an explicit unavailable state for the destination before rethrowing, so every mode shows the failure instead of the wrong file |
| `hub/return-navigation.ts` — `validate()` opened with `suspend()`, so the 5s poll blanked the Return control and reflowed the bottom navigation on every tick | Split `cancelInFlight()` out of `suspend()`: a refresh supersedes the in-flight attempt but keeps the verified result on screen. A negative outcome still withholds |
| `shell/tab-bar.ts` — the collapsed edge handle painted on top of the expanded bar on first frame, because only `show()` writes `data-expanded` and `onUiModeChange` does not fire on subscribe | The handle's expanded state is initialized at the end of setup |
| `shell/presentation-storage.ts` — a quota-denied write was shadowed by the stale persisted value, silently reverting the update. My own test only covered keys absent from the real store | `getItem` consults the fallback first: it only ever holds values whose durable write was denied, and a successful write clears it. Regression test added for the shadowing case |
| `hub/pages.ts` — the Return poll ran on desktop, where the control is `display: none`, costing two authenticated round-trips every five seconds | The interval skips when the control is not laid out |

Fixing the handle's first-paint state exposed a real consequence of the chosen
standalone route: the design shows no handle while the bar is expanded, so a
long press can only reach the sheet from the collapsed state. That is coherent —
the handle is the persistent affordance — but it means reaching preferences
standalone is *dismiss, then hold*. The helpers and the affected tests now model
that sequence rather than depending on the handle wrongly painting over an open
bar.

Re-verification after the review fixes: `bun run typecheck` clean;
`bun test ./src/` 2831 passed, 0 failed (clean tool env);
`test:e2e navigation-overlay + preview-file-navigation + base-path + mobile +
hub-mobile-navigation + hub-mobile-lifecycle` 89 passed.

## Release And Review Metadata

Prepared per `CONTRIBUTING.md`; **commit, PR creation, and merge remain
separately authorized and have not been performed.**

**Proposed squash title**

```text
feat(mobile): navigate Hub and workspace surfaces on touch devices
```

`feat` is correct: users of the latest stable tag (`v0.6.2`) have none of this
UI, so the stable-to-stable delta is a new capability, and the minor bump it
produces matches that. No `!` — nothing here removes or repurposes an existing
affordance on desktop, and no wire contract changed incompatibly.

**No Release Please override is needed.** The corrections made while
stabilizing this work — the redundant history branch, the media-type range, the
over-strict cache assertion — only stabilize functionality introduced *after*
`v0.6.2` inside this same change, and they are squashed into the feature commit
rather than landing as separate `fix` PRs. The override in `CLAUDE.md` applies
to a separate `fix` PR against unreleased work, which this is not.

**One judgment for the reviewer.** The branch also carries fixes to behavior
that *does* exist in `v0.6.2`, bundled here because the mobile work exposed
them:

- `src/shell/presentation-storage.ts` — storage whose *methods* throw broke
  every caller, not just the Terminal.
- `#view-control` / `.uatu-layout-toolbar` — 200% text overflowed a 320px
  viewport, zooming the whole page out.
- `src/shell/history.ts` — Back/Forward resolved by relative path, so a
  duplicate path in another root could restore the wrong document.
- `src/hub/proxy.ts` — workspace HTML could be restored from cache after a
  stop, before its bundle could execute.

A single `feat` entry will not mention them. If those corrections should reach
stable users as visible `fix` notes, they want splitting into their own PRs
ahead of this one; otherwise this body should state that the feature commit
carries them. That is a maintainer decision, not one to settle silently.

**Additive API surface**: `workspaceGetDocumentResource`
(`GET /s/{workspaceId}/api/document/resource`), documented in
`api/openapi.yaml` and `api/CHANGELOG.md`, black-box covered in
`src/hub/hub.integration.test.ts`. No existing operation changed shape.

## D9 Coverage Inventory

Existing tests establish baseline coverage; new cases below remain implementation
acceptance work, not completed verification.

| Area | Existing test ownership | Required new regression cases |
| --- | --- | --- |
| Desktop/mode | desktop-inset.e2e, ipad.e2e | Overlay mode normalization, saved placement under zoom/rotation; Hub screenshots |
| Hub identity/history | shell/hub-nav.test, url-routing.e2e, hub-mobile-baseline.e2e | A/B management versus Return identity, BFCache, stale/copied/session-bound hints and bounded validation |
| Authentication | hub/hub.integration.test, hub/credential-api.integration.test | Browser revocation/logout during Return validation, no stale metadata |
| Native/PWA | hub/hub.integration.test, shell/hub-nav.test, base-path.e2e | Real main-frame logout navigation and Hub manifest assertions; no claim of Keychain runtime verification |
| Workspace lifecycle | hub/sessions.test, hub/hub.integration.test, hub-mobile-baseline.e2e | Slow opening, repeated starts, no-assignment cancel, unlock continuation, stop/forget partial failures |
| Folders/onboarding | hub/hub.integration.test, hub/onboarding.test, hub/pages.test | Touch folder operations, nested stopping, consent, default-parent and retained-path recovery |
| Credential types | hub/credential-ssh.integration.test, hub/openpgp-credentials.test, hub/token-credentials.test, hub-mobile-baseline.e2e | Browser capability matrix including SSH, OpenPGP, provider/HTTPS tokens; no external-provider authentication claim |
| Assignments/tools | hub/credential-api.integration.test, hub/credential-tools.test | Untouched defaults, role/host intent, review cancellation, failed stop preserving catalog |
| Secrets | hub/pages.test, hub/credential-ssh.integration.test, hub/clone-jobs.test | Actual browser upload/paste limits and clearing; inspect new storage; retain nonsecret drafts |
| Clone | hub/clone-jobs.test, hub/clone-process.test, hub/hub.integration.test | Browser replay/prompt/cancel/unlock and authoritative outcome variants; preserve configured stopped registration on start failure |
| Workspace surfaces | mobile.e2e, sidebar.e2e, project-search.e2e, find.e2e, Follow/compare/Git Log suites | Four tabs, separate Hub action, no duplicate surfaces or activity-driven promotion |
| Preview | preview-renderers.e2e, document-tree.e2e, files-pane-filter.e2e, manual-selection.e2e | Exact sibling scope/order, mixed kinds, pins, Changed filter, failures/timeouts/exact-target retry |
| Chat | chat-touch.e2e, chat-attachments.e2e, chat-queue.e2e, inventory/request/recovery suites | Overlay attention, pending uploads/queues across in-page switching; unchanged full-document lifecycle |
| Terminal | mobile.e2e, terminal-persistence.e2e, terminal-session-manager.e2e | Real Hub PTY identity across navigation, no implicit takeover, exact input delivery, unavailable backend |
| Accessibility/persistence | ipad.e2e, chat-touch.e2e, shell/presentation-storage.test, personal-state.e2e | Chromium/WebKit viewport/text/theme/preference matrix, timer/focus/drag behavior, narrow preference sync |
