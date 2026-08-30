## 1. Isolated Prototype

- [x] 1.1 Add a self-contained prototype under `tests/prototypes/navbar-visual-spike/` with static representative workspace content, a visible spike watermark, and no imports from or edits to `src/`; verify the prototype loads without network requests, console errors, or browser-storage writes.
- [x] 1.2 Implement the narrow navbar and in-memory controls for Files, Preview, Chat, Terminal, Follow, Change Overview, Git Log, and Settings; verify each control exposes a stable label/state selector and produces the surface combination described in `design.md`.
- [x] 1.3 Implement the Files/Search side-panel views, mutually exclusive anchored contextual panels, illustrative documentation-only setting, activity/attention treatments, and no-primary-surface launcher; verify all states can be reached and reversed solely through prototype controls.
- [x] 1.4 Style realistic default and constrained desktop layouts using fixture content representative of current Files, Preview, Chat, Terminal, repository status, and commit history; verify content remains legible at the planned screenshot viewports and no collapsed Chat strip appears.

## 2. Screenshot Driver

- [x] 2.1 Add a spike-specific Playwright file under `tests/e2e/` that loads only the isolated prototype and is skipped unless `UATU_VISUAL_SPIKE=1`; verify the normal `bun test:e2e` collection does not execute or generate spike screenshots by default.
- [x] 2.2 Drive the nine desktop interaction states and one constrained-width state listed in `design.md`, resetting prototype state between independent sequences; verify assertions confirm visible surfaces, selected controls, active accents, and open contextual panels before each capture.
- [x] 2.3 Write deterministic PNGs to `openspec/changes/navbar-visual-spike/screenshots/` with ordered descriptive names and generate a concise screenshot index that records the click sequence represented by each image; verify all ten expected images and the index exist after the spike command completes.

## 3. Review Evidence

- [x] 3.1 Run `UATU_VISUAL_SPIKE=1 bunx playwright test tests/e2e/navbar-visual-spike.e2e.ts --workers=1`, inspect every generated image for clipping, overlap, accidental production chrome, and inconsistent selected/active treatments, and rerun after correcting prototype-only defects until the command passes.
- [x] 3.2 Record neutral observations and unresolved UX choices beside the screenshot index, including all-primary-surfaces-hidden behavior, Files/Search relationship, selected-versus-active legibility, popover sizing, and documentation-only wording; verify the notes distinguish observed evidence from recommendations and establish no product requirement.
- [x] 3.3 Run `bun run typecheck` and the spike-specific Playwright command, then confirm `git diff -- src` is empty so the visual study has not changed production code.

## 4. Handoff And Disposal

- [x] 4.1 Present the ordered screenshots and interaction sequences for review, then capture the user's accepted, rejected, and still-open directions in the screenshot index without implementing them; verify every reviewed direction has one of those three dispositions.

## 5. Settings Modal Comparison

- [x] 5.1 Replace the rejected compact Settings popover with a centered fixture-only modal containing a category rail, representative settings capacity, the illustrative documentation-only control, and reversible prototype controls; verify the modal overlays rather than resizes the workspace and no state is persisted.
- [x] 5.2 Update screenshot 07 and its Playwright assertions for the centered Settings modal while preserving the ordered ten-image matrix; verify the opt-in spike command passes and the screenshot index records the comparison and review disposition.
- [x] 5.3 Present the revised Settings screenshot for review and record its Accepted, Rejected, or Still open disposition in the screenshot index without implementing production behavior.

## 6. Workspace Context Comparison

- [x] 6.1 Replace the separate Change Overview and Git Log navbar controls and popovers with Files, Search, Changes, and History views in the shared Workspace panel; verify every view remains scoped to the active fixture context and is reachable and reversible through prototype controls.
- [x] 6.2 Add an in-memory workspace switcher with several visibly open repository/worktree fixture sessions and one active context; verify selecting an alternate context updates representative panel and preview identity without network requests or browser-storage writes.
- [x] 6.3 Expand the Playwright driver and ordered evidence from ten to twelve images for the revised matrix in `design.md`; verify assertions cover panel views, switcher visibility, active fixture context, and the preserved surface states before every capture.
- [x] 6.4 Run the opt-in spike command, inspect all twelve images, update the screenshot index with neutral observations and dispositions, run `bun run typecheck`, and confirm `git diff -- src` is empty.
- [x] 6.5 Present the revised Workspace-panel and switcher screenshots for review and record each direction as Accepted, Rejected, or Still open without implementing production behavior.

## 7. Compare Target Comparison

- [x] 7.1 Replace the spike-only Changes summary with the existing Since base and Since last commit segmented control plus repository identity and Branch, Commit, Status, Base, and Changes facts; verify both modes are reversible in memory and update the Changes anchor without network or storage activity.
- [x] 7.2 Expand the ordered Playwright evidence to thirteen images with separate Since base and Since last commit captures; verify assertions cover active segments, unchanged Base evidence, and `vs main` versus `vs HEAD` anchors.
- [x] 7.3 Run the opt-in spike command, inspect all thirteen images, update the screenshot index, run `bun run typecheck`, and confirm `git diff -- src` is empty.
- [x] 7.4 Present both comparison screenshots for review and record the direction as Accepted, Rejected, or Still open without implementing production behavior.

## 8. Disposal

- [ ] 8.1 After a separate production proposal captures any accepted direction, remove the prototype, spike-specific Playwright driver, review copies, and generated screenshots together; verify no production file or main capability spec depends on a removed spike path.
