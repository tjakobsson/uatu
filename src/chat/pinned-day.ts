/**
 * Day separators are sticky siblings in one container, so every day already
 * scrolled past stays pinned at the top with the current one. Only their
 * labels are opaque (the row lets the transcript show through), so a pinned
 * older label would show around a narrower newer one. A label is therefore
 * marked superseded, and hidden by the stylesheet, once the next day's label
 * reaches it: at most one label is visible at the top at a time, and it is
 * the day being read.
 */
export const SUPERSEDED_ATTRIBUTE = "data-superseded";

const separatorsOf = (container: Element): HTMLElement[] =>
  Array.from(container.children).filter((child): child is HTMLElement => child.classList.contains("chat-day-separator"));

export function markSupersededDayLabels(container: Element): void {
  const separators = separatorsOf(container);
  // Measure every label first, then write, so the pass forces one layout.
  const bounds = separators.map(separator => (separator.querySelector("time") ?? separator).getBoundingClientRect());
  separators.forEach((separator, index) => {
    const next = bounds[index + 1];
    const superseded = !!next && next.top < bounds[index]!.bottom;
    if (separator.hasAttribute(SUPERSEDED_ATTRIBUTE) !== superseded) separator.toggleAttribute(SUPERSEDED_ATTRIBUTE, superseded);
  });
}

/**
 * Keeps `container`'s labels marked while `scroller` scrolls or anything in
 * it changes size or order: at most once per frame, and only while there are
 * two separators to compare. Returns the teardown.
 */
export function watchPinnedDayLabels(scroller: HTMLElement, container: HTMLElement): () => void {
  let frame = 0;
  const update = () => {
    frame = 0;
    // A lone separator has nothing to be superseded by: skip the measuring.
    const separators = separatorsOf(container);
    if (separators.length < 2) separators.forEach(separator => separator.removeAttribute(SUPERSEDED_ATTRIBUTE));
    else markSupersededDayLabels(container);
  };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
  scroller.addEventListener("scroll", schedule, { passive: true });
  const resize = typeof ResizeObserver === "function" ? new ResizeObserver(schedule) : null;
  resize?.observe(scroller);
  resize?.observe(container);
  const children = typeof MutationObserver === "function" ? new MutationObserver(schedule) : null;
  children?.observe(container, { childList: true });
  return () => {
    scroller.removeEventListener("scroll", schedule);
    resize?.disconnect();
    children?.disconnect();
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
  };
}
