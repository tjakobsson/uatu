## Why

Chat configuration currently shares one naturally wrapping composer row with context, lifecycle status, and the trailing action. On desktop, changing panel width or routine state can move individual controls between rows, while a long native model select makes finding one model among a large OpenCode inventory unnecessarily slow.

## What Changes

- Replace the wrapping composer controls with one stable, non-wrapping action rail whose context readout, configuration trigger, fixed-footprint status, and Send/Cancel action have deliberate layout roles.
- Move model, mode, and reasoning selection out of the composer into one unified configuration picker.
- Present that picker as a Chat-panel-constrained anchored panel on desktop and as a visual-viewport-aware bottom sheet in touch mode, without nested configuration sheets.
- Add local model search across model name, provider name, provider id, and model id, with provider grouping, result counts, selected and unavailable states, keyboard navigation, and focus restoration.
- Preserve staged conversation configuration semantics: picker changes update the displayed selection immediately and travel with the next prompt.
- Replace variable-width routine status text with a fixed-size, accessible state indicator while keeping actionable failures visible as explanatory text outside the stable rail.
- Add accessible copy actions for completed assistant Markdown and fenced code blocks, with fixed-geometry success and failure feedback.
- Do not add attachment, microphone, profile, auto-accept, or other controls for unsupported Chat behavior.
- Do not change touch safe-area ownership; the duplicate composer inset was already removed and is outside this change.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `opencode-chat`: Chat gains a stable composer action rail, an adaptive searchable configuration picker, fixed-footprint routine status, and scoped assistant-content copy actions.

## Impact

- Chat shell markup, configuration and status state handling, timeline rendering, clipboard behavior, focus management, and responsive styling.
- `src/index.html`, `src/styles.css`, `src/chat/ui.ts`, Chat timeline rendering, and shared clipboard utilities.
- Chat renderer, configuration, shell, accessibility, desktop-layout, and touch-layout tests.
- No workspace API shape, OpenCode provider behavior, persisted conversation data, dependency, or safe-area changes.
