# Tasks — declutter-sidebar-defaults

## 1. Default visibility

- [x] 1.1 Flip the `git-log` default to `visible: false` in `src/shell/state.ts` and verify (or add) the pane-state reader's tolerance for unknown stored pane ids, with a unit test covering a stored `selection-inspector` entry
- [x] 1.2 Update sidebar/pane unit tests that assume Git Log is visible by default

## 2. Selection Inspector removal

- [x] 2.1 Delete `src/sidebar/selection-inspector.ts`, `selection-inspector-mount.ts`, and `selection-inspector.test.ts`; remove the init call from `src/app.ts`
- [x] 2.2 Remove the pane's markup from `src/index.html`, its entry from the pane defs and default state in `src/shell/state.ts`, and any handling in `src/sidebar/panes.ts`
- [x] 2.3 Remove selection-inspector CSS from `src/styles.css` and sweep the repo for remaining references (`rg -i "selection.?inspector"`), keeping the `uatu-source-pre` marker class and its word-wrap consumer untouched
- [x] 2.4 Update or remove e2e coverage referencing the pane; assert the panes menu no longer lists it and boot succeeds with legacy stored pane state present

## 3. Verification

- [x] 3.1 `bun test` and `bun test:e2e` green; manually confirm a fresh profile shows only Change Overview + Files while a profile with stored state keeps its arrangement

Implementation note: flipping the git-log default exposed a latent bug — the
tree library writes `display: flex` as an inline style on its host, which
outranks the UA's `[hidden]` rule, so a "hidden" tree could absorb spare
Files-pane height and render over the empty-state message. Fixed with
`.tree[hidden] { display: none !important; }` (the only way to beat a
third-party inline style); covered by the existing files-pane-filter e2e.
