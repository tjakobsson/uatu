# Tasks — fix-desktop-titlebar-regressions

## 1. Reproduce and root-cause the drag regression

- [x] 1.1 Build the app from main (`bun run build`, then the Xcode project)
      and reproduce with a fixed recipe: fresh window, folder open, no
      split, terminal closed — try dragging the titlebar strip above the
      sidebar, preview, and toolbar gaps; record which regions (if any)
      drag. Then vary one factor at a time: split open, terminal docked
      right, second native tab.
- [x] 1.2 Rebuild at `ad839fd` (v0.3.0) and repeat the recipe. If drag
      works there, bisect the two functional commits (`00d0072`,
      `9d036c3`) to name the culprit; if drag is broken at `ad839fd` too,
      attribute to an OS/WebKit change and note the macOS build.
- [x] 1.3 If `9d036c3` is the culprit, isolate which of its desktop-side
      edits triggers it (key monitor rework vs `.textEditing` CommandGroup
      replacement vs FindBar wiring) by reverting each in isolation.

## 2. Fix titlebar dragging

- [x] 2.1 Apply the minimal fix for the identified cause (or, for an
      external cause, add the transparent titlebar-region drag affordance
      per design D2, kept behind toolbar controls).
- [x] 2.2 Verify dragging works at every horizontal position: above the
      sidebar, preview, right-docked terminal, and split-browser pane —
      with and without the split open, and with a native tab bar visible.
- [x] 2.3 Verify no hit-testing collateral: back/forward buttons, split
      toggle, traffic lights, and double-click-titlebar-to-zoom all still
      work; text selection and terminal drag-selection in the page are
      unaffected.

## 3. Fix the terminal top-strip rendering

- [x] 3.1 Keep the dock-right panel's opaque surface out of the covered
      strip (`background-clip: content-box` or margin-top per design D3),
      scoped to `html.uatu-desktop-host`.
- [x] 3.2 Exclude the terminal column from the frost overlay when a
      dock-right terminal is visible (cap the frost's `right` with a
      panel-width variable via `body:has(...)`), covering the minimized
      rail state too.
- [x] 3.3 Verify visually in the app: dock-right normal / minimized /
      fullscreen, terminal find bar open, sidebar collapsed, light and
      dark system themes — strip above the terminal reads like the strip
      above the sidebar, boundary stays sharp.
- [x] 3.4 Verify no regression outside the desktop: dock-bottom layout,
      plain browser, and PWA render exactly as before (no
      `uatu-desktop-host` leakage).

## 4. Specs and wrap-up

- [x] 4.1 Run `bun test` and the affected e2e suites (`terminal`, `find`)
      to confirm no web-side regressions.
- [x] 4.2 Validate the change (`openspec validate
      fix-desktop-titlebar-regressions`) and record the root cause found
      in 1.2/1.3 in the design doc's Open Questions section.

Ship via PR as usual (conventional title, e.g. `fix(desktop): restore
titlebar dragging and clean the dock-right terminal strip`, with
before/after screenshots of the top strip) — not a checkbox, since it can
only be ticked after the PR itself lands.
