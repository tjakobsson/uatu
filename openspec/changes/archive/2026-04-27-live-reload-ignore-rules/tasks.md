## 1. Implementation (already shipped on `view-all-non-binary-files`)

- [x] 1.1 In `src/server.ts` `handleWatcherEvent`, evict the cached `IgnoreMatcher` for the parent dir-root when the event's basename is `.uatuignore` or `.gitignore`
- [x] 1.2 Add unit test `src/server.test.ts` → "editing .uatuignore at runtime reapplies the new patterns" exercising both add-pattern (file disappears) and remove-pattern (file reappears) directions

## 2. Spec validation

- [x] 2.1 Run `openspec validate live-reload-ignore-rules --strict` — change-level structure
- [x] 2.2 Run `openspec validate --specs --strict` — confirm the modified `document-watch-browser` spec deltas parse and round-trip cleanly
- [x] 2.3 Run `bun test src/server.test.ts -t "editing .uatuignore at runtime"` to confirm the spec scenario is covered by the existing test

## 3. Archive

- [x] 3.1 After review/merge, archive this change under `openspec/changes/archive/<date>-live-reload-ignore-rules/`
