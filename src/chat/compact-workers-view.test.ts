import { expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { compactWorkers } from "./compact-work";
import { CompactWorkersView } from "./compact-workers-view";

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
