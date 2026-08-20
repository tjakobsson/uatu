## Context

See `proposal.md` — Why. Three facts about the current stylesheet shape the
approach.

**Chat has no type scale of its own.** `body` sets no `font-size`, so Chat
inherits the browser's 16px root. An assistant message renders into
`.markdown-body`, and the vendored `github-markdown-css` pins that at an
absolute `font-size: 16px`, which no parent-level scale can reach.

**Most chat type is root-relative.** Within the chat block of `src/styles.css`,
30 rules size type in `rem` against 4 in `em`. A scale declared on the surface
would not reach any of the 30.

**The surface tiers collapse in dark mode.** `--surface-raised`,
`--surface-subtle`, and `--surface-muted` all resolve to `#161b22` under the
dark scheme, so re-pointing the tracks at an existing token differentiates them
in light mode and does nothing in dark.

## Goals / Non-Goals

**Goals:**
- One declared scale that every chat region actually inherits, vendored
  Markdown included.
- A tracks tier that reads in both schemes and without colour.
- One file touched, so this runs beside the other wave 1 changes.

**Non-Goals:**
- Spacing, radius, or colour anywhere else in Chat.
- Any TypeScript, markup, or transported-data change. If this change needs one,
  the scope was wrong.

## Decisions

**Declare the scale on `.chat-surface`; convert the chat block's `rem` font
sizes to `em`.** A `font-size` on the surface is the only declaration that
composes with the desktop split, touch mode, and native WebView zoom without
any of them needing to know about it. The conversion is what makes it real: a
`0.78rem` badge ignores the surface and would drift out of proportion the
moment the scale moves. Alternative considered: leave `rem` and restate every
size at the new scale — the same edit count, and the next scale change repeats
all of it.

**Override `.markdown-body` inside the chat surface only.** `.chat-surface
.markdown-body` is specificity 0,2,0 against the vendored rule's 0,1,0, and
`src/styles.css` already sits after the `@import`, so it wins without
`!important` — the same specificity-matching discipline the file's existing
`.markdown-body` mono-font override documents. github-markdown-css sizes its
internals in `em` and `%`, so overriding the base carries proportionally
through the whole rendered document.

**Give the tracks an explicit tier token.** Add a token defined as a
`light-dark()` pair that differs from `--surface-raised` in both schemes,
rather than re-pointing at `--surface-subtle`, which is identical to
`--surface-raised` in dark. Colour alone would not satisfy the requirement
anyway: the tracks keep their structural cue — pinned below the transcript,
above the composer, behind a disclosure caret — so the distinction survives
greyscale and forced-colours.

## Risks / Trade-offs

- **A global scale change makes every chat region smaller at once, including
  ones nobody complained about.** → Verify against the running app at desktop
  split, collapsed split, and touch widths before running any suite.
- **`em` conversion compounds where chat rules nest.** A `0.85em` inside a
  `0.875em` summary is now 0.74 of the surface, not of the root. → Convert with
  the nesting in view, and check the smallest surviving text
  (`chat-activity-status`, `chat-command-description`) against the app rather
  than against the number.
- **This change rewrites the chat block of `src/styles.css`, and the other four
  wave 1 changes each touch that file lightly.** → Land it last, or land it
  first and fast. Landing it in the middle is what produces four conflicts.
