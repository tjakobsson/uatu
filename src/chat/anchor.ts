export type TimelineAnchor = { itemId: string; offset: number };
/** Which way a scroll event moved the viewport, judged against the previous event. */
export type ScrollMovement = "up" | "down" | "none";
export type AnchorGeometry = {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
  items: Array<{ id: string; top: number; bottom: number }>;
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

  constructor(private readonly endThreshold = 48) {}

  /**
   * Reads where the reader is after a scroll. Arriving near the end pins —
   * anything within the threshold counts, so a reader who stops just short
   * still follows the stream. Leaving is judged differently: `movement`
   * says which way the scroll went, and any upward step unpins, however
   * small. The
   * threshold cannot apply on the way out — while a turn streams, a render
   * lands every few frames, and each one drags a still-pinned viewport back
   * to the end, so a reader nudging a trackpad never gets past 48px and
   * feels every wheel tick reset. A decrease caused by a measured extent
   * clamp preserves the existing intent, including paused intent.
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
    const expected = this.expected;
    const maximum = Math.max(0, geometry.scrollHeight - geometry.clientHeight);
    const echo = expected !== null && Math.abs(geometry.scrollTop - Math.max(0, Math.min(expected, maximum))) <= 1;
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
    if (!this.anchor) return this.handOut(geometry.scrollTop);
    // Nothing measured means nothing rendered or laid out yet — a render
    // that ran before the surface had its size, a resize of a still-empty
    // timeline. That says nothing about whether the anchored item exists,
    // so the anchor waits for a measurement that can find it. Judging it
    // gone here would turn a restored position into a jump to the end.
    if (geometry.items.length === 0) return this.handOut(geometry.scrollTop);
    const item = geometry.items.find(candidate => candidate.id === this.anchor!.itemId);
    if (item) {
      this.restoring = false;
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
  restore(anchor: TimelineAnchor | null): void {
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
  return visible ? { itemId: visible.id, offset: visible.top } : null;
}
