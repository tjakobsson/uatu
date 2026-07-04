# Tasks — fix-pane-fit-padding-clip

## 1. CSS fix

- [x] 1.1 In `src/styles.css`: remove `padding: 0.4rem 0.6rem` from
      `.terminal-pane-host` and add it to `.terminal-pane-host .xterm`;
      keep `overflow: hidden` and `position: relative` on the host. Update
      the comment to note FitAddon subtracts the `.xterm` element's padding,
      so the inset MUST live there.
- [ ] 1.2 Manual smoke with `bun run dev`: single pane, bottom and right
      dock, split panes, drag resizers to odd positions — bottom row (prompt
      line) stays fully visible in every configuration.

## 2. Regression coverage

- [x] 2.1 Add an E2E test (e.g. in `tests/e2e/terminal.e2e.ts` or a new
      `terminal-fit.e2e.ts`): sweep several panel heights via resizer drags
      (odd pixel values), assert `.xterm-screen`'s bounding box fits inside
      `.terminal-pane-host`'s content box (bottom edge included) for a
      single pane and for a split, in both docks.
- [x] 2.2 Run the existing terminal E2E suite (first-paint, lifecycle,
      persistence, font) to confirm the padding move does not regress
      first-paint fit or reattach behavior.
- [x] 2.3 Run `bun test` and the full `bun test:e2e`; fix regressions.

## 3. Docs and spec sync

- [x] 3.1 Validate the change (`openspec validate fix-pane-fit-padding-clip`).
- [x] 3.2 Archive the change once it has landed (tested + merged).
