export type TimelineAnchor = {
  itemId: string;
  offset: number;
  /** Opaque stable block key, never raw message text. Offsets are viewport-relative. */
  content?: { key: string; offset: number };
};
/** A paused view can have no measurable item yet; that is not following. */
export type TimelinePosition =
  | { kind: "following" }
  | { kind: "anchor"; anchor: TimelineAnchor }
  | { kind: "paused"; top: number };
/** Which way a scroll event moved the viewport, judged against the previous event. */
export type ScrollMovement = "up" | "down" | "none";
export type AnchorGeometry = {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
  items: Array<{
    id: string; top: number; bottom: number;
    /** Block rectangles use the same viewport-relative coordinates as the item. */
    content?: Array<{ key: string; top: number; bottom: number }>;
  }>;
};

export class TimelineAnchorController {
  private pinned = true;
  private unseen = false;
  private anchor: TimelineAnchor | null = null;
  // The position this controller last handed out. A scroll that lands there
  // is the caller's own assignment echoing back as an event.
  private expected: number | null = null;
  private previous: AnchorGeometry | null = null;
  private restoring = false;
  private fallbackTop: number | null = null;

  constructor(private readonly endThreshold = 48) {}

  /**
   * Reads where the reader is after a scroll. Downward arrival within the
   * end threshold pins; placement or stopping in that band does not.
   * Leaving is judged differently: `movement` says which way the scroll
   * went, and any upward step unpins, however small. Otherwise frequent
   * streaming renders pull the reader back before their next trackpad tick.
   * A measured extent clamp preserves existing intent, including paused intent.
   *
   * A scroll that lands where `afterMutation` or `jumpToLatest` just put it
   * is not the reader at all — it is that assignment echoing back, whether
   * restoring a saved position after a reload or holding an anchor through
   * a layout change above it. It neither pins nor unpins; only the anchor is
   * refreshed. Otherwise a position restored 12px above the end would read
   * as the reader arriving there, re-pin, and the next update would drop
   * the anchor and pull them to the end. An event that moved nothing is
   * treated the same way: only a downward movement is an arrival.
   */
  observe(geometry: AnchorGeometry, movement: ScrollMovement = "down"): void {
    this.fallbackTop = null;
    const expected = this.expected;
    const maximum = Math.max(0, geometry.scrollHeight - geometry.clientHeight);
    // A nearby but distinct position can be a genuine fractional reader step.
    // Assignment echoes match the applied top, allowing arithmetic roundoff only.
    const echo = expected !== null && Math.abs(geometry.scrollTop - Math.max(0, Math.min(expected, maximum))) < 1e-6;
    const previous = this.previous;
    const clamped = previous !== null && maximum < previous.scrollHeight - previous.clientHeight
      && previous.scrollTop > maximum && Math.abs(geometry.scrollTop - maximum) <= 1;
    this.previous = geometry;
    if (!echo) this.expected = null;
    const distance = geometry.scrollHeight - geometry.clientHeight - geometry.scrollTop;
    if (!echo && !clamped && movement === "up") this.pinned = false;
    else if (!echo && !clamped && movement === "down") this.pinned = distance <= this.endThreshold;
    if (this.pinned) {
      this.unseen = false;
      this.anchor = null;
    } else {
      this.anchor = captureAnchor(geometry);
    }
  }

  /** Input intent arrives before the browser's scroll event or default action. */
  pause(geometry: AnchorGeometry): void {
    this.fallbackTop = null;
    this.expected = null;
    this.previous = geometry;
    this.pinned = false;
    this.restoring = false;
    this.anchor = captureAnchor(geometry);
  }

  beforeMutation(geometry: AnchorGeometry, preferredItemId?: string): void {
    if (this.pinned) return;
    const preferred = preferredItemId ? geometry.items.find(item => item.id === preferredItemId) : undefined;
    this.anchor = preferred ? { itemId: preferred.id, offset: preferred.top } : captureAnchor(geometry);
  }

  afterMutation(geometry: AnchorGeometry, hasNewContent = false): number {
    if (this.pinned) return this.handOut(Math.max(0, geometry.scrollHeight - geometry.clientHeight));
    if (hasNewContent) this.unseen = true;
    if (!this.anchor) {
      const top = this.fallbackTop ?? geometry.scrollTop;
      this.fallbackTop = null;
      return this.handOut(top);
    }
    // Nothing measured means nothing rendered or laid out yet — a render
    // that ran before the surface had its size, a resize of a still-empty
    // timeline. That says nothing about whether the anchored item exists,
    // so the anchor waits for a measurement that can find it. Judging it
    // gone here would turn a restored position into a jump to the end.
    if (geometry.items.length === 0) return this.handOut(geometry.scrollTop);
    const item = geometry.items.find(candidate => candidate.id === this.anchor!.itemId);
    if (item) {
      this.restoring = false;
      const content = this.anchor.content;
      const blocks = content && item.content?.filter(candidate => candidate.key === content.key);
      if (content && blocks?.length === 1) {
        return this.handOut(geometry.scrollTop + blocks[0]!.top - content.offset);
      }
      return this.handOut(geometry.scrollTop + item.top - this.anchor.offset);
    }
    if (!this.restoring) {
      this.anchor = captureAnchor(geometry);
      return this.handOut(geometry.scrollTop);
    }
    this.pinned = true;
    this.anchor = null;
    this.unseen = false;
    this.restoring = false;
    return this.handOut(Math.max(0, geometry.scrollHeight - geometry.clientHeight));
  }

  jumpToLatest(geometry: AnchorGeometry): number {
    this.fallbackTop = null;
    this.pinned = true;
    this.unseen = false;
    this.restoring = false;
    this.anchor = null;
    return this.handOut(Math.max(0, geometry.scrollHeight - geometry.clientHeight));
  }

  private handOut(top: number): number {
    this.expected = top;
    return top;
  }

  isPinned(): boolean { return this.pinned; }
  hasUnseen(): boolean { return this.unseen; }
  currentAnchor(): TimelineAnchor | null { return this.anchor; }
  capturePosition(scrollTop: number): TimelinePosition {
    if (this.pinned) return { kind: "following" };
    if (this.anchor) return { kind: "anchor", anchor: this.anchor };
    return { kind: "paused", top: this.fallbackTop ?? (Number.isFinite(scrollTop) ? scrollTop : 0) };
  }
  restorePosition(position: TimelinePosition): void {
    if (position.kind === "paused" && !Number.isFinite(position.top)) return;
    this.restore(position.kind === "anchor" ? position.anchor : null);
    if (position.kind === "paused") {
      this.pinned = false;
      this.fallbackTop = position.top;
    }
  }
  restore(anchor: TimelineAnchor | null): void {
    this.fallbackTop = null;
    this.restoring = anchor !== null;
    this.anchor = anchor;
    this.pinned = anchor === null;
    this.expected = null;
    this.previous = null;
    this.unseen = false;
  }
}

export function captureAnchor(geometry: AnchorGeometry): TimelineAnchor | null {
  const visible = geometry.items.find(item => item.bottom > 0 && item.top < geometry.clientHeight);
  if (!visible) return null;
  const anchor: TimelineAnchor = { itemId: visible.id, offset: visible.top };
  const counts = new Map<string, number>();
  for (const block of visible.content ?? []) counts.set(block.key, (counts.get(block.key) ?? 0) + 1);
  const block = visible.content?.find(block => block.bottom > 0 && block.top < geometry.clientHeight
    && counts.get(block.key) === 1);
  if (block) anchor.content = { key: block.key, offset: block.top };
  return anchor;
}
