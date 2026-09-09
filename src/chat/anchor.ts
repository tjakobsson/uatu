export type TimelineAnchor = { itemId: string; offset: number };
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

  constructor(private readonly endThreshold = 48) {}

  /**
   * Reads where the reader is after a scroll. Arriving near the end pins —
   * anything within the threshold counts, so a reader who stops just short
   * still follows the stream. Leaving is judged differently: `movedUp` says
   * the scroll went upward, and any upward step unpins, however small. The
   * threshold cannot apply on the way out — while a turn streams, a render
   * lands every few frames, and each one drags a still-pinned viewport back
   * to the end, so a reader nudging a trackpad never gets past 48px and
   * feels every wheel tick reset. Only a decrease that still leaves the end
   * in view stays pinned: that is the browser clamping scrollTop after the
   * content shrank, not the reader leaving.
   */
  observe(geometry: AnchorGeometry, movedUp = false): void {
    const distance = geometry.scrollHeight - geometry.clientHeight - geometry.scrollTop;
    this.pinned = distance <= (movedUp ? 1 : this.endThreshold);
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
    if (this.pinned) return Math.max(0, geometry.scrollHeight - geometry.clientHeight);
    if (hasNewContent) this.unseen = true;
    if (!this.anchor) return geometry.scrollTop;
    const item = geometry.items.find(candidate => candidate.id === this.anchor!.itemId);
    if (item) return geometry.scrollTop + item.top - this.anchor.offset;
    this.pinned = true;
    this.anchor = null;
    this.unseen = false;
    return Math.max(0, geometry.scrollHeight - geometry.clientHeight);
  }

  jumpToLatest(geometry: AnchorGeometry): number {
    this.pinned = true;
    this.unseen = false;
    this.anchor = null;
    return Math.max(0, geometry.scrollHeight - geometry.clientHeight);
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
