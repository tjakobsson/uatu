// Flattens a subtree into the text a reader actually sees, plus the mapping
// back from a character offset in that flat string to the DOM node it came
// from.
//
// This exists because searching serialized HTML is wrong twice over: it
// matches markup the reader cannot see, and it *misses* content the reader
// can, since syntax highlighting splits `const foo` across adjacent `<span>`
// elements. Concatenating text nodes is the only view that agrees with what
// is on screen.
//
// The offset→node mapping is kept pure and separate from `Range`
// construction so it can be unit-tested against a parsed fragment — the same
// split `outline-headings.ts` uses against `outline.ts`.

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

// Element names whose text is never reader-visible content.
const SKIPPED_TAGS = new Set(["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT"]);

// Elements that start a new visual block. Text either side of one is not
// contiguous on screen, so a match must not span the boundary: `<p>foo</p>`
// followed by `<p>bar</p>` reads as two paragraphs, and reporting a hit for
// `foobar` would highlight something the reader cannot see as one phrase.
//
// Inline elements are deliberately absent — keeping them contiguous is the
// whole point of walking text nodes, since that is what lets a query match
// across the `<span>`s syntax highlighting inserts.
const BLOCK_TAGS = new Set([
  "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "BR", "CAPTION", "DD", "DETAILS",
  "DIALOG", "DIV", "DL", "DT", "FIELDSET", "FIGCAPTION", "FIGURE", "FOOTER",
  "FORM", "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "HR", "LI", "MAIN",
  "NAV", "OL", "P", "PRE", "SECTION", "SUMMARY", "TABLE", "TBODY", "TD",
  "TFOOT", "TH", "THEAD", "TR", "UL",
]);

export type TextIndexEntry = {
  node: Text;
  // Half-open [start, end) in the flattened string.
  start: number;
  end: number;
};

export type TextIndex = {
  text: string;
  entries: TextIndexEntry[];
  // Shadow roots encountered while walking. Highlight styling is tree-scoped:
  // a `::highlight()` rule in the document stylesheet does not reach text
  // inside a shadow tree, so the painter needs to know which roots it must
  // teach. Same constraint `tree-view.ts` works around for its reveal cue.
  shadowRoots: ShadowRoot[];
};

export type TextSpan = { start: number; end: number };

// Where a span begins and ends in DOM terms. Deliberately not a `Range`:
// building one needs a live document, and this is the part worth testing.
export type RangeDescriptor = {
  startNode: Text;
  startOffset: number;
  endNode: Text;
  endOffset: number;
};

function isSkippedElement(element: Element): boolean {
  if (SKIPPED_TAGS.has(element.tagName)) {
    return true;
  }
  if (element.hasAttribute("hidden")) {
    return true;
  }
  // SVG subtrees are excluded on purpose. The CSS Custom Highlight API paints
  // text, not SVG `<text>`, so a match inside a rendered mermaid diagram could
  // be counted but never shown — worse than not finding it. Treating a
  // diagram as a picture rather than as prose is the consistent choice.
  return element.namespaceURI === "http://www.w3.org/2000/svg";
}

// Build the flat text of `root` together with the offset table.
//
// This walks children explicitly rather than using a `TreeWalker`. A walker
// would express the skip rules more compactly via `FILTER_REJECT`, but that
// value means "prune this subtree" only in a full DOM implementation — the
// parsed-fragment environment the unit tests run in accepts the children
// anyway. Two different traversals in test and production is exactly the
// divergence not worth having in the code that decides what "the text" is.
//
// Shadow roots inside the searched subtree ARE descended into. An earlier
// version refused to, reasoning that the sidebar tree's shadow content is not
// a find target — but that is already guaranteed by scoping the walk to
// `#preview`, and refusing shadow roots made the entire Diff view unsearchable:
// the diff component renders into a `<diffs-container>` shadow root, leaving
// `#preview` with twelve characters of toolbar text and nothing else. Anything
// inside the searched root is content the reader can see, whatever tree it
// lives in.
export function buildTextIndex(root: Node): TextIndex {
  const entries: TextIndexEntry[] = [];
  const shadowRoots: ShadowRoot[] = [];
  let text = "";

  const visit = (node: Node): void => {
    if (node.nodeType === TEXT_NODE) {
      const data = (node as Text).data;
      if (data.length > 0) {
        entries.push({ node: node as Text, start: text.length, end: text.length + data.length });
        text += data;
      }
      return;
    }
    if (node.nodeType === ELEMENT_NODE) {
      const element = node as Element;
      if (isSkippedElement(element)) {
        return;
      }
      // A block boundary becomes a newline in the flat text, backed by no text
      // node. `locateSpan` refuses spans that cross the resulting gap, so a
      // match is never highlighted across a break the reader does not see.
      if (BLOCK_TAGS.has(element.tagName) && text.length > 0 && !text.endsWith("\n")) {
        text += "\n";
      }
      // A closed `<details>` shows only its first `<summary>`; the rest of
      // the subtree exists in the DOM but not on screen, and a match there
      // would be reported yet never visible — and a project-search reveal
      // into it would count as success while highlighting nothing the reader
      // can see. The find engine re-runs when the `open` attribute toggles,
      // so the collapsed body becomes searchable the moment it is disclosed.
      if (element.tagName === "DETAILS" && !element.hasAttribute("open")) {
        for (let child = element.firstChild; child; child = child.nextSibling) {
          if (child.nodeType === ELEMENT_NODE && (child as Element).tagName === "SUMMARY") {
            visit(child);
            break;
          }
        }
        return;
      }
      // Walk the shadow tree in place of the host's light-DOM children when
      // one is attached: what the reader sees is the shadow content.
      const shadow = element.shadowRoot;
      if (shadow) {
        shadowRoots.push(shadow);
        for (let child = shadow.firstChild; child; child = child.nextSibling) {
          visit(child);
        }
        return;
      }
    }
    for (let child = node.firstChild; child; child = child.nextSibling) {
      visit(child);
    }
  };

  visit(root);
  return { text, entries, shadowRoots };
}

// Index of the entry containing `offset` as a start boundary:
// `start <= offset < end`.
function indexContaining(entries: TextIndexEntry[], offset: number): number {
  let low = 0;
  let high = entries.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const entry = entries[mid]!;
    if (offset < entry.start) {
      high = mid - 1;
    } else if (offset >= entry.end) {
      low = mid + 1;
    } else {
      return mid;
    }
  }
  return -1;
}

// Index of the entry containing `offset` as an end boundary:
// `start < offset <= end`. A match ending exactly on a node boundary belongs to
// the node it ended in, not the one that happens to start there — otherwise the
// range would close at offset 0 of the following node and render as zero-width.
function indexEndingAt(entries: TextIndexEntry[], offset: number): number {
  let low = 0;
  let high = entries.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const entry = entries[mid]!;
    if (offset <= entry.start) {
      high = mid - 1;
    } else if (offset > entry.end) {
      low = mid + 1;
    } else {
      return mid;
    }
  }
  return -1;
}

// Map a span of the flattened string back to DOM positions. Returns null for
// spans that are empty or fall outside the indexed text, so callers never
// build a degenerate range.
export function locateSpan(index: TextIndex, span: TextSpan): RangeDescriptor | null {
  if (span.end <= span.start) {
    return null;
  }
  const startIndex = indexContaining(index.entries, span.start);
  const endIndex = indexEndingAt(index.entries, span.end);
  if (startIndex === -1 || endIndex === -1) {
    return null;
  }
  // Checking only the endpoints would let a span straddle a block boundary —
  // the gap between entries is a separator with no text node behind it, and a
  // regex can match across the newline it inserts. Every entry in between must
  // be contiguous with its neighbour, or the span covers text the reader does
  // not see as continuous.
  for (let i = startIndex; i < endIndex; i += 1) {
    if (index.entries[i]!.end !== index.entries[i + 1]!.start) {
      return null;
    }
  }
  const startEntry = index.entries[startIndex]!;
  const endEntry = index.entries[endIndex]!;
  return {
    startNode: startEntry.node,
    startOffset: span.start - startEntry.start,
    endNode: endEntry.node,
    endOffset: span.end - endEntry.start,
  };
}

// Build the live `Range`. Trivial, and separated so everything above stays
// testable without a full DOM implementation.
export function toRange(descriptor: RangeDescriptor, ownerDocument: Document): Range {
  const range = ownerDocument.createRange();
  range.setStart(descriptor.startNode, descriptor.startOffset);
  range.setEnd(descriptor.endNode, descriptor.endOffset);
  return range;
}
