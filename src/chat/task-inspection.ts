// Inspecting a running background task (design D7). Two views share the
// drill-down chrome: an agent task opens its child transcript with a header
// strip stating the task's facts, and a shell task opens a task view whose
// body is a bounded tail of the output file, re-read on a timer. The strip
// and the pane are one panel here, kept in sync by the same repaint that
// redraws the composer's task list — the task item changes in place, so the
// panel only ever needs the current item and whether a stop is in flight.
//
// The pure helpers decide where a row leads and how the facts read; the
// panel owns the DOM and the two timers (the elapsed clock, the output poll).
// Timers are injected so the lifecycle can be tested without waiting.

import { formatTokens } from "./usage";
import { workerStateLabel } from "./worker-state";
import type { BackgroundTaskItem, BackgroundTaskOutput, BackgroundTaskUsage, ConversationItem } from "./types";

/** Where selecting a running task's row leads. */
export type TaskInspection =
  | { view: "transcript"; conversationId: string }
  | { view: "output" };

/**
 * A running agent task opens the subagent's transcript, which the normalizer
 * names from the start edge; anything else — a shell task, or an agent whose
 * child is not (yet) known — opens the task view, which needs no child.
 * A settled task is not inspectable from the list: it has left the list and
 * taken a timeline row.
 */
export function taskInspection(task: BackgroundTaskItem): TaskInspection | undefined {
  if (task.childConversationId) return { view: "transcript", conversationId: task.childConversationId };
  if (task.status !== "running" && !task.outputFile) return undefined;
  return { view: "output" };
}

/** Historical children are not picker entries; their task link survives settlement. */
export function taskForChild(items: readonly ConversationItem[], childId: string, sourceItemId?: string): BackgroundTaskItem | undefined {
  const tasks = items.filter((item): item is BackgroundTaskItem => item.type === "background_task" && item.childConversationId === childId);
  if (sourceItemId) {
    const exact = tasks.find(item => item.id === sourceItemId || sourceItemId === `tool:${item.toolUseId}`
      || item.toolUseIds?.some(call => sourceItemId === `tool:${call}`));
    if (exact) return exact;
  }
  return tasks.sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))[0];
}

/** The running task that a child transcript belongs to, if any. */
export function runningTaskForChild(items: readonly ConversationItem[], conversationId: string): BackgroundTaskItem | undefined {
  return items.find((item): item is BackgroundTaskItem => item.type === "background_task" && item.status === "running" && item.childConversationId === conversationId);
}

export function taskById(items: readonly ConversationItem[], taskId: string, itemId?: string): BackgroundTaskItem | undefined {
  const tasks = items.filter((item): item is BackgroundTaskItem => item.type === "background_task" && item.taskId === taskId);
  return itemId === undefined ? tasks.sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))[0] : tasks.find(item => item.id === itemId);
}

/** "0:07" / "1:05" / "1:02:03" — a clock, since the strip is watched rather than read once. */
export function formatTaskElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60) % 60;
  const hours = Math.floor(seconds / 3600);
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds % 60)}` : `${minutes}:${pad(seconds % 60)}`;
}

/** "1 tool use" / "3 tool uses" — the count beside the token figure. */
export function taskUsesLabel(usage: BackgroundTaskUsage): string {
  return usage.toolUses === 1 ? "1 tool use" : `${usage.toolUses} tool uses`;
}

/** "13.1k tokens · 1 tool use", as the agent's progress reports it. */
export function taskUsageLabel(usage: BackgroundTaskUsage): string {
  return `${formatTokens(usage.totalTokens)} tokens · ${taskUsesLabel(usage)}`;
}

/** Outcome only: the report body belongs to the canonical timeline result. */
export function taskSettledLabel(task: BackgroundTaskItem): string {
  return workerStateLabel(task.status, task.stateUncertain);
}

// How often the output pane re-reads the tail while the task runs. The file
// is what the model itself reads through TaskOutput, so a two-second cadence
// keeps the view honest without a stream (design D7, non-goal: streaming).
export const TASK_OUTPUT_REFRESH_MS = 2_000;

// A read that fails is not retried at the full cadence for as long as the
// task runs: each consecutive failure doubles the wait, up to this cap, and
// the next read that answers puts the cadence back. A workspace that has gone
// away is then asked about twice a minute rather than every two seconds.
export const TASK_OUTPUT_BACKOFF_MAX_MS = 30_000;

/** The wait before the next output read after `failures` consecutive failed reads. */
export function taskOutputRefreshDelay(failures: number): number {
  return Math.min(TASK_OUTPUT_REFRESH_MS * 2 ** Math.max(0, failures), TASK_OUTPUT_BACKOFF_MAX_MS);
}

export type TaskInspectionTimers = {
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

export type TaskInspectionHosts = {
  // The header strip above the transcript or the output pane.
  strip: HTMLElement;
  // The output pane and its parts; the pane is shown for the output view only.
  output: HTMLElement;
  outputText: HTMLElement;
  outputNote: HTMLElement;
};

export type TaskInspectionOptions = {
  hosts: TaskInspectionHosts;
  fetchOutput: (conversationId: string, taskId: string, signal: AbortSignal) => Promise<BackgroundTaskOutput | null>;
  // Whether the surface is on screen; a hidden page skips the read and lets
  // the next tick try again.
  active?: () => boolean;
  onError?: (error: unknown) => void;
  // A read answered after one or more failed: the error `onError` reported
  // is no longer true. The output view has no child stream whose next event
  // would take the error line down, so the panel says when it can go.
  onRecovered?: () => void;
  now?: () => number;
  timers?: TaskInspectionTimers;
};

export type OpenTaskInspection = { conversationId: string; taskId: string; itemId?: string; view: TaskInspection["view"] };

export class TaskInspectionPanel {
  private readonly hosts: TaskInspectionHosts;
  private readonly fetchOutput: TaskInspectionOptions["fetchOutput"];
  private readonly active: () => boolean;
  private readonly onError: (error: unknown) => void;
  private readonly onRecovered: () => void;
  private readonly now: () => number;
  private readonly timers: TaskInspectionTimers;
  private current: OpenTaskInspection | null = null;
  private task: BackgroundTaskItem | undefined;
  private painted = "";
  private elapsedTimer: unknown = null;
  private outputTimer: unknown = null;
  private outputRead: AbortController | null = null;
  // Consecutive failed output reads, which set the backoff; zero once a read
  // answers.
  private outputFailures = 0;
  // Whether the server said the output is final: the file will not grow, so
  // the poll ends even if the task item's own settle has not arrived.
  private outputFinal = false;
  // Whether the reader is at the end of the output: the pane follows new
  // output only while they are, so scrolling up to read holds still.
  private following = true;

  constructor(options: TaskInspectionOptions) {
    this.hosts = options.hosts;
    this.fetchOutput = options.fetchOutput;
    this.active = options.active ?? (() => true);
    this.onError = options.onError ?? (() => {});
    this.onRecovered = options.onRecovered ?? (() => {});
    this.now = options.now ?? (() => Date.now());
    this.timers = options.timers ?? {
      setInterval: (fn, ms) => setInterval(fn, ms),
      clearInterval: handle => clearInterval(handle as ReturnType<typeof setInterval>),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
    };
    this.hosts.outputText.addEventListener("scroll", () => {
      const pane = this.hosts.outputText;
      this.following = pane.scrollHeight - pane.scrollTop - pane.clientHeight <= 1;
    });
  }

  /** The task the panel is showing, or null while closed. */
  get open(): OpenTaskInspection | null {
    return this.current;
  }

  /** Shows the panel for a task; `sync` then keeps it current. */
  show(link: OpenTaskInspection, task: BackgroundTaskItem | undefined, stopping = false): void {
    if (this.current && (this.current.conversationId !== link.conversationId || this.current.taskId !== link.taskId || this.current.itemId !== link.itemId || this.current.view !== link.view)) this.close();
    this.current = link;
    this.following = true;
    this.outputFailures = 0;
    this.outputFinal = false;
    this.hosts.output.hidden = link.view !== "output";
    if (link.view === "output") {
      this.hosts.outputText.textContent = "";
      this.hosts.outputNote.textContent = "Output not yet available";
      this.hosts.outputNote.hidden = false;
    }
    this.sync(task, stopping);
    if (link.view === "output") this.refreshOutput();
  }

  /**
   * The repaint hook: the task item as it now stands (undefined when it is
   * gone from the projection) and whether a stop is in flight. Rebuilds the
   * strip only when what it says changed; the elapsed clock ticks on its own.
   */
  sync(task: BackgroundTaskItem | undefined, stopping = false): void {
    if (!this.current) return;
    const wasRunning = this.task?.status === "running";
    this.task = task;
    const running = task?.status === "running";
    const signature = task
      ? [task.taskId, task.status, task.stateUncertain ? "uncertain" : "", task.description, task.subagentType ?? "", task.progress ?? "", task.summary ?? "", task.usage ? `${task.usage.totalTokens}/${task.usage.toolUses}` : "", stopping ? "stopping" : ""].join("\u0001")
      : "";
    if (signature !== this.painted) {
      this.painted = signature;
      this.paintStrip(task, stopping);
    }
    if (running && this.elapsedTimer === null) {
      this.elapsedTimer = this.timers.setInterval(() => this.tickElapsed(), 1_000);
    }
    if (!running && this.elapsedTimer !== null) {
      this.timers.clearInterval(this.elapsedTimer);
      this.elapsedTimer = null;
    }
    // Settling ends the poll and reads once more: the file gains its
    // `[exited with code N]` line at the end, and the last poll may have
    // missed the final output. A read the server already marked settled
    // has shown that final output, so there is nothing left to catch.
    if (wasRunning && !running && this.current.view === "output") {
      this.stopOutputTimer();
      if (!this.outputFinal) this.refreshOutput();
    }
  }

  close(): void {
    if (this.elapsedTimer !== null) {
      this.timers.clearInterval(this.elapsedTimer);
      this.elapsedTimer = null;
    }
    this.stopOutputTimer();
    this.outputRead?.abort();
    this.outputRead = null;
    this.outputFailures = 0;
    this.outputFinal = false;
    this.current = null;
    this.task = undefined;
    this.painted = "";
    this.hosts.strip.hidden = true;
    this.hosts.strip.replaceChildren();
    this.hosts.output.hidden = true;
    this.hosts.outputText.textContent = "";
    this.hosts.outputNote.textContent = "";
    this.hosts.outputNote.hidden = true;
  }

  private paintStrip(task: BackgroundTaskItem | undefined, stopping: boolean): void {
    const strip = this.hosts.strip;
    if (!task) {
      strip.hidden = true;
      strip.replaceChildren();
      return;
    }
    strip.dataset.taskId = task.taskId;
    strip.dataset.taskState = task.status === "running" ? "running" : "settled";
    strip.classList.toggle("is-settled", task.status !== "running");
    const line = document.createElement("div");
    line.className = "chat-drilldown-task-line";
    const description = document.createElement("span");
    description.className = "chat-drilldown-task-description";
    description.textContent = task.description;
    description.title = task.description;
    line.append(description);
    if (task.subagentType) {
      const type = document.createElement("code");
      type.className = "chat-drilldown-task-type";
      type.textContent = task.subagentType;
      line.append(type);
    }
    // A foreground run (a typed command's) is the turn's own work: the turn's
    // Cancel stops it, and the per-task stop the CLI offers is for background
    // work only, so the strip offers none.
    if (task.status === "running" && !task.stateUncertain && task.foreground !== true) {
      const stop = document.createElement("button");
      stop.type = "button";
      stop.className = "chat-task-stop";
      stop.dataset.stopTask = task.taskId;
      stop.dataset.stopItem = task.id;
      const nativeWorker = task.taskType === "agent" || task.taskType === "shell";
      stop.textContent = stopping ? "Stopping…" : nativeWorker ? "Stop worker" : "Stop";
      stop.disabled = stopping;
      stop.setAttribute("aria-label", nativeWorker ? `Stop worker: ${task.description}` : `Stop ${task.description}`);
      line.append(stop);
    }
    const facts = document.createElement("div");
    facts.className = "chat-drilldown-task-facts";
    if (task.stateUncertain) {
      facts.textContent = "Status unavailable — reconnecting";
    } else if (task.status === "running") {
      const elapsed = document.createElement("span");
      elapsed.className = "chat-drilldown-task-elapsed";
      elapsed.dataset.taskElapsed = "";
      elapsed.textContent = formatTaskElapsed(this.now() - task.createdAt);
      facts.append(elapsed);
      if (task.progress) {
        const progress = document.createElement("span");
        progress.className = "chat-drilldown-task-progress";
        progress.textContent = task.progress;
        facts.append(progress);
      }
      if (task.usage) {
        const usage = document.createElement("span");
        usage.className = "chat-drilldown-task-usage";
        usage.textContent = taskUsageLabel(task.usage);
        // The compact figure shortcuts a billion-scale run to "1.0B" —
        // nearly 50M tokens of rounding — so the exact count stays one
        // hover away, the pairing every other token figure keeps.
        usage.title = `${task.usage.totalTokens.toLocaleString()} tokens · ${taskUsesLabel(task.usage)}`;
        facts.append(usage);
      }
    } else {
      const settled = document.createElement("span");
      settled.className = "chat-drilldown-task-settled";
      settled.textContent = taskSettledLabel(task);
      facts.append(settled);
      const result = document.createElement("button");
      result.type = "button";
      result.className = "chat-secondary-button";
      result.dataset.taskResult = task.id;
      result.textContent = "View worker result";
      facts.append(result);
    }
    strip.replaceChildren(line, facts);
    strip.hidden = false;
  }

  private tickElapsed(): void {
    const task = this.task;
    if (!task || task.status !== "running") return;
    const readout = this.hosts.strip.querySelector<HTMLElement>("[data-task-elapsed]");
    if (readout) readout.textContent = formatTaskElapsed(this.now() - task.createdAt);
  }

  private stopOutputTimer(): void {
    if (this.outputTimer !== null) {
      this.timers.clearTimeout(this.outputTimer);
      this.outputTimer = null;
    }
  }

  // One read at a time, and the next scheduled only after this one answers,
  // so a slow read never stacks requests behind it. A read that fails waits
  // longer before the next (`taskOutputRefreshDelay`); one that answers —
  // "not yet available" included, which is an answer — resets the wait and
  // takes down the error the failures reported. A read the server marks
  // settled is the last: the output is final, whatever the task item says.
  private refreshOutput(): void {
    const link = this.current;
    if (!link || link.view !== "output") return;
    this.stopOutputTimer();
    if (!this.active()) {
      this.scheduleOutputRefresh();
      return;
    }
    this.outputRead?.abort();
    const read = new AbortController();
    this.outputRead = read;
    void this.fetchOutput(link.conversationId, link.taskId, read.signal).then(output => {
      if (read.signal.aborted || this.current !== link) return;
      this.paintOutput(output);
      if (output?.settled) this.outputFinal = true;
      if (this.outputFailures > 0) {
        this.outputFailures = 0;
        this.onRecovered();
      }
    }, error => {
      if (read.signal.aborted || this.current !== link) return;
      this.outputFailures += 1;
      this.onError(error);
    }).finally(() => {
      if (this.outputRead === read) this.outputRead = null;
      if (read.signal.aborted || this.current !== link) return;
      if (this.task?.status === "running" && !this.outputFinal) this.scheduleOutputRefresh();
    });
  }

  private scheduleOutputRefresh(): void {
    this.stopOutputTimer();
    this.outputTimer = this.timers.setTimeout(() => {
      this.outputTimer = null;
      this.refreshOutput();
    }, taskOutputRefreshDelay(this.outputFailures));
  }

  private paintOutput(output: BackgroundTaskOutput | null): void {
    const { outputText, outputNote } = this.hosts;
    if (!output) {
      outputNote.textContent = this.task?.taskType === "shell"
        ? "Output unavailable from the provider. Already received output remains here; it may be lost after reload."
        : "Output not yet available";
      outputNote.hidden = false;
      return;
    }
    if (outputText.textContent !== output.text) outputText.textContent = output.text;
    outputNote.textContent = output.truncated ? "Showing the end of the output; earlier lines are trimmed." : "";
    outputNote.hidden = !output.truncated;
    if (this.following) outputText.scrollTop = outputText.scrollHeight;
  }
}

// A run that is still working but has said nothing on its live stream for
// this long is read from its transcript on disk instead (design D14), and
// re-read at the same cadence for as long as it stays silent. Two seconds:
// the CLI writes a forked run's transcript live, and a typed command's run
// streams nothing at all, so this is the only way its drill-down moves.
export const SILENT_RUN_QUIET_MS = 2_000;
export const SILENT_RUN_REFRESH_MS = 2_000;

// The reads a run gets when it settles while silent: one as soon as the
// settle is known, and one more a refresh period later. A typed command's run
// never streams, so its last records (the closing thought, then the review
// itself) reach an open drill-down only through a read made after the settle.
// The CLI appends a run's records as they arrive and announces the settle
// once the run has returned; the re-check on CLI 2.1.280 found the final text
// on disk by the time the settle showed, so the first read is the one that
// matters. The second is a bounded guard against a transcript flushed just
// behind the announcement. A read that brought nothing new cannot tell a
// complete transcript from a late one, and a read that did bring something
// may hold the thought without the text, since they are separate records, so
// the guard does not depend on what the first read found. Then nothing more:
// a settled run is never polled.
export const SILENT_RUN_SETTLE_READS = 2;

export type SilentRunFollowerOptions = {
  // One snapshot re-read of the open run, folded into the view. It resolves
  // to whether the read found the run still running, or to undefined when
  // the read did not apply (the drill-down moved on, or the page was older
  // than what the view already holds). The follower never starts a second
  // read before the first has answered.
  refresh: (signal: AbortSignal) => Promise<boolean | undefined>;
  // Whether the surface is on screen; a hidden page skips the read and lets
  // the next tick try again.
  active?: () => boolean;
  onError?: (error: unknown) => void;
  timers?: Pick<TaskInspectionTimers, "setTimeout" | "clearTimeout">;
  quietMs?: number;
  refreshMs?: number;
};

/**
 * Follows a silent run from its transcript on disk (design D14). The drill-
 * down says what the open run is doing — `follow(running)` on every change of
 * its status — and that its live stream just carried the run's words
 * (`heard()`); the follower re-reads the run's snapshot once the run has been
 * running and silent for `quietMs`, then every `refreshMs` while it stays so.
 * A live event puts the clock back to a full quiet period, so a run that
 * streams never trips it. A run that settles after streaming ends the follow,
 * since its last word came the same way; a run that settles while silent gets
 * its settle reads (`SILENT_RUN_SETTLE_READS`) first. A drill-down that closes
 * (`stop()`) ends everything, settle reads included.
 */
export class SilentRunFollower {
  private readonly refresh: SilentRunFollowerOptions["refresh"];
  private readonly active: () => boolean;
  private readonly onError: (error: unknown) => void;
  private readonly timers: Pick<TaskInspectionTimers, "setTimeout" | "clearTimeout">;
  private readonly quietMs: number;
  private readonly refreshMs: number;
  private running = false;
  // Whether the live stream has carried the run's words since the last read
  // began, or since the follow began: when it has at the settle, the run's
  // last word arrived that way and the disk has nothing to add.
  private spoke = false;
  // The reads still owed to a run that settled while silent.
  private settleReads = 0;
  private timer: unknown = null;
  private read: AbortController | null = null;

  constructor(options: SilentRunFollowerOptions) {
    this.refresh = options.refresh;
    this.active = options.active ?? (() => true);
    this.onError = options.onError ?? (() => {});
    this.timers = options.timers ?? {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
    };
    this.quietMs = options.quietMs ?? SILENT_RUN_QUIET_MS;
    this.refreshMs = options.refreshMs ?? SILENT_RUN_REFRESH_MS;
  }

  /** Whether a re-read is scheduled or in flight. */
  get following(): boolean {
    return this.timer !== null || this.read !== null;
  }

  /**
   * The open run's state. Running starts the quiet clock if it is not
   * already going. Settling after the stream spoke ends the follow, in-flight
   * read included. Settling while silent starts the settle reads at once; a
   * read already in flight is superseded, since it may have been made before
   * the run's last records were written.
   */
  follow(running: boolean): void {
    if (running === this.running) return;
    if (running) {
      this.running = true;
      this.spoke = false;
      this.settleReads = 0;
      // A settle read still in flight schedules the next read when it answers.
      if (!this.read) this.schedule(this.quietMs);
      return;
    }
    const spoke = this.spoke;
    this.stop();
    if (spoke) return;
    this.settleReads = SILENT_RUN_SETTLE_READS;
    this.tick();
  }

  /**
   * The run's live stream carried its words (a record, or text arriving): it
   * is not silent, so the quiet clock starts over. A status change alone is
   * not the run speaking, and the caller does not report one.
   */
  heard(): void {
    if (!this.running) return;
    this.spoke = true;
    if (this.read) return;
    this.schedule(this.quietMs);
  }

  /** The drill-down closed or moved to another run. */
  stop(): void {
    this.running = false;
    this.spoke = false;
    this.settleReads = 0;
    this.clearTimer();
    this.read?.abort();
    this.read = null;
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    this.timers.clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(ms: number): void {
    this.clearTimer();
    this.timer = this.timers.setTimeout(() => {
      this.timer = null;
      this.tick();
    }, ms);
  }

  private tick(): void {
    if (this.read || (!this.running && this.settleReads === 0)) return;
    // A hidden page makes no read, and a settle read waits for the page to
    // come back rather than being spent.
    if (!this.active()) {
      this.schedule(this.refreshMs);
      return;
    }
    if (!this.running) this.settleReads -= 1;
    this.spoke = false;
    const read = new AbortController();
    this.read = read;
    void this.refresh(read.signal).catch(error => {
      if (!read.signal.aborted) this.onError(error);
      return undefined;
    }).then(stillRunning => {
      // Superseded or stopped: whoever did that owns what happens next.
      if (this.read !== read) return;
      this.read = null;
      if (stillRunning === false && this.running) {
        // The read itself found the run settled. It read the transcript after
        // the settle, as a settle read would, so it counts as the first one.
        this.running = false;
        this.settleReads = this.spoke ? 0 : SILENT_RUN_SETTLE_READS - 1;
      } else if (stillRunning === true && !this.running) {
        // The view now holds the run as running again: follow it as such.
        this.follow(true);
        return;
      }
      if (this.running || this.settleReads > 0) this.schedule(this.refreshMs);
    });
  }
}
