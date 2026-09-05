## 1. Establish regression evidence

- [x] 1.1 Add deterministic text and Markdown reproductions for Follow-off selection during unrelated edits, temporary removal and return, and delayed preview responses; verify the failing cases identify selection, preview identity, and URL, and record whether they reproduce issue #339's generic symptom.
- [x] 1.2 Exercise scan overlap with controlled scan/repository completion and tree refresh with the real selection callback path; verify whether each suspected mechanism can cause stale publication or unintended navigation and record the outcome before changing those paths.

## 2. Preserve the selected destination

- [x] 2.1 Separate retention of a Follow-off destination from current index membership and non-binary Follow eligibility; verify text, image, classification-change, and empty-index cases retain selection while Follow-on catch-up still passes.
- [x] 2.2 Add a named unavailable presentation and same-path recovery for a retained destination; verify deletion, replacement, exposure-rule removal, return without changedId, and navigation elsewhere preserve the specified URL and content behavior.
- [x] 2.3 Audit preview and commit load completion guards and fix uncovered stale writes; verify gated A-to-B responses and document-to-commit navigation cannot overwrite newer preview content or chrome.
- [x] 2.4 Audit tree selection callbacks against genuine activation and fix any reproduced programmatic navigation; verify refresh/filter callbacks preserve selection and a subsequent pointer or keyboard activation still works.

## 3. Order workspace refreshes

- [x] 3.1 Serialize scan and repository collection with a coalesced pending refresh while retaining idle debounce and maximum-wait behavior; verify one refresh executes at a time and events arriving in flight converge to the final index.
- [x] 3.2 Preserve the last complete snapshot on refresh failure and cancel pending publication at shutdown; verify controlled failure, retry, sustained churn, and stop-during-scan tests pass without partial or post-stop publication.
- [x] 3.3 Verify HTTP snapshots and concurrent scoped SSE subscribers observe ordered complete refresh results, retained later events, and existing keepalive/cancellation behavior using watcher integration tests.

## 4. Validate the complete navigation behavior

- [x] 4.1 Add browser regressions in desktop and touch layouts for text-file stability, image stability, replacement and return, unrelated edits, and delayed responses; assert URL, selected row when present, displayed identity, Follow state, focus, and active tab.
- [x] 4.2 Verify resume/reconnect and two-client scenarios retain each client's chosen file, while genuine navigation, Follow-on switching, and current-file refresh remain functional; run the affected live-connection, follow-mode, document-tree, URL-routing, and preview suites.
- [x] 4.3 Run `bun run typecheck`, `bun test`, the affected Playwright suites, and `bun run build`; summarize reproduction evidence and validation, explicitly distinguishing fixed triggers from any still-unreproduced part of issue #339 before starting the performance change.
