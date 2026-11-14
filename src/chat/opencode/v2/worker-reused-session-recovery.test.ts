import { expect, test } from "bun:test";
import { createOpenCodeV2Provider } from "./provider";
import { startOpenCodeV2Fake } from "../../../../tests/e2e/opencode-v2-fake";
import { workerState } from "../../worker-state";
import type { BackgroundTaskItem } from "../../types";

// Sanitized native-history reduction: one child is reused three times. Its
// first succeeded execution has no parent report; the next two do. Clocks are
// translated to a fixture epoch, preserving relative timing and ordering.
// Identical descriptions deliberately cannot identify a particular occurrence.
type HistoryVariant = "separate" | "overlap" | "missing-bounds" | "tied-boundary" | "report-first" | "delayed-first-report" | "bare-first-idle" | "delayed-delivery" | "missing-response" | "duplicate-response" | "same-summary" | "multipart-response" | "unknown-finish" | "invalid-response-clock" | "delayed-second-boundary" | "hidden-tied-competitor" | "unknown-duplicate";
async function reusedSessionFixture(variant: HistoryVariant = "separate") {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  let parent: string | undefined, child: string | undefined;
  const launch = (index: number, ran: number, completed?: number) => ({
    id: `message-launch-${index}`, type: "assistant", time: { created: ran - 1 },
    content: [{ type: "tool", id: `call-reused-${index}`, name: "subagent",
      time: { created: ran - 1, ran, ...(completed === undefined ? {} : { completed }) },
      state: { status: "completed", input: { agent: "explore", description: "Check fixture", prompt: "Check the bounded fixture", background: true },
        metadata: { sessionID: child, status: "running" },
        content: [{ type: "text", text: "The subagent is working in the background. You will be notified automatically." }] } }],
  });
  const body = (index: number) => `Fixture result ${variant === "same-summary" && index === 3 ? 2 : index}`;
  const delayed = variant === "delayed-delivery" || variant === "delayed-second-boundary";
  const report = (index: number, created: number) => ({
    id: `message-report-${index}`, type: "synthetic", time: { created }, description: "Check fixture",
    text: `<subagent sessionID="${child}" state="${delayed && index === 1 ? "error" : "completed"}">\n${body(index)}\n</subagent>`,
    metadata: { source: "subagent", childID: child, state: delayed && index === 1 ? "error" : "completed", agent: "explore" },
  });
  // Native observations show a single final text part, finish=stop and both
  // assistant clocks inside the bounded execution. Payloads here are invented.
  const response = (index: number, created: number, completed: number) => ({
    id: `message-response-${index}`, type: "assistant", finish: variant === "unknown-finish" && index === 2 ? "unknown" : "stop",
    time: { created, completed: variant === "invalid-response-clock" && index === 2 ? created - 1 : completed },
    content: [{ type: "text", text: body(index) }, ...(variant === "multipart-response" && index === 2 ? [{ type: "text", text: "" }] : [])],
  });
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route === `/api/session/${parent}/message`) return Response.json({ data: [
      ...(variant === "report-first" ? [report(2, 8_138_466)] : []),
      // The control straddles the first idle and overlaps the next admission;
      // unlike two calls wholly inside one interval, these cannot prove aliases.
      launch(1, 1_000, variant === "missing-bounds" ? undefined : variant === "overlap" ? 7_678_940 : 1_133),
      launch(2, 7_678_891, 7_678_927),
       ...(variant === "report-first" ? [] : [report(2, variant === "delayed-second-boundary" ? 9_500_000 : 8_138_466)]),
      launch(3, 8_166_800, 8_166_819), report(3, 8_998_192),
      // Read order is later; the native report clock still names execution 1.
       ...(variant === "delayed-first-report" ? [report(1, 5_265_280)] : []),
       ...(variant === "delayed-delivery" ? [report(1, 10_000_000)] : []),
       ...(variant === "delayed-second-boundary" ? [report(1, 8_140_000)] : []),
       ...(variant === "hidden-tied-competitor" ? [{ ...launch(4, 7_678_891, 7_678_927), time: { created: 11_000_000 } }] : []),
    ], cursor: {} });
    if (route === `/api/session/${child}/message`) return Response.json({ data: [
      { id: "message-child-input-1", type: "user", text: "Check the bounded fixture", time: { created: 1_000 } },
      response(1, 5_260_000, 5_265_260),
      { id: "message-idle-1", type: "idle", time: { created: 5_265_267 }, ...(variant === "bare-first-idle" ? {} : { outcome: delayed ? "failed" : "succeeded" }) },
      ...(variant === "tied-boundary" ? [{ id: "message-idle-conflict", type: "idle", time: { created: 5_265_267 }, outcome: "failed" }] : []),
      { id: "message-child-input-2", type: "user", text: "Continue the bounded fixture", time: { created: 7_678_891 } },
      ...(variant === "missing-response" ? [] : [response(2, 8_130_000, 8_138_450)]),
      { id: "message-idle-2", type: "idle", time: { created: 8_138_452 }, outcome: "succeeded" },
      { id: "message-child-input-3", type: "user", text: "Verify the bounded fixture", time: { created: 8_166_800 } },
      response(3, 8_990_000, 8_998_150),
      ...(variant === "duplicate-response" ? [{ ...response(2, 8_980_000, 8_985_000), id: "duplicate-response" }] : []),
      ...(variant === "unknown-duplicate" ? [{ ...response(2, 8_980_000, 8_985_000), id: "unknown-duplicate", finish: "unknown" }] : []),
      { id: "message-idle-3", type: "idle", time: { created: 8_998_155 }, outcome: "succeeded" },
    ].sort((a, b) => a.time.created - b.time.created), cursor: {} });
    // All results are already stored; no queued report or quiet wait can repair
    // attribution. The native fake supplies ownership and quiet activity routes.
    if (route.endsWith("/inbox")) return Response.json({ data: [] });
    if (variant === "hidden-tied-competitor" && route === `/api/session/${parent}`) {
      const response = await fetch(request), body = await response.json();
      body.data.revert = { messageID: "message-launch-4" };
      return Response.json(body);
    }
    return fetch(request);
  }) as typeof globalThis.fetch;
  const open = () => createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const provider = open();
  try {
    parent = (await provider.createSession("Reused child recovery fixture")).id;
    child = fake.launchRequestWorker(parent).childId;
    fake.settleWorkerWithoutReport(child, "succeeded", "Fixture child is quiet");
    return { provider, open, fake, parent, child, taskId: (index: number) => `v2:${parent}:call-reused-${index}` };
  } catch (error) {
    await provider.dispose!(); await fake.stop(); throw error;
  }
}

function expectRecovered(rows: BackgroundTaskItem[], fixture: Awaited<ReturnType<typeof reusedSessionFixture>>) {
  expect(rows).toHaveLength(3); // No orphan report rows or duplicated occurrences.
  expect(rows.map(row => row.taskId).sort()).toEqual([1, 2, 3].map(fixture.taskId).sort());
  for (const index of [1, 2, 3]) {
    const row = rows.find(row => row.taskId === fixture.taskId(index))!;
    expect(row).toMatchObject({ status: "completed", stateUncertain: false, childConversationId: fixture.child });
    expect(workerState(row.status, row.stateUncertain, row.activity)).toBe("completed");
    expect(row.control?.available).not.toBe(true);
    if (index === 1) {
      expect(row.resultId).toBeUndefined();
      expect(row.summary).toBeUndefined();
    } else {
      expect(row.resultId).toBe(`message-report-${index}`);
      expect(row.summary).toBe(`Fixture result ${index}`);
    }
  }
}

for (const entry of ["listMessages", "reconcileBackgroundTasks"] as const)
test(`${entry} recovers a missing first report before attributing later reused-child reports`, async () => {
  const fixture = await reusedSessionFixture();
  let provider = fixture.provider;
  const read = async () => entry === "listMessages"
    ? (await provider.listMessages(fixture.parent, { limit: 100 })).items.filter((item): item is BackgroundTaskItem => item.type === "background_task")
    : await provider.reconcileBackgroundTasks!(fixture.parent, { fresh: true });
  try {
    // A cold observation may conservatively abstain. A subsequent fresh quiet
    // read must converge, with no timer, child mutation, or synthetic SSE idle.
    await read();
    expectRecovered(await read(), fixture);
    expectRecovered(await provider.reconcileBackgroundTasks!(fixture.parent, { fresh: true }), fixture);
    await provider.dispose!(); provider = fixture.open();
    await read();
    expectRecovered(await read(), fixture);
    expect(fixture.fake.state().unhandled).toEqual([]);
  } finally { await provider.dispose!(); await fixture.fake.stop(); }
});

for (const variant of ["delayed-delivery", "delayed-second-boundary"] as const)
test(`a delayed native report uses exact response evidence, not its delivery clock (${variant})`, async () => {
  const fixture = await reusedSessionFixture(variant);
  try {
    await fixture.provider.reconcileBackgroundTasks!(fixture.parent, { fresh: true });
    const rows = await fixture.provider.reconcileBackgroundTasks!(fixture.parent, { fresh: true });
    expect(rows).toHaveLength(3);
    for (const index of [1, 2, 3]) expect(rows.find(row => row.taskId === fixture.taskId(index))).toMatchObject({
      status: index === 1 ? "failed" : "completed", stateUncertain: false,
      resultId: `message-report-${index}`, summary: `Fixture result ${index}`,
    });
  } finally { await fixture.provider.dispose!(); await fixture.fake.stop(); }
});

for (const variant of ["missing-response", "duplicate-response", "same-summary", "multipart-response", "unknown-finish", "invalid-response-clock", "unknown-duplicate"] as const)
test(`reused-child reports cannot acquire authority with ${variant}`, async () => {
  const fixture = await reusedSessionFixture(variant);
  try {
    await fixture.provider.reconcileBackgroundTasks!(fixture.parent, { fresh: true });
    const rows = await fixture.provider.reconcileBackgroundTasks!(fixture.parent, { fresh: true });
    const second = rows.find(row => row.taskId === fixture.taskId(2))!;
    expect(second.resultId).toBeUndefined();
    expect(second.summary).toBeUndefined();
    expect(second.control?.available).not.toBe(true);
    // Independently typed child outcomes may settle an interval. They never
    // manufacture the missing/ambiguous parent's result identity or summary.
    if (variant === "same-summary") {
      const third = rows.find(row => row.taskId === fixture.taskId(3))!;
      expect(third.resultId).toBeUndefined(); expect(third.summary).toBeUndefined();
    }
  } finally { await fixture.provider.dispose!(); await fixture.fake.stop(); }
});

for (const entry of ["listMessages", "reconcileBackgroundTasks"] as const)
test(`${entry} includes a hidden tied competitor before granting exact-response authority`, async () => {
  const fixture = await reusedSessionFixture("hidden-tied-competitor");
  const read = async () => entry === "listMessages"
    ? (await fixture.provider.listMessages(fixture.parent, { limit: 100 })).items.filter((item): item is BackgroundTaskItem => item.type === "background_task")
    : await fixture.provider.reconcileBackgroundTasks!(fixture.parent, { fresh: true });
  try {
    await read();
    const second = (await read()).find(row => row.taskId === fixture.taskId(2))!;
    expect(second.resultId).toBeUndefined(); expect(second.summary).toBeUndefined();
    expect(second.control?.available).not.toBe(true);
  } finally { await fixture.provider.dispose!(); await fixture.fake.stop(); }
});

for (const variant of ["overlap", "missing-bounds", "tied-boundary"] as const)
test(`matching descriptions cannot transfer a report with ${variant}`, async () => {
  const fixture = await reusedSessionFixture(variant);
  try {
    await fixture.provider.reconcileBackgroundTasks!(fixture.parent, { fresh: true });
    const rows = await fixture.provider.reconcileBackgroundTasks!(fixture.parent, { fresh: true });
    for (const index of [1, 2]) {
      const row = rows.find(row => row.taskId === fixture.taskId(index))!;
      expect(row).toMatchObject({ status: "running", stateUncertain: true });
      expect(workerState(row.status, row.stateUncertain, row.activity)).toBe("unknown");
      expect(row.resultId).toBeUndefined();
      expect(row.summary).toBeUndefined();
      expect(row.control?.available).not.toBe(true);
    }
    expect(fixture.fake.state().unhandled).toEqual([]);
  } finally { await fixture.provider.dispose!(); await fixture.fake.stop(); }
});

test("a later execution report read before either launcher still joins only its bounded execution", async () => {
  const fixture = await reusedSessionFixture("report-first");
  try {
    await fixture.provider.reconcileBackgroundTasks!(fixture.parent, { fresh: true });
    expectRecovered(await fixture.provider.reconcileBackgroundTasks!(fixture.parent, { fresh: true }), fixture);
    const history = await fixture.provider.listMessages(fixture.parent, { limit: 100 });
    expectRecovered(history.items.filter((item): item is BackgroundTaskItem => item.type === "background_task"), fixture);
  } finally { await fixture.provider.dispose!(); await fixture.fake.stop(); }
});

test("an earlier native report read after later executions retains its own authority", async () => {
  const fixture = await reusedSessionFixture("delayed-first-report");
  try {
    await fixture.provider.reconcileBackgroundTasks!(fixture.parent, { fresh: true });
    const rows = await fixture.provider.reconcileBackgroundTasks!(fixture.parent, { fresh: true });
    expect(rows).toHaveLength(3);
    for (const index of [1, 2, 3]) {
      expect(rows.find(row => row.taskId === fixture.taskId(index))).toMatchObject({
        status: "completed", stateUncertain: false, resultId: `message-report-${index}`, summary: `Fixture result ${index}`,
      });
    }
  } finally { await fixture.provider.dispose!(); await fixture.fake.stop(); }
});

test("separating an older bare idle does not invent its outcome or poison later explicit reports", async () => {
  const fixture = await reusedSessionFixture("bare-first-idle");
  try {
    await fixture.provider.reconcileBackgroundTasks!(fixture.parent, { fresh: true });
    const rows = await fixture.provider.reconcileBackgroundTasks!(fixture.parent, { fresh: true });
    expect(rows).toHaveLength(3);
    const first = rows.find(row => row.taskId === fixture.taskId(1))!;
    expect(first).toMatchObject({ status: "running", stateUncertain: true });
    expect(first.resultId).toBeUndefined();
    expect(first.summary).toBeUndefined();
    for (const index of [2, 3]) expect(rows.find(row => row.taskId === fixture.taskId(index))).toMatchObject({
      status: "completed", resultId: `message-report-${index}`, summary: `Fixture result ${index}`,
    });
  } finally { await fixture.provider.dispose!(); await fixture.fake.stop(); }
});
