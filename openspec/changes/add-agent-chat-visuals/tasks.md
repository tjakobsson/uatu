# Tasks

This is a retrospective checklist. Checked items have focused verification;
they do not mean the feature has passed final review. The user approved these
artifacts on 2026-10-30 and implementation has resumed. Existing implementation
and safety stash are preserved; no feature commit or publication is implied.

## 1. Integration and approval

- [x] 1.1 Merge pinned upstream `71e4700` with a merge commit and restore feature work; verify merge `331661b`, a conflict-free restoration, and unchanged SHA-256 hashes for `visuals/curl-flow.*`.
- [x] 1.2 Obtain user approval of the proposal, capability delta, design, and tasks before resuming implementation; verify an explicit approval response.
- [x] 1.3 Obtain separate approval before refreshing dependencies or tools to the merged pins; verify Bun and installed SDK versions and a frozen-lockfile install without unintended manifest changes. Approved 2026-10-30: task-local Bun 1.4.3 verified against the release asset SHA-256; frozen restore supplies client 2.1.2 and leaves both manifest/lockfile hashes unchanged.
- [x] 1.4 Refresh the task-local runtime and dependencies for the 2026-11-08 rebase with separate approval: Bun 1.4.4 archive SHA-256 matches the GitHub release asset digest; the frozen restore supplies Claude SDK 0.3.316, OpenCode SDK 1.19.5 and client 2.2.5 without changing the upstream manifest or lockfile.

## 2. Markdown preparation and safety

- [x] 2.1 Finish token-origin attribution, including the independently reproduced `<image>` alias regression and original refused URL destinations in `visual-markdown.ts`; verify raw/Markdown tables, duplicate URLs, nested SVG fences, normalized tag aliases, refused references, and rendered snapshot/index mapping in colocated tests. Keep `docs/CHAT.md` aligned with supported syntax.
- [x] 2.2 Add bounded `fast-check` coverage through the full `renderChatMarkdown` output path, including hostile references, SVG source, and snapshot metadata; verify arbitrary inputs do not throw, output has no script-capable markup, and original external image URLs are not emitted as image requests.
- [x] 2.3 Separate assistant-visual count policy from user uploads and reuse it across capture, enrichment, rendering, and validation; verify typecheck and the chat/route/API unit suite pass with the shared limit.

## 3. Immutable snapshots and native identity

- [x] 3.1 Persist bounded first-capture records outside watched roots with atomic publication and missing-file completion retry; verify source mutation/deletion, restart, racing stores, pending/refused captures, four-reader admission, and persistence-failure recovery in `visual-store.test.ts`.
- [x] 3.2 Preserve workspace root, ignore, deny, traversal, symlink, and bounded-read protections; verify the reader-policy tests in `visual-store.test.ts` and authenticated preview/source tests in `chat-routes.test.ts`.
- [x] 3.3 Preserve Claude logical text-block identity through transient completion and native history reload; verify the real-normalization regression in `agents.test.ts` keeps PNG, safe SVG, and refused SVG IDs/bytes/source with exactly three initial reader calls. Independent scoped review found no residual Claude identity issue.
- [x] 3.4 Preserve native delta/replay boundaries while enriching references; verify existing history, replay, resync, split-syntax, and plain-text-delta regressions in `visual-store.test.ts`. Document immutable capture and completion retry in `docs/CHAT.md`.
- [x] 3.5 Persist bounded admission by stable logical occurrence rather than current rendered position; verify the eight-image table-reordering and late-reference cases never capture a ninth occurrence or evict earlier content, including reload, concurrent admission, refused slots, and native identity transitions for both agents. Complete the OpenCode cross-part admission correction authorized on 2026-11-02. Keep wire validation and rendering indexes coherent. As explicitly approved on 2026-11-02, remove legacy-priority compatibility for intermediate test builds while preserving existing stored files, IDs, and bytes.

## 4. Browser presentation and native guidance

- [x] 4.1 Present inline visuals, original SVG source/copy, graceful refusals, and in-chat enlargement; verify the visual/UI unit tests and all 35 focused visual/attachment browser tests, including viewBox-only desktop/touch sizing and reload persistence. Keep usage examples in `docs/CHAT.md`.
- [x] 4.2 Verify image decoding and streaming changes preserve reading anchors and follow intent when the reader is scrolled away; add any missing image-specific browser regression and record its result against the existing scroll contract.
- [x] 4.3 Inject guidance through Claude native context and child-scoped OpenCode instructions without replacing existing settings; verify guidance preparation/cleanup, inherited JSONC validation, startup/resume hooks, and environment tests. This establishes mocked/native-option behavior, not a new live-agent end-to-end claim.
- [x] 4.4 Verify invalid PNG/JPEG decoding and unavailable preview responses produce readable fallbacks that preserve references and retained SVG source, keep the reply usable, and never recapture on browser failure; add any missing browser/UI regressions and align failure guidance in `docs/CHAT.md`.
- [x] 4.5 Fix the focused-composer touch-Latest target shift approved on 2026-10-30; verify red-to-green real-pointer activation in focused and unfocused states, preserve keyboard/desktop behavior, and rerun image-anchor and existing touch-follow coverage.
- [ ] 4.6 Fix Codex's findings on `71f42427`: canonical watched-root matching, visual decoration in deferred Agent reports, and keyboard focus retention during streaming; reproduce each and verify affected regressions after integration.

## 5. Contracts and acceptance

- [ ] 5.1 Confirm Hub revision 14, workspace revision 36, web revision 4, closed visual-reference schemas, examples, API migration notes, and chat documentation agree after rebasing onto `1ab17f47`; rerun affected contract validation/compatibility checks and resolve any mismatch.
- [ ] 5.2 Resume independent Standards and Spec reviews in parallel using GPT-6.1 Sol high against `1ab17f47`, including new files; fix actionable findings, run affected checks, and repeat until both axes are clear. Renew review for affected fixes.
- [ ] 5.3 Run final relevant unit/property, browser, build, smoke, license, and dependency checks against the approved dependency/runtime state; distinguish new failures from reproduced baseline failures and report any unrun full-suite/live-agent checks.
- [ ] 5.4 Synchronize `chat-visuals` into main specs and archive this change only after acceptance; verify strict OpenSpec validation, clean diff whitespace, and preserved demo files before final merge/publication review.
- [ ] 5.5 After the review loop is clear, fetch and rebase onto latest `upstream/main` as requested on 2026-10-30; preserve feature/demo work, rerun affected checks, and renew affected independent reviews against the new target.
- [ ] 5.6 Create the draft PR now, as requested on 2026-11-02, before the final rebase/review is finished; review the full target diff and publication metadata, obtain PR-text approval, then push and publish through the approved routes and verify its draft status. Preserve draft status during subsequent updates.

## Historical checkpoint evidence (current status is tracked above)

- Post-integration: `bun run typecheck` passed; `bun test src/chat src/server/chat-routes.test.ts api/contract.test.ts` passed **1,685**, skipped **9**, failed **0**.
- Focused browser run: visual and attachment Playwright files passed **35** tests after the identity fixes.
- Independent Sol high scoped review passed **42** focused tests and **150** generated offset checks; it identified the low-severity `<image>` annotation regression tracked in task 2.1.
- On 2026-10-30, tasks 2.1/2.2 passed 52 parser/render/property/store tests, 550 bounded generated cases (750 full-render evaluations), and 30 service tests. The alias service regression failed before extending the capture precheck and passed after; typecheck and diff whitespace checks passed.
- Pinned contract checks passed API validation, baseline compatibility, and 79 contract tests. License checks passed for 597 installed packages.
- Publication blocker: audit reports high-severity GHSA-27r3-jxmh-p828 in upstream-locked body-parser 2.3.0. The user chose to keep feature scope rather than authorize a dependency patch. Leave task 5.3 incomplete and do not publish while this blocker is unresolved.
- The complete two-axis review loop has not yet reached a clean round.
- Resumed round 2: Standards found two low-severity heuristics (duplicate sanitizer policy and unused highlight option); Spec found secondary-watched-root capture outside the agent workspace and loss of refused URL destinations. The workspace boundary regression went red then green; 99 reader/service/route tests and typecheck passed. Parser findings remain in progress.
- Browser resilience handoff passed 246 focused unit tests and 41 visual/attachment browser tests; task 4.2 remains open while checking touch-pointer activation in the synthetic anchor scenario.
- Full pinned-runtime unit run: 5,181 passed, 16 skipped, 5 failed. Four credential-context failures pass all 28 tests with an unprojected tool PATH. The remaining macOS code-signing failure reproduces in isolation; it is unresolved. Build failed writing its executable with only 219 MiB free; smoke did not run. After removing this run's obsolete download archive, 248 MiB remained.
- Parser round-2 fixes passed 96 tests across seven focused files; chat safety properties now cover 650 generated cases / 950 renderer evaluations. Refused destinations survive in private metadata as inert fallback text, both pipelines share the sanitizer schema, and the unused highlight option is removed. Typecheck and whitespace checks passed; renewed independent review is pending.
- Scoped round 3 cleared the parser and workspace-boundary Spec findings and the two Standards heuristics. Standards requested historical status wording in proposal/design; those statements are now explicitly tied to the approval checkpoint. The pending touch-Latest fix still needs independent review.
- The approved touch-Latest fix passed red-to-green real focused-composer taps on Chromium/WebKit, 18 repeated browser checks (including six image-anchor runs), four existing cross-engine touch-follow cases, UI/anchor/scroll unit checks, typecheck, and whitespace checks. Focus, draft retention, and subsequent typing were verified; physical-device keyboard behavior remains untested. Fresh combined review is pending.
- Combined round 4: Standards reported zero findings; Spec found one medium cumulative-admission issue when mutable rendered ordering lets a ninth occurrence displace a previously captured eighth. Task 3.5 is in progress. Before that correction, the combined focused suite passed 1,701 tests (9 skipped) and the visual/attachment browser suite passed 45 tests; typecheck passed.
