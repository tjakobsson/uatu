import { expect, test } from "bun:test";
import { createOpenCodeV2Provider } from "./provider";
import { startOpenCodeV2Fake } from "../../../../tests/e2e/opencode-v2-fake";
import type { NormalizedProviderEvent } from "../../provider";

const terminalReports = [["completed", "completed"], ["error", "failed"], ["cancelled", "stopped"]] as const;

for (const [reported, status] of terminalReports) {
for (const delivery of ["pending", "stored"] as const) {
for (const reload of [false, true]) {
test(`${reported} report (${delivery}, ${reload ? "reloaded" : "warm"}) settles exactly its launcher`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  const open = () => createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory });
  let provider = open();
  try {
    const parent = (await provider.createSession("Terminal report recovery")).id;
    const worker = fake.launchWorker(parent, true);
    const before = await provider.reconcileBackgroundTasks!(parent, { fresh: true });
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({ taskId: worker.taskId, status: "running" });
    const summary = `Safe fixture ${reported}`;
    fake.settleWorker(worker.childId, reported, summary);
    const reportId = fake.state().sessions[parent]!.pending[0]!.id;
    if (delivery === "stored") {
      fake.wakeParent(parent);
      expect(fake.state().sessions[parent]!.pending).toEqual([]);
      expect(fake.state().sessions[parent]!.messages).toContainEqual({ id: reportId, type: "synthetic" });
    }
    if (reload) {
      await provider.dispose!();
      provider = open();
    }
    if (delivery === "stored") {
      const history = await provider.listMessages(parent, { limit: 100 });
      const rows = history.items.filter(item => item.type === "background_task");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ taskId: worker.taskId, status, resultId: reportId, summary });
    }
    const tasks = await provider.reconcileBackgroundTasks!(parent, { fresh: true });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ taskId: worker.taskId, childConversationId: worker.childId,
      status, resultId: reportId, summary });
    expect(tasks.filter(task => task.status === "running" || task.stateUncertain)).toEqual([]);
    expect(fake.state().unhandled).toEqual([]);
  } finally {
    await provider.dispose!();
    await fake.stop();
  }
});
}
}
}

for (const delivery of ["pending", "stored"] as const) {
for (const [reported, status] of terminalReports) {
test(`a completed occurrence (${delivery}) stays terminal when the same child runs again and reports ${reported}`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  const open = () => createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory });
  let provider = open();
  try {
    const parent = (await provider.createSession("Same-child terminal recovery")).id;
    const first = fake.launchWorker(parent, true);
    fake.settleWorker(first.childId, "completed", "First occurrence completed");
    // settleWorker persists a native idle record, not merely a quiet event stream.
    expect(fake.state().sessions[first.childId]!.messages.filter(message => message.type === "idle")).toHaveLength(1);
    const firstReport = fake.state().sessions[parent]!.pending[0]!.id;
    if (delivery === "stored") fake.wakeParent(parent);
    const settled = await provider.reconcileBackgroundTasks!(parent, { fresh: true });
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({ taskId: first.taskId, status: "completed", resultId: firstReport });

    const second = fake.launchWorker(parent, true, first.childId);
    expect(second.childId).toBe(first.childId);
    expect(second.taskId).not.toBe(first.taskId);
    for (const reload of [false, true]) {
      if (reload) { await provider.dispose!(); provider = open(); }
      const tasks = await provider.reconcileBackgroundTasks!(parent, { fresh: true });
      expect(tasks).toHaveLength(2);
      expect(tasks.find(task => task.taskId === first.taskId)).toMatchObject({ status: "completed", resultId: firstReport });
      expect(tasks.find(task => task.taskId === second.taskId)).toMatchObject({ status: "running", childConversationId: first.childId });
      expect(tasks.filter(task => task.status === "running").map(task => task.taskId)).toEqual([second.taskId]);
      // History contains delivered records only; pending reports are folded by
      // reconciliation, the public inventory asserted above.
      if (delivery === "stored") {
        const history = await provider.listMessages(parent, { limit: 100 });
        const rows = history.items.filter(item => item.type === "background_task");
        expect(rows).toHaveLength(2);
        expect(rows.find(task => task.taskId === first.taskId)).toMatchObject({ status: "completed", resultId: firstReport });
      }
    }
    fake.settleWorker(second.childId, reported, "Second occurrence settled");
    const tasks = await provider.reconcileBackgroundTasks!(parent, { fresh: true });
    expect(tasks).toHaveLength(2);
    expect(tasks.find(task => task.taskId === first.taskId)).toMatchObject({ status: "completed", summary: "First occurrence completed" });
    expect(tasks.find(task => task.taskId === second.taskId)).toMatchObject({ status, summary: "Second occurrence settled" });
    expect(tasks.filter(task => task.status === "running" || task.stateUncertain)).toEqual([]);
    expect(fake.state().unhandled).toEqual([]);
  } finally {
    await provider.dispose!();
    await fake.stop();
  }
});
}
}

for (const [reported, status] of terminalReports) {
test(`a live ${reported} report received before launcher history recovers one canonical terminal row`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  const open = () => createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory });
  let provider = open();
  const abort = new AbortController();
  const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(5_000)]);
  let pump: Promise<void> | undefined;
  try {
    const parent = (await provider.createSession("Notification-first recovery")).id;
    // Launch before subscribing: this provider will receive the report before
    // it has seen either a launcher event or any launcher history.
    const worker = fake.launchWorker(parent, true);
    let received!: (event: NormalizedProviderEvent) => void;
    const report = new Promise<NormalizedProviderEvent>(resolve => { received = resolve; });
    pump = (async () => {
      for await (const event of provider.events(signal)) {
        if (event.conversationId === parent && event.eventType === "session.inbox.enqueued") received(event);
      }
    })();
    await provider.waitForEventStream!(signal);
    fake.settleWorker(worker.childId, reported, "Notification arrived first");
    const reportId = fake.state().sessions[parent]!.pending[0]!.id;
    const event = await Promise.race([report, pump.then(() => { throw new Error("Event stream ended before the terminal report"); })]);
    const terminal = event.updates.filter(update => update.kind === "upsert" && update.item.type === "background_task");
    expect(terminal).toHaveLength(1);
    expect(terminal[0]).toMatchObject({ kind: "upsert", item: { status, resultId: reportId, childConversationId: worker.childId } });
    // End the stream before changing delivery, avoiding an event/read race.
    abort.abort(); await pump;
    const recovered = await provider.reconcileBackgroundTasks!(parent, { fresh: true });
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({ taskId: worker.taskId, status, resultId: reportId, summary: "Notification arrived first" });
    fake.wakeParent(parent);
    await provider.dispose!(); provider = open();
    const history = await provider.listMessages(parent, { limit: 100 });
    const rows = history.items.filter(item => item.type === "background_task");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ taskId: worker.taskId, status, resultId: reportId, summary: "Notification arrived first" });
    const after = await provider.reconcileBackgroundTasks!(parent, { fresh: true });
    expect(after).toHaveLength(1);
    expect(after.filter(task => task.status === "running" || task.stateUncertain)).toEqual([]);
    expect(fake.state().unhandled).toEqual([]);
  } finally {
    abort.abort(); await pump;
    await provider.dispose!();
    await fake.stop();
  }
}, 10_000);
}
