## 1. Establish a reproducible baseline

- [x] 1.1 Confirm `preserve-manual-file-selection` has been implemented and its navigation regressions pass before starting performance changes; record the tested revision and preserve those tests through this work.
- [x] 1.2 Add equivalent 50-, 500-, and 2,000-item UI fixtures and separate Claude/OpenCode provider-history fixtures; verify they cover prose, code, large tool output, images, collapsed activity, and pending interaction requests with recorded byte counts.
- [x] 1.3 Add a reproducible production-browser benchmark command and fixed-label timing/count instrumentation; record baseline results for cold open, warm tab return, paging, streaming, and resume using the design's CPU/network profiles and at least 30 measured warm returns per workload.

## 2. Reduce shared presentation work

- [x] 2.1 Suspend parent and child transcript presentation while hidden, retaining live projection/cursor updates and minimal attention state; verify hidden output schedules no transcript renders and tab return restores current content, drafts, attachments, expansion, and reading anchors.
- [x] 2.2 Use pinned extent-only anchoring in resize paths and batch visible geometry reads/writes; verify pinned resize does not measure every item and unpinned scrolling, expansion, keyboard resize, and older-page prepend preserve position.
- [x] 2.3 Add bounded reuse of unchanged markdown/detail output, lazy closed-activity bodies, and coalesced incremental markdown presentation; verify exact final sanitized output, prompt incremental text, unchanged-item reuse, and actionable pending requests.
- [x] 2.4 Rerun long-chat reveal measurements and meet the p95 200 ms warm-return budget; add anchored off-screen windowing only if the simpler changes miss it, and verify find over loaded history, copy, file links, prompt-rail navigation, accessible reading order, and active text selections before enabling it. Record the measurement if windowing is unnecessary.

## 3. Make waiting visible and navigation independent

- [x] 3.1 Generalize the existing delayed loading signal for operation labels and per-operation ownership; verify immediate acknowledgment, the 200 ms show delay, 300 ms minimum visibility, reduced motion, accessible state, and stale-operation isolation without regressing Diff feedback.
- [x] 3.2 Apply loading/error/retry presentation to initial conversation reads, cross-agent selection, older history, and authoritative refresh; verify retained content and scroll remain stable, unrelated errors survive, and feedback stays active through presentation readiness.
- [x] 3.3 Add cancellation and finite deadlines to Chat reads, using the 30-second ordinary read budget and respecting configured cold-start budgets; verify timeout releases recovery ownership, superseded reads cannot mutate the active surface, and retries issue reads only.
- [x] 3.4 Separate required workspace/auth initialization from hidden preview materialization; verify a restored Chat tab initializes despite a delayed preview response, other tabs do not start agents, and later preview reveal uses the current manually selected destination.
- [x] 3.5 Load transcript and optional agent catalogs independently, including removing Claude's history dependency on catalog hydration; verify delayed catalogs do not block history, unresolved readouts stay unknown, and late catalog results cannot apply to another agent.

## 4. Reduce provider history work safely

- [x] 4.1 Add provider-owned bounded in-memory history reuse with shared in-flight reads and initial limits of 32 MiB/8 conversations per provider; verify byte/count eviction, oversized-entry bypass, disposal, and workspace/conversation isolation.
- [x] 4.2 Reuse unchanged Claude transcript parsing/normalization using validated source identity and metadata, including normalization inputs; verify reduced processing counts and correctness for append, partial final lines, rewrite, replacement, truncation, deletion, native forks, and child transcripts.
- [x] 4.3 Establish reliable OpenCode freshness evidence for each contributing store and reuse verified merged history or bounded native pages where safe; verify adjacent unchanged reads avoid redundant traversal when freshness is provable, and uncertain versions force authoritative reconciliation without omitting legacy content. Record the available freshness guarantees and resulting provider-call counts.
- [x] 4.4 Integrate invalidation with both providers' stream updates and history mutation paths; verify append, undo, redo, revert, restore, deletion, provider restart, replay gaps, accounting, and child attribution against authoritative uncached results.
- [x] 4.5 Preserve consistent page versions and the pre-read snapshot-to-stream cursor boundary; verify overlapping reads and live events do not duplicate or omit items, obsolete page cursors resynchronize explicitly, and public API/cursor compatibility checks pass.

## 5. Validate responsiveness and compatibility

- [x] 5.1 Run desktop and touch browser scenarios for both agents, including Files/Preview/Terminal interaction during hidden streaming, delayed inventory, catalog failure, hanging reads, child drill-down, and page resume; verify drafts, requests, loaded-history find, copy, links, and reading anchors.
- [x] 5.2 Repeat the recorded performance matrix against the baseline, checking p95 warm returns, cold-read and presentation timings, hidden work, DOM counts, and provider processing counts; report each agent separately and gather phone/WebKit evidence when available, explicitly labeling any physical-device validation gap.
- [x] 5.3 Run `bun run typecheck`, `bun test`, affected Playwright suites, `bun run test:api`, and `bun run build`; rerun the file-selection and resilient-connection regressions and summarize outstanding performance misses before declaring implementation complete.
