## Why

[Issue #339](https://github.com/tjakobsson/uatu/issues/339) reports that the preview jumps to another file while Follow is off. This is the first priority: manual navigation must survive background file activity and reconnects across text, Markdown, images, and other selectable files.

## What Changes

- Preserve the manually selected file and its URL while Follow is off, including when the file temporarily disappears from the index or changes classification.
- Show an unavailable state for a missing selection instead of silently selecting another file; restore its preview if the same path becomes available again and the user has not navigated elsewhere.
- Prevent stale workspace rescans, preview requests, and programmatic tree callbacks from overriding newer state or user navigation.
- Preserve existing Follow-on behavior, intentional navigation, current-file refreshes, and independent clients.
- Add deterministic regression coverage for ordinary text files as well as images, rapid edits, replacement, deletion, delayed responses, and page recovery. Establish which sequence reproduces the reported generic bug rather than treating an image-only reproduction as resolution.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `follow-mode`: Manual selection remains authoritative through background updates, unavailable files, and asynchronous navigation completion.
- `document-watch-index`: Workspace refresh publication preserves scan ordering and coalesces overlapping work without losing eventual convergence.

## Impact

- Selection and recovery in `src/shell/selection.ts`, `follow.ts`, `events.ts`, and `history.ts`; preview load ownership in `src/preview/mount.ts` and `load-generation.ts`.
- Tree callback ownership in `src/sidebar/tree-view.ts` and workspace refresh scheduling in `src/server/watch-session.ts`.
- Focused unit, watcher integration, and browser regression tests. No new dependency, public API, or persisted-state migration is planned.
- Builds on the implemented `resilient-live-connections` change without changing its stream recovery guarantees or archiving it.
- Implement before `improve-chat-responsiveness`. Chat optimization and installed-app launch restoration are outside this change.
