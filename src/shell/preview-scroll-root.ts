// Which element actually scrolls the preview.
//
// Three layouts answer this differently, and until this module existed six
// call sites answered it identically and wrongly. `.preview-shell` is the
// scroller in the desktop layout, so everything captured it once at module
// load — but touch mode lays it out `overflow: visible; height: auto`
// (`html[data-ui-mode="touch"] .preview-shell`) and the ≤900px stacked layout
// does the same, handing scrolling to the page in both. A `scrollTop`
// assignment on a non-scrolling element is not an error; it is silence, which
// is why the resulting bugs read as "the highlight paints but nothing moves".
//
// Resolved per call, never cached: the UI mode switches live, the stacked
// breakpoint is crossed by a rotation or a window drag, and docking the
// terminal changes the shell's geometry. The resolution is one computed-style
// read, so caching would buy nothing and cost correctness.
//
// The test is behavioural rather than a mode lookup — "can this element
// scroll?" instead of "are we in touch mode?" — so a fourth layout that hands
// scrolling to the page is handled without touching this file.

// The document's own scroller. `scrollingElement` is <html> in standards mode;
// the fallback is for a document that somehow has none.
function viewportScroller(): HTMLElement {
  return (document.scrollingElement as HTMLElement | null) ?? document.documentElement;
}

// `visible` and `clip` are the two values that do NOT establish a scroll
// container. `hidden` does — it scrolls programmatically even though the user
// cannot drag it — so it must count as one here.
function isScrollContainer(element: HTMLElement): boolean {
  const overflowY = getComputedStyle(element).overflowY;
  return overflowY !== "visible" && overflowY !== "clip";
}

// The rule itself, separated from the DOM so it can be tested.
//
// Split layout first: the rendered pane is its own scroll container and owns
// the content inside it, which is the one case that already worked. Then the
// shell, if it is currently a scroller. Otherwise the page, which is always a
// scroller and so always terminates the search.
//
// Generic in the element type because the unit suite's DOM (linkedom) has no
// `getComputedStyle`, no `scrollingElement`, and no `clientHeight` — faking
// those onto it would be testing the fake. The rule is what unit tests can
// honestly hold; that it is wired to the real cascade is an E2E question.
export function pickScrollRoot<T>(
  candidates: { renderedPane: T | null; shell: T | null; viewport: T },
  scrolls: (element: T) => boolean,
): T {
  const { renderedPane, shell, viewport } = candidates;
  if (renderedPane !== null && scrolls(renderedPane)) {
    return renderedPane;
  }
  if (shell !== null && scrolls(shell)) {
    return shell;
  }
  return viewport;
}

// The element that scrolls the preview right now.
export function previewScrollRoot(): HTMLElement {
  return pickScrollRoot(
    {
      renderedPane: document.querySelector<HTMLElement>("#preview .preview-pane-rendered"),
      shell: document.querySelector<HTMLElement>(".preview-shell"),
      viewport: viewportScroller(),
    },
    isScrollContainer,
  );
}

// Where to listen for that element's scroll events.
//
// Not the same thing as the element. When the viewport scroller scrolls, the
// event is fired at the *document* and reaches `window` — it never reaches
// `document.documentElement`, which is a child of the node it fires at. An
// element-bound listener there would attach cleanly and never fire once, which
// is the same species of silent no-op this module exists to remove.
export function previewScrollEventTarget(): EventTarget {
  const root = previewScrollRoot();
  return root === viewportScroller() ? document : root;
}

// How `IntersectionObserver` wants that element expressed as its `root`.
//
// The third translation over the same resolution, and the one that fails most
// quietly. An observer's root is an *element or the implicit viewport* — and
// for the viewport there is no element that will do. Both `<html>` and
// `<body>` are `height: 100%` boxes pinned to the document origin, so once the
// page scrolls they describe a region the content has already left. Passing
// either does not merely mis-report; it clips every target below the first
// screenful out of the root permanently. Those targets never intersect, at any
// scroll position, so a lazy consumer never acts on them at all (#186 — in
// touch mode AND in the ≤900px stacked layout, both of which hand scrolling to
// the page through `body { overflow: auto }`).
//
// Note what that means for a walk-up that looks for a scrolling overflow
// value: `<body>` matches, and is wrong. "Has an overflow" and "is the thing
// that scrolls" are different questions, which is the whole reason this
// resolver exists.
//
// Split out from the DOM for the same reason as `pickScrollRoot`.
export function observerRootFor<T>(root: T, viewport: T): T | null {
  return root === viewport ? null : root;
}

// The `root` an IntersectionObserver over preview content should use.
export function previewObserverRoot(): Element | null {
  return observerRootFor<Element>(previewScrollRoot(), viewportScroller());
}

// The visible box of a scroll container, in viewport coordinates.
//
// For an ordinary overflow container that is its border box. For the document
// scroller it is NOT: `documentElement.getBoundingClientRect()` describes the
// whole document, so its `height` is the full content height and its `top` is
// `-scrollTop` rather than 0. Both differences are load-bearing and both bite:
//
//   - as a visible box, the document rect makes every match test as "already
//     in view", so a reveal computes no scroll at all (#181);
//   - as an origin for `elementTop - rootTop + scrollTop`, a `top` of
//     `-scrollTop` double-counts the scroll offset, so heading activation
//     points drift further wrong the further down the page you are.
//
// The layout viewport is `documentElement.clientHeight`, anchored at 0.
export function scrollportRect(container: HTMLElement): { top: number; bottom: number; height: number } {
  const doc = container.ownerDocument;
  const viewport = doc.scrollingElement ?? doc.documentElement;
  if (container === viewport) {
    const height = doc.documentElement.clientHeight;
    return { top: 0, bottom: height, height };
  }
  const rect = container.getBoundingClientRect();
  return { top: rect.top, bottom: rect.bottom, height: rect.height };
}
