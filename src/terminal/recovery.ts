// Attachment recovery for one terminal pane: the bounded loop that turns a
// failed or lost attachment into one of a fixed set of outcomes, using the
// same two signals whether the pane connects directly or through the hub —
// terminal reconstruction readiness (did the child accept and deliver the
// PTY?) and the authenticated inventory (does the PTY exist, and does anyone
// hold it?). A browser-side WebSocket `open` proves nothing here: the hub
// accepts the browser before it has asked the child.
//
// Pure by construction: time, the inventory read and the attach attempt are
// injected, so the timing — increasing delays, a total budget, requests and
// readiness bounded by what is left of it — is tested with a controlled clock
// rather than by sleeping. The pane owns what each outcome LOOKS like; this
// only decides which one it is.

export const RECOVERY_BUDGET_MS = 5_000;
export const RECOVERY_FIRST_DELAY_MS = 100;
export const RECOVERY_MAX_DELAY_MS = 1_000;

export type RecoveryClock = {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(timer: unknown): void;
};

// What an authenticated inventory read said. `failed` is a read that got no
// usable answer — network, 5xx, a malformed body — and is deliberately
// distinct from an empty list: it proves nothing about any PTY.
export type InventoryRead =
  | { kind: "ok"; sessions: { id: string; attached: boolean }[] }
  | { kind: "auth-required" }
  | { kind: "origin-rejected" }
  | { kind: "failed" };

// How one attach attempt ended.
//   ready    reconstruction was delivered: the child accepted this socket.
//   refused  the transport closed before readiness, whatever the code —
//            a pre-upgrade refusal, a collision, an upstream error through
//            the hub, a dropped connection. Inventory says which.
//   silent   the transport stayed open but readiness never came within the
//            deadline; the attempt closed it.
//   taken    the child answered with the takeover code (4410).
//   exit     the child reported the shell exited.
export type AttachAttemptResult = "ready" | "refused" | "silent" | "taken" | "exit";

export type RecoveryOutcome =
  | "attached"
  | "occupied"
  | "ended"
  | "unreachable"
  | "auth-required"
  | "origin-rejected"
  | "taken"
  | "cancelled";

export type RecoveryPhase =
  // The direct attempt, before any inventory is consulted.
  | { phase: "attaching"; attempt: number }
  // Reconciling with inventory: the pane shows itself reconnecting.
  | { phase: "reconciling"; attempt: number };

export type RecoveryDeps = {
  clock: RecoveryClock;
  // Bounded by the caller through `signal`: an abort ends the read.
  readInventory(signal: AbortSignal): Promise<InventoryRead>;
  // One attach attempt with at most `deadlineMs` to reach readiness. The
  // attempt owns its transport: it must close a socket that is still open
  // when it resolves anything but `ready`, and when `signal` aborts.
  attach(deadlineMs: number, signal: AbortSignal): Promise<AttachAttemptResult>;
  onPhase?(phase: RecoveryPhase): void;
};

export type RecoveryOptions = {
  budgetMs?: number;
  // Whether to try attaching before the first inventory read. A restore or
  // resume does (the common case is that it simply works); a recovery that
  // already knows its attach failed skips straight to inventory.
  direct?: boolean;
};

export type RecoveryRun = {
  outcome: Promise<RecoveryOutcome>;
  cancel(): void;
};

// The delay before attempt `index` (0-based) retries: 100 ms doubling, capped
// at one second.
export function recoveryDelayMs(index: number): number {
  return Math.min(RECOVERY_FIRST_DELAY_MS * 2 ** index, RECOVERY_MAX_DELAY_MS);
}

// One recovery: a single budget, however many attempts fit in it. Never
// restarts itself — a failed attempt inside the run is a retry within the
// same budget, and an outcome is final until the pane or the user starts a
// new run.
export function recoverAttachment(sessionId: string, deps: RecoveryDeps, options: RecoveryOptions = {}): RecoveryRun {
  const budgetMs = options.budgetMs ?? RECOVERY_BUDGET_MS;
  const controller = new AbortController();
  const { signal } = controller;
  const { clock } = deps;
  const deadline = clock.now() + budgetMs;
  const remaining = (): number => deadline - clock.now();

  // What the run last learned, for the verdict when the budget runs out.
  // Only a PTY seen held by someone else can settle as `occupied`; every
  // other exhaustion is `unreachable`, which offers a retry and claims
  // nothing about ownership or exit.
  let lastObservation: "occupied" | "refused" | "silent" | "unavailable" | null = null;

  const settle = (): RecoveryOutcome => (lastObservation === "occupied" ? "occupied" : "unreachable");

  const sleep = (ms: number): Promise<void> => new Promise(resolve => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = clock.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clock.clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });

  // An inventory read bounded by what is left of the budget: a read that
  // outlives it is abandoned, and the run settles rather than waiting.
  const readInventory = async (ms: number): Promise<InventoryRead | "cancelled" | "timeout"> => {
    const bounded = new AbortController();
    const onAbort = () => bounded.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    let timedOut = false;
    const timer = clock.setTimeout(() => {
      timedOut = true;
      bounded.abort();
    }, ms);
    try {
      const result = await deps.readInventory(bounded.signal);
      if (signal.aborted) return "cancelled";
      if (timedOut) return "timeout";
      return result;
    } catch {
      if (signal.aborted) return "cancelled";
      return timedOut ? "timeout" : { kind: "failed" };
    } finally {
      clock.clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
  };

  const attempt = async (ms: number): Promise<AttachAttemptResult | "cancelled"> => {
    let result: AttachAttemptResult;
    try {
      result = await deps.attach(ms, signal);
    } catch {
      result = "refused";
    }
    return signal.aborted ? "cancelled" : result;
  };

  const run = async (): Promise<RecoveryOutcome> => {
    let index = 0;
    let direct = options.direct !== false;
    for (;;) {
      if (signal.aborted) return "cancelled";
      const left = remaining();
      if (left <= 0) return settle();

      let attach: AttachAttemptResult | "cancelled" | null = null;
      if (direct) {
        direct = false;
        deps.onPhase?.({ phase: "attaching", attempt: index });
        attach = await attempt(left);
      } else {
        deps.onPhase?.({ phase: "reconciling", attempt: index });
        const read = await readInventory(left);
        if (read === "cancelled") return "cancelled";
        if (read === "timeout") {
          lastObservation ??= "unavailable";
          return settle();
        }
        if (read.kind === "auth-required" || read.kind === "origin-rejected") return read.kind;
        if (read.kind === "failed") {
          lastObservation = "unavailable";
        } else {
          const entry = read.sessions.find(session => session.id === sessionId);
          // A successful read that omits the PTY is authoritative: the shell
          // is gone. Nothing to take over, nothing to retry.
          if (!entry) return "ended";
          if (entry.attached) {
            lastObservation = "occupied";
          } else {
            const window = remaining();
            if (window <= 0) return settle();
            attach = await attempt(window);
          }
        }
      }

      if (attach !== null) {
        switch (attach) {
          case "cancelled": return "cancelled";
          case "ready": return "attached";
          case "taken": return "taken";
          case "exit": return "ended";
          case "refused":
            // Refused after inventory said detached is a race with another
            // client, or the departing holder still being processed; the
            // next read says which.
            lastObservation = "refused";
            break;
          case "silent":
            lastObservation = "silent";
            break;
        }
      }

      const wait = Math.min(recoveryDelayMs(index), remaining());
      index += 1;
      if (wait <= 0) return settle();
      await sleep(wait);
      if (signal.aborted) return "cancelled";
    }
  };

  return {
    outcome: run(),
    cancel: () => controller.abort(),
  };
}

// Classifies an inventory response. Shared by the pane (recovery) and kept
// away from the panel's own inventory reader, whose null-on-failure contract
// serves a different caller.
export function classifyInventoryResponse(status: number, body: unknown): InventoryRead {
  if (status === 401) return { kind: "auth-required" };
  if (status === 403) return { kind: "origin-rejected" };
  if (status < 200 || status >= 300) return { kind: "failed" };
  const sessions = (body as { sessions?: unknown } | null)?.sessions;
  if (!Array.isArray(sessions)) return { kind: "failed" };
  return {
    kind: "ok",
    sessions: sessions
      .filter((entry): entry is { id: string; attached: boolean } =>
        typeof entry === "object" && entry !== null
        && typeof (entry as { id?: unknown }).id === "string"
        && typeof (entry as { attached?: unknown }).attached === "boolean")
      .map(entry => ({ id: entry.id, attached: entry.attached })),
  };
}
