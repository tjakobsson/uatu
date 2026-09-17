## Why

The workspace file tree must respect the user's folder arrangement instead of reopening folders during background refreshes. UX review clarified that manually collapsing an ancestor of the active file means closing that document: selection and preview should clear, and Follow should turn off, rather than retaining an invisible active selection.

## What Changes

- Treat a manual collapse of any ancestor of the active file as explicit document deselection: clear the active document and preview, and disable Follow. Reopening the folder does not reopen the document.
- Keep that intentional empty state across background updates, filter transitions, reconnect/recovery, and page reloads. Explicit document navigation or enabling Follow resumes the normal selection flow. Existing startup defaults remain available when the user has not deliberately cleared selection.
- Leave the active document and Follow unchanged when an unrelated folder is collapsed. Programmatic expansion changes, path rebuilds, and filter transitions never count as manual deselection.
- Preserve surviving folders' open/closed state across All-to-All content and path-set refreshes, including expanded descendants beneath collapsed ancestors. Retain additive ancestor reveal for initial and genuinely new document selections.
- Replace the earlier hidden-selection restoration policy rather than add deselection on top of it. Keep the library responsible for folder state, row rendering, and keyboard navigation; observe user actions and use public APIs for application orchestration.
- Revise the browser and adapter regressions to cover empty-preview persistence, manual-input origin, and explicit resumption, with observable refresh-completion signals instead of fixed waits.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `document-tree`: Preserve manual folder state and define ancestor-collapse deselection, including empty preview, Follow-off, reload persistence, and the distinction between manual collapse and programmatic tree updates.
- `follow-mode`: Extend Rule A to include deliberate ancestor-collapse deselection while retaining exactly four authoritative rules; clarify intentional-empty behavior under Rule D and guard both selecting and deselecting against programmatic tree updates.

## Impact

- Tree adapter: manual-collapse observation, reveal decisions, reset-boundary expansion restoration, and removal of conflicting hidden-selection reconciliation.
- Shell/preview lifecycle: central deselection handling, selected-document state, live/recovery selection decisions, preview-load invalidation, empty rendering, and URL/history consistency.
- Client persistence/boot: remember deliberate deselection only in browser-local storage, scoped to the workspace/base path, and restore the empty preview without falling back to a default document. Existing remembered-document, Follow, and other personal preferences remain Hub-backed. Folder expansion itself is still not persisted across reloads.
- Verification: tree, selection-decision, persistence, and preview-load tests, plus document-tree, Follow, manual-selection, and Files-filter browser coverage on desktop and touch.
- No server protocol, public API, dependency, or desktop-native changes are expected. Follow's existing navigation rules remain unchanged except for this new explicit user action turning it off.
- Non-goals: persistent folder expansion, Changed-filter expansion redesign, tree virtualization work, touch-density redesign, and new folder-preview or ancestor-badge UI.

This revision supersedes the earlier requirement to keep a hidden file selected. Existing validation and research notes describe prior implementations; they do not establish completion of the revised behavior.
