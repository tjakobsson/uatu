# Creation exit, Security hierarchy and preview sibling recovery

2026-09-11. Verified isolated-review candidate. Human approval remains pending.

Before implementation, committed and pushed **b5d5f30** to
`fork/design/hub-mobile-navigation`, preserving unrelated local changes and raw
diagnostics. The new correction is a separate, uncommitted refinement.

## User-visible changes

- Creation Cancel returns to Add Workspace, not an unnecessary configure landing
  page. Picker Cancel and review Back retain the creation draft; loading Cancel
  rejects late reads. History follows the same task ownership and safe base route.
- Devices has one entry inside Session Security, with an actual session count.
  Direct device routes remain supported; contextual Back goes to Session Security.
- Preview index recovery uses fresh synthetic HTTP/SSE snapshot timestamps.
  Previous/Next uses the existing format-independent same-directory selector.
  The operations folder now includes Markdown, TypeScript, SVG, plain text,
  AsciiDoc and binary files to exercise the actual renderers/fallbacks.

## Diagnosis and boundary

The published index already contained both AsciiDoc siblings. The reviewer reused
`FIXTURE_TIME` for every snapshot; after a channel reset the real reconciler
correctly rejected it as stale and stayed in index-error. The new HTTP/reconciler
regression was red (`ready` expected, `index-error` received) before monotonic
snapshot generation repaired it. File mtimes remain fixed; reset does not rewind
the snapshot watermark. No missing-endpoint workaround, markdown-only fallback,
error suppression, live backend adapter or workspace visual redesign was added.

The coordinator's nested-task history correction preserves an editor restored by
Back as a live task entry, so its next Back exits to the correct base instead of
skipping Add Workspace. Hub/workspace mounted-instance ownership is unchanged.

Direct image reload testing found a second, product-level defect: initial boot
explicitly rejected indexed binary files. `src/shell/boot.ts` now accepts those
explicit URLs and lets the existing document loader choose image or binary
fallback. Unknown paths and default/follow selection semantics remain unchanged.
No workspace layout or control was redesigned.

The synthetic raw-image route also needed exact Accept negotiation after images
became indexed documents. It now reuses production `prefersHtmlNavigation()`:
HTML navigation serves the workspace shell; embedded-image requests serve SVG;
the real viewer uses the canonical document-resource endpoint. Query/encoded/POST
variants remain rejected. Red HTTP and real-browser tests preceded both repairs.

## Current identity

- Frontend asset fingerprint:
  `sha256:dc2b6253b6434c9bb194ef49e58ccbfff7c2080f64da27acb96199db3177b996`.
- Independent reference (including guide):
  `sha256:1aedc5d3e794349e4bcafb05309e303ea3dfff1185dfd1894104ff7f3e10f55b`.
- Uncommitted correction after the requested **b5d5f30** checkpoint. Fingerprints
  identify asset bytes, not a clean Git revision, model state or human approval.
- Private review access details removed; local-only review instructions: `../handoff.md`.
  Simulation login **reviewer / review-only**; never enter real credentials.

## Final verification

- `bun test src/hub/mobile tests/mobile-hub-review src/preview/file-siblings.test.ts src/preview/file-navigation.test.ts src/shell/boot-stamp.test.ts src/shell/navigation-cold-boot.test.ts src/shell/hub-nav.test.ts src/shell/navigation-preferences.test.ts`:
  **437 passed, 0 failed, 5151 assertions**.
- `bun run typecheck` and
  `bunx --no-install tsc --noEmit --pretty false -p tests/mobile-hub-review/tsconfig.json`:
  **passed**. Whitespace and strict OpenSpec validation pass.
- `UATU_REVIEW_PICKER_EVIDENCE="openspec/changes/restore-refined-mobile-hub-experience/review-evidence/navigation-recovery/folder-picker" UATU_REVIEW_PREVIEW_EVIDENCE="openspec/changes/restore-refined-mobile-hub-experience/review-evidence/navigation-recovery/previews" UATU_REVIEW_HUB_EVIDENCE="openspec/changes/restore-refined-mobile-hub-experience/review-evidence/navigation-recovery/" bunx --no-install playwright test --config tests/mobile-hub-review/navigation-recovery.config.ts`:
  **48 passed**, Chromium/WebKit, ~1.2 minutes, no retries/skips. Covers creation
  visible/history cancellation, nested drafts, late reads, Security/Devices,
  actual preview examples, seven mixed-format siblings, resume/Retry, boundaries,
  and direct image/binary load/reload. Native report: `browser-results.json`.
- `PLAYWRIGHT_JSON_OUTPUT_NAME="$PWD/openspec/changes/restore-refined-mobile-hub-experience/review-evidence/navigation-recovery/production-results.json" bunx --no-install playwright test --config playwright.config.ts tests/e2e/preview-file-navigation.e2e.ts --workers=1 --reporter=list,json --retries=0 --output=tests/mobile-hub-review/evidence/navigation-production-results`:
  **9 passed in 47.3s**, Chromium, using the normal per-worker E2E server and its
  test-owned files. Covers explicit encoded image/binary URLs, mixed siblings,
  retry/failure, duplicate roots, layout, Chat draft and terminal continuity.
  This separate regression harness uses a test PTY; the published reviewer remains
  entirely synthetic. No live Hub, personal workspace, credential or provider was used.
- `PLAYWRIGHT_JSON_OUTPUT_NAME="$PWD/openspec/changes/restore-refined-mobile-hub-experience/review-evidence/navigation-recovery/boundary-results.json" bunx --no-install playwright test --config tests/mobile-hub-review/preview-boundary.config.ts --reporter=list,json --output=tests/mobile-hub-review/evidence/navigation-boundary-results`:
  **4 passed in 18.8s**, Chromium/WebKit, retained all-four-surface workspace
  identity and exact Chat draft/File plus terminal transport across Hub/Settings.
  Absolute report path avoids config-relative duplicate directories.

## Evidence and review limits

Screenshots show actual browser output, not approved goldens. Lead inspected
WebKit Session Security and recovered AsciiDoc preview; both arrows are enabled
and the stale-index warning is absent after recovery. Prior phase-15 evidence is
retained separately. Error screenshots intentionally exercise transport failure
and show the warning; they are not a claim the final recovery still fails.

The initial broad run had **42 passes, 2 direct-image failures**. Those failures
exposed the boot exclusion; expanded red testing confirmed three binary paths in
both engines failed despite their presence in the actual index. Six targeted
cases and the final 48-case run pass after repair, without larger timeouts, retries
or a format-filter workaround. Unit fixture updates reflect text/code rendering
and Security's new device-count read, without weakening transport rejection tests.

All browser results are local browser emulation, not physical iPhone/VoiceOver
certification. Existing full-app/golden/historical-interior and user-approval gates
remain open. No dependency installation, new live backend integration, spec sync,
archive or second commit/push is implied by publishing this correction.
