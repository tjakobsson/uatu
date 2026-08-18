## 1. Resolved requests recede

- [ ] 1.1 In `src/chat/timeline-renderer.ts`, render a resolved permission's and question's outcome into its `<summary>` and leave the resources in the collapsed body
- [ ] 1.2 Style `[data-request-state="resolved"]` in `src/styles.css` as a receded one-line trace, replacing the bare opacity treatment
- [ ] 1.3 Confirm a pending request's presentation is unchanged
- [ ] 1.4 Cover it in `timeline-renderer.test.ts`: a resolved request states its outcome, keeps its resources, and is closed by default

## 2. The pending change in the card

- [ ] 2.1 Locate the diff a file-edit permission carries — the permission `metadata` or the pending tool's `SnapshotFileDiff` — in `src/chat/normalization.ts`, and keep it on the permission item (`src/chat/types.ts`)
- [ ] 2.2 In `src/chat/timeline-renderer.ts`, render that diff in `renderPermission`, reusing the timeline's `.chat-diff` presentation, where the approve/reject choices are
- [ ] 2.3 Show no diff when the permission carries none; never block approval on a diff
- [ ] 2.4 Parse the permission diff in `src/chat/validation.ts` and `src/chat/client.ts`
- [ ] 2.5 Cover it: an edit permission shows its diff, a command permission shows none

## 3. Contract and delivery

- [ ] 3.1 In `api/openapi.yaml`, add the diff field to the permission item schema
- [ ] 3.2 Coordinate the `workspaceApiRevision` bump with the branch's other wave-1 changes (one revision for the branch), and add the `api/CHANGELOG.md` section
- [ ] 3.3 Run the app: approve an edit and see its diff in the card; confirm a resolved card recedes
- [ ] 3.4 Run `bun test`, then `bun test:e2e`
