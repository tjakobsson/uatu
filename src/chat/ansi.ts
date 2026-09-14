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
const TAB_STOP = 8;

// How many cells a character takes, as a terminal lays it out: none for a
// combining mark, joiner, or variation selector (it rides the cell before
// it), two for East Asian wide and fullwidth forms and the emoji blocks
// terminals draw double-width, one otherwise. Coarse by design — the
// ranges are the ones ordinary command output meets, not a full Unicode
// width table — but a progress line redrawn over accented or CJK text now
// lands on the cells the terminal would put it on.
const ZERO_WIDTH = /^(?:\p{M}|\u200b|\u200c|\u200d|\ufe0e|\ufe0f)$/u;
// East Asian Wide and Fullwidth, as wcwidth tabulates them (Unicode 15):
// the CJK blocks, Hangul, fullwidth forms, and the symbol and emoji ranges
// terminals draw double-width. Sorted, non-overlapping, binary-searched.
const WIDE: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], [0x231a, 0x231b], [0x2329, 0x232a], [0x23e9, 0x23ec], [0x23f0, 0x23f0], [0x23f3, 0x23f3],
  [0x25fd, 0x25fe], [0x2614, 0x2615], [0x2648, 0x2653], [0x267f, 0x267f], [0x2693, 0x2693], [0x26a1, 0x26a1],
  [0x26aa, 0x26ab], [0x26bd, 0x26be], [0x26c4, 0x26c5], [0x26ce, 0x26ce], [0x26d4, 0x26d4], [0x26ea, 0x26ea],
  [0x26f2, 0x26f3], [0x26f5, 0x26f5], [0x26fa, 0x26fa], [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b],
  [0x2728, 0x2728], [0x274c, 0x274c], [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797],
  [0x27b0, 0x27b0], [0x27bf, 0x27bf], [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55], [0x2e80, 0x303e],
  [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0xa4cf], [0xa960, 0xa97f], [0xac00, 0xd7a3], [0xf900, 0xfaff],
  [0xfe10, 0xfe19], [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6], [0x16fe0, 0x16fe4], [0x17000, 0x18cd5],
  [0x1aff0, 0x1b2fb], [0x1f004, 0x1f004], [0x1f0cf, 0x1f0cf], [0x1f18e, 0x1f18e], [0x1f191, 0x1f19a],
  [0x1f200, 0x1f202], [0x1f210, 0x1f23b], [0x1f240, 0x1f248], [0x1f250, 0x1f251], [0x1f260, 0x1f265],
  [0x1f300, 0x1f320], [0x1f32d, 0x1f335], [0x1f337, 0x1f37c], [0x1f37e, 0x1f393], [0x1f3a0, 0x1f3ca],
  [0x1f3cf, 0x1f3d3], [0x1f3e0, 0x1f3f0], [0x1f3f4, 0x1f3f4], [0x1f3f8, 0x1f43e], [0x1f440, 0x1f440],
  [0x1f442, 0x1f4fc], [0x1f4ff, 0x1f53d], [0x1f54b, 0x1f54e], [0x1f550, 0x1f567], [0x1f57a, 0x1f57a],
  [0x1f595, 0x1f596], [0x1f5a4, 0x1f5a4], [0x1f5fb, 0x1f64f], [0x1f680, 0x1f6c5], [0x1f6cc, 0x1f6cc],
  [0x1f6d0, 0x1f6d2], [0x1f6d5, 0x1f6d7], [0x1f6dc, 0x1f6df], [0x1f6eb, 0x1f6ec], [0x1f6f4, 0x1f6fc],
  [0x1f7e0, 0x1f7eb], [0x1f7f0, 0x1f7f0], [0x1f90c, 0x1f93a], [0x1f93c, 0x1f945], [0x1f947, 0x1f9ff],
  [0x1fa70, 0x1fa7c], [0x1fa80, 0x1fa88], [0x1fa90, 0x1fabd], [0x1fabf, 0x1fac5], [0x1face, 0x1fadb],
  [0x1fae0, 0x1fae8], [0x1faf0, 0x1faf8], [0x20000, 0x2fffd], [0x30000, 0x3fffd],
];

function isWide(point: number): boolean {
  let low = 0;
  let high = WIDE.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const [from, to] = WIDE[mid]!;
    if (point < from) high = mid - 1;
    else if (point > to) low = mid + 1;
    else return true;
  }
  return false;
}

function codePointWidth(point: number): 0 | 1 | 2 {
  if (ZERO_WIDTH.test(String.fromCodePoint(point))) return 0;
  return isWide(point) ? 2 : 1;
}

/**
 * A grapheme's cells: two if any code point in it is wide (an emoji joined
 * or modified — `👩‍💻`, `👍🏽` — is one double-width glyph, not a chain of
 * them) or if it asks for emoji presentation (`☑️`: a narrow symbol made
 * wide by U+FE0F, as terminals draw it), none if every code point is
 * zero-width (a lone combining mark, which rides the cell before it), one
 * otherwise.
 */
function cellWidth(grapheme: string): 0 | 1 | 2 {
  let width: 0 | 1 | 2 = 0;
  let regionalIndicators = 0;
  for (const char of grapheme) {
    const point = char.codePointAt(0)!;
    if (point === 0xfe0f && width === 1) return 2;
    // A flag is a pair of regional indicators, each narrow on its own and
    // two cells together.
    if (point >= 0x1f1e6 && point <= 0x1f1ff && ++regionalIndicators === 2) return 2;
    const own = codePointWidth(point);
    if (own === 2) return 2;
    if (own === 1) width = 1;
  }
  return width;
}

// Graphemes, not code points, are what a terminal lays out and what a
// redraw overwrites: the segmenter keeps a joined or modified emoji whole.
const graphemes: (text: string) => Iterable<string> = typeof Intl !== "undefined" && "Segmenter" in Intl
  ? (() => {
      const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
      return (text: string) => {
        const out: string[] = [];
        for (const segment of segmenter.segment(text)) out.push(segment.segment);
        return out;
      };
    })()
  : (text: string) => [...text];

// The second cell of a wide character: no text of its own, skipped when
// runs are built. Overwriting either half blanks the other, as a terminal
// does, so a redraw never leaves half a glyph behind.
const WIDE_TAIL = "";

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
 * two-byte ESC sequence is removed. `\t` moves the cursor to the next tab
 * stop (every eight columns) as a terminal does, so a line redrawn over a
 * tabbed one overwrites the right cells; the cells it skips are left as
 * they were, or spaces where nothing was. Other C0 controls are dropped.
 */
export function renderTerminalText(text: string): TerminalLine[] {
  const lines: LineBuffer[] = [newLine()];
  let line = lines[0]!;
  let style: TerminalStyle = PLAIN;
  const length = text.length;
  let index = 0;
  const put = (column: number, char: string) => {
    // Clearing a wide character's other half when one half is overwritten —
    // its style too, or a red background would outlive the glyph it was on.
    const previous = line.chars[column];
    if (previous === WIDE_TAIL && column > 0) {
      line.chars[column - 1] = " ";
      line.styles[column - 1] = style;
    } else if (previous !== undefined && line.chars[column + 1] === WIDE_TAIL && cellWidth(previous) === 2) {
      line.chars[column + 1] = " ";
      line.styles[column + 1] = style;
    }
    line.chars[column] = char;
    line.styles[column] = style;
  };
  const write = (char: string) => {
    const width = cellWidth(char);
    if (width === 0) {
      // A combining mark joins the cell before the cursor; with none, it
      // stands in a cell of its own rather than vanishing.
      if (line.cursor > 0 && line.chars[line.cursor - 1] !== undefined && line.chars[line.cursor - 1] !== WIDE_TAIL) {
        line.chars[line.cursor - 1] += char;
        return;
      }
      if (line.cursor > 1 && line.chars[line.cursor - 1] === WIDE_TAIL) {
        line.chars[line.cursor - 2] += char;
        return;
      }
    }
    put(line.cursor, char);
    line.cursor += 1;
    if (width === 2) {
      put(line.cursor, WIDE_TAIL);
      line.cursor += 1;
    }
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
        else if (final === "K") eraseInLine(line, params, style);
        index = end + 1;
        continue;
      }
      if (next === "]" || next === "P" || next === "_" || next === "^" || next === "X") {
        // A control string — OSC, DCS, APC, PM, SOS — runs to BEL or ST
        // (ESC \): the whole payload goes, not just its introducer.
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
    if (code === 0x09) {
      const stop = (Math.floor(line.cursor / TAB_STOP) + 1) * TAB_STOP;
      while (line.chars.length < stop) {
        line.chars.push(" ");
        line.styles.push(PLAIN);
      }
      line.cursor = stop;
      index += 1;
      continue;
    }
    if (code < 0x20) {
      index += 1;
      continue;
    }
    // A run of printable text is laid out grapheme by grapheme: a joined or
    // modified emoji is one glyph, so a `\r` overwrite clears it whole.
    let end = index + 1;
    while (end < length) {
      const next = text.charCodeAt(end);
      if (next < 0x20 || next === 0x1b) break;
      end += 1;
    }
    for (const grapheme of graphemes(text.slice(index, end))) write(grapheme);
    index = end;
  }
  return lines.map(toRuns);
}

// Erased cells take the active rendition, as a terminal fills them with the
// current background: a coloured status line erased under its colour stays
// coloured. Attributes that only apply to glyphs are irrelevant on a blank.
function eraseInLine(line: LineBuffer, params: string, style: TerminalStyle): void {
  const mode = params === "" ? 0 : Number.parseInt(params, 10);
  const blank = style.bg === undefined && !style.inverse ? PLAIN : { ...(style.bg === undefined ? {} : { bg: style.bg }), ...(style.inverse ? { inverse: true, ...(style.fg === undefined ? {} : { fg: style.fg }) } : {}) };
  if (mode === 0) {
    // A cursor on a wide glyph's second cell erases the glyph whole; erase
    // never moves the cursor, so the glyph's first cell becomes a blank the
    // next write lands after.
    if (line.chars[line.cursor] === WIDE_TAIL && line.cursor > 0) {
      line.chars[line.cursor - 1] = " ";
      line.styles[line.cursor - 1] = blank;
    }
    line.chars.length = line.cursor;
    line.styles.length = line.cursor;
  } else if (mode === 1) {
    // From the start of the line through the cursor cell, inclusive — and
    // through a wide glyph's second cell when the cursor is on its first,
    // so no orphaned tail is left for the next write to trip over.
    const last = line.chars[line.cursor + 1] === WIDE_TAIL ? line.cursor + 1 : line.cursor;
    for (let column = 0; column <= last && column < line.chars.length; column += 1) {
      line.chars[column] = " ";
      line.styles[column] = blank;
    }
  } else if (mode === 2) {
    // The whole line, cursor unmoved: the cells up to it are blanks under
    // the active background, so what is written next lands where the
    // cursor stands, after them; nothing beyond is kept.
    line.chars.length = line.cursor;
    line.styles.length = line.cursor;
    for (let column = 0; column < line.cursor; column += 1) {
      line.chars[column] = " ";
      line.styles[column] = blank;
    }
  }
}

function toRuns(line: LineBuffer): TerminalLine {
  const runs: TerminalLine = [];
  let current: TerminalRun | undefined;
  for (let column = 0; column < line.chars.length; column += 1) {
    // A column the cursor skipped past (it cannot, without cursor-forward,
    // which is dropped) would be undefined; keep the guard anyway. A wide
    // character's tail cell has no text of its own.
    const char = line.chars[column] ?? " ";
    if (char === WIDE_TAIL) continue;
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
  // `;` separates parameters. `:` separates a parameter's subparameters —
  // `4:2` is an underline variant, `38:2::r:g:b` an extended colour with a
  // colourspace slot — and those stay with their parameter: flattened into
  // the top level, `4:2` would read as underline plus dim and the
  // colourspace slot as a channel.
  const groups = params === "" ? [[0]] : params.split(";").map(group => group.split(":").map(part => (part === "" ? undefined : Number.parseInt(part, 10))));
  let next: TerminalStyle = { ...style };
  // Flattened for the `;`-separated extended colour forms (`38;2;r;g;b`),
  // which span several parameters; a `:` form arrives as one group and is
  // resolved below before the loop sees its subparameters.
  const codes: number[] = [];
  for (const group of groups) {
    const head = group[0];
    if (head === undefined || Number.isNaN(head)) {
      if (group.length === 1 && head === undefined) codes.push(0); // bare `;;` is a reset
      continue;
    }
    if ((head === 38 || head === 48) && group.length > 1) {
      // Colon form: `38:5:n`, or `38:2:[cs]:r:g:b` where the colourspace
      // slot is present (possibly empty) only when six items are given.
      const mode = group[1];
      if (mode === 5 && group[2] !== undefined) codes.push(head, 5, group[2]);
      else if (mode === 2) {
        const channels = (group.length >= 6 ? group.slice(3, 6) : group.slice(2, 5)).map(value => value ?? Number.NaN);
        if (channels.length === 3 && channels.every(value => !Number.isNaN(value))) codes.push(head, 2, ...(channels as number[]));
      }
      continue;
    }
    if (head === 4 && group.length > 1) {
      // Underline variants: `4:0` is off, any other kind is on.
      codes.push(group[1] === 0 ? 24 : 4);
      continue;
    }
    // Any other subparameters are the parameter's own detail (`58:…`
    // underline colour and the like): the head alone is what we style by.
    codes.push(head);
  }
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
  paint(fg, "fg", classes, inline);
  paint(bg, "bg", classes, inline);
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

function paint(colour: TerminalColor | "default" | undefined, kind: "fg" | "bg", classes: string[], inline: string[]): void {
  if (colour === undefined) return;
  if (colour === "default") classes.push(`ansi-${kind}-default`);
  else if (typeof colour === "number") classes.push(`ansi-${kind}-${colour}`);
  else if (/^rgb\(\d{1,3},\d{1,3},\d{1,3}\)$/.test(colour)) {
    // An extended colour rides a custom property rather than the colour
    // declaration itself, so the stylesheet's dim rule can mix it like a
    // palette colour instead of losing to an inline declaration.
    classes.push(`ansi-${kind}-inline`);
    inline.push(`--ansi-${kind}:${colour}`);
  }
}
