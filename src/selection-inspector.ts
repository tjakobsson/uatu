// Selection-capture module for the Selection Inspector pane (Review-mode only).
//
// Produces a small state machine driven by the user's text selection inside
// the preview area. The pane reads the current state and renders one of:
//
//   - "placeholder"  — no preview selection (or no document active)
//   - "hint"         — a Rendered-view selection that cannot produce a line
//                      range; the pane offers to switch to Source view
//   - "reference"    — a Source-view selection rooted in a host element
//                      carrying `class="uatu-source-pre"`, where each
//                      rendered source line carries a `data-line` attribute
//                      (per the `document-source-view` capability),
//                      mapped to `{ path, startLine, endLine }`
//
// Future agent adapters (Claude Code IDE protocol, opencode, ...) will read
// the same `SelectionRecord` shape and feed it into their respective
// at-mention / context APIs.

export type SelectionRecord = {
  path: string;
  startLine: number;
  endLine: number;
};

export type PaneState =
  | { kind: "placeholder" }
  | { kind: "hint" }
  | { kind: "reference"; record: SelectionRecord };

export type SelectionInspectorOptions = {
  // Root of the rendered preview. A selection is only considered when its
  // commonAncestorContainer is inside this element. Selections rooted
  // anywhere else (sidebar, preview header, mode/view toggles, fullscreen
  // mermaid viewer) produce the placeholder state.
  previewElement: HTMLElement;
  // Returns the active document's path when a real document is being
  // rendered, or null when the preview is in any non-document state. The
  // capture module calls this on every recompute so the path always matches
  // the live UI state.
  getActiveDocumentPath: () => string | null;
  // Returns whether the active document is currently rendered in source view.
  // True for text/source files (always source-rendered) and for Markdown /
  // AsciiDoc when the user has flipped the view toggle to Source.
  isSourceView: () => boolean;
  // Optional override of the global selection accessor. Defaults to
  // `() => window.getSelection()`. Tests inject a fake.
  getSelection?: () => Selection | null;
};

export type SelectionInspector = {
  // Current snapshot of the pane state. The pane render code reads this on
  // each `change` callback.
  current(): PaneState;
  // Subscribe to state changes. Fires once on subscription with the current
  // state, then on every transition. Returns an unsubscribe.
  subscribe(callback: (state: PaneState) => void): () => void;
  // Re-evaluate against the current DOM and selection. Call after document
  // loads, view-mode flips, or any other event that mutates the preview body.
  recompute(): void;
  // Detach event listeners. Mainly here for tests.
  dispose(): void;
};

const PLACEHOLDER: PaneState = { kind: "placeholder" };
const HINT: PaneState = { kind: "hint" };

// DOM node-type values inlined because the `Node` global is not available in
// non-browser test runners (linkedom's Document is sufficient for the
// computeRecord logic, but its Node constructor is not exposed as a global).
const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

// Equality used to suppress redundant notifications when `selectionchange`
// fires repeatedly during a drag.
function statesEqual(a: PaneState, b: PaneState): boolean {
  if (a.kind !== b.kind) {
    return false;
  }
  if (a.kind === "reference" && b.kind === "reference") {
    return (
      a.record.path === b.record.path &&
      a.record.startLine === b.record.startLine &&
      a.record.endLine === b.record.endLine
    );
  }
  return true;
}

// Format the captured record as a Claude-Code-style at-mention. Single-line
// ranges (start === end) collapse to `@path#L<n>`; multi-line ranges expand
// to `@path#L<a>-<b>`. Mirrors claudecode.nvim's convention.
export function formatReference(record: SelectionRecord): string {
  if (record.startLine === record.endLine) {
    return `@${record.path}#L${record.startLine}`;
  }
  return `@${record.path}#L${record.startLine}-${record.endLine}`;
}

// Walk up the ancestor chain from `node` to find the nearest element carrying
// a `data-line` attribute. Returns the 1-indexed line number, or null if no
// such ancestor exists within `root`. Exported for unit tests.
export function lineNumberForNode(node: Node, root: Element): number | null {
  let current: Node | null = node;
  while (current && current !== root) {
    if (current.nodeType === ELEMENT_NODE) {
      const element = current as Element;
      const value = element.getAttribute("data-line");
      if (value !== null) {
        const parsed = Number.parseInt(value, 10);
        if (Number.isFinite(parsed) && parsed >= 1) {
          return parsed;
        }
      }
    }
    current = current.parentNode;
  }
  return null;
}

// Build the pane state from the current selection. Pure function — exported
// so unit tests can drive every branch with synthetic Selection / Range
// shapes without spinning up a browser.
export function computeState(options: SelectionInspectorOptions): PaneState {
  // Document mode + active path are required for any non-placeholder state.
  // Commit views, review-score views, and the empty preview have no
  // capture-able selection.
  const path = options.getActiveDocumentPath();
  if (path === null) {
    return PLACEHOLDER;
  }

  const getSelection =
    options.getSelection ??
    (typeof window === "undefined" ? () => null : () => window.getSelection());
  const selection = getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return PLACEHOLDER;
  }

  const range = selection.getRangeAt(0);
  // Filter out "no real content" selections. We check both serializers
  // because `selection.toString()` returns an empty string in Chromium for
  // programmatically-created selections whose anchors sit on whitespace-only
  // text nodes inside a CSS-grid layout — exactly the shape @pierre/diffs's
  // File component renders for empty source lines. `range.toString()` does a
  // pure DOM-walk and reports the contained text content, so it catches
  // those grid-layout cases. A genuinely empty selection (e.g. a triple-click
  // at the end of a line that the browser collapsed) makes BOTH empty, which
  // still routes to the placeholder branch.
  if (selection.toString().length === 0 && range.toString().length === 0) {
    return PLACEHOLDER;
  }

  if (!options.previewElement.contains(range.commonAncestorContainer)) {
    return PLACEHOLDER;
  }

  // The whole-file source-view region carries `class="uatu-source-pre"` on a
  // wrapper that hosts @pierre/diffs's File output. Find the nearest such
  // ancestor of the selection's commonAncestor; if the selection is rooted
  // inside a fenced code block embedded in rendered Markdown / AsciiDoc body
  // content, no such ancestor exists. We use this single check as the gate
  // that simultaneously rules out fenced code blocks AND chrome / metadata
  // / mermaid viewer.
  const ancestorElement =
    range.commonAncestorContainer.nodeType === ELEMENT_NODE
      ? (range.commonAncestorContainer as Element)
      : range.commonAncestorContainer.parentElement;
  const sourceHost = ancestorElement?.closest(".uatu-source-pre") ?? null;

  if (!options.isSourceView() || !sourceHost) {
    // Either the user is in Rendered view, or the selection is inside a
    // rendered fenced code block where line numbers would be misleading.
    // Either way: offer the user a way to opt into source-aligned capture.
    return HINT;
  }

  // Walk from the selection's start/end nodes up to the nearest element
  // carrying a `data-line` attribute. With @pierre/diffs's File output every
  // rendered source line carries one.
  const startLine = lineNumberForNode(range.startContainer, sourceHost);
  if (startLine === null) {
    return PLACEHOLDER;
  }

  let endLine = lineNumberForNode(range.endContainer, sourceHost);
  if (endLine === null) {
    return PLACEHOLDER;
  }

  // "End at the start of the next line" semantic: a selection whose end
  // boundary sits at the leading edge of a line element (range.endOffset === 0
  // and endContainer is that element) reports the prior line as endLine.
  // Mirrors the legacy newline-counting behavior so users authoring a
  // single-line selection by dragging to the start of the next line still get
  // an N-N range, not N-(N+1).
  if (
    range.endOffset === 0 &&
    endLine > startLine
  ) {
    endLine = endLine - 1;
  }

  // Defensive clamp: pathological selections (e.g. backwards ranges resolved
  // by the browser) could otherwise produce endLine < startLine.
  if (endLine < startLine) {
    endLine = startLine;
  }

  return {
    kind: "reference",
    record: { path, startLine, endLine },
  };
}

export function createSelectionInspector(options: SelectionInspectorOptions): SelectionInspector {
  let current: PaneState = PLACEHOLDER;
  const subscribers = new Set<(state: PaneState) => void>();

  const recompute = () => {
    const next = computeState(options);
    if (statesEqual(current, next)) {
      return;
    }
    current = next;
    for (const callback of subscribers) {
      callback(current);
    }
  };

  const handler = () => recompute();
  document.addEventListener("selectionchange", handler);

  return {
    current() {
      return current;
    },
    subscribe(callback) {
      subscribers.add(callback);
      callback(current);
      return () => {
        subscribers.delete(callback);
      };
    },
    recompute,
    dispose() {
      document.removeEventListener("selectionchange", handler);
      subscribers.clear();
    },
  };
}

// Used by the copy-to-clipboard helper on source-view `<pre>` blocks. With the
// @pierre/diffs renderer's DOM, `code.textContent` contains the line-number
// gutter digits as well as the source text, so a naive textContent read would
// copy "1const a = 1;2const b = 2;..." rather than the clean source. This
// helper walks `<div data-line>` children and joins their text with newlines,
// returning the original source. The TEXT_NODE / ELEMENT_NODE constants are
// reused from the selection-capture path above so this module owns one set of
// node-type literals.
//
// Exported separately so it lives close to the data-line contract it depends
// on; the copy-button wiring imports it from app.ts.
export function extractSourceTextFromHost(host: Element): string {
  // `[data-line]` matches every rendered source line in document order.
  // `<div data-content>` (the @pierre/diffs content container) holds them as
  // children, but querySelectorAll returns them in tree order regardless of
  // the immediate parent, which is exactly what we want.
  const lines = Array.from(host.querySelectorAll<HTMLElement>("[data-line]"));
  if (lines.length === 0) {
    // Fallback for the >1 MB plain-text path (no per-line elements): copy the
    // `<code>` element's textContent directly.
    const code = host.querySelector<HTMLElement>("pre > code");
    return (code?.textContent ?? "").replace(/\n$/, "");
  }
  // Strip the gutter copies: @pierre/diffs's data-gutter region contains
  // its own [data-line-type] / [data-column-number] children for the line
  // numbers, but those don't carry `data-line` — they carry
  // `data-line-index`. So `[data-line]` cleanly matches only the content
  // side. The textContent of each line element is just the source for that
  // line (token spans concatenated). Join with newlines.
  return lines.map(line => line.textContent ?? "").join("\n");
}
