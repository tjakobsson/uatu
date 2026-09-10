# Design-reference alignment

Before/after evidence for realigning the implementation with the approved
reference in `design/hub-mobile/screenshots-refined/`.

`design-*` files are copies of the approved reference. `current-*` were
captured before the realignment; `after-*` after it.

| Aspect | `design-1` / `design-3` | `current-1`, `current-2` | `after-1`, `after-2`, `after-3` |
| --- | --- | --- | --- |
| Bar | One row: close, Hub, four surfaces | Two rows, `Preferences` above the tabs, no Hub | One row, Hub styled as a destination |
| Preferences | Sheet from Hub → Settings (`design-2`) | `Preferences` button opening a centred dialog | Button removed; bottom sheet with grabber and grouped controls |
| Preview controls | Pill: folder + `Files` │ `‹` `›` | Wide `Back to Files` `Previous` `Next` buttons | Pill matching the reference |
| Error state | Amber card above the pill (`design-4`) | Retry button inside the pill | Separate alert card above the pill |

Standalone has no Hub Settings page, so the sheet is reached there by holding
the navigation handle for 500ms, with `contextmenu` and `ContextMenu`/`Shift+F10`
as equivalent non-pointer routes. Under a Hub the sheet stays in Settings and
the bar is identical to the reference.

Regenerate the `after-*` captures with a short throwaway Playwright spec that
boots touch mode, opens the bar, and screenshots the page and
`#preview-file-navigation`; do not leave that spec in `tests/e2e/`.
