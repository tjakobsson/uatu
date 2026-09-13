## Reproduction evidence

Before the fix, controlled browser snapshots removing the selected `selected.txt` or `diagram.md` navigated to `README.md`. All four desktop/touch cases failed the URL assertion. The two gated A-to-B preview tests already passed. This reproduces issue #339's generic symptom for temporary index absence, but does not establish which filesystem sequence caused the user's incident.

Pure selection tests also failed for text, Markdown, binary classification, and missing-to-present preview invalidation. A controlled watcher test held scan 2 open and observed scan 3 start after a later event. That confirms overlapping refresh execution.

The original watcher was also exercised directly from `HEAD`, with only scan/collection dependency injection added. Scan 2 was held open, scan 3 published, and then scan 2 was released. Published metadata moved from generation 3 back to generation 2 while the stale snapshot's `generatedAt` looked newer. The serial queue removes that completion-order inversion. Startup, watcher events, and the five-second reconciliation all use it. Each batch settles its callers independently so startup does not wait for sustained background activity to end.

## Navigation audit

The real tree library passed refresh, removal/return, filter, pointer, and keyboard tests. No separate tree-originated jump was reproduced, so its callback guard remains unchanged. The existing document response guard also passed the gated text-to-Markdown tests before implementation. Commit rendering is synchronous and clears the document selection. Gated document-to-commit tests now cover that ownership boundary.

Diff loads had a separate omission: their generation guarded loading feedback but not response publication. They now check generation before caching or rendering, and rendering rechecks ownership after asynchronous preparation and before updating the view controls. Gated same-file diff refresh tests verify the older response cannot replace the newer one. Fragment-scroll callbacks also check the current document and preview mode.

The retained destination stores session-local identity only. Missing or excluded destinations show their name and path with an unavailable message. Their content is cleared without fetching outside the allowed index. Empty indexes and image classification no longer force fallback. Return without `changedId` reloads the selected path; returning files cannot displace a newer selection. Existing explicit navigation and Follow-on behavior remain covered.

## Coverage

Twenty new Playwright cases cover desktop and touch layouts, text, Markdown, images, unrelated edits, missing and empty indexes, return, excluded content reads, independent clients, HTTP resume, tree filtering and activation, delayed document responses, commit navigation, and overlapping diff responses. They check URL, displayed identity, selection, Follow, focus, and touch tab where relevant. Watcher tests cover controlled scan overlap, repository failure, retained later events, scoped subscribers, keepalive/cancellation, shutdown, debounce, sustained progress, and startup during churn.

This fixes confirmed generic triggers for issue #339. The precise sequence that occurred on the user's device remains unknown. Chat performance and installed-app launch restoration are outside this implementation.

## Validation results

- `bun run typecheck`: passed.
- `bun test`: 2,881 passed, 9 skipped, 0 failed across 191 files. The full suite ran outside the sandbox because integration tests require local sockets.
- Affected Playwright suites: all 67 existing cases passed. The final manual-selection run passed all 20 new cases twice, 40 passes. Earlier broad runs exposed an intermittent touch-test setup failure before the delayed response. Instrumentation showed the pointer itself landing on `xref-targets.adoc`, followed by a matching tree selection callback, rather than a background selection reversal. The delayed-response fixture is now `a-selected.txt`, near the top of the tree, so that race test does not depend on scrolling to an offscreen virtualized row. Touch input uses a tap, and the test checks the selected URL before proceeding. Separate refresh/filter tests retain pointer and keyboard coverage.
- `bun run build`: passed. The bundler emitted unsupported CSS `highlight` selector warnings.
- `openspec validate preserve-manual-file-selection --strict`: passed.
- `git diff --check`: passed.

Implementation is on `fix/preserve-manual-file-selection`. The OpenSpec change remains unarchived.
