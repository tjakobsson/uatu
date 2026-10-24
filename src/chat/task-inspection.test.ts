import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";

import { SILENT_RUN_QUIET_MS, SILENT_RUN_REFRESH_MS, SILENT_RUN_SETTLE_READS, SilentRunFollower, TASK_OUTPUT_BACKOFF_MAX_MS, TASK_OUTPUT_REFRESH_MS, TaskInspectionPanel, formatTaskElapsed, runningTaskForChild, taskInspection, taskSettledLabel, taskUsageLabel, type TaskInspectionTimers } from "./task-inspection";
import type { BackgroundTaskItem, BackgroundTaskOutput } from "./types";
import { taskById, taskForChild } from "./task-inspection";

describe("task inspection facts", () => {
  test("a reused provider id stops only the latest occurrence and opens the selected historical occurrence", () => {
    const earlier = item({ id: "early", taskId: "reused", status: "completed", createdAt: 1 });
    const latest = item({ id: "late", taskId: "reused", status: "running", createdAt: 2 });
    expect(taskById([earlier, latest], "reused")).toBe(latest);
    expect(taskById([earlier, latest], "reused", "early")).toBe(earlier);
    expect(taskById([earlier, latest], "reused", "missing")).toBeUndefined();
  });
  test("historical result and joined launcher inspection retain their occurrence when the child is reused", () => {
    const earlier = item({ id: "task:early", taskId: "early", childConversationId: "child", status: "completed", createdAt: 1, toolUseId: "call-early", toolUseIds: ["call-early", "call-joined"] });
    const latest = item({ id: "task:latest", taskId: "latest", childConversationId: "child", status: "running", createdAt: 2, toolUseId: "call-latest" });
    expect(taskForChild([latest, earlier], "child", "task:early")).toBe(earlier);
    expect(taskForChild([latest, earlier], "child", "tool:call-early")).toBe(earlier);
    expect(taskForChild([latest, earlier], "child", "tool:call-joined")).toBe(earlier);
    expect(taskForChild([latest, earlier], "other", "task:early")).toBeUndefined();
  });
  test("a settled child's strip remains inspectable; reused children select the latest occurrence", () => {
    const earlier = item({ taskId: "early", childConversationId: "child", status: "completed", createdAt: 1 });
    const latest = item({ taskId: "latest", childConversationId: "child", status: "failed", createdAt: 2 });
    expect(taskForChild([latest, earlier], "child")).toBe(latest);
    expect(taskInspection(latest)).toEqual({ view: "transcript", conversationId: "child" });
    expect(taskInspection(item({ status: "completed", outputFile: "shell:one" }))).toEqual({ view: "output" });
  });
  test("the elapsed clock reads m:ss, then h:mm:ss", () => {
    expect(formatTaskElapsed(0)).toBe("0:00");
    expect(formatTaskElapsed(7_400)).toBe("0:07");
    expect(formatTaskElapsed(65_000)).toBe("1:05");
    expect(formatTaskElapsed(3_723_000)).toBe("1:02:03");
    expect(formatTaskElapsed(-5_000)).toBe("0:00");
  });

  test("usage and the settled line read as the agent reported them", () => {
    expect(taskUsageLabel({ totalTokens: 13_122, toolUses: 1, durationMs: 4_751 })).toBe("13k tokens · 1 tool use");
    expect(taskUsageLabel({ totalTokens: 640, toolUses: 3, durationMs: 100 })).toBe("640 tokens · 3 tool uses");
    expect(taskSettledLabel(item({ status: "completed", summary: "There is 1 file" }))).toBe("finished");
    expect(taskSettledLabel(item({ status: "failed" }))).toBe("failed");
    expect(taskSettledLabel(item({ status: "stopped", summary: "  " }))).toBe("stopped");
  });

  test("a child transcript is matched to the running task that owns it", () => {
    const agent = item({ taskId: "a", childConversationId: "sub:p:a" });
    const settled = item({ taskId: "b", childConversationId: "sub:p:b", status: "completed" });
    expect(runningTaskForChild([agent, settled], "sub:p:a")).toBe(agent);
    expect(runningTaskForChild([agent, settled], "sub:p:b")).toBeUndefined();
    expect(taskInspection(agent)).toEqual({ view: "transcript", conversationId: "sub:p:a" });
    expect(taskInspection(item({ taskType: "local_bash" }))).toEqual({ view: "output" });
  });
});

describe("task inspection panel", () => {
  let dom: ReturnType<typeof parseHTML>;
  let restore: Array<() => void> = [];
  let now = 100_000;
  let scheduled: Array<{ kind: "interval" | "timeout"; fn: () => void; ms: number; cleared: boolean }> = [];
  const timers: TaskInspectionTimers = {
    setInterval: (fn, ms) => { const entry = { kind: "interval" as const, fn, ms, cleared: false }; scheduled.push(entry); return entry; },
    clearInterval: handle => { (handle as { cleared: boolean }).cleared = true; },
    // A timeout that fires is spent, as a real one is.
    setTimeout: (fn, ms) => { const entry = { kind: "timeout" as const, ms, cleared: false, fn: () => { entry.cleared = true; fn(); } }; scheduled.push(entry); return entry; },
    clearTimeout: handle => { (handle as { cleared: boolean }).cleared = true; },
  };
  const live = () => scheduled.filter(entry => !entry.cleared);
  let reads: Array<{ conversationId: string; taskId: string; signal: AbortSignal; resolve: (output: BackgroundTaskOutput | null) => void; reject: (error: unknown) => void }> = [];
  let errors: unknown[] = [];
  let recoveries = 0;

  beforeEach(() => {
    dom = parseHTML('<!doctype html><html><body><div id="strip" hidden></div><div id="output" hidden><p id="note" hidden></p><pre id="text"></pre></div></body></html>');
    for (const [key, value] of Object.entries({ document: dom.document, window: dom.window })) {
      const old = Reflect.get(globalThis, key); Reflect.set(globalThis, key, value); restore.push(() => Reflect.set(globalThis, key, old));
    }
    now = 100_000;
    scheduled = [];
    reads = [];
    errors = [];
    recoveries = 0;
  });
  afterEach(() => { restore.forEach(fn => fn()); restore = []; });

  const hosts = () => ({
    strip: dom.document.querySelector("#strip") as unknown as HTMLElement,
    output: dom.document.querySelector("#output") as unknown as HTMLElement,
    outputText: dom.document.querySelector("#text") as unknown as HTMLElement,
    outputNote: dom.document.querySelector("#note") as unknown as HTMLElement,
  });
  const panel = () => new TaskInspectionPanel({
    hosts: hosts(),
    fetchOutput: (conversationId, taskId, signal) => new Promise((resolve, reject) => { reads.push({ conversationId, taskId, signal, resolve, reject }); }),
    onError: error => { errors.push(error); },
    onRecovered: () => { recoveries += 1; },
    now: () => now,
    timers,
  });
  const text = (selector: string) => dom.document.querySelector(selector)?.textContent ?? null;

  test("uncertain work remains inspectable but has no Stop; recovery restores it", () => {
    const view = panel();
    const task = item({ taskId: "uncertain", taskType: "agent", childConversationId: "child", stateUncertain: true });
    view.show({ conversationId: "one", taskId: task.taskId, view: "transcript" }, task);
    expect(hosts().strip.textContent).toContain("Status unavailable — reconnecting");
    expect(hosts().strip.querySelector("[data-stop-task]")).toBeNull();
    view.sync({ ...task, stateUncertain: false });
    expect(hosts().strip.querySelector("[data-stop-task]")).not.toBeNull();
    view.close();
  });

  for (const taskType of ["agent", "shell"]) test(`${taskType} inspection explicitly names Stop worker`, () => {
    const view = panel();
    const task = item({ taskId: "native", taskType, description: "Fixture worker" });
    view.show({ conversationId: "one", taskId: task.taskId, view: "transcript" }, task);
    const stop = hosts().strip.querySelector<HTMLButtonElement>("[data-stop-task]")!;
    expect(stop.textContent).toBe("Stop worker");
    expect(stop.getAttribute("aria-label")).toBe("Stop worker: Fixture worker");
    view.close();
  });

  test("an agent task's strip names the task, its type, progress, elapsed, spend, and Stop; it ticks and settles into one line", () => {
    const view = panel();
    const task = item({ taskId: "ada2b", description: "Review renderer", taskType: "local_agent", subagentType: "explore", createdAt: now - 65_000, childConversationId: "sub:p:ada2b", progress: "Reading the tests", usage: { totalTokens: 13_122, toolUses: 1, durationMs: 4_000 } });
    view.show({ conversationId: "one", taskId: "ada2b", view: "transcript" }, task);

    const strip = hosts().strip;
    expect(strip.hidden).toBe(false);
    expect(strip.dataset.taskId).toBe("ada2b");
    expect(strip.dataset.taskState).toBe("running");
    expect(text("#strip .chat-drilldown-task-description")).toBe("Review renderer");
    expect(text("#strip .chat-drilldown-task-type")).toBe("explore");
    expect(text("#strip .chat-drilldown-task-progress")).toBe("Reading the tests");
    expect(text("#strip [data-task-elapsed]")).toBe("1:05");
    expect(text("#strip .chat-drilldown-task-usage")).toBe("13k tokens · 1 tool use");
    const stop = dom.document.querySelector<HTMLButtonElement>('#strip [data-stop-task="ada2b"]')!;
    expect(stop.textContent).toBe("Stop");
    expect(stop.disabled).toBe(false);
    // The transcript view has no output pane.
    expect(hosts().output.hidden).toBe(true);
    expect(reads).toHaveLength(0);

    // The clock ticks once a second without rebuilding the strip.
    const clock = live().filter(entry => entry.kind === "interval");
    expect(clock.map(entry => entry.ms)).toEqual([1_000]);
    const description = dom.document.querySelector("#strip .chat-drilldown-task-description");
    now += 2_000;
    clock[0]!.fn();
    expect(text("#strip [data-task-elapsed]")).toBe("1:07");
    expect(dom.document.querySelector("#strip .chat-drilldown-task-description")).toBe(description);

    // A stop in flight disables the control; a progress update repaints in place.
    view.sync({ ...task, progress: "Using Bash" }, true);
    expect(text("#strip .chat-drilldown-task-progress")).toBe("Using Bash");
    expect(dom.document.querySelector<HTMLButtonElement>("#strip [data-stop-task]")!.disabled).toBe(true);
    expect(dom.document.querySelector("#strip [data-stop-task]")!.textContent).toBe("Stopping…");

    // Settling turns the strip into one line and stops the clock.
    view.sync({ ...task, status: "completed", summary: "Two findings" });
    expect(strip.dataset.taskState).toBe("settled");
    expect(strip.classList.contains("is-settled")).toBe(true);
    expect(text("#strip .chat-drilldown-task-settled")).toBe("finished");
    expect(dom.document.querySelector("#strip [data-stop-task]")).toBeNull();
    expect(dom.document.querySelector("#strip [data-task-elapsed]")).toBeNull();
    expect(live()).toHaveLength(0);

    view.close();
    expect(strip.hidden).toBe(true);
    expect(strip.childNodes.length).toBe(0);
  });

  test("settled inspection states the outcome and links to its canonical result without repeating the report", () => {
    const task = item({ id: "task:canonical", taskId: "canonical", childConversationId: "child", status: "failed", summary: "Long canonical report that must not be duplicated" });
    const view = panel();
    view.show({ conversationId: "parent", taskId: task.taskId, view: "transcript" }, task);
    expect(hosts().strip.textContent).toContain("failed");
    expect(hosts().strip.textContent).not.toContain(task.summary!);
    expect(hosts().strip.querySelector("[data-task-result]")?.getAttribute("data-task-result")).toBe(task.id);
  });
  test("a shell task's view reads the output on open, every two seconds while running, once more on settle, and never after close", async () => {
    const view = panel();
    const task = item({ taskId: "bgjpa", description: "sleep 25; echo done", taskType: "local_bash", createdAt: now - 3_000, outputFile: "/tmp/tasks/bgjpa.output" });
    view.show({ conversationId: "one", taskId: "bgjpa", view: "output" }, task);

    expect(hosts().output.hidden).toBe(false);
    expect(hosts().outputNote.hidden).toBe(false);
    expect(text("#note")).toBe("Output not yet available");
    expect(text("#strip [data-task-elapsed]")).toBe("0:03");
    // No progress note is asserted for a shell task; elapsed is its live signal.
    expect(dom.document.querySelector("#strip .chat-drilldown-task-progress")).toBeNull();
    expect(reads.map(read => [read.conversationId, read.taskId])).toEqual([["one", "bgjpa"]]);

    // Nothing is scheduled until the read answers: reads never stack.
    expect(live().filter(entry => entry.kind === "timeout")).toHaveLength(0);
    reads[0]!.resolve(null);
    await settle();
    expect(text("#note")).toBe("Output not yet available");
    const poll = live().filter(entry => entry.kind === "timeout");
    expect(poll.map(entry => entry.ms)).toEqual([TASK_OUTPUT_REFRESH_MS]);

    poll[0]!.fn();
    expect(reads).toHaveLength(2);
    reads[1]!.resolve({ text: "first\nsecond\n", truncated: false, settled: false });
    await settle();
    expect(text("#text")).toBe("first\nsecond\n");
    expect(hosts().outputNote.hidden).toBe(true);

    live().filter(entry => entry.kind === "timeout")[0]!.fn();
    reads[2]!.resolve({ text: "second\nthird\n", truncated: true, settled: false });
    await settle();
    expect(text("#text")).toBe("second\nthird\n");
    expect(hosts().outputNote.hidden).toBe(false);
    expect(text("#note")).toContain("trimmed");

    // Settling stops the poll and reads once more for the final lines.
    const pending = live().filter(entry => entry.kind === "timeout");
    expect(pending).toHaveLength(1);
    view.sync({ ...task, status: "completed", summary: "exit 0" });
    expect(pending[0]!.cleared).toBe(true);
    expect(reads).toHaveLength(4);
    reads[3]!.resolve({ text: "third\n[exited with code 0]\n", truncated: false, settled: true });
    await settle();
    expect(text("#text")).toBe("third\n[exited with code 0]\n");
    expect(text("#strip .chat-drilldown-task-settled")).toBe("finished");
    // A settled read schedules nothing further.
    expect(live()).toHaveLength(0);

    view.close();
    expect(hosts().output.hidden).toBe(true);
    expect(text("#text")).toBe("");
  });

  test("closing mid-read discards the answer and stops the poll; a failed read is reported and retried on the next tick", async () => {
    const view = panel();
    const task = item({ taskId: "bgjpa", taskType: "local_bash", createdAt: now });
    view.show({ conversationId: "one", taskId: "bgjpa", view: "output" }, task);
    reads[0]!.reject(new Error("workspace did not answer"));
    await settle();
    expect(errors.map(error => (error as Error).message)).toEqual(["workspace did not answer"]);
    const poll = live().filter(entry => entry.kind === "timeout");
    expect(poll).toHaveLength(1);
    poll[0]!.fn();
    expect(reads).toHaveLength(2);

    view.close();
    expect(reads[1]!.signal.aborted).toBe(true);
    expect(live()).toHaveLength(0);
    reads[1]!.resolve({ text: "late", truncated: false, settled: false });
    await settle();
    expect(text("#text")).toBe("");
    expect(hosts().output.hidden).toBe(true);
  });

  test("consecutive failed reads lengthen the wait up to the cap; a read that answers resets it and takes the error down", async () => {
    const view = panel();
    view.show({ conversationId: "one", taskId: "bgjpa", view: "output" }, item({ taskId: "bgjpa", taskType: "local_bash", createdAt: now }));
    const nextPoll = () => {
      const polls = live().filter(entry => entry.kind === "timeout");
      expect(polls).toHaveLength(1);
      return polls[0]!;
    };
    const waits: number[] = [];
    for (let failure = 0; failure < 6; failure += 1) {
      reads.at(-1)!.reject(new Error("workspace did not answer"));
      await settle();
      const poll = nextPoll();
      waits.push(poll.ms);
      poll.fn();
    }
    expect(waits).toEqual([4_000, 8_000, 16_000, TASK_OUTPUT_BACKOFF_MAX_MS, TASK_OUTPUT_BACKOFF_MAX_MS, TASK_OUTPUT_BACKOFF_MAX_MS]);
    expect(errors).toHaveLength(6);
    expect(recoveries).toBe(0);

    // "Not yet available" is an answer, not a failure: the cadence is back
    // and the error the failures reported is no longer true.
    reads.at(-1)!.resolve(null);
    await settle();
    expect(text("#note")).toBe("Output not yet available");
    expect(recoveries).toBe(1);
    expect(nextPoll().ms).toBe(TASK_OUTPUT_REFRESH_MS);

    // A read that answers after answers has nothing to take down.
    nextPoll().fn();
    reads.at(-1)!.resolve({ text: "one\n", truncated: false, settled: false });
    await settle();
    expect(recoveries).toBe(1);
    expect(nextPoll().ms).toBe(TASK_OUTPUT_REFRESH_MS);

    // The backoff starts over from the first failure, and the next answer
    // takes the new error down in turn.
    nextPoll().fn();
    reads.at(-1)!.reject(new Error("again"));
    await settle();
    expect(nextPoll().ms).toBe(4_000);
    nextPoll().fn();
    reads.at(-1)!.resolve({ text: "one\ntwo\n", truncated: false, settled: false });
    await settle();
    expect(text("#text")).toBe("one\ntwo\n");
    expect(recoveries).toBe(2);
    expect(nextPoll().ms).toBe(TASK_OUTPUT_REFRESH_MS);
    view.close();
  });

  test("a read the server marks settled ends the poll, even while the task item still says running", async () => {
    const view = panel();
    const task = item({ taskId: "bgjpa", taskType: "local_bash", createdAt: now });
    view.show({ conversationId: "one", taskId: "bgjpa", view: "output" }, task);
    reads[0]!.resolve({ text: "done\n[exited with code 0]\n", truncated: false, settled: true });
    await settle();
    expect(text("#text")).toBe("done\n[exited with code 0]\n");
    expect(live().filter(entry => entry.kind === "timeout")).toHaveLength(0);
    // The strip still follows the item, whose own settle has not arrived.
    view.sync(task);
    expect(live().filter(entry => entry.kind === "timeout")).toHaveLength(0);
    expect(reads).toHaveLength(1);
    expect(text("#strip [data-task-elapsed]")).toBe("0:00");
    // Nor does the item's settle read again: the output was already known
    // final, so there is nothing left for a last read to catch.
    view.sync({ ...task, status: "completed", summary: "exit 0" });
    expect(reads).toHaveLength(1);
    expect(live()).toHaveLength(0);
    expect(text("#strip .chat-drilldown-task-settled")).toBe("finished");
    view.close();
  });

  test("a hidden surface skips the read and tries again on the next tick", async () => {
    let active = false;
    const view = new TaskInspectionPanel({
      hosts: hosts(),
      fetchOutput: (conversationId, taskId, signal) => new Promise((resolve, reject) => { reads.push({ conversationId, taskId, signal, resolve, reject }); }),
      active: () => active,
      now: () => now,
      timers,
    });
    view.show({ conversationId: "one", taskId: "bgjpa", view: "output" }, item({ taskId: "bgjpa", taskType: "local_bash" }));
    expect(reads).toHaveLength(0);
    const poll = live().filter(entry => entry.kind === "timeout");
    expect(poll).toHaveLength(1);
    active = true;
    poll[0]!.fn();
    expect(reads).toHaveLength(1);
    view.close();
  });

  test("a change that only moves text across a field boundary still repaints the strip", () => {
    const view = panel();
    // Run together, "explore" + "ing tests" and "explor" + "eing tests" read
    // the same; the strip must still show the second state.
    const task = item({ taskId: "x", taskType: "local_agent", subagentType: "explore", progress: "ing tests", childConversationId: "sub:p:x", createdAt: now });
    view.show({ conversationId: "one", taskId: "x", view: "transcript" }, task);
    expect(text("#strip .chat-drilldown-task-type")).toBe("explore");
    view.sync({ ...task, subagentType: "explor", progress: "eing tests" });
    expect(text("#strip .chat-drilldown-task-type")).toBe("explor");
    expect(text("#strip .chat-drilldown-task-progress")).toBe("eing tests");
    view.close();
  });

  test("a foreground run's strip offers no Stop: the turn's own Cancel is its stop", () => {
    const view = panel();
    view.show({ conversationId: "one", taskId: "rv", view: "transcript" }, item({ taskId: "rv", description: "/code-review", taskType: "local_agent", childConversationId: "sub:p:rv", foreground: true, createdAt: now - 4_000 }));
    expect(text("#strip .chat-drilldown-task-description")).toBe("/code-review");
    expect(text("#strip [data-task-elapsed]")).toBe("0:04");
    expect(dom.document.querySelector("#strip [data-stop-task]")).toBeNull();
    view.close();
  });

  test("a task gone from the projection leaves an empty strip rather than a stale one", () => {
    const view = panel();
    view.show({ conversationId: "one", taskId: "x", view: "transcript" }, item({ taskId: "x" }));
    expect(hosts().strip.hidden).toBe(false);
    view.sync(undefined);
    expect(hosts().strip.hidden).toBe(true);
    expect(live()).toHaveLength(0);
    view.close();
  });
});

// Design D14: a run that is running and silent is followed from its
// transcript on disk; a live event, a settle, or a close ends the silence.
describe("following a silent run", () => {
  let clock = 0;
  let pending: Array<{ at: number; fn: () => void; cleared: boolean }> = [];
  const timers = {
    setTimeout: (fn: () => void, ms: number) => { const entry = { at: clock + ms, fn, cleared: false }; pending.push(entry); return entry; },
    clearTimeout: (handle: unknown) => { (handle as { cleared: boolean }).cleared = true; },
  };
  // Advances the fake clock, firing each timer that falls due in order.
  const advance = async (ms: number) => {
    const until = clock + ms;
    for (;;) {
      const next = pending.filter(entry => !entry.cleared && entry.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      clock = next.at;
      next.cleared = true;
      next.fn();
      await settle();
    }
    clock = until;
  };
  // A read resolves to whether it found the run still running, as the
  // drill-down's re-read does; undefined is a read that did not apply.
  let reads: Array<{ at: number; signal: AbortSignal; resolve: (running?: boolean) => void; reject: (error: unknown) => void }> = [];
  let visible = true;
  let errors: unknown[] = [];
  const follower = () => new SilentRunFollower({
    refresh: signal => new Promise<boolean | undefined>((resolve, reject) => { reads.push({ at: clock, signal, resolve, reject }); }),
    active: () => visible,
    onError: error => { errors.push(error); },
    timers,
  });
  // Every read answers at once, as a quick snapshot would.
  const answering = async (ms: number) => {
    const until = clock + ms;
    while (clock < until) {
      await advance(Math.min(250, until - clock));
      for (const read of reads) read.resolve();
      await settle();
    }
  };
  beforeEach(() => { clock = 0; pending = []; reads = []; visible = true; errors = []; });

  test("reads only once the run has been running and silent for the quiet period, then on the refresh interval", async () => {
    expect(SILENT_RUN_QUIET_MS).toBe(2_000);
    expect(SILENT_RUN_REFRESH_MS).toBe(2_000);
    const run = follower();
    // Not running: nothing to follow.
    run.follow(false);
    await answering(10_000);
    expect(reads).toHaveLength(0);
    run.follow(true);
    await answering(1_999);
    expect(reads).toHaveLength(0);
    await answering(1);
    expect(reads.map(read => read.at)).toEqual([12_000]);
    await answering(6_000);
    expect(reads.map(read => read.at)).toEqual([12_000, 14_000, 16_000, 18_000]);
    run.stop();
  });

  test("a live event resets the silence, so a run that streams is never read", async () => {
    const run = follower();
    run.follow(true);
    for (let second = 0; second < 10; second += 1) {
      await answering(1_500);
      run.heard();
    }
    expect(reads).toHaveLength(0);
    // It falls silent: the quiet period runs from the last event.
    await answering(2_000);
    expect(reads.map(read => read.at)).toEqual([17_000]);
    run.stop();
  });

  test("a run whose stream spoke stops when it settles, in-flight read included, and is not read again", async () => {
    const run = follower();
    run.follow(true);
    // It stalled long enough to be read, then its stream carried its last word.
    await advance(2_000);
    expect(reads).toHaveLength(1);
    run.heard();
    run.follow(false);
    expect(reads[0]!.signal.aborted).toBe(true);
    reads[0]!.resolve();
    await answering(10_000);
    expect(reads).toHaveLength(1);
    expect(run.following).toBe(false);
    // A streamed run that never stalled pays nothing at its settle.
    const streamed = follower();
    streamed.follow(true);
    for (let second = 0; second < 5; second += 1) {
      await answering(1_500);
      streamed.heard();
    }
    streamed.follow(false);
    await answering(10_000);
    expect(reads).toHaveLength(1);
    expect(streamed.following).toBe(false);
  });

  // The typed command's run: nothing streams, so its last records reach the
  // open view only through a read made after the settle.
  test("a run that settles while silent is read at once and once more a refresh period later, then never", async () => {
    expect(SILENT_RUN_SETTLE_READS).toBe(2);
    const run = follower();
    run.follow(true);
    await answering(2_000);
    await advance(2_000);
    expect(reads.map(read => read.at)).toEqual([2_000, 4_000]);
    // The settle lands while a read is in flight: that read may predate the
    // last records, so a fresh one replaces it rather than being dropped.
    run.follow(false);
    expect(reads[1]!.signal.aborted).toBe(true);
    expect(reads.map(read => read.at)).toEqual([2_000, 4_000, 4_000]);
    expect(reads[2]!.signal.aborted).toBe(false);
    reads[1]!.resolve(true);
    reads[2]!.resolve(false);
    await settle();
    await answering(2_000);
    expect(reads.map(read => read.at)).toEqual([2_000, 4_000, 4_000, 6_000]);
    await answering(20_000);
    expect(reads).toHaveLength(4);
    expect(run.following).toBe(false);
    // Nothing the run says after its settle starts the follow again.
    run.heard();
    await answering(10_000);
    expect(reads).toHaveLength(4);
  });

  test("a run that settles before its first silent read still gets its settle reads", async () => {
    const run = follower();
    run.follow(true);
    await answering(1_000);
    expect(reads).toHaveLength(0);
    run.follow(false);
    reads[0]!.resolve(false);
    await settle();
    await answering(20_000);
    expect(reads.map(read => read.at)).toEqual([1_000, 3_000]);
    expect(run.following).toBe(false);
  });

  test("a read that itself finds the run settled counts as the first settle read", async () => {
    const run = follower();
    run.follow(true);
    await advance(2_000);
    expect(reads).toHaveLength(1);
    reads[0]!.resolve(false);
    await settle();
    await answering(20_000);
    expect(reads.map(read => read.at)).toEqual([2_000, 4_000]);
    expect(run.following).toBe(false);
    // The view's own settle, arriving afterwards, finds the follow over.
    run.follow(false);
    await answering(10_000);
    expect(reads).toHaveLength(2);
  });

  test("closing the drill-down cancels the settle reads, in flight or still due", async () => {
    const run = follower();
    run.follow(true);
    run.follow(false);
    expect(reads).toHaveLength(1);
    run.stop();
    expect(reads[0]!.signal.aborted).toBe(true);
    reads[0]!.resolve();
    await answering(20_000);
    expect(reads).toHaveLength(1);
    expect(run.following).toBe(false);
    // Closed between the two: the second never comes.
    run.follow(true);
    run.follow(false);
    await answering(1_000);
    expect(reads).toHaveLength(2);
    run.stop();
    await answering(20_000);
    expect(reads).toHaveLength(2);
    expect(run.following).toBe(false);
  });

  test("a hidden page holds the settle reads until it is shown, without spending them", async () => {
    const run = follower();
    run.follow(true);
    visible = false;
    run.follow(false);
    await answering(10_000);
    expect(reads).toHaveLength(0);
    expect(run.following).toBe(true);
    visible = true;
    await answering(20_000);
    expect(reads.map(read => read.at)).toEqual([12_000, 14_000]);
    expect(run.following).toBe(false);
  });

  test("stops when the drill-down closes; reopening starts a fresh quiet period", async () => {
    const run = follower();
    run.follow(true);
    await answering(3_000);
    expect(reads).toHaveLength(1);
    run.stop();
    await answering(10_000);
    expect(reads).toHaveLength(1);
    expect(run.following).toBe(false);
    run.follow(true);
    await answering(2_000);
    expect(reads.map(read => read.at)).toEqual([2_000, 15_000]);
    run.stop();
  });

  test("one read at a time; a failed read is reported and the next tick tries again; a hidden page skips the read", async () => {
    const run = follower();
    run.follow(true);
    await advance(2_000);
    await advance(10_000);
    // The first read has not answered: no second one stacks behind it.
    expect(reads).toHaveLength(1);
    reads[0]!.reject(new Error("snapshot failed"));
    await settle();
    expect(errors).toEqual([new Error("snapshot failed")]);
    await advance(2_000);
    expect(reads).toHaveLength(2);
    reads[1]!.resolve();
    await settle();
    visible = false;
    await answering(6_000);
    expect(reads).toHaveLength(2);
    visible = true;
    await answering(2_000);
    expect(reads).toHaveLength(3);
    run.stop();
  });
});

function item(extra: Partial<BackgroundTaskItem> = {}): BackgroundTaskItem {
  return { id: `task:${extra.taskId ?? "t"}`, type: "background_task", createdAt: 1, taskId: "t", description: "Task", status: "running", ...extra };
}

async function settle(): Promise<void> {
  for (let round = 0; round < 5; round += 1) await Promise.resolve();
}
