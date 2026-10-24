/** A device-local learning bit; no message content or account state. */
export class QueueDiscovery {
  private learned = false;
  constructor(private readonly storage: Storage | null) {
    try { this.learned = storage?.getItem("chat-queue-learned") === "1"; } catch { /* page-local fallback */ }
  }
  visible(eligible: boolean): boolean { return eligible && !this.learned; }
  accepted(held: boolean): void {
    if (!held) return;
    this.learned = true;
    try { this.storage?.setItem("chat-queue-learned", "1"); } catch { /* learned for this page */ }
  }
}
