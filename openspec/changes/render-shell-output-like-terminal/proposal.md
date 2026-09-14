## Why

A shell command's output in Chat is rendered as escaped plain text, so the
ANSI sequences most tools emit (bun, cargo, git, test runners, anything with
`--color`) show up as literal `[32m` fragments, carriage-return progress bars
pile up as repeated lines, and column-aligned output wraps mid-token in a font
that is not the terminal's. Uatu already has a terminal with a palette and
font for exactly this text, one pane over. Separately, the activity chrome —
the working line, group summaries, and member rows — sits at the same faint
grey as every other secondary label, so steps are hard to tell apart from
each other and from the surrounding prose in both themes.

## What Changes

- A shell command's output (and any tool output that carries escape
  sequences) is rendered with its ANSI styling interpreted: 16-colour, 256-
  colour and truecolour foreground/background, bold, dim, italic, underline,
  inverse and strikethrough. Carriage-return overwrites and erase-line
  sequences are applied before rendering so progress bars and spinners
  collapse to their final state; any other control sequence is dropped
  rather than shown.
- Shell output blocks adopt the embedded terminal's look: its background,
  foreground, 16-colour palette (the `--terminal-*` variables) and font,
  with no mid-token wrapping — long lines scroll horizontally as they would
  in the terminal.
- The streaming tail and the bounded "show more" preview keep working on the
  rendered lines, not the raw bytes.
- Hostile content stays inert: escape handling never produces active markup.
- The activity chrome — the composer's working line, group summary lines,
  member row labels and subjects, the group's connecting rule and neutral
  dot — gets a dedicated colour token with higher contrast than `--text-subtle`
  in both light and dark, while staying visibly quieter than assistant prose.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `opencode-chat`: adds two requirements to the Chat surface — shell output
  is rendered as the terminal would render it, and activity chrome is legible
  and distinct from prose. The existing "Chat presents turns as readable
  conversation with inspectable activity" requirement stays as is; the new
  ones add to it. (The surface is shared by every agent; Claude Code's Bash
  output goes through the same renderer.)

## Impact

- New `src/chat/ansi.ts` (+ test): terminal-text → safe HTML segments.
- `src/chat/timeline-renderer.ts` — `renderActivityOutput` and the command
  branch of `toolBody` use it; running-tail and bounded-preview logic works on
  rendered lines.
- `src/styles.css` — `.chat-tool-terminal` block styled from the
  `--terminal-*` variables; `ansi-*` classes; a new `--chat-activity-fg`
  token applied to the working line, group and member summaries, group rule
  and dot; touch-mode overrides where they exist.
- No new dependency; no wire change.
- Screenshots under `openspec/changes/render-shell-output-like-terminal/screenshots/`.
