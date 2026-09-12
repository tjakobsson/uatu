## Why

A conversation near its plan cap fills with rows nobody asked for: "Approaching your 7-day (overage included) rate limit (77% used). Resets 06:00." arrives as a fresh timeline notice for every rate-limit event, keyed by the event's uuid, so the same standing is restated between turns and pushes the actual work off screen. The composer already carries that standing — and the readout beside it already lists every window, its percentage, and its reset — but the badge is an inert `<span>` the reader cannot open, and the plan chip next to it says nothing about being rate limited.

Two surfaces for one fact, and the noisy one is the one that cannot be opened.

## What Changes

- A rate-limit standing stops being timeline content. It becomes data the composer consumes and the timeline never shows, the way a context report already is.
- The standing is carried as one item updated in place rather than one per event, so a conversation held at the same standing for an hour accumulates a single entry instead of dozens.
- The separate rate-limit badge is removed. The plan chip absorbs it: the standing raises the chip's level, a rejection says so in the chip's own words, and the chip opens the readout that already names every window and when it resets.
- Where a login reports no plan but is rate limited, the chip appears for the standing alone, so the fact never has nowhere to go.
- The standing keeps its spoken announcement when it changes — folding the badge into a `<summary>` must not cost a screen-reader user the notice.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `claude-code-chat`: a rate-limit warning or rejection is presented in the composer's plan summary and its readout rather than as timeline content, and is stated once as a standing rather than restated per event.

## Impact

- `src/chat/claude/normalization.ts` (how the standing is minted), `src/chat/composer-status.ts` (how it is read and labelled), `src/chat/timeline-renderer.ts` (what is not rendered), `src/chat/ui.ts` and `src/index.html` (the chip, the removed badge), `src/styles.css` (the badge's rules).
- Colocated unit tests for each; a browser regression covering a warning, a rejection, and the readout the chip opens.
- No wire, storage, or dependency change. `NoticeItem.code` keeps its `refusal-fallback` value and its rate-limit values, so nothing outside the chat surface changes shape.
- The rate-limit surfaces have not appeared in a stable release, so the PR carries a Release Please override per the project's release-note discipline.
