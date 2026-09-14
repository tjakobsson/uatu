// Terminal text → safe HTML, for a tool's output shown in Chat. A shell
// command's output carries what the process wrote to a terminal: SGR colour
// and weight sequences, carriage returns that redraw a progress line in
// place, erase-line sequences, and the odd cursor movement. Shown raw, the
// sequences appear as `[32m` fragments and every redraw stacks up as a new
// line. This module interprets the subset that shapes ordinary command output
// — styling and in-line overwrites — and drops the rest, so the block reads
// as the terminal pane would show the same bytes.
//
// Deliberately not a terminal emulator: no cursor addressing, no alternate
// screen, no scroll regions. A full-screen UI degrades to its lines in the
// order they were drawn, which is readable; the escapes shown raw were not.
//
// Colours are emitted as class names resolving to the terminal's palette
// variables (`--terminal-ansi-*`), never as hex, so Chat and the terminal
// pane share one palette. Only 256-colour indexes past the palette and
// truecolour become an inline `rgb()` — numeric, from the standard ramp.

import { escapeHtml } from "../shared/html";

/** A palette index (0–15) or a css rgb() string for the extended colours. */
export type TerminalColor = number | string;

export type TerminalStyle = {
  fg?: TerminalColor;
  bg?: TerminalColor;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
  strike?: boolean;
};

export type TerminalRun = { text: string; style: TerminalStyle };
export type TerminalLine = TerminalRun[];

const PLAIN: TerminalStyle = {};

// One line under construction: parallel arrays of characters and the style
// each was written with, plus the cursor column an overwrite resumes from.
// Cells rather than runs, because `\r` puts the cursor back at column 0 and
// the next write replaces cell by cell — a progress bar redraws the same
// columns dozens of times, and only the last write of each column shows.
type LineBuffer = { chars: string[]; styles: TerminalStyle[]; cursor: number };

function newLine(): LineBuffer {
  return { chars: [], styles: [], cursor: 0 };
}

/**
 * Interpret terminal text into styled lines. Handles SGR (0, 1, 2, 3, 4, 7,
 * 9, 22–24, 27, 29, 30–37, 39, 40–47, 49, 90–97, 100–107, 38/48;5;n,
 * 38/48;2;r;g;b), `\r`, `\b`, and erase-in-line; every other CSI, OSC, and
 * two-byte ESC sequence is removed. Other C0 controls are dropped; `\t` is
 * kept as a character for CSS `tab-size` to lay out.
 */
export function renderTerminalText(text: string): TerminalLine[] {
  const lines: LineBuffer[] = [newLine()];
  let line = lines[0]!;
  let style: TerminalStyle = PLAIN;
  const length = text.length;
  let index = 0;
  const write = (char: string) => {
    line.chars[line.cursor] = char;
    line.styles[line.cursor] = style;
    line.cursor += 1;
  };
  while (index < length) {
    const code = text.charCodeAt(index);
    if (code === 0x1b) {
      const next = text[index + 1];
      if (next === "[") {
        // CSI: parameter bytes, then a final byte in 0x40–0x7E.
        let end = index + 2;
        while (end < length) {
          const c = text.charCodeAt(end);
          if (c >= 0x40 && c <= 0x7e) break;
          end += 1;
        }
        if (end >= length) break; // truncated sequence at the end of a chunk: drop it
        const final = text[end]!;
        const params = text.slice(index + 2, end);
        if (final === "m") style = applySgr(style, params);
        else if (final === "K") eraseInLine(line, params);
        index = end + 1;
        continue;
      }
      if (next === "]") {
        // OSC: up to BEL or ST (ESC \).
        let end = index + 2;
        while (end < length) {
          const c = text.charCodeAt(end);
          if (c === 0x07) { end += 1; break; }
          if (c === 0x1b && text[end + 1] === "\\") { end += 2; break; }
          end += 1;
        }
        index = end;
        continue;
      }
      // Charset designation (ESC ( B), keypad modes, save/restore cursor,
      // reverse index: ESC plus one byte, or two for the charset forms.
      index += next === "(" || next === ")" || next === "#" ? 3 : 2;
      continue;
    }
    if (code === 0x0a) {
      line = newLine();
      lines.push(line);
      index += 1;
      continue;
    }
    if (code === 0x0d) {
      line.cursor = 0;
      index += 1;
      continue;
    }
    if (code === 0x08) {
      if (line.cursor > 0) line.cursor -= 1;
      index += 1;
      continue;
    }
    if (code < 0x20 && code !== 0x09) {
      index += 1;
      continue;
    }
    // Surrogate pairs travel as one cell, or a `\r` overwrite would split
    // an emoji in half.
    if (code >= 0xd800 && code <= 0xdbff && index + 1 < length) {
      write(text.slice(index, index + 2));
      index += 2;
      continue;
    }
    write(text[index]!);
    index += 1;
  }
  return lines.map(toRuns);
}

function eraseInLine(line: LineBuffer, params: string): void {
  const mode = params === "" ? 0 : Number.parseInt(params, 10);
  if (mode === 0) {
    line.chars.length = line.cursor;
    line.styles.length = line.cursor;
  } else if (mode === 1) {
    // From the start of the line through the cursor cell, inclusive.
    for (let column = 0; column <= line.cursor && column < line.chars.length; column += 1) {
      line.chars[column] = " ";
      line.styles[column] = PLAIN;
    }
  } else if (mode === 2) {
    line.chars.length = 0;
    line.styles.length = 0;
  }
}

function toRuns(line: LineBuffer): TerminalLine {
  const runs: TerminalLine = [];
  let current: TerminalRun | undefined;
  for (let column = 0; column < line.chars.length; column += 1) {
    // A column the cursor skipped past (it cannot, without cursor-forward,
    // which is dropped) would be undefined; keep the guard anyway.
    const char = line.chars[column] ?? " ";
    const style = line.styles[column] ?? PLAIN;
    if (current && current.style === style) current.text += char;
    else {
      current = { text: char, style };
      runs.push(current);
    }
  }
  return runs;
}

/**
 * The style after an SGR sequence. Styles are immutable and replaced on
 * every change, so cells written under one style share a reference and
 * `toRuns` can merge by identity.
 */
function applySgr(style: TerminalStyle, params: string): TerminalStyle {
  // `;` separates parameters; `:` is the subparameter form some emitters use
  // for extended colours (`38:2::r:g:b`). Empty entries are the colourspace
  // slot of that form, or the bare `ESC[m` reset.
  const codes = params === "" ? [0] : params.split(/[;:]/).filter(part => part !== "").map(part => Number.parseInt(part, 10));
  if (params !== "" && codes.length === 0) return style;
  let next: TerminalStyle = { ...style };
  for (let at = 0; at < codes.length; at += 1) {
    const code = codes[at]!;
    if (Number.isNaN(code)) continue;
    if (code === 0) next = {};
    else if (code === 1) next.bold = true;
    else if (code === 2) next.dim = true;
    else if (code === 3) next.italic = true;
    else if (code === 4) next.underline = true;
    else if (code === 7) next.inverse = true;
    else if (code === 9) next.strike = true;
    else if (code === 22) { delete next.bold; delete next.dim; }
    else if (code === 23) delete next.italic;
    else if (code === 24) delete next.underline;
    else if (code === 27) delete next.inverse;
    else if (code === 29) delete next.strike;
    else if (code >= 30 && code <= 37) next.fg = code - 30;
    else if (code === 39) delete next.fg;
    else if (code >= 40 && code <= 47) next.bg = code - 40;
    else if (code === 49) delete next.bg;
    else if (code >= 90 && code <= 97) next.fg = code - 90 + 8;
    else if (code >= 100 && code <= 107) next.bg = code - 100 + 8;
    else if (code === 38 || code === 48) {
      const target = code === 38 ? "fg" : "bg";
      const mode = codes[at + 1];
      if (mode === 5 && codes[at + 2] !== undefined) {
        const colour = extendedColor(codes[at + 2]!);
        if (colour !== undefined) next[target] = colour;
        at += 2;
      } else if (mode === 2 && codes[at + 4] !== undefined) {
        const [r, g, b] = [codes[at + 2]!, codes[at + 3]!, codes[at + 4]!];
        if ([r, g, b].every(channel => Number.isInteger(channel) && channel >= 0 && channel <= 255)) next[target] = `rgb(${r},${g},${b})`;
        at += 4;
      } else {
        // Malformed extended colour: consume nothing further; the rest of
        // the sequence is unreadable and is left as it stands.
        break;
      }
    }
  }
  return next;
}

/** The 256-colour ramp: the palette for 0–15, the 6×6×6 cube, then greys. */
function extendedColor(index: number): TerminalColor | undefined {
  if (!Number.isInteger(index) || index < 0 || index > 255) return undefined;
  if (index < 16) return index;
  if (index < 232) {
    const cube = index - 16;
    const level = (value: number) => (value === 0 ? 0 : 55 + value * 40);
    return `rgb(${level(Math.floor(cube / 36))},${level(Math.floor(cube / 6) % 6)},${level(cube % 6)})`;
  }
  const grey = 8 + (index - 232) * 10;
  return `rgb(${grey},${grey},${grey})`;
}

/**
 * Styled lines as HTML: one `<span>` per run that carries any style, bare
 * escaped text otherwise, lines joined by newlines for a `<pre>`. Class names
 * come from a fixed set; the only inline style is a numeric `rgb()`.
 */
export function terminalLinesToHtml(lines: readonly TerminalLine[]): string {
  return lines.map(line => line.map(runToHtml).join("")).join("\n");
}

/** Convenience for the common case: interpret and emit in one call. */
export function terminalTextToHtml(text: string): string {
  return terminalLinesToHtml(renderTerminalText(text));
}

function runToHtml(run: TerminalRun): string {
  const text = escapeHtml(run.text);
  const { style } = run;
  const classes: string[] = [];
  const inline: string[] = [];
  // Inverse swaps the two colours; with neither set it swaps the block's
  // defaults, which the `fg-default`/`bg-default` classes name.
  const fg = style.inverse ? style.bg ?? "default" : style.fg;
  const bg = style.inverse ? style.fg ?? "default" : style.bg;
  paint(fg, "fg", classes, inline, "color");
  paint(bg, "bg", classes, inline, "background-color");
  if (style.bold) classes.push("ansi-bold");
  if (style.dim) classes.push("ansi-dim");
  if (style.italic) classes.push("ansi-italic");
  if (style.underline) classes.push("ansi-underline");
  if (style.strike) classes.push("ansi-strike");
  if (classes.length === 0 && inline.length === 0) return text;
  const classAttribute = classes.length ? ` class="${classes.join(" ")}"` : "";
  const styleAttribute = inline.length ? ` style="${inline.join(";")}"` : "";
  return `<span${classAttribute}${styleAttribute}>${text}</span>`;
}

function paint(colour: TerminalColor | "default" | undefined, kind: "fg" | "bg", classes: string[], inline: string[], property: string): void {
  if (colour === undefined) return;
  if (colour === "default") classes.push(`ansi-${kind}-default`);
  else if (typeof colour === "number") classes.push(`ansi-${kind}-${colour}`);
  else if (/^rgb\(\d{1,3},\d{1,3},\d{1,3}\)$/.test(colour)) inline.push(`${property}:${colour}`);
}
