# Hub Implementation Record

## Scope And Status

Completed and checked: **2.1, 2.2, 2.3, 2.4, 3.1, 3.2, 3.4, 7.1, 7.2,
7.3, 7.4, 7.5**. Task **3.3 remains unchecked**, with the blocker below.
Only section 2, 3, and 7 checkboxes were edited by this implementation owner.

Product edits are limited to `src/hub/pages.ts`, the new Hub presentation,
preference-delivery and Return modules, and `src/shell/hub-nav.ts`. No backend,
API schema, route, process-lifetime, or wire-contract change was made. No changes
were made to the parallel-owned tab bar, workspace stylesheet, index, app entry,
or Preview modules. Existing baseline tests/screenshots, `.local/`, and the
`fix-chat-send-button/` worktree were not modified. No commits were made.

## Integration Seams

- `shell/hub-nav.ts` exports `isHubAvailable(): boolean` (initially false) and
  `onHubAvailabilityChange(listener): () => void`. Detection remains the existing
  Hub-shaped base path plus authenticated root Hub probe. Subscription and
  validation do not gate boot. The selector's navigation destination remains `/`.
- `hub/return-navigation.ts` is a self-contained client factory shared by the
  workspace bundle and server-rendered Hub HTML. The browsing-session key is
  `uatu.hub.return.v1`, containing only version, workspace id, and the public
  current-device session handle, not tokens, labels, paths, or credentials.
- Return validation issues independent reads concurrently, with a three-second
  combined deadline including response-body reads. It does not abort a shared
  Hub-state refresh. Generation/authentication invalidation prevents old results
  from restoring a cleared hint. Hub pages retry through the five-second refresh
  cadence; activation revalidates an expired result. Missing registration,
  malformed records, session changes, unauthorized responses, and logout clear
  the hint. Copied sessionStorage is never sufficient by itself.
- `hub/navigation-preferences-client.ts` embeds the production
  `shell/navigation-preferences.ts` source with Bun's text loader and transpiles
  it into the existing inline Hub script. Settings therefore uses the same
  validation, defaults, key, getters/setters, and storage-event synchronization.
  No permanent serialization export or new asset/API route was necessary.
  `confirmNavigationHubScope()` is called only for authenticated Hub pages or
  confirmed workspace Hub detection. Controls use `side`, `position`, `autoHide`,
  and `previewSide`; the production Hub key is `uatu:navigation:v1:hub`.
- Assignment and tool drafts retain their owning form nodes across refreshes.
  Credential choices still refresh, without silently dropping a missing selected
  credential. Default editing initializes both roles; explicit new assignment
  is separately identified. Review cancellation restores input and focus.
- Unlock cancellation cannot continue a pending start/clone. Clone requests
  capture non-secret authorized choices before asynchronous unlock/refresh;
  duplicate submissions and stale streamed events are guarded. Existing secret
  and uploaded-source clearing remains in place. An early clone submission before
  the destination browser has loaded now preserves its draft and reports a
  contextual retry message without creating a job.
- Mobile rows retain actual shell/credential summaries, primary Open/Start, and
  disclosure-grouped secondary actions. Refresh preserves disclosure/focus by
  row identity. Desktop navigation, grouped Settings details, and native inset
  remain in their original presentation.

## Task 3.3 Blocker

The successfully initialized client handles Back/page-cache restoration, clears
opening UI, revalidates state, and asks the existing workspace route to render
stopped/missing recovery without issuing Start. Management of B does not retarget
the visit hint for A; Hub scroll hints remain numeric, page-local session data.

However, Back can interrupt workspace boot before its JavaScript finishes
loading. After that workspace stops, Forward can restore cached HTML with a
`pageshow.persisted === false` load, while the stopped proxy cannot serve its
uncached JavaScript. The page shows static workspace chrome and no document;
`initHubNav()` never runs. A handler inside `hub-nav.ts` cannot recover a document
whose bundle has not executed.

This was reproduced repeatedly in the real Chromium Hub fixture. The acceptance
case is retained as an explicit `test.fixme` named **Forward after interrupted
workspace boot must recover even when its JavaScript is unavailable**, in
`tests/e2e/hub-mobile-navigation.e2e.ts`, skipped in both focused browser projects.
The passing tests are not evidence that this case works.

Resolution requires approval to change the Hub document/cache policy or introduce
a pre-bundle recovery bootstrap through the relevant document owner. Those touch
the backend/document-delivery boundary or the parallel-owned index rather than
the assigned Hub client modules. No such change was made under the current
no-backend/wire-change and file-ownership constraints.

## Verification

- `bun run typecheck`: passed.
- `bun test ./src/hub/pages.test.ts ./src/hub/return-navigation.test.ts ./src/hub/mobile-presentation.test.ts ./src/shell/hub-nav.test.ts ./src/shared/app-url-discipline.test.ts`: 59 passed.
- `bun run test:e2e --config playwright.hub-mobile.config.ts --workers=1 --reporter=dot`: 26 passed, 2 explicitly skipped (the same task-3.3 blocker in Chromium and WebKit).
- After restoring desktop action spacing and preserving disclosure focus on
  refresh, `bun run test:e2e --config playwright.hub-mobile.config.ts --grep 'slow-opening' --workers=1 --reporter=line`: 2 passed.
- `bun run test:e2e tests/e2e/hub-mobile-baseline.e2e.ts --grep desktop --workers=1 --reporter=line`: 1 passed, repeated after the spacing correction. Baseline source and reference images were not changed. Dashboard and Settings captures were inspected against the recorded desktop references.
- `git diff --check`: passed.

The final clean-tool Hub/API regression invocation passed **267 tests across 10
files**, including existing directory/onboarding recovery, provider-token stop
ordering, clone ownership/prompt/replay/expiry/timer/outcome, and UI secret-clearing
coverage. These are layered tests: not every server failure is independently
re-created in a browser. New browser failure injection is local to the test client
and checks the real Hub state before/after the operation.

```sh
bun -e 'const env = {...process.env}; for (const key of Object.keys(env)) if (/^(GIT_CONFIG|GIT_SSH|GIT_ASKPASS|SSH_AUTH_SOCK)/.test(key)) delete env[key]; env.PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"; const child = Bun.spawn(["bun", "test", "./src/hub/pages.test.ts", "./src/hub/return-navigation.test.ts", "./src/hub/mobile-presentation.test.ts", "./src/shell/hub-nav.test.ts", "./src/shared/app-url-discipline.test.ts", "./src/hub/hub.integration.test.ts", "./src/hub/credential-api.integration.test.ts", "./src/hub/clone-jobs.test.ts", "./src/hub/clone-process.test.ts", "./src/hub/onboarding.test.ts", "--timeout", "30000"], {env, stdout: "inherit", stderr: "inherit"}); process.exit(await child.exited);'
```

An earlier combined run with Bun's default five-second test timeout had 264
passes and a Chat retry timeout, followed by a teardown-time 502. The isolated
rerun above passed without product changes. Earlier browser iterations exposed
test timing issues around native confirmation, SSH unlock latency, and observing
an opening overlay during pending document navigation; the final results above
are from the corrected, real-application tests.

The helper delivery test also bundles/minifies the Return and preference client
modules and executes their serialized output. This is not a claim that a full
compiled-binary build/smoke, full unit/E2E suite, audit, or license gate was run.
Those whole-change gates remain with the integrating owner.
