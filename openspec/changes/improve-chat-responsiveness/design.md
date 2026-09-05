## Context

See `proposal.md` for scope and priority. The user noticed slowness with Claude, but `chat/ui.ts`, `timeline-renderer.ts`, markdown rendering, and viewport handling serve both agents. Touch tabs hide persistent surfaces with CSS. Returning to Chat normally retains the projection and refreshes inventory; it does not normally refetch the transcript.

The render scheduler continues working while Chat is hidden. The resize observer calls full per-item geometry even when pinned, although the ordinary render path already has a cheap extent-only branch. Each changed assistant message reparses its full markdown, and collapsed activity still has constructed child DOM. Loaded history grows through paging and live events. Initial Chat setup waits behind `loadInitialState`, including preview loading; a cross-agent selection can await catalogs before announcing the conversation read.

Claude reads and normalizes a full native transcript before slicing a page and currently waits for model-catalog hydration. OpenCode traverses v2 pages and merges legacy messages before local paging. The adapter also uses complete history for accounting and reconstruction, so returning a smaller page alone cannot safely replace those responsibilities.

Exploration's synthetic local renderer check measured approximately 60 ms for 50 messages and 586 ms for 500, excluding browser layout and paint. These are investigation clues, not phone benchmarks.

## Goals / Non-Goals

**Goals:**

- Separate immediate navigation, retained content, authoritative data readiness, and optional catalog readiness.
- Reduce work using existing item identity and provider history ownership, with measurable results for both agents.
- Preserve cursor replay, history mutations, accessible interactions, and the preceding file-selection fix.

**Non-Goals:**

- Improve model generation speed or assume a slow request means the network is responsible.
- Add durable transcript storage, a service worker, broad bundle splitting, or new dependencies.
- Change authentication expiry, terminal takeover semantics, or installed-app launch destinations.

## Decisions

### 1. Establish separate latency measurements before optimization

Use equivalent fixtures with 50, 500, and 2,000 normalized items, including prose, code, long tool output, collapsed activity, images, and a pending request. Record source bytes as well as item count, since OpenCode pages provider messages that can expand into multiple timeline items. Provider fixtures separately exercise native paging and mutation behavior; shared UI fixtures alone do not prove backend improvements.

Measure input-to-visible-content, read duration, snapshot-to-interactive-content, browser long tasks, DOM element count, hidden render count, and provider history reads/normalizations. Distinguish cold opening, warm tab return, older-page prepend, streaming pinned/unpinned, and lifecycle resume.

The controlled profile is a production build in Chromium at a 390x844 touch viewport, with an unthrottled baseline and 4x CPU slowdown. Test network separately at 150 ms latency and 1.6 Mbps downstream, then combined; record browser version and host hardware. Run at least 30 measured warm returns per workload after warm-up. The acceptance budget is p95 <= 200 ms for return to retained content, with a deliberately delayed inventory request proving network independence. Use event/presentation timing and traces, not only a changed DOM attribute, to establish visible completion. Gather a phone/WebKit trace when available and label any lack of physical-device validation.

Keep deterministic correctness checks in the normal suite and performance runs reproducible in a dedicated command. Do not loosen the budget to make a result pass; report unresolved misses. Measurements record durations/counts and fixed operation labels, not conversation contents or credentials.

### 2. Separate live state from transcript presentation

Continue applying events, cursor updates, and minimal attention/request state while Chat is hidden. Suspend transcript DOM work, geometry reads, decorations, and hidden elapsed-time presentation. Retain a dirty marker instead of scheduling one render per event. Capture the reading anchor before hiding while geometry is valid. On reveal, preserve the existing content and reconcile pending changes once, yielding additional work when needed. Apply the same ownership rules to an open child transcript.

Use extent-only anchoring while pinned in resize and render paths; batch geometry reads before writes and avoid measurements of display:none content. Keep drafts, attachment staging, expanded IDs, and answerable request state independent of transcript DOM. Closing streams whenever a tab hides was rejected because it discards useful live state and increases reopen latency.

### 3. Reduce history presentation work without breaking loaded-history features

Retain keyed item rendering and cache immutable markdown/detail output by item identity and content revision. Bound cache memory; do not cache arbitrary content forever. Delay expensive bodies of closed activity until expansion. Rate-limit/coalesce streaming markdown work while still presenting incremental text, and flush the exact final sanitized content promptly. Never use unsanitized markup as a fast path.

Measure after these changes. If revealing long retained timelines still misses the budget, bound mounted off-screen history using an anchored window with overscan and measured placeholders. This is a conditional implementation technique within the same interaction contract, not permission to remove content. Find must index loaded projection content and materialize matching results before navigation; pending forms and active text selections must not be evicted. Copy, file links, accessible reading order, prompt-rail jumps, expansion, and older-page anchoring must pass before enabling windowing. A renderer rewrite without measurements was rejected because the current unchanged-item path is already inexpensive.

### 4. Give data reads operation-owned loading and cancellation

Reuse the Diff signal's timing, generalizing its label and ownership rather than introducing a second visual convention. Select the tab or acknowledge the control synchronously, start the delayed signal at action initiation, and settle it only when the current operation's content is interactive. Use operation tokens so an older request cannot hide a newer indication. Retained refresh content stays visible and labeled as updating; a new conversation's retained predecessor must not be presented as the new conversation.

Show operation-specific text such as `Loading conversation...`, `Loading older messages...`, and `Updating conversation...`, with aria-busy/status semantics and reduced-motion behavior. Keep loading state separate from connection interruption, agent working state, and actionable errors. Allow feedback to paint before large work and yield between chunks; a timer cannot display during a blocked main thread.

Add cancellation and a 30-second default deadline to ordinary snapshot and inventory reads. Startup and catalog reads use their existing documented operator startup budget, with a finite client allowance for transport, so a legitimate configured startup is not cut off by the ordinary read deadline. Timeout/failure offers a read-only retry and preserves drafts. Do not automatically retry mutations through this mechanism. Ensure stalled recovery reads release their in-flight ownership after timeout so later lifecycle signals can run.

### 5. Let the active surface become usable before optional work

Split workspace/auth initialization from preview materialization so Chat can initialize once its required workspace state and credentials are available. Keep agents lazy when another surface is active. Defer hidden preview materialization, retaining the latest selected destination from the first change, and materialize when revealed. A cold Chat surface must still identify which required phase is loading.

Start transcript and optional catalogs independently after resolving the conversation's owning agent. Catalog-dependent controls stay unavailable until ready; stale catalog completions remain guarded by agent/selection identity. On the server, Claude history normalization must support unresolved model aliases and enrich readouts when reliable catalog data arrives, instead of blocking history behind a probe. Do not launch duplicate probes or discard operator startup controls.

### 6. Reuse provider history only when its freshness is established

Use a workspace/provider-owned, in-memory LRU limited by retained bytes and entry count, with concurrent reads sharing in-flight work. Initial limits are 32 MiB and 8 conversations per provider; bypass retention for an entry exceeding the byte budget. Correctness is independent of eviction or process restart. Do not create a second durable source of conversation truth.

For Claude, key by canonical transcript identity plus file metadata that detects replacement, append, truncation, and rewrite, including inode, size, mtime, and ctime. Validate before reuse and compare metadata before/after a read. An unstable read is retried within the read budget. Cache parsed/normalized history for unchanged files first; incremental append parsing is only justified by subsequent measurements and must handle partial final lines and history rewrites. Include normalization inputs such as model-alias revisions and public parent identity in validity, and invalidate forks/rewinds through their existing mutation hooks.

For OpenCode, reuse a complete merged history only with reliable provider revision evidence covering the stores that contributed to it. Invalidate on stream changes, history mutations, deletion, provider restart, and replay gaps. Check external-change freshness on snapshot reads; a TTL alone does not prove freshness. Where a store lacks reliable revision evidence, perform authoritative reads for that source and share only concurrent work. Prefer bounded native paging where it preserves merged-store completeness; do not remove legacy-store reads or complete-history accounting merely to lower a request count.

Keep snapshot-to-stream cursor capture before asynchronous provider reads. Page requests must refer to a consistent history version; invalidated cursors require explicit resynchronization rather than silently using stale offsets. Preserve public response shapes and existing opaque-cursor compatibility. Provider contract tests must cover append, rewrite, delete, undo/redo/revert/restore, subagents, accounting, cache eviction, and two simultaneous clients.

## Risks / Trade-offs

- [Hidden events still consume CPU] -> Keep state application incremental, coalesce presentation, and measure visible-surface responsiveness during streaming.
- [Deferred DOM breaks find or selection] -> Preserve loaded-history indexing and interaction state; require the compatibility tests before enabling windowing.
- [History cache returns stale provider data] -> Verify source freshness, invalidate on mutations/gaps, and use authoritative fallback when uncertain.
- [Read deadline conflicts with cold agent startup] -> Separate ordinary reads from the existing operator-controlled startup budget and make retries read-only.
- [Performance results vary across machines] -> Record hardware/profile and distributions; separate deterministic operation-count assertions from browser timing runs.
- [Boot refactoring regresses manual selection] -> Apply after the selection change and rerun its navigation/recovery regressions.

## Migration Plan

Implement after `preserve-manual-file-selection`. Land measurement and shared presentation work before provider reuse so each effect can be evaluated. No persisted migration or dependency change is planned. Run API contract checks if cursor/error behavior changes internally. Rollback discards in-memory caches and restores the prior renderer; native conversation history remains intact.

Home-screen restoration remains a separate follow-up. The Hub start URL `/` and workspace start URLs differ, and safe per-device restoration needs a launch-specific destination that does not intercept an explicit dashboard visit. That is not included as a cheap side change.
