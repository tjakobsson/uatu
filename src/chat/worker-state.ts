/** Shared worker vocabulary; an unavailable outcome is never success. */
export type WorkerState = "working" | "unknown" | "completed" | "failed" | "stopped";

export function workerState(status: string, uncertain = false): WorkerState {
  if (uncertain) return "unknown";
  if (status === "running" || status === "working") return "working";
  if (status === "completed" || status === "idle") return "completed";
  if (status === "failed" || status === "error") return "failed";
  if (status === "stopped" || status === "cancelled") return "stopped";
  return "unknown";
}

export function workerIsActive(state: WorkerState): boolean {
  return state === "working" || state === "unknown";
}

export function workerStateLabel(status: string, uncertain = false): string {
  const state = workerState(status, uncertain);
  return state === "completed" ? "finished" : state;
}
