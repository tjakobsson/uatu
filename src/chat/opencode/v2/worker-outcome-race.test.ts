import { expect, spyOn, test } from "bun:test";
import { createOpenCodeV2Provider } from "./provider";
import { startOpenCodeV2Fake } from "../../../../tests/e2e/opencode-v2-fake";
import { ChatAdapter } from "../../adapter";
import { AsyncLocalStorage } from "node:async_hooks";
import { workerCanStop, workerExecutionClockRuns } from "../../worker-state";
import { workerDismissalEvidence } from "../../worker-dismissal-evidence";

for (const mode of ["newer-duplicate-seed", "older-seed", "older-merge", "older-merge-with-newer-unrelated", "older-overflow-seed", "cancelled", "reconnect", "unknown-guard", "original-deadline", "unrelated-cohort", "older-report", "current-report"] as const)
test(`covered pending watch preserves native order and original ownership (${mode})`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  let parent: string | undefined, child: string | undefined, observing = false, storedAt: number | undefined, inboxReads = 0;
  const olderObservation = mode === "newer-duplicate-seed" || mode === "older-seed" || mode === "older-merge" || mode === "older-merge-with-newer-unrelated" || mode === "older-overflow-seed";
  let entered!: () => void, release!: () => void;
  const pending = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route.endsWith("/inbox")) {
      if (observing && route === `/api/session/${parent}/inbox`) {
        const index = ++inboxReads;
        if (olderObservation) { entered(); await held; }
        if (mode === "older-overflow-seed") return Response.json({ data: Array.from({ length: 257 }, (_, fact) => ({ id: `${index}:${fact}`, type: "synthetic", time: { created: 45 }, payload: {
          text: "Native failure", metadata: { source: "subagent", childID: index === 1 ? "unrelated-child" : child, state: "error" },
        } })) });
        return Response.json({ data: [{ id: "queued-failure", type: "synthetic", time: { created: 45 }, payload: {
          text: "Native failure", metadata: { source: "subagent", childID: mode === "older-merge-with-newer-unrelated" && index > 1 ? "unrelated-child" : child, state: "error" },
        } }] });
      }
      return Response.json({ data: [] });
    }
    const response = await fetch(request);
    if (route === `/api/session/${parent}/message`) {
      const body = await response.json(), first = body.data[0]; first.time = { created: 10 }; first.content[0].time = { created: 10, ran: 11, completed: 12 };
      return Response.json({ data: [first, ...(storedAt !== undefined ? [{ id: "queued-failure", type: "synthetic", time: { created: storedAt }, text: "Native failure",
        metadata: { source: "subagent", childID: child, state: "error" } }] : [])], cursor: {} });
    }
    if (route === `/api/session/${child}/message`) return Response.json({ data: [{ id: "idle", type: "idle", time: { created: 40 }, outcome: "succeeded" }], cursor: {} });
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const owner = new AbortController(), lifetime = new AbortController(), stream = new AbortController(), secondStream = new AbortController();
  const realTimeout = AbortSignal.timeout.bind(AbortSignal), deadlines: AbortController[] = [];
  const timeout = mode === "original-deadline" ? spyOn(AbortSignal, "timeout").mockImplementation(ms => {
    if (ms !== 25_000) return realTimeout(ms);
    const deadline = new AbortController(); deadlines.push(deadline); return deadline.signal;
  }) : undefined;
  let inbox: ReturnType<NonNullable<typeof provider.listPendingInbox>> | undefined, pump: Promise<void> | undefined, secondPump: Promise<void> | undefined;
  try {
    parent = (await provider.createSession("Owned retry counterproof order")).id; child = fake.launchRequestWorker(parent).childId;
    if (mode === "reconnect") { pump = (async () => { for await (const _event of provider.events(stream.signal)) {} })(); await provider.waitForEventStream!(stream.signal); }
    if (olderObservation) {
      observing = true; inbox = provider.listPendingInbox!(parent, { signal: owner.signal }); void inbox.catch(() => undefined); await pending;
    }
    const page = await provider.listMessages(parent, { limit: 100, signal: owner.signal });
    const rows = page.items.filter((item): item is import("../../types").BackgroundTaskItem => item.type === "background_task");
    expect(page.workerSource?.isCurrent()).toBe(true);
    const longOwner = AbortSignal.any([lifetime.signal, stream.signal, realTimeout(60_000)]);
    let watch = mode === "newer-duplicate-seed" || mode === "older-seed" || mode === "older-overflow-seed" ? undefined : page.workerSource!.retainPendingCounterproof!(longOwner);
    if (olderObservation) {
      release(); await inbox; expect(page.workerSource?.isCurrent()).toBe(true);
      if (mode === "newer-duplicate-seed" || mode === "older-merge-with-newer-unrelated" || mode === "older-overflow-seed") await provider.listPendingInbox!(parent, { signal: owner.signal });
      watch ??= page.workerSource!.retainPendingCounterproof!(longOwner);
      if (mode === "newer-duplicate-seed" || mode === "older-overflow-seed") {
        if (mode === "newer-duplicate-seed") expect(page.workerSource?.isCurrent()).toBe(false);
        const retry = await provider.listMessages(parent, { limit: 100, signal: owner.signal });
        expect(retry.workerSource?.isCurrent()).toBe(true);
        expect(watch.applyTo(retry.workerSource!, retry.items.filter((item): item is import("../../types").BackgroundTaskItem => item.type === "background_task")).isCurrent()).toBe(false);
      } else expect(watch.applyTo(page.workerSource!, rows).isCurrent()).toBe(true);
    } else {
      observing = true; await provider.listPendingInbox!(parent, { signal: owner.signal });
      expect(page.workerSource?.isCurrent()).toBe(false);
      if (mode === "cancelled") lifetime.abort();
      if (mode === "original-deadline") { expect(deadlines.length).toBeGreaterThan(1); deadlines[0]!.abort(); expect(longOwner.aborted).toBe(false); }
      if (mode === "reconnect") {
        stream.abort(); await pump;
        secondPump = (async () => { for await (const _event of provider.events(secondStream.signal)) {} })(); await provider.waitForEventStream!(secondStream.signal);
      }
      storedAt = mode === "older-report" ? 30 : mode === "current-report" ? 50 : undefined;
      const next = await provider.listMessages(parent, { limit: 100, signal: owner.signal });
      const nextRows = next.items.filter((item): item is import("../../types").BackgroundTaskItem => item.type === "background_task");
      if (mode === "cancelled" || mode === "original-deadline" || mode === "reconnect") expect(() => watch!.applyTo(next.workerSource!, nextRows)).toThrow("expired");
      else if (mode === "unknown-guard") expect(() => watch!.applyTo({ isCurrent: next.workerSource!.isCurrent, retain: next.workerSource!.retain }, nextRows)).toThrow("source unavailable");
      else if (mode === "unrelated-cohort") {
        const other = (await provider.createSession("Different enclosing cohort")).id; fake.launchRequestWorker(other);
        const unrelated = await provider.listMessages(other, { limit: 100, signal: owner.signal });
        expect(() => watch!.applyTo(unrelated.workerSource!, [])).toThrow("source unavailable");
      } else {
        expect(watch!.applyTo(next.workerSource!, nextRows).isCurrent()).toBe(mode === "current-report");
        if (mode === "current-report") expect(nextRows).toContainEqual(expect.objectContaining({ status: "failed", resultId: "queued-failure", terminalReportedAt: 50 }));
      }
    }
  } finally { release(); owner.abort(); lifetime.abort(); stream.abort(); secondStream.abort(); timeout?.mockRestore(); await inbox?.catch(() => undefined); await pump; await secondPump; await provider.dispose!(); await fake.stop(); }
}, 10_000);

for (const carrier of ["transcript", "consumer"] as const)
for (const mode of ["relevant-then-unrelated", "sticky-overflow", ...(carrier === "consumer" ? ["ordered-baseline" as const] : [])] as const)
test(`prebaseline native positives retain scope and order (${carrier}/${mode})`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  let parent: string | undefined, child: string | undefined, phase: "owned" | "first" | "second" = "owned", heldOnce = false;
  let entered!: () => void, release!: () => void, inboxEntered!: () => void, releaseInbox!: () => void;
  const pending = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  const inboxPending = new Promise<void>(resolve => { inboxEntered = resolve; }), inboxHeld = new Promise<void>(resolve => { releaseInbox = resolve; });
  const report = (id: string, worker: string) => ({ id, type: "synthetic", time: { created: 45 }, payload: { text: "Native report",
    metadata: { source: "subagent", childID: worker, state: "error" } } });
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route === `/api/session/${parent}/inbox`) {
      const at = phase;
      if (at === "owned" && mode === "ordered-baseline") { inboxEntered(); await inboxHeld; }
      return Response.json({ data: at === "owned" ? [] : at === "second" ? mode === "sticky-overflow" ? [] : [report("other", "unrelated-child")]
        : mode === "sticky-overflow" ? Array.from({ length: 257 }, (_, index) => report(`report-${index}`, "unrelated-child")) : [report("first", child!)] });
    }
    if (route.endsWith("/inbox")) return Response.json({ data: [] });
    if (!heldOnce && (mode === "ordered-baseline" ? route === `/api/session/${parent}` : route === `/api/session/${parent}/message`)) { heldOnce = true; entered(); await held; }
    const response = await fetch(request);
    if (route === `/api/session/${parent}/message`) {
      const body = await response.json(), first = body.data[0]; first.time = { created: 10 }; first.content[0].time = { created: 10, ran: 11, completed: 12 };
      return Response.json({ data: [first], cursor: {} });
    }
    if (route === `/api/session/${child}/message`) return Response.json({ data: [{ id: "idle", type: "idle", time: { created: 40 }, outcome: "succeeded" }], cursor: {} });
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport }), abort = new AbortController();
  let reading: Promise<import("../../provider").ProviderHistoryPage | import("../../types").BackgroundTaskItem[]> | undefined;
  try {
    parent = (await provider.createSession("Native prebaseline evidence")).id; child = fake.launchRequestWorker(parent).childId;
    reading = carrier === "transcript" ? provider.listMessages(parent, { limit: 100, signal: abort.signal }) : provider.reconcileBackgroundTasks!(parent, { fresh: true, signal: abort.signal });
    void reading.catch(() => undefined); await pending;
    phase = "first"; expect(await provider.listPendingInbox!(parent, { signal: abort.signal })).toEqual([]);
    if (mode === "ordered-baseline") { phase = "owned"; release(); await inboxPending; }
    phase = "second"; expect(await provider.listPendingInbox!(parent, { signal: abort.signal })).toEqual([]);
    release(); releaseInbox();
    const result = await reading.then(value => ({ value }), error => ({ error }));
    if (mode === "ordered-baseline") {
      expect(result).toHaveProperty("value");
      if ("value" in result && Array.isArray(result.value)) expect(result.value[0]?.status).toBe("completed");
    } else if (carrier === "consumer") expect(result).toHaveProperty("error");
    else {
      expect(result).toHaveProperty("value");
      if ("value" in result && !Array.isArray(result.value)) expect(result.value.workerSource?.isCurrent()).toBe(false);
    }
  } finally { release(); releaseInbox(); abort.abort(); await reading?.catch(() => undefined); await provider.dispose!(); await fake.stop(); }
}, 10_000);

for (const mode of ["older-relevant", "newer-relevant", "older-stale", "older-stale-overflow", "older-overflow", "older-bytes", "older-duplicates", "unrelated"] as const)
test(`inventory provisional positives merge independently of response order (${mode})`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  let parent: string | undefined, child: string | undefined, final = false;
  let parentEntered!: () => void, releaseParent!: () => void, ownedEntered!: () => void, releaseOwned!: () => void, olderEntered!: () => void, releaseOlder!: () => void;
  const parentPending = new Promise<void>(resolve => { parentEntered = resolve; }), parentHeld = new Promise<void>(resolve => { releaseParent = resolve; });
  const ownedPending = new Promise<void>(resolve => { ownedEntered = resolve; }), ownedHeld = new Promise<void>(resolve => { releaseOwned = resolve; });
  const olderPending = new Promise<void>(resolve => { olderEntered = resolve; }), olderHeld = new Promise<void>(resolve => { releaseOlder = resolve; });
  const explicit = new AsyncLocalStorage<"older" | "newer">();
  const entry = (id: string, worker: string) => ({ id, type: "synthetic", time: { created: 45 }, payload: { text: "Actual provisional failure", metadata: { source: "subagent", childID: worker, state: "error" } } });
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route.endsWith("/inbox")) {
      if (route !== `/api/session/${parent}/inbox`) return Response.json({ data: [] });
      const order = explicit.getStore();
      if (!order && !final) { ownedEntered(); await ownedHeld; return Response.json({ data: [] }); }
      if (order === "older") { olderEntered(); await olderHeld; }
      const relevant = final || order === "newer" && mode === "newer-relevant" || order === "older" && ["older-relevant", "older-stale", "older-duplicates"].includes(mode);
      const report = entry(relevant ? "actual-provisional-failure" : "unrelated-failure", relevant ? child! : "unrelated");
      return Response.json({ data: order === "older" && (mode === "older-overflow" || mode === "older-stale-overflow") ? Array.from({ length: 257 }, (_, index) => entry(`overflow-${index}`, "unrelated"))
        : order === "older" && mode === "older-bytes" ? [entry("oversized", "z".repeat(32_768))]
        : order === "older" && mode === "older-duplicates" ? Array.from({ length: 400 }, () => report) : [report] });
    }
    const response = await fetch(request);
    if (route === `/api/session/${parent}/message`) {
      if (!final) { parentEntered(); await parentHeld; }
      const body = await response.json(), first = body.data[0]; first.time = { created: 10 }; first.content[0].time = { created: 10, ran: 11, completed: 12 };
      return Response.json({ data: [first], cursor: {} });
    }
    if (route === `/api/session/${child}/message`) return Response.json({ data: [{ id: "idle", type: "idle", time: { created: 40 }, outcome: "succeeded" }], cursor: {} });
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport }), abort = new AbortController();
  const guards: import("../../provider").WorkerSourceGuard[] = [];
  let older: ReturnType<NonNullable<typeof provider.listPendingInbox>> | undefined, reading: ReturnType<NonNullable<typeof provider.reconcileBackgroundTasks>> | undefined;
  const startOlder = async () => { older = explicit.run("older", () => provider.listPendingInbox!(parent!, { signal: abort.signal })); void older.catch(() => undefined); await olderPending; };
  try {
    parent = (await provider.createSession("Owned empty inventory baseline with overlapping positives")).id; const worker = fake.launchRequestWorker(parent); child = worker.childId;
    if (mode.startsWith("older-stale")) await startOlder();
    reading = provider.reconcileBackgroundTasks!(parent, { fresh: true, signal: abort.signal, onSource: source => guards.push(source.workerSource.retain(abort.signal)) }); void reading.catch(() => undefined);
    await Promise.all([parentPending, ownedPending]);
    if (!mode.startsWith("older-stale")) await startOlder();
    await explicit.run("newer", () => provider.listPendingInbox!(parent!, { signal: abort.signal }));
    releaseOlder(); await older; releaseParent(); releaseOwned();
    const result = await reading.then(value => ({ value }), error => ({ error }));
    const denied = !["older-stale", "older-stale-overflow", "unrelated"].includes(mode);
    if (denied) expect(result).not.toMatchObject({ value: [expect.objectContaining({ taskId: worker.taskId, status: "completed" })] });
    expect(guards.length).toBeGreaterThan(0);
    expect(guards.every(guard => guard.isCurrent())).toBe(!denied);
    if (denied) expect(result).toHaveProperty("error");
    else expect(result).toMatchObject({ value: [expect.objectContaining({ taskId: worker.taskId, status: "completed" })] });
    final = true;
    const fresh = await provider.reconcileBackgroundTasks!(parent, { fresh: true, signal: abort.signal });
    expect(fresh.find(item => item.taskId === worker.taskId)).toMatchObject({ status: "failed", resultId: "actual-provisional-failure", summary: "Actual provisional failure", terminalReportedAt: 45 });
  } finally { releaseOlder(); releaseParent(); releaseOwned(); abort.abort(); await older?.catch(() => undefined); await reading?.catch(() => undefined); await provider.dispose!(); await fake.stop(); }
}, 10_000);

for (const stagedPrefix of [false, true])
for (const mode of ["newer-relevant", "older-only", "newer-overflow", "older-overflow", "newer-unrelated"] as const)
test(`transcript pending order survives a late older snapshot envelope (${mode}, staged-prefix=${stagedPrefix})`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  let parent: string | undefined, child: string | undefined, heldOnce = false;
  let parentEntered!: () => void, releaseParent!: () => void, inboxEntered!: () => void, releaseInbox!: () => void;
  const parentPending = new Promise<void>(resolve => { parentEntered = resolve; }), parentHeld = new Promise<void>(resolve => { releaseParent = resolve; });
  const inboxPending = new Promise<void>(resolve => { inboxEntered = resolve; }), inboxHeld = new Promise<void>(resolve => { releaseInbox = resolve; });
  const explicit = new AsyncLocalStorage<"older" | "newer">();
  const report = (id: string, worker: string) => ({ id, type: "synthetic", time: { created: 45 }, payload: { text: "Actual ordered failure",
    metadata: { source: "subagent", childID: worker, state: "error" } } });
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route.endsWith("/inbox")) {
      if (route !== `/api/session/${parent}/inbox`) return Response.json({ data: [] });
      const order = explicit.getStore();
      if (order === "older") { inboxEntered(); await inboxHeld; }
      const overflow = order === "older" ? mode === "older-overflow" : order === "newer" && mode === "newer-overflow";
      const relevant = order === "older" ? mode === "older-only" : mode === "newer-relevant";
      return Response.json({ data: overflow ? Array.from({ length: 257 }, (_, index) => report(`overflow-${index}`, "unrelated"))
        : [report(relevant || !order ? "actual-ordered-failure" : "unrelated-failure", relevant || !order ? child! : "unrelated")] });
    }
    const response = await fetch(request);
    if (route === `/api/session/${parent}/message`) {
      if (!heldOnce) { heldOnce = true; parentEntered(); await parentHeld; }
      const body = await response.json(), first = body.data[0]; first.time = { created: 10 }; first.content[0].time = { created: 10, ran: 11, completed: 12 };
      return Response.json({ data: [first, ...(stagedPrefix ? [{ id: "parent-hidden", type: "user", text: "Hidden parent suffix", time: { created: 60 } }] : [])], cursor: {} });
    }
    if (route === `/api/session/${child}/message`) return Response.json({ data: [{ id: "idle", type: "idle", time: { created: 40 }, outcome: "succeeded" }], cursor: {} });
    if (route === `/api/session/${parent}` && stagedPrefix) { const body = await response.json(); body.data.revert = { messageID: "parent-hidden" }; return Response.json(body); }
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport }), abort = new AbortController();
  let older: ReturnType<NonNullable<typeof provider.listPendingInbox>> | undefined, reading: ReturnType<typeof provider.listMessages> | undefined;
  try {
    parent = (await provider.createSession("Per-fact order after out-of-order snapshots")).id; const worker = fake.launchRequestWorker(parent); child = worker.childId;
    older = explicit.run("older", () => provider.listPendingInbox!(parent!, { signal: abort.signal })); void older.catch(() => undefined); await inboxPending;
    reading = provider.listMessages(parent, { limit: 100, signal: abort.signal }); void reading.catch(() => undefined); await parentPending;
    await explicit.run("newer", () => provider.listPendingInbox!(parent!, { signal: abort.signal }));
    releaseInbox(); await older; releaseParent(); const page = await reading;
    expect(page.items).toContainEqual(expect.objectContaining({ taskId: worker.taskId, status: "completed" }));
    expect(page.workerSource?.isCurrent()).toBe(mode !== "newer-relevant" && mode !== "newer-overflow");
    const fresh = await provider.reconcileBackgroundTasks!(parent, { fresh: true, signal: abort.signal });
    expect(fresh.find(item => item.taskId === worker.taskId)).toMatchObject({ status: "failed", resultId: "actual-ordered-failure", summary: "Actual ordered failure", terminalReportedAt: 45 });
  } finally { releaseInbox(); releaseParent(); abort.abort(); await older?.catch(() => undefined); await reading?.catch(() => undefined); await provider.dispose!(); await fake.stop(); }
}, 10_000);

for (const mode of ["pending-only", "delivered", "unrelated", "prelaunch"] as const)
test(`covered history keeps pending counterproof across failed-inventory retries (${mode})`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  let parent: string | undefined, child: string | undefined, captured = false, released = false, delivered = false, observing = false, parentReads = 0, attempts = 0;
  let entered!: () => void, release!: () => void;
  const pending = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  const report = () => ({ id: "actual-failed-report", type: "synthetic", time: { created: mode === "prelaunch" ? 5 : 45 }, payload: {
    text: "Actual parent failure", metadata: { source: "subagent", childID: mode === "unrelated" ? "unrelated-child" : child, state: "error" },
  } });
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route.endsWith("/inbox")) return Response.json({ data: observing && route === `/api/session/${parent}/inbox` ? [report()] : [] });
    const response = await fetch(request);
    if (route === `/api/session/${parent}/message`) {
      parentReads++;
      const body = await response.json(), first = body.data[0]; first.time = { created: 10 }; first.content[0].time = { created: 10, ran: 11, completed: 12 };
      const result = report();
      return Response.json({ data: [first, ...(delivered ? [{ ...result.payload, id: result.id, type: result.type, time: result.time }] : [])], cursor: {} });
    }
    if (route === `/api/session/${child}/message`) return Response.json({ data: [{ id: "idle", type: "idle", time: { created: 40 }, outcome: "succeeded" }], cursor: {} });
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const nativeHistory = provider.listMessages.bind(provider), abort = new AbortController();
  const guards: import("../../provider").WorkerSourceGuard[] = [];
  provider.listMessages = async (id, options) => {
    const page = await nativeHistory(id, options);
    if (id === parent) { attempts++; captured = true; if (page.workerSource) guards.push(page.workerSource); }
    return page;
  };
  provider.reconcileBackgroundTasks = async () => { if (captured && !released) { entered(); await held; } throw new Error("Inventory remains unavailable"); };
  const adapter = new ChatAdapter({ provider, workspacePath: directory, coalesceWindowMs: 0, historyReadTimeoutMs: 400 });
  let history: ReturnType<typeof adapter.history> | undefined;
  try {
    parent = (await provider.createSession("One covered read, repeated transcript attempts")).id; const worker = fake.launchRequestWorker(parent); child = worker.childId;
    history = adapter.history(parent); void history.catch(() => undefined); await pending;
    expect(guards[0]?.isCurrent()).toBe(true);
    observing = true;
    await provider.listPendingInbox!(parent, { signal: abort.signal });
    expect(guards[0]?.isCurrent()).toBe(mode === "unrelated" || mode === "prelaunch");
    delivered = mode === "delivered"; released = true; release();
    const result = await history.then(value => ({ value }), error => ({ error }));
    if (mode === "pending-only") {
      expect(result).toHaveProperty("error");
      expect(attempts).toBeGreaterThan(1);
    } else {
      expect(result).toHaveProperty("value");
      if ("value" in result) expect(result.value.items).toContainEqual(expect.objectContaining({ taskId: worker.taskId,
        status: mode === "delivered" ? "failed" : "completed", ...(mode === "delivered" ? { resultId: "actual-failed-report", summary: "Actual parent failure", terminalReportedAt: 45 } : {}) }));
      if (mode === "delivered") expect(parentReads).toBeGreaterThan(1);
    }
  } finally { released = true; release(); abort.abort(); await history?.catch(() => undefined); await adapter.dispose(); await fake.stop(); }
}, 10_000);

for (const pageKind of ["newest", "older"] as const)
for (const delivered of [false, true])
test(`paginated adapter retains newer duplicate pending observation (delivered=${delivered}/${pageKind})`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  let parent: string | undefined, child: string | undefined, inboxReads = 0, attempts = 0, stored = false;
  let entered!: () => void, release!: () => void;
  const pending = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  const explicitObservation = new AsyncLocalStorage<boolean>();
  let armed = pageKind === "newest";
  const report = { id: "duplicate-failure", type: "synthetic", time: { created: 45 }, payload: { text: "Actual duplicate failure",
    metadata: { source: "subagent", childID: "", state: "error" } } };
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route.endsWith("/inbox")) {
      if (route !== `/api/session/${parent}/inbox` || !explicitObservation.getStore()) return Response.json({ data: [] });
      if (++inboxReads === 1) { entered(); await held; }
      return Response.json({ data: [report] });
    }
    const response = await fetch(request);
    if (route === `/api/session/${parent}/message`) {
      const body = await response.json(), first = body.data[0]; first.time = { created: 10 }; first.content[0].time = { created: 10, ran: 11, completed: 12 };
      return Response.json({ data: [{ id: "older-text", type: "user", text: "Older pagination boundary", time: { created: 1 } },
        { id: "earlier-text", type: "user", text: "Earlier pagination boundary", time: { created: 2 } }, first,
        ...(stored ? [{ ...report.payload, id: report.id, type: report.type, time: report.time }] : []),
        ...(pageKind === "older" ? [{ id: "newest-page", type: "user", text: "Newest page", time: { created: 60 } }] : [])], cursor: {} });
    }
    if (route === `/api/session/${child}/message`) return Response.json({ data: [{ id: "idle", type: "idle", time: { created: 40 }, outcome: "succeeded" }], cursor: {} });
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const nativeHistory = provider.listMessages.bind(provider), abort = new AbortController();
  let older: ReturnType<NonNullable<typeof provider.listPendingInbox>> | undefined;
  provider.listMessages = async (id, options) => {
    const page = await nativeHistory(id, options);
    if (id === parent && armed && ++attempts === 1) {
      expect(page.nextCursor).toBeDefined(); expect(page.workerSource?.isCurrent()).toBe(true);
      release(); await older; expect(page.workerSource?.isCurrent()).toBe(true);
      await explicitObservation.run(true, () => provider.listPendingInbox!(parent!, { signal: abort.signal }));
      expect(page.workerSource?.isCurrent()).toBe(false);
      stored = delivered;
    }
    return page;
  };
  provider.reconcileBackgroundTasks = async () => { throw new Error("Inventory intentionally unavailable"); };
  const adapter = new ChatAdapter({ provider, workspacePath: directory, coalesceWindowMs: 0, historyReadTimeoutMs: 400 });
  try {
    parent = (await provider.createSession("Duplicate observation pagination")).id; const worker = fake.launchRequestWorker(parent); child = worker.childId; report.payload.metadata.childID = child;
    older = explicitObservation.run(true, () => provider.listPendingInbox!(parent!, { signal: abort.signal })); void older.catch(() => undefined); await pending;
    const newest = pageKind === "older" ? await adapter.history(parent, { limit: 1 }) : undefined;
    if (newest) expect(newest.olderCursor).toBeDefined();
    armed = true;
    let result = await adapter.history(parent, { limit: 2, ...(newest ? { cursor: newest.olderCursor } : {}) }).then(value => ({ value }), error => ({ error }));
    if (pageKind === "older" && delivered) {
      // Delivery changes the native history version. The old cursor must not
      // publish; canonical stored content is obtained by a new public read.
      expect(result).toHaveProperty("error");
      result = await adapter.history(parent, { limit: 100 }).then(value => ({ value }), error => ({ error }));
    }
    expect(attempts).toBeGreaterThan(1);
    if (!delivered) {
      if ("value" in result) expect(result.value.items).not.toContainEqual(expect.objectContaining({ taskId: worker.taskId, status: "completed" }));
      expect(result).toHaveProperty("error");
    }
    else {
      expect(result).toHaveProperty("value");
      if ("value" in result) expect(result.value.items).toContainEqual(expect.objectContaining({ taskId: worker.taskId, status: "failed",
        resultId: report.id, summary: report.payload.text, terminalReportedAt: 45 }));
    }
  } finally { release(); abort.abort(); await older?.catch(() => undefined); await adapter.dispose(); await fake.stop(); }
}, 10_000);

for (const boundary of ["terminal", "start"] as const)
for (const read of ["provider", "adapter"] as const)
for (const change of read === "provider" ? ["exact", "changed-id", "changed-clock", "changed-payload", "other-child", "foreign"] as const : ["exact"] as const)
test(`${read} recognizes a retained history-only ${boundary} replay (${change})`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  const eventType = boundary === "terminal" ? "session.execution.succeeded" : "session.execution.started", proofId = `${boundary}-proof`, nativeAt = boundary === "terminal" ? 20 : 11;
  let parent: string | undefined, child: string | undefined, wire!: ReadableStreamDefaultController<Uint8Array>, acknowledge: (() => void) | undefined;
  const frame = (type: string, data: unknown, id = type, created = 20, location = directory) => wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ id, type, data, created, location: { directory: location } })}\n\n`));
  const barrier = () => new Promise<void>(resolve => { acknowledge = resolve; frame("diagnostic.terminal-replay-applied", {}); });
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route === "/api/event") return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      wire = controller; frame("server.connected", {}, "connected", 1); request.signal.addEventListener("abort", () => controller.close(), { once: true });
    } }), { headers: { "content-type": "text/event-stream" } });
    if (route.endsWith("/inbox")) return Response.json({ data: [] });
    const response = await fetch(request);
    if (route === `/api/session/${parent}/message`) {
      const body = await response.json(), first = body.data[0]; first.time = { created: 10 }; first.content[0].time = { created: 10, ran: 11, completed: 12 };
      return Response.json({ data: [first], cursor: {} });
    }
    if (route === `/api/session/${child}/message`) return Response.json({ data: [{ id: "idle", type: "idle", time: { created: 20 }, outcome: "succeeded" }], cursor: {} });
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const nativeEvents = provider.events.bind(provider), nativeHistory = provider.listMessages.bind(provider);
  provider.events = async function* (signal) { for await (const event of nativeEvents(signal)) {
    if (event.eventType === "diagnostic.terminal-replay-applied") { acknowledge?.(); acknowledge = undefined; } yield event;
  } };
  const firstAbort = new AbortController(), abort = new AbortController();
  const adapter = read === "adapter" ? new ChatAdapter({ provider, workspacePath: directory, coalesceWindowMs: 0, historyReadTimeoutMs: 500 }) : undefined;
  let firstPump: Promise<void> | undefined, pump: Promise<void> | undefined, handoffs = 0;
  try {
    firstPump = (async () => { for await (const _event of nativeEvents(firstAbort.signal)) {} })();
    await provider.waitForEventStream!(firstAbort.signal); firstAbort.abort(); await firstPump;
    parent = (await provider.createSession("History-only native terminal replay")).id; const worker = fake.launchRequestWorker(parent); child = worker.childId;
    pump = adapter ? adapter.startEventPump() : (async () => { for await (const _event of provider.events(abort.signal)) {} })();
    await provider.waitForEventStream!(abort.signal);
    frame(eventType, { sessionID: child }, proofId, nativeAt); await barrier();
    if (adapter) {
      provider.listMessages = async (id, options) => {
        const page = await nativeHistory(id, options);
        if (id === parent) { handoffs++; frame(eventType, { sessionID: child }, proofId, nativeAt); await barrier(); }
        return page;
      };
      const snapshot = await adapter.history(parent);
      expect(snapshot.items).toContainEqual(expect.objectContaining({ taskId: worker.taskId, status: "completed" }));
      expect(handoffs).toBeGreaterThan(0);
    } else {
      const page = await provider.listMessages(parent, { limit: 100, signal: abort.signal });
      expect(page.items).toContainEqual(expect.objectContaining({ taskId: worker.taskId, status: "completed" }));
      expect(page.workerSource?.isCurrent()).toBe(true);
      frame(eventType, { sessionID: change === "other-child" ? "another-child" : child, ...(change === "changed-payload" ? { reason: "different payload" } : {}) },
        change === "changed-id" ? "different-proof" : proofId, change === "changed-clock" ? 25 : nativeAt, change === "foreign" ? `${directory}/foreign` : directory);
      await barrier();
      expect(page.workerSource?.isCurrent()).toBe(["exact", "other-child", "foreign"].includes(change));
      const row = page.items.find((item): item is import("../../types").BackgroundTaskItem => item.type === "background_task");
      expect(workerCanStop(row!)).toBe(false); expect(row?.resultId).toBeUndefined(); expect(row?.terminalReportedAt).toBeUndefined();
    }
  } finally { firstAbort.abort(); abort.abort(); if (adapter) await adapter.dispose(); else await provider.dispose!(); await firstPump; await pump; await fake.stop(); }
}, 10_000);

for (const carrier of ["native", "streamed", "native-independent-veto"] as const)
for (const change of carrier === "native-independent-veto" ? ["failed-report"] as const : ["failed-report", "ordinary-text", "other-child", "prelaunch", "same-report"] as const)
test(`transcript fallback fences ${carrier} pending counterproof after inventory failure (${change})`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  let parent: string | undefined, child: string | undefined, other: string | undefined, changed = false, captured = false, failedInventory = false, released = false;
  let entered!: () => void, release!: () => void, wire!: ReadableStreamDefaultController<Uint8Array>, applied!: () => void;
  const pending = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  const observed = new Promise<void>(resolve => { applied = resolve; });
  const frame = (type: string, data: unknown, created = 45) => wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type, data, created, location: { directory } })}\n\n`));
  const report = () => ({ id: "pending-result", type: "synthetic", time: { created: change === "prelaunch" ? 5 : 45 }, payload: change === "ordinary-text" ? { text: "Ordinary text" }
    : { text: "Native report", metadata: { source: "subagent", childID: change === "other-child" ? other : child, state: change === "same-report" ? "completed" : "error" } } });
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route === "/api/event") return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      wire = controller; frame("server.connected", {}, 1); request.signal.addEventListener("abort", () => controller.close(), { once: true });
    } }), { headers: { "content-type": "text/event-stream" } });
    if (route.endsWith("/inbox")) return Response.json({ data: route === `/api/session/${parent}/inbox` && changed ? [report()] : [] });
    const response = await fetch(request);
    if (route === `/api/session/${parent}/message`) {
      const body = await response.json(), first = body.data[0]; first.time = { created: 10 }; first.content[0].time = { created: 10, ran: 11, completed: 12 };
      first.content.push({ type: "text", text: "Transcript text keeps its own authority." });
      const result = report();
      return Response.json({ data: [first, ...(change === "same-report" ? [{ ...result.payload, id: result.id, type: result.type, time: result.time }] : [])], cursor: {} });
    }
    if (route === `/api/session/${child}/message`) return Response.json({ data: [{ id: "idle", type: "idle", time: { created: 40 }, outcome: "succeeded" }], cursor: {} });
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const nativeHistory = provider.listMessages.bind(provider), nativeRecovery = provider.reconcileBackgroundTasks!.bind(provider), nativeEvents = provider.events.bind(provider);
  const guards: import("../../provider").WorkerSourceGuard[] = [];
  let pageSignal: AbortSignal | undefined, revokePage: (() => void) | undefined, successfulHistoryInventories = 0;
  provider.listMessages = async (id, options) => {
    const page = await nativeHistory(id, options);
    if (id === parent && !captured) { captured = true; if (page.workerSource) guards.push(page.workerSource); }
    if (id === parent && carrier === "native-independent-veto") {
      let current = true; pageSignal = options.signal; revokePage = () => { current = false; };
      return { ...page, isWorkerSourceCurrent: () => current };
    }
    return page;
  };
  provider.reconcileBackgroundTasks = async (id, options) => {
    if (!released) { if (captured) { entered(); await held; } failedInventory = true; throw new Error("Inventory intentionally unavailable"); }
    const tasks = await nativeRecovery(id, options);
    if (carrier === "native-independent-veto" && options?.signal === pageSignal && ++successfulHistoryInventories === 1) revokePage?.();
    return tasks;
  };
  provider.events = async function* (signal) { for await (const event of nativeEvents(signal)) { if (event.eventType === "diagnostic.transcript-report-applied") applied(); yield event; } };
  const adapter = new ChatAdapter({ provider, workspacePath: directory, coalesceWindowMs: 0 });
  let history: ReturnType<typeof adapter.history> | undefined;
  try {
    parent = (await provider.createSession("Transcript-only outcome publication")).id; const worker = fake.launchRequestWorker(parent); child = worker.childId;
    const peer = (await provider.createSession("Other report owner")).id; other = fake.launchRequestWorker(peer).childId;
    history = adapter.history(parent); void history.catch(() => undefined); await pending;
    expect(guards.length).toBeGreaterThan(0); expect(guards.every(guard => guard.isCurrent())).toBe(true);
    changed = true;
    if (carrier !== "streamed") {
      const fresh = await nativeRecovery(parent, { fresh: true });
      expect(fresh.find(task => task.taskId === worker.taskId)?.status).toBe(change === "failed-report" ? "failed" : "completed");
    } else {
      const result = report(); frame("session.inbox.enqueued", { sessionID: parent, inboxID: result.id, item: result }, result.time.created);
      frame("diagnostic.transcript-report-applied", {}); await observed;
    }
    const current = guards.every(guard => guard.isCurrent());
    released = true; release(); const result = await history.then(value => ({ value }), error => ({ error }));
    expect(failedInventory).toBe(true);
    expect(result).toHaveProperty("value");
    if ("value" in result) {
      expect(result.value.items.some(item => item.type === "assistant_message" && item.markdown.includes("Transcript text keeps its own authority."))).toBe(true);
      const row = result.value.items.find((item): item is import("../../types").BackgroundTaskItem => item.type === "background_task" && item.taskId === worker.taskId);
      expect(row?.status).toBe(change === "failed-report" ? "failed" : "completed");
      if (change === "failed-report") expect(row).toMatchObject({ resultId: "pending-result", summary: "Native report", terminalReportedAt: 45 });
    }
    expect(current).toBe(change !== "failed-report");
    if (carrier === "native-independent-veto") expect(successfulHistoryInventories).toBeGreaterThan(1);
  } finally { released = true; release(); await history?.catch(() => undefined); await adapter.dispose(); await fake.stop(); }
}, 10_000);

for (const mode of ["qualified", "changed-execution", "changed-child", "report-free", "released", "ownership", "revert", "independent-outcome", "partial-coverage", "inventory-change", "transfer-budget"] as const)
test(`explicit inventory report relinquishes only qualified transcript outcomes (${mode})`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  let parent: string | undefined, child: string | undefined, other: string | undefined, changed = false, foreign = false, reverted = false, secondReport = false, reportText = "Real explicit failure";
  const cohort: string[] = [];
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route.endsWith("/inbox")) return Response.json({ data: changed && mode !== "report-free" && route === `/api/session/${parent}/inbox`
      ? (mode === "transfer-budget" ? cohort : [child, ...(secondReport ? [other] : [])]).map(subject => ({ id: `result-${subject}`, type: "synthetic", time: { created: 45 }, payload: {
        text: reportText, metadata: { source: "subagent", childID: mode === "changed-child" ? other : subject, state: "error" },
      } })) : [] });
    const response = await fetch(request);
    if (route === `/api/session/${parent}/message`) {
      const body = await response.json(), first = body.data[0]; first.time = { created: 10 }; first.content[0].time = { created: 10, ran: 11, completed: 12 };
      if (changed && mode === "changed-execution") { first.time = { created: 30 }; first.content[0].time = { created: 30, ran: 31, completed: 32 }; }
      if (changed && mode === "changed-child") first.content[0].state.metadata.sessionID = other;
      const second = body.data[1];
      if (second) { second.time = { created: 10 }; second.content[0].time = { created: 10, ran: 11, completed: 12 }; }
      if (second && mode === "partial-coverage") { second.content[0].state.metadata.sessionID = child; second.time = { created: 30 }; second.content[0].time = { created: 30, ran: 31, completed: 32 }; }
      if (mode === "transfer-budget") return Response.json({ data: body.data.map((message: any) => {
        message.time = { created: 10 }; message.content[0].time = { created: 10, ran: 11, completed: 12 }; return message;
      }), cursor: {} });
      return Response.json({ data: [first, ...(mode === "independent-outcome" || mode === "partial-coverage" ? [second] : [])], cursor: {} });
    }
    if (route === `/api/session/${child}/message` || route === `/api/session/${other}/message` || cohort.some(subject => route === `/api/session/${subject}/message`))
      return Response.json({ data: [...(mode === "partial-coverage" ? [{ id: "earlier-idle", type: "idle", time: { created: 20 }, outcome: "succeeded" }] : []),
        { id: "idle", type: "idle", time: { created: 40 }, outcome: "succeeded" }], cursor: {} });
    if (route === `/api/session/${child}` && foreign) { const body = await response.json(); body.data.parentID = "foreign-parent"; return Response.json(body); }
    if (route === `/api/session/${child}` && reverted) { const body = await response.json(); body.data.revert = { messageID: "hidden-boundary" }; return Response.json(body); }
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const owner = new AbortController(), inventory = new AbortController();
  const guards: import("../../provider").WorkerSourceGuard[] = [];
  try {
    parent = (await provider.createSession("Qualified explicit outcome transfer")).id; child = fake.launchRequestWorker(parent).childId; other = fake.launchRequestWorker(parent).childId;
    if (mode === "transfer-budget") { cohort.push(child, other); while (cohort.length < 80) cohort.push(fake.launchRequestWorker(parent).childId); }
    const page = await provider.listMessages(parent, { limit: 100, signal: owner.signal });
    expect(page.items).toContainEqual(expect.objectContaining({ status: "completed", childConversationId: child }));
    expect(page.workerSource?.isCurrent()).toBe(true);
    if (mode === "transfer-budget") expect(page.items.filter(item => item.type === "background_task" && item.status === "completed")).toHaveLength(80);
    if (mode === "released") owner.abort();
    changed = true;
    const reports = await provider.reconcileBackgroundTasks!(parent, { fresh: true, signal: inventory.signal,
      onSource: source => guards.push(source.workerSource.retain(inventory.signal)) });
    expect(guards.every(guard => guard.isCurrent())).toBe(true);
    const narrowed = page.workerSource?.withoutInferredOutcomes?.(reports);
    const qualifies = !["changed-execution", "changed-child", "report-free", "released", "partial-coverage", "transfer-budget"].includes(mode);
    if (!qualifies) expect(narrowed).toBeUndefined();
    else {
      expect(page.workerSource?.isCurrent()).toBe(false); // The stale whole-source lease is never restored.
      expect(narrowed?.isCurrent()).toBe(true);
      if (mode === "ownership") { foreign = true; await provider.getSession(child); expect(narrowed?.isCurrent()).toBe(false); }
      if (mode === "revert") { reverted = true; await provider.getSession(child); expect(narrowed?.isCurrent()).toBe(false); }
      if (mode === "independent-outcome") {
        secondReport = true; await provider.listPendingInbox!(parent, { signal: inventory.signal });
        expect(narrowed?.isCurrent()).toBe(false); // A covered sibling cannot exempt this other inference.
      }
      if (mode === "inventory-change") {
        reportText = "Newer explicit content"; await provider.listPendingInbox!(parent, { signal: inventory.signal });
        expect(narrowed?.isCurrent()).toBe(true); // Text authority does not own the replacement report.
        expect(guards.every(guard => guard.isCurrent())).toBe(false); // Inventory authority must still veto admission.
      }
      owner.abort(); expect(narrowed?.isCurrent()).toBe(false);
    }
  } finally { owner.abort(); inventory.abort(); await provider.dispose!(); await fake.stop(); }
}, 10_000);

for (const order of ["older-inbox", "newer-inbox", "streamed-pending-deltas", "native-pending-delivered"] as const)
test(`transcript pending counterproof uses owned native request order (${order})`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  let parent: string | undefined, child: string | undefined, heldOnce = false, delivered = false, inboxObservations = 0;
  let entered!: () => void, release!: () => void;
  const pending = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  let wire!: ReadableStreamDefaultController<Uint8Array>, applied!: () => void;
  const observed = new Promise<void>(resolve => { applied = resolve; });
  const frame = (type: string, data: unknown) => wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type, data, created: 45, location: { directory } })}\n\n`));
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (order === "streamed-pending-deltas" && route === "/api/event") return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      wire = controller; frame("server.connected", {}); request.signal.addEventListener("abort", () => controller.close(), { once: true });
    } }), { headers: { "content-type": "text/event-stream" } });
    if (route.endsWith("/inbox")) {
      if (route === `/api/session/${parent}/inbox`) {
        inboxObservations++;
        if (order === "older-inbox") { entered(); await held; }
        return Response.json({ data: [{ id: "pending-result", type: "synthetic", time: { created: 45 }, payload: {
          text: "Native failed report", metadata: { source: "subagent", childID: order === "native-pending-delivered" && inboxObservations > 1 ? "unrelated-child" : child, state: "error" },
        } }] });
      }
      return Response.json({ data: [] });
    }
    const response = await fetch(request);
    if (route === `/api/session/${parent}/message`) {
      const includeReport = delivered;
      if (order !== "older-inbox" && !heldOnce) { heldOnce = true; entered(); await held; }
      const body = await response.json(), first = body.data[0]; first.time = { created: 10 }; first.content[0].time = { created: 10, ran: 11, completed: 12 };
      return Response.json({ data: [first, ...(includeReport ? [{ id: "pending-result", type: "synthetic", time: { created: 45 }, text: "Native failed report",
        metadata: { source: "subagent", childID: child, state: "error" } }] : [])], cursor: {} });
    }
    if (route === `/api/session/${child}/message`) return Response.json({ data: [{ id: "idle", type: "idle", time: { created: 40 }, outcome: "succeeded" }], cursor: {} });
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport }), abort = new AbortController();
  let inbox: ReturnType<NonNullable<typeof provider.listPendingInbox>> | undefined, history: ReturnType<typeof provider.listMessages> | undefined;
  let pump: Promise<void> | undefined;
  try {
    parent = (await provider.createSession("Transcript owned ordering")).id; child = fake.launchRequestWorker(parent).childId;
    if (order === "streamed-pending-deltas") {
      pump = (async () => { for await (const event of provider.events(abort.signal)) if (event.eventType === "diagnostic.transcript-deltas-applied") applied(); })();
      await provider.waitForEventStream!(abort.signal);
    }
    if (order === "older-inbox") {
      inbox = provider.listPendingInbox!(parent, { signal: abort.signal }); void inbox.catch(() => undefined); await pending;
      const page = await provider.listMessages(parent, { limit: 100, signal: abort.signal });
      expect(page.workerSource?.isCurrent()).toBe(true); release(); await inbox;
      expect(page.workerSource?.isCurrent()).toBe(true);
    } else {
      history = provider.listMessages(parent, { limit: 100, signal: abort.signal }); void history.catch(() => undefined); await pending;
      if (order === "streamed-pending-deltas") {
        for (const [id, subject] of [["pending-result", child], ["unrelated-result", "unrelated-child"]])
          frame("session.inbox.enqueued", { sessionID: parent, inboxID: id, item: { type: "synthetic", payload: {
            text: "Report", metadata: { source: "subagent", childID: subject, state: "error" },
          } } });
        frame("diagnostic.transcript-deltas-applied", {}); await observed;
      } else {
        expect(await provider.listPendingInbox!(parent, { signal: abort.signal })).toEqual([]);
        if (order === "native-pending-delivered") { delivered = true; expect(await provider.listPendingInbox!(parent, { signal: abort.signal })).toEqual([]); }
      }
      release(); const page = await history;
      expect(page.workerSource?.isCurrent()).toBe(false);
      if (order === "native-pending-delivered") {
        const fresh = await provider.reconcileBackgroundTasks!(parent, { fresh: true, signal: abort.signal });
        expect(fresh).toContainEqual(expect.objectContaining({ status: "failed", resultId: "pending-result", summary: "Native failed report" }));
      }
    }
  } finally { release(); abort.abort(); await inbox?.catch(() => undefined); await history?.catch(() => undefined); await pump; await provider.dispose!(); await fake.stop(); }
}, 10_000);

for (const mode of ["older-inactive", "newer-inactive-pending", "cancelled-inactive", "released-owner", "live-inactive"] as const)
test(`cold inventory counterproof respects native ordering and source lifetime (${mode})`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  let parent: string | undefined, child: string | undefined, activeReads = 0, active = true;
  let entered!: () => void, release!: () => void, wire!: ReadableStreamDefaultController<Uint8Array>, applied!: () => void;
  const pending = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  const observed = new Promise<void>(resolve => { applied = resolve; });
  const frame = (type: string, data: unknown, created: number) => wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type, data, created, location: { directory } })}\n\n`));
  let launcher: Record<string, unknown> | undefined;
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (mode === "live-inactive" && route === "/api/event") return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      wire = controller; frame("server.connected", {}, 1); request.signal.addEventListener("abort", () => controller.close(), { once: true });
    } }), { headers: { "content-type": "text/event-stream" } });
    if (route === "/api/session/active") {
      const index = ++activeReads, data = active && child ? { [child]: { status: "running" } } : {};
      if ((mode === "older-inactive" || mode === "newer-inactive-pending") && index === 1 || mode === "cancelled-inactive" && index === 2) { entered(); await held; }
      return Response.json({ data });
    }
    if (route.endsWith("/inbox")) return Response.json({ data: [] });
    const response = await fetch(request);
    if (route === `/api/session/${parent}/message`) {
      const body = await response.json(), first = body.data[0]; first.time = { created: 10 };
      first.content[0].time = { created: 10, ran: 11, completed: 12 }; launcher = first;
      return Response.json({ data: [first], cursor: {} });
    }
    if (route === `/api/session/${child}/message`) return Response.json({ data: [], cursor: {} });
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const owner = new AbortController(), probe = new AbortController(), lifetime = new AbortController();
  const guards: import("../../provider").WorkerSourceGuard[] = [];
  const recover = (signal: AbortSignal, retain = false, id = parent!) => provider.reconcileBackgroundTasks!(id, { fresh: true, signal,
    ...(retain ? { onSource: (source: import("../../provider").WorkerRecoverySource) => guards.push(source.workerSource.retain(owner.signal)) } : {}) });
  let older: ReturnType<typeof recover> | undefined, pump: Promise<void> | undefined;
  try {
    parent = (await provider.createSession("Ordered cold inventory")).id; child = fake.launchRequestWorker(parent).childId;
    const peer = (await provider.createSession("Independent inventory reader")).id; fake.launchRequestWorker(peer);
    if (mode === "live-inactive") {
      // Use the real native launcher projection; no synthetic source guards.
      await provider.listMessages(parent, { limit: 100, signal: lifetime.signal });
      pump = (async () => { for await (const event of provider.events(lifetime.signal)) if (event.eventType === "diagnostic.live-inventory-ready") applied(); })();
      await provider.waitForEventStream!(lifetime.signal);
      frame("session.message.content.updated", { sessionID: parent, messageID: launcher!.id, content: launcher!.content }, 12);
      frame("diagnostic.live-inventory-ready", {}, 13); await observed;
    }
    if (mode === "older-inactive" || mode === "newer-inactive-pending") {
      active = mode !== "older-inactive";
      // Same-parent fresh reads intentionally serialize. An independent
      // parent's public recovery supplies the overlapping global inventory.
      older = recover(probe.signal, false, mode === "older-inactive" ? peer : parent); void older.catch(() => undefined); await pending;
      active = !active;
      const newer = await recover(owner.signal, true, mode === "older-inactive" ? parent : peer);
      expect(newer[0]?.activity?.kind).toBe(active ? "working" : "unavailable");
      expect(guards.length).toBeGreaterThan(0); expect(guards.every(guard => guard.isCurrent())).toBe(true);
      release(); const stale = await older;
      expect(stale[0]?.activity?.kind).toBe("unavailable");
      expect(guards.every(guard => guard.isCurrent())).toBe(true);
    } else {
      const initial = await recover(owner.signal, true);
      expect(initial[0]?.activity?.kind).toBe("working"); expect(guards.every(guard => guard.isCurrent())).toBe(true);
      if (mode === "released-owner") owner.abort();
      active = false;
      if (mode === "cancelled-inactive") {
        older = recover(probe.signal); void older.catch(() => undefined); await pending;
        probe.abort(); release(); await older.catch(() => undefined);
        expect(guards.every(guard => guard.isCurrent())).toBe(true);
      } else {
        await recover(lifetime.signal);
        // Independent live-control evidence does not borrow cold inventory's
        // publication lease. Released leases are already retired.
        expect(guards.every(guard => guard.isCurrent())).toBe(mode === "live-inactive");
      }
    }
    active = true;
    const fresh = await recover(lifetime.signal);
    expect(fresh[0]?.activity?.kind).toBe("working");
  } finally { release(); owner.abort(); probe.abort(); lifetime.abort(); await older?.catch(() => undefined); await pump; await provider.dispose!(); await fake.stop(); }
}, 10_000);

for (const read of ["listMessages", "reconcileBackgroundTasks"] as const)
for (const stage of ["cold", "outcome"] as const)
for (const scenario of ["within", "same-clock", "single", "exact-replay", "late-first", "new-interval"] as const)
test(`${read} rejects multiple start proofs inside admission (${scenario}/${stage})`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  let parent: string | undefined, child: string | undefined, finished = false, interrupts = 0;
  let wire!: ReadableStreamDefaultController<Uint8Array>, acknowledge: (() => void) | undefined;
  const frame = (type: string, data: unknown, created: number, id = `${type}:${created}`) => wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ id, type, data, created, location: { directory } })}\n\n`));
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route.endsWith("/interrupt")) interrupts++;
    if (route === "/api/event") return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      wire = controller; frame("server.connected", {}, 1); request.signal.addEventListener("abort", () => controller.close(), { once: true });
    } }), { headers: { "content-type": "text/event-stream" } });
    if (route.endsWith("/inbox")) return Response.json({ data: [] });
    if (route === "/api/session/active") return Response.json({ data: !finished && child ? { [child]: { status: "running" } } : {} });
    const response = await fetch(request);
    if (route === `/api/session/${parent}/message`) {
      const body = await response.json(), first = body.data[0]; first.time = { created: scenario === "new-interval" ? 30 : 10 };
      first.content[0].time = scenario === "new-interval" ? { created: 30, ran: 31, completed: 35 } : { created: 10, ran: 11, completed: 15 };
      return Response.json({ data: [first], cursor: {} });
    }
    if (route === `/api/session/${child}/message`) return Response.json({ data: [...(finished ? [{ id: "only-idle", type: "idle", time: { created: scenario === "new-interval" ? 40 : 20 }, outcome: "failed" }] : [])], cursor: {} });
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  let stream = new AbortController(), pump: Promise<void> | undefined;
  const owner = new AbortController();
  const connect = async () => { pump = (async () => { for await (const event of provider.events(stream.signal)) if (event.eventType === "diagnostic.admission-starts") { acknowledge?.(); acknowledge = undefined; } })(); await provider.waitForEventStream!(stream.signal); };
  try {
    await connect(); stream.abort(); await pump; stream = new AbortController();
    parent = (await provider.createSession("Distinct native starts within admission")).id; const worker = fake.launchRequestWorker(parent); child = worker.childId;
    await connect();
    if (scenario === "new-interval") { frame("session.execution.started", { sessionID: child }, 11, "prior-start"); frame("session.execution.succeeded", { sessionID: child }, 20); }
    const firstAt = scenario === "single" ? 13 : scenario === "late-first" ? 17 : scenario === "new-interval" ? 33 : 11;
    frame("session.execution.started", { sessionID: child }, firstAt, "start-A");
    if (scenario === "within" || scenario === "same-clock" || scenario === "exact-replay") frame("session.execution.started", { sessionID: child }, scenario === "within" ? 13 : firstAt, scenario === "exact-replay" ? "start-A" : "start-B");
    await new Promise<void>(resolve => { acknowledge = resolve; frame("diagnostic.admission-starts", {}, 50); });
    const denied = scenario === "within" || scenario === "same-clock";
    finished = stage === "outcome";
    const guards: import("../../provider").WorkerSourceGuard[] = [];
    const recovered = await provider.reconcileBackgroundTasks!(parent, { fresh: true, signal: owner.signal, onSource: source => guards.push(source.workerSource.retain(owner.signal)) });
    const page = read === "listMessages" ? await provider.listMessages(parent, { limit: 100, signal: owner.signal }) : undefined;
    const row = (page?.items ?? recovered).find((item): item is import("../../types").BackgroundTaskItem => item.type === "background_task" && item.taskId === worker.taskId);
    expect(row?.status).toBe(stage === "outcome" && !denied ? "failed" : "running");
    if (stage === "cold") expect(recovered.find(item => item.taskId === worker.taskId)?.activity?.kind).toBe(denied ? "unavailable" : "working");
    expect(guards.every(guard => guard.isCurrent())).toBe(true); if (page) expect(page.workerSource?.isCurrent()).toBe(true);
    expect(row?.resultId).toBeUndefined(); expect(row?.terminalReportedAt).toBeUndefined(); expect(workerCanStop(row!)).toBe(false);
    if (denied) { expect(workerExecutionClockRuns(row!)).toBe(false); expect(row?.activity?.endedAt).toBeUndefined(); }
    await expect(provider.stopTask!(parent, worker.taskId)).rejects.toMatchObject({ name: "BackgroundTaskUnavailableError" }); expect(interrupts).toBe(0);
  } finally { owner.abort(); stream.abort(); await pump; await provider.dispose!(); await fake.stop(); }
}, 10_000);

for (const read of ["listMessages", "reconcileBackgroundTasks"] as const)
for (const scenario of ["delayed-new-interval", "delayed-transcript-interval", "delayed-observed-interval", "delayed-third-start", "delayed-reuse", "aligned-new-interval", "later-outcome", "start-only", "third-start", "third-start-older-replay", "third-start-new-admission", "unique-after-start", "unique-late-after-start", "unique-terminal", "duplicate-idles", "earlier-boundary", "new-admission", "missing-clock", "undated-idle", "undated-end", "other-child", "foreign-workspace", "explicit-report", "explicit-after-undated"] as const)
for (const stage of scenario.startsWith("delayed-") || scenario === "aligned-new-interval" ? ["cold", "outcome"] as const : ["outcome"] as const)
test(`${read} keeps observed execution boundaries as outcome vetoes (${scenario}${stage === "cold" ? "/cold" : ""})`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  let parent: string | undefined, child: string | undefined, finished = false;
  const laterAdmission = scenario === "new-admission" || scenario === "third-start-new-admission";
  const intervalAdmission = scenario.startsWith("delayed-") || scenario === "aligned-new-interval";
  let wire!: ReadableStreamDefaultController<Uint8Array>;
  const barriers = new Map<string, () => void>();
  const frame = (type: string, data: unknown, created: number | undefined, location = directory) => wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ id: `${type}:${created}`, type, data, created, location: { directory: location } })}\n\n`));
  const barrier = (name: string) => new Promise<void>(resolve => { barriers.set(name, resolve); frame(name, {}, 50); });
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route === "/api/event") return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      wire = controller; frame("server.connected", {}, 1); request.signal.addEventListener("abort", () => controller.close(), { once: true });
    } }), { headers: { "content-type": "text/event-stream" } });
    if (route.endsWith("/inbox")) return Response.json({ data: [] });
    if (route === "/api/session/active") return Response.json({ data: !finished && child ? { [child]: { status: "running" } } : {} });
    const response = await fetch(request);
    if (route === `/api/session/${parent}/message`) {
      const body = await response.json(), first = body.data[0]; first.time = { created: intervalAdmission ? 30 : laterAdmission ? 34 : 10 };
      first.content[0].time = intervalAdmission ? { created: 30, ran: 31, completed: 32 } : laterAdmission ? { created: 34, ran: 35, completed: 36 }
        : scenario === "missing-clock" ? { created: 10 } : { created: 10, ran: 11, completed: 12 };
      return Response.json({ data: [first, ...(finished && (scenario === "explicit-report" || scenario === "explicit-after-undated") ? [{ id: "parent-result", type: "synthetic", time: { created: 45 },
        text: "Parent owns result", metadata: { source: "subagent", childID: child, state: "completed" } }] : [])], cursor: {} });
    }
    if (route === `/api/session/${child}/message`) return Response.json({ data: [
      ...(intervalAdmission && scenario !== "delayed-observed-interval" ? [{ id: "prior-idle", type: "idle", time: { created: 20 }, outcome: "succeeded" }] : []),
      { id: "new-prompt", type: "user", text: "Current execution", time: { created: 35 } },
      ...(finished ? [{ id: "new-idle", type: "idle", time: scenario === "undated-idle" ? {} : { created: 40 }, outcome: "failed" }] : []),
      ...(finished && scenario === "duplicate-idles" ? [{ id: "duplicate-idle", type: "idle", time: { created: 40 }, outcome: "succeeded" }] : []),
    ], cursor: {} });
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const firstAbort = new AbortController(), abort = new AbortController();
  let firstPump: Promise<void> | undefined, pump: Promise<void> | undefined;
  try {
    firstPump = (async () => { for await (const _event of provider.events(firstAbort.signal)) {} })();
    await provider.waitForEventStream!(firstAbort.signal); firstAbort.abort(); await firstPump;
    parent = (await provider.createSession("Retained negative execution intervals")).id;
    const worker = fake.launchRequestWorker(parent); child = worker.childId;
    const unrelated = (await provider.createSession("Other boundary owner")).id, otherChild = fake.launchRequestWorker(unrelated).childId;
    pump = (async () => { for await (const event of provider.events(abort.signal)) { barriers.get(event.eventType)?.(); barriers.delete(event.eventType); } })();
    await provider.waitForEventStream!(abort.signal);
    const subject = scenario === "other-child" ? otherChild : child, location = scenario === "foreign-workspace" ? `${directory}/foreign` : directory;
    frame("session.created", { sessionID: subject, parentID: subject === child ? parent : unrelated, location: { directory } }, scenario === "earlier-boundary" ? 3 : 11);
    frame("session.execution.started", { sessionID: child }, scenario === "unique-late-after-start" ? 20 : 11);
    if (scenario !== "unique-terminal" && scenario !== "unique-after-start" && scenario !== "unique-late-after-start" && scenario !== "duplicate-idles") {
      if (scenario !== "start-only" && scenario !== "delayed-transcript-interval" && !scenario.startsWith("third-start")) frame("session.execution.succeeded", { sessionID: subject }, scenario === "undated-end" || scenario === "explicit-after-undated" ? undefined : scenario === "earlier-boundary" ? 5 : 20, location);
      if (!intervalAdmission) frame("session.revert.committed", { sessionID: subject, to: "removed-idle" }, 30, location);
      if (scenario !== "undated-end") frame("session.execution.started", { sessionID: subject }, scenario === "earlier-boundary" ? 11 : scenario === "aligned-new-interval" ? 31 : 35, location);
      if (scenario === "delayed-reuse") frame("session.execution.started", { sessionID: subject }, 37, location);
    }
    await barrier("diagnostic.outcome-before-final-idle");
    const before = await provider.reconcileBackgroundTasks!(parent, { fresh: true, signal: abort.signal });
    expect(before.find(task => task.taskId === worker.taskId)?.status).toBe("running");
    if (stage === "cold") {
      const cold = before.find(task => task.taskId === worker.taskId);
      expect(cold?.activity?.kind).toBe(scenario === "delayed-reuse" ? "unavailable" : "working");
      expect(workerCanStop(cold!)).toBe(false); expect(cold?.resultId).toBeUndefined(); expect(cold?.terminalReportedAt).toBeUndefined(); return;
    }
    if (["later-outcome", "start-only", "missing-clock", "undated-idle", "undated-end", "explicit-report", "explicit-after-undated"].includes(scenario))
      expect(before.find(task => task.taskId === worker.taskId)?.activity?.kind).toBe("unavailable");
    finished = true; frame("session.execution.failed", { sessionID: child, error: { type: "unknown", message: "Later execution failed" } }, 40);
    await barrier("diagnostic.outcome-after-final-idle");
    if (scenario.startsWith("third-start") || scenario === "delayed-third-start" || scenario === "unique-after-start" || scenario === "unique-late-after-start") {
      const initial = await provider.reconcileBackgroundTasks!(parent, { fresh: true, signal: abort.signal });
      expect(initial.find(task => task.taskId === worker.taskId)?.status).toBe(scenario.startsWith("third-start") && !laterAdmission ? "running" : "failed");
      frame("session.execution.started", { sessionID: child }, 55);
      if (scenario === "third-start-older-replay") frame("session.execution.started", { sessionID: child }, 11);
      await barrier("diagnostic.outcome-after-third-start");
    }
    const rows = read === "listMessages" ? (await provider.listMessages(parent, { limit: 100, signal: abort.signal })).items
      : await provider.reconcileBackgroundTasks!(parent, { fresh: true, signal: abort.signal });
    const row = rows.find((item): item is import("../../types").BackgroundTaskItem => item.type === "background_task" && item.taskId === worker.taskId);
    const withheld = ["later-outcome", "start-only", "third-start", "third-start-older-replay", "delayed-reuse", "missing-clock", "undated-idle", "undated-end", "duplicate-idles"].includes(scenario);
    const reported = scenario === "explicit-report" || scenario === "explicit-after-undated";
    expect(row?.status).toBe(reported ? "completed" : withheld ? "running" : "failed");
    expect(workerCanStop(row!)).toBe(false);
    if (reported) expect(row).toMatchObject({ resultId: "parent-result", summary: "Parent owns result", terminalReportedAt: 45 });
    else { expect(row?.resultId).toBeUndefined(); expect(row?.terminalReportedAt).toBeUndefined(); }
    if (withheld) { expect(row?.activity?.endedAt).toBeUndefined(); expect(workerExecutionClockRuns(row!)).toBe(false); }
  } finally { firstAbort.abort(); abort.abort(); await firstPump; await pump; await provider.dispose!(); await fake.stop(); }
}, 10_000);

for (const change of ["within-admission", "same-clock-distinct", "first-delayed-new-interval", "inactive", "unchanged-active", "other-inactive", "distinct-start", "distinct-start-replay", "first-late-start", "exact-start-replay", "replay-storm", "text-noise", "other-child", "foreign-workspace"] as const)
test(`returned cold activity remains covered through scheduler admission (${change})`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  let parent: string | undefined, child: string | undefined, unrelatedChild: string | undefined, armed = false, parentHeldOnce = false, interrupts = 0, inactive = false, otherInactive = false;
  let wire!: ReadableStreamDefaultController<Uint8Array>, parentEntered!: () => void, releaseParent!: () => void,
    folded!: (tasks: import("../../types").BackgroundTaskItem[]) => void, interactionsEntered!: () => void, releaseInteractions!: () => void;
  const parentPending = new Promise<void>(resolve => { parentEntered = resolve; }), parentHeld = new Promise<void>(resolve => { releaseParent = resolve; });
  const returned = new Promise<import("../../types").BackgroundTaskItem[]>(resolve => { folded = resolve; });
  const interactions = new Promise<void>(resolve => { interactionsEntered = resolve; }), interactionsHeld = new Promise<void>(resolve => { releaseInteractions = resolve; });
  const barriers = new Map<string, () => void>();
  const frame = (type: string, data: unknown, created: number, location = directory, id = `${type}:${created}`) => wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ id, type, data, created, location: { directory: location } })}\n\n`));
  const barrier = (name: string) => new Promise<void>(resolve => { barriers.set(name, resolve); frame(name, {}, 40); });
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route.endsWith("/interrupt")) interrupts++;
    if (route === "/api/event") return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      wire = controller; frame("server.connected", {}, 1); request.signal.addEventListener("abort", () => controller.close(), { once: true });
    } }), { headers: { "content-type": "text/event-stream" } });
    if (route.endsWith("/inbox")) return Response.json({ data: [] });
    if (route === "/api/permission/request" || route === "/api/form") { interactionsEntered(); await interactionsHeld; }
    if (route === "/api/session/active") return Response.json({ data: {
      ...(child && !inactive ? { [child]: { status: "running" } } : {}),
      ...(unrelatedChild && !otherInactive ? { [unrelatedChild]: { status: "running" } } : {}),
    } });
    const response = await fetch(request);
    if (route === `/api/session/${parent}/message`) {
      const body = await response.json(), first = body.data[0]; first.time = { created: 10 };
      first.content[0].time = { created: 10, ran: 11, completed: 12 };
      if (change === "within-admission" || change === "same-clock-distinct") first.content[0].time.completed = 15;
      if (change === "first-delayed-new-interval") { first.time = { created: 30 }; first.content[0].time = { created: 30, ran: 31, completed: 32 }; }
      if (armed && !parentHeldOnce) { parentHeldOnce = true; parentEntered(); await parentHeld; }
      return Response.json({ data: [first], cursor: {} });
    }
    if (route === `/api/session/${child}/message`) return Response.json({ data: [{ id: "child-prompt", type: "user", text: "Execution prompt", time: { created: 10 } },
      ...(change === "first-delayed-new-interval" ? [{ id: "prior-idle", type: "idle", time: { created: 20 }, outcome: "succeeded" }] : [])], cursor: {} });
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const nativeEvents = provider.events.bind(provider), nativeRecovery = provider.reconcileBackgroundTasks!.bind(provider);
  provider.events = async function* (signal) { for await (const event of nativeEvents(signal)) {
    barriers.get(event.eventType)?.(); barriers.delete(event.eventType); yield event;
  } };
  const firstAbort = new AbortController(), abort = new AbortController(), guards: import("../../provider").WorkerSourceGuard[] = [];
  let capturedInitial = false;
  provider.reconcileBackgroundTasks = async (id, options) => {
    const observedGuards: import("../../provider").WorkerSourceGuard[] = [];
    const tasks = await nativeRecovery(id, { ...options, onSource: source => { options?.onSource?.(source); if (id === parent) observedGuards.push(source.workerSource.retain(abort.signal)); } });
    if (id === parent && !capturedInitial && tasks.some(task => task.activity?.generation === 2)) {
      capturedInitial = true; guards.push(...observedGuards); folded(tasks);
    }
    return tasks;
  };
  const adapter = new ChatAdapter({ provider, workspacePath: directory, coalesceWindowMs: 0 });
  let firstPump: Promise<void> | undefined, pump: Promise<void> | undefined, publication: Promise<import("../../types").BackgroundTaskItem> | undefined;
  try {
    firstPump = (async () => { for await (const _event of nativeEvents(firstAbort.signal)) {} })();
    await provider.waitForEventStream!(firstAbort.signal); firstAbort.abort(); await firstPump;
    parent = (await provider.createSession("Returned activity start counterproof")).id;
    const worker = fake.launchRequestWorker(parent); child = worker.childId;
    const unrelated = (await provider.createSession("Other execution owner")).id; unrelatedChild = fake.launchRequestWorker(unrelated).childId;
    const subscription = await adapter.subscribe(parent, { signal: abort.signal });
    publication = (async () => { for await (const event of subscription.events) if (event.type === "item.upsert" && event.item.type === "background_task" && event.item.taskId === worker.taskId) return event.item;
      throw new Error("Scheduler ended before worker admission"); })(); void publication.catch(() => undefined);
    armed = true; pump = adapter.startEventPump(); await provider.waitForEventStream!(abort.signal); await parentPending;
    frame("session.created", { sessionID: child, parentID: parent, location: { directory } }, 11);
    if (change !== "first-late-start") frame("session.execution.started", { sessionID: child }, 11);
    if (change === "other-child") frame("session.created", { sessionID: unrelatedChild, parentID: unrelated, location: { directory } }, 11);
    await barrier("diagnostic.initial-cold-start"); releaseParent();
    const initial = await returned; await interactions;
    expect(initial.find(task => task.taskId === worker.taskId)).toMatchObject({ status: "running", activity: { kind: "working", generation: 2 }, control: { available: false } });
    expect(guards.length).toBeGreaterThan(0); expect(guards.every(guard => guard.isCurrent())).toBe(true);
    if (change === "inactive") inactive = true;
    else if (change === "other-inactive") otherInactive = true;
    else if (change === "unchanged-active") { /* Native inventory is unchanged. */ }
    else if (change === "replay-storm") for (let replay = 0; replay < 300; replay++) frame("session.execution.started", { sessionID: child }, 11);
    else if (change === "text-noise") frame("session.message.content.updated", { sessionID: child, messageID: "later-output", content: [{ type: "text", text: "More output" }] }, 35);
    else if (change === "within-admission" || change === "same-clock-distinct") frame("session.execution.started", { sessionID: child }, change === "within-admission" ? 13 : 11, directory, "another-start-proof");
    else frame("session.execution.started", { sessionID: change === "other-child" ? unrelatedChild : child }, change === "exact-start-replay" ? 11 : 35,
      change === "foreign-workspace" ? `${directory}/foreign` : directory);
    if (change === "distinct-start-replay") frame("session.execution.started", { sessionID: child }, 11);
    await barrier("diagnostic.returned-cold-start");
    const current = await nativeRecovery(parent, { fresh: true, signal: abort.signal }), denied = change === "inactive" || change === "distinct-start" || change === "distinct-start-replay" || change === "within-admission" || change === "same-clock-distinct";
    expect(current.find(task => task.taskId === worker.taskId)?.activity?.kind).toBe(denied ? "unavailable" : "working");
    if (!denied) expect(guards.every(guard => guard.isCurrent())).toBe(true);
    releaseInteractions(); const published = await publication;
    expect(published.activity?.kind).toBe(denied ? "unavailable" : "working");
    expect(workerExecutionClockRuns(published)).toBe(!denied);
    expect(workerDismissalEvidence(published)?.dismissible).toBe(denied);
    expect(published.status).toBe("running"); expect(published.activity?.endedAt).toBeUndefined();
    expect(published.resultId).toBeUndefined(); expect(published.terminalReportedAt).toBeUndefined();
    expect(workerCanStop(published)).toBe(false);
    if (denied) expect(guards.some(guard => !guard.isCurrent())).toBe(true);
    await expect(provider.stopTask!(parent, worker.taskId)).rejects.toMatchObject({ name: "BackgroundTaskUnavailableError" }); expect(interrupts).toBe(0);
  } finally { releaseParent(); releaseInteractions(); firstAbort.abort(); abort.abort(); await adapter.dispose(); await firstPump; await pump; await publication?.catch(() => undefined); await fake.stop(); }
}, 10_000);

for (const change of ["distinct-start", "first-late-start", "exact-start-replay"] as const)
test(`pending cold activity rechecks execution starts before return (${change})`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  let parent: string | undefined, child: string | undefined, captured = false, heldOnce = false;
  let wire!: ReadableStreamDefaultController<Uint8Array>, entered!: () => void, release!: () => void;
  const pending = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  const barriers = new Map<string, () => void>();
  const frame = (type: string, data: unknown, created: number) => wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ id: `${type}:${created}`, type, data, created, location: { directory } })}\n\n`));
  const barrier = (name: string) => new Promise<void>(resolve => { barriers.set(name, resolve); frame(name, {}, 40); });
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route === "/api/event") return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      wire = controller; frame("server.connected", {}, 1); request.signal.addEventListener("abort", () => controller.close(), { once: true });
    } }), { headers: { "content-type": "text/event-stream" } });
    if (route.endsWith("/inbox")) return Response.json({ data: [] });
    if (route === "/api/session/active") return Response.json({ data: child ? { [child]: { status: "running" } } : {} });
    const response = await fetch(request);
    if (route === `/api/session/${parent}/message`) {
      const body = await response.json(), first = body.data[0]; first.time = { created: 10 };
      first.content[0].time = { created: 10, ran: 11, completed: 12 }; return Response.json({ data: [first], cursor: {} });
    }
    if (route === `/api/session/${child}/message`) return Response.json({ data: [], cursor: {} });
    if (route === `/api/session/${parent}` && captured && !heldOnce) { heldOnce = true; entered(); await held; }
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const firstAbort = new AbortController(), abort = new AbortController(), guards: import("../../provider").WorkerSourceGuard[] = [];
  let firstPump: Promise<void> | undefined, pump: Promise<void> | undefined, recovery: ReturnType<NonNullable<typeof provider.reconcileBackgroundTasks>> | undefined;
  try {
    firstPump = (async () => { for await (const _event of provider.events(firstAbort.signal)) {} })();
    await provider.waitForEventStream!(firstAbort.signal); firstAbort.abort(); await firstPump;
    parent = (await provider.createSession("Pending cold activity admission")).id;
    const worker = fake.launchRequestWorker(parent); child = worker.childId;
    pump = (async () => { for await (const event of provider.events(abort.signal)) { barriers.get(event.eventType)?.(); barriers.delete(event.eventType); } })();
    await provider.waitForEventStream!(abort.signal);
    frame("session.created", { sessionID: child, parentID: parent, location: { directory } }, 11);
    if (change !== "first-late-start") frame("session.execution.started", { sessionID: child }, 11);
    await barrier("diagnostic.pending-initial-start");
    recovery = provider.reconcileBackgroundTasks!(parent, { fresh: true, signal: abort.signal, onSource: source => {
      guards.push(source.workerSource.retain(abort.signal)); captured = true;
    } }); void recovery.catch(() => undefined); await pending;
    frame("session.execution.started", { sessionID: child }, change === "exact-start-replay" ? 11 : 35);
    await barrier("diagnostic.pending-next-start");
    expect(guards.length).toBeGreaterThan(0); expect(guards.every(guard => guard.isCurrent())).toBe(true);
    release(); const [row] = await recovery, denied = change === "distinct-start";
    expect(row?.activity?.kind).toBe(denied ? "unavailable" : "working");
    expect(workerExecutionClockRuns(row!)).toBe(!denied);
    expect(workerDismissalEvidence(row)?.dismissible).toBe(denied);
    expect(row?.activity?.endedAt).toBeUndefined(); expect(row?.terminalReportedAt).toBeUndefined();
    expect(workerCanStop(row!)).toBe(false);
    expect(guards.every(guard => guard.isCurrent())).toBe(true); // Pending control reads are not blanket-invalidated.
    const [reused] = await provider.reconcileBackgroundTasks!(parent, { signal: abort.signal });
    expect(reused?.activity?.kind).toBe(denied ? "unavailable" : "working");
  } finally { release(); firstAbort.abort(); abort.abort(); await recovery?.catch(() => undefined); await firstPump; await pump; await provider.dispose!(); await fake.stop(); }
}, 10_000);

for (const boundary of ["requested-tie", "accepted-tie", "requested-unrelated", "requested-earlier", "requested-replay", "reported-other", "succeed-revert-start", "history-only-child", "history-only-terminal", "terminal-only", "no-boundary", "initial-start", "initial-late-start", "initial-start-replay", "newer-start-only", "older-start-replay", "first-late-start-replay", "pre-admission-starts", "earlier-boundary", "other-child", "foreign-workspace"] as const)
test(`cold generation-2 activity respects processed execution boundaries (${boundary})`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  let parent: string | undefined, child: string | undefined, interrupts = 0;
  const invocation = boundary.startsWith("requested-") || boundary === "accepted-tie" || boundary === "reported-other";
  const childReads: string[] = [];
  let wire!: ReadableStreamDefaultController<Uint8Array>, applied!: () => void;
  let observed = new Promise<void>(resolve => { applied = resolve; });
  const frame = (type: string, data: unknown, created: number, location = directory) => wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ id: `${type}:${created}`, type, data, created, location: { directory: location } })}\n\n`));
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route.endsWith("/interrupt")) interrupts++;
    if (route.startsWith("/api/session/") && !route.endsWith("/inbox")) childReads.push(route);
    if (route === "/api/event") return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      wire = controller; frame("server.connected", {}, 1); request.signal.addEventListener("abort", () => controller.close(), { once: true });
    } }), { headers: { "content-type": "text/event-stream" } });
    if (route.endsWith("/inbox")) return Response.json({ data: [] });
    if (route === "/api/session/active") return Response.json({ data: child ? { [child]: { status: "running" } } : {} });
    const response = await fetch(request);
    if (route === `/api/session/${parent}/message`) {
      const body = await response.json(), first = body.data[0]; first.time = { created: 10 };
      first.content[0].time = { created: 10, ran: 11, completed: 12 };
      const competitor = structuredClone(first); competitor.id = "unclassified-message"; competitor.content[0].id = "unclassified-call";
      competitor.content[0].state.input = { sessionID: boundary === "requested-unrelated" ? "unrelated-request" : child, prompt: "Another invocation" };
      if (boundary !== "accepted-tie" && boundary !== "reported-other") { competitor.content[0].state.status = "running"; competitor.content[0].state.metadata = {}; }
      if (boundary === "reported-other") competitor.content[0].state.metadata.sessionID = "reported-other-child";
      if (boundary === "requested-earlier") competitor.content[0].time = { created: 0, ran: 1, completed: 2 };
      return Response.json({ data: [first, ...(invocation ? [boundary === "requested-replay" ? structuredClone(first) : competitor] : [])], cursor: {} });
    }
    if (route === `/api/session/${child}/message`) return Response.json({ data: [...(boundary === "requested-earlier" ? [{ id: "prior-end", type: "idle", time: { created: 5 } }] : []), { id: "new-prompt", type: "user", text: "Current child prompt", time: { created: 35 } }], cursor: {} });
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const firstAbort = new AbortController(), abort = new AbortController();
  let firstPump: Promise<void> | undefined, pump: Promise<void> | undefined;
  try {
    firstPump = (async () => { for await (const _event of provider.events(firstAbort.signal)) {} })();
    await provider.waitForEventStream!(firstAbort.signal); firstAbort.abort(); await firstPump;
    parent = (await provider.createSession("Cold boundary attribution")).id;
    const worker = fake.launchRequestWorker(parent); child = worker.childId;
    const unrelated = (await provider.createSession("Unrelated boundary owner")).id;
    const unrelatedChild = fake.launchRequestWorker(unrelated).childId;
    pump = (async () => { for await (const event of provider.events(abort.signal)) if (event.eventType === "diagnostic.cold-boundaries-applied") applied(); })();
    await provider.waitForEventStream!(abort.signal);
    const subject = boundary === "other-child" ? unrelatedChild : child;
    const location = boundary === "foreign-workspace" ? `${directory}/foreign` : directory;
    // Ownership/birth is observed, but no launcher is streamed or recovered
    // until after all native execution counterproof has been processed.
    if (!invocation && boundary !== "history-only-child" && boundary !== "history-only-terminal")
      frame("session.created", { sessionID: subject, parentID: subject === child ? parent : unrelated, location: { directory } }, boundary === "earlier-boundary" || boundary === "pre-admission-starts" ? 3 : 11);
    if (boundary === "initial-start" || boundary === "initial-late-start" || boundary === "initial-start-replay" || boundary === "first-late-start-replay") {
      const start = boundary === "initial-late-start" || boundary === "first-late-start-replay" ? 20 : 11;
      frame("session.execution.started", { sessionID: child }, start);
      if (boundary === "initial-start-replay" || boundary === "first-late-start-replay") frame("session.execution.started", { sessionID: child }, start);
    }
    else if (boundary === "newer-start-only" || boundary === "older-start-replay") {
      frame("session.execution.started", { sessionID: child }, 11);
      frame("session.execution.started", { sessionID: child }, 35);
      if (boundary === "older-start-replay") {
        frame("diagnostic.cold-boundaries-applied", {}, 40); await observed;
        const [beforeReplay] = await provider.reconcileBackgroundTasks!(parent, { fresh: true, signal: abort.signal });
        expect(beforeReplay?.activity?.kind).toBe("unavailable");
        observed = new Promise<void>(resolve => { applied = resolve; });
        frame("session.execution.started", { sessionID: child }, 11);
      }
    }
    else if (boundary === "pre-admission-starts") {
      frame("session.execution.started", { sessionID: child }, 4);
      frame("session.execution.started", { sessionID: child }, 11);
    }
    else if (boundary === "history-only-child" || boundary === "history-only-terminal") {
      frame("session.execution.succeeded", { sessionID: child }, 20);
      frame("session.revert.committed", { sessionID: child, to: "old-idle" }, 30);
      if (boundary === "history-only-child") frame("session.execution.started", { sessionID: child }, 35);
    }
    else if (!invocation && boundary !== "no-boundary") {
      frame("session.execution.started", { sessionID: subject }, boundary === "earlier-boundary" ? 4 : 11, location);
      frame("session.execution.succeeded", { sessionID: subject }, boundary === "earlier-boundary" ? 5 : 20, location);
      frame("session.revert.committed", { sessionID: subject, to: "old-idle" }, 30, location);
      if (boundary !== "terminal-only") frame("session.execution.started", { sessionID: subject }, boundary === "earlier-boundary" ? 11 : 35, location);
    }
    frame("diagnostic.cold-boundaries-applied", {}, 40); await observed;
    const rows = await provider.reconcileBackgroundTasks!(parent, { fresh: true, signal: abort.signal });
    const row = rows.find(item => item.taskId === worker.taskId);
    const denied = boundary === "succeed-revert-start" || boundary === "history-only-child" || boundary === "history-only-terminal" || boundary === "terminal-only" || boundary === "newer-start-only" || boundary === "older-start-replay";
    expect(row).toBeDefined();
    expect(row?.status).toBe("running");
    const competing = boundary === "requested-tie" || boundary === "accepted-tie";
    expect(row?.activity?.kind).toBe(denied ? "unavailable" : competing ? "session-active" : "working");
    expect(workerExecutionClockRuns(row!)).toBe(!denied && !competing);
    if (invocation && boundary !== "accepted-tie" && boundary !== "reported-other") expect(rows).toHaveLength(1);
    expect(childReads.some(route => route.includes("unrelated-request"))).toBe(false);
    expect(workerDismissalEvidence(row)?.dismissible).toBe(denied);
    expect(row?.activity?.endedAt).toBeUndefined();
    expect(row?.resultId).toBeUndefined(); expect(row?.summary).toBeUndefined(); expect(row?.terminalReportedAt).toBeUndefined();
    expect(workerCanStop(row!)).toBe(false); expect(row?.control?.available).toBe(false);
    if (denied) expect(row?.activity?.launchRef).toBeUndefined();
    await expect(provider.stopTask!(parent, worker.taskId)).rejects.toMatchObject({ name: "BackgroundTaskUnavailableError" });
    expect(interrupts).toBe(0);
  } finally { firstAbort.abort(); abort.abort(); await firstPump; await pump; await provider.dispose!(); await fake.stop(); }
}, 10_000);

for (const scenario of ["end-revert-start", "start-reuse", "unknown-end", "unknown-start", "unrelated", "no-negative", "late-first", "new-admission", "old-replay"] as const)
test(`negative execution evidence survives generation 2 to 3 (${scenario})`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  let parent: string | undefined, child: string | undefined, interrupts = 0, subscriptions = 0;
  let wire!: ReadableStreamDefaultController<Uint8Array>, acknowledge: (() => void) | undefined;
  const frame = (type: string, data: unknown, created?: number) => wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ id: `${type}:${created}`, type, data, ...(created === undefined ? {} : { created }), location: { directory } })}\n\n`));
  const barrier = () => new Promise<void>(resolve => { acknowledge = resolve; frame("diagnostic.counterproof-reconnect", {}, 100); });
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route.endsWith("/interrupt")) interrupts++;
    if (route === "/api/event") return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      wire = controller; subscriptions++; frame("server.connected", {}, subscriptions); request.signal.addEventListener("abort", () => controller.close(), { once: true });
    } }), { headers: { "content-type": "text/event-stream" } });
    if (route.endsWith("/inbox")) return Response.json({ data: [] });
    if (route === "/api/session/active") return Response.json({ data: child ? { [child]: { status: "running" } } : {} });
    const response = await fetch(request);
    if (route === `/api/session/${parent}/message`) {
      const body = await response.json(), first = body.data[0]; first.time = { created: scenario === "new-admission" ? 30 : 10 };
      first.content[0].time = scenario === "new-admission" ? { created: 30, ran: 31, completed: 32 } : { created: 10, ran: 11, completed: 12 };
      return Response.json({ data: [first], cursor: {} });
    }
    if (route === `/api/session/${child}/message`) return Response.json({ data: [{ id: "current-prompt", type: "user", text: "Unchanged child transcript", time: { created: 35 } }], cursor: {} });
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const owner = new AbortController();
  let stream = new AbortController(), pump: Promise<void> | undefined;
  const connect = async () => { pump = (async () => { for await (const event of provider.events(stream.signal)) if (event.eventType === "diagnostic.counterproof-reconnect") { const done = acknowledge; acknowledge = undefined; done?.(); } })(); await provider.waitForEventStream!(stream.signal); };
  try {
    await connect(); stream.abort(); await pump;
    parent = (await provider.createSession("Negative continuity without live launchers")).id; const worker = fake.launchRequestWorker(parent); child = worker.childId;
    stream = new AbortController(); await connect();
    const subject = scenario === "unrelated" ? "unrelated-child" : child;
    if (scenario !== "no-negative" && scenario !== "late-first") {
      frame("session.execution.started", { sessionID: subject }, 11);
      if (scenario !== "start-reuse" && scenario !== "unknown-start") {
        frame("session.execution.succeeded", { sessionID: subject }, scenario === "unknown-end" ? undefined : 20);
        frame("session.revert.committed", { sessionID: subject, to: "removed-idle" }, 30);
      }
      frame("session.execution.started", { sessionID: subject }, scenario === "unknown-start" ? undefined : 35);
    } else if (scenario === "late-first") frame("session.execution.started", { sessionID: child }, 20);
    await barrier();
    const denied = ["end-revert-start", "start-reuse", "unknown-end", "unknown-start", "old-replay"].includes(scenario);
    const assertCurrent = async () => {
      const [row] = await provider.reconcileBackgroundTasks!(parent!, { fresh: true, signal: owner.signal });
      expect(row?.activity?.kind).toBe(denied ? "unavailable" : "working");
      expect(workerExecutionClockRuns(row!)).toBe(!denied); expect(workerDismissalEvidence(row)?.dismissible).toBe(denied);
      expect(row?.resultId).toBeUndefined(); expect(row?.terminalReportedAt).toBeUndefined(); expect(row?.activity?.endedAt).toBeUndefined();
      expect(workerCanStop(row!)).toBe(false); expect(row?.control?.available).toBe(false);
      const page = await provider.listMessages(parent!, { limit: 100, signal: owner.signal });
      expect(page.workerSource?.isCurrent()).toBe(true); expect(page.items).toContainEqual(expect.objectContaining({ taskId: worker.taskId, status: "running" }));
      await expect(provider.stopTask!(parent!, worker.taskId)).rejects.toMatchObject({ name: "BackgroundTaskUnavailableError" }); expect(interrupts).toBe(0);
    };
    await assertCurrent(); stream.abort(); await pump;
    await assertCurrent(); // The disconnected gap must not erase the veto either.
    stream = new AbortController(); await connect();
    if (scenario === "old-replay") { frame("session.execution.started", { sessionID: child }, 11); await barrier(); }
    expect(subscriptions).toBe(3); await assertCurrent();
  } finally { owner.abort(); stream.abort(); await pump; await provider.dispose!(); await fake.stop(); }
}, 10_000);

for (const change of ["hidden", "unchanged", "other-parent", "retained-prefix", "append", "stale-response"] as const)
test(`scheduler inferred outcome retains native parent visibility through publication (${change})`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  let parent: string | undefined, child: string | undefined, other: string | undefined, staged = false, appended = false, captured = false;
  let interactionsEntered!: () => void, releaseInteractions!: () => void, folded!: () => void, finished!: () => void, olderEntered!: () => void, releaseOlder!: () => void;
  const interactions = new Promise<void>(resolve => { interactionsEntered = resolve; }), interactionsHeld = new Promise<void>(resolve => { releaseInteractions = resolve; });
  const returned = new Promise<void>(resolve => { folded = resolve; }), admitted = new Promise<void>(resolve => { finished = resolve; });
  const olderPending = new Promise<void>(resolve => { olderEntered = resolve; }), olderHeld = new Promise<void>(resolve => { releaseOlder = resolve; });
  const olderRead = new AsyncLocalStorage<boolean>();
  let launcher: any;
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route.endsWith("/inbox")) return Response.json({ data: [] });
    if (route === "/api/permission/request" || route === "/api/form") { interactionsEntered(); await interactionsHeld; }
    const response = await fetch(request);
    if (route === `/api/session/${parent}/message`) {
      const body = await response.json(), first = body.data[0]; first.time = { created: 10 }; first.content[0].time = { created: 10, ran: 11, completed: 12 }; launcher = first;
      return Response.json({ data: [first, { id: "hidden-parent", type: "user", text: "Retained prefix boundary", time: { created: 30 } },
        ...(appended ? [{ id: "ordinary-output", type: "assistant", time: { created: 50 }, content: [{ type: "text", text: "Independent output" }] }] : [])], cursor: {} });
    }
    if (route === `/api/session/${child}/message`) return Response.json({ data: [{ id: "idle", type: "idle", time: { created: 20 }, outcome: "succeeded" }], cursor: {} });
    if (route === `/api/session/${parent}` || route === `/api/session/${other}`) {
      const body = await response.json();
      if (olderRead.getStore() || staged && (change === "other-parent" ? route.endsWith(other!) : route.endsWith(parent!))) body.data.revert = { messageID: change === "retained-prefix" ? "hidden-parent" : launcher?.id };
      if (olderRead.getStore()) { olderEntered(); await olderHeld; }
      return Response.json(body);
    }
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const nativeRecovery = provider.reconcileBackgroundTasks!.bind(provider), abort = new AbortController();
  const guards: import("../../provider").WorkerSourceGuard[] = [];
  provider.reconcileBackgroundTasks = async (id, options) => {
    const tasks = await nativeRecovery(id, { ...options, onSource: source => {
      if (id === parent) guards.push(source.workerSource.retain(abort.signal));
      options?.onSource?.({ ...source, workerSource: { ...source.workerSource, retain: signal => {
        if (id === parent) { if (signal.aborted) finished(); else signal.addEventListener("abort", () => finished(), { once: true }); }
        return source.workerSource.retain(signal);
      } } });
    } });
    if (id === parent && !captured) { captured = true; expect(tasks).toContainEqual(expect.objectContaining({ status: "completed" })); folded(); }
    return tasks;
  };
  const adapter = new ChatAdapter({ provider, workspacePath: directory, coalesceWindowMs: 0 });
  let older: ReturnType<typeof provider.getSession> | undefined;
  try {
    parent = (await provider.createSession("Parent visibility during scheduler handoff")).id; const worker = fake.launchRequestWorker(parent); child = worker.childId;
    other = (await provider.createSession("Other visibility owner")).id;
    if (change === "stale-response") {
      // Populate only a launcher identity for the stale native record payload,
      // not a source guard or an inferred worker on the adapter projection.
      await provider.listMessages(parent, { limit: 100, signal: abort.signal });
      older = olderRead.run(true, () => provider.getSession(parent!)); void older.catch(() => undefined); await olderPending;
    }
    await adapter.subscribe(parent, { signal: abort.signal }); void adapter.startEventPump().catch(() => undefined);
    await returned; await interactions; expect(guards.every(guard => guard.isCurrent())).toBe(true);
    if (change === "stale-response") { releaseOlder(); await older; }
    staged = change === "hidden" || change === "retained-prefix" || change === "other-parent";
    appended = change === "append";
    await provider.getReversibleHistoryState!(change === "other-parent" ? other : parent);
    const fresh = await nativeRecovery(parent, { fresh: true, signal: abort.signal });
    if (change === "hidden") expect(fresh).toEqual([]);
    else expect(fresh).toContainEqual(expect.objectContaining({ taskId: worker.taskId, status: "completed" }));
    releaseInteractions(); await admitted;
    const row = adapter.projectionForTests(parent).items().find(item => item.type === "background_task" && item.taskId === worker.taskId);
    if (change === "hidden") expect(row).toBeUndefined(); else expect(row).toMatchObject({ status: "completed" });
    expect(guards.every(guard => guard.isCurrent())).toBe(change !== "hidden");
  } finally { releaseOlder(); releaseInteractions(); abort.abort(); await older?.catch(() => undefined); await adapter.dispose(); await fake.stop(); }
}, 10_000);

for (const read of ["history", "automatic-recovery"] as const)
for (const proof of ["session-active", "session-active-changed", "session-active-report", "same-execution", "parent-report", "changed-identity", "smaller-alias", "smaller-alias-unavailable"] as const)
test(`${read} resumes active work after withdrawing an inferred outcome (${proof})`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  let parent: string | undefined, child: string | undefined, resumed = false, armed = false;
  let aliasAttempt = 0;
  const aliasChange = proof === "smaller-alias" || proof === "smaller-alias-unavailable";
  const sessionActive = proof.startsWith("session-active"), explicitReport = proof === "parent-report" || proof === "session-active-report";
  let wire!: ReadableStreamDefaultController<Uint8Array>, finished!: () => void;
  const published = new Promise<void>(resolve => { finished = resolve; });
  const frame = (type: string, data: unknown) => wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type, data, created: 50, location: { directory } })}\n\n`));
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route === "/api/event") return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      wire = controller; frame("server.connected", {}); request.signal.addEventListener("abort", () => controller.close(), { once: true });
    } }), { headers: { "content-type": "text/event-stream" } });
    if (route === "/api/session/active") return Response.json({ data: resumed && proof !== "smaller-alias-unavailable" && child ? { [child]: { status: "running" } } : {} });
    if (route.endsWith("/inbox")) return Response.json({ data: [] });
    const response = await fetch(request);
    if (route === `/api/session/${parent}/message`) {
      const body = await response.json(), first = body.data[0], changed = resumed && (proof === "changed-identity" || proof === "session-active-changed");
      first.time = { created: changed ? 30 : 10 }; first.content[0].time = changed ? { created: 30, ran: 31, completed: 32 } : { created: 10, ran: 11, completed: 12 };
      const alias = structuredClone(first); alias.id = "proven-alias-message"; alias.content[0].id = `proven-alias-call-${aliasAttempt}`;
      alias.time = { created: 13 }; alias.content[0].time = { created: 13, ran: 14, completed: 15 };
      const competitor = structuredClone(first); competitor.id = "competing-message"; competitor.content[0].id = "competing-call";
      competitor.content[0].state = { status: "running", input: { sessionID: child, prompt: "Competing invocation" }, metadata: {} };
      return Response.json({ data: [first, ...(resumed && sessionActive ? [competitor] : []), ...(resumed && aliasChange ? [alias] : []), ...(explicitReport ? [{ id: "parent-result", type: "synthetic", time: { created: 25 }, text: "Explicit parent report", metadata: { source: "subagent", childID: child, state: "completed" } }] : [])], cursor: {} });
    }
    if (route === `/api/session/${child}/message`) return Response.json({ data: resumed ? [] : [
      { id: "reverted-child-input", type: "user", text: "Committed reverted suffix", time: { created: 15 } },
      { id: "reverted-child-idle", type: "idle", time: { created: 20 }, outcome: "succeeded" },
    ], cursor: {} });
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const nativeRecovery = provider.reconcileBackgroundTasks!.bind(provider);
  provider.reconcileBackgroundTasks = (id, options) => nativeRecovery(id, options?.onSource ? { ...options, onSource: source => options.onSource!({ ...source, workerSource: {
    isCurrent: source.workerSource.isCurrent,
    retain: signal => {
      if (armed) { if (signal.aborted) finished(); else signal.addEventListener("abort", () => finished(), { once: true }); }
      return source.workerSource.retain(signal);
    },
  } }) } : options);
  const adapter = new ChatAdapter({ provider, workspacePath: directory, coalesceWindowMs: 0 }), abort = new AbortController();
  try {
    parent = (await provider.createSession("Resumed history-only outcome")).id;
    const worker = fake.launchRequestWorker(parent); child = worker.childId;
    const warm = (await adapter.history(parent)).items.find(item => item.type === "background_task" && item.taskId === worker.taskId);
    expect(warm).toMatchObject({ type: "background_task", status: "completed", activity: { kind: "ended" } });
    // Model the persisted result of a committed child revert: its input/idle
    // suffix is gone, no staged boundary remains, and native inventory resumes
    // the same execution. No provider activity or adapter row is fabricated.
    resumed = true;
    let fresh = await nativeRecovery(parent, { fresh: true, signal: abort.signal });
    const original = warm?.type === "background_task" ? warm.activity?.executionId : undefined;
    if (aliasChange) {
      while (aliasAttempt < 64 && fresh[0]?.activity?.executionId === original) {
        aliasAttempt++;
        fresh = await nativeRecovery(parent, { fresh: true, signal: abort.signal });
      }
      expect(fresh[0]?.activity?.executionId! < original!).toBe(true);
      expect(fresh[0]?.activity?.executionAliases).toContain(original);
    }
    expect(fresh[0]).toMatchObject({ status: explicitReport ? "completed" : "running", activity: { kind: explicitReport ? "ended" : sessionActive ? "session-active" : proof === "smaller-alias-unavailable" ? "unavailable" : "working" } });
    expect(fresh[0]?.activity?.executionId === original).toBe(proof !== "changed-identity" && proof !== "session-active-changed" && !aliasChange);
    if (proof === "same-execution") expect(fresh[0]?.control?.available).toBe(false);
    armed = true;
    let items: import("../../types").ConversationItem[];
    if (read === "history") items = (await adapter.history(parent)).items;
    else {
      frame("session.message.content.updated", { sessionID: parent, messageID: "ordinary-parent-output", content: [{ type: "text", text: "Resume progress" }] });
      await published;
      items = (await adapter.subscribe(parent, { signal: abort.signal })).snapshot.items;
    }
    const current = items.find((item): item is import("../../types").BackgroundTaskItem => item.type === "background_task" && item.taskId === worker.taskId);
    expect(current?.status).toBe(proof === "same-execution" || proof === "session-active" || aliasChange ? "running" : "completed");
    expect(workerExecutionClockRuns(current!)).toBe(proof === "same-execution" || proof === "smaller-alias");
    if (aliasChange) { expect(current?.activity?.executionAliases).toContain(original); expect(workerCanStop(current!)).toBe(false); }
    if (proof === "same-execution") { expect(current?.activity?.kind).toBe("working"); expect(adapter.activity().working).toBe(true); }
    if (explicitReport) expect(current).toMatchObject({ resultId: "parent-result", summary: "Explicit parent report" });
    if (proof === "session-active") {
      expect(current?.activity?.kind).toBe("session-active"); expect(workerDismissalEvidence(current)?.dismissible).toBe(false);
      expect(workerCanStop(current!)).toBe(false); expect(current?.resultId).toBeUndefined(); expect(current?.terminalReportedAt).toBeUndefined();
    }
  } finally { armed = false; abort.abort(); await adapter.dispose(); await fake.stop(); }
}, 10_000);

for (const boundary of ["ownership", "initial-parent"] as const)
for (const change of ["competing", "unchanged", "ordinary-output", "unrelated-parent", ...(boundary === "initial-parent" ? ["included-launch" as const] : [])] as const)
test(`parent counterproof survives the ${boundary === "ownership" ? "first ownership" : "initial parent history"} await (${change})`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  let parent: string | undefined, child: string | undefined, changed = false, lookups = 0, first: any, competitor: any;
  let wire!: ReadableStreamDefaultController<Uint8Array>, entered!: () => void, release!: () => void, applied!: () => void;
  const ownershipPending = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const observed = new Promise<void>(resolve => { applied = resolve; });
  const frame = (type: string, data: unknown) => wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type, data, created: 30, location: { directory } })}\n\n`));
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route === "/api/event") return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      wire = controller; frame("server.connected", {}); request.signal.addEventListener("abort", () => controller.close(), { once: true });
    } }), { headers: { "content-type": "text/event-stream" } });
    if (route.endsWith("/inbox")) return Response.json({ data: [] });
    const response = await fetch(request);
    if (route === `/api/session/${parent}/message`) {
      const body = await response.json(); first = body.data[0]; first.time = { created: 10 };
      first.content[0].time = { created: 10, ran: 11, completed: 12 };
      competitor = structuredClone(first); competitor.id = "ownership-race-message"; competitor.time = { created: 15 };
      competitor.content[0].id = "ownership-race-call"; competitor.content[0].time = { created: 15, ran: 16, completed: 25 };
      const data = [first, ...(changed || change === "included-launch" ? [competitor] : [])];
      if (boundary === "initial-parent" && ++lookups === 1) { entered(); await held; }
      return Response.json({ data, cursor: {} });
    }
    if (boundary === "ownership" && route === `/api/session/${child}` && ++lookups === 1) { entered(); await held; }
    if (route === `/api/session/${child}/message`) return Response.json({ data: [{ id: "child-outcome", type: "idle", time: { created: 20 }, outcome: "succeeded" }], cursor: {} });
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const abort = new AbortController(), firstAbort = new AbortController();
  const guards: import("../../provider").WorkerSourceGuard[] = [];
  let firstPump: Promise<void> | undefined, pump: Promise<void> | undefined, recovery: ReturnType<NonNullable<typeof provider.reconcileBackgroundTasks>> | undefined;
  try {
    firstPump = (async () => { for await (const _event of provider.events(firstAbort.signal)) {} })();
    await provider.waitForEventStream!(firstAbort.signal); firstAbort.abort(); await firstPump;
    parent = (await provider.createSession("Pre-ownership parent counterproof")).id;
    const worker = fake.launchRequestWorker(parent); child = worker.childId; fake.settleWorker(child, "completed", "No parent report");
    const unrelated = (await provider.createSession("Independent parent")).id;
    const unrelatedWorker = fake.launchRequestWorker(unrelated);
    pump = (async () => { for await (const event of provider.events(abort.signal)) if (event.eventType === "diagnostic.ownership-counterproof-applied") applied(); })();
    await provider.waitForEventStream!(abort.signal);
    recovery = provider.reconcileBackgroundTasks!(parent, { fresh: true, signal: abort.signal, onSource: source => guards.push(source.workerSource.retain(abort.signal)) });
    void recovery.catch(() => undefined); await ownershipPending;
    changed = change === "competing";
    const content = change === "ordinary-output" ? [{ type: "text", text: "Parent output" }]
      : change === "unchanged" ? first.content : structuredClone(competitor.content);
    if (change === "unrelated-parent") content[0].state.metadata.sessionID = unrelatedWorker.childId;
    frame("session.message.content.updated", { sessionID: change === "unrelated-parent" ? unrelated : parent,
      messageID: change === "unchanged" ? first.id : competitor.id, content });
    frame("diagnostic.ownership-counterproof-applied", {});
    // Stream enrichment has a finite deadline; it cannot authorize the held
    // required lookup. Counterproof must be recorded before that enrichment.
    await observed; release();
    const result = await recovery.then(tasks => ({ tasks }), error => ({ error }));
    if (changed) { expect(result).toMatchObject({ error: expect.any(Error) }); expect(guards.some(guard => !guard.isCurrent())).toBe(true); }
    else if (change === "included-launch") {
      const tasks = "tasks" in result ? result.tasks : undefined;
      expect(tasks).toHaveLength(2);
      expect(tasks?.find(task => task.taskId === worker.taskId)?.status).toBe("running");
      expect(guards.every(guard => guard.isCurrent())).toBe(true);
    }
    else { expect(result).toMatchObject({ tasks: [expect.objectContaining({ taskId: worker.taskId, status: "completed" })] }); expect(guards.every(guard => guard.isCurrent())).toBe(true); }
    const fresh = await provider.reconcileBackgroundTasks!(parent, { fresh: true, signal: abort.signal });
    expect(fresh).toHaveLength(changed || change === "included-launch" ? 2 : 1);
    expect(fresh.find(task => task.taskId === worker.taskId)?.status).toBe(changed || change === "included-launch" ? "running" : "completed");
    if (changed || change === "included-launch") expect(fresh.every(task => task.status === "running")).toBe(true);
  } finally { release(); firstAbort.abort(); abort.abort(); await firstPump; await pump; await recovery?.catch(() => undefined); await provider.dispose!(); await fake.stop(); }
}, 10_000);

for (const mode of ["prebaseline", "same-report", "large-same-report", "many-reports", "report-budget-at", "report-budget-over", "late-ownerless", "report-change-without-part-clocks"] as const)
test(`native parent-result counterproof is scoped and compact (${mode})`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  let parent: string | undefined, child: string | undefined, reads = 0, repaired = false, foreignLookups = 0;
  let entered!: () => void, release!: () => void, secondEntered!: () => void, releaseSecond!: () => void;
  const pending = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  const secondPending = new Promise<void>(resolve => { secondEntered = resolve; }), secondHeld = new Promise<void>(resolve => { releaseSecond = resolve; });
  const hasInitialReport = mode !== "prebaseline" && mode !== "late-ownerless";
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route === "/api/session/z") foreignLookups++;
    if (route === "/api/event") return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "server.connected", data: {}, location: { directory } })}\n\n`));
      request.signal.addEventListener("abort", () => controller.close(), { once: true });
    } }), { headers: { "content-type": "text/event-stream" } });
    if (route.endsWith("/inbox")) return Response.json({ data: [] });
    const response = await fetch(request);
    if (route === `/api/session/${parent}/message`) {
      const body = await response.json(), first = body.data[0], index = ++reads, delayed = mode === "late-ownerless" && index === 2;
      first.time = { created: 20 }; first.content[0].time = { created: 20, ran: 20, completed: 30 };
      if (mode === "report-change-without-part-clocks") first.content[0].time = {};
      const report = { id: "native-report", type: "synthetic", time: { created: 45 }, text: mode === "large-same-report" ? "Report".repeat(20_000) : "Parent result",
        metadata: { source: "subagent", childID: child, state: hasInitialReport && !(mode === "report-change-without-part-clocks" && index > 1) ? "completed" : "error" } };
      const data = [first, ...(hasInitialReport || index > 1 && !delayed ? [report] : [])];
      if (mode === "many-reports") for (let item = 1; item < 300; item++) data.push({ ...report, id: `result-${item}` });
      if (!repaired && index > 1 && (mode === "report-budget-at" || mode === "report-budget-over")) data.push({ id: "noise", type: "assistant", time: { created: 50 },
        content: Array.from({ length: mode === "report-budget-at" ? 254 : 255 }, (_, item) => ({ type: "tool", id: `n${item}`, name: "subagent", state: { metadata: { sessionID: "z" } } })) });
      if (index === 1) { entered(); await held; }
      if (delayed) { secondEntered(); await secondHeld; }
      return Response.json({ data, cursor: {} });
    }
    if (route === `/api/session/${child}/message`) return Response.json({ data: [{ id: "idle", type: "idle", time: { created: 40 }, outcome: "succeeded" }], cursor: {} });
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport }), abort = new AbortController();
  let older: ReturnType<typeof provider.listMessages> | undefined, delayed: ReturnType<NonNullable<typeof provider.getReversibleHistoryState>> | undefined, pump: Promise<void> | undefined;
  try {
    parent = (await provider.createSession("Compact parent-result observation")).id;
    const worker = fake.launchRequestWorker(parent); child = worker.childId;
    const unrelated = (await provider.createSession("Independent reuse invalidation")).id;
    pump = (async () => { for await (const _event of provider.events(abort.signal)) {} })(); await provider.waitForEventStream!(abort.signal);
    older = provider.listMessages(parent, { limit: 100, signal: abort.signal }); void older.catch(() => undefined); await pending;
    await provider.reconcileBackgroundTasks!(unrelated, { fresh: true, signal: abort.signal });
    if (mode === "late-ownerless") {
      delayed = provider.getReversibleHistoryState!(parent); void delayed.catch(() => undefined); await secondPending;
      await provider.reconcileBackgroundTasks!(unrelated, { fresh: true, signal: abort.signal });
    }
    await provider.getReversibleHistoryState!(parent); releaseSecond(); await delayed; release();
    const stale = await older, contradicted = mode === "prebaseline" || mode === "late-ownerless" || mode === "report-budget-over" || mode === "report-change-without-part-clocks";
    expect(stale.workerSource?.isCurrent()).toBe(!contradicted);
    expect(foreignLookups).toBe(0);
    await provider.getReversibleHistoryState!(parent); expect(reads).toBe(mode === "late-ownerless" ? 3 : 2);
    repaired = true;
    const fresh = await provider.reconcileBackgroundTasks!(parent, { fresh: true, signal: abort.signal });
    expect(fresh.find(task => task.taskId === worker.taskId)).toMatchObject({ status: hasInitialReport && mode !== "report-change-without-part-clocks" ? "completed" : "failed", resultId: "native-report" });
    expect(foreignLookups).toBe(0);
  } finally { release(); releaseSecond(); abort.abort(); await older?.catch(() => undefined); await delayed?.catch(() => undefined); await pump; await provider.dispose!(); await fake.stop(); }
}, 10_000);

for (const arrival of ["after-owned", "while-owned-pending"] as const)
test(`older ownerless parent results cannot revoke later consumed results (${arrival})`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  let parent: string | undefined, child: string | undefined, reads = 0;
  let entered!: () => void, release!: () => void, newerEntered!: () => void, releaseNewer!: () => void;
  const pending = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  const newerPending = new Promise<void>(resolve => { newerEntered = resolve; }), newerHeld = new Promise<void>(resolve => { releaseNewer = resolve; });
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route === "/api/event") return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "server.connected", data: {}, location: { directory } })}\n\n`));
      request.signal.addEventListener("abort", () => controller.close(), { once: true });
    } }), { headers: { "content-type": "text/event-stream" } });
    if (route.endsWith("/inbox")) return Response.json({ data: [] });
    const response = await fetch(request);
    if (route === `/api/session/${parent}/message`) {
      const body = await response.json(), first = body.data[0], index = ++reads;
      first.time = { created: 20 }; first.content[0].time = { created: 20, ran: 20, completed: 30 };
      if (index === 1) { entered(); await held; }
      else if (arrival === "while-owned-pending") { newerEntered(); await newerHeld; }
      return Response.json({ data: [first, { id: "parent-result", type: "synthetic", time: { created: 45 }, text: "Authoritative result",
        metadata: { source: "subagent", childID: child, state: index === 1 ? "completed" : "error" } }], cursor: {} });
    }
    if (route === `/api/session/${child}/message`) return Response.json({ data: [{ id: "idle", type: "idle", time: { created: 40 }, outcome: "succeeded" }], cursor: {} });
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport }), abort = new AbortController();
  let older: ReturnType<NonNullable<typeof provider.getReversibleHistoryState>> | undefined, read: ReturnType<typeof provider.listMessages> | undefined, pump: Promise<void> | undefined;
  try {
    parent = (await provider.createSession("Native report ordering")).id; const worker = fake.launchRequestWorker(parent); child = worker.childId;
    const unrelated = (await provider.createSession("Independent reuse invalidation")).id;
    pump = (async () => { for await (const _event of provider.events(abort.signal)) {} })(); await provider.waitForEventStream!(abort.signal);
    older = provider.getReversibleHistoryState!(parent); void older.catch(() => undefined); await pending;
    await provider.reconcileBackgroundTasks!(unrelated, { fresh: true, signal: abort.signal });
    read = provider.listMessages(parent, { limit: 100, signal: abort.signal }); void read.catch(() => undefined);
    if (arrival === "while-owned-pending") { await newerPending; release(); await older; releaseNewer(); }
    const page = await read; expect(page.workerSource?.isCurrent()).toBe(true);
    expect(page.items).toContainEqual(expect.objectContaining({ taskId: worker.taskId, status: "failed", resultId: "parent-result" }));
    release(); await older;
    expect(page.workerSource?.isCurrent()).toBe(true);
    await provider.getReversibleHistoryState!(parent); expect(reads).toBe(2);
    expect(page.workerSource?.isCurrent()).toBe(true);
  } finally { release(); releaseNewer(); abort.abort(); await older?.catch(() => undefined); await read?.catch(() => undefined); await pump; await provider.dispose!(); await fake.stop(); }
}, 10_000);

for (const carrier of ["native", "streamed", "transcript"] as const)
for (const mode of ["newer-observation", ...(carrier !== "streamed" ? ["cancelled" as const] : []), "released-owner", "count-at", "count-over", "bytes-over", "duplicates"] as const)
test(`${carrier === "native" ? "pending" : carrier === "streamed" ? "streamed pending" : "transcript pending"} outcome observations retain bounded authority and lifetime (${mode})`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  let parent: string | undefined, child: string | undefined, phase: "initial" | "observe" | "final" = "initial", foreignReads = 0;
  let entered!: () => void, release!: () => void;
  const pending = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  let wire!: ReadableStreamDefaultController<Uint8Array>, applied!: () => void, inboxReads = 0;
  const observed = new Promise<void>(resolve => { applied = resolve; });
  const frame = (type: string, data: unknown) => wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type, data, created: 45, location: { directory } })}\n\n`));
  const entry = (id: string, worker: string) => ({ id, type: "synthetic", time: { created: 45 }, payload: {
    text: "Pending failed result", metadata: { source: "subagent", childID: worker, state: "error" },
  } });
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (carrier === "streamed" && route === "/api/event") return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      wire = controller; frame("server.connected", {}); request.signal.addEventListener("abort", () => controller.close(), { once: true });
    } }), { headers: { "content-type": "text/event-stream" } });
    const lookup = /^\/api\/session\/([^/]+)$/.exec(route);
    if (lookup && lookup[1] !== "active" && lookup[1] !== parent && lookup[1] !== child) foreignReads++;
    if (route === `/api/session/${parent}/inbox`) {
      inboxReads++;
      const entries = phase === "initial" ? [] : phase === "final" || !["count-at", "count-over", "bytes-over", "duplicates"].includes(mode) ? [entry("target-result", child!)]
        : mode === "bytes-over" ? [entry("oversized", "z".repeat(32_768))]
          : Array.from({ length: mode === "count-at" ? 256 : mode === "count-over" ? 257 : 400 }, (_, index) => entry(mode === "duplicates" ? "same-result" : `result-${index}`, "z"));
      if (phase === "observe" && mode === "cancelled") { entered(); await held; }
      return Response.json({ data: entries });
    }
    if (route.endsWith("/inbox")) return Response.json({ data: [] });
    const response = await fetch(request);
    if (route === `/api/session/${parent}/message`) {
      const body = await response.json(), first = body.data[0]; first.time = { created: 20 };
      first.content[0].time = { created: 20, ran: 20, completed: 30 }; return Response.json({ data: [first], cursor: {} });
    }
    if (route === `/api/session/${child}/message`) return Response.json({ data: [{ id: "idle", type: "idle", time: { created: 40 }, outcome: "succeeded" }], cursor: {} });
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const owner = new AbortController(), lifetime = new AbortController(), probe = new AbortController();
  const guards: import("../../provider").WorkerSourceGuard[] = [], freshGuards: import("../../provider").WorkerSourceGuard[] = [];
  let observing: ReturnType<NonNullable<typeof provider.listPendingInbox>> | undefined;
  let pump: Promise<void> | undefined;
  try {
    if (carrier === "streamed") {
      pump = (async () => { for await (const event of provider.events(lifetime.signal)) if (event.eventType === "diagnostic.stream-budget-applied") applied(); })();
      await provider.waitForEventStream!(lifetime.signal);
    }
    parent = (await provider.createSession("Pending outcome retention")).id;
    const worker = fake.launchRequestWorker(parent); child = worker.childId;
    const initial = carrier === "transcript" ? await provider.listMessages(parent, { limit: 100, signal: owner.signal }).then(page => {
      guards.push(page.workerSource!.retain(owner.signal)); return page.items.filter((item): item is import("../../types").BackgroundTaskItem => item.type === "background_task");
    }) : await provider.reconcileBackgroundTasks!(parent, { fresh: true, signal: owner.signal,
      onSource: source => guards.push(source.workerSource.retain(owner.signal)) });
    expect(initial[0]?.status).toBe("completed"); expect(initial[0]?.resultId).toBeUndefined();
    expect(guards.length).toBeGreaterThan(0); expect(guards.every(guard => guard.isCurrent())).toBe(true);
    if (mode === "released-owner") owner.abort();
    phase = "observe";
    if (carrier === "streamed") {
      const before = inboxReads;
      const entries = mode === "newer-observation" || mode === "released-owner" ? [entry("target-result", child!)]
        : mode === "bytes-over" ? [entry("oversized", "z".repeat(32_768))]
          : Array.from({ length: mode === "count-at" ? 256 : mode === "count-over" ? 257 : 400 }, (_, index) => entry(mode === "duplicates" ? "same-result" : `result-${index}`, "z"));
      for (const item of entries) frame("session.inbox.enqueued", { sessionID: parent, inboxID: item.id, item });
      frame("diagnostic.stream-budget-applied", {}); await observed;
      expect(inboxReads).toBe(before);
    } else {
      observing = provider.listPendingInbox!(parent, { signal: probe.signal }); void observing.catch(() => undefined);
      if (mode === "cancelled") { await pending; probe.abort(); release(); await observing.catch(() => undefined); }
      else expect(await observing).toEqual([]); // No worker report is exposed as a user steer.
    }
    const denied = ["newer-observation", "released-owner", "count-over", "bytes-over"].includes(mode);
    expect(guards.every(guard => guard.isCurrent())).toBe(!denied);
    // SSE already verifies reported children; native inbox observation does
    // not. The counterproof itself must add no inbox or ownership reads.
    const expectedLookups = carrier !== "streamed" ? 0 : mode === "count-at" ? 256 : mode === "count-over" ? 257 : mode === "duplicates" ? 400 : 0;
    expect(foreignReads).toBe(expectedLookups);
    phase = "final";
    const fresh = await provider.reconcileBackgroundTasks!(parent, { fresh: true, signal: lifetime.signal,
      onSource: source => freshGuards.push(source.workerSource.retain(lifetime.signal)) });
    expect(fresh.find(task => task.taskId === worker.taskId)).toMatchObject({ status: "failed", resultId: "target-result" });
    expect(freshGuards.every(guard => guard.isCurrent())).toBe(true); expect(foreignReads).toBe(expectedLookups);
  } finally { release(); owner.abort(); lifetime.abort(); probe.abort(); await observing?.catch(() => undefined); await pump; await provider.dispose!(); await fake.stop(); }
}, 10_000);

for (const arrival of ["after-owned", "while-owned-pending", "newer-ownerless", "streamed-overlap", "streamed-replay-overlap"] as const)
test(`pending outcome native order cannot be replaced by response arrival (${arrival})`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  let parent: string | undefined, child: string | undefined, inboxReads = 0;
  let entered!: () => void, release!: () => void, secondEntered!: () => void, releaseSecond!: () => void;
  const pending = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  const secondPending = new Promise<void>(resolve => { secondEntered = resolve; }), secondHeld = new Promise<void>(resolve => { releaseSecond = resolve; });
  let wire!: ReadableStreamDefaultController<Uint8Array>, applied!: () => void;
  const observed = new Promise<void>(resolve => { applied = resolve; });
  const frame = (type: string, data: unknown) => wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type, data, created: 45, location: { directory } })}\n\n`));
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (arrival.startsWith("streamed") && route === "/api/event") return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      wire = controller; frame("server.connected", {}); request.signal.addEventListener("abort", () => controller.close(), { once: true });
    } }), { headers: { "content-type": "text/event-stream" } });
    if (route === `/api/session/${parent}/inbox`) {
      const index = ++inboxReads;
      const data = index === 1 && arrival !== "streamed-replay-overlap" ? [] : [{ id: "pending-result", type: "synthetic", time: { created: 45 }, payload: {
        text: "New pending result", metadata: { source: "subagent", childID: child, state: "error" },
      } }];
      if (index === 1) { entered(); await held; }
      if (index === 2 && arrival === "while-owned-pending") { secondEntered(); await secondHeld; }
      return Response.json({ data });
    }
    if (route.endsWith("/inbox")) return Response.json({ data: [] });
    const response = await fetch(request);
    if (route === `/api/session/${parent}/message`) {
      const body = await response.json(), first = body.data[0]; first.time = { created: 20 };
      first.content[0].time = { created: 20, ran: 20, completed: 30 }; return Response.json({ data: [first], cursor: {} });
    }
    if (route === `/api/session/${child}/message`) return Response.json({ data: [{ id: "idle", type: "idle", time: { created: 40 }, outcome: "succeeded" }], cursor: {} });
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport }), abort = new AbortController();
  const guards: import("../../provider").WorkerSourceGuard[] = [];
  let older: ReturnType<NonNullable<typeof provider.listPendingInbox>> | undefined, recovery: ReturnType<NonNullable<typeof provider.reconcileBackgroundTasks>> | undefined;
  let pump: Promise<void> | undefined;
  try {
    if (arrival.startsWith("streamed")) {
      pump = (async () => { for await (const event of provider.events(abort.signal)) if (event.eventType === "diagnostic.stream-order-applied") applied(); })();
      await provider.waitForEventStream!(abort.signal);
    }
    parent = (await provider.createSession("Native pending observation order")).id;
    const worker = fake.launchRequestWorker(parent); child = worker.childId;
    if (arrival === "newer-ownerless" || arrival.startsWith("streamed")) {
      recovery = provider.reconcileBackgroundTasks!(parent, { fresh: true, signal: abort.signal }); void recovery.catch(() => undefined); await pending;
      if (arrival.startsWith("streamed")) {
        frame("session.inbox.enqueued", { sessionID: parent, inboxID: "pending-result", item: { type: "synthetic", payload: {
          text: "New pending result", metadata: { source: "subagent", childID: child, state: "error" },
        } } });
        frame("diagnostic.stream-order-applied", {}); await observed;
        expect(inboxReads).toBe(1);
      } else expect(await provider.listPendingInbox!(parent, { signal: abort.signal })).toEqual([]);
      release();
      if (arrival === "streamed-replay-overlap") expect((await recovery)[0]?.status).toBe("failed");
      else await expect(recovery).rejects.toBeInstanceOf(Error);
      const fresh = await provider.reconcileBackgroundTasks!(parent, { fresh: true, signal: abort.signal });
      expect(fresh.find(task => task.taskId === worker.taskId)?.status).toBe("failed");
    } else {
      older = provider.listPendingInbox!(parent, { signal: abort.signal }); void older.catch(() => undefined); await pending;
      recovery = provider.reconcileBackgroundTasks!(parent, { fresh: true, signal: abort.signal,
        onSource: source => guards.push(source.workerSource.retain(abort.signal)) }); void recovery.catch(() => undefined);
      if (arrival === "while-owned-pending") { await secondPending; release(); await older; releaseSecond(); }
      const current = await recovery;
      expect(current.find(task => task.taskId === worker.taskId)).toMatchObject({ status: "failed", resultId: "pending-result" });
      release(); await older;
      expect(guards.length).toBeGreaterThan(0); expect(guards.every(guard => guard.isCurrent())).toBe(true);
      expect((await provider.reconcileBackgroundTasks!(parent, { signal: abort.signal }))[0]?.status).toBe("failed");
    }
  } finally { release(); releaseSecond(); abort.abort(); await older?.catch(() => undefined); await recovery?.catch(() => undefined); await pump; await provider.dispose!(); await fake.stop(); }
}, 10_000);

for (const carrier of ["stored", "pending", "streamed"] as const)
for (const change of ["failed-report", "report-before-idle", "same-report", "other-child", "earlier-report", "append-text", ...(carrier === "stored" ? ["hidden-report" as const] : []), ...(carrier === "streamed" ? ["foreign-workspace" as const] : [])] as const)
test(`automatic recovery guards native ${carrier === "stored" ? "parent" : carrier} results through interaction admission (${change})`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  let parent: string | undefined, child: string | undefined, otherChild: string | undefined, changed = false;
  let folded!: () => void, interactionsEntered!: () => void, release!: () => void;
  const consumed = new Promise<void>(resolve => { folded = resolve; }), interactions = new Promise<void>(resolve => { interactionsEntered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  let wire!: ReadableStreamDefaultController<Uint8Array>, streamed!: () => void, inboxReads = 0;
  const applied = new Promise<void>(resolve => { streamed = resolve; });
  const frame = (type: string, data: unknown, created = 45, location = directory) => wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ id: `${type}:${created}`, type, data, created, location: { directory: location } })}\n\n`));
  const parentReport = () => ({ id: "native-parent-result", type: "synthetic", time: { created: change === "earlier-report" ? 5 : change === "report-before-idle" ? 35 : 45 },
    text: "Native parent result", metadata: { source: "subagent", childID: change === "other-child" ? otherChild : child, state: change === "same-report" ? "completed" : "error" } });
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (carrier === "streamed" && route === "/api/event") return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      wire = controller; frame("server.connected", {}, 1); request.signal.addEventListener("abort", () => controller.close(), { once: true });
    } }), { headers: { "content-type": "text/event-stream" } });
    if ((carrier === "pending" || carrier === "streamed") && route === `/api/session/${parent}/inbox`) {
      inboxReads++;
      const report = parentReport();
      return Response.json({ data: change === "same-report" || changed && change !== "foreign-workspace" ? [{ id: report.id, type: "synthetic", time: report.time,
        payload: change === "append-text" ? { text: "Ordinary inbox text" } : { text: report.text, metadata: report.metadata } }] : [] });
    }
    if (route.endsWith("/inbox")) return Response.json({ data: [] });
    if (route === "/api/permission/request" || route === "/api/form") { interactionsEntered(); await held; }
    const response = await fetch(request);
    if (route === `/api/session/${parent}/message`) {
      const body = await response.json(), first = body.data[0]; first.time = { created: 20 };
      first.content[0].time = { created: 20, ran: 20, completed: 30 };
      const report = parentReport();
      return Response.json({ data: [first,
        ...(change === "hidden-report" ? [{ id: "report-hidden", type: "user", text: "Hidden suffix", time: { created: 43 } }] : []),
        ...(carrier === "stored" && (change === "same-report" || changed && change !== "append-text") ? [report] : []),
        ...(changed && change === "append-text" ? [{ id: "ordinary-output", type: "assistant", time: { created: 50 }, content: [{ type: "text", text: "Parent output" }] }] : []),
      ], cursor: {} });
    }
    if (route === `/api/session/${parent}` && change === "hidden-report") {
      const body = await response.json(); body.data.revert = { messageID: "report-hidden" }; return Response.json(body);
    }
    if (route === `/api/session/${child}/message`) return Response.json({ data: [{ id: "idle", type: "idle", time: { created: 40 }, outcome: "succeeded" }], cursor: {} });
    if (route === `/api/session/${otherChild}/message`) return Response.json({ data: [], cursor: {} });
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const nativeRecovery = provider.reconcileBackgroundTasks!.bind(provider), abort = new AbortController();
  const nativeEvents = provider.events.bind(provider);
  provider.events = async function* (signal) { for await (const event of nativeEvents(signal)) { if (event.eventType === "diagnostic.streamed-report-applied") streamed(); yield event; } };
  const guards: import("../../provider").WorkerSourceGuard[] = [];
  provider.reconcileBackgroundTasks = async (id, options) => {
    const tasks = await nativeRecovery(id, { ...options, onSource: source => { options?.onSource?.(source); guards.push(source.workerSource.retain(abort.signal)); } });
    folded(); return tasks;
  };
  const adapter = new ChatAdapter({ provider, workspacePath: directory, coalesceWindowMs: 0 });
  let pump: Promise<void> | undefined, events: Promise<import("../../types").BackgroundTaskItem> | undefined;
  try {
    parent = (await provider.createSession("Native parent report handoff")).id;
    const worker = fake.launchRequestWorker(parent); child = worker.childId;
    if (change === "other-child") otherChild = fake.launchRequestWorker(parent).childId;
    const subscription = await adapter.subscribe(parent, { signal: abort.signal });
    events = (async () => { for await (const event of subscription.events) if (event.type === "item.upsert" && event.item.type === "background_task" && event.item.taskId === worker.taskId) return event.item;
      throw new Error("Scheduler ended before worker publication"); })(); void events.catch(() => undefined);
    pump = adapter.startEventPump(); await Promise.all([consumed, interactions]);
    expect(guards.length).toBeGreaterThan(0);
    changed = true;
    if (carrier === "streamed") {
      const readsBefore = inboxReads, report = parentReport();
      frame("session.inbox.enqueued", { sessionID: parent, inboxID: report.id, item: { type: "synthetic",
        payload: change === "append-text" ? { text: "Ordinary inbox text" } : { text: report.text, metadata: report.metadata } } },
        report.time.created, change === "foreign-workspace" ? `${directory}/foreign` : directory);
      frame("diagnostic.streamed-report-applied", {}); await applied;
      const failed = change === "failed-report" || change === "report-before-idle";
      if (failed) expect(inboxReads).toBe(readsBefore);
      const currentBeforePublication = guards.every(guard => guard.isCurrent());
      release(); const published = await events;
      expect(published.status).toBe(failed ? "failed" : "completed");
      expect(currentBeforePublication).toBe(!failed);
      const fresh = await nativeRecovery(parent, { fresh: true, signal: abort.signal });
      expect(fresh.find(task => task.taskId === worker.taskId)?.status).toBe(failed ? "failed" : "completed");
      return;
    }
    // This native read, not SSE, discovers the parent report before the older
    // scheduler recovery can commit its report-free inferred completion.
    const current = await nativeRecovery(parent, { fresh: true, signal: abort.signal });
    const failed = change === "failed-report" || change === "report-before-idle";
    const expected = failed ? "failed" : change === "hidden-report" ? "running" : "completed";
    expect(current.find(task => task.taskId === worker.taskId)?.status).toBe(expected);
    if (!failed && change !== "hidden-report") expect(guards.every(guard => guard.isCurrent())).toBe(true);
    release(); const published = await events;
    expect(published.status).toBe(expected);
    if (failed) expect(guards.some(guard => !guard.isCurrent())).toBe(true);
    if (failed || change === "same-report") expect(published).toMatchObject({ resultId: "native-parent-result", summary: "Native parent result" });
    else expect(published.resultId).toBeUndefined();
  } finally { release(); abort.abort(); await adapter.dispose(); await pump; await events?.catch(() => undefined); await fake.stop(); }
}, 10_000);

for (const change of ["staged-only", "staged-cleared", "unchanged", "other-child", "stale-overlap"] as const)
test(`warm child transcript observes native visibility before parent recovery (${change})`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  let parent: string | undefined, child: string | undefined, other: string | undefined, staged = false, removed = false, childReads = 0, holdLookup = false;
  let entered!: () => void, release!: () => void;
  const pending = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route.endsWith("/inbox")) return Response.json({ data: [] });
    if (route === "/api/session/active") return Response.json({ data: child ? { [child]: { status: "running" } } : {} });
    const response = await fetch(request);
    if (route === `/api/session/${parent}/message`) {
      const body = await response.json(), first = body.data[0]; first.time = { created: 10 }; first.content[0].time = { created: 10, ran: 11, completed: 12 };
      return Response.json({ data: [first], cursor: {} });
    }
    if (route === `/api/session/${child}/message`) { childReads++; return Response.json({ data: [{ id: "prompt", type: "user", text: "Unchanged execution", time: { created: 15 } },
      ...(!removed ? [{ id: "old-idle", type: "idle", time: { created: 40 }, outcome: "succeeded" }] : [])], cursor: {} }); }
    if (route === `/api/session/${change === "other-child" ? other : child}`) {
      const body = await response.json(); if (staged) body.data.revert = { messageID: "old-idle" };
      if (holdLookup) { holdLookup = false; entered(); await held; }
      return Response.json(body);
    }
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport }), abort = new AbortController();
  let pump: Promise<void> | undefined, older: ReturnType<typeof provider.getSession> | undefined;
  try {
    parent = (await provider.createSession("Warm child visibility before consumer scope")).id; const worker = fake.launchRequestWorker(parent); child = worker.childId; other = fake.launchRequestWorker(parent).childId;
    pump = (async () => { for await (const _event of provider.events(abort.signal)) {} })(); await provider.waitForEventStream!(abort.signal);
    await provider.getReversibleHistoryState!(child); expect(childReads).toBe(1);
    if (change === "stale-overlap") {
      staged = true; holdLookup = true; older = provider.getSession(child); void older.catch(() => undefined); await pending;
    }
    staged = change !== "unchanged"; await provider.getSession(change === "other-child" ? other : child);
    staged = change === "staged-only"; removed = change === "staged-cleared" || change === "stale-overlap";
    await provider.getSession(change === "other-child" ? other : child);
    if (change === "stale-overlap") { await provider.getReversibleHistoryState!(child); expect(childReads).toBe(2); release(); await older; }
    const page = await provider.listMessages(parent, { limit: 100, signal: abort.signal });
    expect(page.workerSource?.isCurrent()).toBe(true);
    expect(page.items).toContainEqual(expect.objectContaining({ taskId: worker.taskId, status: removed || change === "staged-only" ? "running" : "completed" }));
    expect(childReads).toBe(removed ? 2 : 1);
    const fresh = await provider.reconcileBackgroundTasks!(parent, { fresh: true, signal: abort.signal });
    expect(fresh.find(item => item.taskId === worker.taskId)).toMatchObject({ status: removed || change === "staged-only" ? "running" : "completed", ...(removed ? { activity: expect.objectContaining({ kind: "working" }) } : {}) });
    // Explicit fresh inventory intentionally invalidates all history reuse.
    expect(childReads).toBe(removed ? 3 : 2);
  } finally { release(); abort.abort(); await older?.catch(() => undefined); await pump; await provider.dispose!(); await fake.stop(); }
}, 10_000);

for (const read of ["provider", "adapter"] as const)
for (const change of ["staged-cleared", "unchanged", "append", "other-child"] as const)
test(`${read} retains boundary transitions during the first child transcript (${change})`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  let parent: string | undefined, child: string | undefined, staged = false, removed = false, heldOnce = false;
  let entered!: () => void, release!: () => void;
  const pending = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route.endsWith("/inbox")) return Response.json({ data: [] });
    if (route === "/api/session/active") return Response.json({ data: child ? { [child]: { status: "running" } } : {} });
    const response = await fetch(request);
    if (route === `/api/session/${parent}/message`) {
      const body = await response.json(), first = body.data[0]; first.time = { created: 10 }; first.content[0].time = { created: 10, ran: 11, completed: 12 };
      return Response.json({ data: [first], cursor: {} });
    }
    if (route === `/api/session/${child}/message`) {
      const data = [{ id: "child-prompt", type: "user", text: "Current execution", time: { created: 15 } },
        ...(!removed ? [{ id: "removed-idle", type: "idle", time: { created: 40 }, outcome: "succeeded" }] : [])];
      if (!heldOnce) { heldOnce = true; entered(); await held; }
      return Response.json({ data, cursor: {} });
    }
    if (route === `/api/session/${child}`) { const body = await response.json(); if (staged) body.data.revert = { messageID: "removed-idle" }; return Response.json(body); }
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const adapter = read === "adapter" ? new ChatAdapter({ provider, workspacePath: directory, coalesceWindowMs: 0 }) : undefined;
  const abort = new AbortController();
  let reading: Promise<import("../../provider").ProviderHistoryPage | import("../../types").ConversationSnapshot> | undefined;
  try {
    parent = (await provider.createSession("First child transcript boundary window")).id; const worker = fake.launchRequestWorker(parent); child = worker.childId;
    const other = (await provider.createSession("Unrelated boundary owner")).id;
    reading = adapter ? adapter.history(parent) : provider.listMessages(parent, { limit: 100, signal: abort.signal }); void reading.catch(() => undefined); await pending;
    staged = change === "staged-cleared"; await provider.getSession(change === "other-child" ? other : child);
    staged = false; removed = change === "staged-cleared"; await provider.getSession(change === "other-child" ? other : child);
    if (change === "append") fake.workerReport(child, "Independent model", "high", 0.001);
    release(); const result = await reading;
    if (adapter) expect(result.items).toContainEqual(expect.objectContaining({ taskId: worker.taskId, status: removed ? "running" : "completed" }));
    else expect((result as import("../../provider").ProviderHistoryPage).workerSource?.isCurrent()).toBe(!removed);
    const fresh = await provider.reconcileBackgroundTasks!(parent, { fresh: true, signal: abort.signal });
    expect(fresh.find(item => item.taskId === worker.taskId)).toMatchObject({ status: removed ? "running" : "completed",
      ...(removed ? { activity: expect.objectContaining({ kind: "working" }) } : {}) });
  } finally { release(); abort.abort(); await reading?.catch(() => undefined); if (adapter) await adapter.dispose(); else await provider.dispose!(); await fake.stop(); }
}, 10_000);

for (const change of ["stale-cleared", "stale-staged", "unchanged", "newer-change"] as const)
test(`ownerless session lookup cannot claim a collecting visibility read (${change})`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  let parent: string | undefined, child: string | undefined, lookups = 0, staged = change === "stale-staged";
  let historyEntered!: () => void, releaseHistory!: () => void, lookupEntered!: () => void, releaseLookup!: () => void;
  const historyPending = new Promise<void>(resolve => { historyEntered = resolve; }), historyHeld = new Promise<void>(resolve => { releaseHistory = resolve; });
  const lookupPending = new Promise<void>(resolve => { lookupEntered = resolve; }), lookupHeld = new Promise<void>(resolve => { releaseLookup = resolve; });
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route.endsWith("/inbox")) return Response.json({ data: [] });
    const response = await fetch(request);
    if (route === `/api/session/${parent}/message`) {
      const body = await response.json(); body.data[0].time = { created: 20 };
      body.data[0].content[0].time = { created: 20, ran: 20, completed: 30 }; return Response.json(body);
    }
    if (route === `/api/session/${child}/message`) {
      historyEntered(); await historyHeld;
      return Response.json({ data: [{ id: "child-hidden", type: "user", text: "Visibility suffix", time: { created: 35 } },
        { id: "child-idle", type: "idle", time: { created: 40 }, outcome: "succeeded" }], cursor: {} });
    }
    if (route === `/api/session/${child}`) {
      const body = await response.json(); if (staged) body.data.revert = { messageID: "child-hidden" };
      if (++lookups === 2) { lookupEntered(); await lookupHeld; }
      return Response.json(body);
    }
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport }), abort = new AbortController();
  let read: ReturnType<typeof provider.listMessages> | undefined, ownerless: ReturnType<typeof provider.getSession> | undefined;
  try {
    parent = (await provider.createSession("Explicit visibility read owner")).id;
    const worker = fake.launchRequestWorker(parent); child = worker.childId;
    read = provider.listMessages(parent, { limit: 100, signal: abort.signal }); void read.catch(() => undefined); await historyPending;
    ownerless = provider.getSession(child); void ownerless.catch(() => undefined); await lookupPending;
    staged = change === "stale-cleared"; releaseHistory();
    const page = await read;
    expect(page.workerSource?.isCurrent()).toBe(true);
    expect(page.items).toContainEqual(expect.objectContaining({ taskId: worker.taskId, status: staged ? "running" : "completed" }));
    releaseLookup(); await ownerless;
    expect(page.workerSource?.isCurrent()).toBe(true);
    if (change === "newer-change") {
      staged = true; await provider.getSession(child);
      expect(page.workerSource?.isCurrent()).toBe(false);
    }
    const current = await provider.listMessages(parent, { limit: 100, signal: abort.signal });
    expect(current.workerSource?.isCurrent()).toBe(true);
    expect(current.items).toContainEqual(expect.objectContaining({ taskId: worker.taskId, status: staged ? "running" : "completed" }));
  } finally { releaseHistory(); releaseLookup(); abort.abort(); await read?.catch(() => undefined); await ownerless?.catch(() => undefined); await provider.dispose!(); await fake.stop(); }
}, 10_000);

for (const change of ["competing", "unchanged", "append", "other-child", "late-ownerless", "native-count-at-limit", "native-count-over-limit", "native-bytes-below-limit", "native-bytes-over-limit", "native-replacements"] as const)
test(`ownerless parent inventory covers its first pending response (${change})`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  let parent: string | undefined, child: string | undefined, otherChild: string | undefined, reads = 0, recovered = false, unknownLookups = 0;
  const bounded = change.startsWith("native-"), saturated = change === "native-count-over-limit" || change === "native-bytes-over-limit";
  let entered!: () => void, release!: () => void, secondEntered!: () => void, releaseSecond!: () => void;
  const pending = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  const secondPending = new Promise<void>(resolve => { secondEntered = resolve; }), secondHeld = new Promise<void>(resolve => { releaseSecond = resolve; });
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route === "/api/session/z") unknownLookups++;
    if (route === "/api/event") return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "server.connected", data: {}, location: { directory } })}\n\n`));
      request.signal.addEventListener("abort", () => controller.close(), { once: true });
    } }), { headers: { "content-type": "text/event-stream" } });
    if (route.endsWith("/inbox")) return Response.json({ data: [] });
    const response = await fetch(request);
    if (route === `/api/session/${parent}/message`) {
      const body = await response.json(), first = body.data[0], index = ++reads;
      first.time = { created: 10 }; first.content[0].time = { created: 10, ran: 11, completed: 12 };
      const competitor = structuredClone(first); competitor.id = "new-parent-launch"; competitor.time = { created: 15 };
      competitor.content[0].id = "new-parent-call"; competitor.content[0].time = { created: 15, ran: 16, completed: 25 };
      if (change === "other-child") competitor.content[0].state.metadata.sessionID = otherChild;
      const delayed = change === "late-ownerless" && index === 2;
      const data = [first, ...(index > 1 && !delayed && !bounded && change !== "unchanged" && change !== "append" ? [competitor] : []),
        ...(index > 1 && change === "append" ? [{ id: "ordinary-output", type: "assistant", time: { created: 30 }, content: [{ type: "text", text: "Continued output" }] }] : [])];
      if (bounded && index > 1 && !recovered) data.push({ id: "m", type: "assistant", time: { created: 30 }, content: Array.from({ length: change === "native-count-at-limit" ? 255 : change === "native-count-over-limit" ? 256 : 1 }, (_, item) => ({
        type: "tool", name: "subagent", id: change === "native-bytes-over-limit" ? "x".repeat(32_768) : change === "native-bytes-below-limit" ? "x".repeat(30_000) : change === "native-replacements" ? `n${index}` : `n${item}`,
        state: { metadata: { sessionID: "z" } },
      })) });
      if (index === 1) { entered(); await held; }
      if (delayed) { secondEntered(); await secondHeld; }
      return Response.json({ data, cursor: {} });
    }
    if (route === `/api/session/${child}/message`) return Response.json({ data: [{ id: "child-idle", type: "idle", time: { created: 20 }, outcome: "succeeded" }], cursor: {} });
    if (route === `/api/session/${otherChild}/message`) return Response.json({ data: [], cursor: {} });
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport }), abort = new AbortController();
  let older: ReturnType<typeof provider.listMessages> | undefined, delayed: ReturnType<NonNullable<typeof provider.getReversibleHistoryState>> | undefined, pump: Promise<void> | undefined;
  try {
    parent = (await provider.createSession("Pending parent / ownerless inventory")).id;
    const worker = fake.launchRequestWorker(parent); child = worker.childId;
    if (change === "other-child") otherChild = fake.launchRequestWorker(parent).childId;
    const unrelated = (await provider.createSession("Independent invalidation")).id;
    pump = (async () => { for await (const _event of provider.events(abort.signal)) {} })(); await provider.waitForEventStream!(abort.signal);
    older = provider.listMessages(parent, { limit: 100, signal: abort.signal }); void older.catch(() => undefined); await pending;
    await provider.reconcileBackgroundTasks!(unrelated, { fresh: true, signal: abort.signal });
    if (change === "late-ownerless") {
      delayed = provider.getReversibleHistoryState!(parent); void delayed.catch(() => undefined); await secondPending;
      await provider.reconcileBackgroundTasks!(unrelated, { fresh: true, signal: abort.signal });
    }
    await provider.getReversibleHistoryState!(parent);
    if (change === "native-replacements") for (let index = 1; index < 260; index++) {
      await provider.reconcileBackgroundTasks!(unrelated, { fresh: true, signal: abort.signal });
      await provider.getReversibleHistoryState!(parent);
    }
    const nativeReads = change === "native-replacements" ? 261 : change === "late-ownerless" ? 3 : 2;
    expect(reads).toBe(nativeReads);
    releaseSecond(); await delayed; release();
    const stale = await older, contradicted = change === "competing" || change === "late-ownerless" || saturated;
    expect(stale.workerSource?.isCurrent()).toBe(!contradicted);
    if (!contradicted) expect(stale.items).toContainEqual(expect.objectContaining({ taskId: worker.taskId, status: "completed" }));
    await provider.getReversibleHistoryState!(parent);
    expect(reads).toBe(nativeReads);
    expect(unknownLookups).toBe(0); // Provisional native facts never grant child IO.
    recovered = true;
    const fresh = await provider.reconcileBackgroundTasks!(parent, { fresh: true, signal: abort.signal });
    expect(fresh).toHaveLength(!bounded && (contradicted || change === "other-child") ? 2 : 1);
    expect(fresh.find(task => task.taskId === worker.taskId)?.status).toBe(contradicted && !bounded ? "running" : "completed");
    if (contradicted && !bounded) expect(fresh.every(task => task.status === "running")).toBe(true);
    expect(unknownLookups).toBe(0);
  } finally { release(); releaseSecond(); abort.abort(); await older?.catch(() => undefined); await delayed?.catch(() => undefined); await pump; await provider.dispose!(); await fake.stop(); }
}, 10_000);

for (const arrival of ["after-owned", "while-owned-pending", "shared-transport"] as const)
test(`an older ownerless parent response cannot poison newer owned inventory (${arrival})`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  let parent: string | undefined, child: string | undefined, reads = 0;
  let entered!: () => void, release!: () => void, newerEntered!: () => void, releaseNewer!: () => void;
  const pending = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  const newerPending = new Promise<void>(resolve => { newerEntered = resolve; }), newerHeld = new Promise<void>(resolve => { releaseNewer = resolve; });
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route === "/api/event") return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "server.connected", data: {}, location: { directory } })}\n\n`));
      request.signal.addEventListener("abort", () => controller.close(), { once: true });
    } }), { headers: { "content-type": "text/event-stream" } });
    if (route.endsWith("/inbox")) return Response.json({ data: [] });
    const response = await fetch(request);
    if (route === `/api/session/${parent}/message`) {
      const body = await response.json(), first = body.data[0], index = ++reads;
      first.time = { created: 10 }; first.content[0].time = { created: 10, ran: 11, completed: 12 };
      const competitor = structuredClone(first); competitor.id = "later-parent"; competitor.time = { created: 15 };
      competitor.content[0].id = "later-call"; competitor.content[0].time = { created: 15, ran: 16, completed: 25 };
      if (index === 1) { entered(); await held; }
      else if (arrival === "while-owned-pending") { newerEntered(); await newerHeld; }
      return Response.json({ data: index === 1 ? [first] : [first, competitor], cursor: {} });
    }
    if (route === `/api/session/${child}/message`) return Response.json({ data: [{ id: "idle", type: "idle", time: { created: 20 }, outcome: "succeeded" }], cursor: {} });
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport }), abort = new AbortController();
  let older: ReturnType<NonNullable<typeof provider.getReversibleHistoryState>> | undefined, current: ReturnType<typeof provider.listMessages> | undefined, pump: Promise<void> | undefined;
  try {
    parent = (await provider.createSession("Native parent order")).id; child = fake.launchRequestWorker(parent).childId;
    const unrelated = (await provider.createSession("Independent invalidation")).id;
    pump = (async () => { for await (const _event of provider.events(abort.signal)) {} })(); await provider.waitForEventStream!(abort.signal);
    older = provider.getReversibleHistoryState!(parent); void older.catch(() => undefined); await pending;
    if (arrival !== "shared-transport") await provider.reconcileBackgroundTasks!(unrelated, { fresh: true, signal: abort.signal });
    current = provider.listMessages(parent, { limit: 100, signal: abort.signal }); void current.catch(() => undefined);
    if (arrival === "while-owned-pending") { await newerPending; release(); await older; releaseNewer(); }
    if (arrival === "shared-transport") release();
    const page = await current;
    expect(page.workerSource?.isCurrent()).toBe(true);
    expect(page.items.filter(item => item.type === "background_task")).toHaveLength(arrival === "shared-transport" ? 1 : 2);
    expect(page.items.filter(item => item.type === "background_task").every(task => task.status === (arrival === "shared-transport" ? "completed" : "running"))).toBe(true);
    release(); await older;
    expect(page.workerSource?.isCurrent()).toBe(true);
    await provider.getReversibleHistoryState!(parent); expect(reads).toBe(arrival === "shared-transport" ? 1 : 2);
    expect(page.workerSource?.isCurrent()).toBe(true);
  } finally { release(); releaseNewer(); abort.abort(); await older?.catch(() => undefined); await current?.catch(() => undefined); await pump; await provider.dispose!(); await fake.stop(); }
}, 10_000);

for (const change of ["committed-revert", "unchanged", "append", "late-ownerless"] as const)
test(`ownerless reversible history covers the first pending child response (${change})`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  let parent: string | undefined, child: string | undefined, reads = 0, changed = false;
  let entered!: () => void, release!: () => void, wire!: ReadableStreamDefaultController<Uint8Array>, secondEntered!: () => void, releaseSecond!: () => void;
  const pending = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const secondPending = new Promise<void>(resolve => { secondEntered = resolve; }), secondHeld = new Promise<void>(resolve => { releaseSecond = resolve; });
  const reverted = change === "committed-revert" || change === "late-ownerless";
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route === "/api/event") return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      wire = controller; wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "server.connected", data: {}, location: { directory } })}\n\n`));
      request.signal.addEventListener("abort", () => controller.close(), { once: true });
    } }), { headers: { "content-type": "text/event-stream" } });
    if (route.endsWith("/inbox")) return Response.json({ data: [] });
    const response = await fetch(request);
    if (route === `/api/session/${parent}/message`) {
      const body = await response.json(), first = body.data[0];
      first.time = { created: 10 }; first.content[0].time = { created: 10, ran: 11, completed: 12 };
      return Response.json({ data: [first], cursor: {} });
    }
    if (route === `/api/session/${child}/message`) {
      const index = ++reads, first = index === 1, delayed = change === "late-ownerless" && index === 2;
      const data = changed && reverted && !delayed ? [] : [
        { id: "child-input", type: "user", text: "Reverted suffix", time: { created: 15 } },
        { id: "child-idle", type: "idle", time: { created: 20 }, outcome: "succeeded" },
        ...(changed && change === "append" ? [{ id: "later-output", type: "assistant", time: { created: 25 }, content: [{ type: "text", text: "Continued output" }] }] : []),
      ];
      if (first) { entered(); await held; }
      if (delayed) { secondEntered(); await secondHeld; }
      return Response.json({ data, cursor: {} });
    }
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const abort = new AbortController();
  let older: ReturnType<typeof provider.listMessages> | undefined, pump: Promise<void> | undefined,
    delayed: ReturnType<NonNullable<typeof provider.getReversibleHistoryState>> | undefined;
  try {
    parent = (await provider.createSession("Pending child / ownerless native read")).id;
    const worker = fake.launchRequestWorker(parent); child = worker.childId;
    const unrelated = (await provider.createSession("Independent reuse invalidation")).id;
    pump = (async () => { for await (const _event of provider.events(abort.signal)) {} })();
    await provider.waitForEventStream!(abort.signal);
    older = provider.listMessages(parent, { limit: 100, signal: abort.signal }); void older.catch(() => undefined);
    await pending;
    // A committed revert's persisted suffix removal is discovered by a native
    // reader, not SSE. An independent fresh recovery invalidates shared reuse.
    changed = true;
    await provider.reconcileBackgroundTasks!(unrelated, { fresh: true, signal: abort.signal });
    if (change === "late-ownerless") {
      delayed = provider.getReversibleHistoryState!(child); void delayed.catch(() => undefined); await secondPending;
      await provider.reconcileBackgroundTasks!(unrelated, { fresh: true, signal: abort.signal });
    }
    const state = await provider.getReversibleHistoryState!(child);
    expect(state.canUndo).toBe(!reverted);
    expect(reads).toBe(change === "late-ownerless" ? 3 : 2);
    // The older ownerless request returns last and must neither replace the
    // newer cached transcript nor overwrite its pending counterproof slot.
    releaseSecond(); await delayed;
    release();
    const stale = await older;
    expect(stale.workerSource?.isCurrent()).toBe(!reverted);
    if (!reverted) expect(stale.items).toContainEqual(expect.objectContaining({ taskId: worker.taskId, status: "completed" }));
    // Reuse must still contain the newer transcript, not the late old response.
    expect((await provider.getReversibleHistoryState!(child)).canUndo).toBe(!reverted);
    expect(reads).toBe(change === "late-ownerless" ? 3 : 2);
    const fresh = await provider.reconcileBackgroundTasks!(parent, { fresh: true, signal: abort.signal });
    expect(fresh).toHaveLength(1);
    expect(fresh[0]?.status).toBe(reverted ? "running" : "completed");
  } finally { release(); releaseSecond(); abort.abort(); await older?.catch(() => undefined); await delayed?.catch(() => undefined); await pump; await provider.dispose!(); await fake.stop(); }
}, 10_000);

for (const arrival of ["after-owned", "while-owned-pending"] as const)
test(`a stale ownerless reversible response cannot revoke later owned child evidence or its reuse (${arrival})`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  let parent: string | undefined, child: string | undefined, reads = 0;
  let entered!: () => void, release!: () => void, newerEntered!: () => void, releaseNewer!: () => void;
  const pending = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  const newerPending = new Promise<void>(resolve => { newerEntered = resolve; }), newerHeld = new Promise<void>(resolve => { releaseNewer = resolve; });
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route === "/api/event") return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "server.connected", data: {}, location: { directory } })}\n\n`));
      request.signal.addEventListener("abort", () => controller.close(), { once: true });
    } }), { headers: { "content-type": "text/event-stream" } });
    if (route.endsWith("/inbox")) return Response.json({ data: [] });
    const response = await fetch(request);
    if (route === `/api/session/${parent}/message`) {
      const body = await response.json(), first = body.data[0];
      first.time = { created: 10 }; first.content[0].time = { created: 10, ran: 11, completed: 12 };
      return Response.json({ data: [first], cursor: {} });
    }
    if (route === `/api/session/${child}/message`) {
      const first = ++reads === 1;
      if (first) { entered(); await held; }
      else if (arrival === "while-owned-pending") { newerEntered(); await newerHeld; }
      return Response.json({ data: [{ id: "child-idle", type: "idle", time: { created: 20 }, outcome: first ? "succeeded" : "failed" }], cursor: {} });
    }
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const abort = new AbortController(), guards: import("../../provider").WorkerSourceGuard[] = [];
  let older: ReturnType<NonNullable<typeof provider.getReversibleHistoryState>> | undefined, pump: Promise<void> | undefined,
    recovery: ReturnType<NonNullable<typeof provider.reconcileBackgroundTasks>> | undefined;
  try {
    parent = (await provider.createSession("Ownerless overlap ordering")).id; child = fake.launchRequestWorker(parent).childId;
    pump = (async () => { for await (const _event of provider.events(abort.signal)) {} })();
    await provider.waitForEventStream!(abort.signal);
    older = provider.getReversibleHistoryState!(child); void older.catch(() => undefined); await pending;
    recovery = provider.reconcileBackgroundTasks!(parent, { fresh: true, signal: abort.signal,
      onSource: source => guards.push(source.workerSource.retain(abort.signal)) });
    void recovery.catch(() => undefined);
    if (arrival === "while-owned-pending") { await newerPending; release(); await older; releaseNewer(); }
    const current = await recovery;
    expect(current[0]?.status).toBe("failed"); expect(guards.length).toBeGreaterThan(0);
    release(); await older;
    expect(guards.every(guard => guard.isCurrent())).toBe(true);
    const reused = await provider.reconcileBackgroundTasks!(parent, { signal: abort.signal });
    expect(reused[0]?.status).toBe("failed"); expect(reads).toBe(2);
    expect(guards.every(guard => guard.isCurrent())).toBe(true);
  } finally { release(); releaseNewer(); abort.abort(); await older?.catch(() => undefined); await recovery?.catch(() => undefined); await pump; await provider.dispose!(); await fake.stop(); }
}, 10_000);

for (const outcome of ["terminal", "activity"] as const)
for (const pressure of ["count-at-limit", "count-over-limit", "bytes-below-limit", "bytes-over-limit", "count-replays", "byte-replays"] as const)
test(`prebaseline buffer ${pressure} preserves bounded ${outcome} authority`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  let parent: string | undefined, child: string | undefined, independent: string | undefined, independentChild: string | undefined, heldOnce = false, interrupts = 0;
  let wire!: ReadableStreamDefaultController<Uint8Array>, entered!: () => void, release!: () => void, applied!: () => void;
  const pending = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const observed = new Promise<void>(resolve => { applied = resolve; });
  const frame = (type: string, data: unknown) => wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type, data, created: 30, location: { directory } })}\n\n`));
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route.endsWith("/interrupt")) interrupts++;
    if (route === "/api/event") return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      wire = controller; frame("server.connected", {}); request.signal.addEventListener("abort", () => controller.close(), { once: true });
    } }), { headers: { "content-type": "text/event-stream" } });
    if (route.endsWith("/inbox")) return Response.json({ data: [] });
    if (route === "/api/session/active") return Response.json({ data: Object.fromEntries([child, independentChild].filter(Boolean).map(id => [id, { status: "running" }])) });
    const response = await fetch(request);
    if (route === `/api/session/${parent}/message` || route === `/api/session/${independent}/message`) {
      const body = await response.json(), first = body.data[0];
      first.time = { created: 10 }; first.content[0].time = { created: 10, ran: 11, completed: 12 };
      if (route === `/api/session/${parent}/message` && !heldOnce) { heldOnce = true; entered(); await held; }
      return Response.json({ data: [first], cursor: {} });
    }
    if (route === `/api/session/${child}/message`) return Response.json({ data: outcome === "terminal"
      ? [{ id: "child-idle", type: "idle", time: { created: 20 }, outcome: "succeeded" }] : [], cursor: {} });
    if (route === `/api/session/${independentChild}/message`) return Response.json({ data: [], cursor: {} });
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const abort = new AbortController(), guards: import("../../provider").WorkerSourceGuard[] = [], independentGuards: import("../../provider").WorkerSourceGuard[] = [];
  let pump: Promise<void> | undefined, recovery: ReturnType<NonNullable<typeof provider.reconcileBackgroundTasks>> | undefined;
  try {
    parent = (await provider.createSession("Bounded counterproof")).id;
    const worker = fake.launchRequestWorker(parent); child = worker.childId;
    independent = (await provider.createSession("Independent owned worker")).id;
    const other = fake.launchRequestWorker(independent); independentChild = other.childId;
    pump = (async () => { for await (const event of provider.events(abort.signal)) if (event.eventType === "diagnostic.buffer-applied") applied(); })();
    await provider.waitForEventStream!(abort.signal);
    const before = await provider.reconcileBackgroundTasks!(independent, { fresh: true, signal: abort.signal,
      onSource: source => independentGuards.push(source.workerSource.retain(abort.signal)) });
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({ taskId: other.taskId, status: "running", activity: { kind: "working" }, control: { available: true } });
    expect(workerCanStop(before[0]!)).toBe(true);
    recovery = provider.reconcileBackgroundTasks!(parent, { fresh: true, signal: abort.signal,
      onSource: source => guards.push(source.workerSource.retain(abort.signal)) });
    void recovery.catch(() => undefined); await pending;
    // Minimal unrelated tool facts fit 256 entries below the byte cap. Long
    // native message identities cross the byte cap with just one fact; tool
    // input would be hashed and would not exercise retained evidence size.
    const count = pressure === "count-at-limit" ? 256 : pressure === "count-over-limit" ? 257
      : pressure.endsWith("replays") ? 300 : 1;
    const messageID = pressure === "bytes-over-limit" ? "x".repeat(32_768)
      : pressure === "bytes-below-limit" || pressure === "byte-replays" ? "x".repeat(32_000) : "n";
    for (let index = 0; index < count; index++) frame("session.message.content.updated", {
      sessionID: parent, messageID, content: [{ type: "tool", id: pressure.startsWith("count-") && !pressure.endsWith("replays") ? `n${index}` : "n", name: "tool" }],
    });
    frame("diagnostic.buffer-applied", {}); await observed; release();
    const result = await recovery.then(tasks => ({ tasks }), error => ({ error }));
    const saturated = pressure === "count-over-limit" || pressure === "bytes-over-limit";
    expect(guards.length).toBeGreaterThan(0);
    if (saturated) {
      const error = "error" in result ? result.error : undefined;
      expect(error).toBeInstanceOf(Error);
      if (outcome === "terminal") expect(guards.some(guard => !guard.isCurrent())).toBe(true);
      else {
        // Inventory/ownership evidence can remain current, but its later
        // history-only activity publication must fail the retained counterproof.
        expect(error?.message).toBe("Background launch inventory changed during recovery");
      }
    } else {
      const tasks = "tasks" in result ? result.tasks : undefined;
      expect(tasks).toHaveLength(1);
      expect(tasks?.[0]).toMatchObject({ taskId: worker.taskId, status: outcome === "terminal" ? "completed" : "running",
        activity: { kind: outcome === "terminal" ? "ended" : "working" } });
      expect(guards.every(guard => guard.isCurrent())).toBe(true);
    }
    await expect(provider.stopTask!(parent, `v2:${parent}:n0`)).rejects.toMatchObject({ name: "BackgroundTaskUnavailableError" });
    expect(interrupts).toBe(0);
    expect(independentGuards.length).toBeGreaterThan(0);
    expect(independentGuards.every(guard => guard.isCurrent())).toBe(true);
    expect((await provider.getSession(independentChild))?.id).toBe(independentChild);
    const after = await provider.reconcileBackgroundTasks!(independent, { fresh: true, signal: abort.signal });
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ taskId: other.taskId, status: "running", activity: { kind: "working", executionId: before[0]?.activity?.executionId }, control: { available: true } });
    expect(workerCanStop(after[0]!)).toBe(true);
  } finally { release(); abort.abort(); await recovery?.catch(() => undefined); await pump; await provider.dispose!(); await fake.stop(); }
}, 10_000);

for (const replay of [false, true])
test(`older parent response cannot overwrite a newer read's launch baseline (replay: ${replay})`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  let parent: string | undefined, child: string | undefined, parentReads = 0, childReads = 0, competitor: any;
  let wire!: ReadableStreamDefaultController<Uint8Array>, oldEntered!: () => void, childEntered!: () => void,
    releaseOld!: () => void, releaseChild!: () => void, applied!: () => void;
  const oldPending = new Promise<void>(resolve => { oldEntered = resolve; });
  const childPending = new Promise<void>(resolve => { childEntered = resolve; });
  const oldHeld = new Promise<void>(resolve => { releaseOld = resolve; });
  const childHeld = new Promise<void>(resolve => { releaseChild = resolve; });
  const observed = new Promise<void>(resolve => { applied = resolve; });
  const frame = (type: string, data: unknown) => wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type, data, created: 30, location: { directory } })}\n\n`));
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route === "/api/event") return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      wire = controller; frame("server.connected", {}); request.signal.addEventListener("abort", () => controller.close(), { once: true });
    } }), { headers: { "content-type": "text/event-stream" } });
    if (route.endsWith("/inbox")) return Response.json({ data: [] });
    const response = await fetch(request);
    if (route === `/api/session/${parent}/message`) {
      const body = await response.json(), first = body.data[0], index = ++parentReads;
      first.time = { created: 10 }; first.content[0].time = { created: 10, ran: 11, completed: 12 };
      competitor = structuredClone(first); competitor.id = "newer-launch"; competitor.time = { created: 15 };
      competitor.content[0].id = "newer-call"; competitor.content[0].time = { created: 15, ran: 16, completed: 25 };
      if (index === 1) { oldEntered(); await oldHeld; }
      return Response.json({ data: index === 1 ? [first] : [first, competitor], cursor: {} });
    }
    if (route === `/api/session/${child}/message`) {
      if (++childReads === 1) { childEntered(); await childHeld; }
      return Response.json({ data: [{ id: "child-idle", type: "idle", time: { created: 20 }, outcome: "succeeded" }], cursor: {} });
    }
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const abort = new AbortController();
  let pump: Promise<void> | undefined, old: ReturnType<typeof provider.listMessages> | undefined,
    fresh: ReturnType<NonNullable<typeof provider.reconcileBackgroundTasks>> | undefined;
  const guards: import("../../provider").WorkerSourceGuard[] = [];
  try {
    parent = (await provider.createSession("Read-owned parent baselines")).id;
    const worker = fake.launchRequestWorker(parent); child = worker.childId; fake.settleWorker(child, "completed", "No parent report");
    pump = (async () => { for await (const event of provider.events(abort.signal)) if (event.eventType === "diagnostic.baseline-replay") applied(); })();
    await provider.waitForEventStream!(abort.signal);
    old = provider.listMessages(parent, { limit: 100, signal: abort.signal }); void old.catch(() => undefined);
    await oldPending;
    fresh = provider.reconcileBackgroundTasks!(parent, { fresh: true, signal: abort.signal, onSource: source => guards.push(source.workerSource.retain(abort.signal)) });
    void fresh.catch(() => undefined); await childPending;
    releaseOld(); await old.catch(() => undefined);
    if (replay) {
      frame("session.message.content.updated", { sessionID: parent, messageID: competitor.id, content: competitor.content });
      frame("diagnostic.baseline-replay", {}); await observed;
    }
    releaseChild();
    const result = await fresh;
    expect(result).toHaveLength(2);
    expect(result.find(task => task.taskId === worker.taskId)?.status).toBe("running");
    expect(result.every(task => task.status === "running")).toBe(true);
    expect(guards.every(guard => guard.isCurrent())).toBe(true);
    const next = await provider.reconcileBackgroundTasks!(parent, { fresh: true, signal: abort.signal });
    expect(next).toHaveLength(2);
    expect(next.find(task => task.taskId === worker.taskId)?.status).toBe("running");
  } finally { releaseOld(); releaseChild(); abort.abort(); await old?.catch(() => undefined); await fresh?.catch(() => undefined); await pump; await provider.dispose!(); await fake.stop(); }
}, 10_000);

test("an overlapping stale child read and transport reuse preserve newer owned working activity", async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  let parent: string | undefined, child: string | undefined, reads = 0;
  let entered!: () => void, release!: () => void;
  const reading = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route.endsWith("/inbox")) return Response.json({ data: [] });
    const response = await fetch(request);
    if (route === `/api/session/${child}/message`) {
      const first = ++reads === 1;
      if (first) { entered(); await held; }
      return Response.json({ data: first ? [{ id: "stale-boundary", type: "idle", time: { created: Date.now() + 1_000 } }] : [], cursor: {} });
    }
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const firstAbort = new AbortController(), abort = new AbortController(), guards: import("../../provider").WorkerSourceGuard[] = [];
  let firstPump: Promise<void> | undefined, pump: Promise<void> | undefined, stale: ReturnType<typeof provider.listMessages> | undefined;
  try {
    firstPump = (async () => { for await (const _event of provider.events(firstAbort.signal)) {} })();
    await provider.waitForEventStream!(firstAbort.signal); firstAbort.abort(); await firstPump;
    parent = (await provider.createSession("Newer working source ordering")).id;
    const worker = fake.launchRequestWorker(parent); child = worker.childId;
    pump = (async () => { for await (const _event of provider.events(abort.signal)) {} })();
    await provider.waitForEventStream!(abort.signal);
    stale = provider.listMessages(child, { limit: 100, signal: abort.signal });
    await reading;
    const current = await provider.reconcileBackgroundTasks!(parent, { fresh: true, signal: abort.signal,
      onSource: source => guards.push(source.workerSource.retain(abort.signal)) });
    expect(current).toContainEqual(expect.objectContaining({ taskId: worker.taskId, activity: expect.objectContaining({ kind: "working", generation: 2 }) }));
    release(); await stale;
    expect(guards.every(guard => guard.isCurrent())).toBe(true);
    const reused = await provider.reconcileBackgroundTasks!(parent, { signal: abort.signal });
    expect(reused).toContainEqual(expect.objectContaining({ taskId: worker.taskId, activity: expect.objectContaining({ kind: "working", generation: 2 }) }));
    expect(reads).toBe(2);
    expect(guards.every(guard => guard.isCurrent())).toBe(true);
  } finally { release(); firstAbort.abort(); abort.abort(); await firstPump; await pump; await stale?.catch(() => undefined); await provider.dispose!(); await fake.stop(); }
}, 10_000);

for (const read of ["provider", "automatic-recovery"] as const)
for (const change of ["completed", "bare-boundary", "append"] as const)
test(`${read} retains activity-only child observation through the final parent lookup (${change})`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  let parent: string | undefined, child: string | undefined, changed = false, captured = false, heldOnce = false;
  let entered!: () => void, release!: () => void;
  const atPublication = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route.endsWith("/inbox")) return Response.json({ data: [] });
    const response = await fetch(request);
    if (route === `/api/session/${child}/message`) return Response.json({ data: !changed ? [] : change === "append"
      ? [{ id: "later-assistant", type: "assistant", time: { created: Date.now() }, content: [{ type: "text", text: "Still working" }] }]
      : [{ id: "child-boundary", type: "idle", time: { created: Date.now() + 1_000 }, ...(change === "completed" ? { outcome: "succeeded" } : {}) }], cursor: {} });
    if (route === `/api/session/${parent}` && captured && !heldOnce) { heldOnce = true; entered(); await held; }
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const nativeRecovery = provider.reconcileBackgroundTasks!.bind(provider);
  provider.reconcileBackgroundTasks = (id, options) => nativeRecovery(id, { ...options, onSource: source => {
    options?.onSource?.(source); captured = true;
  } });
  const adapter = read === "automatic-recovery" ? new ChatAdapter({ provider, workspacePath: directory, coalesceWindowMs: 0 }) : undefined;
  const firstAbort = new AbortController(), abort = new AbortController();
  let firstPump: Promise<void> | undefined, pump: Promise<void> | undefined, pending: Promise<unknown> | undefined;
  try {
    firstPump = (async () => { for await (const _event of provider.events(firstAbort.signal)) {} })();
    await provider.waitForEventStream!(firstAbort.signal); firstAbort.abort(); await firstPump;
    parent = (await provider.createSession("Prepublication child observation continuity")).id;
    const worker = fake.launchRequestWorker(parent); child = worker.childId;
    if (adapter) pump = adapter.startEventPump();
    else {
      pump = (async () => { for await (const _event of provider.events(abort.signal)) {} })();
      await provider.waitForEventStream!(abort.signal);
      pending = provider.reconcileBackgroundTasks!(parent, { fresh: true, signal: abort.signal });
    }
    void pending?.catch(() => undefined); await atPublication;
    if (adapter) {
      // Subscribe after startup so this case observes the scheduler itself,
      // without startup's selected-projection history() reconciliation.
      const subscription = await adapter.subscribe(parent, { signal: abort.signal });
      pending = (async () => { for await (const event of subscription.events) {
        if (event.type === "item.upsert" && event.item.type === "background_task" && event.item.taskId === worker.taskId) return event.item;
      } throw new Error("No automatic worker publication"); })();
      void pending.catch(() => undefined);
    }
    changed = true;
    if (change !== "append") fake.workerObservation(child, false);
    const current = await nativeRecovery(parent, { fresh: true, signal: abort.signal });
    expect(current.find(task => task.taskId === worker.taskId)?.activity?.kind).toBe(change === "completed" ? "ended" : change === "bare-boundary" ? "unavailable" : "working");
    release();
    const result = await pending!.then(value => ({ value }), error => ({ error }));
    if (adapter) {
      expect(result).toMatchObject({ value: expect.objectContaining({ taskId: worker.taskId, activity: expect.objectContaining({ kind: change === "completed" ? "ended" : change === "bare-boundary" ? "unavailable" : "working" }) }) });
    } else if (change === "append") expect(result).toMatchObject({ value: [expect.objectContaining({ taskId: worker.taskId, activity: expect.objectContaining({ kind: "working", generation: 2 }) })] });
    else expect(result).toMatchObject({ error: expect.any(Error) });
  } finally { release(); firstAbort.abort(); abort.abort(); if (adapter) await adapter.dispose(); else await provider.dispose!(); await firstPump; await pump; await pending?.catch(() => undefined); await fake.stop(); }
}, 10_000);

for (const read of ["provider-guard", "history", "workerEvidence"] as const)
for (const mutation of ["replay", "changed-facts"] as const)
test(`${read} progresses through repeated requested-child snapshots (${mutation})`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  let parent: string | undefined, child: string | undefined, consumed = false, streaming = false, changed = false, updates = 0;
  let requested: any, wire!: ReadableStreamDefaultController<Uint8Array>;
  const explicitRead = new AsyncLocalStorage<boolean>();
  const barriers = new Map<string, () => void>();
  const frame = (type: string, data: unknown) => wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type, data, created: 35, location: { directory } })}\n\n`));
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route === "/api/event") return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      wire = controller; frame("server.connected", {}); request.signal.addEventListener("abort", () => controller.close(), { once: true });
    } }), { headers: { "content-type": "text/event-stream" } });
    if (route.endsWith("/inbox")) return Response.json({ data: [] });
    const response = await fetch(request);
    if (route === `/api/session/${parent}/message`) {
      const body = await response.json(), first = body.data[0]; first.time = { created: 10 };
      first.content[0].time = { created: 10, ran: 11, completed: 12 };
      requested = structuredClone(first); requested.id = "requested-message"; requested.time = { created: changed ? 15 : 30 };
      const tool = requested.content[0]; tool.id = "requested-call"; tool.time = { created: changed ? 15 : 30, ran: changed ? 16 : 31 };
      tool.state.status = "pending"; tool.state.input.sessionID = child; tool.state.metadata = {};
      return Response.json({ data: [first, requested], cursor: {} });
    }
    if (route === `/api/session/${child}/message`) {
      consumed = true;
      return Response.json({ data: [{ id: "child-outcome", type: "idle", time: { created: 20 }, outcome: "succeeded" }], cursor: {} });
    }
    if (route === `/api/session/${parent}` && consumed && streaming && explicitRead.getStore()) {
      const diagnostic = `diagnostic.requested-replay-${++updates}`;
      const observed = new Promise<void>(resolve => { barriers.set(diagnostic, resolve); request.signal.addEventListener("abort", () => resolve(), { once: true }); });
      const content = structuredClone(requested.content);
      if (mutation === "changed-facts") { changed = true; content[0].time = { created: 15, ran: 16 }; }
      // Every attempt overlaps snapshots, so a retry cannot buy quiet output.
      for (let index = 0; index < 3; index++) frame("session.message.content.updated", { sessionID: parent, messageID: requested.id, content });
      frame(diagnostic, {}); await observed;
    }
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const nativeEvents = provider.events.bind(provider);
  provider.events = async function* (signal) { for await (const event of nativeEvents(signal)) { barriers.get(event.eventType)?.(); yield event; } };
  const adapter = read === "provider-guard" ? undefined : new ChatAdapter({ provider, workspacePath: directory, coalesceWindowMs: 0, historyReadTimeoutMs: 1_000 });
  const abort = new AbortController();
  let pump: Promise<void> | undefined;
  try {
    parent = (await provider.createSession("Requested-child replay progress")).id;
    const worker = fake.launchRequestWorker(parent); child = worker.childId; fake.settleWorker(child, "completed", "No parent report");
    if (adapter) await adapter.history(parent);
    else { pump = (async () => { for await (const _event of provider.events(abort.signal)) {} })(); await provider.waitForEventStream!(abort.signal); }
    streaming = true;
    if (adapter) {
      const result = await explicitRead.run(true, () => adapter[read === "history" ? "history" : "workerEvidence"](parent!));
      if ("items" in result) expect(result.items).toContainEqual(expect.objectContaining({ taskId: worker.taskId, status: mutation === "replay" ? "completed" : "running" }));
      else {
        expect(result).toMatchObject({ conversationId: parent, complete: true });
        // Compact evidence also includes the pending tool's own dismissal row.
        expect(result.entries).toHaveLength(2);
        expect(result.entries).toContainEqual(expect.objectContaining({ executionId: "worker-dismissal:tool:requested-call", active: false }));
        expect(result.entries.filter(entry => entry.executionId.startsWith("v1:"))).toHaveLength(1);
      }
    } else {
      const guards: import("../../provider").WorkerSourceGuard[] = [];
      const result = await explicitRead.run(true, () => provider.reconcileBackgroundTasks!(parent!, { fresh: true, signal: abort.signal, onSource: source => guards.push(source.workerSource.retain(abort.signal)) }))
        .then(tasks => ({ tasks }), error => ({ error }));
      if (mutation === "replay") {
        expect(result).toMatchObject({ tasks: [expect.objectContaining({ taskId: worker.taskId, status: "completed" })] });
        expect(guards.every(guard => guard.isCurrent())).toBe(true);
      } else { expect(result).toMatchObject({ error: expect.any(Error) }); expect(guards.some(guard => !guard.isCurrent())).toBe(true); }
    }
    expect(updates).toBeGreaterThan(0);
  } finally { streaming = false; abort.abort(); await pump; if (adapter) await adapter.dispose(); else await provider.dispose!(); await fake.stop(); }
}, 10_000);

for (const path of ["native-read", "stream"] as const)
for (const change of ["competing", "ordinary-output", "other-child"] as const)
test(`returned history-only activity observes ${path} parent launch counterproof (${change})`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  let parent: string | undefined, child: string | undefined, other: string | undefined, changed = false, competitor: any;
  let wire!: ReadableStreamDefaultController<Uint8Array>, folded!: (tasks: import("../../types").BackgroundTaskItem[]) => void, release!: () => void, applied!: () => void;
  const returned = new Promise<import("../../types").BackgroundTaskItem[]>(resolve => { folded = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const observed = new Promise<void>(resolve => { applied = resolve; });
  const frame = (type: string, data: unknown) => wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type, data, created: 30, location: { directory } })}\n\n`));
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route === "/api/event") return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      wire = controller; frame("server.connected", {}); request.signal.addEventListener("abort", () => controller.close(), { once: true });
    } }), { headers: { "content-type": "text/event-stream" } });
    if (route.endsWith("/inbox")) return Response.json({ data: [] });
    if (route === "/api/permission/request" || route === "/api/form") await held;
    const response = await fetch(request);
    if (route === `/api/session/${parent}/message`) {
      const body = await response.json(), first = body.data[0]; first.time = { created: 10 };
      first.content[0].time = { created: 10, ran: 11, completed: 12 };
      competitor = structuredClone(first); competitor.id = "tied-parent-message"; competitor.content[0].id = "tied-parent-call";
      if (change === "other-child") competitor.content[0].state.metadata.sessionID = other;
      return Response.json({ data: [first, ...(changed && change !== "ordinary-output" ? [competitor] : [])], cursor: {} });
    }
    if (route === `/api/session/${child}/message`) return Response.json({ data: [], cursor: {} });
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const nativeRecovery = provider.reconcileBackgroundTasks!.bind(provider), nativeEvents = provider.events.bind(provider);
  provider.reconcileBackgroundTasks = async (id, options) => { const tasks = await nativeRecovery(id, options); folded(tasks); return tasks; };
  provider.events = async function* (signal) { for await (const event of nativeEvents(signal)) {
    if (event.eventType === "diagnostic.parent-counterproof-applied") applied(); yield event;
  } };
  const adapter = new ChatAdapter({ provider, workspacePath: directory, coalesceWindowMs: 0 });
  const abort = new AbortController(), firstAbort = new AbortController();
  let firstPump: Promise<void> | undefined, pump: Promise<void> | undefined, publication: Promise<import("../../types").BackgroundTaskItem> | undefined;
  try {
    firstPump = (async () => { for await (const _event of provider.events(firstAbort.signal)) {} })();
    await provider.waitForEventStream!(firstAbort.signal); firstAbort.abort(); await firstPump;
    parent = (await provider.createSession("Returned activity launch inventory")).id;
    const worker = fake.launchRequestWorker(parent); child = worker.childId;
    if (change === "other-child") other = fake.launchRequestWorker(parent).childId;
    const subscription = await adapter.subscribe(parent, { signal: abort.signal });
    publication = (async () => { for await (const event of subscription.events) {
      if (event.type === "item.upsert" && event.item.type === "background_task" && event.item.taskId === worker.taskId) return event.item;
    } throw new Error("No activity recovery publication"); })();
    void publication.catch(() => undefined); pump = adapter.startEventPump();
    expect(await returned).toContainEqual(expect.objectContaining({ taskId: worker.taskId, activity: expect.objectContaining({ kind: "working", generation: 2 }) }));
    changed = true;
    if (path === "native-read") {
      const fresh = await nativeRecovery(parent, { fresh: true, signal: abort.signal });
      expect(fresh.find(task => task.taskId === worker.taskId)?.activity?.kind).toBe(change === "competing" ? "session-active" : "working");
    } else {
      frame("session.message.content.updated", { sessionID: parent,
        messageID: change === "ordinary-output" ? "ordinary-parent-output" : competitor.id,
        content: change === "ordinary-output" ? [{ type: "text", text: "Parent output progresses" }] : competitor.content });
      frame("diagnostic.parent-counterproof-applied", {}); await observed;
    }
    release();
    const published = await publication;
    expect(published.activity?.kind).toBe(change === "competing" ? "session-active" : "working");
    expect(published.status).toBe("running"); expect(published.control?.available).not.toBe(true);
  } finally { release(); firstAbort.abort(); abort.abort(); await adapter.dispose(); await firstPump; await pump; await publication?.catch(() => undefined); await fake.stop(); }
}, 10_000);

for (const read of ["listMessages", "reconcileBackgroundTasks"] as const)
for (const staged of [false, true])
for (const newerParentRead of [false, true])
test(`${read} retains boundary counterproof while its first outcome visibility lookup is pending (${staged}, newer parent: ${newerParentRead})`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  let parent: string | undefined, child: string | undefined, changed = false, childLookups = 0;
  let entered!: () => void, release!: () => void;
  const pendingLookup = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route.endsWith("/inbox")) return Response.json({ data: [] });
    const response = await fetch(request);
    if (route === `/api/session/${parent}/message`) {
      const body = await response.json(); body.data[0].time = { created: 20 };
      body.data[0].content[0].time = { created: 20, ran: 20, completed: 30 }; return Response.json(body);
    }
    if (route === `/api/session/${child}/message`) return Response.json({ data: [
      { id: "child-reverted", type: "user", text: "Reverted suffix", time: { created: 35 } },
      { id: "child-outcome", type: "idle", time: { created: 40 }, outcome: "succeeded" },
    ], cursor: {} });
    if (route === `/api/session/${child}`) {
      const body = await response.json();
      if (changed && staged) body.data.revert = { messageID: "child-reverted" };
      // Verification is the first lookup; hold the first outcome-visibility
      // response after capturing its old null boundary, not the newer response.
      if (++childLookups === 2) { entered(); await held; }
      return Response.json(body);
    }
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const abort = new AbortController();
  let older: Promise<unknown> | undefined;
  try {
    parent = (await provider.createSession("First child visibility lookup counterproof")).id;
    const worker = fake.launchRequestWorker(parent); child = worker.childId; fake.settleWorker(child, "completed", "No parent report");
    older = read === "listMessages" ? provider.listMessages(parent, { limit: 100, signal: abort.signal })
      : provider.reconcileBackgroundTasks!(parent, { fresh: true, signal: abort.signal });
    void older.catch(() => undefined); await pendingLookup;
    changed = true;
    expect(await provider.getSession(child)).not.toBeNull();
    const current = newerParentRead ? await provider.listMessages(parent, { limit: 100, signal: abort.signal }) : undefined;
    if (current) {
      expect(current.items).toContainEqual(expect.objectContaining({ taskId: worker.taskId, status: staged ? "running" : "completed" }));
      expect(current.workerSource?.isCurrent()).toBe(true);
    }
    release();
    const result = await older.then(value => ({ value }), error => ({ error }));
    if (read === "listMessages" && "value" in result) expect((result.value as Awaited<ReturnType<typeof provider.listMessages>>).workerSource?.isCurrent()).toBe(!staged);
    else if (staged) expect(result).toMatchObject({ error: expect.any(Error) });
    else expect(result).toMatchObject({ value: [expect.objectContaining({ taskId: worker.taskId, status: "completed" })] });
    const fresh = current ?? await provider.listMessages(parent, { limit: 100, signal: abort.signal });
    expect(fresh.items).toContainEqual(expect.objectContaining({ taskId: worker.taskId, status: staged ? "running" : "completed" }));
    expect(fresh.workerSource?.isCurrent()).toBe(true);
  } finally { release(); abort.abort(); await older?.catch(() => undefined); await provider.dispose!(); await fake.stop(); }
}, 10_000);

for (const change of ["terminal", "append", "unrelated-terminal"] as const)
test(`automatic recovery fences ${change} after returning generation-2 history-only activity`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  let parent: string | undefined, child: string | undefined, ended = false;
  let wire!: ReadableStreamDefaultController<Uint8Array>, folded!: (tasks: import("../../types").BackgroundTaskItem[]) => void, release!: () => void, applied!: () => void;
  const returned = new Promise<import("../../types").BackgroundTaskItem[]>(resolve => { folded = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const observed = new Promise<void>(resolve => { applied = resolve; });
  const frame = (type: string, data: unknown) => wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type, data, created: Date.now(), location: { directory } })}\n\n`));
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route === "/api/event") return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      wire = controller; frame("server.connected", {});
      request.signal.addEventListener("abort", () => controller.close(), { once: true });
    } }), { headers: { "content-type": "text/event-stream" } });
    if (route.endsWith("/inbox")) return Response.json({ data: [] });
    if (route === "/api/permission/request" || route === "/api/form") await held;
    const response = await fetch(request);
    if (route === `/api/session/${child}/message`) return Response.json({ data: ended
      ? [{ id: "terminal-boundary", type: "idle", time: { created: Date.now() + 1_000 } }] : [], cursor: {} });
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const nativeRecovery = provider.reconcileBackgroundTasks!.bind(provider), nativeEvents = provider.events.bind(provider);
  provider.reconcileBackgroundTasks = async (id, options) => { const tasks = await nativeRecovery(id, options); folded(tasks); return tasks; };
  provider.events = async function* (signal) { for await (const event of nativeEvents(signal)) {
    if (event.eventType === "diagnostic.post-return-applied") applied(); yield event;
  } };
  const adapter = new ChatAdapter({ provider, workspacePath: directory, coalesceWindowMs: 0 });
  const abort = new AbortController(), firstAbort = new AbortController();
  let firstPump: Promise<void> | undefined, pump: Promise<void> | undefined, publication: Promise<import("../../types").BackgroundTaskItem> | undefined;
  try {
    firstPump = (async () => { for await (const _event of provider.events(firstAbort.signal)) {} })();
    await provider.waitForEventStream!(firstAbort.signal); firstAbort.abort(); await firstPump;
    parent = (await provider.createSession("Post-return activity authority")).id;
    const worker = fake.launchRequestWorker(parent); child = worker.childId;
    const subscription = await adapter.subscribe(parent, { signal: abort.signal });
    publication = (async () => { for await (const event of subscription.events) {
      if (event.type === "item.upsert" && event.item.type === "background_task" && event.item.taskId === worker.taskId) return event.item;
    } throw new Error("No automatic recovery publication"); })();
    void publication.catch(() => undefined);
    pump = adapter.startEventPump();
    expect(await returned).toContainEqual(expect.objectContaining({ taskId: worker.taskId, activity: expect.objectContaining({ kind: "working", generation: 2 }) }));
    if (change === "terminal") { ended = true; fake.workerObservation(child, false); }
    if (change === "append") frame("session.message.content.updated", { sessionID: child, messageID: "later-assistant", content: [{ type: "text", text: "Still working" }] });
    else frame("session.execution.succeeded", { sessionID: change === "terminal" ? child : "unrelated-child" });
    frame("diagnostic.post-return-applied", {}); await observed; release();
    const published = await publication;
    expect(published.activity?.kind).toBe(change === "terminal" ? "unavailable" : "working");
    expect(published.status).toBe("running"); expect(published.control?.available).not.toBe(true);
  } finally { release(); firstAbort.abort(); abort.abort(); await adapter.dispose(); await firstPump; await pump; await publication?.catch(() => undefined); await fake.stop(); }
}, 10_000);

for (const parentReport of [false, true])
test(`automatic recovery replaces an admitted history-only outcome but preserves parent reports (${parentReport})`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  let parent: string | undefined, child: string | undefined, changed = false;
  let wire!: ReadableStreamDefaultController<Uint8Array>, admitted!: () => void, updated!: () => void;
  const initial = new Promise<void>(resolve => { admitted = resolve; });
  const later = new Promise<void>(resolve => { updated = resolve; });
  const frame = (type: string, data: unknown) => wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type, data, created: 30, location: { directory } })}\n\n`));
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route === "/api/event") return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      wire = controller; frame("server.connected", {});
      request.signal.addEventListener("abort", () => controller.close(), { once: true });
    } }), { headers: { "content-type": "text/event-stream" } });
    if (route.endsWith("/inbox")) return Response.json({ data: [] });
    const response = await fetch(request);
    if (route === `/api/session/${parent}/message`) {
      const body = await response.json(), first = body.data[0]; first.time = { created: 10 };
      first.content[0].time = { created: 10, ran: 11, completed: 12 };
      const competitor = structuredClone(first); competitor.id = "competing-message"; competitor.time = { created: 15 };
      competitor.content[0].id = "competing-call"; competitor.content[0].time = { created: 15, ran: 16, completed: 25 };
      return Response.json({ data: [first,
        ...(parentReport ? [{ id: "parent-result", type: "synthetic", time: { created: 13 }, text: "Explicit parent report", metadata: { source: "subagent", childID: child, state: "completed" } }] : []),
        ...(changed ? [competitor] : [])], cursor: {} });
    }
    if (route === `/api/session/${child}/message`) return Response.json({ data: [{ id: "child-outcome", type: "idle", time: { created: 20 }, outcome: "succeeded" }], cursor: {} });
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const adapter = new ChatAdapter({ provider, workspacePath: directory, coalesceWindowMs: 0 }), abort = new AbortController();
  let pump: Promise<void> | undefined, events: Promise<void> | undefined;
  try {
    parent = (await provider.createSession("Already-admitted scheduler outcome")).id;
    const worker = fake.launchRequestWorker(parent); child = worker.childId;
    fake.settleWorker(child, "completed", "No inferred parent report");
    const subscription = await adapter.subscribe(parent, { signal: abort.signal });
    events = (async () => { for await (const event of subscription.events) {
      if (event.type !== "item.upsert" || event.item.type !== "background_task") continue;
      if (event.item.taskId === worker.taskId && event.item.status === "completed") admitted();
      if (event.item.toolUseId === "competing-call") updated();
    } })();
    pump = adapter.startEventPump(); await initial;
    changed = true;
    const fresh = await provider.reconcileBackgroundTasks!(parent, { fresh: true, signal: abort.signal });
    expect(fresh.find(task => task.taskId === worker.taskId)?.status).toBe(parentReport ? "completed" : "running");
    // A public ordinary-output event requests automatic recovery, not history().
    frame("session.message.content.updated", { sessionID: parent, messageID: "ordinary-output", content: [{ type: "text", text: "Keep progressing" }] });
    await later;
    const current = (await adapter.subscribe(parent, { signal: abort.signal })).snapshot.items.find(item => item.type === "background_task" && item.taskId === worker.taskId);
    expect(current).toMatchObject({ type: "background_task", status: parentReport ? "completed" : "running", stateUncertain: !parentReport });
    if (parentReport) expect(current).toMatchObject({ resultId: "parent-result", summary: "Explicit parent report" });
    else expect(current).toMatchObject({ activity: { kind: "unavailable" }, control: { available: false } });
  } finally { abort.abort(); await adapter.dispose(); await pump; await events; await fake.stop(); }
}, 10_000);

for (const change of ["remove", "alter", "append"] as const)
test(`a direct child history ${change} observes consumed parent outcome counterproof before SSE`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  let parent: string | undefined, child: string | undefined, changed = false;
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route.endsWith("/inbox")) return Response.json({ data: [] });
    const response = await fetch(request);
    if (route === `/api/session/${parent}/message`) {
      const body = await response.json(); body.data[0].time = { created: 20 };
      body.data[0].content[0].time = { created: 20, ran: 20, completed: 30 }; return Response.json(body);
    }
    if (route === `/api/session/${child}/message`) return Response.json({ data: [
      ...(changed && change === "remove" ? [] : [{ id: "child-outcome", type: "idle", time: { created: 40 }, outcome: changed && change === "alter" ? "failed" : "succeeded" }]),
      ...(changed && change === "append" ? [{ id: "later-assistant", type: "assistant", time: { created: 50 }, content: [{ type: "text", text: "Continued output" }] }] : []),
    ], cursor: {} });
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const abort = new AbortController();
  try {
    parent = (await provider.createSession("Direct child outcome counterproof")).id;
    const worker = fake.launchRequestWorker(parent); child = worker.childId;
    fake.settleWorker(child, "completed", "No parent report");
    const earlier = await provider.listMessages(parent, { limit: 100, signal: abort.signal });
    expect(earlier.items).toContainEqual(expect.objectContaining({ taskId: worker.taskId, status: "completed" }));
    expect(earlier.workerSource?.isCurrent()).toBe(true);
    changed = true;
    await provider.listMessages(child, { limit: 100, signal: abort.signal });
    expect(earlier.workerSource?.isCurrent()).toBe(change === "append");
    const fresh = await provider.reconcileBackgroundTasks!(parent, { fresh: true, signal: abort.signal });
    expect(fresh[0]?.status).toBe(change === "remove" ? "running" : change === "alter" ? "failed" : "completed");
  } finally { abort.abort(); await provider.dispose!(); await fake.stop(); }
});

for (const change of ["revert", "append", "parent-report", "reconnect", "interaction-error"] as const)
test(`automatic recovery retains consumed outcomes through pending interactions (${change})`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  let parent: string | undefined, child: string | undefined, changed = false;
  let folded!: () => void, interactionsEntered!: () => void, release!: () => void;
  const consumed = new Promise<void>(resolve => { folded = resolve; });
  const interactions = new Promise<void>(resolve => { interactionsEntered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const leases: AbortSignal[] = [], released: Promise<void>[] = [];
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route.endsWith("/inbox")) return Response.json({ data: [] });
    if (route === "/api/permission/request" || route === "/api/form") {
      interactionsEntered(); await held;
      if (change === "interaction-error" && changed) return new Response(null, { status: 503 });
    }
    const response = await fetch(request);
    if (route === `/api/session/${parent}/message`) {
      const body = await response.json(); body.data[0].time = { created: 20 };
      body.data[0].content[0].time = { created: 20, ran: 20, completed: 30 };
      if (change === "parent-report") body.data.push({ id: "parent-result", type: "synthetic", time: { created: 45 },
        text: "Explicit parent report", metadata: { source: "subagent", childID: child, state: "completed" } });
      return Response.json(body);
    }
    if (route === `/api/session/${child}/message`) return Response.json({ data: [
      { id: "child-reverted", type: "user", text: "Reversible suffix", time: { created: 35 } },
      { id: "child-outcome", type: "idle", time: { created: 40 }, outcome: "succeeded" },
      ...(changed && change === "append" ? [{ id: "later-assistant", type: "assistant", time: { created: 50 }, content: [{ type: "text", text: "Continued child output" }] }] : []),
    ], cursor: {} });
    if (changed && change !== "append" && route === `/api/session/${child}`) {
      const body = await response.json(); body.data.revert = { messageID: "child-reverted" }; return Response.json(body);
    }
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const nativeRecovery = provider.reconcileBackgroundTasks!.bind(provider);
  provider.reconcileBackgroundTasks = async (id, options) => {
    const tasks = await nativeRecovery(id, options?.onSource ? { ...options, onSource: source => options.onSource!({ ...source, workerSource: {
      isCurrent: source.workerSource.isCurrent,
      retain: signal => {
        leases.push(signal);
        released.push(signal.aborted ? Promise.resolve() : new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true })));
        return source.workerSource.retain(signal);
      },
    } }) } : options);
    folded(); return tasks;
  };
  const adapter = new ChatAdapter({ provider, workspacePath: directory, coalesceWindowMs: 0 });
  const abort = new AbortController();
  let pump: Promise<void> | undefined, events: Promise<import("../../types").BackgroundTaskItem> | undefined;
  try {
    parent = (await provider.createSession("Automatic outcome handoff")).id;
    const worker = fake.launchRequestWorker(parent); child = worker.childId;
    fake.settleWorker(child, "completed", "No inferred parent report");
    const subscription = await adapter.subscribe(parent, { signal: abort.signal });
    events = (async () => { for await (const event of subscription.events) {
      if (event.type === "item.upsert" && event.item.type === "background_task" && event.item.taskId === worker.taskId) return event.item;
    } throw new Error("Recovery subscription ended before publication"); })();
    void events.catch(() => undefined);
    pump = adapter.startEventPump();
    await Promise.all([consumed, interactions]);
    changed = true;
    const current = await nativeRecovery(parent, { fresh: true, signal: abort.signal });
    const status = change === "append" || change === "parent-report" ? "completed" : "running";
    expect(current.find(task => task.taskId === worker.taskId)?.status).toBe(status);
    if (change === "reconnect") {
      await adapter.stopEventPump();
      await Promise.all(released);
      expect(leases.every(signal => signal.aborted)).toBe(true);
    }
    release();
    if (change === "reconnect") pump = adapter.startEventPump();
    const published = await events;
    expect(published.status).toBe(status);
    if (change === "parent-report") expect(published).toMatchObject({ resultId: "parent-result", summary: "Explicit parent report" });
    if (leases.length) {
      await Promise.all(released);
      expect(leases.every(signal => signal.aborted)).toBe(true);
    }
  } finally { release(); abort.abort(); await adapter.dispose(); await pump; await events?.catch(() => undefined); await fake.stop(); }
}, 10_000);

test("an overlapping older parent history cannot revoke the later consumed launch inventory", async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  let parent: string | undefined, child: string | undefined, reads = 0;
  let wire!: ReadableStreamDefaultController<Uint8Array>, entered!: () => void, release!: () => void, applied!: () => void;
  const reading = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const observed = new Promise<void>(resolve => { applied = resolve; });
  const frame = (type: string, data: unknown) => wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type, data, created: 30, location: { directory } })}\n\n`));
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route === "/api/event") return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      wire = controller; frame("server.connected", {});
      request.signal.addEventListener("abort", () => controller.close(), { once: true });
    } }), { headers: { "content-type": "text/event-stream" } });
    if (route.endsWith("/inbox")) return Response.json({ data: [] });
    const response = await fetch(request);
    if (route === `/api/session/${parent}/message`) {
      const firstRead = ++reads === 1, body = await response.json(), first = body.data[0];
      first.time = { created: 10 }; first.content[0].time = { created: 10, ran: 11, completed: 12 };
      const competitor = structuredClone(first); competitor.id = "competing-parent"; competitor.time = { created: 15 };
      competitor.content[0].id = "competing-call"; competitor.content[0].time = { created: 15, ran: 16, completed: 25 };
      if (firstRead) { entered(); await held; }
      return Response.json({ data: [first, ...(firstRead ? [] : [competitor])], cursor: {} });
    }
    if (route === `/api/session/${child}/message`) return Response.json({ data: [{ id: "child-outcome", type: "idle", time: { created: 20 }, outcome: "succeeded" }], cursor: {} });
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const abort = new AbortController();
  let pump: Promise<void> | undefined, older: ReturnType<typeof provider.listMessages> | undefined;
  try {
    parent = (await provider.createSession("Overlapping parent observations")).id;
    child = fake.launchRequestWorker(parent).childId; fake.settleWorker(child, "completed", "No parent report");
    pump = (async () => { for await (const event of provider.events(abort.signal)) if (event.eventType === "diagnostic.parent-output-applied") applied(); })();
    await provider.waitForEventStream!(abort.signal);
    older = provider.listMessages(parent, { limit: 100, signal: abort.signal });
    await reading;
    frame("session.message.content.updated", { sessionID: parent, messageID: "ordinary-output", content: [{ type: "text", text: "Parent streaming" }] });
    frame("diagnostic.parent-output-applied", {}); await observed;
    const current = await provider.listMessages(parent, { limit: 100, signal: abort.signal });
    expect(current.items.filter(item => item.type === "background_task")).toHaveLength(2);
    expect(current.items.filter(item => item.type === "background_task").every(item => item.status === "running")).toBe(true);
    expect(current.workerSource?.isCurrent()).toBe(true);
    release();
    const stale = await older;
    expect(stale.workerSource?.isCurrent()).toBe(false);
    expect(current.workerSource?.isCurrent()).toBe(true);
  } finally { release(); abort.abort(); await pump; await older?.catch(() => undefined); await provider.dispose!(); await fake.stop(); }
});

for (const read of ["retained-source", "adapter-history"] as const)
for (const change of ["competing-launch", "parent-output", "child-output", "different-child"] as const)
test(`${read} observes later parent history ${change} before SSE without requiring quiet output`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  let parent: string | undefined, child: string | undefined, otherChild: string | undefined, changed = false, armed = false, heldOnce = false;
  let entered!: () => void, release!: () => void;
  const atHandoff = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route.endsWith("/inbox")) return Response.json({ data: [] });
    const response = await fetch(request);
    if (route === `/api/session/${parent}/message`) {
      const body = await response.json(), first = body.data[0];
      first.time = { created: 10 }; first.content[0].time = { created: 10, ran: 11, completed: 12 };
      const competitor = structuredClone(first); competitor.id = "observed-parent-launch"; competitor.time = { created: 15 };
      competitor.content[0].id = "observed-parent-call"; competitor.content[0].time = { created: 15, ran: 16, completed: 25 };
      if (change === "different-child") competitor.content[0].state.metadata.sessionID = otherChild;
      return Response.json({ data: [first,
        ...(changed && (change === "competing-launch" || change === "different-child") ? [competitor] : []),
        ...(changed && change === "parent-output" ? [{ id: "later-parent-output", type: "assistant", time: { created: 30 }, content: [{ type: "text", text: "Parent output" }] }] : []),
      ], cursor: {} });
    }
    if (route === `/api/session/${child}/message`) return Response.json({ data: [
      { id: "child-outcome", type: "idle", time: { created: 20 }, outcome: "succeeded" },
      ...(changed && change === "child-output" ? [{ id: "later-child-output", type: "assistant", time: { created: 30 }, content: [{ type: "text", text: "Child output" }] }] : []),
    ], cursor: {} });
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const nativeRecovery = provider.reconcileBackgroundTasks!.bind(provider), abort = new AbortController();
  const sources: import("../../provider").WorkerSourceGuard[] = [];
  provider.reconcileBackgroundTasks = async (id, options) => {
    const tasks = await nativeRecovery(id, { ...options, onSource: source => {
      options?.onSource?.(source);
      if (armed) sources.push(source.workerSource.retain(abort.signal));
    } });
    if (armed && !heldOnce) { heldOnce = true; entered(); await held; }
    return tasks;
  };
  const adapter = read === "adapter-history" ? new ChatAdapter({ provider, workspacePath: directory, coalesceWindowMs: 0 }) : undefined;
  let pending: Promise<unknown> | undefined;
  try {
    parent = (await provider.createSession("Observed parent inventory counterproof")).id;
    const worker = fake.launchRequestWorker(parent); child = worker.childId;
    fake.settleWorker(child, "completed", "No parent report");
    if (change === "different-child") { otherChild = fake.launchRequestWorker(parent).childId; fake.settleWorker(otherChild, "completed", "No unrelated report"); }
    if (adapter) expect((await adapter.history(parent)).items).toContainEqual(expect.objectContaining({ taskId: worker.taskId, status: "completed" }));
    armed = true;
    pending = adapter ? adapter.history(parent) : provider.reconcileBackgroundTasks!(parent, { fresh: true, signal: abort.signal });
    void pending.catch(() => undefined);
    await atHandoff;
    expect(sources.every(source => source.isCurrent())).toBe(true);
    changed = true;
    const fresh = await nativeRecovery(parent, { fresh: true, signal: abort.signal });
    expect(fresh.find(task => task.taskId === worker.taskId)?.status).toBe(change === "competing-launch" ? "running" : "completed");
    release();
    if (adapter) {
      const snapshot = await pending as Awaited<ReturnType<ChatAdapter["history"]>>;
      expect(snapshot.items).toContainEqual(expect.objectContaining({ taskId: worker.taskId, status: change === "competing-launch" ? "running" : "completed" }));
    } else await pending;
    expect(sources.every(source => source.isCurrent())).toBe(change !== "competing-launch");
  } finally { release(); abort.abort(); await pending?.catch(() => undefined); if (adapter) await adapter.dispose(); else await provider.dispose!(); await fake.stop(); }
}, 10_000);

for (const read of ["listMessages", "reconcileBackgroundTasks", "adapter-history"] as const)
for (const change of read === "adapter-history" ? ["competing-launch", "ordinary-output"] as const : ["competing-launch", "ordinary-output", "replay"] as const)
for (const cachedTerminal of read === "adapter-history" && change === "competing-launch" ? [false, true] : [false])
for (const parentReport of cachedTerminal ? [false, true] : [false])
test(`${read} fences ${change} in the consumed parent launch inventory (cached terminal: ${cachedTerminal}, parent report: ${parentReport})`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  let parent: string | undefined, child: string | undefined, armed = false, heldOnce = false, changed = false;
  let first: any, competitor: any;
  let wire!: ReadableStreamDefaultController<Uint8Array>, entered!: () => void, release!: () => void, applied!: () => void;
  const atPublication = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const observed = new Promise<void>(resolve => { applied = resolve; });
  const frame = (type: string, data: unknown) => wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type, data, created: 30, location: { directory } })}\n\n`));
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route === "/api/event") return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      wire = controller; frame("server.connected", {});
      request.signal.addEventListener("abort", () => controller.close(), { once: true });
    } }), { headers: { "content-type": "text/event-stream" } });
    if (route.endsWith("/inbox")) return Response.json({ data: [] });
    const response = await fetch(request);
    if (route === `/api/session/${parent}/message`) {
      const body = await response.json(); first = body.data[0]; first.time = { created: 10 };
      first.content[0].time = { created: 10, ran: 11, completed: 12 };
      competitor = structuredClone(first); competitor.id = "competing-parent-message"; competitor.time = { created: 15 };
      competitor.content[0].id = "competing-call"; competitor.content[0].time = { created: 15, ran: 16, completed: 25 };
      return Response.json({ data: [first,
        ...(parentReport ? [{ id: "parent-result", type: "synthetic", time: { created: 13 }, text: "Explicit parent report", metadata: { source: "subagent", childID: child, state: "completed" } }] : []),
        ...(changed ? [competitor] : [])], cursor: {} });
    }
    if (route === `/api/session/${child}/message`) {
      if (armed && !heldOnce) { heldOnce = true; entered(); await held; }
      return Response.json({ data: armed || cachedTerminal ? [{ id: "child-outcome", type: "idle", time: { created: 20 }, outcome: "succeeded" }] : [], cursor: {} });
    }
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const nativeEvents = provider.events.bind(provider);
  provider.events = async function* (signal) { for await (const event of nativeEvents(signal)) {
    if (event.eventType === "diagnostic.parent-change-applied") applied();
    yield event;
  } };
  const abort = new AbortController();
  const adapter = read === "adapter-history" ? new ChatAdapter({ provider, workspacePath: directory, coalesceWindowMs: 0 }) : undefined;
  let pump: Promise<void> | undefined, recovery: Promise<any> | undefined;
  try {
    parent = (await provider.createSession("Parent competition publication race")).id;
    const worker = fake.launchRequestWorker(parent); child = worker.childId;
    fake.settleWorker(child, "completed", "No parent report");
    if (adapter) {
      const warm = await adapter.history(parent);
      expect(warm.items).toContainEqual(expect.objectContaining({ taskId: worker.taskId, status: cachedTerminal ? "completed" : "running" }));
    }
    else {
      pump = (async () => { for await (const _event of provider.events(abort.signal)) {} })();
      await provider.waitForEventStream!(abort.signal);
    }
    // A native ordinary update expires only transport reuse, not outcome proof.
    frame("session.message.content.updated", { sessionID: child, messageID: "later-assistant", content: [{ type: "text", text: "Output" }] });
    frame("diagnostic.parent-change-applied", {}); await observed;
    armed = true;
    recovery = read === "listMessages" ? provider.listMessages(parent, { limit: 100, signal: abort.signal })
      : adapter ? adapter.history(parent) : provider.reconcileBackgroundTasks!(parent, { fresh: true, signal: abort.signal });
    void recovery.catch(() => undefined);
    await atPublication;
    changed = change === "competing-launch";
    const processed = new Promise<void>(resolve => { applied = resolve; });
    frame("session.message.content.updated", { sessionID: parent,
      messageID: change === "ordinary-output" ? "ordinary-assistant" : changed ? competitor.id : first.id,
      content: change === "ordinary-output" ? [{ type: "text", text: "Parent output continues" }] : changed ? competitor.content : first.content });
    frame("diagnostic.parent-change-applied", {}); await processed; release();
    const result = await recovery.then(value => ({ value }), error => ({ error }));
    if ("value" in result) {
      const tasks = Array.isArray(result.value) ? result.value : result.value.items.filter((item: any) => item.type === "background_task");
      if (changed && read === "listMessages") expect(result.value.workerSource.isCurrent()).toBe(false);
      else expect(tasks.find((task: any) => task.taskId === worker.taskId)?.status).toBe(changed && !parentReport ? "running" : "completed");
      if (parentReport) expect(tasks.find((task: any) => task.taskId === worker.taskId)).toMatchObject({ resultId: "parent-result", summary: "Explicit parent report" });
    } else { expect(change).toBe("competing-launch"); expect(result.error).toBeInstanceOf(Error); }
    const fresh = await provider.reconcileBackgroundTasks!(parent, { fresh: true, signal: abort.signal });
    expect(fresh).toHaveLength(changed ? 2 : 1);
    expect(fresh.find(task => task.taskId === worker.taskId)?.status).toBe(changed && !parentReport ? "running" : "completed");
  } finally { release(); abort.abort(); await pump; await recovery?.catch(() => undefined); if (adapter) await adapter.dispose(); else await provider.dispose!(); await fake.stop(); }
}, 10_000);

for (const change of ["finished", "append"] as const)
test(`reconnected history-only activity observes ${change} after outcome-free child history consumption`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  let parent: string | undefined, child: string | undefined, captured = false, finished = false;
  let wire!: ReadableStreamDefaultController<Uint8Array>, entered!: () => void, release!: () => void, applied!: () => void;
  const atPublication = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const observed = new Promise<void>(resolve => { applied = resolve; });
  const frame = (type: string, data: unknown) => wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type, data, created: Date.now(), location: { directory } })}\n\n`));
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route === "/api/event") return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      wire = controller; frame("server.connected", {});
      request.signal.addEventListener("abort", () => controller.close(), { once: true });
    } }), { headers: { "content-type": "text/event-stream" } });
    if (route.endsWith("/inbox")) return Response.json({ data: [] });
    const response = await fetch(request);
    if (route === `/api/session/${child}/message`) return Response.json({ data: finished
      ? [{ id: "child-boundary", type: "idle", time: { created: Date.now() + 1_000 } }] : [], cursor: {} });
    if (route === `/api/session/${parent}` && captured) { entered(); await held; }
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const abort = new AbortController(), initialAbort = new AbortController();
  let pump: Promise<void> | undefined, initialPump: Promise<void> | undefined;
  let recovery: ReturnType<NonNullable<typeof provider.reconcileBackgroundTasks>> | undefined;
  try {
    initialPump = (async () => { for await (const _event of provider.events(initialAbort.signal)) {} })();
    await provider.waitForEventStream!(initialAbort.signal);
    initialAbort.abort(); await initialPump;
    parent = (await provider.createSession("Reconnect history-only activity race")).id;
    const worker = fake.launchRequestWorker(parent); child = worker.childId;
    pump = (async () => { for await (const event of provider.events(abort.signal)) if (event.eventType === "diagnostic.activity-applied") applied(); })();
    await provider.waitForEventStream!(abort.signal);
    recovery = provider.reconcileBackgroundTasks!(parent, { fresh: true, signal: abort.signal, onSource: () => { captured = true; } });
    void recovery.catch(() => undefined);
    await atPublication;
    if (change === "finished") {
      finished = true; fake.settleWorker(child, "completed", "No parent report");
      frame("session.execution.succeeded", { sessionID: child });
    } else frame("session.message.content.updated", { sessionID: child, messageID: "later-assistant", content: [{ type: "text", text: "Working output" }] });
    frame("diagnostic.activity-applied", {});
    await observed; release();
    const raced = await recovery.then(tasks => ({ tasks }), error => ({ error }));
    if (change === "append") expect(raced).toMatchObject({ tasks: [expect.objectContaining({ taskId: worker.taskId, activity: expect.objectContaining({ kind: "working", generation: 2 }) })] });
    else if ("tasks" in raced) expect(raced.tasks.every(task => task.activity?.kind !== "working")).toBe(true);
    else expect(raced.error).toBeInstanceOf(Error);
    const fresh = await provider.reconcileBackgroundTasks!(parent, { fresh: true, signal: abort.signal });
    expect(fresh[0]?.activity?.kind).toBe(change === "finished" ? "unavailable" : "working");
    expect(fresh[0]?.control?.available).not.toBe(true);
  } finally { release(); initialAbort.abort(); abort.abort(); await initialPump; await pump; await recovery?.catch(() => undefined); await provider.dispose!(); await fake.stop(); }
}, 10_000);

for (const directChild of [false, true])
test(`an overlapping older child response cannot revoke the later consumed history source (direct child: ${directChild})`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  let parent: string | undefined, child: string | undefined, reads = 0;
  let entered!: () => void, release!: () => void;
  let wire!: ReadableStreamDefaultController<Uint8Array>, applied!: () => void;
  const observed = new Promise<void>(resolve => { applied = resolve; });
  const frame = (type: string, data: unknown) => wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type, data, created: 50, location: { directory } })}\n\n`));
  const reading = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route === "/api/event") return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      wire = controller; frame("server.connected", {});
      request.signal.addEventListener("abort", () => controller.close(), { once: true });
    } }), { headers: { "content-type": "text/event-stream" } });
    if (route.endsWith("/inbox")) return Response.json({ data: [] });
    const response = await fetch(request);
    if (route === `/api/session/${parent}/message`) {
      const body = await response.json(); body.data[0].content[0].time = { created: 20, ran: 20, completed: 30 };
      return Response.json(body);
    }
    if (route === `/api/session/${child}/message`) {
      const first = ++reads === 1;
      if (first) { entered(); await held; }
      return Response.json({ data: [{ id: "idle-outcome", type: "idle", time: { created: 40 }, outcome: first ? "succeeded" : "failed" }], cursor: {} });
    }
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const abort = new AbortController();
  let older: ReturnType<typeof provider.listMessages> | undefined;
  let pump: Promise<void> | undefined;
  try {
    parent = (await provider.createSession("Overlapping child snapshots")).id;
    child = fake.launchRequestWorker(parent).childId; fake.settleWorker(child, "completed", "No parent report");
    pump = (async () => { for await (const event of provider.events(abort.signal)) if (event.eventType === "diagnostic.append-applied") applied(); })();
    await provider.waitForEventStream!(abort.signal);
    older = provider.listMessages(parent, { limit: 100, signal: abort.signal });
    await reading;
    frame("session.message.content.updated", { sessionID: child, messageID: "later-assistant", content: [{ type: "text", text: "Continued output" }] });
    frame("diagnostic.append-applied", {});
    await observed;
    const current = await provider.listMessages(directChild ? child : parent, { limit: 100, signal: abort.signal });
    if (!directChild) expect(current.items).toContainEqual(expect.objectContaining({ type: "background_task", status: "failed" }));
    expect(current.workerSource?.isCurrent()).toBe(true);
    release();
    const stale = await older;
    expect(stale.workerSource?.isCurrent()).toBe(false);
    expect(current.workerSource?.isCurrent()).toBe(true);
  } finally { release(); abort.abort(); await pump; await older?.catch(() => undefined); await provider.dispose!(); await fake.stop(); }
});

for (const change of ["remove", "alter", "append"] as const)
test(`a later nonoverlapping child history ${change} fences only changed consumed outcome evidence`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  let parent: string | undefined, child: string | undefined, changed = false;
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route.endsWith("/inbox")) return Response.json({ data: [] });
    const response = await fetch(request);
    if (route === `/api/session/${parent}/message`) {
      const body = await response.json(); body.data[0].time = { created: 20 };
      body.data[0].content[0].time = { created: 20, ran: 20, completed: 30 };
      body.data.push({ id: "parent-hidden", type: "user", text: "Staged suffix", time: { created: 60 } });
      return Response.json(body);
    }
    if (route === `/api/session/${child}/message`) return Response.json({ data: [
      ...(changed && change === "remove" ? [] : [{ id: "idle-outcome", type: "idle", time: { created: 40 }, outcome: changed && change === "alter" ? "failed" : "succeeded" }]),
      ...(changed && change === "append" ? [{ id: "later-assistant", type: "assistant", time: { created: 50 }, content: [{ type: "text", text: "Continued output" }] }] : []),
    ], cursor: {} });
    if (route === `/api/session/${parent}`) {
      const body = await response.json(); body.data.revert = { messageID: "parent-hidden" };
      return Response.json(body);
    }
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  try {
    parent = (await provider.createSession("Observed committed child history")).id;
    const worker = fake.launchRequestWorker(parent); child = worker.childId;
    fake.settleWorker(child, "completed", "No parent report");
    // Both child session lookups have a null revert boundary. No SSE is sent.
    const raced = await provider.reconcileBackgroundTasks!(parent, { fresh: true, onSource: () => { changed = true; } })
      .then(tasks => ({ tasks }), error => ({ error }));
    if (change === "append") expect(raced).toMatchObject({ tasks: [expect.objectContaining({ taskId: worker.taskId, status: "completed" })] });
    else if ("tasks" in raced) expect(raced.tasks).toContainEqual(expect.objectContaining({ taskId: worker.taskId, status: change === "alter" ? "failed" : "running" }));
    else expect(raced.error).toBeInstanceOf(Error);
    const fresh = await provider.reconcileBackgroundTasks!(parent, { fresh: true });
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).toMatchObject({ taskId: worker.taskId, status: change === "remove" ? "running" : change === "alter" ? "failed" : "completed" });
    expect(fresh[0]?.control?.available).not.toBe(true);
  } finally { await provider.dispose!(); await fake.stop(); }
});

for (const read of ["history", "workerEvidence"] as const)
test(`covered ${read} finishes while a consumed child keeps appending output`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  let parent: string | undefined, child: string | undefined, consumed = false, streaming = false, outputUpdates = 0;
  let wire!: ReadableStreamDefaultController<Uint8Array>;
  const barriers = new Map<string, () => void>();
  const frame = (type: string, data: unknown) => wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type, data, created: 50, location: { directory } })}\n\n`));
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route === "/api/event") return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      wire = controller; frame("server.connected", {});
      request.signal.addEventListener("abort", () => controller.close(), { once: true });
    } }), { headers: { "content-type": "text/event-stream" } });
    if (route.endsWith("/inbox")) return Response.json({ data: [] });
    const response = await fetch(request);
    if (route === `/api/session/${parent}/message`) {
      const body = await response.json(); body.data[0].content[0].time = { created: 20, ran: 20, completed: 30 };
      return Response.json(body);
    }
    if (route === `/api/session/${child}/message`) {
      consumed = true;
      return Response.json({ data: [{ id: "idle-outcome", type: "idle", time: { created: 40 }, outcome: "succeeded" }], cursor: {} });
    }
    if (route === `/api/session/${parent}` && consumed && streaming) {
      // Every attempt overlaps output. A retry cannot buy a quiet child.
      const sequence = ++outputUpdates, diagnostic = `diagnostic.output-applied-${sequence}`;
      const observed = new Promise<void>(resolve => {
        barriers.set(diagnostic, resolve);
        request.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      frame("session.message.content.updated", { sessionID: child, messageID: "later-assistant", content: [{ type: "text", text: `Output ${sequence}` }] });
      frame(diagnostic, {});
      await observed;
    }
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const events = provider.events.bind(provider);
  provider.events = async function* (signal) { for await (const event of events(signal)) {
    barriers.get(event.eventType)?.();
    yield event;
  } };
  const adapter = new ChatAdapter({ provider, workspacePath: directory, coalesceWindowMs: 0, historyReadTimeoutMs: 1_000 });
  try {
    parent = (await provider.createSession("Covered streaming child")).id;
    child = fake.launchRequestWorker(parent).childId;
    fake.settleWorker(child, "completed", "No parent report");
    await adapter.history(parent);
    streaming = true;
    const result = await adapter[read](parent);
    expect(outputUpdates).toBeGreaterThan(0);
    if ("items" in result) expect(result.items).toContainEqual(expect.objectContaining({ type: "background_task", status: "completed" }));
    else { expect(result.complete).toBe(true); expect(result.entries).toHaveLength(1); }
  } finally { await adapter.dispose(); await fake.stop(); }
}, 10_000);

for (const mutation of ["append", "alter-outcome", "remove", "revert"] as const)
test(`consumed child outcomes allow ${mutation} progress only when their proof is unchanged`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  let parent: string | undefined, child: string | undefined, consumed = false;
  let wire!: ReadableStreamDefaultController<Uint8Array>, entered!: () => void, release!: () => void, applied!: () => void;
  const atPublication = new Promise<void>(resolve => { entered = resolve; });
  const publication = new Promise<void>(resolve => { release = resolve; });
  const observed = new Promise<void>(resolve => { applied = resolve; });
  const frame = (type: string, data: unknown) => wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type, data, created: 50, location: { directory } })}\n\n`));
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route === "/api/event") return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      wire = controller; frame("server.connected", {});
      request.signal.addEventListener("abort", () => controller.close(), { once: true });
    } }), { headers: { "content-type": "text/event-stream" } });
    if (route.endsWith("/inbox")) return Response.json({ data: [] });
    const response = await fetch(request);
    if (route === `/api/session/${parent}/message`) {
      const body = await response.json(); body.data[0].content[0].time = { created: 20, ran: 20, completed: 30 };
      return Response.json(body);
    }
    if (route === `/api/session/${child}/message`) {
      consumed = true;
      return Response.json({ data: [{ id: "idle-outcome", type: "idle", time: { created: 40 }, outcome: "succeeded" }], cursor: {} });
    }
    if (route === `/api/session/${parent}` && consumed) { entered(); await publication; }
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(5_000)]);
  let pump: Promise<void> | undefined, recovery: ReturnType<NonNullable<typeof provider.reconcileBackgroundTasks>> | undefined;
  try {
    parent = (await provider.createSession("Streaming resumed child")).id;
    const worker = fake.launchRequestWorker(parent); child = worker.childId;
    fake.settleWorker(child, "completed", "No parent report");
    pump = (async () => { for await (const event of provider.events(signal)) if (event.eventType === "diagnostic.mutation-applied") applied(); })();
    await provider.waitForEventStream!(signal);
    const sources: import("../../provider").WorkerSourceGuard[] = [];
    recovery = provider.reconcileBackgroundTasks!(parent, { fresh: true, signal, onSource: source => sources.push(source.workerSource.retain(signal)) });
    void recovery.catch(() => undefined);
    await atPublication;
    if (mutation === "append") {
      // A later assistant message and successive streaming snapshots leave the
      // older typed idle outcome and its execution interval untouched.
      for (const text of ["New", "New output", "New output continues"]) frame("session.message.content.updated", {
        sessionID: child, messageID: "later-assistant", content: [{ type: "text", text }],
      });
    } else if (mutation === "alter-outcome") frame("session.message.content.updated", {
      sessionID: child, messageID: "idle-outcome", content: [{ type: "text", text: "Replacement" }],
    });
    else if (mutation === "remove") frame("session.revert.committed", { sessionID: child, to: "idle-outcome" });
    else frame("session.revert.staged", { sessionID: child, revert: { messageID: "idle-outcome" } });
    frame("diagnostic.mutation-applied", {});
    await observed; release();
    if (mutation === "append") {
      expect(await recovery).toContainEqual(expect.objectContaining({ taskId: worker.taskId, status: "completed" }));
      expect(sources.every(source => source.isCurrent())).toBe(true);
    } else await expect(recovery).rejects.toThrow();
  } finally { release(); abort.abort(); await pump; await recovery?.catch(() => undefined); await provider.dispose!(); await fake.stop(); }
}, 10_000);

test("an observed child staged revert between inventory and parent visibility cannot retain an earlier outcome", async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  let parent: string | undefined, child: string | undefined, staged = false;
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route.endsWith("/inbox")) return Response.json({ data: [] });
    const response = await fetch(request);
    if (route === `/api/session/${parent}/message`) {
      const body = await response.json();
      body.data[0].time = { created: 20 };
      body.data[0].content[0].time = { created: 20, ran: 20, completed: 30 };
      body.data.push({ id: "parent-hidden", type: "user", text: "Hidden suffix", time: { created: 60 } });
      return Response.json(body);
    }
    if (route === `/api/session/${child}/message`) return Response.json({ data: [
      { id: "child-hidden", type: "user", text: "Reverted input", time: { created: 35 } },
      { id: "idle-outcome", type: "idle", time: { created: 40 }, outcome: "succeeded" },
    ], cursor: {} });
    if (route === `/api/session/${parent}` || route === `/api/session/${child}`) {
      const body = await response.json();
      if (route === `/api/session/${parent}`) body.data.revert = { messageID: "parent-hidden" };
      else if (staged) body.data.revert = { messageID: "child-hidden" };
      return Response.json(body);
    }
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  try {
    parent = (await provider.createSession("Observed child visibility race")).id;
    const worker = fake.launchRequestWorker(parent); child = worker.childId;
    fake.settleWorker(child, "completed", "No parent report");
    const raced = await provider.reconcileBackgroundTasks!(parent, { fresh: true, onSource: () => { staged = true; } })
      .then(tasks => ({ tasks }), error => ({ error }));
    // No SSE event is sent: the fresh native lookup itself observes the change.
    if ("tasks" in raced) {
      expect(raced.tasks).toContainEqual(expect.objectContaining({ taskId: worker.taskId, status: "running", stateUncertain: true }));
      expect(raced.tasks[0]?.control?.available).not.toBe(true);
    } else expect(raced.error).toBeInstanceOf(Error);
    const fresh = await provider.reconcileBackgroundTasks!(parent, { fresh: true });
    expect(fresh).toContainEqual(expect.objectContaining({ taskId: worker.taskId, status: "running", stateUncertain: true }));
    expect(fresh[0]?.control?.available).not.toBe(true);
  } finally { await provider.dispose!(); await fake.stop(); }
});

for (const scope of ["dependent", "unrelated"] as const)
test(`an outcome first consumed by a staged parent visibility reread fences ${scope} mutation through publication`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  let parent: string | undefined, child: string | undefined, captured = false, outcome = false, consumed = false, reverted = false;
  let wire!: ReadableStreamDefaultController<Uint8Array>, entered!: () => void, release!: () => void, completed!: () => void, applied!: () => void;
  const atPublication = new Promise<void>(resolve => { entered = resolve; });
  const publication = new Promise<void>(resolve => { release = resolve; });
  const executionApplied = new Promise<void>(resolve => { completed = resolve; });
  const revertApplied = new Promise<void>(resolve => { applied = resolve; });
  const frame = (type: string, data: unknown, created = 50) => wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type, data, created, location: { directory } })}\n\n`));
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route === "/api/event") return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      wire = controller; frame("server.connected", {});
      request.signal.addEventListener("abort", () => controller.close(), { once: true });
    } }), { headers: { "content-type": "text/event-stream" } });
    if (route.endsWith("/inbox")) return Response.json({ data: [] });
    const response = await fetch(request);
    if (route === `/api/session/${parent}/message`) {
      const body = await response.json();
      body.data[0].time = { created: 20 };
      body.data[0].content[0].time = { created: 20, ran: 20, completed: 30 };
      body.data.push({ id: "parent-hidden", type: "user", text: "Hidden suffix", time: { created: 60 } });
      return Response.json(body);
    }
    if (route === `/api/session/${child}/message`) {
      if (outcome) consumed = true;
      return Response.json({ data: outcome && !reverted ? [
        { id: "child-reverted", type: "user", text: "Reversible input", time: { created: 35 } },
        { id: "idle-outcome", type: "idle", time: { created: 40 }, outcome: "succeeded" },
      ] : [], cursor: {} });
    }
    if (route === `/api/session/${parent}`) {
      if (captured) await executionApplied;
      if (consumed) { entered(); await publication; }
      const body = await response.json(); body.data.revert = { messageID: "parent-hidden" };
      return Response.json(body);
    }
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(5_000)]);
  let pump: Promise<void> | undefined, recovery: ReturnType<NonNullable<typeof provider.reconcileBackgroundTasks>> | undefined;
  try {
    parent = (await provider.createSession("Late visibility outcome")).id;
    const worker = fake.launchRequestWorker(parent); child = worker.childId;
    const unrelatedParent = (await provider.createSession("Unrelated visibility source")).id;
    const unrelatedChild = fake.launchRequestWorker(unrelatedParent).childId;
    pump = (async () => { for await (const event of provider.events(signal)) {
      if (event.eventType === "diagnostic.execution-applied") completed();
      if (event.eventType === "diagnostic.revert-applied") applied();
    } })();
    await provider.waitForEventStream!(signal);
    recovery = provider.reconcileBackgroundTasks!(parent, { fresh: true, signal, onSource: () => {
      if (captured) return;
      captured = true; outcome = true;
      frame("session.execution.succeeded", { sessionID: child }, 40);
      frame("diagnostic.execution-applied", {});
    } });
    void recovery.catch(() => undefined);
    await atPublication;
    reverted = scope === "dependent";
    frame("session.revert.committed", { sessionID: scope === "dependent" ? child : unrelatedChild, to: "child-reverted" });
    frame("diagnostic.revert-applied", {});
    await revertApplied; release();
    if (scope === "dependent") {
      const result = await recovery.then(tasks => ({ tasks }), error => ({ error }));
      expect(result).toMatchObject({ error: expect.any(Error) });
    }
    else expect(await recovery).toContainEqual(expect.objectContaining({ taskId: worker.taskId, status: "completed" }));
    const fresh = await provider.reconcileBackgroundTasks!(parent, { fresh: true, signal });
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).toMatchObject({ taskId: worker.taskId, status: scope === "dependent" ? "running" : "completed" });
    expect(fresh[0]?.control?.available).not.toBe(true);
  } finally { release(); abort.abort(); await pump; await recovery?.catch(() => undefined); await provider.dispose!(); await fake.stop(); }
}, 10_000);

test("fresh parent outcomes follow child staged, cleared and committed visibility", async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  let parent: string | undefined, child: string | undefined;
  let visibility: "staged" | "cleared" | "committed" = "staged";
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route.endsWith("/inbox")) return Response.json({ data: [] });
    const response = await fetch(request);
    if (route === `/api/session/${parent}/message`) {
      const body = await response.json();
      body.data[0].content[0].time = { created: 20, ran: 20, completed: 30 };
      return Response.json(body);
    }
    if (route === `/api/session/${child}/message`) return Response.json({ data: [
      { id: "child-kept", type: "user", time: { created: 10 }, text: "Kept prefix" },
      ...(visibility === "committed" ? [] : [
        { id: "child-reverted", type: "user", time: { created: 35 }, text: "Staged suffix" },
        { id: "idle-outcome", type: "idle", time: { created: 40 }, outcome: "succeeded" },
      ]),
    ], cursor: {} });
    if (route === `/api/session/${child}`) {
      const body = await response.json();
      if (visibility === "staged") body.data.revert = { messageID: "child-reverted" };
      return Response.json(body);
    }
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  try {
    parent = (await provider.createSession("Child visibility outcome recovery")).id;
    const worker = fake.launchRequestWorker(parent); child = worker.childId;
    fake.settleWorker(child, "completed", "No parent report");
    const read = async (status: "running" | "completed") => {
      const tasks = await provider.reconcileBackgroundTasks!(parent!, { fresh: true });
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toMatchObject({ taskId: worker.taskId, status, stateUncertain: status === "running" });
      expect(tasks[0]?.control?.available).not.toBe(true);
      expect(tasks[0]?.resultId).toBeUndefined();
      expect(tasks[0]?.summary).toBeUndefined();
    };
    await read("running");
    visibility = "cleared";
    await read("completed");
    visibility = "staged";
    await read("running");
    visibility = "committed";
    await read("running");
  } finally { await provider.dispose!(); await fake.stop(); }
});

for (const scope of ["dependent", "unrelated"] as const)
for (const lifecycle of ["committed", "staged", "cleared"] as const)
test(`a ${scope} child revert ${lifecycle} after history consumption fences only dependent parent publication`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  let parent: string | undefined, child: string | undefined, consumed = false, reverted = false, held = false;
  let wire!: ReadableStreamDefaultController<Uint8Array>, entered!: () => void, release!: () => void, applied!: () => void;
  const atPublication = new Promise<void>(resolve => { entered = resolve; });
  const publication = new Promise<void>(resolve => { release = resolve; });
  const observed = new Promise<void>(resolve => { applied = resolve; });
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route === "/api/event") return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      wire = controller; controller.enqueue(new TextEncoder().encode('data: {"type":"server.connected","data":{}}\n\n'));
      request.signal.addEventListener("abort", () => controller.close(), { once: true });
    } }), { headers: { "content-type": "text/event-stream" } });
    if (route.endsWith("/inbox")) return Response.json({ data: [] });
    const response = await fetch(request);
    if (route === `/api/session/${parent}/message`) {
      const body = await response.json();
      body.data[0].content[0].time = { created: 20, ran: 20, completed: 30 };
      return Response.json(body);
    }
    if (route === `/api/session/${child}/message`) {
      consumed = true;
      return Response.json({ data: reverted && lifecycle === "committed" ? [] : [
        { id: "child-reverted", type: "user", time: { created: 35 }, text: "Reversible child input" },
        { id: "idle-outcome", type: "idle", time: { created: 40 }, outcome: "succeeded" },
      ], cursor: {} });
    }
    if (route === `/api/session/${child}`) {
      const body = await response.json();
      if (reverted && lifecycle === "staged" || scope === "dependent" && !reverted && lifecycle === "cleared") {
        body.data.revert = { messageID: "child-reverted" };
      }
      return Response.json(body);
    }
    // This lookup is reached only after the child transcript has been folded.
    // Holding the child response itself would not exercise publication leases.
    if (route === `/api/session/${parent}` && consumed && !held) {
      held = true; entered(); await publication;
    }
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(5_000)]);
  let pump: Promise<void> | undefined, recovery: ReturnType<NonNullable<typeof provider.reconcileBackgroundTasks>> | undefined;
  try {
    parent = (await provider.createSession("Consumed outcome publication fence")).id;
    const worker = fake.launchRequestWorker(parent); child = worker.childId;
    fake.settleWorker(child, "completed", "Do not invent a parent report");
    const unrelatedParent = (await provider.createSession("Independent recovery source")).id;
    const unrelatedChild = fake.launchRequestWorker(unrelatedParent).childId;
    pump = (async () => { for await (const event of provider.events(signal)) if (event.eventType === "diagnostic.revert-applied") applied(); })();
    await provider.waitForEventStream!(signal);
    recovery = provider.reconcileBackgroundTasks!(parent, { fresh: true, signal });
    void recovery.catch(() => undefined);
    await atPublication;
    reverted = scope === "dependent";
    const changedChild = scope === "dependent" ? child : unrelatedChild;
    for (const event of [
      { id: "event-child-reverted", type: `session.revert.${lifecycle}`, created: 50, durable: { aggregateID: changedChild, seq: 1, version: 1 }, data: {
        sessionID: changedChild, ...(lifecycle === "committed" ? { to: "child-reverted" } : lifecycle === "staged" ? { revert: { messageID: "child-reverted" } } : {}),
      } },
      { type: "diagnostic.revert-applied", data: {} },
    ]) wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ ...event, location: { directory } })}\n\n`));
    await observed; release();
    if (scope === "dependent") await expect(recovery).rejects.toThrow();
    else expect(await recovery).toContainEqual(expect.objectContaining({ taskId: worker.taskId, status: "completed", stateUncertain: false }));
    const fresh = await provider.reconcileBackgroundTasks!(parent, { fresh: true, signal });
    expect(fresh).toHaveLength(1);
    const unresolved = scope === "dependent" && lifecycle !== "cleared";
    expect(fresh[0]).toMatchObject({ taskId: worker.taskId, status: unresolved ? "running" : "completed", stateUncertain: unresolved });
    expect(fresh[0]?.control?.available).not.toBe(true);
    expect(fresh[0]?.resultId).toBeUndefined();
    expect(fresh[0]?.summary).toBeUndefined();
  } finally { release(); abort.abort(); await pump; await recovery?.catch(() => undefined); await provider.dispose!(); await fake.stop(); }
}, 10_000);
