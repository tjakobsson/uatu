# UX audit follow-up (baseline 32e6d73)

## Independent review corrections
- [x] Preserve automatic/deliberate provenance consistently with the retained open state across conversation switches; unit and both-engine two-conversation regressions, followed by ordered final acceptance. Independent closure and latest evidence are recorded below.
- [x] First-touch Continue while composing (Chromium/WebKit).
- [x] Collapse automatic foreground-track expansion after detachment; preserve deliberate user selection.
- [x] Announce each successful mutation once, including repeated identical actions; suppress routine replay.
- [x] Restore shell confirmation focus to a surviving inspection control after settlement.
- [x] Distinguish duplicate-text and image-only dock actions with stable human-readable names.
- [x] Final CI → exact three browser suites → type/build/spec/diff, revised-state screenshot comparison.

Existing implementation tasks and their verification limitations remain unchanged.
Tests use existing UI/browser and normalization seams; test artifacts stay outside OpenSpec.

## Phase 1 — individual regression commits
- [x] Clear Continue feedback after parent/workers settle (browser regression red: action visible after settlement; green: 1/1).
- [x] Explain queued Send now waking paused steers; retain resume semantics (browser red: ambiguous Send now; green: confirmation cancel/accept and remaining queue; renderer 184/184).
- [x] Order terminal results after launchers without duplicating reports (agent/shell renderer cases red; 186/186 green; typecheck passes). Final source-shape review also reproduced native shell `command`-row ordering; its correction and realistic regression remain in the uncommitted follow-up.
- [x] Separate vertically adjacent worker Stop targets by at least 0.5rem (Chromium/WebKit touch red: 0px; green: 2/2 including existing target/gap/navigation assertions).
- [x] Diagnose and fix delayed Stop completion race without weakening assertions (red: 9/12 failures; probe: 409 before native dispatch; event-gated browser acknowledgement: 16/16 green). Harness settled before server admission; product correctly rejected an already-settled target. Existing success/result assertions retained and native-call assertion added.

## Phase 2 — pending dock
Renderer RED lacked the sticky counts/batch action; focused renderer and final browser acceptance pass.
- [x] Accessible targets, sticky counts, bounded height/overflow fade, delivery/paused badges and plain timing labels.
- [x] One paused-steer batch action, contextual accessible names, polite mutation feedback, visible focus, neutral delivery-race feedback and count-only Undo note.

## Phase 3 — composer
Browser RED expected current shortcut/title semantics but received the old delivery-only title. Contrast, menu/focus and compact-rail regressions pass in final acceptance.
- [x] Checked radio choices and current shortcut labels, accurate Send/selector names, contrast, compact non-steering rail and previous-focus Escape restoration.

## Phase 4 — background surface
Browser RED showed Continue with no blocker. Further UI RED exposed pending-tool and settled-foreground eligibility; the corrected gate excludes pending tools and confirmed detached/settled/uncertain worker launchers. Touch tap regression reproduced blur-induced layout movement and passed after focus-preserving activation. Native inspection labels had two RED cases before explicit Stop worker labels. Final acceptance passes.
- [x] Consistent rem/token controls, actual-blocker-only Continue with concise explanation, less duplicate touch presentation and explicit stop scopes; use established in-app shell confirmation if appropriate.

## Verification
- [x] `bun run test:ci` and all three requested browser suites pass.
- [x] Desktop/touch, light/dark screenshot comparisons reviewed.
- [x] Affected behavior documentation aligned; separate independent review is now closed for the findings recorded below, not inferred from self-review.

## Final verification — 2026-10-15

Logs are under the approved temporary `opencode/` directory. Checks completed in this order, against final product code:

| Check | Result / log |
| --- | --- |
| Documented clean-tool environment + `bun run test:ci` | **5,178 pass, 17 skip, 0 fail**, 285 files; `ux-verified-ci.log` |
| `bun run test:e2e -- tests/e2e/chat-steering.e2e.ts tests/e2e/chat-queue.e2e.ts tests/e2e/chat-opencode-background.e2e.ts` | **60 pass**, including Chromium/WebKit touch; `ux-verified-browser.log` |
| `bun run typecheck` / `bun run build` | Pass; `ux-verified-typecheck.log`, `ux-verified-build.log`; existing unsupported CSS `highlight` build warnings retained |
| Strict validation, both changes / `git diff --check` | Pass |

Browser environment only: test ports 26000/27000 avoid a preflight conflict on 20000; `UATU_E2E_SCREENSHOTS_DIR=/tmp/uatu-steering-ux-final` copies evidence to the user's requested temporary location. No test names an OpenSpec output directory.

Earlier aggregate CI had six timing failures in unchanged watcher/live-stream/credential tests under host load ~29. All affected files passed **63/63** in isolation; subsequent full CI runs passed without edits to those tests or authentication. The native cancelled-worker browser case also counted requests before admission; awaiting the actual acknowledgement preserved its exact-target/sibling assertions (**12/12** stress passes, `stop-ack-admission-green.log`). The new gated no-op test once remained at Requesting before acknowledgement; its probe passed **12/12**, and it now explicitly verifies the actual 200/accepted body and one native call before the unchanged feedback/no-invented-tasks assertions. All temporary debug logging was removed.

Additional RED evidence: `blocker-authority-red.log`, `settled-blocker-red.log`, `inspection-label-red.log`, `shell-launch-order-red.log`. Focused UI/renderer/inspection acceptance passed **216/216** (`ux-final-focused-green.log`); the final full suite includes the subsequent settled-blocker regression too.

### Screenshot comparison

Actual PNGs and JSON from `/tmp/uatu-steering-audit/` were read and visually compared with new `/tmp/uatu-steering-ux-final/` captures; this is a self-review, not independent validation.

| Surface | New evidence / observed delta |
| --- | --- |
| Desktop/touch dock, light/dark | `audit-dock-{desktop,touch}-{light,dark}.png` and matching metrics JSON: 36px desktop / 44px touch actions versus audited 12px; 399px scroll viewport at 1000px height versus 135px, visible sticky counts, leading badges and overflow fade |
| Composer, light/dark | `audit-composer-{desktop,touch}-{light,dark}.png`: explicit check/shortcuts instead of a default suffix; `audit-composer-enabled-dark.png` and `audit-enabled-send-dark-contrast.json`: **4.634:1** enabled Send contrast |
| Paused batch / narrow non-steering | `steering-paused-after-cancel.png`: one header batch action and separate Paused chips; `non-steering-busy-send.png`: settings/status/Send/Stop share one compact rail |
| Background desktop, light/dark | `audit-background-desktop-{light,dark}-{blocking,detached,settled}.png`: styled Continue with collapsed explanation, hidden after detachment, no accepted banner after settlement, launcher-before-result order |
| Native-engine touch, light/dark | `audit-background-{chromium,webkit}-touch-{light,dark}-{running,settled}.png`: collapsed duplicate subagent track, explicit Stop worker/Stop parent, separated vertical targets and preserved settled inspection |

At this checkpoint, phases 2–4 and the source-shaped shell ordering correction remained uncommitted for independent lead review; the later closure below supersedes that pending-review status. Original completed-task evidence is retained. No new paid/native-provider validation, real-device keyboard/assistive-technology acceptance, configuration changes, existing-hub actions, or publication were performed.

## Independent-review correction evidence — 2026-10-16

The review's `ux-independent-review-{unit,e2e,browser,focus,touch}.log` and both duplicate-track PNGs were read and retained unchanged. New logs below are in the same approved temporary `opencode/` root. All five phase-1 commits remain intact; HEAD is still `cb30797`, with no new commits.

| Finding | RED → GREEN evidence |
| --- | --- |
| First-touch Continue blurred/reflowed before activation | `ux-review-firsttouch-red.log`: both engines sent zero background requests. Focus-preserving mousedown activation: `ux-review-firsttouch-green.log`, **2/2 pass**, exactly one call plus retained draft/focus. |
| Automatic foreground expansion survived detachment | `ux-review-disclosure-unit-red.log`: no collapse verdict; browser RED: **2 automatic cases failed**, both deliberate cases already passed. Provenance-aware disclosure: **10 unit / 4 browser pass**, `ux-review-disclosure-green.log`; late programmatic toggle echoes stay distinct from user reopening. |
| Identical mutation successes were text-deduplicated | `ux-review-announcement-red.log`: two removals produced one update. `ux-review-announcement-green.log`: **1 pass**, two successes produce exactly two live updates; subsequent worker paint produces none. Explicit mutation events bypass text-only deduplication once, routine paints do not. |
| Settlement removed shell confirmation invoker | `ux-review-confirm-focus-red.log`: **3 focus failures** (desktop and both touch engines). Capture actual pointer invoker, then restore surviving same-inspection result/Back/timeline before composer: `ux-review-confirm-focus-green.log`, **3/3 pass**, inspection stays open and zero shell removals. Initial focus-only correction passed Chromium but failed WebKit; explicit invoker capture resolved WebKit's non-focusing pointer activation. |
| Duplicate/image-only action names collided | Renderer RED had four controls but two names; browser RED confirmed that collision. Client-local pending numbers retained through live-entry changes: **188 renderer / 1 browser pass**, `ux-review-unique-labels-green.log`, `ux-review-unique-labels-browser-green.log`. State is retained only for live entries, not unbounded tombstones. |

Final checks ran against the corrected implementation in the required order:

- Documented clean-tool environment + `bun run test:ci`: **5,181 pass, 17 skip, 0 fail** across 285 files — `ux-review-final-ci.log`.
- Exact requested `bun run test:e2e -- tests/e2e/chat-steering.e2e.ts tests/e2e/chat-queue.e2e.ts tests/e2e/chat-opencode-background.e2e.ts`: **71 pass** — `ux-review-final-browser.log`. Test-only ports 26000/27000 and screenshot-copy environment as before; no existing hubs touched.
- Typecheck/build pass — `ux-review-final-typecheck.log`, `ux-review-final-build.log`. Existing CSS `highlight` warnings remain.
- Both strict OpenSpec validations and `git diff --check` pass. Focused four-module unit check: **227 pass**, `ux-review-focused-unit.log`.

New screenshots/JSON are in `/tmp/uatu-steering-ux-review/`. Actual before/after PNGs were compared: the automatic duplicate track now collapses (`review-detached-automatic-{chromium,webkit}.png`), deliberate expansion remains (`review-detached-deliberate-{chromium,webkit}.png`), and first-touch Continue preserves the composing draft (`review-continue-first-touch-{chromium,webkit}.png`). `review-shell-confirmation-focus-{desktop,chromium,webkit}.png` shows the surviving result action's focus ring in the still-open inspection. `review-unique-pending-actions.json` records four distinct labels and an unchanged surviving pending-message number after removal; the matching PNG retains normal dock presentation. Final captures were read after the final suite, not inferred from test success.

At this checkpoint, documentation/design/specs covered these refined interactions, and this correction pass was self-verification, not independent re-review or real-device assistive-technology validation. Work remained uncommitted for the lead's review; the later independent closure below supersedes that pending status. No installation, paid prompt, configuration/authentication write, existing-hub operation, push or PR action occurred.

## Current mobile acceptance and independent closure — 2026-10-16

This section supersedes earlier pending-review and aggregate-CI blocker states, not the historical checks/counts above. The lead confirms that independent Sol High re-review closes the two mobile P2s, with **244 focused unit passes** and fresh Chromium/WebKit browser verification. Directly inspected `uatu-independent-mobile-final/results.json` corroborates actual-panel budgeting, loaded hardware-keyboard space, keyboard/pan geometry and twelve anchor/bottom-pin cycles. This is independent evidence, distinct from the implementation checks below.

- [x] Cross-conversation disclosure provenance: unit RED (`ux-rereview-switch-unit-red.log`) → **12 pass**; both-engine RED → **6 focused browser pass** (`ux-rereview-switch-browser-green-recheck.log`). Final four-file acceptance includes A→B detachment, B-only dispatch and A worker survival. Independent closure confirmed by the lead.
- [x] Outside delivery-menu touch consumes underlying activation; portrait/landscape hard limits, keyboard counts/batch/replacement safety, touch Enter, safe insets, visible parent-stop scope, contained scrolling and touch target/rail behavior covered by `chat-mobile-layout.e2e.ts` in final acceptance.
- [x] Desktop height P2: six long pending messages clipped Send/Stop at 600/480px before correction. `mobile-review-budget-red.log` → `mobile-review-budget-green.log`: **six budget cases pass** across both engines, including hardware below. Actual measured panel height replaces the 60rem fallback; independent checks also use a **520px panel inside a 720px window**, yielding a **208px** queue budget.
- [x] Loaded hardware-keyboard P2: **250–251px** transcript before correction versus **343–344px** after (>40% of 844px), with a **202.55px** aggregate dock and **183.56px** composer retaining the 34px bottom inset. Independent fresh measurements agree. Closed/non-editing tracks share a 35% visual-height cap (tablet 25%); hardware editing uses 24%, rather than separately allocating each track.
- [x] Animated bottom-pin race: clean browser acceptance initially had **120 pass / 1 fail**, 142px from bottom; bounded isolated checks and `mobile-pin-trace-red.log` reproduced it. Traces show animated layout resizing interleaving native clamps and prompt-echo removal. Reserving final height before a 160ms visual reveal preserves layout; reduced motion skips the reveal. `mobile-pin-reservation-green.log`: **18/18** repeated motion/anchor cases pass without relaxed assertions. Independent twelve cycles retain **40.171875px** anchors and finish at **0px** bottom distance, with constant layout height during reveal.
- [x] Pointer-Revert concern investigated, not asserted as a proven regression: click/tap/keyboard at 667/844px, both engines, repeat twice → **24/24 pass** (`mobile-review-revert-recheck.log`), exactly one successful request each. The first new probe's incorrect queue-Edit concatenation expectation was corrected to existing history-Revert replacement semantics; no additional product fix was made for this concern.
- [x] OpenSpec descriptions, designs, proposals and task evidence now match device keys, compact visibility, measured budgets and reduced motion. Test artifacts and screenshots remain outside OpenSpec.
- [x] Physical-device acceptance disposition: supplementary checks of actual iOS/Android keyboards/animations, autocorrect, rubber-banding, assistive technology and Dynamic Type are not required at @addiberra's request in the [2026-10-31 archive direction](https://github.com/tjakobsson/uatu/pull/571#issuecomment-6542184300). These checks remain unverified, not passed. Simulated visualViewport/safe-area browser checks and the later compact-chat user-reported iPhone acceptance do not establish this broader coverage.

### Ordered implementation acceptance

Logs below are in the approved temporary `opencode/` root. `CLAUDE.md` documents projected-tool isolation: inherited PATH selected a projected Git wrapper; a clean PATH selected `/opt/homebrew/bin/git`. No credential values were logged and no authentication/configuration or test timeouts were changed to obtain passing CI.

| Ordered check | Actual result / evidence |
| --- | --- |
| `env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin TMPDIR="$TMPDIR" bun run test:ci` | **5,183 pass, 17 skip, 0 fail**, 285 files; `mobile-review-final-ci.log` |
| Same clean environment plus test ports 26000/27000: `bun run test:e2e -- tests/e2e/chat-steering.e2e.ts tests/e2e/chat-queue.e2e.ts tests/e2e/chat-opencode-background.e2e.ts tests/e2e/chat-mobile-layout.e2e.ts` | **139 pass** (73 existing + 66 mobile); `mobile-review-final-browser.log` |
| Clean `bun run typecheck` / `bun run build` | Pass; `mobile-review-final-typecheck.log`, `mobile-review-final-build.log`; existing CSS `highlight` warnings remain |
| Strict validation of both changes / `git diff --check` | Pass after implementation and for this documentation-only parity change |

The previously failing narrow-root observer test passed in clean full CI and in a bounded isolated run (**1 pass**, `mobile-clean-observer-isolated.log`); no observer code was changed. Earlier inherited-environment credential failures and watcher timeouts remain historical evidence, not current acceptance failures or proof of their full causes.

Actual screenshots were compared with `/tmp/uatu-mobile-audit/` and `uatu-independent-mobile/` evidence. Final captures/metrics are `/tmp/uatu-mobile-review-final/review-{chromium,webkit}-desktop-{600,480}.{png,json}`, `review-{chromium,webkit}-hardware-budget.{png,json}` and `review-{chromium,webkit}-bottom-pinned-no-preference.png`, with `mobile-*-reading-anchor-*.json`. A screenshot-capture-only addition to the existing anchor cases subsequently passed **4/4** (`mobile-review-pin-screenshots.log`); positioning assertions were unchanged. Fixture text/delivery selection differs, so these are state/geometry comparisons, not pixel-identical baselines. Independent final PNGs/JSON remain under `uatu-independent-mobile-final/`; none are copied into OpenSpec.

Five phase-1 commits remain preserved at HEAD `cb30797`; later implementation remains uncommitted. This parity update makes no product edits, native-provider calls, existing-hub operations, configuration/authentication writes, installation or publication. Independent implementation findings are closed as reported; publication and the physical-device gap are not implicitly approved.

## Archive disposition (2026-10-31)

The earlier uncommitted/publication status above is historical; implementation was merged in [PR #519](https://github.com/tjakobsson/uatu/pull/519). [@addiberra explicitly requested archival](https://github.com/tjakobsson/uatu/pull/571#issuecomment-6542184300), with supplementary physical-device checks recorded as not required and remaining testing limitations retained. No additional audit or follow-up audit issue is required. This disposition closes the acceptance checklist without claiming that the unperformed device checks passed.
