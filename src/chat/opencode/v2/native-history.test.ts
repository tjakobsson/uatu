import { expect, spyOn, test } from "bun:test";
import { OpenCode } from "@opencode/client";
import { readFileSync } from "node:fs";
import { V2NativeHistory } from "./native-history";
import { SessionChanges } from "./session-changes";

const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
};

test("a retired native reply denies replacement reuse without replacing truth or starting IO", async () => {
  const entered = gate(), held = gate();
  let reads = 0, historyClock = 0, recordClock = 0;
  const observed: unknown[] = [];
  const client = OpenCode.make({ baseUrl: "http://native.test", fetch: (async () => {
    const read = ++reads;
    if (read === 1) { entered.release(); await held.promise; }
    return Response.json({ data: [{ id: "idle", type: "idle", time: { created: 40 }, outcome: read === 1 ? "succeeded" : "failed" }], cursor: {} });
  }) as unknown as typeof fetch });
  const history = new V2NativeHistory({ client, directory: process.cwd(), version: () => "1",
    snapshotRecord: () => undefined, observeInbox: () => {}, inboxFacts: () => undefined,
    historyOrder: { current: () => historyClock, next: () => ++historyClock },
    recordOrder: { current: () => recordClock, next: () => ++recordClock },
    readSignal: signal => signal, observeHistory: (_id, messages) => { observed.push(messages); }, observeRecord: () => {},
  });
  const signal = new AbortController().signal;
  try {
    const old = history.complete("child", signal); await entered.promise;
    history.invalidate("child");
    const replacement = await history.complete("child", signal);
    expect(replacement.messages[0]!.outcome).toBe("failed");
    held.release();
    expect((await old).messages[0]!.outcome).toBe("succeeded");
    expect(reads).toBe(2);
    expect(observed).toHaveLength(2);
    expect((await history.complete("child", signal)).messages[0]!.outcome).toBe("failed");
    expect(reads).toBe(3);
    const cached = await history.complete("child", signal);
    expect(cached.nativeReadOrder).toEqual({ started: 5, completed: 6 });
    expect(reads).toBe(3);
  } finally { held.release(); history.dispose(); }
});

const fixture = JSON.parse(readFileSync(new URL("../../../../tests/fixtures/opencode-v2/background-2.0.29.json", import.meta.url), "utf8"));
const signal = () => new AbortController().signal;
function nativeHarness(handler: (request: Request) => Response | Promise<Response>) {
  let historyClock = 0, recordClock = 0, version: string | undefined = "1";
  const changes = new SessionChanges(1);
  const observations: Array<{ session: string; messages: unknown[] }> = [], records: unknown[] = [];
  const client = OpenCode.make({ baseUrl: "http://native.test", fetch: (async (input: Request | string | URL, init?: RequestInit) => handler(new Request(input, init))) as typeof fetch });
  const history = new V2NativeHistory({ client, directory: process.cwd(), version: () => version,
    snapshotRecord: session => changes.snapshotRecord(session),
    observeInbox: (session, entries, facts) => changes.observeInbox(session, entries, facts),
    inboxFacts: session => changes.inboxFacts(session),
    historyOrder: { current: () => historyClock, next: () => ++historyClock },
    recordOrder: { current: () => recordClock, next: () => ++recordClock }, readSignal: signal => signal,
    observeHistory: (session, messages) => { observations.push({ session, messages }); },
    observeRecord: (value, requestedId) => {
      records.push(value);
      const id = requestedId ?? (value as { id?: string }).id;
      if (id) changes.observe(id, "record", value);
    },
  });
  return { history, client, changes, observations, records, generation(value: string | undefined) { version = value; history.invalidate(); } };
}
const raw = (data: unknown[], next?: string) => Response.json({ data, cursor: { next } });

for (const phase of ["pending", "installed"] as const)
for (const change of ["record", "identical", "aba", "disjoint", "history", "inbox", "active", "unknown", "evicted", "recreated", "clear-before"] as const)
test(`existing record snapshot qualifies only its entry lifetime (${phase}/${change})`, async () => {
  const entered = gate(), release = gate(); let reads = 0;
  const h = nativeHarness(async () => { if (++reads === 1) { entered.release(); await release.promise; } return raw([]); });
  const record = (title: string) => ({ id: "child", location: { directory: process.cwd() }, title });
  const observe = (title: string) => h.history.records(async () => record(title), value => [{ value }]);
  let warm: ReturnType<V2NativeHistory["complete"]> | undefined;
  try {
    if (change !== "unknown") await observe("A");
    if (change === "clear-before") await observe("B");
    warm = h.history.complete("child", signal()); await entered.promise;
    if (phase === "installed") { release.release(); await warm; }
    if (change === "record" || change === "aba") await observe("B");
    if (change === "aba" || change === "identical" || change === "unknown") await observe("A");
    if (change === "history" || change === "inbox" || change === "active") h.changes.observe("child", change, ["changed"], true);
    if (change === "disjoint") {
      // Pin the existing session only in this control, so a distinct record is
      // not conflated with the separately tested capacity-one eviction case.
      const pin = h.changes.capture("child");
      await h.history.records(async () => ({ ...record("Other"), id: "other" }), value => [{ value }]);
      pin.release();
    }
    if (change === "evicted" || change === "recreated") {
      h.changes.observe("other", "record", {});
      if (change === "recreated") await observe("A");
    }
    expect(reads).toBe(1); // No record observation or token check starts IO.
    release.release(); expect((await warm).messages).toEqual([]);
    expect(reads).toBe(1); // Healthy waiter finishes without retrying.
    const denied = ["record", "aba", "evicted", "recreated"].includes(change);
    expect((await h.history.complete("child", signal())).messages).toEqual([]);
    expect(reads).toBe(denied ? 2 : 1);
    await h.history.complete("child", signal());
    expect(reads).toBe(denied ? 2 : 1); // A separate quiet read reuses the replacement.
  } finally { release.release(); await warm?.catch(() => {}); h.history.dispose(); }
});

// Native qualification scenarios live at complete/inbox/records. Public worker
// suites separately retain outcome, identity, activity and dismissal assertions.
for (const phase of ["pending", "installed"] as const)
for (const evidence of ["relevant", "empty", "disjoint", "covered", "prelaunch", "other-child", "overflow"] as const)
test(`inbox qualification at native completion (${phase}/${evidence})`, async () => {
  const inboxEntered = gate(), inboxRelease = gate(), rawEntered = gate(), rawRelease = gate();
  let reads = 0;
  const result = structuredClone(fixture.pending);
  result.time.created = evidence === "prelaunch" ? 5 : 45;
  if (evidence === "other-child") result.payload.metadata.childID = "other";
  const stored = { ...result.payload, id: result.id, type: result.type, time: result.time };
  const messages = [fixture.launch, ...(evidence === "covered" ? [stored] : [])];
  const h = nativeHarness(async request => {
    if (new URL(request.url).pathname.endsWith("/inbox")) {
      inboxEntered.release(); await inboxRelease.promise;
      return Response.json({ data: evidence === "empty" ? [] : evidence === "overflow"
        ? Array.from({ length: 257 }, (_, index) => ({ ...result, id: `report-${index}` })) : [result] });
    }
    if (++reads === 1) { rawEntered.release(); await rawRelease.promise; }
    return raw(messages);
  });
  let pending: ReturnType<V2NativeHistory["inbox"]> | undefined, warm: ReturnType<V2NativeHistory["complete"]> | undefined;
  try {
    pending = h.history.inbox(evidence === "disjoint" ? "other-parent" : "parent", signal());
    await inboxEntered.promise;
    warm = h.history.complete("parent", signal()); await rawEntered.promise;
    if (phase === "installed") { rawRelease.release(); await warm; }
    inboxRelease.release(); const reply = await pending;
    expect(reply.entries).toHaveLength(evidence === "empty" ? 0 : evidence === "overflow" ? 257 : 1);
    expect(reply.observation.overflow).toBe(evidence === "overflow" ? true : undefined);
    expect(reads).toBe(1); // No retry or validation IO at contradiction.
    rawRelease.release(); expect((await warm).messages).toEqual(messages);
    const denied = evidence !== "empty" && evidence !== "disjoint"
      && (phase === "pending" || evidence === "relevant" || evidence === "overflow");
    expect((await h.history.complete("parent", signal())).messages).toEqual(messages);
    expect(reads).toBe(denied ? 2 : 1);
  } finally { inboxRelease.release(); rawRelease.release(); await pending?.catch(() => {}); await warm?.catch(() => {}); h.history.dispose(); }
});

for (const phase of ["pending", "installed"] as const)
for (const scope of ["same", "disjoint", "foreign", "wrong-id", "unchanged", "stage-only"] as const)
test(`records qualify before returned-record filtering (${phase}/${scope})`, async () => {
  const entered = gate(), release = gate(); let reads = 0;
  const h = nativeHarness(async () => { if (++reads === 1) { entered.release(); await release.promise; } return raw([]); });
  const record = (staged: boolean) => ({ id: scope === "wrong-id" ? "wrong" : scope === "disjoint" ? "other" : "child",
    location: { directory: scope === "foreign" ? "/foreign" : process.cwd() }, ...(staged ? { revert: { messageID: "hidden" } } : {}) });
  const observe = (staged: boolean) => {
    const value = { data: [record(staged)] };
    return h.history.records(async () => value, reply => reply.data.map(value => ({ value, requestedId: scope === "wrong-id" ? "child" : undefined })));
  };
  let warm: ReturnType<V2NativeHistory["complete"]> | undefined;
  try {
    warm = h.history.complete("child", signal()); await entered.promise;
    if (phase === "installed") { release.release(); await warm; }
    const staged = await observe(true);
    expect(staged.data[0]).toEqual(record(true));
    if (scope !== "stage-only") await observe(scope === "unchanged");
    expect(h.records).toHaveLength(scope === "stage-only" ? 1 : 2);
    expect(reads).toBe(1);
    release.release(); await warm;
    await h.history.complete("child", signal());
    expect(reads).toBe(scope === "same" ? 2 : 1);
  } finally { release.release(); await warm?.catch(() => {}); h.history.dispose(); }
});

for (const scope of ["different", "equal", "disjoint", "before-replacement", "replacement-pending"] as const)
test(`retired complete read qualifies only established replacement content (${scope})`, async () => {
  const entered = gate(), release = gate(), newerEntered = gate(), newerRelease = gate(); let reads = 0;
  const h = nativeHarness(async request => {
    const old = ++reads === 1;
    if (old) { entered.release(); await release.promise; }
    else if (scope === "replacement-pending" && reads === 2) { newerEntered.release(); await newerRelease.promise; }
    return raw([{ id: "idle", type: "idle", outcome: old && scope !== "equal" ? "succeeded" : "failed" }]);
  });
  let old: ReturnType<V2NativeHistory["complete"]> | undefined, replacement: ReturnType<V2NativeHistory["complete"]> | undefined;
  try {
    old = h.history.complete(scope === "disjoint" ? "other" : "child", signal()); await entered.promise;
    h.history.invalidate();
    if (scope === "before-replacement") { release.release(); await old; }
    replacement = h.history.complete("child", signal());
    if (scope === "replacement-pending") { await newerEntered.promise; release.release(); await old; newerRelease.release(); }
    expect((await replacement).messages[0]!.outcome).toBe("failed");
    release.release(); await old;
    expect(reads).toBe(2);
    expect(h.observations).toHaveLength(2); // Retired returns are still observed.
    expect((await h.history.complete("child", signal())).messages[0]!.outcome).toBe("failed");
    expect(reads).toBe(scope === "different" || scope === "replacement-pending" ? 3 : 2);
  } finally { release.release(); newerRelease.release(); await old?.catch(() => {}); await replacement?.catch(() => {}); h.history.dispose(); }
});

for (const phase of ["pending", "installed"] as const)
for (const transition of ["stage-clear", "stage-only", "unchanged", "disjoint", "before-registration"] as const)
test(`earlier record request qualifies warm history at completion (${phase}/${transition})`, async () => {
  const recordEntered = gate(), recordRelease = gate(), rawEntered = gate(), rawRelease = gate();
  let reads = 0, removed = false;
  const h = nativeHarness(async () => {
    const data = removed ? [] : [{ id: "idle", type: "idle", outcome: "succeeded" }];
    if (++reads === 1) { rawEntered.release(); await rawRelease.promise; }
    return raw(data);
  });
  const record = (stage: boolean) => ({ id: transition === "disjoint" ? "other" : "child", location: { directory: process.cwd() }, ...(stage ? { revert: { messageID: "idle" } } : {}) });
  let older: ReturnType<typeof h.history.records> | undefined, warm: ReturnType<V2NativeHistory["complete"]> | undefined;
  try {
    older = h.history.records(async () => { recordEntered.release(); await recordRelease.promise; return record(transition !== "unchanged"); }, value => [{ value }]);
    await recordEntered.promise;
    if (transition === "before-registration") { recordRelease.release(); await older; }
    warm = h.history.complete("child", signal()); await rawEntered.promise;
    if (phase === "installed") { rawRelease.release(); await warm; }
    recordRelease.release(); await older;
    if (transition !== "stage-only") await h.history.records(async () => record(false), value => [{ value }]);
    removed = transition === "stage-clear";
    rawRelease.release(); expect((await warm).messages).toHaveLength(1);
    expect(reads).toBe(1);
    const next = await h.history.complete("child", signal());
    expect(next.messages).toHaveLength(removed ? 0 : 1);
    expect(reads).toBe(removed || transition === "before-registration" ? 2 : 1);
  } finally { recordRelease.release(); rawRelease.release(); await older?.catch(() => {}); await warm?.catch(() => {}); h.history.dispose(); }
});

test("complete history paginates, deduplicates and preserves native order on reuse", async () => {
  const requests: URL[] = [];
  const h = nativeHarness(request => {
    const url = new URL(request.url); requests.push(url);
    return url.searchParams.has("cursor") ? raw([{ id: "a", time: { created: 1 }, text: "new" }])
      : raw([{ id: "b", time: { created: 2 } }, { id: "a", time: { created: 1 }, text: "old" }], "next");
  });
  try {
    const first = await h.history.complete("session", signal()), cached = await h.history.complete("session", signal());
    expect(first.messages).toEqual([{ id: "a", time: { created: 1 }, text: "new" }, { id: "b", time: { created: 2 } }]);
    expect(cached.messages).toBe(first.messages); expect(cached.nativeReadOrder).toBe(first.nativeReadOrder);
    expect(requests).toHaveLength(2); expect(requests[0]!.searchParams.get("order")).toBe("asc");
    expect(requests[1]!.searchParams.has("order")).toBe(false); expect(h.observations).toHaveLength(1);
  } finally { h.history.dispose(); }
});

test("collective owners isolate cancellation and abandoned late returns cannot install", async () => {
  const entered = gate(), release = gate(); let reads = 0;
  const h = nativeHarness(async () => { if (++reads === 1) { entered.release(); await release.promise; } return raw([{ id: String(reads) }]); });
  const abandoned = new AbortController();
  try {
    const first = h.history.complete("session", abandoned.signal); void first.catch(() => {}); await entered.promise;
    const healthy = h.history.complete("session", signal());
    abandoned.abort(); await expect(first).rejects.toBeDefined();
    release.release(); expect((await healthy).messages).toEqual([{ id: "1" }]); expect(reads).toBe(1);
    expect((await h.history.complete("session", signal())).messages).toEqual([{ id: "1" }]);
    expect(reads).toBe(1);
  } finally { release.release(); h.history.dispose(); }
});

for (const lifecycle of ["scope", "global", "reconnect", "offline", "dispose", "count-eviction", "byte-budget", "byte-retained", "error"] as const)
test(`native history lifecycle preserves ${lifecycle}`, async () => {
  let reads = 0;
  const huge = lifecycle === "byte-budget" || lifecycle === "byte-retained" ? "x".repeat(16 * 1024 * 1024 - (lifecycle === "byte-retained" ? 512 : 0)) : "ordinary";
  const h = nativeHarness(() => {
    reads++;
    return lifecycle === "error" && reads === 1 ? Response.json({ _tag: "UnknownError", message: "unavailable" }, { status: 500 }) : raw([{ id: "message", text: huge }]);
  });
  try {
    if (lifecycle === "error") await expect(h.history.complete("session", signal())).rejects.toBeDefined();
    else await h.history.complete("session", signal());
    if (lifecycle === "scope") h.history.invalidate("other");
    if (lifecycle === "global") h.history.invalidate();
    if (lifecycle === "reconnect") h.generation("2");
    if (lifecycle === "offline") h.generation(undefined);
    if (lifecycle === "count-eviction") for (let index = 0; index < 8; index++) await h.history.complete(`other-${index}`, signal());
    if (lifecycle === "dispose") { h.history.dispose(); await expect(h.history.complete("session", signal())).rejects.toBeDefined(); expect(reads).toBe(1); }
    else { const before = reads; await h.history.complete("session", signal()); expect(reads - before).toBe(lifecycle === "scope" || lifecycle === "byte-retained" ? 0 : 1); }
  } finally { h.history.dispose(); }
});

test("eight conversations retain the hot entry and a ninth evicts the least recent", async () => {
  const reads = new Map<string, number>();
  const h = nativeHarness(request => {
    const session = new URL(request.url).pathname.split("/")[3]!;
    reads.set(session, (reads.get(session) ?? 0) + 1); return raw([]);
  });
  try {
    for (let index = 0; index < 8; index++) await h.history.complete(String(index), signal());
    await h.history.complete("0", signal()); expect(reads.get("0")).toBe(1);
    await h.history.complete("8", signal());
    await h.history.complete("0", signal()); expect(reads.get("0")).toBe(1);
    await h.history.complete("1", signal()); expect(reads.get("1")).toBe(2);
  } finally { h.history.dispose(); }
});

test("abandoned cancellation-ignoring history cannot install over its replacement", async () => {
  const entered = gate(), release = gate(), returned = gate(); let reads = 0;
  const h = nativeHarness(async () => {
    const old = ++reads === 1;
    if (old) { entered.release(); await release.promise; returned.release(); }
    return raw([{ id: old ? "obsolete" : "current" }]);
  });
  const owner = new AbortController();
  try {
    const abandoned = h.history.complete("session", owner.signal); void abandoned.catch(() => {}); await entered.promise;
    owner.abort(); await expect(abandoned).rejects.toBeDefined();
    expect((await h.history.complete("session", signal())).messages).toEqual([{ id: "current" }]);
    release.release(); await returned.promise;
    expect((await h.history.complete("session", signal())).messages).toEqual([{ id: "current" }]);
    expect(reads).toBe(2); expect(h.observations).toHaveLength(1);
  } finally { release.release(); h.history.dispose(); }
});

test("failed record and inbox reads neither retire history nor create observations", async () => {
  let reads = 0;
  const h = nativeHarness(request => {
    if (new URL(request.url).pathname.endsWith("/inbox")) return Response.json({ _tag: "UnknownError", message: "unavailable" }, { status: 500 });
    reads++; return raw([]);
  });
  try {
    await h.history.complete("session", signal());
    await expect(h.history.inbox("session", signal())).rejects.toBeDefined();
    await expect(h.history.records(async () => { throw new Error("unavailable"); }, value => [{ value }])).rejects.toThrow("unavailable");
    expect(h.records).toEqual([]);
    await h.history.complete("session", signal()); expect(reads).toBe(1);
  } finally { h.history.dispose(); }
});

test("completed inbox evidence before registration cannot contaminate the new entry", async () => {
  let reads = 0;
  const h = nativeHarness(request => new URL(request.url).pathname.endsWith("/inbox")
    ? Response.json({ data: [fixture.pending] }) : (reads++, raw([fixture.launch, fixture.stored])));
  try {
    await h.history.inbox("parent", signal());
    expect(reads).toBe(0);
    const first = await h.history.complete("parent", signal());
    expect(first.messages).toEqual([fixture.launch, fixture.stored]);
    expect((await h.history.complete("parent", signal())).messages).toBe(first.messages);
    expect(reads).toBe(1);
  } finally { h.history.dispose(); }
});

for (const phase of ["pending", "installed"] as const)
for (const transcript of ["missing", "covered", "still-pending"] as const)
test(`known pre-registration inbox report retires warm history only when it disappears (${phase}/${transcript})`, async () => {
  const rawEntered = gate(), rawRelease = gate();
  let reads = 0, delivered = false;
  const h = nativeHarness(async request => {
    if (new URL(request.url).pathname.endsWith("/inbox")) return Response.json({ data: delivered ? [] : [fixture.pending] });
    const data = [fixture.launch, ...(transcript === "covered" ? [fixture.stored] : [])];
    if (++reads === 1) { rawEntered.release(); await rawRelease.promise; }
    return raw(data);
  });
  let warm: ReturnType<V2NativeHistory["complete"]> | undefined;
  try {
    await h.history.inbox("parent", signal()); // Completes before any reuse entry exists.
    warm = h.history.complete("parent", signal()); await rawEntered.promise;
    if (phase === "installed") { rawRelease.release(); await warm; }
    delivered = transcript !== "still-pending";
    if (delivered) await h.history.inbox("parent", signal());
    rawRelease.release(); await warm;
    expect(reads).toBe(1); // Disappearance starts no IO and cancels no waiter.
    await h.history.complete("parent", signal());
    expect(reads).toBe(transcript === "missing" ? 2 : 1);
  } finally { rawRelease.release(); await warm?.catch(() => {}); h.history.dispose(); }
});

for (const phase of ["pending", "installed"] as const)
test(`evicted known inbox facts fail closed for a transcript lacking the report (${phase})`, async () => {
  const rawEntered = gate(), rawRelease = gate(); let reads = 0;
  const h = nativeHarness(async request => {
    if (new URL(request.url).pathname.endsWith("/inbox")) return Response.json({ data: [fixture.pending] });
    if (++reads === 1) { rawEntered.release(); await rawRelease.promise; }
    return raw([fixture.launch]);
  });
  let warm: ReturnType<V2NativeHistory["complete"]> | undefined;
  try {
    await h.history.inbox("parent", signal());
    warm = h.history.complete("parent", signal()); await rawEntered.promise;
    if (phase === "installed") { rawRelease.release(); await warm; }
    await h.history.inbox("other", signal()); // Capacity one: evicts the parent's facts.
    rawRelease.release(); await warm;
    expect(reads).toBe(1);
    await h.history.complete("parent", signal());
    expect(reads).toBe(2);
  } finally { rawRelease.release(); await warm?.catch(() => {}); h.history.dispose(); }
});

// Native ids can push stored inbox facts past the counterproof bounds even
// when the native observation fits. An identical later reply then proves that
// no known report disappeared; a relevant pending report still retires reuse.
for (const inbox of ["unrelated-overflow", "related"] as const)
test(`identical inbox replies keep warm history unless a relevant report is pending (${inbox})`, async () => {
  const unrelated = "ses_0123456789abcdefghijklmnop";
  const reports = inbox === "related" ? [fixture.pending] : Array.from({ length: 256 }, (_, index) => ({ ...fixture.pending,
    id: `msg_${String(index).padStart(4, "0")}abcdefghijklmnopqrstuv`,
    payload: { ...fixture.pending.payload, text: fixture.pending.payload.text.replace("ses_child", unrelated),
      metadata: { ...fixture.pending.payload.metadata, childID: unrelated } } }));
  let reads = 0;
  const h = nativeHarness(async request => {
    if (new URL(request.url).pathname.endsWith("/inbox")) return Response.json({ data: reports });
    reads++; return raw([fixture.launch]);
  });
  try {
    const first = await h.history.inbox("parent", signal());
    expect(first.observation.overflow).toBeUndefined();
    expect(h.changes.inboxFacts("parent")?.overflow).toBe(inbox === "unrelated-overflow" ? true : undefined);
    await h.history.complete("parent", signal());
    for (let read = 0; read < 3; read++) { await h.history.inbox("parent", signal()); await h.history.complete("parent", signal()); }
    expect(reads).toBe(inbox === "related" ? 4 : 1);
  } finally { h.history.dispose(); }
});

for (const variation of ["equal", "disjoint", "before-registration", "before-native-start"] as const)
test(`pending raw replacement uses only its lifetime's native observations (${variation})`, async () => {
  const entered = gate(), release = gate(), newerEntered = gate(), newerRelease = gate(); let reads = 0;
  const h = nativeHarness(async () => {
    const old = ++reads === 1;
    const data = old && variation !== "equal" ? [] : [{ id: "idle", type: "idle", outcome: "succeeded" }];
    if (old) { entered.release(); await release.promise; }
    else if (reads === 2) { newerEntered.release(); await newerRelease.promise; }
    return raw(data);
  });
  let old: ReturnType<V2NativeHistory["complete"]> | undefined, newer: ReturnType<V2NativeHistory["complete"]> | undefined;
  try {
    old = h.history.complete(variation === "disjoint" ? "other" : "child", signal());
    if (variation !== "before-native-start") await entered.promise;
    h.history.invalidate();
    if (variation === "before-registration") { release.release(); await old; }
    // For before-native-start, both registrations occur before the original
    // loader's microtask starts: a current peek is not proof of IO ownership.
    newer = h.history.complete("child", signal()); await newerEntered.promise;
    release.release(); expect((await old).messages).toHaveLength(variation === "equal" ? 1 : 0);
    expect(reads).toBe(2);
    newerRelease.release(); expect((await newer).messages).toHaveLength(1);
    expect((await h.history.complete("child", signal())).messages).toHaveLength(1);
    expect(reads).toBe(variation === "before-native-start" ? 3 : 2);
  } finally { release.release(); newerRelease.release(); await old?.catch(() => {}); await newer?.catch(() => {}); h.history.dispose(); }
});

test("the shared owner has its existing 25-second deadline", async () => {
  const entered = gate(), release = gate(), deadline = new AbortController();
  const realTimeout = AbortSignal.timeout.bind(AbortSignal), durations: number[] = [];
  const timeout = spyOn(AbortSignal, "timeout").mockImplementation(ms => { durations.push(ms); return ms === 25_000 ? deadline.signal : realTimeout(ms); });
  const h = nativeHarness(async () => { entered.release(); await release.promise; return raw([]); });
  try {
    const waiting = h.history.complete("session", signal()); void waiting.catch(() => {}); await entered.promise;
    deadline.abort(); await expect(waiting).rejects.toBeDefined(); expect(durations).toContain(25_000);
  } finally { release.release(); h.history.dispose(); timeout.mockRestore(); }
});
