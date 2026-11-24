// The keyboard path into inline review: in a review diff every line number is
// a button ("Comment on <path> line N") that opens the composer on Enter or Space,
// like a click does. A file is one Tab stop (roving tabindex); the arrow keys,
// Home and End move between its lines, and in Split Left / Right switch
// between the old and new columns.
//
// The line numbers live in the shadow root Pierre renders, so this module
// decorates them after every Pierre render, and activation goes through the
// same click Pierre already handles, which knows the line's side and number.
//
// On touch (`rowTap`) the compact number column is a small target, so a tap
// anywhere on a line's row opens its composer the same way: a tap, not a
// drag or a long press that selected text, and never one on a comment.

import type { DiffAnnotationSide } from "./diff-view";

export type ReviewLine = { side: DiffAnnotationSide; lineNumber: number };

// The file is part of the name: a screen reader's list of buttons holds every
// file's lines at once.
export function reviewLineLabel(line: ReviewLine, split: boolean, path: string): string {
  const old = line.side === "deletions";
  return `Comment on ${path} line ${line.lineNumber}${old ? (split ? " (old)" : " (removed)") : ""}`;
}

// Pierre's collapsed-context expanders are unnamed, unfocusable
// `div[role=button]`s; their separator says how many lines they hide.
export function expandButtonLabel(separatorText: string, direction: "up" | "down" | "both", path: string): string {
  const hidden = separatorText.trim().replace(/\s+/g, " ") || "unmodified lines";
  const where = direction === "up" ? " above" : direction === "down" ? " below" : "";
  return `Show ${hidden}${where} in ${path}`;
}

// Where an arrow key goes in a column of `count` line numbers.
export function moveLineIndex(index: number, key: string, count: number): number | null {
  if (count === 0) return null;
  switch (key) {
    case "ArrowDown": return Math.min(count - 1, index + 1);
    case "ArrowUp": return Math.max(0, index - 1);
    case "Home": return 0;
    case "End": return count - 1;
    default: return null;
  }
}

// Jump to file's filter: the paths (in their order) containing every word of
// the query, case-insensitively; an empty query keeps them all.
export function filterJumpPaths(paths: readonly string[], query: string): string[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...paths];
  return paths.filter(path => {
    const lower = path.toLowerCase();
    return words.every(word => lower.includes(word));
  });
}

const sameLine = (a: ReviewLine | null, b: ReviewLine | null) =>
  a !== null && b !== null && a.side === b.side && a.lineNumber === b.lineNumber;

function lineOf(cell: Element): ReviewLine | null {
  const lineNumber = Number(cell.getAttribute("data-column-number"));
  if (!Number.isFinite(lineNumber) || lineNumber < 1) return null;
  const column = cell.closest("code");
  const side: DiffAnnotationSide = column?.hasAttribute("data-deletions") ? "deletions"
    : column?.hasAttribute("data-additions") ? "additions"
    : cell.getAttribute("data-line-type") === "change-deletion" ? "deletions" : "additions";
  return { side, lineNumber };
}

export type ReviewLineKeys = {
  // Re-applies the buttons' attributes after Pierre renders.
  decorate: () => void;
  // The diff's lines, in display order, for the composer's line picker, and
  // whether each is a change (Add line comments opens on the first one).
  lines: () => (ReviewLine & { text: string; changed: boolean })[];
  // Moves focus to a line's number (after a composer closes, say).
  focus: (line: ReviewLine) => boolean;
  // The line whose number has focus, if any.
  focused: () => ReviewLine | null;
};

// The number cell a tap on a line's code stands for: the cell with the same
// line index in the same column. Null when the tap was not on a line's code
// (an annotation, a separator, a number itself).
export function rowTapNumberCell(path: readonly EventTarget[]): HTMLElement | null {
  for (const target of path) {
    const element = target as Element;
    if (typeof element?.hasAttribute !== "function") continue;
    if (element.tagName === "SLOT" || element.hasAttribute("data-line-annotation") || element.hasAttribute("data-column-number")) return null;
    if (!element.hasAttribute("data-line")) continue;
    const index = element.getAttribute("data-line-index");
    if (index === null) return null;
    return element.closest("code")?.querySelector<HTMLElement>(`[data-column-number][data-line-index="${index.replace(/["\\]/g, "\\$&")}"]`) ?? null;
  }
  return null;
}

export function attachReviewLineKeys(host: HTMLElement, split: () => boolean, path: string, rowTap: () => boolean = () => false): ReviewLineKeys {
  // The line that holds the file's Tab stop.
  let stop: ReviewLine | null = null;
  const root = () => host.querySelector("diffs-container")?.shadowRoot ?? null;
  const cells = () => [...(root()?.querySelectorAll<HTMLElement>("[data-column-number]") ?? [])];

  const setStop = (target: HTMLElement) => {
    for (const cell of cells()) cell.tabIndex = cell === target ? 0 : -1;
    stop = lineOf(target);
  };

  const decorate = () => {
    const all = cells();
    let stopCell: HTMLElement | null = null;
    for (const cell of all) {
      const line = lineOf(cell);
      if (!line) continue;
      cell.setAttribute("role", "button");
      cell.setAttribute("aria-label", reviewLineLabel(line, split(), path));
      cell.tabIndex = -1;
      if (!stopCell && sameLine(line, stop)) stopCell = cell;
    }
    stopCell ??= all[0] ?? null;
    if (stopCell) stopCell.tabIndex = 0;
    for (const button of root()?.querySelectorAll<HTMLElement>("[data-expand-button]") ?? []) {
      const direction = button.hasAttribute("data-expand-up") && button.hasAttribute("data-expand-down") ? "both"
        : button.hasAttribute("data-expand-up") ? "up" : button.hasAttribute("data-expand-down") ? "down" : "both";
      button.setAttribute("aria-label", expandButtonLabel(button.closest("[data-separator]")?.textContent ?? "", direction, path));
      button.tabIndex = 0;
    }
  };

  host.addEventListener("keydown", event => {
    const cell = event.composedPath()[0];
    if (cell instanceof HTMLElement && cell.hasAttribute("data-expand-button") && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      cell.click();
      return;
    }
    if (!(cell instanceof HTMLElement) || !cell.hasAttribute("data-column-number")) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setStop(cell);
      cell.click();
      return;
    }
    const column = cell.closest("code");
    if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && split()) {
      const columns = [...(root()?.querySelectorAll("code") ?? [])];
      const other = columns[columns.indexOf(column!) + (event.key === "ArrowLeft" ? -1 : 1)];
      if (!other) return;
      event.preventDefault();
      // The nearest line on the other side, by on-screen position.
      const top = cell.getBoundingClientRect().top;
      const candidates = [...other.querySelectorAll<HTMLElement>("[data-column-number]")];
      const next = candidates.sort((a, b) => Math.abs(a.getBoundingClientRect().top - top) - Math.abs(b.getBoundingClientRect().top - top))[0];
      if (next) { setStop(next); next.focus(); }
      return;
    }
    const inColumn = [...(column?.querySelectorAll<HTMLElement>("[data-column-number]") ?? [])];
    const index = moveLineIndex(inColumn.indexOf(cell), event.key, inColumn.length);
    if (index === null) return;
    event.preventDefault();
    const next = inColumn[index]!;
    setStop(next);
    next.focus();
  });
  // A click (pointer or keyboard) moves the Tab stop to that line; on touch
  // a tap on the line's code clicks its number.
  host.addEventListener("click", event => {
    const composed = event.composedPath();
    const cell = composed[0];
    if (cell instanceof HTMLElement && cell.hasAttribute("data-column-number")) { setStop(cell); return; }
    if (!rowTap() || event.defaultPrevented) return;
    const number = rowTapNumberCell(composed);
    if (!number) return;
    // Text selected (a long press, a drag): the reader is selecting, not
    // asking for a composer.
    const shadow = root() as (ShadowRoot & { getSelection?: () => Selection | null }) | null;
    const selection = shadow?.getSelection?.() ?? document.getSelection();
    if (selection && !selection.isCollapsed && selection.toString().trim() !== "") return;
    setStop(number);
    number.click();
  });

  return {
    decorate,
    lines: () => cells().flatMap(cell => {
      const line = lineOf(cell);
      if (!line) return [];
      const index = cell.getAttribute("data-line-index");
      const code = cell.closest("code");
      const text = index ? code?.querySelector(`[data-line][data-line-index="${CSS.escape(index)}"]`)?.textContent ?? "" : "";
      // An added or removed line, not context.
      const changed = cell.getAttribute("data-line-type")?.startsWith("change") ?? false;
      return [{ ...line, text, changed }];
    }),
    focused: () => {
      const active = root()?.activeElement;
      return active?.hasAttribute("data-column-number") ? lineOf(active) : null;
    },
    focus: line => {
      const cell = cells().find(candidate => sameLine(lineOf(candidate), line));
      if (!cell) return false;
      setStop(cell);
      cell.focus();
      return true;
    },
  };
}

// --- Naming a commented line --------------------------------------------------

type Anchor = { path: string; line: number; side: "LEFT" | "RIGHT" };

// "links.ts:1 (old)": line 1 exists on both sides of a diff, so a comment's
// place names its side.
export function anchorLabel(anchor: Anchor): string {
  return `${anchor.path}:${anchor.line} (${anchor.side === "LEFT" ? "old" : "new"})`;
}

// An inline composer's prompt and accessible name. The side is part of it:
// in Split a context line has a composer on each side, and the two must not
// read alike.
export function inlineComposerPrompt(anchor: Anchor, viewer: string): string {
  return `Comment on ${anchorLabel(anchor)} as @${viewer}…`;
}

// One option of the composer's line picker: the line, its side, and the
// start of its text.
export function lineOptionText(line: ReviewLine, text: string): string {
  const trimmed = text.trim();
  return `line ${line.lineNumber} (${line.side === "deletions" ? "old" : "new"})${trimmed ? ` · ${trimmed.length > 40 ? `${trimmed.slice(0, 40)}…` : trimmed}` : ""}`;
}

// The commented line's code on one line, for lists of comments away from the
// diff; empty when the file or line is not in the pull request.
export function lineExcerpt(files: readonly { path: string; oldContents: string; newContents: string }[], anchor: Anchor, max = 72): string {
  const file = files.find(candidate => candidate.path === anchor.path);
  const contents = anchor.side === "LEFT" ? file?.oldContents : file?.newContents;
  const text = contents?.split("\n")[anchor.line - 1]?.trim().replace(/\s+/g, " ") ?? "";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// Where a composer opened for a whole file goes ("Add line comments", a
// file's Comment button): its first non-blank added line, else its first
// non-blank changed line, else its first changed line, else its first line.
// A blank line is a poor first anchor: nothing on it to comment about.
export function firstCommentLine<T extends ReviewLine & { text: string; changed: boolean }>(lines: readonly T[]): T | undefined {
  const filled = (line: T) => line.text.trim() !== "";
  return lines.find(line => line.changed && line.side === "additions" && filled(line))
    ?? lines.find(line => line.changed && filled(line))
    ?? lines.find(line => line.changed)
    ?? lines[0];
}
