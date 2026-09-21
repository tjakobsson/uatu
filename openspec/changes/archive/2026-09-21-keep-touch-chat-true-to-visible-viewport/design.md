## Context

See proposal.md — Why. Four mechanisms carry the affected behavior:

- **`ChatViewportController` (`src/chat/viewport.ts`)** is the only writer of `--chat-visual-top` / `--chat-visual-height`. In touch mode those variables position the chat surface, which `styles.css` renders as `position: fixed; top: var(--chat-visual-top); height: var(--chat-visual-height)` under `html[data-ui-mode="touch"][data-active-tab="chat"]`. The controller listens to visual-viewport `resize`/`scroll`, window `resize`, a `ResizeObserver` on the composer and the surface, and UI-mode changes. Every listener is the same bare `() => this.apply()` — no coalescing, no unchanged-value guard, no page-lifecycle listener. Its desktop twin `src/shell/desktop-viewport.ts` already has both guards in `measure()`.
- **`chatViewportMetrics(visualHeight, visualTop, layoutHeight, tabBarInset)`** computes `occluded = layoutHeight − visualTop − visualHeight`, uses it to shrink the tab-bar inset, and reuses it as the keyboard predicate against `max(80, tabBarInset)`. `data-chat-keyboard` on `<html>` is what collapses the pinned tracks.
- **The touch chat column** is `overflow: hidden` and fixed-height. The composer is `flex: 0 0 auto`; the transcript area is the only shrinkable child. Anything that grows and is not bounded therefore pushes the composer past the bottom edge rather than being clipped itself.
- **`CoordinatedScrollOwner` (`src/chat/coordinated-scroll.ts`)** is, by its own comment, the only automatic position writer. `pause()` unpins and re-captures at the topmost visible item; `beforeMutation(preferredItemId?)` exists so a caller can name the item the correction must hold. `keyDown` already excludes `input, textarea, select, [contenteditable=true]`; `touchStart`/`touchMove` do not.

Constraints that bound this work:

- `src/shell/tab-bar.ts` and the keyboard tab-bar rules around `styles.css` ~8020–8045 are being rewritten by draft PR #358, which makes `tabBarBottomInset()` return 0. Do not touch either; prefer tests that pass `tabBarInset = 0` so they survive that merge.
- `data-chat-editing` MUST NOT become a CSS trigger for collapsing the pinned tracks. It is used here only as a signal inside the controller for suppressing a correction.
- iOS is the subject. Two of the mechanisms can only be confirmed on a device (see Risks).

## Goals / Non-Goals

**Goals:**

- One measurement path that is idempotent, frame-coalesced, and re-entrancy-safe, so applying geometry never costs a scroll write.
- Geometry that is re-derived on page-lifecycle transitions, not only on platform viewport events.
- A keyboard predicate that does not depend on how the platform chose to make room for the keyboard.
- Position corrections that are owned by the element the user is interacting with, not by whatever happens to be topmost.

**Non-Goals:**

- Any change to the tab bar, its keyboard rules, or `tabBarBottomInset()` (#358 owns them).
- The same page-lifecycle blind spot in `src/shell/desktop-viewport.ts` and the terminal panel's `viewportSizer` — real, but out of scope; recorded as a follow-up.
- Rewriting the anchor model, the pinned-track markup, or the question form's structure.

## Decisions

**D1 — A foreground resync, applied three times.**
Add a `resync` handler bound to `document` `visibilitychange`, window `pageshow`, and window `focus`. It calls `apply()` immediately, again on the next animation frame, and once more after a short settle timeout, cancelling any resync still outstanding. Three passes because the failure is a missing notification, not a late one: iOS restores the page with the keyboard already dismissed and fires no visual-viewport `resize`, and the values it reports at the moment of the transition are not yet the values it will report a frame or two later. The unchanged-value guard from D4 makes the extra passes free when nothing moved.
*Alternative:* poll the visual viewport while the tab is visible — rejected: a permanent timer for a transition that happens a handful of times per session.

**D2 — Suppressed corrections are replayed, not dropped.**
`apply()` already withholds `requestCorrection()` while `document.visibilityState === "hidden"`. Record that a correction was withheld and replay it on the first apply that finds the page visible, then clear the flag. One flag, not a queue: corrections are idempotent requests for the coordinated owner to re-run, so replaying once is equivalent to replaying each.

**D3 — Keyboard detection uses the layout/visual height difference.**
`keyboardVisible = (layoutHeight − visualHeight) > max(80, tabBarInset)`. `occluded` keeps its existing role in `tabInset` unchanged. The pan offset tells us where the visible viewport sits, which matters for the inset; it tells us nothing about whether a keyboard exists. On the reported iPhone geometry (layout 844, visual 508, pan 266, tab bar hidden) the old predicate saw 70px and dropped `data-chat-keyboard` while the keyboard was up; the new one sees 336px. The existing unit assertions are all cases where `visualTop` is 0 or the tab bar is present, so they hold unchanged.
*Alternative:* lower the 80px threshold — rejected: the threshold exists to keep accessory bars and URL-bar collapse from being read as keyboards, and the pan can be arbitrarily large.
Pinch zoom is browser-owned, as in the desktop viewport controller: while the visual viewport scale differs from 1 by more than 0.01, retain the last normal-scale geometry and keyboard state and request no correction. A zoomed viewport is not evidence of a keyboard. Normal-scale measurements resume when zoom ends.

**D4 — One frame, and no write when nothing changed.**
Coalesce every listener into a single `requestAnimationFrame`-scheduled apply, cache the last written height and top, and skip `setProperty` when the value is unchanged. This closes the re-entrant loop directly: the controller observes the surface it resizes, so a write that changes nothing must produce no ResizeObserver callback with new values, and a write that does change something is one write per frame rather than one per pan event.

**D5 — While editing, a pan alone does not request a correction.**
When `html[data-chat-editing]` is set and only `visualTop` changed between applies, write the geometry but do not call `requestCorrection()`. A caret-tracking pan is the platform moving the window over an unchanged document; the reader did not ask for a new position. Height changes still request a correction while editing, because those genuinely resize the transcript. `data-chat-editing` is read here only as controller state — per the constraint it is not used as a CSS trigger.
Compare the actual visual height as well as the applied surface height: D10 keeps the latter fixed while answering, so it cannot distinguish a pure pan from a simultaneous keyboard resize and pan.
The suppression is touch-only: the first desktop apply after a mode switch must request its correction even if the previous touch geometry makes the change look like a pure pan.

**D6 — The question card claims the anchor before focus.**
The question `change` handler in `src/chat/ui.ts` calls `syncQuestionControl(input, true)`, which un-hides and focuses the custom editor. Call the coordinated owner's `beforeMutation(<card's `data-chat-item-id`>)` before that, so the pending correction holds the card being answered instead of the topmost visible item. This reuses the existing `preferredItemId` seam — the same one `ui.ts` already uses when expanding a `<details>` — rather than adding a new suppression path around focus. Pairs with D7: the touch fix stops the gesture from unpinning, the anchor hand-off makes the resulting correction land on the right card.

**D7 — Touch handlers exclude text controls, as the key handler already does.**
`touchStart` and `touchMove` gain the same `closest("input, textarea, select, [contenteditable=true]")` exclusion `keyDown` applies. A touch inside a text control is a caret placement or a selection drag, not a request to scroll the conversation, and `pause()` unpins and re-anchors.

**D8 — The pill's clearance is reserved by the timeline, in CSS only.**
`.chat-transcript-area:has(> #chat-requests-jump:not([hidden])) .chat-timeline { padding-bottom: 3.5rem; scroll-padding-bottom: 3.5rem; }`, placed beside the existing `.chat-latest:not([hidden]) + .chat-requests-jump` offset rule. `:has()` is already used in this stylesheet. The `scroll-padding-bottom` matters as much as the padding: scrolling a request into view must not park it under the pill either. Reserving space rather than moving the pill keeps the pill where it is documented to be — pinned at the right edge so the count cannot scroll away.
The implemented selector wraps the pill id in `:where()` so its specificity cannot override D10's answering keyboard inset. This matters when a parent pill lacks `[hidden]` above a pushed drill-down but is visually suppressed by answering CSS.
*Alternative:* make the pill part of the flow — rejected: it would push the composer in exactly the layout that has no room for it.

**D9 — The background-task list joins the pinned-track budget.**
`#chat-background-tasks-items` is added to the `max-height: 8.5rem; overflow-y: auto` cap and to the `html[data-chat-keyboard]` hide rule, alongside the task list and subagent list. It is a pinned track by construction and was simply missed; leaving it out means a track that can grow without bound in a column whose only shrinkable child is the transcript.

**D10 — The keyboard covers the chrome while a request is answered.**
`syncEditingFocus` also toggles `data-chat-answering` on `<html>` when the focused text control sits inside a request card (`.chat-request` / `[data-question-form]`). While it is set on touch, the chat surface keeps the *layout* viewport height (`window.innerHeight`) instead of shrinking to the visual viewport; its top still follows the visual viewport's offset. The composer, the five pinned tracks (`#chat-task-list`, `#chat-subagents`, `#chat-background-tasks`, `#chat-reverted`, `#chat-queue`) and the Latest button therefore stay laid out where they are and the software keyboard slides up over them — they are literally under the keyboard, and they reappear as it dismisses. If the keyboard is already open when the request field takes focus (the user was in the composer), the surface's height transitions (~250 ms) so the bottom chrome visibly slides down under the keyboard rather than jumping. The header stays visible at the top. Only `#chat-requests-jump` — the outstanding-request pill, which yields anyway under D12 — and the prompt rail, which captures touches beside the field, are hidden while answering; nothing else is taken out of the layout. No tab-bar rule is needed (already hidden under `data-chat-editing`), and nothing in `styles.css` ~8020–8045 or `src/shell/tab-bar.ts` is touched. Once the keyboard geometry settles, the focused control is brought inside the visible viewport through the coordinated owner — it is the only automatic position writer, so no raw `scrollTop` or `scrollIntoView` on the nested timeline. *Tap safety:* the request's submit and cancel controls get the touch `pointerdown` `preventDefault()` the send button already has, so tapping them does not blur the field first and reflow the chrome back under the finger.
Because the timeline now runs on under the keyboard and a scroller cannot be scrolled past its own bottom edge, the timeline reserves the covered strip (`--chat-keyboard-inset`, written by the viewport controller as the surface height below the visible band) as bottom padding while answering — otherwise a request at the very end of the conversation could never be lifted into the band.
**Tap-safety correction after browser review:** the `pointerdown` guard described above is superseded by a `mousedown` guard. WebKit suppresses the touch-generated click when pointerdown is cancelled, so the earlier guard prevented Answer/Reject from activating. Keep focus stable without cancelling the touch pointer event.
*Alternative:* hide the chrome outright — rejected after the field test: the disappearance reads as loss, not as making room. Letting the keyboard cover it says where the chrome went, and dismissing the keyboard brings it back by itself.

**D11 — 16 px on the custom-answer input in touch mode.**
The same rule family as `#chat-input` and the configuration dialog: iOS zooms on focus for any text control under 16 px; pinning the size is the only reliable opt-out.

**D12 — The pill yields to intersection.**
`syncOutstandingRequests` keeps an `IntersectionObserver` rooted at the timeline on the current target card and sets `hidden` only while the card is genuinely on screen: at least half of it showing, or — for a card taller than the band — at least half the visible band filled by it. A sliver crossing the edge leaves the answer field and the Answer/Reject controls unreachable, and the pill is the way back to them, so intersection alone is the wrong test; the observer is given dense thresholds (`0`…`1` in twentieths) so the rule is re-evaluated as the card scrolls rather than only as it enters and leaves. While a subagent drill-down is pushed the parent card still intersects the parent timeline underneath it but cannot be reached there, so the pill does not yield to it — that is what keeps a parent request visible over the pushed screen. The count is unchanged when the pill does show, and the reservation from D8 stays for the case where it is shown over a different request.

**D13 — The revealed position is held while answering.**
While `data-chat-answering` is set, the coordinated owner holds the timeline
at the position the reveal established: any scroll it did not write itself —
WebKit's own autoscroll as a caret or selection handle is dragged to the edge
of the answer field, an accidental pan — is undone on the next coordinated
frame, and the hold is released when focus leaves the request. The undo
re-runs the reveal rather than restoring the recorded `scrollTop`, so the
minimal move is recomputed against the current layout — with the band's bottom
clamped to the visual viewport's bottom (`offsetTop + height`) rather than the
timeline's own, which under D10 now extends beneath the keyboard — and the
field lands in view even when content above it changed height; a new reveal — the one the
viewport controller asks for when the keyboard height changes — re-establishes
the held position the same way. A held scroll speaks for nobody: it must not
pause following or re-anchor, so it takes none of the unpinning path an
upward gesture takes.
*Alternative:* `overflow: hidden` or `touch-action: none` on the timeline
while answering — rejected: WebKit's selection autoscroll ignores both, it
scrolls the container while the caret is dragged regardless. A JS hold is also
the smaller idea here: this owner is already the only automatic position
writer for the scroller, so defending a position it just wrote is an extension
of what it does rather than a new mechanism. It is a standing mode
(`hold(element)` / `release()`) rather than an option on the one-shot
`reveal(element)`, because a reveal is consumed by the frame that serves it
while a hold outlives it and has to be ended by name.
The hold follows the focused element's identity, not just the answering boolean:
a direct transfer between request fields releases the old owner and holds the
new field. Hiding the surface cancels the hold and clears its tracked identity;
on foreground return, retained request focus reinstalls the hold even without a
new focus event. Ordinary viewport corrections remain one-shot reveals, so they
do not reinstate a hold released by an explicit scroll gesture.
After parent and child paints, reconcile a removed focused answer control even
when WebKit emits no `focusout`. The scroll owner also rejects a held target
outside its scroller. Holds remember the reader's previous follow intent and
restore it on release/cancellation; a reader who was unpinned remains unpinned,
and an explicit pause or Latest action ends the hold. Automatic snapshot refresh
reinstates a hold only if that field actually held its owner before cancellation,
not merely because the same input still has focus. Touch drags from question
radio/checkbox choices remain transcript gestures; only text-editing controls
are excluded. The request action focus guard runs on `mousedown`, not
`pointerdown`: cancelling touch pointerdown suppresses WebKit's compatibility
click and prevents Answer/Reject activation.

**D14 — The held field sits at the bottom of the band.**
While the hold is in force the reveal does not merely put the field *inside*
the band, it aligns the whole *extent* to the band's bottom. The extent is the
answer field together with the row that carries its submit and cancel controls
(the `.chat-request-actions` of the same `form[data-question-form]`), and the
band's bottom is the visible viewport's bottom less the timeline's
`scroll-padding-bottom`; the move is clamped by the scroller's range like every
other correction, so a conversation with nothing left to scroll simply stops
where it stops. The transcript therefore fills everything above the question
and no empty strip is left between the Answer/Reject row and the keyboard's
edge. If the extent is taller than the band its *top* is aligned instead:
scrolling the question's own top out of view to chase its buttons would hide
what is being answered in order to show how to answer it. `reveal(element,
{ extent, align })` carries both as options — `align: "nearest"`, today's
minimal move, stays the default for every other caller, and `hold()` passes
`align: "end"`. The end alignment is touch-only — the caller passes `nearest`
in desktop mode — because nothing covers the chrome there: without a keyboard
there is no band to press the question against, and moving a card the reader
can already see would be a jump bought for nothing. The custom editor is focused with `preventScroll: true`,
because this owner reveals it itself: WebKit's own focus scroll only adds a
jump the owner then has to correct.
*Why D13's minimal move is not enough:* it moves only as far as it must, so a
field that WebKit's focus scroll — or the user's own pan — already left high in
the band asks for no move at all, and the hold has no reason to move it either.
That is the ~200 CSS px gap between the Answer/Reject row and the keyboard
reported from the iPhone field test. The bottom of the band is the one position
that is stable under both the platform's initial scroll and the hold's later
defence of it.
*Alternative:* keep `nearest` and pad the timeline so the minimal move lands
lower — rejected: padding moves the resting place of every card in the
conversation to fix the resting place of one, and it cannot pull a field
*down* that the platform already scrolled too far up.

## Risks / Trade-offs

- [The two iOS mechanisms are hypotheses that browser tests cannot confirm — that iOS suppresses the visual-viewport `resize` across a background transition, and that the fixed-top surface and the pan form a feedback loop] → the e2e tests fake `visualViewport` and drive the exact event sequences, which proves the code responds correctly to that sequence; only the manual iPhone Safari and installed-PWA checklist confirms the sequence is the one iOS produces. Both are flagged in tasks.md as device-only.
- [A third apply on a settle timer could fight a user gesture that started in between] → the unchanged-value guard means it writes only if the geometry actually differs, and the resync is cancelled and rescheduled by any later transition.
- [Suppressing the correction on an editing-time pan could strand the reader if a height change is delivered as pan-only] → the suppression is scoped to applies where the height is identical to the last one; any height movement still corrects.
- [Hiding the background-task list while the keyboard is up removes visible state] → identical to the treatment the task list and subagent list already receive, and the track's summary line remains.
- [`:has()` support] → already relied on elsewhere in this stylesheet, including in the touch keyboard rules; no new baseline.
- [D3 changes a predicate other rules depend on] → `data-chat-keyboard` gates the pinned-track hide rules and the tab-bar rules #358 is rewriting. Making the predicate fire in a case where it previously did not is the fix; tests pin `tabBarInset = 0` so they do not encode the inset behavior #358 removes.
- [Changing the surface's height on focus is a layout move] → the height is transitioned (~250 ms) rather than switched, so the bottom chrome slides under the keyboard instead of jumping, and a reveal measured mid-transition is re-run by the resize path once the transition settles; the transcript's own scroll position is held by D6's anchor hand-off, and D10's tap safety keeps submit/cancel taps where the finger is.
- [Intersection gating flickers as the card scrolls past the edge] → observe with a small threshold and switch on the observer's boolean, not per-frame geometry.
- [While the answer field has focus the reader cannot scroll the transcript: the hold undoes their scroll along with the platform's] → blurring the field, which a tap outside it does, releases the hold, and while answering the visible band is the card being answered anyway. An explicit upward gesture on the transcript still reaches `pause()`, which cancels pending work and ends the hold with it.

## Migration Plan

None — no stored state, no protocol, no configuration. The `fix(chat)` title describes the correction, but the stable-to-stable release-note decision is pending the per-issue verification in [release-evidence.md](release-evidence.md) and task 6.5; the prior blanket `v0.7.0` reproduction claim was unsupported. Rollback is a revert of the change.

## Open Questions

- The settle delay in D1 is chosen to cover iOS's post-restore reflow; the exact value can be tuned from the device checklist without changing the specs, the approach, or the task breakdown.
