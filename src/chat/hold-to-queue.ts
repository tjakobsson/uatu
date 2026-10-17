import type { MessageDelivery } from "./types";

/** One pointer owns one immutable draft. Invalid state never becomes a tap. */
export class HoldToQueue {
  private gesture: { pointer: number; start: number; identity: string } | null = null;

  constructor(private readonly identity: () => string | null, private readonly deliver: (delivery: MessageDelivery) => void) {}

  begin(pointer: number, now: number): boolean {
    const identity = this.identity();
    if (this.gesture || identity === null) return false;
    this.gesture = { pointer, start: now, identity };
    return true;
  }

  progress(now: number): number | null {
    if (!this.gesture) return null;
    if (this.identity() !== this.gesture.identity) { this.cancel(); return null; }
    return Math.min(1, Math.max(0, (now - this.gesture.start) / 2000));
  }

  check(now: number): void {
    if (this.progress(now) !== 1) return;
    this.cancel(); // Consume before the callback can synchronously reenter.
    this.deliver("queue");
  }

  release(pointer: number, now: number): void {
    if (this.gesture?.pointer !== pointer) return;
    const progress = this.progress(now);
    this.cancel();
    if (progress === 1) this.deliver("queue");
    else if (progress !== null && progress < 0.125) this.deliver("steer");
  }

  cancel(): void { this.gesture = null; }
}
