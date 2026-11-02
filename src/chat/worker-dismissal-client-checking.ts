import type { CompactWorker } from "./compact-work";
import type { BackgroundTaskItem, WorkerActivity } from "./types";

type Timers = { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(handle: unknown): void };
const key = (id: string, activity: WorkerActivity) => JSON.stringify([id, activity.executionId, activity.generation]);

/** A presentation deadline, not a new probe or a claim about provider activity. */
export class CheckingPresentation {
  private conversation: string | null = null;
  private deadlines = new Map<string, number>();
  private timer: unknown = null;
  constructor(private readonly changed: () => void, private readonly now = () => Date.now(), private readonly timers: Timers = {
    setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
  }) {}

  paint(conversation: string | null, workers: readonly CompactWorker[]): CompactWorker[] {
    if (conversation !== this.conversation) { this.dispose(); this.conversation = conversation; }
    const checking = new Set<string>();
    for (const worker of workers) {
      if (worker.activity?.kind !== "checking") continue;
      const id = key(worker.id, worker.activity); checking.add(id);
      if (!this.deadlines.has(id)) this.deadlines.set(id, this.now() + 10_000);
    }
    for (const id of this.deadlines.keys()) if (!checking.has(id)) this.deadlines.delete(id);
    this.schedule();
    return workers.map(worker => this.worker(worker));
  }

  worker(worker: CompactWorker): CompactWorker {
    return worker.activity?.kind === "checking" ? { ...worker, activity: this.activity(worker.id, worker.activity) } : worker;
  }

  task(task: BackgroundTaskItem | undefined): BackgroundTaskItem | undefined {
    return task?.activity?.kind === "checking" ? { ...task, activity: this.activity(task.id, task.activity) } : task;
  }

  private activity(id: string, activity: WorkerActivity): WorkerActivity {
    const deadline = this.deadlines.get(key(id, activity));
    return deadline !== undefined && this.now() >= deadline ? { ...activity, kind: "unavailable" } : activity;
  }
  private schedule(): void {
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = null;
    const next = Math.min(...[...this.deadlines.values()].filter(deadline => deadline > this.now()));
    if (Number.isFinite(next)) this.timer = this.timers.setTimeout(() => { this.timer = null; this.changed(); }, next - this.now());
  }
  dispose(): void {
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = null; this.deadlines.clear(); this.conversation = null;
  }
}
