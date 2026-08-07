## Context

The touch keybar currently handles every affordance on `pointerdown` and calls `preventDefault()` so tapping a key does not move focus away from xterm's helper textarea and dismiss the software keyboard. That is correct for raw sequence keys, but the same handler immediately invokes `navigator.clipboard.readText()` for Paste. The web activation model grants transient activation on `pointerup` for non-mouse pointers, so iOS can reject the earlier read; the rejection is swallowed and the control appears inert.

The keybar also forwards successful clipboard text through `TerminalPanelHandle.sendInput()`. That raw WebSocket path bypasses xterm's `paste()` behavior, including newline normalization and bracketed-paste wrapping. Keyboard clipboard handling already uses `term.paste()`, establishing the desired semantic path.

Constraints:

- A touch press must not move focus away from xterm or collapse the software keyboard.
- Clipboard access must begin synchronously from an activation accepted by iOS Safari.
- A touch normally generates both pointer and click events; one gesture must not paste twice.
- The control is a real button and must work with Enter and Space.
- Automated Chromium coverage cannot substitute for a real WebKit device check of clipboard authorization.

## Goals / Non-Goals

**Goals:**

- Make keybar Paste work on iPhone and iPad Safari while retaining terminal focus.
- Give touch and keyboard activation one exactly-once semantic action path.
- Match xterm's native and keyboard paste semantics.
- Degrade safely when clipboard reading is unavailable, denied, empty, or throws.
- Cover deterministic behavior automatically and record the real-device acceptance gate.

**Non-Goals:**

- Redesign the terminal panel, keybar layout, or terminal splitting model tracked by #180.
- Add a keybar Copy control or change OSC 52 and desktop clipboard shortcuts.
- Add browser-specific user-agent detection or a Clipboard API fallback for insecure origins.
- Introduce user-visible error UI for clipboard denial.

## Decisions

### D1: Separate focus preservation from semantic activation

Every keybar button keeps its `pointerdown` listener and `preventDefault()` focus guard. Raw sequence and sticky-Ctrl actions continue to execute there. Paste does no clipboard work on `pointerdown`; its action runs from the button's `click` event.

A real touch click is dispatched after the non-mouse `pointerup` that grants transient activation, while keyboard Enter/Space also invokes the button's click activation behavior. One click handler therefore covers both input modes without coordinating separate `pointerup`, `touchend`, and keyboard handlers.

Alternative considered: perform Paste directly on `pointerup`. Rejected because it requires a second keyboard handler and duplicate suppression against the subsequent click, creating more state for no benefit.

### D2: Keep Paste exactly once by owning it only from click

The Paste action has one execution event: `click`. Its `pointerdown` handler only prevents focus transfer. No paste work runs from `pointerup` or `touchend`, so the browser's normal pointer sequence cannot invoke it twice.

Alternative considered: timestamp or pointer-id deduplication across pointerup and click. Rejected as unnecessary complexity when native button activation already unifies pointer and keyboard input.

### D3: Add a semantic paste seam to each terminal pane

`TerminalPanelHandle` gains a `paste(text)` operation that delegates to the mounted xterm instance's `term.paste(text)`. The panel's keybar callback resolves the active attached pane, invokes that semantic operation, and restores/retains focus. Raw `sendInput()` remains the path for Esc, control bytes, arrows, and other keybar sequences.

This preserves xterm's newline conversion and bracketed-paste behavior and aligns keybar Paste with existing Ctrl+V handling.

Alternative considered: reproduce bracketed-paste framing in the keybar or panel. Rejected because xterm already owns terminal mode state and paste normalization.

### D4: Contain every clipboard failure at the action boundary

The click action guards the clipboard invocation itself as well as the returned promise. Missing API support, a synchronous throw, promise rejection, and empty text all produce no paste. Production keeps the Clipboard API dependency injectable so unit tests can exercise every path.

The action remains silent, matching the existing terminal clipboard failure convention. An insecure origin cannot be repaired in application code; the absence of a fallback is deliberate.

### D5: Split automated semantics from real-device authorization

Unit tests drive pointerdown and click independently to prove that reads do not start on press, one click performs one read/paste, keyboard-generated click uses the same path, and all failure forms are contained. Client/panel tests prove that semantic Paste reaches `term.paste()` rather than raw socket input. Chromium E2E grants clipboard permissions, seeds text, activates the visible mobile keybar control, and observes terminal input.

A manual iPhone/iPad Safari check remains an explicit completion task because the current Playwright project is Desktop Chrome with touch emulation and cannot validate WebKit's permission callout or software-keyboard focus behavior.

## Risks / Trade-offs

- [Risk] Preventing `pointerdown` default could suppress click in a browser-specific edge case. → Verify Safari on physical iPhone and iPad; keep the handler on a native button rather than synthesizing events.
- [Risk] Refocusing after an async clipboard result could move focus unexpectedly if the user changes panes while permission UI is open. → Resolve the active attached pane at paste time and use the panel's existing active-pane semantics; do not retain a stale pane handle from press time.
- [Risk] E2E clipboard permissions may prove Chromium wiring while masking Safari behavior. → Treat real-device Safari verification as a release acceptance task, not optional evidence.
- [Trade-off] Silent failure remains hard to diagnose on insecure origins. → Preserve current product convention and avoid expanding this focused bug fix into clipboard-status UI.

## Migration Plan

No data or protocol migration is required. Deploy as a client-only behavior change. Rollback consists of reverting the keybar event split and semantic pane paste seam; server and persisted terminal state remain compatible.

## Open Questions

None. If real-device verification shows native touch selection Copy is also broken, capture it as a separate requirement/change rather than expanding #189 during implementation.
