## Context

See proposal.md — Why.

Tool output reaches the renderer as plain text on `ToolItem.output`, from both
agents, and is painted by `renderActivityOutput` in `timeline-renderer.ts`
through `escapeHtml` into a `<pre>`. Nothing on either adapter strips or
interprets escapes today. The shell command row is the `kind: "command"`
branch of `toolBody`.

The terminal's palette is sixteen `--terminal-ansi-*` variables plus
`--terminal-bg` / `--terminal-fg` / `--terminal-font-family` on `:root`
(`styles.css:141-163`); xterm reads them at theme build. They are dark-only
values — the terminal does not switch with the light theme.

The activity chrome is coloured with `--text-subtle`
(`light-dark(#57606a, #8b949e)`) on `.chat-activity`, its summary,
`.chat-activity-subject`, `.chat-activity-group`, `.chat-turn-status`; the
group rule and neutral dot use `--border-soft`.

`@xterm/headless` and `@xterm/addon-serialize` are already dependencies
(used server-side in the terminal subsystem).

## Goals / Non-Goals

**Goals:**
- One renderer for escape-bearing output, applied to every tool's output;
  the terminal look applied to shell command rows.
- Output stays real text in the DOM: selectable, copyable, browser-findable,
  no per-block canvas.
- No new dependency; nothing on the wire changes.

**Non-Goals:**
- Full terminal emulation (cursor addressing, alternate screen, scroll
  regions). Sequences beyond SGR, `\r`, `\b`, and erase-line are dropped.
- Interpreting escapes inside diffs, file contents, or assistant markdown.
- A light variant of the terminal palette; shell blocks are dark in both
  themes, like the terminal pane.

## Decisions

**D1 — An in-house converter, `src/chat/ansi.ts`, not `@xterm/headless`
+ serialize and not a third-party `ansi_up`.** Headless xterm needs a fixed
column count and hard-wraps at it (rewriting the text), serializes to inline
hex colours (defeating the shared variables), and costs a terminal instance
per block per streaming chunk. `ansi_up` and kin handle SGR only (no `\r`),
add a dependency and a license entry. The needed subset is small: an SGR
state machine, a line buffer with a cursor column for `\r`/`\b`/EL, and a
skipper for CSI/OSC/charset sequences. Output is a list of lines, each a list
of `{ text, style }` runs; a separate `toHtml` escapes text and emits
`<span class="ansi-fg-2 ansi-bold">`. 256-colour indexes 0–15 map to the
palette classes; 16–255 and truecolour emit an inline `style="color: rgb()"`
computed from the standard cube/greyscale ramp (what xterm does).

**D2 — Overwrites happen in the converter, on a per-line cursor.** `\r`
moves the cursor to column 0 of the current line; subsequent text overwrites
runs from there; `\x1b[K` truncates from the cursor; `\x1b[2K` clears the
line. `\b` steps back one column. Cursor-up (`\x1b[nA`) is dropped, so a
multi-line redrawing UI degrades to its lines appended in order — readable,
not exact, and better than the escapes shown raw.

**D2b — Cells follow terminal widths.** A tab advances to the next
eight-column stop; a combining mark, joiner, or variation selector rides the
cell before it; East Asian wide/fullwidth forms and the emoji blocks take two
cells, and overwriting either half blanks the glyph. Coarse ranges, not a full
width table — enough that a progress line redrawn over accented or CJK text
lands on the cells the terminal would use.

**D3 — Streaming tail cuts the raw text first, converts second.** Today's
tail walks back twelve `\n` in the raw string so a long stream is not
re-scanned per chunk; that stays. The tail is then converted, so a rewritten
progress line counts once. SGR state opened before the cut is lost for the
visible tail — accepted while running. The finished render converts the whole
output once and splits rendered lines into preview and rest, so the bounded
preview and "Show N more lines" count rendered lines. Alternative rejected:
convert the whole stream per chunk (quadratic over a long log).

**D4 — Which blocks get which treatment.** Escape interpretation applies to
every `renderActivityOutput` call and to `chat-tool-error` — escapes show up
wherever a tool relays a process's stderr. The terminal look
(`.chat-tool-terminal`: `background: var(--terminal-bg)`, `color:
var(--terminal-fg)`, `font-family: var(--terminal-font-family)`,
`white-space: pre`, `overflow-x: auto`, `tab-size: 8`) applies to the
command row's output and error blocks only; other tools' output keeps the
current wrapped `pre`. This is what "same as our terminal" means for shell
rows without turning a file read into a black box.

**D5 — Palette sharing is by CSS variable.** `ansi-fg-0..15` /
`ansi-bg-0..15` classes resolve to `--terminal-ansi-*`; `ansi-bold` uses
`--terminal-ansi-bright-*` for 30–37 when bold-is-bright is on (xterm's
default `drawBoldTextInBrightColors: true`, so the two surfaces agree).
`ansi-dim` is `opacity: 0.6`; `ansi-inverse` swaps fg/bg via the same
variables. Nothing in `client.ts`'s `buildTheme` changes.

**D6 — A `--chat-activity-fg` token, not a `--text-subtle` retune.**
`--text-subtle` colours labels app-wide; raising it would loudly change the
sidebar and metadata card. The new token sits between subtle and strong —
target ≥ 7:1 against `--surface` and `--surface-raised` in both themes (AAA
for the 0.875em size the chrome uses) while staying measurably lighter than
`--text-strong`. Values are chosen at implementation with a contrast check
and recorded in the CSS comment. It replaces `--text-subtle` on
`.chat-turn-status`, `.chat-activity`, `.chat-activity summary`,
`.chat-activity-subject`, `.chat-activity-group` and its summary/line, and
`--border-soft` → `--border-medium` on `.chat-group-items` and the neutral
`.chat-group-dot`. Touch-mode overrides that restate a colour follow.
`.chat-activity-status` (the "running" word) and failure colours are
untouched.

## Risks / Trade-offs

- [A converter bug turns escaped text into markup] → the converter never
  emits raw text; `toHtml` escapes every run through `escapeHtml` and only
  emits class names from a fixed allow-list plus a numeric `rgb()` style. A
  test feeds `<script>` and `javascript:` between escapes.
- [Horizontal scroll inside a vertically scrolling timeline on a phone] →
  it matches the terminal pane's own behaviour on touch; the block has a
  bounded height already. If it grates, a touch-only wrap toggle is a
  follow-up, not a reason to wrap by default.
- [Dark block in the light theme] → deliberate (D4); it is what the terminal
  pane does. Screenshot both themes so the user can veto.
- [Bold-as-bright disagreeing with a future xterm option change] → both
  read the same variables; if `drawBoldTextInBrightColors` is ever turned
  off, `ansi-bold` drops its colour swap in the same PR.
- [Contrast values guessed by eye] → task requires a measured ratio in the
  CSS comment and before/after shots in both themes.

## Open Questions

None open. Resolved during review: `ansi-dim` lowers the foreground's
intensity alone (`color-mix` on the palette colour), leaving an SGR
background opaque as a terminal does, and its inverse-video default follows
the enclosing block like the undimmed one, and extended (256/truecolour)
colours ride a custom property so dim mixes them like palette colours;
erase-in-line clears a wide glyph whole from either half; the wide table is
the wcwidth East Asian Wide/Fullwidth set (binary-searched) rather than a
few coarse ranges, with U+FE0F emoji presentation making a narrow symbol
wide; colon-form SGR subparameters (`4:2`, `38:2:cs:r:g:b`) stay with their
parameter instead of being flattened into top-level codes.
