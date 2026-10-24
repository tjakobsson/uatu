import { expect, spyOn, test } from "bun:test";
import { parseHTML } from "linkedom";
import { compactWorkers, type CompactWorker } from "./compact-work";
import { CompactWorkersView } from "./compact-workers-view";

test("reported clock has its own suffix and the full kind and provenance remain in the metadata title", () => {
  const { document, window } = parseHTML('<html><body><div id="workers"></div></body></html>');
  const previous = new Map(["document", "Element"].map(key => [key, Reflect.get(globalThis, key)]));
  Reflect.set(globalThis, "document", document); Reflect.set(globalThis, "Element", window.Element);
  const format = spyOn(Date.prototype, "toLocaleTimeString").mockImplementation(() => "19:43");
  try {
    const host = document.getElementById("workers")! as unknown as HTMLElement;
    const view = new CompactWorkersView(host);
    const agent = "synthetic-long-agent-kind-with-no-breaks".repeat(8);
    view.paint("parent", compactWorkers([
      { type: "background_task", id: "report", taskId: "report", description: "Synthetic report", subagentType: agent, status: "completed", createdAt: 10, terminalReportedAt: 40, progress: "Report received" },
    ]), new Set(), true);
    const meta = host.querySelector<HTMLElement>(".chat-worker-meta")!;
    expect(meta.title).toBe(`${agent} · Reported 19:43 · finished · Report received`);
    expect(meta.querySelector(".chat-worker-kind")!.textContent).toBe(agent);
    expect(meta.querySelector(".chat-worker-time > .chat-worker-clock")!.textContent).toBe("Reported 19:43");
    expect(meta.textContent).toBe(`${agent} · Reported 19:43`);
    expect(meta.querySelector("[data-elapsed-since]")).toBeNull();
    expect(host.querySelector(".chat-worker-inspect")!.getAttribute("aria-label")).toContain("Synthetic report");
  } finally {
    format.mockRestore();
    for (const [key, value] of previous) Reflect.set(globalThis, key, value);
  }
});

test("active kind and shell elapsed time survive the clock suffix structure without stale report titles", () => {
  const { document, window } = parseHTML('<html><body><div id="workers"></div></body></html>');
  const previous = new Map(["document", "Element"].map(key => [key, Reflect.get(globalThis, key)]));
  Reflect.set(globalThis, "document", document); Reflect.set(globalThis, "Element", window.Element);
  const now = spyOn(Date, "now").mockReturnValue(65_000);
  try {
    const host = document.getElementById("workers")! as unknown as HTMLElement;
    const view = new CompactWorkersView(host);
    const workers = compactWorkers([
      { type: "background_task", id: "shell", taskId: "shell", taskType: "shell", description: "Synthetic shell", status: "running", createdAt: 5_000 },
      { type: "background_task", id: "agent", taskId: "agent", subagentType: "explore", description: "Synthetic agent", status: "running", createdAt: 5_000 },
    ]);
    view.paint("parent", workers.map(worker => ({ ...worker, state: "completed", terminalReportedAt: 60_000, settledAt: 60_000 })), new Set(), true);
    view.paint("parent", workers, new Set(), true);
    const shell = host.querySelector<HTMLElement>('[data-worker-id="shell"] .chat-worker-meta')!;
    const agent = host.querySelector<HTMLElement>('[data-worker-id="agent"] .chat-worker-meta')!;
    expect(shell.textContent).toBe("Shell · 1:00");
    expect(shell.querySelector(".chat-worker-clock")!.getAttribute("data-elapsed-since")).toBe("5000");
    expect(shell.title).toBe("Shell · 1:00 · working");
    expect(agent.textContent).toBe("explore");
    expect(agent.querySelector(".chat-worker-time")).toBeNull();
    view.paint("parent", workers.map(worker => ({ ...worker, state: "unknown" })), new Set(), true);
    expect(shell.textContent).toBe("Shell · 1:00");
    expect(shell.title).toBe("Shell · 1:00 · unknown");
    expect(shell.textContent).not.toContain("Reported");
  } finally {
    now.mockRestore();
    for (const [key, value] of previous) Reflect.set(globalThis, key, value);
  }
});

test("native terminal clocks say Reported, including zero/equal-launch, while missing clocks say Started", () => {
  const { document, window } = parseHTML('<html><body><div id="workers"></div></body></html>');
  const previous = new Map(["document", "Element"].map(key => [key, Reflect.get(globalThis, key)]));
  Reflect.set(globalThis, "document", document); Reflect.set(globalThis, "Element", window.Element);
  const format = spyOn(Date.prototype, "toLocaleTimeString").mockImplementation(() => "19:43");
  try {
    const host = document.getElementById("workers")! as unknown as HTMLElement;
    const view = new CompactWorkersView(host);
    view.paint("parent", compactWorkers([
      { type: "background_task", id: "agent", taskId: "agent", description: "Agent", status: "completed", createdAt: 10, terminalReportedAt: 40 },
      { type: "background_task", id: "shell", taskId: "shell", taskType: "shell", description: "Shell", status: "failed", createdAt: 10, terminalReportedAt: 10 },
      { type: "background_task", id: "zero", taskId: "zero", description: "Epoch report", status: "stopped", createdAt: 0, terminalReportedAt: 0 },
      { type: "background_task", id: "missing", taskId: "missing", description: "No clock", status: "completed", createdAt: 10 },
      { type: "background_task", id: "unknown", taskId: "unknown", description: "Unknown time", status: "completed", createdAt: 0 },
    ]), new Set(), true);
    for (const id of ["agent", "shell", "zero"]) {
      expect(host.querySelector(`[data-worker-id="${id}"] .chat-worker-meta`)!.textContent).toContain("Reported 19:43");
      expect(host.querySelector(`[data-worker-id="${id}"] .chat-worker-meta`)!.textContent).not.toContain("Finished");
    }
    expect(host.querySelector('[data-worker-id="missing"] .chat-worker-meta')!.textContent).toBe("Agent · Started 19:43");
    expect(host.querySelector('[data-worker-id="unknown"] .chat-worker-meta')!.textContent).toBe("Agent");
  } finally {
    format.mockRestore();
    for (const [key, value] of previous) Reflect.set(globalThis, key, value);
  }
});

test("finished worker clocks render 24-hour evening and midnight even under an AM/PM locale", () => {
  const { document, window } = parseHTML('<html><body><div id="workers"></div></body></html>');
  const previous = new Map(["document", "Element"].map(key => [key, Reflect.get(globalThis, key)]));
  Reflect.set(globalThis, "document", document); Reflect.set(globalThis, "Element", window.Element);
  // Force an AM/PM locale while retaining the host timezone and the view's
  // real formatting options. Local date construction makes this timezone-neutral.
  const format = spyOn(Date.prototype, "toLocaleTimeString").mockImplementation(function(this: Date, _locales?: Intl.LocalesArgument, options?: Intl.DateTimeFormatOptions) {
    return new Intl.DateTimeFormat("en-US", options).format(this);
  });
  try {
    const host = document.getElementById("workers")! as unknown as HTMLElement;
    const view = new CompactWorkersView(host);
    const evening = new Date(2026, 9, 22, 19, 43).getTime();
    const midnight = new Date(2026, 9, 23, 0, 0).getTime();
    view.paint("parent", compactWorkers([
      { type: "background_task", id: "evening", taskId: "evening", description: "Finished", status: "completed", createdAt: evening - 60_000, usage: { durationMs: 60_000, totalTokens: 0, toolUses: 0 } },
      { type: "background_task", id: "midnight", taskId: "midnight", description: "Start only", status: "completed", createdAt: midnight },
      { type: "background_task", id: "unknown", taskId: "unknown", description: "No timestamp", status: "completed", createdAt: 0 },
      { type: "tool", id: "same", name: "task", input: '{"description":"Instant completion"}', status: "completed", createdAt: midnight, completedAt: midnight },
      { type: "tool", id: "zero", name: "task", input: '{"description":"Epoch completion"}', status: "completed", createdAt: 0, completedAt: 0 },
      { type: "tool", id: "later", name: "task", input: '{"description":"Later finish"}', status: "completed", createdAt: midnight - 60_000, completedAt: midnight },
    ]), new Set(), true);
    expect(host.querySelector('[data-worker-id="evening"] .chat-worker-meta')!.textContent).toBe("Agent · 19:43");
    expect(host.querySelector('[data-worker-id="midnight"] .chat-worker-meta')!.textContent).toBe("Agent · Started 00:00");
    expect(host.querySelector('[data-worker-id="unknown"] .chat-worker-meta')!.textContent).toBe("Agent");
    expect(host.querySelector('[data-worker-id="same"] .chat-worker-meta')!.textContent).toBe("Agent · 00:00");
    expect(host.querySelector('[data-worker-id="later"] .chat-worker-meta')!.textContent).toBe("Agent · 00:00");
    expect(host.querySelector('[data-worker-id="zero"] .chat-worker-meta')!.textContent).toBe(`Agent · ${new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(0))}`);
  } finally {
    format.mockRestore();
    for (const [key, value] of previous) Reflect.set(globalThis, key, value);
  }
});

test("running and finished workers share one flat list and a single compact header", () => {
  const { document, window } = parseHTML('<html><body><details open><summary>1 working · 1 finished</summary><div id="workers"></div></details></body></html>');
  const previous = new Map(["document", "Element"].map(key => [key, Reflect.get(globalThis, key)]));
  Reflect.set(globalThis, "document", document); Reflect.set(globalThis, "Element", window.Element);
  try {
    const host = document.getElementById("workers")! as unknown as HTMLElement;
    const view = new CompactWorkersView(host);
    view.paint("parent", compactWorkers([
      { type: "background_task", id: "done", taskId: "done", description: "Finished task", status: "completed", createdAt: 1 },
      { type: "background_task", id: "live", taskId: "live", description: "Running task", status: "running", createdAt: 2 },
    ]), new Set(), true);
    expect(host.querySelectorAll("details, summary").length).toBe(0);
    expect(host.querySelectorAll("ul").length).toBe(1);
    expect([...host.querySelectorAll("li")].map(row => row.dataset.workerId)).toEqual(["live", "done"]);
    expect(host.parentElement!.querySelector("summary .chat-workers-dismiss")).not.toBeNull();
  } finally { for (const [key, value] of previous) Reflect.set(globalThis, key, value); }
});

test("finished dismissal is view-only and exposes no Restore control", () => {
  const { document, window } = parseHTML('<html><body><details><summary>Workers</summary><div id="workers"></div></details></body></html>');
  const previous = new Map(["document", "Element"].map(key => [key, Reflect.get(globalThis, key)]));
  Reflect.set(globalThis, "document", document); Reflect.set(globalThis, "Element", window.Element);
  try {
    let choices = 0;
    const host = document.getElementById("workers")! as unknown as HTMLElement;
    const view = new CompactWorkersView(host, () => choices++);
    const workers = compactWorkers([{ type: "background_task", id: "done", taskId: "done", description: "Finished task", status: "completed", createdAt: 1 }]);
    view.paint("parent", workers, new Set(), true);
    const button = host.parentElement!.querySelector<HTMLButtonElement>(".chat-workers-dismiss")!;
    expect(button.textContent).toBe("Dismiss finished"); button.click();
    view.paint("parent", [], new Set(), true);
    expect(button.hidden).toBe(true);
    expect(host.textContent).not.toContain("Restore finished");
    expect(choices).toBe(1);
    expect(workers[0]?.state).toBe("completed");
  } finally { for (const [key, value] of previous) Reflect.set(globalThis, key, value); }
});

test("a worker Stop becoming disabled returns owned keyboard focus to inspection", () => {
  const { document, window } = parseHTML('<html><body><details open><summary>Workers</summary><div id="workers"></div></details></body></html>');
  const previous = new Map(["document", "Element"].map(key => [key, Reflect.get(globalThis, key)]));
  Reflect.set(globalThis, "document", document);
  Reflect.set(globalThis, "Element", window.Element);
  let focused: Element | null = null;
  Object.defineProperty(document, "activeElement", { get: () => focused });
  try {
    const host = document.getElementById("workers")! as unknown as HTMLElement;
    const view = new CompactWorkersView(host);
    const workers = compactWorkers([{ type: "background_task", id: "execution", taskId: "native", description: "Worker", taskType: "agent", createdAt: 1, status: "running" }]);
    view.paint("parent", workers, new Set(), true);
    const inspect = host.querySelector<HTMLButtonElement>(".chat-worker-inspect")!;
    const stop = host.querySelector<HTMLButtonElement>("[data-stop-task]")!;
    inspect.focus = () => { focused = inspect; };
    focused = stop;
    view.paint("parent", workers, new Set(["native"]), true);
    expect(stop.disabled).toBe(true);
    expect(focused).toBe(inspect);
  } finally {
    for (const [key, value] of previous) Reflect.set(globalThis, key, value);
  }
});

test("keyed worker rows and actions survive arbitrary sibling insertion, removal and reordering", () => {
  const { document, window } = parseHTML('<html><body><details open><summary>Workers</summary><div id="workers"></div></details></body></html>');
  const previous = new Map(["document", "Element"].map(key => [key, Reflect.get(globalThis, key)]));
  Reflect.set(globalThis, "document", document); Reflect.set(globalThis, "Element", window.Element);
  let focused: Element | null = null;
  Object.defineProperty(document, "activeElement", { get: () => focused });
  try {
    const host = document.getElementById("workers")! as unknown as HTMLElement;
    const view = new CompactWorkersView(host);
    const worker = (id: string): CompactWorker => ({ id, name: id, taskId: id, stoppable: true, state: "working", kind: "agent", references: [], since: 0, settledAt: 0 });
    view.paint("parent", [worker("a"), worker("b"), worker("c")], new Set(), true);
    const row = host.querySelector('[data-worker-id="b"]')!;
    const inspect = row.querySelector(".chat-worker-inspect")!;
    const stop = row.querySelector("[data-stop-task]")!;
    focused = stop;
    for (const ids of [["c", "b", "a"], ["b", "a", "c"], ["a", "c", "b"], ["d", "b", "a"], ["b"], ["a", "b", "c"]]) {
      view.paint("parent", ids.map(worker), new Set(), true);
      expect([...host.querySelectorAll("li")].map(node => node.dataset.workerId)).toEqual(ids);
      expect(host.querySelector('[data-worker-id="b"]')).toBe(row);
      expect(row.querySelector(".chat-worker-inspect")).toBe(inspect);
      expect(row.querySelector("[data-stop-task]")).toBe(stop);
      expect(stop.hasAttribute("disabled")).toBe(false);
    }
  } finally { for (const [key, value] of previous) Reflect.set(globalThis, key, value); }
});

test.each(["unknown", "stopping", "completed", "removed", "dismiss"] as const)("worker focus fallback uses preventScroll when %s", transition => {
  const { document, window } = parseHTML('<html><body><details open><summary>Workers</summary><div id="workers"></div></details></body></html>');
  const previous = new Map(["document", "Element"].map(key => [key, Reflect.get(globalThis, key)]));
  Reflect.set(globalThis, "document", document); Reflect.set(globalThis, "Element", window.Element);
  let focused: Element | null = null;
  Object.defineProperty(document, "activeElement", { get: () => focused });
  try {
    const host = document.getElementById("workers")! as unknown as HTMLElement;
    const view = new CompactWorkersView(host);
    const worker: CompactWorker = { id: "worker", taskId: "native", stoppable: true, name: "Worker", kind: "agent", state: transition === "dismiss" ? "completed" : "working", references: [], since: 0, settledAt: 0 };
    view.paint("parent", [worker], new Set(), true);
    const inspect = host.querySelector<HTMLButtonElement>(".chat-worker-inspect")!;
    const stop = host.querySelector<HTMLButtonElement>("[data-stop-task]");
    const header = host.parentElement!.querySelector<HTMLElement>("summary")!;
    const dismiss = header.querySelector<HTMLButtonElement>(".chat-workers-dismiss")!;
    const fallback = transition === "removed" || transition === "dismiss" ? header : inspect;
    const focus = spyOn(fallback, "focus").mockImplementation(() => { focused = fallback; });
    focused = transition === "dismiss" ? dismiss : stop;
    view.paint("parent", transition === "removed" || transition === "dismiss" ? [] : [{ ...worker, state: transition === "stopping" ? "working" : transition }], transition === "stopping" ? new Set(["native"]) : new Set(), true);
    expect(focused).toBe(fallback);
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    if (transition === "unknown" || transition === "stopping") expect(stop!.disabled).toBe(true);
    if (transition === "completed" || transition === "removed") expect(stop!.isConnected).toBe(false);
    if (transition === "dismiss") expect(dismiss.hidden).toBe(true);
    focus.mockRestore();
  } finally { for (const [key, value] of previous) Reflect.set(globalThis, key, value); }
});
