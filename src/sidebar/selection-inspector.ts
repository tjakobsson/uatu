// Selection-capture module for the Selection Inspector pane (Review-mode only).
//
// Produces a small state machine driven by the user's text selection inside
// the preview area. The pane reads the current state and renders one of:
//
//   - "placeholder"  — no preview selection (or no document active)
//   - "hint"         — a Rendered-view selection that cannot produce a line
//                      range; the pane offers to switch to Source view
//   - "reference"    — a Source-view selection rooted in the whole-file
//                      `<pre class="uatu-source-pre"><code>` block, mapped
//                      to `{ path, startLine, endLine }`
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

// Walk the DOM from `root` to `target`, accumulating textContent length to
// produce an absolute character offset of `target`'s `targetOffset` into
// `root`'s textContent. The browser's Range API does not expose this directly
// for selections that span multiple text nodes — we have to compute it.
//
// Returns null if `target` is not contained by `root` or if the walk fails.
export function characterOffsetWithin(
  root: Node,
  target: Node,
  targetOffset: number,
): number | null {
  if (!root.contains(target)) {
    return null;
  }
  if (target === root) {
    // Range endpoint is at a child boundary of `root` itself. `targetOffset`
    // is then a child index, not a character offset. Sum textContent of
    // children before that index.
    let total = 0;
    const children = Array.from(root.childNodes);
    for (let i = 0; i < Math.min(targetOffset, children.length); i += 1) {
      total += (children[i].textContent ?? "").length;
    }
    return total;
  }

  // Walk the tree in document order; sum lengths until we reach `target`,
  // then add `targetOffset`. Implementation uses an explicit stack so we can
  // bail out as soon as we hit the target.
  let total = 0;
  let found = false;

  const visit = (node: Node): boolean => {
    if (found) {
      return true;
    }
    if (node === target) {
      // For element targets, `targetOffset` is a child index — sum the first
      // N children's text. For text nodes, `targetOffset` is a character
      // offset inside the node's data.
      if (node.nodeType === TEXT_NODE) {
        total += targetOffset;
      } else {
        const children = Array.from(node.childNodes);
        for (let i = 0; i < Math.min(targetOffset, children.length); i += 1) {
          total += (children[i].textContent ?? "").length;
        }
      }
      found = true;
      return true;
    }
    if (node.nodeType === TEXT_NODE) {
      total += (node.nodeValue ?? "").length;
      return false;
    }
    for (const child of Array.from(node.childNodes)) {
      if (visit(child)) {
        return true;
      }
    }
    return false;
  };

  visit(root);
  return found ? total : null;
}

// Convert a 0-indexed character offset into the source `<code>` element's
// textContent into a 1-indexed source line number. The convention mirrors
// claudecode.nvim: a range that ends exactly at the start of a new line
// (i.e., immediately after a `\n`) reports endLine as the previous line —
// the user's selection is "of those lines", not "up to and including the
// next line's first character."
//
// Exported for unit tests.
export function offsetToLine(
  text: string,
  offset: number,
  options: { trimTrailingNewline?: boolean } = {},
): number {
  const clamped = Math.max(0, Math.min(offset, text.length));
  let effective = clamped;
  if (options.trimTrailingNewline && effective > 0 && text.charAt(effective - 1) === "\n") {
    // Single-newline trim only: a selection ending exactly at the start of
    // a new line reports the previous line as endLine. Multiple consecutive
    // newlines are kept so empty trailing lines still register on their own
    // line numbers.
    effective -= 1;
  }
  let line = 1;
  for (let i = 0; i < effective; i += 1) {
    if (text.charAt(i) === "\n") {
      line += 1;
    }
  }
  return line;
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

  const text = selection.toString();
  if (text.length === 0) {
    return PLACEHOLDER;
  }

  const range = selection.getRangeAt(0);
  if (!options.previewElement.contains(range.commonAncestorContainer)) {
    return PLACEHOLDER;
  }

  // The whole-file source `<pre>` carries `class="uatu-source-pre"`. Find the
  // nearest such ancestor of the selection's commonAncestor; if the selection
  // is rooted inside a fenced code block embedded in rendered Markdown / AsciiDoc
  // body content, the closest match is null (those `<pre>` blocks don't carry
  // the class). We use this single check as the gate that simultaneously
  // rules out fenced code blocks AND chrome / metadata / mermaid viewer.
  const ancestorElement =
    range.commonAncestorContainer.nodeType === ELEMENT_NODE
      ? (range.commonAncestorContainer as Element)
      : range.commonAncestorContainer.parentElement;
  const sourcePre = ancestorElement?.closest("pre.uatu-source-pre") ?? null;

  if (!options.isSourceView() || !sourcePre) {
    // Either the user is in Rendered view, or the selection is inside a
    // rendered fenced code block where line numbers would be misleading.
    // Either way: offer the user a way to opt into source-aligned capture.
    return HINT;
  }

  const codeElement = sourcePre.querySelector("code");
  if (!codeElement) {
    return PLACEHOLDER;
  }

  const codeText = codeElement.textContent ?? "";
  const startOffset = characterOffsetWithin(codeElement, range.startContainer, range.startOffset);
  const endOffset = characterOffsetWithin(codeElement, range.endContainer, range.endOffset);
  if (startOffset === null || endOffset === null) {
    // Selection ranges that escape the code element produce null offsets.
    // Defensive: treat as no capture.
    return PLACEHOLDER;
  }

  const startLine = offsetToLine(codeText, startOffset);
  // For the end line, trim any trailing `\n` that the selection happens to
  // include. A selection ending at the start of line N+1 should report N as
  // the last line covered by the selection.
  const endLine = offsetToLine(codeText, endOffset, { trimTrailingNewline: true });
  // After trimming, endLine could fall below startLine for empty / pathological
  // ranges; clamp to startLine so the reference always represents at least
  // one line.
  const safeEndLine = Math.max(startLine, endLine);

  return {
    kind: "reference",
    record: { path, startLine, endLine: safeEndLine },
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
