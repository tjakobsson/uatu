# Same-document motion and remaining continuity verification

**Follow-up:** the subsequently authorized fresh/reset default calibration is
recorded in [default-placement.md](default-placement.md). The old-default audit
below and `*-handle.json` files are retained as historical measurements; saved
0.72 placements are unchanged by that follow-up.

Synthetic backend only; awaiting user visual/interaction approval. These are new
motion captures and measurements, not approved goldens. Original reference and
the visual worker's `visual/corrected/` evidence remain untouched.

## Implementation

- One foreground signal drives a reversible 240 ms workspace slide to the right.
  Inertness and accessibility state change immediately; there is no animation
  state machine, input-blocking overlay or transition-completion navigation.
- Reduced Motion removes travel. Authentication/workspace invalidation hides
  protected pixels immediately rather than animating them away.
- The workspace's normal-flow content uses relative positioning. Its existing
  viewport-fixed surfaces move independently, so their ancestor is never made
  a transformed containing block. A non-scrolling `overflow-x: clip` frame keeps
  the mobile layout viewport from widening to include the parked workspace.
  The moving layer inherits the existing body canvas through that frame, rather
  than exposing Hub through transparent workspace gaps or inventing a palette.
- Removed the review assembly's fixed-height/fixed-position workspace wrapper:
  long Preview documents now use the original document scrolling owner. No
  replacement scrolling body or custom Preview scroller was introduced.
- The selector still fades locally, 180 ms in / 280 ms out. It does not travel
  from the handle when expanded. Ordinary Return preserves the active tab and
  client instance and never focuses the selector.
- Corrected the coordinator's remembered workspace URL after delegated
  document/hash history. Previously, Back could incorrectly consume an older
  commit location as though that commit were still displayed.
- Detail history now saves the actual detail scroller, not the overview's
  scroller, and waits for an asynchronous detail read before restoring its
  offset. New navigation or user input cancels that pending restoration.

## Handle evidence: no unapproved position migration

The actual default is **0.72**, not 0.5. Its existing meaning is a fraction of
the clamped **top-edge travel**, and drag uses the inverse of the same mapping.
At 390×844 with a 44px target and 8px edge clearance:

`top = 8 + (844 - 16 - 44) × 0.72 = 572.48px`.

The 40px visual face is centered within that target, so its top is about574.48px.
The screenshot's visual face begins around588px. Thus the earlier≈15.5px report
compares the hit target with the photographed face; the face-to-face difference
is about13.5px. Neither is evidence of broken drag/clamp geometry.
The reference is consistent with a center at72% of the whole viewport
(`844 × .72 - 20 = 587.68px` for its face). That is a different coordinate policy
from the existing persisted clamped-travel fraction.

Changing the mapping to a full-viewport fraction would silently move saved
positions. Changing just the default/reset ratio requires an explicit product
choice (approximately0.7372 would put this face at588px at this one viewport).
This worker changed **neither** saved positions nor the default. Browser checks
cover the current mapping, keyboard changes, right-edge placement, persistence
through reload, and the selector's independent bottom position. Exact reference
default placement remains an unresolved task6.1 decision, not a claimed fix.

## Verification and captures

The expanded fixture is test-owned:101 Files entries,80 Preview sections,40
real Chat timeline messages, a populated synthetic commit and real xterm output.
The original fixture is restored on reset. No host repository or executable
shell participates.
All declared fixture documents have explicit protocol responses and direct
document routes; personal-state validation follows the active fixture allowlist.

The scroll test discovers the actual Files scroll element (including shadow
DOM), uses `document.scrollingElement` for Preview and the existing Chat timeline.
For xterm6's virtual scrolling it observes the real Terminal through its public
`buffer.active.viewportY`/`scrollToLine` APIs—not a fictitious DOM scrollTop.
Each settled nonzero position is compared exactly during and after two detours;
Chat/terminal output also arrives while Hub is visible. Chat's own initial anchor
normalization is allowed to settle **before** capturing the retained position.

Commands:

```sh
UATU_MOTION_EVIDENCE=1 bunx --no-install playwright test --config playwright.mobile-hub-review.config.ts clients.e2e.ts continuity.e2e.ts motion.e2e.ts
UATU_MOTION_EVIDENCE=1 bunx --no-install playwright test --config playwright.mobile-hub-review.config.ts continuity.e2e.ts motion.e2e.ts --grep 'exact real|foreground drives|handle geometry'
bun tests/mobile-hub-review/compatibility.ts
bunx --no-install tsc --noEmit
bunx --no-install tsc --noEmit -p tests/mobile-hub-review/tsconfig.json
```

The evidence command writes per-browser in-flight PNGs and geometry/handle/scroll
JSONs here. Motion is sampled by seeking the actual CSS transition to80ms, not
by pretending the JavaScript timer clock also controls CSS animations.
Completed-visit continuity actions wait for the requested destination to be on
screen; separate paused-transition tests exercise real pointer input into Hub
during exit and visible workspace controls during Return. They do not ask the
browser to auto-scroll an offscreen fixed destination into view mid-transition.

Compatibility compiles the original production `src/index.html`/`app.ts`, with
no coordinator entry, and serves it through the isolated protocol double at an
ephemeral loopback port. Both fine-pointer desktop and standalone touch are
checked in Chromium and WebKit. This is not a live desktop Hub/native-inset
visual audit.

## Final recorded results

- Full client/continuity/motion command: **38 passed**,19 per engine (Chromium
  and WebKit). This includes direct fixture-file/hash loads, populated and
  unavailable commits, asynchronous detail-scroll restoration, invalidation,
  exact settled surface scroll, motion interruption and reduced motion.
- Focused units: **183 passed**,511 expectations across17 files (coordinator,
  fixture/protocol/server/transport, Hub-nav, boot stamps, active surface,
  terminal client, state ownership and visual CSS guards).
- Both TypeScript commands: **PASS**. The concurrent clone-flow type blocker is
  no longer present; this worker did not change that flow.
- Original-entry compatibility: **4 passed** (desktop and touch in each engine).
- Focused repetition: **8 passed** for attachment continuity and in-flight
  Return pointer interaction, two repetitions in each engine. An earlier
  Chromium-only exact-scroll repetition also passed3/3.
- `git diff --check`: **PASS**. Test listeners were stopped; no4703 listener left.

Earlier exploratory Chromium
runs included transient browser stalls and interrupted smooth-scroll assertions;
the final full run and explicit repeat results must be considered separately,
not represented as an uninterrupted all-green development history. No physical
device, OS eviction, live authorization or full responsive matrix is certified.
