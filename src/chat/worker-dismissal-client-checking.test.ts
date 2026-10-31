import { expect, test } from "bun:test";
import { CheckingPresentation } from "./worker-dismissal-client-checking";
import type { CompactWorker } from "./compact-work";

test("Checking ends at ten seconds, independent of repaint; genuine evidence and generations recover", () => {
  let now = 0, fired = 0; const pending = new Map<number, () => void>(); let sequence = 0;
  const presenter = new CheckingPresentation(() => fired++, () => now, {
    setTimeout: fn => { pending.set(++sequence, fn); return sequence; }, clearTimeout: handle => { pending.delete(handle as number); },
  });
  const worker: CompactWorker = { id: "row", name: "Worker", kind: "agent", references: [], state: "unknown", since: 1, settledAt: 1,
    activity: { kind: "checking", executionId: "exec:one", generation: 1 } };
  expect(presenter.paint("parent", [worker])[0]!.activity!.kind).toBe("checking");
  now = 9000; presenter.paint("parent", [{ ...worker, progress: "unrelated repaint" }]);
  expect(pending.size).toBe(1);
  now = 10000; const [handle, callback] = [...pending.entries()][0]!; pending.delete(handle); callback();
  expect(fired).toBe(1);
  expect(presenter.paint("parent", [worker])[0]!.activity!.kind).toBe("unavailable");
  now = 30000;
  expect(presenter.paint("parent", [worker])[0]!.activity!.kind).toBe("unavailable");
  const working = { ...worker, state: "working" as const, activity: { ...worker.activity!, kind: "working" as const } };
  expect(presenter.paint("parent", [working])[0]!.activity!.kind).toBe("working");
  expect(presenter.paint("parent", [worker])[0]!.activity!.kind).toBe("checking");
  now = 40000;
  expect(presenter.paint("parent", [worker])[0]!.activity!.kind).toBe("unavailable");
  expect(presenter.paint("parent", [{ ...worker, activity: { ...worker.activity!, generation: 2 } }])[0]!.activity!.kind).toBe("checking");
  presenter.dispose(); expect(pending.size).toBe(0);
});

test("selection and disposal cancel presentation timers without mutating worker evidence", () => {
  let now = 0; const pending = new Map<number, () => void>(); let sequence = 0;
  const presenter = new CheckingPresentation(() => {}, () => now, {
    setTimeout: fn => { pending.set(++sequence, fn); return sequence; }, clearTimeout: handle => { pending.delete(handle as number); },
  });
  const worker: CompactWorker = { id: "row", name: "Worker", kind: "agent", references: [], state: "unknown", since: 1, settledAt: 1,
    activity: { kind: "checking", executionId: "exec:one", generation: 1, observedAt: 1234 } };
  const original = structuredClone(worker);
  presenter.paint("parent", [worker]); const first = [...pending.keys()][0]!;
  now = 9000; presenter.paint("other", []);
  expect(pending.has(first)).toBe(false); expect(pending.size).toBe(0);
  expect(presenter.paint("parent", [worker])[0]!.activity!.kind).toBe("checking");
  now = 19000;
  expect(presenter.paint("parent", [worker])[0]!.activity).toEqual({ ...original.activity!, kind: "unavailable" });
  expect(worker).toEqual(original);
  presenter.dispose(); expect(pending.size).toBe(0);
});
