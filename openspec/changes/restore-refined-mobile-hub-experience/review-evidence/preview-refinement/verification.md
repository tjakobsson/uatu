# Preview examples and Hub control refinement

> Start with the [current evidence index](../README.md) and [current verification](../verification.md). Status and generated-artifact paths below are historical at pre-cleanup commit `373ef6350032f6a0f2a91c2037ebafb553bc002f`; they do not assert fresh passes or close pending gates.

2026-09-11. Verified isolated-review candidate; human approval pending.

The user approved richer synthetic preview content and Apple-aligned Hub controls
after seeing the impact summary and clarifying the workspace-interior boundary.
This is not visual approval of the implemented result or live integration approval.

## Design sources

- [Apple HIG: Buttons](https://developer.apple.com/design/human-interface-guidelines/buttons):
  recognizable controls; prominent accent-filled style for the most likely action;
  restrained primary hierarchy; style rather than size distinguishes related
  choices; clear labels, pressed feedback and adequate touch targets.
- [UIKit: UIContentUnavailableConfiguration](https://developer.apple.com/documentation/uikit/uicontentunavailableconfiguration):
  image, title and secondary-text composition for unavailable/empty content.

These inform Web-specific shared recipes, not a UIKit port. A verified empty
collection is distinct from loading/error. No-subfolders cannot mean no-files.

## Intended review paths

- Open Atlas or Notes → Files → examples → START-HERE.md. Follow Markdown and
  AsciiDoc links, compare Source/Rendered, view diagrams, tables and local images.
- Add Workspace → Create workspace → Cancel: Configure new workspace is the
  prominent action on the underlying Create Workspace page.
- Default Folder → Choose folder → Atlas → examples → guides: No subfolders
  explains that this picker hides files and Choose selects the current directory.
- `/review/design-system`: primary/secondary/destructive commands and composed
  empty states, alongside distinct loading/error examples.

## Scope boundary

Files/Preview/Chat/Terminal interior layouts and controls, workspace navigation
chrome, Hub↔workspace transitions, state retention and desktop presentation are
unchanged. Test-owned corpus and routes expand; actual renderers and clients are
used. No real workspaces, providers, credential tools, clone jobs or PTYs run.

Initial populated workspace folder fixtures mirror the examples. Empty lifecycle
fixtures remain empty; newly created/cloned synthetic workspace folder models keep
their operation-specific facts rather than pretending a read copied example files.
Their preview transport still uses the shared corpus. This is a simulation limit,
not a claim about live workspace contents.

## Current identity

- Product frontend asset fingerprint:
  `sha256:49845329baf12c14a8da54b584cfb43c3f6c8152189a10adda6c0dfcbbd7c239`.
- Independent reference (including guide):
  `sha256:3f0423af7bc88fb972af6e0553d8db50ec8fecc33c2f77489acb668e1d173a22`.
- Uncommitted refinement after `b7d51f7`, the previously requested fork checkpoint.
  Fingerprints identify served asset bytes, not Git cleanliness, live backend
  correctness, synthetic model state, or visual approval.
- Private review access details removed; local-only review instructions: `../handoff.md`.
  Use only simulation credentials **reviewer / review-only**.

## Verification

Final commands/results (not additive coverage claims):

1. `bun test src/hub/mobile tests/mobile-hub-review src/shell/navigation-cold-boot.test.ts src/shell/hub-nav.test.ts src/shell/navigation-preferences.test.ts`:
   **393 passed, 0 failed, 4851 assertions**.
2. `bun run typecheck` and
   `bunx --no-install tsc --noEmit --pretty false -p tests/mobile-hub-review/tsconfig.json`:
   **passed**. `git diff --check` and strict OpenSpec validation also pass.
3. `UATU_REVIEW_PICKER_EVIDENCE="openspec/changes/restore-refined-mobile-hub-experience/review-evidence/preview-refinement/folder-picker" UATU_REVIEW_PREVIEW_EVIDENCE="openspec/changes/restore-refined-mobile-hub-experience/review-evidence/preview-refinement/previews" bunx --no-install playwright test --config tests/mobile-hub-review/preview-refinement.config.ts`:
   **20 passed in 34.8s**, ten each Chromium/WebKit, no retries/skips. Includes
   actual Configure primary styling, portrait/short landscape/200% text, readonly
   picker/drafts/error recovery, real Files tree, Markdown/AsciiDoc links, images,
   Source/Rendered, lazy Mermaid and fullscreen zoom, direct Notes reload.
4. `bunx --no-install playwright test --config tests/mobile-hub-review/design-system.config.ts`:
   **3 passed in 4.8s**, Chromium reference fill/press/focus/target checks, local
   picker and task lifecycle/responsive examples.
5. `bun tests/e2e/folder-picker-layout.browser.ts`:
   **48 viewport/text/state/color combinations passed**, including the actual
   empty-state primitive, forced colors and reduced motion.
6. `bunx --no-install playwright test --config tests/mobile-hub-review/preview-boundary.config.ts`:
   **4 passed in 16.8s**, Chromium/WebKit all-four-surface Hub/Settings/Return and
   exact Chat draft/File plus terminal-transport retention. Uses unchanged
   continuity tests on disposable 4731, never the published reviewer.

`browser-results.json` and `boundary-results.json` retain native reports and
request probes. `previews/`, `folder-picker/` and top-level button/empty PNGs are
actual browser screenshots; earlier phase-14 captures remain separate. Lead
visually inspected WebKit Configure/No subfolders/AsciiDoc diagram/Files tree and
Chromium guide/table/image. Accessibility text/theme variants are explicit test
conditions, not hidden layout replacements. No pixel-golden approval is implied.

## Diagnosed failures, now repaired

The first cross-engine run passed 14 controls/picker cases but failed both first
preview cases, leaving four serial siblings unrun. Actual lazy Mermaid requests
received 501 because the reviewer omitted the installed library from its explicit
asset map. A focused HTTP regression reproduced 501 before repair; the server now
snapshots the same library production uses, with exact bytes/MIME and rejected
unknown/query/encoded variants. No dependency or workspace renderer was changed.

After that repair, the remaining timeout was a test assumption: Pierre compacts
`releases / 2026` into one tree row. The test now operates that real row rather
than waiting for a nonexistent ancestor. Independently reset tests no longer use
a serial group, and audit failures no longer mask the original interaction error.
The final complete run above passes with original timeouts and no retries.

## Remaining limits

This is desktop-hosted mobile browser emulation, not physical iPhone Safari,
VoiceOver or native Dynamic Type certification. Existing full-app matrix,
approved-golden and historical pre-change interior-proof gates remain open.
Repository status confirms no edits to workspace interior/chrome owners; scoped
continuity tests are not a substitute for every lifecycle/accessibility scenario.
Live operations, full diff/search/provider coverage and approval remain outside
this pass. No real backend rollout, spec sync, archive or new commit/push is implied.
