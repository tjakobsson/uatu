// Whether a pinned list of running work — the composer's background tasks,
// the subagents track — is shown expanded. Running work is reachable without
// a disclosure click: the list opens when running work first appears in it.
// A collapse the user makes while it holds running work is a choice about
// that work, so it holds until the work is over and never reopens against
// them (spec: running work is reachable without disclosing the list; a list
// the user collapsed stays collapsed).
//
// Pure over what the surface reports, so the rule is testable without a DOM:
// the surface tells it, on every paint, which conversation it shows and how
// many running entries the list holds, and forwards the element's `toggle`
// events. It answers with the open state to apply, if any.

export class RunningWorkDisclosure {
  private conversationId: string | null = null;
  private running = false;
  private userCollapsed = false;
  private automaticallyOpened = false;
  /**
   * The state the element is known to be in: what this object last told the
   * surface to apply, or what a user toggle was last observed to leave. The
   * `toggle` event fires asynchronously after `open` changes, so a flag set
   * around the programmatic write would be cleared long before its event
   * arrives. Comparing the observed state with the known one instead tells
   * the two apart whenever the event lands: an event that finds the element
   * where it was put is this object's own write echoing back; one that finds
   * it elsewhere is the user.
   */
  private knownOpen: boolean;

  constructor(initiallyOpen = false) {
    this.knownOpen = initiallyOpen;
  }

  /**
   * One paint's reading of the list. Returns `true` when the list should be
   * opened now, `false` to collapse a redundant automatic expansion, and
   * `undefined` to leave it as it stands. Finished lists normally retain
   * their state; only a caller identifying duplicate detached work opts in.
   */
  paint(conversationId: string | null, runningCount: number, collapseAutomatic = false): boolean | undefined {
    // No conversation shown is a selection in flight, not a verdict on the
    // list: a refresh that clears and reinstalls the same conversation must
    // not read as its work ending and forget the user's collapse.
    if (conversationId === null) return undefined;
    if (conversationId !== this.conversationId) {
      // The collapse belongs to the conversation it was made in: it is a
      // choice about that conversation's work, and the next conversation's
      // running work is new work that has not been seen yet.
      this.conversationId = conversationId;
      this.running = false;
      this.userCollapsed = false;
      // The DOM's open state is retained across selection, so retain its
      // provenance too. A conversation switch is not a deliberate opening.
    }
    const running = runningCount > 0;
    const started = running && !this.running;
    this.running = running;
    // The work being over ends the collapse, so the next work opens again.
    if (!running) this.userCollapsed = false;
    if (!running && collapseAutomatic && this.automaticallyOpened && this.knownOpen) {
      this.knownOpen = false;
      this.automaticallyOpened = false;
      return false;
    }
    if (!started || this.userCollapsed || this.knownOpen) return undefined;
    this.knownOpen = true;
    this.automaticallyOpened = true;
    return true;
  }

  /** The element's `toggle` event, with the state it now reports. */
  toggled(open: boolean): void {
    if (open === this.knownOpen) return;
    this.knownOpen = open;
    this.automaticallyOpened = false;
    // Only a collapse of running work is held. Collapsing a list of finished
    // entries says nothing about work that has not started yet; opening a
    // list is taking back an earlier collapse.
    this.userCollapsed = !open && this.running;
  }
}
