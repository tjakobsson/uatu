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
   * feels every wheel tick reset. Only a decrease that still leaves the end
   * in view stays pinned: that is the browser clamping scrollTop after the
   * content shrank, not the reader leaving.
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
    this.expected = null;
    const echo = expected !== null && Math.abs(geometry.scrollTop - expected) <= 1;
    const distance = geometry.scrollHeight - geometry.clientHeight - geometry.scrollTop;
    if (!echo && movement === "up") this.pinned = distance <= 1;
    else if (!echo && movement === "down") this.pinned = distance <= this.endThreshold;
    if (this.pinned) {
      this.unseen = false;
      this.anchor = null;
    } else {
      this.anchor = captureAnchor(geometry);
    }
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
    if (item) return this.handOut(geometry.scrollTop + item.top - this.anchor.offset);
    this.pinned = true;
    this.anchor = null;
    this.unseen = false;
    return this.handOut(Math.max(0, geometry.scrollHeight - geometry.clientHeight));
  }

  jumpToLatest(geometry: AnchorGeometry): number {
    this.pinned = true;
    this.unseen = false;
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
  restore(anchor: TimelineAnchor | null): void { this.anchor = anchor; this.pinned = anchor === null; }
}

export function captureAnchor(geometry: AnchorGeometry): TimelineAnchor | null {
  const visible = geometry.items.find(item => item.bottom > 0 && item.top < geometry.clientHeight);
  return visible ? { itemId: visible.id, offset: visible.top } : null;
}
