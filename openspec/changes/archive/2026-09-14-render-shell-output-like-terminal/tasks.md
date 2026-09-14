## 1. Baseline

- [x] 1.1 Capture `screenshots/before-shell-output-light.png` and `before-shell-output-dark.png` of a command row whose output carries colour escapes and a `\r` progress line, and `before-activity-chrome-light.png` / `before-activity-chrome-dark.png` of a finished group between two assistant messages, at 1400×1000 and a phone width; verify the files exist before any code changes

## 2. Converter

- [x] 2.1 Create `src/chat/ansi.ts` with `renderTerminalText(text): TerminalLine[]` (runs of `{ text, style }` per line) handling SGR 0/1/2/3/4/7/9/22–24/27/29, 30–37/39/40–47/49/90–97/100–107, `38;5;n` / `48;5;n`, `38;2;r;g;b` / `48;2;r;g;b`; verify `ansi.test.ts` covers each attribute, reset semantics, and nesting
- [x] 2.2 Implement the per-line cursor: `\r`, `\b`, `\x1b[K` (0/1/2 modes), and dropping of other CSI, OSC (BEL- and ST-terminated), and charset sequences; verify tests for a rewritten progress line collapsing to its final content, an erased line, and cursor-up sequences vanishing with surrounding text intact
- [x] 2.3 Implement `terminalLinesToHtml(lines)` emitting `escapeHtml`-ed runs with `ansi-fg-N` / `ansi-bg-N` / `ansi-bold` / `ansi-dim` / `ansi-italic` / `ansi-underline` / `ansi-inverse` / `ansi-strike` classes and inline `rgb()` for 256/truecolour; verify a test that `<script>`, `javascript:` and quote characters interleaved with escapes produce no tag or attribute, and that the emitted class set is the fixed allow-list

## 3. Renderer

- [x] 3.1 Route `renderActivityOutput` through the converter: raw tail cut, then convert (running); whole convert, then split rendered lines into preview and "Show N more lines" (finished); verify `timeline-renderer.test.ts` cases for a rewritten progress line counting once in both the running tail and the finished preview
- [x] 3.2 Give the command row's output and error blocks the `chat-tool-terminal` class and run `chat-tool-error` text through the converter; verify a renderer test that a `kind: "command"` item's output block carries the class and a `read` tool's does not

## 4. Styles

- [x] 4.1 Add `.chat-tool-terminal` (terminal bg/fg/font, `white-space: pre`, `overflow-x: auto`, `tab-size: 8`, bounded height) and the `ansi-*` classes resolving to `--terminal-ansi-*` (bold → bright for 30–37, dim opacity, inverse swap) in `src/styles.css`; verify a `mono-font`-style grep test that the block's font resolves through `--terminal-font-family` and no hex colour is hardcoded in the `ansi-*` rules
- [x] 4.2 Add `--chat-activity-fg` as a `light-dark()` token with the measured contrast ratios recorded in its comment (≥ 7:1 on `--surface` and `--surface-raised`, lighter than `--text-strong`), apply it to the working line, activity and group summaries, subjects, and switch the group rule and neutral dot to `--border-medium`, including touch-mode overrides; verify by computing the ratios in a unit test against the token values

## 5. Verification

- [x] 5.1 Capture `screenshots/after-shell-output-light.png` / `-dark.png` for the same command as 1.1 (colours rendered, progress line collapsed, table columns aligned with horizontal scroll) at desktop and phone width; verify visually against the terminal pane showing the same output in `after-shell-output-vs-terminal.png`
- [x] 5.2 Capture `screenshots/after-activity-chrome-light.png` / `-dark.png` matching 1.1; verify the chrome reads darker/brighter than before and still quieter than the prose
- [x] 5.3 Add an e2e in `tests/e2e/chat-shell-output.e2e.ts` driving a fixture command whose output carries escapes and a `\r` line; verify it asserts the rendered text has no `[` codes, the green span has the `ansi-fg-2` class, and the progress line appears once
