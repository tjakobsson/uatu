import type { AnchorGeometry, TimelineAnchor } from "./anchor";
import { measureChatWork } from "./performance";

/** Opaque, versioned fingerprints: presentation storage must not copy chat text. */
function blockKey(block: HTMLElement, text = block.textContent ?? "", context = block.localName): string {
  let first = 2166136261;
  let second = 5381;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    first = Math.imul(first ^ code, 16777619);
    second = Math.imul(second, 33) ^ code;
  }
  // The Markdown block type is structural context; an identical code block
  // and paragraph are not interchangeable reading locations.
  return `markdown-v1:${context}:${text.length}:${(first >>> 0).toString(36)}:${(second >>> 0).toString(36)}`;
}

type ContentGeometry = NonNullable<AnchorGeometry["items"][number]["content"]>[number];
type CaretDocument = Document & {
  caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  caretRangeFromPoint?: (x: number, y: number) => Range | null;
};

function textNodes(block: HTMLElement): Text[] {
  const walker = block.ownerDocument.createTreeWalker(block, 4 /* SHOW_TEXT */);
  const nodes: Text[] = [];
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if (!node.parentElement?.closest(".chat-shell-output")) nodes.push(node as Text);
  }
  return nodes;
}

/** Resolve every time: streaming may have replaced every descendant node. */
function characterGeometry(block: HTMLElement, key: string, offset: number, viewportTop: number, nodes = textNodes(block)): ContentGeometry | null {
  if (!Number.isSafeInteger(offset) || offset < 0) return null;
  let remaining = offset;
  for (const node of nodes) {
    if (remaining >= node.length) { remaining -= node.length; continue; }
    const range = block.ownerDocument.createRange();
    if (typeof range.setStart !== "function" || typeof range.getBoundingClientRect !== "function") return null;
    range.setStart(node, remaining);
    range.setEnd(node, remaining + 1);
    const rect = range.getBoundingClientRect();
    return rect.bottom > rect.top
      ? { key: `${key}:text:${offset}`, top: rect.top - viewportTop, bottom: rect.bottom - viewportTop } : null;
  }
  return null;
}

function visibleCharacter(block: HTMLElement, key: string, rect: DOMRect, viewport: DOMRect, nodes = textNodes(block)): ContentGeometry | null {
  const document = block.ownerDocument as CaretDocument;
  const x = Math.min(Math.max(rect.left, viewport.left) + 5, Math.min(rect.right, viewport.right) - 1);
  const y = Math.min(Math.max(rect.top, viewport.top) + 8, Math.min(rect.bottom, viewport.bottom) - 1);
  const position = document.caretPositionFromPoint?.(x, y);
  const range = position ? null : document.caretRangeFromPoint?.(x, y);
  const node = position?.offsetNode ?? range?.startContainer;
  const offset = position?.offset ?? range?.startOffset;
  // Hit tests can land on a sticky overlay or an independent nested viewport.
  if (!node || node.nodeType !== 3 || offset === undefined || !block.contains(node)
    || node.parentElement?.closest(".chat-shell-output")) return null;
  let preceding = 0;
  for (const text of nodes) {
    if (text === node) {
      const index = Math.min(preceding + offset, preceding + text.length - 1);
      return characterGeometry(block, key, index, viewport.top, nodes);
    }
    preceding += text.length;
  }
  return null;
}

const READING_BLOCKS = "p,h1,h2,h3,h4,h5,h6,pre,li,td,th";
const REGION_BOUNDARIES = `${READING_BLOCKS},ul,ol,blockquote,table,.chat-shell-output`;

/** Separate a tight list item's own inline runs from independent child blocks. */
function ownTextRuns(block: HTMLElement): Text[][] {
  const runs: Text[][] = [];
  let run: Text[] = [];
  const finish = () => {
    if (run.some(node => node.data.trim())) runs.push(run);
    run = [];
  };
  for (const child of Array.from(block.childNodes)) {
    if (child.nodeType === 3) run.push(child as Text);
    else if (child.nodeType === 1) {
      const element = child as HTMLElement;
      if (element.matches(REGION_BOUNDARIES) || element.querySelector(REGION_BOUNDARIES)) finish();
      else run.push(...textNodes(element));
    }
  }
  finish();
  return runs;
}

/** A region's box spans its own text only, never a nested list's geometry. */
function textRegionRect(nodes: Text[]): DOMRect | null {
  const rects = nodes.flatMap(node => {
    if (!node.length) return [];
    const range = node.ownerDocument.createRange();
    if (typeof range.setStart !== "function" || typeof range.getBoundingClientRect !== "function") return [];
    range.setStart(node, 0); range.setEnd(node, node.length);
    const rect = range.getBoundingClientRect();
    return rect.bottom > rect.top ? [rect] : [];
  });
  if (!rects.length) return null;
  const top = Math.min(...rects.map(rect => rect.top)), bottom = Math.max(...rects.map(rect => rect.bottom));
  const left = Math.min(...rects.map(rect => rect.left)), right = Math.max(...rects.map(rect => rect.right));
  return { top, bottom, left, right, width: right - left, height: bottom - top, x: left, y: top } as DOMRect;
}

function markdownGeometry(element: HTMLElement, viewport: DOMRect, height: number, retainedKey?: string): ContentGeometry[] {
  const markdown = element.querySelector<HTMLElement>(":scope > .chat-assistant-content.markdown-body");
  if (!markdown) return [];
  const candidates = Array.from(markdown.querySelectorAll<HTMLElement>(READING_BLOCKS))
    .filter(block => !block.closest(".chat-shell-output"));
  // A quote/list/table is not one indivisible reading location: paragraphs,
  // leaf list items and cells must survive changes to an earlier sibling.
  const containers = new Set<HTMLElement>();
  for (const block of candidates) {
    for (let parent = block.parentElement; parent && parent !== markdown; parent = parent.parentElement) containers.add(parent);
  }
  const leaves = candidates.filter(block => !containers.has(block));
  // Retain the former top-level wrapper keys after the finer candidates so
  // existing persisted anchors can still resolve when their wrapper is intact.
  const wrappers = Array.from(markdown.children).filter((block): block is HTMLElement =>
    block instanceof HTMLElement && !block.closest(".chat-shell-output") && /^(blockquote|ul|ol|table)$/.test(block.localName));
  const regions = [
    ...leaves.map(block => ({ block, nodes: undefined as Text[] | undefined, key: blockKey(block), wrapper: false })),
    ...candidates.filter(block => block.localName === "li" && containers.has(block)).flatMap(block =>
      ownTextRuns(block).map(nodes => ({ block, nodes, key: blockKey(block, nodes.map(node => node.data).join(""), "li-own"), wrapper: false }))),
    ...wrappers.map(block => ({ block, nodes: undefined as Text[] | undefined, key: blockKey(block), wrapper: true })),
  ];
  const counts = new Map<string, number>();
  for (const { key } of regions) counts.set(key, (counts.get(key) ?? 0) + 1);
  const measured = regions.flatMap(region => {
    const { block, nodes, key } = region;
    // Repeated text has no reliable identity after innerHTML replacement.
    // Keep the row fallback instead of guessing an occurrence by its index.
    if (counts.get(key) !== 1) return [];
    const rect = nodes ? textRegionRect(nodes) : block.getBoundingClientRect();
    return rect && rect.bottom > rect.top ? [{ ...region, rect }] : [];
  }).sort((a, b) => Number(a.wrapper) - Number(b.wrapper) || a.rect.top - b.rect.top);
  const visible = measured.find(({ rect }) => rect.bottom > viewport.top && rect.top < viewport.top + height);
  const fresh = visible && visibleCharacter(visible.block, visible.key, visible.rect, viewport, visible.nodes);
  const retained = retainedKey?.match(/^(.*):text:(\d+)$/);
  const retainedBlock = retained && measured.find(({ key }) => key === retained[1]);
  const previous = retainedBlock && characterGeometry(retainedBlock.block, retainedBlock.key, Number(retained![2]), viewport.top, retainedBlock.nodes);
  // A correction's scroll echo must retain the same visible character, not
  // recapture a new line-start character after every width step. Once it is
  // offscreen, captureAnchor naturally chooses the fresh visible entry.
  const content = [previous, fresh, ...measured.map(({ key, rect }) => ({ key, top: rect.top - viewport.top, bottom: rect.bottom - viewport.top }))];
  const seen = new Set<string>();
  return content.filter((entry): entry is ContentGeometry => {
    if (!entry || seen.has(entry.key)) return false;
    seen.add(entry.key);
    return true;
  });
}

/** Closed details may still give descendants content-visibility placeholder boxes. */
function insideClosedDetails(element: HTMLElement): boolean {
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    if (parent.localName !== "details" || parent.hasAttribute("open")) continue;
    const summary = Array.from(parent.children).find(child => child.localName === "summary");
    if (!summary?.contains(element)) return true;
  }
  return false;
}

const ROW_SELECTOR = "[data-chat-item-id]";

function presentedRow(element: HTMLElement): boolean {
  return !element.closest(".chat-shell-output") && !insideClosedDetails(element);
}

/**
 * Discover the first presented row without walking old history. Point lookup
 * uses the content band's edges, including inset/narrow aligned messages;
 * ancestors preserve the existing document-order choice of an activity group
 * before its nested tool rows. At most three columns in four text-line bands
 * are probed; later hits require a nonvisible immediate predecessor as proof.
 * No usable hit (hidden/occluded surface or an older DOM) means full fallback,
 * not empty geometry: losing a reader's anchor is worse than a slow read.
 */
function viewportRow(scroller: HTMLElement, container: HTMLElement, bounds: DOMRect, measure: (element: HTMLElement) => DOMRect): HTMLElement | null {
  const document = scroller.ownerDocument;
  if (typeof document.elementsFromPoint !== "function" && typeof document.elementFromPoint !== "function") return null;
  const view = document.defaultView;
  const content = container.getBoundingClientRect();
  const clientLeft = bounds.left + (scroller.clientLeft || 0), clientTop = bounds.top + (scroller.clientTop || 0);
  const viewportTop = Math.max(0, clientTop);
  const top = Math.max(viewportTop, content.top), bottom = Math.min(clientTop + scroller.clientHeight, view?.innerHeight ?? bounds.bottom, content.bottom);
  const left = Math.max(0, clientLeft, content.left), right = Math.min(clientLeft + (scroller.clientWidth || bounds.width), content.right, view?.innerWidth ?? bounds.right);
  if (bottom <= top || right <= left) return null;
  const inset = Math.min(1, (right - left) / 4);
  const xs = [(left + right) / 2, right - inset, left + inset];
  const firstY = top + Math.min(0.01, (bottom - top) / 2);
  // Only consult computed style for a gap, not the usual top-band hit.
  let lineHeight = 0;
  for (let band = 0; band < 4; band++) {
    if (band === 1) {
      const style = view?.getComputedStyle?.(scroller);
      lineHeight = Number.parseFloat(style?.lineHeight ?? "") || Number.parseFloat(style?.fontSize ?? "");
    }
    if (band > 0 && !(lineHeight > 0)) break;
    const y = firstY + band * lineHeight;
    if (y >= bottom) break;
    for (const x of xs) {
      const hits = typeof document.elementsFromPoint === "function"
        ? document.elementsFromPoint(x, y) : [document.elementFromPoint(x, y)];
      for (const hit of hits) {
        if (!hit || !container.contains(hit)) continue;
        let row: HTMLElement | null = null;
        for (let element: Element | null = hit; element && element !== container; element = element.parentElement) {
          if (element.matches(ROW_SELECTOR) && presentedRow(element as HTMLElement)) row = element as HTMLElement;
        }
        if (!row) continue;
        // Overflowing controls remain hit-testable after their owning row has
        // left the viewport (for example the user bubble's Revert action).
        // A descendant hit alone is not evidence of a visible reading row.
        const candidate = measure(row);
        if (candidate.bottom <= candidate.top || candidate.bottom <= viewportTop || candidate.top >= bottom) continue;
        if (band === 0) return row;
        // A hit below the reading edge may have skipped a narrow message.
        // Check one adjacent root row only: never descend into closed groups
        // or walk backwards through old history. Uncertain structure falls
        // back to the original scan instead of choosing the wrong anchor.
        if (row.parentElement !== container) return null;
        const previous = row.previousElementSibling as HTMLElement | null;
        if (!previous) return row;
        if (!previous.matches(ROW_SELECTOR) || !presentedRow(previous)) return null;
        const rect = measure(previous);
        return rect.bottom > rect.top && rect.bottom <= viewportTop ? row : null;
      }
    }
  }
  return null;
}

/** Read geometry only; the coordinated owner remains the sole scroll writer.
 * Normal reads measure the viewport row, retained row and explicit control row,
 * plus one adjacent witness in a gap. Offscreen retained keys remain resolvable
 * without materializing history. Rectangle reuse lasts for this read only.
 */
export function timelineGeometry(scroller: HTMLElement, container: HTMLElement, retained: TimelineAnchor | null, preferredItemId?: string): AnchorGeometry {
  const bounds = scroller.getBoundingClientRect();
  // Nearby-row validation and the final projection share each rectangle read.
  const measured = new Map<HTMLElement, DOMRect>();
  const measure = (element: HTMLElement): DOMRect => {
    let rect = measured.get(element);
    if (!rect) {
      const finish = measureChatWork("item-geometry");
      rect = element.getBoundingClientRect();
      finish();
      measured.set(element, rect);
    }
    return rect;
  };
  const visibleRow = viewportRow(scroller, container, bounds, measure);
  const selected = new Set<HTMLElement>();
  if (visibleRow) {
    selected.add(visibleRow);
    for (const id of [retained?.itemId, preferredItemId]) {
      if (!id) continue;
      // Hex escapes also handle quotes, backslashes and unusual provider IDs;
      // no global CSS.escape dependency in older embedded DOMs.
      const escaped = Array.from(id, character => `\\${character.codePointAt(0)!.toString(16)} `).join("");
      for (const row of container.querySelectorAll<HTMLElement>(`[data-chat-item-id="${escaped}"]`)) selected.add(row);
    }
  }
  const rows = (visibleRow ? Array.from(selected).sort((a, b) => a.compareDocumentPosition(b) & 4 ? -1 : 1)
    : Array.from(container.querySelectorAll<HTMLElement>(ROW_SELECTOR)))
    // Check structural presentation, not checkVisibility(contentVisibilityAuto):
    // offscreen auto rows still matter for retained anchors. This also works
    // without the optional checkVisibility API, and preserves a closed row's
    // own summary and descendants inside an ancestor's first summary.
    .filter(presentedRow)
    .map(element => {
      const rect = measure(element);
      return { element, id: element.dataset.chatItemId!, top: rect.top - bounds.top, bottom: rect.bottom - bounds.top };
    }).filter(row => row.bottom > row.top);
  const visible = rows.find(row => row.bottom > 0 && row.top < scroller.clientHeight);
  return {
    scrollTop: scroller.scrollTop,
    clientHeight: scroller.clientHeight,
    scrollHeight: scroller.scrollHeight,
    items: rows.map(({ element, ...row }) => {
      const content = (element === visible?.element || row.id === retained?.itemId)
        ? markdownGeometry(element, bounds, scroller.clientHeight, row.id === retained?.itemId ? retained.content?.key : undefined) : undefined;
      return { ...row, ...(content ? { content } : {}) };
    }),
  };
}
