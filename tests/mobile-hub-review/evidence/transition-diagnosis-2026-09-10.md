# Transition diagnosis — 2026-09-10, incomplete

No product fix was applied. In particular, the coordinator's corrected
`.mh-flow-content` scroll-root selection and the original continuity assertions
and failure-only attachment remain unchanged.

## Completed original reproduction

```sh
bunx --no-install playwright test --config tests/mobile-hub-review/transition-regression.config.ts --project chromium --grep "Chat retains|exact real" --repeat-each 10 --trace retain-on-failure
```

Completed result: **13 passed, 7 failed, 7.3 minutes**.

- Chat retention: 10/10 passed in this completed run. An earlier invocation
  reproduced a Chat hang at the plain retained-terminal identity evaluation;
  the afterEach geometry evaluation also could not execute. That first shell
  invocation hit its 120-second tool timeout; it is not counted as a completed run.
- Exact scroll: 3/10 passed; five failures were expected 210 / received 244 at
  line 346, **before** recording retained scroll and starting the next detour.
  The first failure's error-context snapshot identifies the active surface as
  Chat, with all 40 synthetic messages present; this is not document scroll.
- Two exact-scroll failures timed out waiting for Hub to become hidden after
  Return. These were renderer responsiveness failures, not merely a wrong
  foreground flag. The repeat2 geometry attachment eventually ran at
  performance.now = 78866.4 ms: document visible/focused, foreground=true,
  workspace x=0, Hub visibility=hidden, no animations on either root.

Original-run traces and error contexts remain in `transition-regression-results/`.
Do not infer that scroll 244 has the same cause as the renderer stalls.

## Reduced real-assembly probe

`../transition-probe.ts` runs the actual review assembly on **4706 only** and
cycles Files / Chat / Terminal through Hub → Settings → Preview File Controls
sheet → Cancel → Return, 12 rounds (36 detours). It does not remount a workspace
or substitute DOM. The latest version loads the continuity fixture and emits
100 terminal outputs before each Terminal detour. It samples foreground,
getAnimations(), document.timeline, visibility/focus, geometry and observer
callback counts. A host-side heartbeat watchdog samples the native renderer
when browser-side timer reports stop.

The probe is diagnostic, **not a replacement for the exact scroll, motion,
reduced-motion, pointer, or retention assertions**. It does not yet preserve
all the original scroll setup. No green full-suite claim is made.

## Predictions and experiments

1. **Observer/layout feedback** predicts recurring callbacks while frames stall,
   and removal of the responsible observer eliminates it. Disabling all
   ResizeObserver callbacks still reproduced a renderer stall. Counts were
   otherwise modest, not a callback storm. Disabling all MutationObservers
   broke layout (toolbar intercepted Settings), so that experiment was
   inconclusive and is not evidence of a fix.
2. **Pending transition with a live renderer** predicts responsive timer samples
   with frozen animation time. Instead, browser timer reports and ordinary
   Playwright evaluations stop together for tens of seconds. After recovery,
   the motion is at its expected endpoint. Continuous rAF on/off did not
   establish a coordinator-state bug.
3. **Native browser/rendering work** predicts pauses outside application JS and
   sensitivity to rendering instrumentation. Repeated 36-detour no-trace runs
   completed normally; tracing the same probe reproduced 20–30-second gaps,
   then a ~117-second gap on a later run. Native sampling during that gap
   found a blocked renderer main thread and a font-related background worker.
   This narrows the cause but does not prove tracing is necessary: an early
   no-trace version also timed out.
4. **Bundled font download/decoding** predicts aborting WOFF2 removes the stall.
   `FONT=fallback` aborts WOFF2 requests, but still reproduced a ~23-second
   stall with a worker in CoreText glyph metrics. Thus this is not established
   as a corrupt/custom downloaded font or a reason to change the product font.

Commands used for these controls:

```sh
bun tests/mobile-hub-review/transition-probe.ts
DISABLE=ResizeObserver bun tests/mobile-hub-review/transition-probe.ts
DISABLE=MutationObserver bun tests/mobile-hub-review/transition-probe.ts
TICKER=off bun tests/mobile-hub-review/transition-probe.ts
TRACE=on TICKER=off bun tests/mobile-hub-review/transition-probe.ts
TRACE=on TICKER=off FONT=fallback bun tests/mobile-hub-review/transition-probe.ts
ENGINE=webkit TRACE=on TICKER=off bun tests/mobile-hub-review/transition-probe.ts
```

WebKit's diagnostic run was slow and timed out clicking Settings in round 1;
its sampled timeline advanced and workspace x reached 390. It is not a stable
10-round pass and does not establish the same native stall as Chromium.

## Native evidence (not symbolized Chromium attribution)

Environment: Playwright 1.63.0; installed Chromium headless shell
153.0.8010.12 / revision 1243; macOS ARM64 26.6.2 (25G83).

At 09:20:26, live renderer PID 94513, 1-second native sample:

```text
594 Thread ... com.apple.main-thread
  ... native Chromium frames ...
  594 _dispatch_semaphore_wait_slow
    594 _dispatch_sema4_wait
      594 semaphore_wait_trap
```

All 594 main-thread samples were blocked on that same native semaphore stack.
After browser-side reports resumed near 121971 ms, another sample showed a
background worker in `CTFontGetAdvancesForGlyphs` while the main thread was
mostly idle. Chromium's stripped symbols are misleading nearest exports;
do NOT interpret the intervening `rust_png` / media export names literally.

At 09:23:29, with WOFF2 aborted, renderer PID 96232, live stall sample:

```text
488 Thread ... ThreadPoolBackgroundWorker
  ... native Chromium frames ...
  488 CTFontGetAdvancesForGlyphs (CoreText)
    488 TFont::GetAdvancesForGlyphs
      488 TFont::GetAdvancesForGlyphsWithStyleFromCG
        488 GetGlyphAdvancesForStyle
          get_glyph_advances / CGFontGetGlyphAdvancesForStyle
          FPFontGetGlyphIdealAdvanceWidths (libFontParser)
```

Another worker was waiting on a semaphore. This is evidence of native font
metrics activity concurrent with the stall, not enough to name the exact
Chromium function/feature or its causal connection to the coordinator.

`transition-probe.zip` retains the bundled-font severe-stall run.
The timestamped `transition-probe-fallback-*.zip` retains the fallback run.
The last legacy `transition-probe-bundled-*.zip` is the WebKit probe, before
the harness filename was improved to include engine. Check trace metadata.

## Why no coordinator fallback was added

A timer/animation.finish() cannot run while the renderer main thread is
blocked. Adding one without separating the native stall from scroll drift
would bless an unproven fix. No ownership-compliant product defect in the
four authorized files has been demonstrated yet.

Next evidence needed: symbolized/native browser or font-work isolation;
identify the exact 210→244 scroll owner and its late geometry change
separately. Then write the failing regression at the proven owner, apply the
small fix, and run the required Chromium/WebKit 10+ loops and all continuity.
Those green verification requirements remain outstanding.

## Follow-up: exact 210→244 owner captured

The real strict test reproduced the exact pre-detour failure with opt-in DOM
diagnostics (now enabled by `CHAT_SCROLL_DIAGNOSIS=on`). The attachment
`chat-initial-scroll-diagnosis` is in
`transition-scroll-diagnosis-results/continuity.e2e.ts-exact-re-3c8a0-e-repeated-animated-detours-chromium-repeat2/trace.zip`.
It contains root/row rectangles, font readiness, intrinsic sizing, resize,
mutation and scroll events, and JavaScript scrollTop write stacks.

| Event / performance.now | scrollTop | clientHeight | scrollHeight | first two row heights |
| --- | ---: | ---: | ---: | --- |
| before test / 47586.6 | 4176 | 495 | 4671 | 100, 100 |
| fonts-ready / 47625.7 | 4176 | 495 | 4671 | 100, 100 |
| test write completed / 47926.2 | 210 | 495 | 4671 | 100, 100 |
| scroll / 47964.2 | 210 | 495 | 4671 | 100, 100 |
| resize / 48068.7 | 244 | 495 | 4941 | 116.875, 116.875 |
| JS write-before:244 / 48253.4 | 244 | 495 | 4941 | 116.875, 116.875 |

Actual root: `#chat-timeline.chat-timeline`, width 390, y 66.953125,
rect height 494.6875, unchanged across the drift. Fonts were loaded throughout.
The first rows use `content-visibility` with intrinsic size
`auto none auto 100px`; scrolling from the initial bottom reveals their real
116.875px height. The third row's viewport y remains 87.328125→87.078125:
the browser compensates for two preceding rows growing 16.875px each,
rounding 33.75px to the observed 34px scroll adjustment.
**No JavaScript scrollTop write causes 210→244**: the next intercepted write
already sees 244 and writes 244. No child-list mutation was recorded. This is
browser-native anchoring during intrinsic-placeholder realization, not a
Hub retention change or font-readiness change. Chat has intrinsic-size rows,
not a separate virtual-list library. The relevant product owners inspected
were `chat/ui.ts` scroll handling and ResizeObserver/rAF anchor restoration,
`chat/anchor.ts`, and `chat/viewport.ts`; none was changed.

An opt-in initial-state control, `CHAT_INITIAL_SETTLE=on`, reveals the top
rows at scrollTop 0, waits for their `checkVisibility({contentVisibilityAuto:
true})` (not merely fonts or message presence), then lets Chat's scheduled
ResizeObserver/rAF restoration complete before the original write of 210.
All exact-value and retention assertions remain unchanged. This is still an
experimental helper, not enabled in the baseline pending stronger repeats.

Completed verification:

- Original strict exact-scroll test + diagnostics, traced, 3 repeats:
  **0 passed / 3 failed**. Two renderer/evaluation timeouts; one exact
  expected-210/received-244 pre-detour failure with the capture above.
- Initial-settle control, untraced, 3 repeats: **2 passed / 1 failed**.
  The failure timed out on retained-root `isConnected` evaluation after
  Return, not an initial 210 assertion. Results: `transition-scroll-settle-results/`.
- Same initial-settle control + diagnostics, traced, 3 repeats:
  **0 passed / 3 failed**. Two page-fixture setup timeouts, one detour dialog
  timeout/session closed. No useful matched traced green verification.
  Results: `transition-scroll-settle-traced-results/`. The failure-only
  afterEach now guards a null page so setup failure is not masked by TypeError.

## Follow-up: installed full Chromium control is not stable

Full Chromium 153.0.8010.12 is installed at Playwright revision 1243.
`transition-full-chromium.config.ts` inherits the exact regression config,
changing only the project to headless `channel: 'chromium'` and isolating
its output directory. No installation, golden rewrite, motion change, or
timeout-budget change was made.

```sh
bunx --no-install playwright test --config tests/mobile-hub-review/transition-full-chromium.config.ts --project chromium --grep "Chat retains|exact real" --repeat-each 10 --trace retain-on-failure
```

This unchanged strict 20-test invocation **did not complete**: its first
eight reported results were failures (four Chat retention, four exact scroll),
then the host command exceeded 900 seconds. Do not report 0/20 or a completed
10-repeat result. Artifacts remain in `transition-full-chromium-results/`.
Full Chromium is therefore not an established stable substitute. These
timeouts do not establish the identical native semaphore/CoreText stack;
no new native sample was taken. A preliminary Bun launch-only invocation
also exceeded 20 seconds. Its verified orphan browser PID 2314 and the
repeat-run orphan server PID 6328 on 4706 were stopped; 4703 was untouched.

Remaining: matched strict 10-repeat green verification is blocked by browser
responsiveness; the initial-settle control needs further validation before
promotion to baseline. No product fix or general UX change is justified by
this work. The exact scroll cause is now captured, but no green full-suite,
WebKit, or native-hang-resolution claim is made.
