# Fresh bootstrap isolation — 2026-09-10

## Scope and safety

Verified PID 24822: PPID 1, command `bun -e import { startReviewServer } from "./tests/mobile-hub-review/server.ts"; await startReviewServer({port:4704})`, cwd this repository. Sent SIGTERM only to that PID. Diagnostic owns 4710, with a separate Bun server child and teardown. Did not contact or modify 4703. No product/security changes, dependencies, commits, or existing evidence edits.

## Red-capable command

```sh
bun tests/mobile-hub-review/bootstrap-diagnostic.ts --webkit
```

Default runs fresh Chromium then WebKit. `--close` changes only browser request Connection headers; `--clone-only` isolates clone navigation; `--blank-only` measures an empty-page baseline without the application. Output is JSONL to stdout, not an overwrite of evidence. `wall` is comparable across processes; `t` is process-local. Server-end means response object returned, **not** bytes acknowledged by the browser. No request bodies, auth headers, or response payloads are logged.

Assertions retain five-second preview/clone readiness and eight-second navigation limits; global 75-second cap is deliberately red on incomplete runs. The first combined run consumed its cap partly in browser lifecycle, so separate WebKit runs were used rather than a matrix.

## Observed results

| Probe | Result |
|---|---|
| Fresh Chromium, normal reuse | Preview passed; clone submit reached Clone Progress. submitClone server handler 79 ms, browser request completion 128 ms. |
| Fresh WebKit, normal reuse | Exact reported empty-preview assertion failure after five seconds. No pageerror. Snapshot: bootCount 1, document complete, four rAF frames, largest gap 4289 ms. |
| Fresh WebKit, Connection close | Still red, earlier: DOMContentLoaded navigation exceeded eight seconds despite HTML/CSS/JS returning 200. Not a successful mitigation in this environment. |
| Fresh WebKit, clone only, normal reuse | Remote URL fill timed out before submission; six rAF frames, largest gap 2244 ms. Does **not** reproduce the original admitted-submit reconciliation stall. |
| Fresh WebKit, blank page | Browser launch ~5.9 s, subsequent empty-page setup/evaluation ~10.5 s. 500 ms timer completed in 519 ms, zero rAF callbacks. Empty-page rAF throttling is possible; this is not proof of a native stall. |

In the exact empty-preview reproduction, direct HTTP readAuthentication/readWorkspaces took **12 ms / 1 ms**. Browser readAuthentication/readWorkspace took **1839 ms** to finish while server handlers took **75 ms / 24 ms**. Four following model reads reached the server and completed, with browser completions around **1548–1560 ms**. App API state/personal-state requests started after the preview assertion expired, returned 200, and completed around 492 ms later. App import therefore was delayed, not permanently broken. No document request had yet started at assertion failure.

The preceding Chromium run also had abnormally slow browser lifecycle: browser.close took roughly 30 seconds. WebKit launch/context setup commonly consumed 18–24 seconds **before navigating to the application**. Host load at the time was 5.60 / 6.63 / 7.86; that is context, not causal proof.

## What is established versus unresolved

* **Established:** fresh WebKit can reproduce the initial empty preview independently of the orphaned server. This is not evidence of an interaction-specific UX regression.
* **Established:** the observed failure includes delayed browser/bootstrap progress and very sparse frames, while model HTTP and request handlers remain responsive. It is not a persistent JavaScript exception or universally blocked model operation.
* **Established:** Connection close does not make this bounded scenario healthy. Do not promote the existing workaround to a root-cause fix.
* **Not established:** a six-connection SSE starvation mechanism. At the initial auth reads only one invalidation stream was open; requests reached and returned from the server. Later API requests also flowed. No evidence supports changing API security or serializing product operations.
* **Not established:** CoreText/native font ownership. No native stack sample was collected in these runs, and sparse rAF alone cannot establish it.
* **Unresolved:** exact owner of the browser-side scheduling/delivery delay (WebKit/runtime/environment versus expensive application evaluation). A successful healthy WebKit baseline and a native stack/CPU profile during the red window are needed to distinguish them. The original clone reconciliation-after-admission failure remains unisolated.

No speculative product or harness fix was made. This report deliberately does **not** claim a decisive native root cause: available evidence narrows the boundary but cannot support that claim.

## Verification

Ran the commands above plus the clone-only and blank-only probes. Test TypeScript check reported only existing `management.e2e.ts` errors at lines 122–123 (`value`/`click` on HTMLElement | SVGElement); no diagnostic-file errors. Final timer cleanup was a diagnostic-only change after the probes. Existing suites were not rerun.
