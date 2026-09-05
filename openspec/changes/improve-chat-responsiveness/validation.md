# Chat responsiveness validation

## Prerequisite

Fresh main revision `b3bfef34053660eb2367bfda13e4132d40508711`, containing
`preserve-manual-file-selection`, was checked before performance changes.

Command:

```sh
bunx playwright test tests/e2e/manual-selection.e2e.ts tests/e2e/follow-mode.e2e.ts tests/e2e/document-tree.e2e.ts tests/e2e/files-pane-filter.e2e.ts tests/e2e/url-routing.e2e.ts --workers=4 --reporter=line
```

Result on 2026-09-05: 57 passed in 28.3 seconds.

## Workloads

`tests/fixtures/chat-performance.ts` generates deterministic UI data shared by
both agents, native Claude JSONL, and disjoint OpenCode native/legacy stores.
The UI includes prose, highlighted code, file links, long completed tool output,
closed reasoning, image references, and an answerable request. Native fixtures
exercise each provider's actual parser/normalizer; pending requests are part of
the UI projection because they are live interaction state.

| Items | UI source bytes | Claude JSONL bytes | OpenCode native bytes | OpenCode legacy bytes |
| ---: | ---: | ---: | ---: | ---: |
| 50 | 132092 | 229158 | 122030 | 20230 |
| 500 | 1325731 | 2293397 | 1220830 | 202830 |
| 2000 | 5306280 | 9179056 | 4884780 | 812780 |

Fixture validation: `bun test tests/fixtures/chat-performance.test.ts`, 3 passed.

## Implementation and measurement decisions

The first optimized 2,000-item CPU-4 run still missed the 200 ms warm-return
budget: Claude 468.4 ms, OpenCode 483.7 ms. Hidden streaming had already fallen
to zero transcript renders. This justified the conditional offscreen work.

The browser now windows layout with `content-visibility: auto` and remembered
intrinsic block sizes on assistant and activity bodies. User bubbles and pending
forms keep normal layout. All item nodes remain in document order; the browser
retains layout for focused/selected content. This implements the conditional
window without detaching loaded text or introducing a second item index.
See the [CSS containment specification](https://www.w3.org/TR/css-contain-2/)
and [remembered intrinsic sizes](https://www.w3.org/TR/css-sizing-4/).
Final measurements use these narrower production selectors and real decoded
images.

Markdown reuse is bounded to 4 MiB/128 source-output pairs. Tool detail reuse is
bounded to 4 MiB/256 entries and validates the fields used to derive details.
Closed activity bodies materialize on disclosure or loaded-history find. Find
indexes closed Chat details and opens ancestors when revealing a result; the
Preview find contract continues to search only disclosed details. Incremental
transcript presentation coalesces at 50 ms; final updates bypass that delay.

Only the first hidden preview load is deferred. Already-mounted previews retain
the existing file disappearance/return behavior required by the prerequisite.
Required workspace/auth state releases Chat initialization before that preview.

Read feedback uses Diff's 200 ms delay and 300 ms minimum visibility, with
operation tokens and independent parent/child ownership. Snapshot completion
settles feedback after presentation frames; mutation callers do not wait for
those frames to restore drafts. Ordinary reads expire after 30 seconds. Cold
history/catalog reads use the server-advertised startup timeout plus a 35-second
transport allowance. Retries never replay mutations.

## Provider freshness and compatibility

Claude retains normalized history only after verifying canonical path, device,
inode, byte size, nanosecond mtime/ctime, public conversation identity, staged
boundary, and model aliases. It checks again after the read. Tests cover reuse,
partial trailing writes, append, rewrite, replacement, truncation, deletion,
native forks, children, reversible history, usage, and attribution.

The installed OpenCode SDK's v2 `SessionMessagesResponse` exposes messages and
page cursors; the classic response is a message array. Neither provides a
revision proving both contributing stores unchanged. Session modification time
is not a reliable content revision. Therefore serial reads traverse both stores;
only concurrent traversals are shared. The added contract test observes one
native plus one legacy call for two simultaneous clients, then one of each for
a subsequent read, and rejects an old cursor after an external legacy edit.
The session `version` field identifies the installed OpenCode version, as shown
in [OpenCode's session implementation](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/session.ts).
It is not a history revision. This is the design's authoritative fallback; no
TTL claims freshness.

Provider retention limits are eight conversations and 32 MiB of estimated
serialized UTF-16 data per provider instance. Oversized entries bypass retention;
eviction/disposal never deletes native history. Events and history mutations
invalidate affected work. Changed page versions return HTTP 409 and the UI's
read retry fetches a fresh snapshot. The public response and opaque outer cursor
shapes are unchanged. Adapter tests retain the replay cursor captured before
asynchronous provider reads, including an event arriving during a snapshot.

## Compatibility evidence

- Prerequisite navigation: 57 Chromium scenarios passed before implementation.
- Affected Chat, image attachments, inventory, reversible history, manual
  selection, and live connection: 93 Chromium scenarios passed.
- Full unit suite: 2,896 passed, nine environment-dependent skips, zero failures.
- Final affected unit run: 885 passed, four opt-in integration skips.
- API contracts: 174 passed, zero failures.
- Final Chromium run: 229/230 passed. The existing document-tree Follow toggle
  test failed; it also failed 3/20 repeats against the saved baseline binary.
  The current branch's focused rerun passed. This remains an existing flake.
- iPhone 13 WebKit profile, with Safari user agent, touch input and device scale:
  23/25 passed, including all twelve new responsiveness cases. The existing
  custom-answer test while the input is focused and the older-page position
  test fail against both versions. The prepend offset is 47.1875 px in both.
- Typecheck, production build, strict OpenSpec validation and fixture checks pass.
- Final bootstrap hide/return/retry scenarios: both agents pass in Chromium.
- Physical phone validation has not been performed. Desktop WebKit and Chromium
  touch emulation do not substitute for a physical-device trace.

Local logs include `/tmp/uatu-tests.log`, `/tmp/uatu-api.log`,
`/tmp/uatu-chat-final-browser.log`, `/tmp/uatu-tree-baseline.log`,
`/tmp/uatu-tree-current.log`, `/tmp/uatu-webkit-iphone.log` and
`/tmp/uatu-webkit-iphone-baseline.log`. WebKit traces are in
`.local/webkit-traces/`.

The expanded recovery scenario also holds a snapshot past its 30-second deadline
using the browser clock, checks the timeout/retry UI, switches conversations
while another read is outstanding, and verifies that the draft survives and no
POST requests occur. It exercises initial inventory retry as well. Both agents'
long-history scenarios answer the pending request after find, copy, selection,
file navigation and return. All twelve expanded scenarios pass in WebKit.

A WebKit layout race found during this validation is fixed: when a previously
estimated offscreen body acquires its real height, the resulting extent growth
no longer turns a pinned reader into an unpinned one. The scroll handler follows
that growth unless the reader's scroll position moved upward.

## Reproducing performance measurements

`bun run bench:chat` compiles/minifies the normal SPA with deterministic test
providers and runs 30 measured trusted warm returns after three warm-ups, for
each agent, each workload, and unthrottled/CPU-4/network/combined profiles. App
assets load before network throttling because application setup is outside the
cold-Chat interval; every measured Chat read uses the selected network profile.
One complete inventory response stays delayed in browser transport across all
30 returns. Holding a provider contribution instead crosses the existing
four-second merge limit and temporarily removes that agent from inventory;
that earlier experiment was discarded and both binaries were rerun with the
same corrected driver. Two animation frames
and geometry confirm presentation; screenshots and traces capture the rendered
result. Native-provider processing is measured separately using actual provider
classes and native fixtures, not the browser's fake providers.

Each workload uploads a real 70-byte PNG and replaces fixture image references
with its store id before measurement. The report includes actual UI bytes,
mounted/decoded image counts, read timings, snapshot-to-presentation latency,
DOM counts, long tasks, and per-provider reads/normalizations. Older items have
timestamps preceding the initial page. The benchmark fails if no image decodes.

The saved pre-optimization production binary in `.local/chat-baseline/server`
contains the timing hooks and fixtures but none of the presentation/provider
optimizations. `UATU_CHAT_BENCH_REUSE_BUILD=1` preserves that binary for comparison;
`UATU_CHAT_BENCH_PROVIDER_RESULTS` points to the native-provider results captured
before implementation. `serverSha256` distinguishes the two measured binaries
because both are based on the same main commit with uncommitted changes.

The deliberately oversized 2,000-item initial UI page can exceed the ordinary
30-second read deadline at 1.6 Mbps. The benchmark records one visible read-only
retry and includes both attempts in cold latency. It does not lengthen the
production deadline or omit that wait from the results. The warm-return budget
applies once content is retained; it does not imply a sub-200 ms transfer of a
multi-megabyte cold snapshot. Normal browser snapshot requests ask for 50 items;
the UI fixture deliberately supplies the full workload to stress presentation.
Native-fixture counts describe source records, which may normalize into more
than one timeline item.

## Performance results

The complete [measurement record](measurements.json) retains all 30 warm samples
for each of the 48 before/after cases, provider captures, browser and hardware
identity, binary hashes, byte counts, cold/read/presentation timings, DOM counts,
streaming work, resume timings and local trace locations. Long-task and event
duration arrays are summarized by count, total and maximum. Milliseconds are
rounded only in this review artifact; raw local reports retain full precision.

| Agent | Items | Profile | Warm p95 before / after, ms | Cold before / after, ms | Snapshot presentation before / after, ms | Older prepend before / after, ms |
| --- | ---: | --- | ---: | ---: | ---: | ---: |
| claude | 50 | unthrottled | 26.5 / 27.0 | 149.2 / 170.2 | 74.7 / 65.2 | 68.5 / 59.9 |
| claude | 50 | cpu4 | 31.0 / 30.7 | 467.7 / 411.8 | 203.7 / 211.8 | 136.0 / 106.4 |
| claude | 50 | network | 41.9 / 34.1 | 2866.7 / 2367.0 | 204.6 / 438.8 | 1331.7 / 1325.6 |
| claude | 50 | combined | 40.0 / 40.2 | 3026.9 / 2489.8 | 293.3 / 468.1 | 1341.5 / 1349.1 |
| claude | 500 | unthrottled | 42.4 / 34.2 | 263.8 / 167.5 | 183.4 / 114.0 | 74.9 / 57.3 |
| claude | 500 | cpu4 | 131.6 / 42.8 | 943.0 / 631.2 | 661.9 / 443.5 | 203.4 / 177.1 |
| claude | 500 | network | 33.9 / 33.9 | 7908.3 / 7361.1 | 175.7 / 155.0 | 1329.2 / 1332.6 |
| claude | 500 | combined | 126.7 / 42.9 | 14352.1 / 14141.9 | 619.2 / 441.5 | 1357.3 / 940.9 |
| claude | 2000 | unthrottled | 114.2 / 27.6 | 615.0 / 341.4 | 523.5 / 279.6 | 108.0 / 90.5 |
| claude | 2000 | cpu4 | 499.1 / 137.2 | 2463.2 / 1557.1 | 2189.2 / 1317.9 | 421.2 / 374.0 |
| claude | 2000 | network | 114.7 / 42.9 | 34200.4 / 57490.0 | 509.0 / 317.0 | 1357.1 / 1352.5 |
| claude | 2000 | combined | 497.6 / 132.8 | 35746.4 / 58568.2 | 2043.5 / 1186.1 | 1202.4 / 1112.8 |
| opencode | 50 | unthrottled | 42.8 / 27.2 | 133.0 / 110.5 | 60.1 / 57.6 | 50.7 / 39.2 |
| opencode | 50 | cpu4 | 40.6 / 39.5 | 446.3 / 418.4 | 215.3 / 190.9 | 115.9 / 103.1 |
| opencode | 50 | network | 33.6 / 40.8 | 2886.9 / 2379.4 | 327.9 / 479.8 | 1332.0 / 1337.0 |
| opencode | 50 | combined | 41.3 / 42.4 | 3014.9 / 2983.9 | 391.6 / 410.3 | 1361.5 / 1348.7 |
| opencode | 500 | unthrottled | 34.1 / 27.4 | 249.3 / 176.0 | 174.0 / 115.9 | 71.1 / 76.1 |
| opencode | 500 | cpu4 | 128.4 / 41.9 | 887.0 / 601.0 | 755.3 / 390.6 | 187.0 / 172.2 |
| opencode | 500 | network | 43.2 / 27.5 | 13930.7 / 13413.3 | 204.1 / 523.2 | 1339.8 / 1343.6 |
| opencode | 500 | combined | 127.7 / 43.5 | 14421.4 / 13191.8 | 669.1 / 404.6 | 1004.2 / 1377.7 |
| opencode | 2000 | unthrottled | 117.0 / 43.3 | 578.1 / 352.4 | 496.6 / 289.6 | 115.1 / 77.9 |
| opencode | 2000 | cpu4 | 509.6 / 121.0 | 2339.3 / 1377.0 | 2054.5 / 1163.9 | 416.3 / 305.5 |
| opencode | 2000 | network | 120.7 / 43.2 | 34187.2 / 57483.7 | 519.1 / 299.4 | 1370.5 / 1369.9 |
| opencode | 2000 | combined | 520.0 / 123.8 | 35847.0 / 58425.5 | 2167.4 / 1120.2 | 1209.4 / 1049.8 |

Claude's worst warm p95 fell from 499.1 ms to 137.2 ms. All twelve final profiles meet the 200 ms target.
OpenCode's worst warm p95 fell from 520.0 ms to 123.8 ms. All twelve final profiles meet the 200 ms target.

All final hidden-streaming cases perform zero transcript renders and zero item
geometry reads. Native source processing across three adjacent history pages:

| Agent | Source records | Before | After |
| --- | ---: | --- | --- |
| claude | 50 | 3 reads / 3 normalizations | 1 read / 1 normalization |
| opencode | 50 | 3 native / 3 legacy calls | 3 native / 3 legacy calls |
| claude | 500 | 3 reads / 3 normalizations | 1 read / 1 normalization |
| opencode | 500 | 9 native / 3 legacy calls | 9 native / 3 legacy calls |
| claude | 2000 | 3 reads / 3 normalizations | 1 read / 1 normalization |
| opencode | 2000 | 30 native / 3 legacy calls | 30 native / 3 legacy calls |

The OpenCode serial call counts deliberately retain authoritative reconciliation.
Concurrent reads share one traversal, covered separately by provider tests.

DOM element counts after paging and streaming fell from 1,006 / 5,461 / 20,311
for the 50 / 500 / 2,000-item fixtures to 936 / 5,076 / 18,876. The reduction comes from
closed activity bodies; loaded item nodes remain in order. All 24 before and
24 after paging cases completed. No warm-return budget misses remain. Cold
2,000-item transfers under network throttling still take about 58 seconds with
one retry, compared with about 34 to 36 seconds without the new finite deadline.
