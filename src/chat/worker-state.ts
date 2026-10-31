import type { BackgroundTaskItem, WorkerActivity } from "./types";

/** Shared worker vocabulary; an unavailable outcome is never success. */
export type WorkerState = "working" | "unknown" | "completed" | "failed" | "stopped";

export function workerState(status: string, uncertain = false, activity?: WorkerActivity): WorkerState {
  if (activity && (status === "running" || status === "working" || status === "unknown")) {
    return activity.kind === "working" || activity.kind === "needs-answer" ? "working" : "unknown";
  }
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

export function workerStateLabel(status: string, uncertain = false, activity?: WorkerActivity): string {
  const state = workerState(status, uncertain, activity);
  if (activity && (state === "working" || state === "unknown")) {
    switch (activity.kind) {
      case "working": return "Working";
      case "needs-answer": return "Needs your answer";
      case "checking": return "Checking status…";
      case "session-active": return "Session active · task unverified";
      case "ended": return "Ended · result unavailable";
      case "unavailable": return `Status unavailable · last seen ${activity.observedAt === undefined ? "unknown" : new Date(activity.observedAt).toLocaleString()}`;
    }
  }
  if (state === "unknown") return "Status unavailable · last seen unknown";
  return state === "completed" ? "finished" : state;
}

/** These presentation checks never replace native Stop's private revalidation. */
export function workerCanStop(task: BackgroundTaskItem): boolean {
  return task.status === "running" && task.foreground !== true && !task.stateUncertain
    && task.control?.available !== false && workerState(task.status, task.stateUncertain, task.activity) === "working";
}

export function workerExecutionClockRuns(task: BackgroundTaskItem): boolean {
  return task.status === "running" && (task.activity ? task.activity.kind === "working" : !task.stateUncertain);
}

/** Missing coverage withdraws current activity; it does not erase observed facts. */
export function unverifyWorkerTask(task: BackgroundTaskItem): BackgroundTaskItem {
  const { request: _request, ...activity } = task.activity ?? {};
  return { ...task, stateUncertain: true,
    ...(task.activity ? { activity: task.activity.kind === "ended" ? task.activity : { ...activity, kind: "unavailable" as const } } : {}),
    ...(task.control ? { control: { available: false, reason: "Stop unavailable: current execution coverage is incomplete" } } : {}) };
}
