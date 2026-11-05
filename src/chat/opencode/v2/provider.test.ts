import { describe, expect, spyOn, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ClientError } from "@opencode/client";
import type { FormCancelled, FormCreated, FormReplied, PermissionAsked, PermissionReplied, ShellInfo, SessionCreated, SessionExecutionStarted, SessionExecutionSucceeded, SessionToolInputStarted, SessionToolCalled, SessionToolSuccess, SessionMessageContentUpdated } from "@opencode/client";

import { InvalidQuestionAnswerError, ReversibleHistoryTargetError } from "../../provider";
import { createOpenCodeV2Provider, formAnswerFromChoices, type OpenCodeV2Provider } from "./provider";
import { ChatAdapter, SteerAlreadyDeliveredError, SteerWithdrawalUnconfirmedError } from "../../adapter";
import { ProviderUpdateCoalescer } from "../../coalescer";
import { conversationTotals } from "../../conversation-totals";
import { compactWorkers, workerSummary } from "../../compact-work";
import { workerState, workerExecutionClockRuns, workerCanStop, workerStateLabel } from "../../worker-state";
import { workerDismissalIdentities } from "../../worker-dismissal-identity";
import { visibleWorkers } from "../../worker-dismissal-client";
import { startOpenCodeV2Fake } from "../../../../tests/e2e/opencode-v2-fake";

// The stored records of a real 2.0.13 session: user, assistant (read tool),
// assistant (text), idle, user — see normalization.test.ts for provenance.
const FIXTURES = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/real-2.0.13.json"), "utf8")) as {
  storedMessages: { data: Array<Record<string, unknown>> };
};
const STORED = FIXTURES.storedMessages.data;
const WORKSPACE = "/ws";
const AUTH = `Basic ${Buffer.from("opencode:pw").toString("base64")}`;

type Call = { method: string; path: string; query: URLSearchParams; body: unknown; headers: Headers; signal: AbortSignal };
const ENVELOPED = [
  /^GET \/api\/session\/[^/]+$/,
  /^POST \/api\/session$/,
  /^POST \/api\/session\/[^/]+\/(prompt|compact|revert\/stage)$/,
  /^GET \/api\/session\/[^/]+\/form\/[^/]+$/,
];
type Handler = (call: Call) => unknown;

// A 2.x server as the pinned client sees it: JSON bodies, `204` for void
// routes, a tagged JSON error for a missing session, SSE on `/api/event`.
function fakeOpenCode(routes: Record<string, Handler>) {
  const calls: Call[] = [];
  // Every slash dispatch reads both catalogs; a test that does not care
  // about them serves empty ones.
  const catalogs: Record<string, Handler> = { "GET /api/command": () => scoped([]), "GET /api/skill": () => scoped([]) };
  const patterns = Object.entries({ ...catalogs, ...routes }).map(([pattern, handler]) => {
    const [method, route] = pattern.split(" ") as [string, string];
    const regex = new RegExp(`^${route.replace(/:[a-zA-Z]+/g, "[^/]+")}$`);
    return { method, regex, handler };
  });
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? new Request(input, init) : new Request(input, init);
    const url = new URL(request.url);
    const text = await request.clone().text().catch(() => "");
    const call: Call = { method: request.method, path: url.pathname, query: url.searchParams, body: text ? JSON.parse(text) : undefined, headers: request.headers, signal: request.signal };
    calls.push(call);
    const match = patterns.find(candidate => candidate.method === request.method && candidate.regex.test(url.pathname));
    if (!match) return Response.json({ _tag: "NotFoundError", message: `no route ${request.method} ${url.pathname}` }, { status: 404 });
    const result = await match.handler(call);
    if (result instanceof Response) return result;
    if (result === undefined) return new Response(null, { status: 204 });
    // Single-record routes answer `{ data: … }`, which the client unwraps;
    // list routes answer their own shapes, which it returns whole.
    return Response.json(ENVELOPED.some(pattern => pattern.test(`${request.method} ${url.pathname}`)) ? { data: result } : result);
  }) as typeof globalThis.fetch;
  const provider = (directory = WORKSPACE, options: { commandAdmissionMs?: number; reloadSettleMs?: number } = {}) => createOpenCodeV2Provider({ endpoint: "http://opencode.test", password: "pw", directory, fetch, ...options }) as OpenCodeV2Provider;
  const requests = (method: string, pathname: string) => calls.filter(call => call.method === method && call.path === pathname);
  return { calls, provider, requests };
}

function session(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    projectID: "global",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 100, updated: 200 },
    title: `Session ${id}`,
    location: { directory: WORKSPACE },
    ...overrides,
  };
}

const scoped = <T>(data: T) => ({ location: { directory: WORKSPACE }, data });
const skillInfo = (id: string, overrides: { name?: string; description?: string } = {}) => ({ id, name: overrides.name ?? id, ...(overrides.description ? { description: overrides.description } : {}), path: `/ws/.opencode/skills/${id}/SKILL.md`, content: `# ${id}` });
const notFound = (sessionID: string) => Response.json({ _tag: "SessionNotFoundError", sessionID, message: `Session not found: ${sessionID}` }, { status: 404 });

test("fallback relations describe only actual visible native subagent results, without granting ownership", async () => {
  const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
  const hidden = { ...fixture.stored, id: "msg_hidden" };
  const server = fakeOpenCode({
    "GET /api/session/ses_parent": () => session("ses_parent", { revert: { messageID: hidden.id } }),
    "GET /api/session/ses_child": () => new Response(null, { status: 503 }),
    "GET /api/session/ses_parent/message": () => ({ data: [fixture.stored,
      { id: "msg_unrelated", type: "synthetic", text: "Unrelated note", time: { created: 43 } },
      { ...fixture.stored, id: "msg_shell", metadata: { source: "shell", shellID: "sh_fixture" } },
      hidden], cursor: {} }),
  });
  const provider = server.provider();
  try {
    const page = await provider.listMessages("ses_parent", { limit: 100 });
    expect(page.workerResultFallbacks).toEqual([{ resultId: "msg_result", childConversationId: "ses_child", report: { status: "completed", summary: "Fixture checked." },
      fallback: { id: "notice:msg_result", type: "notice", createdAt: 42, level: "info", message: fixture.stored.text } }]);
    expect(page.items.some(item => item.type === "background_task")).toBe(false);
    expect(page.items).toContainEqual(expect.objectContaining({ id: "notice:msg_result", type: "notice" }));
    expect(server.calls.every(call => call.method === "GET")).toBe(true);
  } finally { await provider.dispose(); }
});

for (const outcome of ["pending", "updated", "delivered", "stored-committed", "required-failure", "late-update", "late-commit", "expired-update", "read-update", "cancel", "generation"] as const)
test(`pending fallback text source survives optional inventory expiry (${outcome})`, async () => {
  const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
  let phase = "initial", pending = false, blockMessages = false, records: unknown[] = [], opened = 0, closed = 0;
  let text = fixture.pending.payload.text, pendingReads = 0, transcriptReads = 0, activeReads = 0;
  let wire!: ReadableStreamDefaultController<Uint8Array>, releaseMessages!: () => void, releaseActive!: () => void;
  let materialized!: () => void, delivered!: () => void, activeEntered!: () => void, textCaptured!: () => void, changed!: () => void;
  let publicationEntered!: () => void, releasePublication!: () => void, heldPublication = false;
  let holdFreshStartup = false, freshStartupEntered!: () => void, releaseFreshStartup!: () => void, freshPublished!: () => void;
  const messages = new Promise<void>(resolve => { releaseMessages = resolve; });
  const active = new Promise<void>(resolve => { releaseActive = resolve; });
  const noticeReady = new Promise<void>(resolve => { materialized = resolve; });
  const delivery = new Promise<void>(resolve => { delivered = resolve; });
  const activeReady = new Promise<void>(resolve => { activeEntered = resolve; });
  const textReady = new Promise<void>(resolve => { textCaptured = resolve; });
  const changeApplied = new Promise<void>(resolve => { changed = resolve; });
  const publicationReady = new Promise<void>(resolve => { publicationEntered = resolve; });
  const publication = new Promise<void>(resolve => { releasePublication = resolve; });
  const freshStartupReady = new Promise<void>(resolve => { freshStartupEntered = resolve; });
  const freshStartup = new Promise<void>(resolve => { releaseFreshStartup = resolve; });
  const freshReportReady = new Promise<void>(resolve => { freshPublished = resolve; });
  const freshText = fixture.pending.payload.text.replace("Fixture checked.", "Fresh generation authoritative report.");
  const activeSignals: AbortSignal[] = [];
  const activeRequests: Promise<unknown>[] = [];
  let cancelledActiveRequests: Promise<unknown>[] = [], explicitRecovery: ReturnType<OpenCodeV2Provider["reconcileBackgroundTasks"]> | undefined;
  let oldSourceIsCurrent: (() => boolean) | undefined;
  const historyOwner = new AsyncLocalStorage<boolean>();
  const server = fakeOpenCode({
    "GET /api/event": ({ signal }) => new Response(new ReadableStream<Uint8Array>({ start(controller) {
      wire = controller; opened++; controller.enqueue(new TextEncoder().encode('data: {"type":"server.connected","data":{}}\n\n'));
      const close = () => { closed++; controller.close(); };
      if (signal.aborted) close(); else signal.addEventListener("abort", close, { once: true });
    } }), { headers: { "content-type": "text/event-stream" } }),
    "GET /api/session": () => ({ data: [], cursor: {} }),
    "GET /api/session/ses_parent": () => session("ses_parent"),
    "GET /api/session/ses_child": () => new Response(null, { status: 503 }),
    "GET /api/session/ses_parent/message": async () => {
      if (blockMessages) await messages;
      if (phase === "refresh") transcriptReads++;
      return { data: records, cursor: {} };
    },
    "GET /api/session/:id/inbox": () => {
      if (phase === "refresh") {
        pendingReads++;
        if (outcome === "required-failure") return new Response(null, { status: 503 });
      }
      return { data: pending ? [{ ...fixture.pending, payload: { ...fixture.pending.payload, text } }] : [] };
    },
    "GET /api/session/active": ({ signal }) => {
      if (phase === "refresh") {
        activeReads++; activeSignals.push(signal);
        const request = active.then(() => ({})); activeRequests.push(request); activeEntered();
        return request;
      }
      return {};
    },
    "GET /api/permission/request": () => scoped([]), "GET /api/form": async () => {
      if (phase === "refresh" && historyOwner.getStore() && (outcome === "expired-update" || outcome === "read-update") && !heldPublication) {
        heldPublication = true; publicationEntered(); await publication;
      }
      return scoped([]);
    },
  });
  const provider = server.provider(), events = provider.events.bind(provider), recover = provider.reconcileBackgroundTasks.bind(provider);
  provider.events = async function* (signal) { for await (const event of events(signal)) {
    // A restarted pump may legitimately publish newly read pending text. Keep
    // its startup recovery behind the cancelled reader's negative assertions.
    if (event.eventType === "server.connected" && holdFreshStartup) { freshStartupEntered(); await freshStartup; }
    if (event.eventType === "diagnostic.delivery.complete") delivered();
    if (event.eventType === "diagnostic.change.complete") changed();
    yield event;
  } };
  provider.reconcileBackgroundTasks = (id, options) => {
    // Shared inventory can invoke callbacks in another reader's async scope.
    const explicitReader = historyOwner.getStore();
    const recovery = recover(id, { ...options, onSource: source => {
      options?.onSource?.(source);
      if (phase === "refresh" && explicitReader && source.workerResultFallbacks.some(relation => relation.resultId === fixture.pending.id)) {
        oldSourceIsCurrent = source.workerSource.isCurrent.bind(source.workerSource); textCaptured();
      }
    } });
    if (phase === "refresh" && explicitReader) explicitRecovery = recovery;
    return recovery;
  };
  const adapter = new ChatAdapter({ provider, workspacePath: WORKSPACE, coalesceWindowMs: 10 });
  const lifetime = new AbortController();
  let observer: Awaited<ReturnType<ChatAdapter["subscribe"]>> | undefined, observing: Promise<void> | undefined, reading: ReturnType<ChatAdapter["history"]> | undefined;
  const publications: import("../../types").ChatEvent[] = [];
  const send = (event: unknown) => wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ ...event as object, location: { directory: WORKSPACE } })}\n\n`));
  try {
    expect((await adapter.history("ses_parent")).items).toEqual([]);
    observer = await adapter.subscribe("ses_parent", { signal: lifetime.signal });
    observing = (async () => { for await (const event of observer!.events) {
      publications.push(event);
      if (event.type === "item.upsert" && event.item.id === "notice:msg_result") {
        materialized();
        if (event.item.type === "notice" && event.item.message === freshText) freshPublished();
      }
    } })();
    phase = "enqueue"; pending = true; blockMessages = true;
    send({ id: "evt_pending", created: 41, type: "session.inbox.enqueued", data: { sessionID: "ses_parent", inboxID: fixture.pending.id, item: fixture.pending } });
    await noticeReady;
    if (outcome === "delivered" || outcome === "stored-committed") {
      pending = false; send({ ...fixture.delivered, created: 42 });
      send({ type: "diagnostic.delivery.complete", data: {} }); await delivery;
    }
    await adapter.stopEventPump(); blockMessages = false; releaseMessages();
    if (outcome === "stored-committed") {
      records = [fixture.stored]; phase = "stored";
      expect((await adapter.history("ses_parent")).items).toContainEqual(expect.objectContaining({ id: "notice:msg_result" }));
      records = [];
      send({ id: "evt_stage", created: 60, type: "session.revert.staged", data: { sessionID: "ses_parent", revert: { messageID: "msg_result" } } });
      send({ id: "evt_commit", created: 61, type: "session.revert.committed", data: { sessionID: "ses_parent", to: "msg_result" } });
      send({ type: "diagnostic.change.complete", data: {} }); await changeApplied;
      await adapter.stopEventPump();
    }
    if (outcome === "updated") text = text.replace("Fixture checked.", "Updated pending report.");
    if (outcome === "cancel" || outcome === "generation") text = text.replace("Fixture checked.", "Cancelled read must not publish this report.");
    phase = "refresh";
    // Start the covering pump outside the explicit reader's async scope, so
    // startup inventory cannot satisfy its final-publication barrier.
    void adapter.startEventPump(); await provider.waitForEventStream(lifetime.signal);
    reading = historyOwner.run(true, () => adapter.history("ses_parent", { limit: 97 }));
    let readSettled = false;
    void reading.finally(() => { readSettled = true; }).catch(() => undefined);
    void reading.catch(() => undefined);
    if (outcome === "required-failure") await expect(reading).rejects.toThrow("Inbox recovery unavailable");
    else {
      await activeReady; // Native active GET is in flight; do not release it.
      if (outcome === "expired-update" || outcome === "read-update") {
        await publicationReady;
        expect(readSettled).toBe(false);
        expect(activeSignals.some(signal => signal.aborted)).toBe(true); // Source lease outlived recovery transport.
        text = text.replace("Fixture checked.", "New text after optional recovery retired.");
        if (outcome === "expired-update") {
          send({ id: "evt_expired_update", created: 50, type: "session.inbox.enqueued", data: { sessionID: "ses_parent", inboxID: fixture.pending.id, item: { ...fixture.pending, payload: { ...fixture.pending.payload, text } } } });
          send({ type: "diagnostic.change.complete", data: {} }); await changeApplied;
        }
        releaseActive();
        if (outcome === "read-update") await expect(provider.reconcileBackgroundTasks("ses_parent", { fresh: true })).rejects.toThrow("OpenCode session lookup failed");
        releasePublication();
      }
      if (outcome === "late-update" || outcome === "late-commit" || outcome === "cancel" || outcome === "generation") {
        await textReady; // The old pending source reached the enclosing owner.
        if (outcome === "cancel" || outcome === "generation") {
          expect(oldSourceIsCurrent?.()).toBe(true);
          cancelledActiveRequests = activeRequests.slice();
          await adapter.stopEventPump();
          if (outcome === "generation") { holdFreshStartup = true; void adapter.startEventPump(); }
          await expect(reading).rejects.toThrow("Inbox recovery unavailable");
          if (outcome === "generation") await freshStartupReady;
        } else {
          if (outcome === "late-update") {
            text = text.replace("Fixture checked.", "Newer live pending report.");
            send({ id: "evt_new_pending", created: 50, type: "session.inbox.enqueued", data: { sessionID: "ses_parent", inboxID: fixture.pending.id, item: { ...fixture.pending, payload: { ...fixture.pending.payload, text } } } });
          } else {
            pending = false;
            send({ ...fixture.delivered, created: 50 });
            send({ id: "evt_late_stage", created: 60, type: "session.revert.staged", data: { sessionID: "ses_parent", revert: { messageID: "msg_result" } } });
            send({ id: "evt_late_commit", created: 61, type: "session.revert.committed", data: { sessionID: "ses_parent", to: "msg_result" } });
          }
          send({ type: "diagnostic.change.complete", data: {} }); await changeApplied;
        }
        releaseActive();
        if (outcome === "cancel" || outcome === "generation") {
          await Promise.all(cancelledActiveRequests); await explicitRecovery?.catch(() => undefined);
          expect(oldSourceIsCurrent?.()).toBe(false);
        }
      }
      const history = outcome === "cancel" || outcome === "generation" ? undefined : await reading;
      expect(transcriptReads).toBeGreaterThan(0); expect(pendingReads).toBeGreaterThan(0); expect(activeReads).toBeGreaterThan(0);
      if (!outcome.startsWith("late-") && outcome !== "cancel" && outcome !== "generation") expect(activeSignals.some(signal => signal.aborted)).toBe(true); // Real five-second recovery expiry.
      if (history) {
        expect(history.items.filter(item => item.id === "notice:msg_result")).toEqual(pending ? [expect.objectContaining({ type: "notice", message: text })] : []);
        expect(history.items.some(item => item.type === "background_task")).toBe(false);
      }
    }
    const next = await adapter.subscribe("ses_parent"); next.events.cancel();
    const expectedText = outcome === "cancel" || outcome === "generation" ? fixture.pending.payload.text : text;
    expect(next.snapshot.items.filter(item => item.id === "notice:msg_result")).toEqual(pending ? [expect.objectContaining({ type: "notice", message: expectedText })] : []);
    expect(next.snapshot.items.some(item => item.type === "background_task")).toBe(false);
    if (!pending) expect(publications).toContainEqual(expect.objectContaining({ type: "item.remove", itemId: "notice:msg_result" }));
    if (outcome === "cancel" || outcome === "generation") expect(publications).not.toContainEqual(expect.objectContaining({ type: "item.upsert", item: expect.objectContaining({ type: "notice", message: text }) }));
    if (outcome === "generation") {
      // Distinct from the cancelled source: only fresh authority can supply it.
      text = freshText; holdFreshStartup = false; releaseFreshStartup(); await freshReportReady;
      const fresh = await adapter.subscribe("ses_parent"); fresh.events.cancel();
      expect(fresh.snapshot.items.filter(item => item.id === "notice:msg_result")).toEqual([expect.objectContaining({ type: "notice", message: freshText })]);
    }
    expect(server.calls.every(call => call.method === "GET")).toBe(true);
  } finally { releaseFreshStartup(); releaseMessages(); releaseActive(); releasePublication(); lifetime.abort(); observer?.events.cancel(); await adapter.dispose(); await reading?.catch(() => undefined); await observing; expect(closed).toBe(opened); }
}, 20_000);

for (const scenario of ["timestamp-transition", "same-timestamp", "ownership-unavailable", "paged-stored", "changed-text", "changed-child", "ordinary-notice"] as const)
test(`pending fallback delivery reconciles exact native provenance (${scenario})`, async () => {
  const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
  const pending = structuredClone(fixture.pending);
  if (scenario === "same-timestamp") pending.time.created = fixture.stored.time.created;
  if (scenario === "changed-text") pending.payload.text = pending.payload.text.replace("Fixture checked.", "A newer pending report.");
  const otherPending = { ...pending, id: "msg_other_pending", time: { created: 44 } };
  const stored = structuredClone(fixture.stored);
  if (scenario === "changed-child") { stored.metadata.childID = "ses_other_child"; stored.text = stored.text.replaceAll("ses_child", "ses_other_child"); }
  const note = { id: "msg_note", type: "synthetic", text: "Unrelated native note", time: { created: 1 } };
  const unmatched = { ...fixture.stored, id: "msg_unmatched", metadata: { ...fixture.stored.metadata, childID: "ses_unverified" },
    text: fixture.stored.text.replaceAll("ses_child", "ses_unverified") };
  let delivered = false, committed = false, unavailable = true, opened = 0, closed = 0;
  const server = fakeOpenCode({
    "GET /api/event": ({ signal }) => new Response(new ReadableStream<Uint8Array>({ start(controller) {
      opened++; controller.enqueue(new TextEncoder().encode('data: {"type":"server.connected","data":{}}\n\n'));
      signal.addEventListener("abort", () => { closed++; controller.close(); }, { once: true });
    } }), { headers: { "content-type": "text/event-stream" } }),
    "GET /api/session": () => ({ data: [], cursor: {} }),
    "GET /api/session/ses_parent": () => session("ses_parent"),
    "GET /api/session/ses_child": () => unavailable ? new Response(null, { status: 503 }) : session("ses_child", { parentID: "ses_parent" }),
    "GET /api/session/ses_other_child": () => session("ses_other_child", { parentID: "ses_parent" }),
    "GET /api/session/ses_unverified": () => new Response(null, { status: 503 }),
    "GET /api/session/ses_parent/message": () => ({ data: [note, unmatched, ...(delivered && !committed ? [stored, ...(scenario === "paged-stored" ? [{ id: "msg_later", type: "user", text: "Later turn", time: { created: 70 } }] : [])]
      : !delivered && scenario === "ordinary-notice" ? [{ id: pending.id, type: "synthetic", text: pending.payload.text, time: pending.time }] : [])], cursor: {} }),
    "GET /api/session/ses_child/message": () => ({ data: [], cursor: {} }),
    "GET /api/session/ses_other_child/message": () => ({ data: [], cursor: {} }),
    "GET /api/session/:id/inbox": () => ({ data: delivered ? [] : [...(scenario === "ordinary-notice" ? [] : [pending]), otherPending] }),
    "GET /api/session/active": () => scenario === "paged-stored" && delivered ? new Response(null, { status: 503 }) : ({}),
    "GET /api/permission/request": () => scoped([]), "GET /api/form": () => scoped([]),
  });
  const provider = server.provider(), adapter = new ChatAdapter({ provider, workspacePath: WORKSPACE, coalesceWindowMs: 0 });
  const lifetime = new AbortController();
  const reports = (items: import("../../types").ConversationItem[]) => items.filter(item => item.id === "notice:msg_result" || item.type === "background_task" && item.resultId === "msg_result");
  if (scenario === "paged-stored") {
    const list = provider.listMessages.bind(provider);
    // Reconnect's automatic reader uses the same real one-message pages as
    // navigation, so it cannot independently materialize the stored notice.
    provider.listMessages = (id, options) => list(id, { ...options, ...(delivered ? { limit: 1 } : {}) });
  }
  try {
    const initial = await adapter.history("ses_parent");
    expect(reports(initial.items)).toEqual([expect.objectContaining({ type: "notice", createdAt: pending.time.created, message: pending.payload.text })]);
    const listener = await adapter.subscribe("ses_parent", { signal: lifetime.signal });
    await adapter.stopEventPump();
    // Native delivery occurs while disconnected: enqueue and stored records
    // deliberately differ by the real fixture's 41 -> 42 creation clock.
    delivered = true; unavailable = scenario === "ownership-unavailable" || scenario === "paged-stored";
    const history = await adapter.history("ses_parent", scenario === "paged-stored" ? { limit: 1 } : {});
    const next = await adapter.subscribe("ses_parent", { signal: lifetime.signal }); next.events.cancel();
    expect(next.snapshot.items).toContainEqual(expect.objectContaining({ id: "notice:msg_other_pending", message: otherPending.payload.text }));
    for (const snapshot of [next.snapshot, ...(scenario === "paged-stored" ? [] : [history])]) {
      expect(snapshot.items).toContainEqual(expect.objectContaining({ id: "notice:msg_note", message: note.text }));
      expect(snapshot.items).toContainEqual(expect.objectContaining({ id: "notice:msg_unmatched", message: unmatched.text }));
    }
    // Observe committed-away raw storage without ever observing its staged
    // boundary. Stored provenance, not ordinary page absence, must remove it.
    await adapter.stopEventPump(); committed = true;
    const removed = await adapter.history("ses_parent");
    const after = await adapter.subscribe("ses_parent", { signal: lifetime.signal }); after.events.cancel();
    for (const itemId of ["notice:msg_note", "notice:msg_unmatched", "notice:msg_other_pending"])
      expect(after.snapshot.items.some(item => item.id === itemId)).toBe(true);
    listener.events.cancel(); const publications = []; for await (const event of listener.events) publications.push(event);
    const ids = (items: import("../../types").ConversationItem[]) => reports(items).map(item => item.id);
    const workerId = "task:v2:ses_parent:notification:msg_result";
    const changed = scenario === "changed-text" || scenario === "changed-child" || scenario === "ordinary-notice";
    const visible = unavailable ? ["notice:msg_result"] : changed ? ["notice:msg_result", workerId] : [workerId];
    // Keep all handoff/removal symptoms in one verdict so an early duplicate
    // does not hide the later ghost left behind after committed removal.
    expect(server.calls.every(call => call.method === "GET")).toBe(true);
    expect({ history: ids(history.items).sort(), subscription: ids(next.snapshot.items).sort(),
      committedHistory: ids(removed.items), committedSubscription: ids(after.snapshot.items),
      notifiedRemoval: publications.some(event => event.type === "item.remove" && event.itemId === "notice:msg_result") }).toEqual({
      history: scenario === "paged-stored" ? [] : unavailable ? ["notice:msg_result"] : [workerId], subscription: [...visible].sort(),
      committedHistory: [], committedSubscription: changed ? ["notice:msg_result"] : [],
      notifiedRemoval: !changed,
    });
  } finally { lifetime.abort(); await adapter.dispose(); expect(closed).toBe(opened); }
});

for (const coalesceWindowMs of [0, 25])
for (const source of ["pending", "stored"] as const)
for (const scenario of ["changed-text", "unchanged-later-clock", "changed-child", "changed-result", "no-retained-worker", "ownership-available", ...(source === "stored" ? ["hidden"] as const : [])] as const)
test(`retained worker supersession requires current report content (${source}/${scenario}/coalesce=${coalesceWindowMs})`, async () => {
  const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
  const updatedText = (scenario === "unchanged-later-clock" ? fixture.stored.text : fixture.stored.text.replace("Fixture checked.", "UPDATED NATIVE REPORT"))
    .replaceAll("ses_child", scenario === "changed-child" ? "ses_other_child" : "ses_child");
  const resultId = scenario === "changed-result" ? "msg_other_result" : fixture.stored.id;
  const metadata = { ...fixture.stored.metadata, childID: scenario === "changed-child" ? "ses_other_child" : "ses_child" };
  const stored = { ...fixture.stored, id: resultId, text: updatedText, metadata, time: { created: 52 } };
  const pending = { ...fixture.pending, id: resultId, time: { created: 51 }, payload: { ...fixture.pending.payload, text: updatedText, metadata } };
  let refreshed = false, opened = 0, closed = 0;
  const unavailable = () => refreshed && scenario !== "ownership-available";
  const server = fakeOpenCode({
    "GET /api/event": ({ signal }) => new Response(new ReadableStream<Uint8Array>({ start(controller) {
      opened++; controller.enqueue(new TextEncoder().encode('data: {"type":"server.connected","data":{}}\n\n'));
      signal.addEventListener("abort", () => { closed++; controller.close(); }, { once: true });
    } }), { headers: { "content-type": "text/event-stream" } }),
    "GET /api/session": () => ({ data: [], cursor: {} }),
    "GET /api/session/ses_parent": () => session("ses_parent", refreshed && scenario === "hidden" ? { revert: { messageID: resultId } } : {}),
    "GET /api/session/ses_child": () => unavailable() ? new Response(null, { status: 503 }) : session("ses_child", { parentID: "ses_parent" }),
    "GET /api/session/ses_other_child": () => new Response(null, { status: 503 }),
    "GET /api/session/ses_parent/message": () => ({ data: source !== "stored" ? [] : !refreshed ? scenario === "no-retained-worker" ? [] : [fixture.stored] : [stored], cursor: {} }),
    "GET /api/session/ses_child/message": () => ({ data: [], cursor: {} }),
    "GET /api/session/:id/inbox": () => ({ data: source !== "pending" ? [] : refreshed ? [pending] : scenario === "no-retained-worker" ? [] : [fixture.pending] }),
    "GET /api/session/active": () => ({}), "GET /api/permission/request": () => scoped([]), "GET /api/form": () => scoped([]),
  });
  const provider = server.provider(), adapter = new ChatAdapter({ provider, workspacePath: WORKSPACE, coalesceWindowMs });
  try {
    const initial = await adapter.history("ses_parent");
    if (scenario === "no-retained-worker") expect(initial.items).toEqual([]);
    else expect(initial.items).toContainEqual(expect.objectContaining({ type: "background_task", resultId: fixture.stored.id, status: "completed", summary: "Fixture checked." }));
    await adapter.stopEventPump(); refreshed = true;
    const history = await adapter.history("ses_parent");
    const next = await adapter.subscribe("ses_parent"); next.events.cancel();
    const reportText = (items: import("../../types").ConversationItem[]) => items.flatMap(item => item.type === "notice" ? [item.message] : item.type === "background_task" ? [item.summary ?? ""] : []).join("\n");
    if (unavailable()) {
      for (const snapshot of [history, next.snapshot]) for (const item of snapshot.items) if (item.type === "background_task") {
        expect(item.status).toBe("completed");
        expect(workerCanStop(item)).toBe(false); expect(workerExecutionClockRuns(item)).toBe(false);
        expect(item.control?.available).not.toBe(true);
      }
    }
    expect(server.calls.every(call => call.method === "GET")).toBe(true);
    if (scenario === "unchanged-later-clock") {
      // A delivery/read clock change is not a content revision: keep exactly
      // one completed worker representation, not a duplicate fallback notice.
      for (const snapshot of [history, next.snapshot]) {
        expect(snapshot.items.filter(item => item.id === `notice:${resultId}`)).toEqual([]);
        expect(snapshot.items.filter(item => item.type === "background_task" && item.resultId === resultId)).toEqual([expect.objectContaining({ summary: "Fixture checked.", status: "completed" })]);
      }
    } else {
      if (scenario === "hidden") for (const snapshot of [history, next.snapshot]) expect(reportText(snapshot.items)).not.toContain("UPDATED NATIVE REPORT");
      else expect({ history: reportText(history.items), subscription: reportText(next.snapshot.items) }).toEqual({
        history: expect.stringContaining("UPDATED NATIVE REPORT"), subscription: expect.stringContaining("UPDATED NATIVE REPORT"),
      });
    }
  } finally { await adapter.dispose(); expect(closed).toBe(opened); }
});

for (const coalesceWindowMs of [0, 25])
for (const cancel of [false, true]) test(`fallback supersession preserves a newer native notice (cancel=${cancel}/coalesce=${coalesceWindowMs})`, async () => {
  const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
  const owner = new AsyncLocalStorage<boolean>();
  let delivered = false, held = false, opened = 0, closed = 0;
  let wire!: ReadableStreamDefaultController<Uint8Array>, entered!: () => void, release!: () => void, applied!: () => void;
  const captured = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const eventApplied = new Promise<void>(resolve => { applied = resolve; });
  const server = fakeOpenCode({
    "GET /api/event": ({ signal }) => new Response(new ReadableStream<Uint8Array>({ start(controller) {
      wire = controller; opened++; controller.enqueue(new TextEncoder().encode('data: {"type":"server.connected","data":{}}\n\n'));
      signal.addEventListener("abort", () => { closed++; controller.close(); }, { once: true });
    } }), { headers: { "content-type": "text/event-stream" } }),
    "GET /api/session": () => ({ data: [], cursor: {} }),
    "GET /api/session/ses_parent": () => session("ses_parent"),
    "GET /api/session/ses_child": () => delivered ? session("ses_child", { parentID: "ses_parent" }) : new Response(null, { status: 503 }),
    "GET /api/session/ses_parent/message": () => ({ data: delivered ? [fixture.stored] : [], cursor: {} }),
    "GET /api/session/ses_child/message": () => ({ data: [], cursor: {} }),
    "GET /api/session/:id/inbox": () => ({ data: delivered ? [] : [fixture.pending] }),
    "GET /api/session/active": () => ({}), "GET /api/permission/request": () => scoped([]),
    "GET /api/form": async () => { if (delivered && owner.getStore() && !held) { held = true; entered(); await gate; } return scoped([]); },
  });
  const provider = server.provider(), events = provider.events.bind(provider);
    provider.events = async function* (signal) { for await (const event of events(signal)) { if (event.eventType === "diagnostic.fallback.complete") applied(); yield event; } };
  const adapter = new ChatAdapter({ provider, workspacePath: WORKSPACE, coalesceWindowMs });
  let reading: ReturnType<ChatAdapter["history"]> | undefined;
  try {
    expect((await adapter.history("ses_parent")).items).toContainEqual(expect.objectContaining({ id: "notice:msg_result", createdAt: 41 }));
    await adapter.stopEventPump(); delivered = true;
    const listener = await adapter.subscribe("ses_parent");
    reading = owner.run(true, () => adapter.history("ses_parent")); void reading.catch(() => undefined);
    await captured;
    const text = "A newer unrelated native notice";
    for (const event of [
      { id: "evt_new_notice", created: 50, type: "session.inbox.enqueued", data: { sessionID: "ses_parent", inboxID: "msg_result", item: { id: "msg_result", type: "synthetic", time: { created: 50 }, payload: { text } } } },
      { type: "diagnostic.fallback.complete", data: {} },
    ]) wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ ...event, location: { directory: WORKSPACE } })}\n\n`));
    await eventApplied;
    if (cancel) await adapter.stopEventPump();
    release();
    if (cancel) await expect(reading).rejects.toThrow("Inbox recovery unavailable");
    else expect((await reading).items).toContainEqual(expect.objectContaining({ id: "notice:msg_result", message: text, createdAt: 50 }));
    const next = await adapter.subscribe("ses_parent"); next.events.cancel();
    expect(next.snapshot.items).toContainEqual(expect.objectContaining({ id: "notice:msg_result", message: text, createdAt: 50 }));
    listener.events.cancel(); const publications = []; for await (const event of listener.events) publications.push(event);
    expect(publications).not.toContainEqual(expect.objectContaining({ type: "item.remove", itemId: "notice:msg_result" }));
    expect(server.calls.every(call => call.method === "GET")).toBe(true);
  } finally { release(); await reading?.catch(() => undefined); await adapter.dispose(); expect(closed).toBe(opened); }
});

for (const outcome of ["unavailable", "healthy", "foreign-parent", "foreign-workspace", "hidden-origin", "changed-occurrence", "changed-child", "changed-input", "ambiguous-origin", "returned-new", "cancel", "cancel-after-auto-stage", "new-live", "late-foreign-parent", "late-foreign-workspace"] as const)
test(`foreground undo retains only the exact available association (${outcome})`, async () => {
  const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
  const launch = structuredClone(fixture.launch), tool = launch.content[0];
  tool.state.input.background = false; tool.state.metadata = { sessionID: "ses_child", status: "completed" };
  tool.state.content = [{ type: "text", text: "Foreground fixture checked." }];
  const prompt = (id: string, created: number) => ({ id, type: "user", text: id, time: { created } });
  let changed = false, boundary: string | undefined, opened = 0, closed = 0, held = false, lateForeign = false;
  let wire!: ReadableStreamDefaultController<Uint8Array>, entered!: () => void, release!: () => void, applied!: () => void;
  const owner = new AsyncLocalStorage<boolean>(), captured = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; }), eventApplied = new Promise<void>(resolve => { applied = resolve; });
  const cancel = outcome === "cancel" || outcome === "cancel-after-auto-stage";
  let automaticEntered!: () => void, releaseAutomatic!: () => void;
  const automaticReady = new Promise<void>(resolve => { automaticEntered = resolve; });
  const automaticGate = new Promise<void>(resolve => { releaseAutomatic = resolve; });
  const gated = cancel || outcome === "new-live" || outcome.startsWith("late-");
  const unavailable = () => changed && (outcome === "unavailable" || outcome.startsWith("changed-") || outcome === "ambiguous-origin" || outcome === "hidden-origin" || gated && !lateForeign);
  const returned = outcome.startsWith("returned-");
  const server = fakeOpenCode({
    "GET /api/event": ({ signal }) => new Response(new ReadableStream<Uint8Array>({ start(controller) {
      wire = controller; opened++; controller.enqueue(new TextEncoder().encode('data: {"type":"server.connected","data":{}}\n\n'));
      signal.addEventListener("abort", () => { closed++; controller.close(); }, { once: true });
    } }), { headers: { "content-type": "text/event-stream" } }),
    "GET /api/session": () => ({ data: [], cursor: {} }),
    "GET /api/session/ses_parent": () => session("ses_parent", boundary ? { revert: { messageID: boundary } } : {}),
    "GET /api/session/ses_child": () => unavailable() ? new Response(null, { status: 503 }) : session("ses_child", {
      parentID: changed && (outcome === "foreign-parent" || lateForeign && outcome === "late-foreign-parent") ? "ses_other" : "ses_parent",
      cost: changed && returned ? 0.25 : 0.125,
      ...(changed && (outcome === "foreign-workspace" || lateForeign && outcome === "late-foreign-workspace") ? { location: { directory: "/foreign" } } : {}),
    }),
    "GET /api/session/ses_other_child": () => new Response(null, { status: 503 }),
    "GET /api/session/ses_parent/message": () => {
      const reused = structuredClone(launch); reused.id = "msg_reused_launch"; reused.content[0].state.metadata.sessionID = "ses_other_child";
      return { data: [prompt("msg_first", 1), ...(outcome === "hidden-origin" ? [prompt("msg_later", 10), launch] : [launch,
        ...(changed && outcome === "ambiguous-origin" ? [reused] : []), prompt("msg_later", 70)])], cursor: {} };
    },
    "GET /api/session/ses_child/message": () => ({ data: [{ id: "msg_priced", type: "assistant", time: { created: 25 }, model: { id: changed && returned ? "new-model" : "fixture-model" }, cost: changed && returned ? 0.25 : 0.125, content: [] }], cursor: {} }),
    "GET /api/session/:id/inbox": () => ({ data: [] }), "GET /api/session/active": () => ({}),
    "GET /api/permission/request": () => scoped([]), "GET /api/form": async () => {
      if (changed && gated && owner.getStore() && !held) { held = true; entered(); await gate; }
      // Reconnect also owns a covering read. Isolate its publication from the
      // explicit replacement being cancelled, rather than racing two owners.
      if (changed && cancel && !owner.getStore()) { automaticEntered(); await automaticGate; }
      return scoped([]);
    },
    "POST /api/session/ses_parent/revert/stage": ({ body }) => { boundary = (body as { messageID: string }).messageID; return { messageID: boundary }; },
  });
  const provider = server.provider(), events = provider.events.bind(provider);
  provider.events = async function* (signal) { for await (const event of events(signal)) { if (event.eventType === "diagnostic.foreground.complete") applied(); yield event; } };
  const adapter = new ChatAdapter({ provider, workspacePath: WORKSPACE, coalesceWindowMs: 0 });
  const history = adapter.history.bind(adapter);
  let automaticHistory: ReturnType<ChatAdapter["history"]> | undefined;
  adapter.history = (...args) => {
    const reading = history(...args);
    if (changed && cancel && !owner.getStore() && args[0] === "ses_parent") automaticHistory ??= reading;
    return reading;
  };
  const now = Date.now(); let elapsed = 0;
  const clock = returned ? spyOn(Date, "now").mockImplementation(() => now + elapsed) : undefined;
  let mutation: ReturnType<ChatAdapter["undo"]> | undefined;
  try {
    const first = await adapter.history("ses_parent");
    const prior = first.items.find(item => item.id === "tool:call_worker");
    expect(prior).toMatchObject({ type: "tool", status: "completed", childConversationId: "ses_child", workerSession: { costUsd: 0.125 }, model: "fixture-model", usage: { costUsd: 0.125 } });
    await adapter.stopEventPump(); changed = true;
    if (returned) elapsed = 31_000; // Expire completeness without changing its budget.
    if (outcome === "changed-occurrence") { tool.time.created = 21; launch.time.created = 21; }
    if (outcome === "changed-child") tool.state.metadata.sessionID = "ses_other_child";
    if (outcome === "changed-input") tool.state.input.prompt = "A distinct foreground invocation";
    void adapter.startEventPump();
    if (unavailable() && outcome !== "hidden-origin") {
      // Observe the real degraded provider page before replacement. No test
      // fabricates a sparse tool or reaches into provider/adapter caches.
      const sparse = await provider.listMessages("ses_parent", { limit: 100 });
      expect(sparse.items.find(item => item.id === "tool:call_worker")).not.toHaveProperty("childConversationId");
    }
    const reads = server.requests("GET", "/api/session/ses_child").length;
    mutation = owner.run(true, () => adapter.undo("ses_parent", "foreground-association"));
    if (gated) {
      await captured;
      if (cancel) {
        await automaticReady;
        expect(automaticHistory).toBeDefined();
        if (outcome === "cancel-after-auto-stage") {
          releaseAutomatic();
          const accepted = await automaticHistory!;
          expect(accepted.items.some(item => item.id === "message:msg_later")).toBe(false);
          expect(accepted.reversibleHistory).toMatchObject({ staged: true });
        }
      }
      if (cancel || outcome === "new-live") {
        tool.state.content = [{ type: "text", text: "Newer live foreground report." }];
        for (const event of [
          { id: "evt_foreground", created: 90, type: "session.message.content.updated", durable: { aggregateID: "ses_parent", seq: 1, version: 1 }, data: { sessionID: "ses_parent", messageID: launch.id, content: launch.content } },
          { type: "diagnostic.foreground.complete", data: {} },
        ]) wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ ...event, location: { directory: WORKSPACE } })}\n\n`));
        await eventApplied;
        if (cancel) {
          // The positive control accepts the live reread too: its authoritative
          // staged projection must retain the newer report across cancellation.
          if (outcome === "cancel-after-auto-stage") await adapter.history("ses_parent");
          await adapter.stopEventPump();
          if (outcome === "cancel") await expect(automaticHistory!).rejects.toThrow("Inbox recovery unavailable");
        }
      } else { lateForeign = true; await provider.getSession("ses_child"); }
      release();
    }
    expect(await mutation).toMatchObject({ outcome: "changed", state: { staged: true } });
    if (outcome !== "changed-child") expect(server.requests("GET", "/api/session/ses_child").length).toBeGreaterThan(reads);
    const next = await adapter.subscribe("ses_parent"); next.events.cancel();
    expect(next.snapshot.items.some(item => item.id === "message:msg_later")).toBe(outcome === "cancel");
    expect(next.snapshot.items.some(item => item.type === "background_task")).toBe(false);
    expect(server.calls.filter(call => call.method !== "GET").map(call => [call.method, call.path, call.body])).toEqual([
      ["POST", "/api/session/ses_parent/revert/stage", { messageID: "msg_later" }],
    ]);
    const row = next.snapshot.items.find(item => item.id === "tool:call_worker");
    if (outcome === "changed-occurrence") expect(row).toMatchObject({ createdAt: 21 });
    if (outcome === "hidden-origin") expect(row).toBeUndefined();
    else {
      expect(row).toMatchObject({ type: "tool", status: "completed", output: outcome === "new-live" || cancel ? "Newer live foreground report." : "Foreground fixture checked." });
      if (outcome === "unavailable" || outcome === "healthy") expect(row).toMatchObject({ childConversationId: "ses_child", workerSession: { costUsd: 0.125 }, model: "fixture-model", usage: { costUsd: 0.125 } });
      else if (outcome === "returned-new") expect(row).toMatchObject({ childConversationId: "ses_child", workerSession: { costUsd: 0.25 }, model: "new-model", usage: { costUsd: 0.25 } });
      else if (outcome !== "new-live" && !cancel) {
        expect(row).not.toHaveProperty("childConversationId"); expect(row).not.toHaveProperty("workerSession"); expect(row).not.toHaveProperty("model"); expect(row).not.toHaveProperty("usage");
      }
    }
  } finally { release(); releaseAutomatic(); await mutation?.catch(() => undefined); await automaticHistory?.catch(() => undefined); clock?.mockRestore(); await adapter.dispose(); expect(closed).toBe(opened); }
});

for (const outcome of [
  "unavailable", "unchanged", "healthy", "current-accounting", "cold", "paged",
  "changed-occurrence", "changed-input", "changed-child", "foreign-parent", "foreign-workspace", "hidden-origin", "hidden-origin-unchanged", "ambiguous-origin",
  "newer-occurrences", "newer-inputs", "newer-first-occurrence", "newer-first-input", "newer-second-occurrence", "newer-second-input",
  "newer-first-occurrence-paged", "newer-first-input-paged", "newer-second-occurrence-paged", "newer-second-input-paged",
  "newer-first-input-foreign-parent", "newer-first-occurrence-foreign-workspace", "newer-first-input-current-accounting", "newer-first-input-unrelated", "newer-second-input-recovery",
  "post-history-input", "post-history-occurrence", "post-history-unchanged", "post-history-healthy", "post-history-cold",
  "post-history-unchanged-unrelated", "post-history-input-unrelated",
  "post-history-input-recovery", "post-history-input-owner-eviction", "post-history-input-projection-eviction",
  "post-history-input-recovery-zero",
  "post-history-input-pending-eviction", "post-history-input-pending-eviction-unpinned",
  "post-history-input-same-generation",
] as const)
test(`concurrent foreground output preserves complete shared-child attribution order (${outcome})`, async () => {
  const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
  const first = structuredClone(fixture.launch), second = structuredClone(fixture.launch);
  first.content[0].state.input.background = false;
  first.content[0].state.metadata = { sessionID: "ses_child", status: "completed" };
  first.content[0].state.content = [{ type: "text", text: "First foreground result." }];
  second.id = "msg_second"; second.time.created = 60;
  second.content[0].id = "call_second"; second.content[0].time = { created: 60, completed: 70 };
  second.content[0].state.input = { ...first.content[0].state.input, prompt: "Second task", sessionID: "ses_child" };
  second.content[0].state.metadata = { sessionID: "ses_child", status: "completed" };
  second.content[0].state.content = [{ type: "text", text: "Second foreground result." }];
  const cold = outcome === "cold" || outcome === "post-history-cold";
  let changed = cold, held = false, opened = 0, closed = 0, admitRestatement = false;
  let wire!: ReadableStreamDefaultController<Uint8Array>, entered!: () => void, release!: () => void, applied!: () => void;
  const owner = new AsyncLocalStorage<boolean>(), captured = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; }), eventApplied = new Promise<void>(resolve => { applied = resolve; });
  let warmed!: () => void, restated!: () => void, pressured!: () => void, invalidated!: () => void;
  const warmApplied = new Promise<void>(resolve => { warmed = resolve; });
  const restatementApplied = new Promise<void>(resolve => { restated = resolve; });
  const pressureApplied = new Promise<void>(resolve => { pressured = resolve; });
  const invalidationApplied = new Promise<void>(resolve => { invalidated = resolve; });
  const postOutcome = outcome.startsWith("post-history-");
  const postHistory = postOutcome || outcome === "newer-second-input-recovery";
  const ownerEviction = outcome.endsWith("-owner-eviction"), projectionEviction = outcome.endsWith("-projection-eviction");
  const pendingProjection = outcome.includes("-pending-eviction"), unpinned = outcome.endsWith("-unpinned");
  const sameGeneration = outcome.endsWith("-same-generation");
  let publicationHeld = false, publicationEntered!: () => void, releasePublication!: () => void;
  const publicationReady = new Promise<void>(resolve => { publicationEntered = resolve; });
  const publicationGate = new Promise<void>(resolve => { releasePublication = resolve; });
  let pressureHeld = false, pressureEntered!: () => void, releasePressure!: () => void;
  const pressureReady = new Promise<void>(resolve => { pressureEntered = resolve; });
  const pressureGate = new Promise<void>(resolve => { releasePressure = resolve; });
  const changedStoredInput = outcome === "changed-input" || postOutcome && outcome.includes("-input");
  const changedStoredOccurrence = outcome === "changed-occurrence" || postOutcome && outcome.includes("-occurrence");
  const paged = outcome === "paged" || outcome.endsWith("-paged");
  const firstOnly = outcome.startsWith("newer-first-"), secondOnly = outcome.startsWith("newer-second-");
  const secondInput = secondOnly && outcome.includes("-input");
  const firstOccurrence = outcome === "newer-occurrences" || firstOnly && outcome.includes("-occurrence");
  const secondOccurrence = outcome === "newer-occurrences" || secondOnly && outcome.includes("-occurrence");
  const foreignParent = outcome === "foreign-parent" || outcome.endsWith("-foreign-parent");
  const foreignWorkspace = outcome === "foreign-workspace" || outcome.endsWith("-foreign-workspace");
  const foreign = foreignParent || foreignWorkspace;
  const hidden = outcome.startsWith("hidden-origin");
  let freshAccounting = outcome === "current-accounting" || outcome.endsWith("-current-accounting");
  const recovering = outcome.includes("-recovery");
  const zero = outcome.endsWith("-zero");
  const unrelated = outcome.endsWith("-unrelated");
  const unrelatedLaunch = structuredClone(second);
  unrelatedLaunch.id = "msg_unrelated"; unrelatedLaunch.time.created = 80;
  unrelatedLaunch.content[0].id = "call_unrelated"; unrelatedLaunch.content[0].time = { created: 80, completed: 90 };
  unrelatedLaunch.content[0].state.input.prompt = "Unrelated task";
  unrelatedLaunch.content[0].state.input.sessionID = "ses_other_child";
  unrelatedLaunch.content[0].state.metadata.sessionID = "ses_other_child";
  const unavailable = () => changed && !foreign && outcome !== "healthy" && outcome !== "post-history-healthy" && !freshAccounting;
  const later = Array.from({ length: 51 }, (_, index) => ({ id: `msg_between_${index}`, type: "user", text: `Between calls ${index}`, time: { created: 40 + index / 10 } }));
  const server = fakeOpenCode({
    "GET /api/event": ({ signal }) => new Response(new ReadableStream<Uint8Array>({ start(controller) {
      wire = controller; opened++; controller.enqueue(new TextEncoder().encode('data: {"type":"server.connected","data":{}}\n\n'));
      signal.addEventListener("abort", () => { closed++; controller.close(); }, { once: true });
    } }), { headers: { "content-type": "text/event-stream" } }),
    "GET /api/session": () => ({ data: [], cursor: {} }),
    "GET /api/session/ses_parent": () => session("ses_parent", changed && hidden ? { revert: { messageID: second.id } } : {}),
    "GET /api/session/ses_child": () => unavailable() && !admitRestatement ? new Response(null, { status: 503 }) : session("ses_child", {
      parentID: changed && foreignParent ? "ses_other" : "ses_parent", cost: changed && freshAccounting ? zero ? 0.5 : 0.9 : 0.3,
      ...(changed && foreignWorkspace ? { location: { directory: "/foreign" } } : {}),
    }),
    "GET /api/session/ses_other_child": () => unrelated ? session("ses_other_child", { parentID: "ses_parent", cost: 0.05 }) : new Response(null, { status: 503 }),
    "GET /api/session/ses_parent/message": () => {
      const ambiguous = structuredClone(second); ambiguous.id = "msg_ambiguous"; ambiguous.content[0].state.metadata.sessionID = "ses_other_child";
      return { data: [first, ...(changed && paged ? later : []), second, ...(unrelated ? [unrelatedLaunch] : []), ...(changed && outcome === "ambiguous-origin" ? [ambiguous] : [])], cursor: {} };
    },
    "GET /api/session/ses_child/message": () => ({ data: [
      { id: "msg_prompt_first", type: "user", text: first.content[0].state.input.prompt, time: { created: 21 } },
      { id: "msg_spend_first", type: "assistant", model: { id: changed && freshAccounting ? "new-model" : "fixture-model" }, cost: changed && freshAccounting ? zero ? 0 : 0.4 : 0.1, time: { created: 25 }, content: [] },
      { id: "msg_prompt_second", type: "user", text: (recovering || pendingProjection) && freshAccounting ? second.content[0].state.input.prompt : "Second task", time: { created: 61 } },
      { id: "msg_spend_second", type: "assistant", model: { id: changed && freshAccounting ? "new-model" : "fixture-model" }, cost: changed && freshAccounting ? 0.5 : 0.2, time: { created: 65 }, content: [] },
    ], cursor: {} }),
    "GET /api/session/ses_other_child/message": () => ({ data: [
      { id: "msg_unrelated_prompt", type: "user", text: "Unrelated task", time: { created: 81 } },
      { id: "msg_unrelated_spend", type: "assistant", model: { id: "unrelated-model" }, cost: 0.05, time: { created: 85 }, content: [] },
    ], cursor: {} }),
    "GET /api/session/:id/inbox": () => ({ data: [] }), "GET /api/session/active": () => ({}),
    "GET /api/permission/request": () => scoped([]), "GET /api/form": () => scoped([]),
    "GET /api/session/:id": call => {
      const id = call.path.split("/").at(-1)!;
      return session(id, id.startsWith("ses_cohort_pressure_") ? { parentID: "ses_pressure_parent" } : {});
    },
    "GET /api/session/:id/message": () => ({ data: [], cursor: {} }),
  });
  const provider = server.provider(), list = provider.listMessages.bind(provider), events = provider.events.bind(provider);
  let capturedPage: Awaited<ReturnType<OpenCodeV2Provider["listMessages"]>> | undefined;
  provider.listMessages = async (id, options) => {
    const page = await list(id, options);
    if (changed && owner.getStore() && id === "ses_parent" && !held) {
      // Hold the real native page before adapter attribution, not a private
      // cache or a fabricated sparse tool. Only the explicit reader is gated.
      held = true; capturedPage = page;
      entered(); await gate;
    }
    return page;
  };
  const boundary = provider.getHistoryRevertBoundary.bind(provider);
  provider.getHistoryRevertBoundary = async (...args) => {
    const value = await boundary(...args);
    if (pendingProjection && changed && owner.getStore() && args[0] === "ses_parent" && !publicationHeld) {
      publicationHeld = true; publicationEntered(); await publicationGate;
    }
    if (unpinned && freshAccounting && args[0] === "ses_projection_pressure_2" && args[1]?.expectedBoundary !== undefined && !pressureHeld) {
      pressureHeld = true; pressureEntered(); await pressureGate;
    }
    return value;
  };
  provider.events = async function* (signal) { for await (const event of events(signal)) {
    if (event.eventType === "diagnostic.shared.foreground.complete") applied();
    if (event.eventType === "diagnostic.cohort.warm") warmed();
    if (event.eventType === "diagnostic.cohort.restated") restated();
    if (event.eventType === "diagnostic.cohort.pressure") pressured();
    if (event.eventType === "diagnostic.cohort.invalidated") invalidated();
    yield event;
  } };
  const restate = (phase: "warm" | "restated") => {
    for (const event of [
      { id: `evt_cohort_model_${phase}`, type: "session.step.started", created: 25, data: { sessionID: "ses_child", assistantMessageID: "msg_spend_first", started: 25, model: { providerID: "fixture", id: pendingProjection && phase === "restated" ? "restated-model" : freshAccounting ? "new-model" : "fixture-model" } } },
      { id: `evt_cohort_usage_${phase}`, type: "session.step.ended", created: 25, data: { sessionID: "ses_child", assistantMessageID: "msg_spend_first", cost: freshAccounting ? zero ? 0 : 0.4 : 0.1 } },
      { type: `diagnostic.cohort.${phase}`, data: {} },
    ]) wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ ...event, location: { directory: WORKSPACE } })}\n\n`));
  };
  const adapter = new ChatAdapter({ provider, workspacePath: WORKSPACE, coalesceWindowMs: 0, ...(projectionEviction || pendingProjection ? { maxProjections: 2 } : {}) });
  const history = adapter.history.bind(adapter);
  const recoveryReads = new Map<string, ReturnType<ChatAdapter["history"]>>();
  adapter.history = (...args) => {
    const reading = history(...args);
    if (unpinned && freshAccounting && !owner.getStore() && args[1]?.limit === undefined) recoveryReads.set(args[0], reading);
    return reading;
  };
  const rows = (items: import("../../types").ConversationItem[]) => items.filter(item => item.type === "tool");
  const costs = (items: import("../../types").ConversationItem[]) => rows(items).filter(item => item.id !== "tool:call_unrelated").map(item => item.usage?.costUsd);
  const now = Date.now(); let elapsed = 0;
  const clock = freshAccounting || recovering || pendingProjection ? spyOn(Date, "now").mockImplementation(() => now + elapsed) : undefined;
  let reading: ReturnType<ChatAdapter["history"]> | undefined;
  let observer: Awaited<ReturnType<ChatAdapter["subscribe"]>> | undefined;
  let retained: Awaited<ReturnType<ChatAdapter["subscribe"]>> | undefined;
  let publicationView: Awaited<ReturnType<ChatAdapter["subscribe"]>> | undefined, nativePublication: Promise<void> | undefined;
  try {
    const initial = await adapter.history("ses_parent");
    expect(costs(initial.items)).toEqual(cold ? [undefined, undefined] : [0.1, 0.2]);
    const unrelatedRow = initial.items.find(item => item.id === "tool:call_unrelated");
    if (postHistory && !cold && (!recovering || postOutcome)) {
      // Establish parent routing through the public native event path while
      // ownership is healthy; later 503s must not be mistaken for counterproof.
      restate("warm"); await warmApplied;
      const warm = await adapter.subscribe("ses_parent"); warm.events.cancel();
      expect(costs(warm.snapshot.items)).toEqual([0.1, 0.2]);
    }
    if (sameGeneration) {
      second.content[0].state.input.prompt = "A distinct second invocation";
      for (const info of [session("ses_child", { parentID: "ses_parent", cost: 0.3 }), session("ses_parent")])
        wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "session.updated", created: 90, location: { directory: WORKSPACE }, data: { info } })}\n\n`));
      wire.enqueue(new TextEncoder().encode('data: {"type":"diagnostic.cohort.invalidated","data":{}}\n\n'));
      await invalidationApplied;
    } else await adapter.stopEventPump();
    changed = true;
    if (freshAccounting) elapsed = 31_000;
    if (changedStoredOccurrence) { second.time.created = 62; second.content[0].time.created = 62; }
    if (changedStoredInput) second.content[0].state.input.prompt = "A distinct second invocation";
    if (outcome === "changed-child") second.content[0].state.metadata.sessionID = "ses_other_child";
    void adapter.startEventPump();
    reading = owner.run(true, () => adapter.history("ses_parent"));
    void reading.catch(() => undefined);
    await captured;
    const tools = capturedPage!.items.filter(item => item.type === "tool" && item.id !== "tool:call_unrelated");
    expect(tools).toHaveLength(paged || hidden ? 1 : 2);
    if (unavailable()) expect(tools.every(item => item.type === "tool" && !item.childConversationId)).toBe(true);
    const content = structuredClone(first.content);
    content[0].state.content = [{ type: "text", text: "Newer first foreground output." }];
    const changedLiveBinding = outcome.startsWith("newer-");
    const updateFirst = outcome !== "unchanged" && outcome !== "hidden-origin-unchanged" && !secondOnly && !postHistory;
    const updateSecond = changedLiveBinding && !firstOnly;
    const secondContent = structuredClone(second.content);
    secondContent[0].state.content = [{ type: "text", text: "Newer second foreground output." }];
    if (changedLiveBinding) observer = await adapter.subscribe("ses_parent");
    if (outcome === "newer-occurrences") {
      content[0].time = { created: 21, completed: 31 }; secondContent[0].time = { created: 62, completed: 72 };
    }
    if (outcome === "newer-inputs") {
      content[0].state.input.prompt = "New first task"; secondContent[0].state.input.prompt = "New second task";
    }
    if (firstOccurrence) content[0].time = { created: 21, completed: 31 };
    if (secondOccurrence) secondContent[0].time = { created: 62, completed: 72 };
    if (firstOnly && outcome.includes("-input")) content[0].state.input.prompt = "New first task";
    if (secondOnly && outcome.includes("-input")) secondContent[0].state.input.prompt = "New second task";
    const liveAccounting = freshAccounting ? [
      { type: "session.step.started", created: 25, data: { sessionID: "ses_child", assistantMessageID: "msg_spend_first", started: 25, model: { providerID: "fixture", id: "new-model" } } },
      { type: "session.step.ended", created: 25, data: { sessionID: "ses_child", assistantMessageID: "msg_spend_first", cost: 0.4 } },
      { type: "session.step.started", created: 65, data: { sessionID: "ses_child", assistantMessageID: "msg_spend_second", started: 65, model: { providerID: "fixture", id: "new-model" } } },
      { type: "session.step.ended", created: 65, data: { sessionID: "ses_child", assistantMessageID: "msg_spend_second", cost: 0.5 } },
    ] : [];
    // The repro restates the original clock; the newer-binding controls
    // deliberately mismatch the captured page and must never revoke live rows.
    for (const event of [...liveAccounting, ...(updateFirst ? [
      { id: "evt_shared_foreground", created: firstOccurrence ? 21 : 20, type: "session.message.content.updated", durable: { aggregateID: "ses_parent", seq: 1, version: 1 }, data: { sessionID: "ses_parent", messageID: first.id, content } },
    ] : []), ...(updateSecond ? [
      { id: "evt_shared_second", created: secondOccurrence ? 62 : 60, type: "session.message.content.updated", durable: { aggregateID: "ses_parent", seq: 2, version: 1 }, data: { sessionID: "ses_parent", messageID: second.id, content: secondContent } },
    ] : []),
      { type: "diagnostic.shared.foreground.complete", data: {} },
    ]) wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ ...event, location: { directory: WORKSPACE } })}\n\n`));
    await eventApplied;
    const current = await adapter.subscribe("ses_parent"); current.events.cancel();
    const newer = rows(current.snapshot.items).find(item => item.id === "tool:call_worker");
    const newerSecond = rows(current.snapshot.items).find(item => item.id === "tool:call_second");
    expect(newer).toMatchObject({ output: updateFirst ? "Newer first foreground output." : "First foreground result.",
      ...(!foreign && !secondOnly && !cold ? { usage: { costUsd: freshAccounting ? 0.4 : 0.1 } } : {}) });
    // The live snapshot must already respect the cohort before the captured
    // history page is released; recovery cannot repair a bad live allocation.
    if (changedLiveBinding && !foreign) expect(costs(current.snapshot.items)).toEqual(freshAccounting ? [0.4, 0.5] : secondInput ? [0.1, undefined] : [0.1, 0.2]);
    if (firstOnly && firstOccurrence) expect(newer).toMatchObject({ createdAt: 21, completedAt: 31 });
    if (firstOnly && outcome.includes("-input")) expect(newer?.input).toBe(JSON.stringify(content[0].state.input));
    if (secondOnly) {
      expect(newerSecond).toMatchObject({ output: "Newer second foreground output.", ...(!secondInput ? { usage: { costUsd: 0.2 } } : {}) });
      if (secondInput) expect(newerSecond).not.toHaveProperty("usage");
    }
    release();
    if (pendingProjection) {
      // The negative cohort decision exists only in a held read. Eviction
      // retires that owner before a new authoritative cohort publishes.
      await publicationReady;
      for (let index = 0; index < 3; index++) await adapter.history(`ses_projection_pressure_${index}`);
      const reset = await adapter.subscribe("ses_parent");
      expect(reset.snapshot.items).toEqual([]);
      // The view under test stays selected after its intentional eviction.
      // A separate unpinned control exercises legitimate two-view LRU loss.
      if (unpinned) reset.events.cancel(); else retained = reset;
      await adapter.stopEventPump();
      await expect(reading).rejects.toThrow("Inbox recovery unavailable");
      second.content = secondContent; freshAccounting = true; elapsed = 31_000;
      const replacement = await owner.run(false, () => adapter.history("ses_parent", { limit: 49 }));
      expect(costs(replacement.items)).toEqual([0.4, 0.5]);
      if (unpinned) {
        await pressureReady;
        const parentRecovery = recoveryReads.get("ses_parent");
        expect(parentRecovery).toBeDefined(); await parentRecovery!;
        // Observe the child's actual usage publication, not a provider-admission
        // marker or a timer. Selecting it uses the same existing two-view budget.
        publicationView = await adapter.subscribe("ses_child", { signal: AbortSignal.timeout(3_000) });
      } else {
        // Start a fresh replay handoff after the history publication. The
        // original retained subscription keeps this same parent view pinned.
        publicationView = await adapter.subscribe("ses_parent", { signal: AbortSignal.timeout(3_000) });
      }
      nativePublication = (async () => {
        const itemId = unpinned ? "usage:msg_spend_first" : "tool:call_worker";
        for await (const event of publicationView!.events) if (event.type === "item.upsert" && event.item.id === itemId) {
          expect(event.item).toMatchObject({ type: unpinned ? "assistant_message" : "tool", usage: { costUsd: 0.4 } });
          if (!unpinned) expect(event.item).toMatchObject({ model: "restated-model" });
          return;
        }
        throw new Error("Missing current native restatement publication");
      })();
      void nativePublication.catch(() => undefined);
      releasePublication();
      restate("restated"); await restatementApplied;
      await nativePublication;
      if (unpinned) {
        const pressureRecovery = recoveryReads.get("ses_projection_pressure_2");
        expect(pressureRecovery).toBeDefined();
        releasePressure(); await pressureRecovery!;
      }
      const current = await adapter.subscribe("ses_parent"); current.events.cancel();
      if (unpinned) {
        // Fresh accounting succeeded before a legitimate unobserved-view
        // eviction. An empty recreated view is unknown, never a zero receipt.
        expect(costs(replacement.items)).toEqual([0.4, 0.5]);
        expect(conversationTotals(replacement.items)?.costUsd).toBeCloseTo(0.9);
        expect(current.snapshot.items).toEqual([]);
        expect(conversationTotals(current.snapshot.items)).toBeUndefined();
      } else {
        expect(costs(current.snapshot.items)).toEqual([0.4, 0.5]);
        expect(conversationTotals(current.snapshot.items)?.costUsd).toBeCloseTo(0.9);
      }
      return;
    }
    const history = await reading;
    const next = await adapter.subscribe("ses_parent"); next.events.cancel();
    let published = next.snapshot;
    for (const snapshot of [history, next.snapshot]) {
      if (!foreign) expect(rows(snapshot.items).find(item => item.id === "tool:call_worker")).toMatchObject({ output: updateFirst ? "Newer first foreground output." : "First foreground result." });
      if (!foreign && !secondOnly) expect(rows(snapshot.items).find(item => item.id === "tool:call_worker")).toEqual(newer);
      if (foreign) for (const row of rows(snapshot.items)) {
        expect(row).not.toHaveProperty("childConversationId"); expect(row).not.toHaveProperty("usage"); expect(row).not.toHaveProperty("model"); expect(row).not.toHaveProperty("workerSession");
      }
      if (updateSecond) expect(rows(snapshot.items).find(item => item.id === "tool:call_second")).toEqual(newerSecond);
      if (outcome.startsWith("changed-") || changedStoredInput || changedStoredOccurrence || outcome === "ambiguous-origin") {
        const secondRow = rows(snapshot.items).find(item => item.id === "tool:call_second");
        expect(secondRow).toMatchObject({ type: "tool", status: "completed", output: "Second foreground result." });
        for (const key of ["childConversationId", "usage", "model", "workerSession"]) expect(secondRow).not.toHaveProperty(key);
      }
      if (hidden) expect(rows(snapshot.items).some(item => item.id === "tool:call_second")).toBe(false);
      if (unrelated) {
        expect(snapshot.items.find(item => item.id === "tool:call_unrelated")).toEqual(unrelatedRow);
        expect(unrelatedRow).toMatchObject({ childConversationId: "ses_other_child", model: "unrelated-model", usage: { costUsd: 0.05 } });
      }
      expect(snapshot.items.some(item => item.type === "background_task")).toBe(false);
    }
    expect(server.calls.every(call => call.method === "GET")).toBe(true);
    if (paged) {
      expect(history.olderCursor).toBeDefined();
      expect(history.items.filter(item => item.type === "user_message")).toHaveLength(49);
    }
    const expected = freshAccounting ? [0.4, 0.5] : foreign || cold ? [undefined, undefined] : secondInput ? [0.1, undefined]
      : outcome.startsWith("changed-") || changedStoredInput || changedStoredOccurrence ? [0.1, undefined] : hidden ? [0.1]
      : outcome === "ambiguous-origin" ? [0.1, undefined] : [0.1, 0.2];
    const expectedCents = foreign || cold ? undefined : freshAccounting ? 90 : secondInput ? 10
      : outcome.startsWith("changed-") || changedStoredInput || changedStoredOccurrence || hidden || outcome === "ambiguous-origin" ? 10 : 30;
    const receipt = (items: import("../../types").ConversationItem[]) => {
      const total = conversationTotals(items)?.costUsd;
      return { costs: costs(items), receiptCents: total === undefined ? undefined : Math.round(total * 100) };
    };
    expect({ history: receipt(history.items), subscription: receipt(next.snapshot.items) }).toEqual({
      history: { costs: expected, receiptCents: expectedCents === undefined ? undefined : expectedCents + (unrelated ? 5 : 0) },
      subscription: { costs: expected, receiptCents: expectedCents === undefined ? undefined : expectedCents + (unrelated ? 5 : 0) },
    });
    for (const snapshot of [history, next.snapshot]) {
      const total = conversationTotals(snapshot.items)?.costUsd;
      if (foreign || cold) expect(total).toBeUndefined();
      else expect(total).toBeCloseTo((freshAccounting ? 0.9 : secondInput || outcome.startsWith("changed-") || changedStoredInput || changedStoredOccurrence || hidden || outcome === "ambiguous-origin" ? 0.1 : 0.3) + (unrelated ? 0.05 : 0));
      if (freshAccounting) expect(rows(snapshot.items).map(item => item.model)).toEqual(["new-model", "new-model"]);
    }
    if (observer) {
      observer.events.cancel(); const publications = []; for await (const event of observer.events) publications.push(event);
      if (!foreign) {
        expect(publications).not.toContainEqual(expect.objectContaining({ type: "item.remove", itemId: "tool:call_worker" }));
        const removal = expect.objectContaining({ type: "item.remove", itemId: "tool:call_second" });
        if (secondInput) expect(publications).toContainEqual(removal); // Deliberate withdrawal of the changed row's old usage.
        else expect(publications).not.toContainEqual(removal);
      }
    }
    if (recovering) {
      // Fresh authoritative parent/child records make the new task provable.
      // Expire the existing reuse window; do not extend any cache or budget.
      second.content = secondContent; freshAccounting = true; elapsed = 31_000;
      await adapter.stopEventPump();
      const restored = await adapter.history("ses_parent");
      const following = await adapter.subscribe("ses_parent"); following.events.cancel();
      published = following.snapshot;
      for (const snapshot of [restored, following.snapshot]) {
        expect(costs(snapshot.items)).toEqual([zero ? 0 : 0.4, 0.5]);
        expect(conversationTotals(snapshot.items)?.costUsd).toBeCloseTo(zero ? 0.5 : 0.9);
        expect(rows(snapshot.items).map(item => item.model)).toEqual(["new-model", "new-model"]);
        expect(rows(snapshot.items).find(item => item.id === "tool:call_second")).toMatchObject({ output: "Newer second foreground output.", input: JSON.stringify(secondContent[0].state.input) });
      }
    }
    if (postHistory) {
      // The read has published and withdrawn the second association. An
      // unchanged child accounting restatement is not fresh cohort proof.
      // Session confinement can recover without new child task/accounting proof.
      if (ownerEviction) {
        retained = await adapter.subscribe("ses_parent");
        // Real 512-entry attribution-owner pressure, model-only: the victim's
        // per-message usage map is not churned along with its owner metadata.
        for (let index = 0; index < 513; index++) wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({
          type: "session.step.started", created: 1000 + index, location: { directory: WORKSPACE },
          data: { sessionID: `ses_cohort_pressure_${index}`, assistantMessageID: `pressure_${index}`, model: { providerID: "fixture", id: "pressure-model" } },
        })}\n\n`));
        wire.enqueue(new TextEncoder().encode('data: {"type":"diagnostic.cohort.pressure","data":{}}\n\n'));
        await pressureApplied;
        const pressured = await adapter.subscribe("ses_parent"); pressured.events.cancel();
        expect(receipt(pressured.snapshot.items)).toEqual({ costs: [0.1, undefined], receiptCents: 10 });
      }
      if (projectionEviction) {
        for (let index = 0; index < 3; index++) await adapter.history(`ses_projection_pressure_${index}`);
        const reset = await adapter.subscribe("ses_parent"); reset.events.cancel();
        expect(reset.snapshot.items).toEqual([]);
      }
      const transcriptReads = server.requests("GET", "/api/session/ses_child/message").length;
      admitRestatement = true;
      restate("restated"); await restatementApplied;
      const after = await adapter.subscribe("ses_parent"); after.events.cancel();
      expect(server.requests("GET", "/api/session/ses_child/message").length).toBe(transcriptReads);
      if (projectionEviction) {
        expect(rows(after.snapshot.items).every(item => item.usage === undefined)).toBe(true);
        expect(conversationTotals(after.snapshot.items)).toBeUndefined();
        return;
      }
      const rejected = after.snapshot.items.find(item => item.id === "tool:call_second");
      expect(rejected).toEqual(published.items.find(item => item.id === "tool:call_second"));
      if (!freshAccounting && (changedStoredInput || changedStoredOccurrence || cold))
        for (const key of ["childConversationId", "usage", "model", "workerSession"]) expect(rejected).not.toHaveProperty(key);
      if (unrelated) expect(after.snapshot.items.find(item => item.id === "tool:call_unrelated")).toEqual(unrelatedRow);
      expect(receipt(after.snapshot.items)).toEqual({
        costs: freshAccounting ? [zero ? 0 : 0.4, 0.5] : expected,
        receiptCents: freshAccounting ? zero ? 50 : 90 : expectedCents === undefined ? undefined : expectedCents + (unrelated ? 5 : 0),
      });
      expect(server.calls.every(call => call.method === "GET")).toBe(true);
    }
  } finally { release(); releasePublication(); releasePressure(); observer?.events.cancel(); retained?.events.cancel(); publicationView?.events.cancel(); await nativePublication?.catch(() => undefined); await reading?.catch(() => undefined); await Promise.allSettled([...recoveryReads.values()]); clock?.mockRestore(); await adapter.dispose(); expect(closed).toBe(opened); }
});

for (const depth of ["direct", "root"] as const) for (const remaining of [0.5, 0])
for (const change of remaining === 0 && depth === "root" ? ["unchanged"] as const : depth === "direct" && remaining === 0.5
  ? ["unchanged", "input", "clock", "output", "held-output", "held-input", "held-clock", "held-cancel", "held-generation", "held-foreign-parent", "held-foreign-workspace"] as const
  : ["unchanged", "input", "clock", "output"] as const)
test(`source-current child undo reprices its exact retained foreground launcher (${depth}/${remaining}/${change})`, async () => {
  const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
  const launch = structuredClone(fixture.launch), tool = launch.content[0];
  tool.state.input.background = false; tool.state.metadata = { sessionID: "ses_child", status: "completed" };
  tool.state.content = [{ type: "text", text: "Foreground fixture checked." }];
  const root = structuredClone(launch); root.id = "msg_root"; root.time.created = 10;
  root.content[0].id = "call_root"; root.content[0].time = { created: 10, completed: 15 };
  root.content[0].state.metadata.sessionID = "ses_parent";
  let boundary: string | undefined, opened = 0, closed = 0;
  let wire!: ReadableStreamDefaultController<Uint8Array>, applied!: () => void;
  const held = change.startsWith("held-"), fieldChange = change.replace("held-", "");
  let entered!: () => void, release!: () => void, releaseStartup!: () => void, startupEntered!: () => void;
  const captured = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const freshStartup = new Promise<void>(resolve => { releaseStartup = resolve; }), startupReady = new Promise<void>(resolve => { startupEntered = resolve; });
  let rewrittenReads = 0, lateForeign = false, holdStartup = false;
  const server = fakeOpenCode({
    "GET /api/event": ({ signal }) => new Response(new ReadableStream<Uint8Array>({ start(controller) {
      wire = controller; opened++; controller.enqueue(new TextEncoder().encode('data: {"type":"server.connected","data":{}}\n\n'));
      signal.addEventListener("abort", () => { closed++; controller.close(); }, { once: true });
    } }), { headers: { "content-type": "text/event-stream" } }),
    "GET /api/session": () => ({ data: [], cursor: {} }),
    "GET /api/session/ses_root": () => session("ses_root"),
    "GET /api/session/ses_root/message": () => ({ data: [root], cursor: {} }),
    "GET /api/session/ses_parent": () => session("ses_parent", depth === "root" ? { parentID: "ses_root" } : {}),
    "GET /api/session/ses_child": () => session("ses_child", { parentID: lateForeign && fieldChange === "foreign-parent" ? "ses_other" : "ses_parent", cost: boundary ? remaining : remaining + 0.25,
      ...(boundary ? { revert: { messageID: boundary } } : {}), ...(lateForeign && fieldChange === "foreign-workspace" ? { location: { directory: "/foreign" } } : {}) }),
    "GET /api/session/ses_parent/message": () => ({ data: [launch], cursor: {} }),
    "GET /api/session/ses_child/message": () => ({ data: [
      { id: "prompt_first", type: "user", text: tool.state.input.prompt, time: { created: 22 } },
      { id: "spend_first", type: "assistant", model: { id: "fixture-model" }, cost: remaining, content: [], time: { created: 25 } },
      { id: "prompt_later", type: "user", text: "Later work", time: { created: 60 } },
      { id: "spend_later", type: "assistant", model: { id: "fixture-model" }, cost: 0.25, content: [], time: { created: 65 } },
    ], cursor: {} }),
    "GET /api/session/:id/inbox": () => ({ data: [] }), "GET /api/session/active": () => ({}),
    "GET /api/permission/request": () => scoped([]), "GET /api/form": () => scoped([]),
    "POST /api/session/ses_child/revert/stage": ({ body }) => { boundary = (body as { messageID: string }).messageID; return { messageID: boundary }; },
  });
  const provider = server.provider(), events = provider.events.bind(provider), list = provider.listMessages.bind(provider);
  provider.events = async function* (signal) { for await (const event of events(signal)) {
    if (holdStartup && event.eventType === "server.connected") { startupEntered(); await freshStartup; }
    yield event; if (event.eventType === "diagnostic.rewrite.applied") applied();
  } };
  provider.listMessages = async (...args) => {
    const page = await list(...args);
    if (held && boundary && args[0] === "ses_child" && ++rewrittenReads === 2) { entered(); await gate; }
    return page;
  };
  const adapter = new ChatAdapter({ provider, workspacePath: WORKSPACE, coalesceWindowMs: 0 });
  const carrier = (items: import("../../types").ConversationItem[]) => items.find(item => item.id === "tool:call_worker");
  let mutation: ReturnType<ChatAdapter["undo"]> | undefined;
  const updateLauncher = async () => {
    if (fieldChange === "input") tool.state.input.prompt = "Different invocation";
    if (fieldChange === "clock") { launch.time.created++; tool.time.created++; tool.time.completed++; }
    if (fieldChange === "output") tool.state.content = [{ type: "text", text: "Newer live output." }];
    const ready = new Promise<void>(resolve => { applied = resolve; });
    for (const event of [
      { id: "evt_rewrite", type: "session.message.content.updated", created: launch.time.created, durable: { aggregateID: "ses_parent", seq: 1, version: 1 }, data: { sessionID: "ses_parent", messageID: launch.id, content: launch.content } },
      { type: "diagnostic.rewrite.applied", data: {} },
    ]) wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ ...event, location: { directory: WORKSPACE } })}\n\n`));
    await ready;
  };
  try {
    if (depth === "root") {
      const initial = await adapter.history("ses_root");
      const row = initial.items.find(item => item.id === "tool:call_root");
      expect(row?.type === "tool" ? row.descendants : undefined).toContainEqual(expect.objectContaining({ id: "tool:call_worker", usage: { costUsd: remaining + 0.25 } }));
    }
    expect(carrier((await adapter.history("ses_parent")).items)).toMatchObject({ usage: { costUsd: remaining + 0.25 } });
    expect(conversationTotals((await adapter.history("ses_child")).items)?.costUsd).toBeCloseTo(remaining + 0.25);
    if (change !== "unchanged" && !held) await updateLauncher();
    mutation = adapter.undo("ses_child", "child-undo-accounting");
    void mutation.catch(() => undefined);
    if (held) {
      await captured;
      if (fieldChange === "cancel" || fieldChange === "generation") {
        await adapter.stopEventPump();
        if (fieldChange === "generation") { holdStartup = true; void adapter.startEventPump(); await startupReady; }
      } else if (fieldChange.startsWith("foreign-")) { lateForeign = true; await provider.getSession("ses_child"); }
      else await updateLauncher();
      release();
    }
    expect(await mutation).toMatchObject({ outcome: "changed" });
    if (lateForeign && fieldChange === "foreign-workspace") await expect(adapter.subscribe("ses_child")).rejects.toThrow("conversation not found");
    else {
      const child = await adapter.subscribe("ses_child"); child.events.cancel();
      if (remaining) expect(conversationTotals(child.snapshot.items)?.costUsd).toBeCloseTo(remaining);
      else expect(conversationTotals(child.snapshot.items)).toBeUndefined();
    }
    const parent = await adapter.subscribe("ses_parent"); parent.events.cancel();
    const blocked = fieldChange === "input" || fieldChange === "clock" || fieldChange === "cancel" || fieldChange === "generation" || lateForeign;
    expect(carrier(parent.snapshot.items)).toMatchObject({ usage: { costUsd: blocked ? remaining + 0.25 : remaining }, output: fieldChange === "output" ? "Newer live output." : "Foreground fixture checked." });
    releaseStartup();
    const refreshed = carrier((await adapter.history("ses_parent")).items);
    if (fieldChange === "input" || fieldChange === "clock" || lateForeign) {
      expect(refreshed).not.toHaveProperty("usage"); expect(refreshed).not.toHaveProperty("model");
    } else expect(refreshed).toMatchObject({ usage: { costUsd: remaining } });
    if (depth === "root" && fieldChange !== "input" && fieldChange !== "clock") {
      const current = await adapter.subscribe("ses_root"); current.events.cancel();
      const row = current.snapshot.items.find(item => item.id === "tool:call_root");
      expect(row?.type === "tool" ? row.descendants : undefined).toContainEqual(expect.objectContaining({ id: "tool:call_worker", usage: { costUsd: remaining } }));
    }
    expect(server.calls.filter(call => call.method !== "GET").map(call => call.path)).toEqual(["/api/session/ses_child/revert/stage"]);
  } finally { release(); releaseStartup(); await mutation?.catch(() => undefined); await adapter.dispose(); expect(closed).toBe(opened); }
});

function ancestorRewriteFixture(levels: number, remaining: number, stagedRoot = false, shared = false, nestedTail = false, tailInPrefix = false) {
  const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
  const launch = (id: string, child: string, created: number) => {
    const message = structuredClone(fixture.launch); message.id = `msg_${id}`; message.time.created = created;
    const tool = message.content[0]; tool.id = id; tool.time = { created, completed: created + 5 };
    tool.state.input.background = false; tool.state.metadata = { sessionID: child, status: "completed" };
    tool.state.content = [{ type: "text", text: `${id} result` }];
    return message;
  };
  const chain = ["ses_root", ...Array.from({ length: levels }, (_, index) => `ses_middle_${index}`), "ses_leaf"];
  const launches = chain.slice(0, -1).map((_, index) => launch(index === 0 ? "root" : `nested_${index}`, chain[index + 1]!, 10 + index * 10));
  for (const message of launches) message.content[0].state.input.prompt = `Task for ${message.content[0].state.metadata.sessionID}`;
  const sibling = launch("second", "ses_leaf", 160); sibling.content[0].state.input.prompt = "Later work";
  const middleSibling = launch("mixed_native_sibling", chain[2]!, 60); middleSibling.content[0].state.input.prompt = "A sibling middle task";
  const peer = launch("peer", "ses_peer", 70); peer.content[0].state.input.prompt = "Task for ses_peer";
  const tail = launch("tail", "ses_tail", tailInPrefix ? 110 : 210);
  const state = { boundary: undefined as string | undefined, peerBoundary: undefined as string | undefined, foreignParent: "", foreignWorkspace: "", unavailable: "", laterCost: 0.25,
    includeMiddleSibling: false, includePeer: false, failRoot: false, hidden: new Map<string, string>() };
  if (stagedRoot) state.hidden.set("ses_root", "root_later");
  let opened = 0, closed = 0, applied!: () => void;
  let wire!: ReadableStreamDefaultController<Uint8Array>;
  const server = fakeOpenCode({
    "GET /api/event": ({ signal }) => new Response(new ReadableStream<Uint8Array>({ start(controller) {
      wire = controller; opened++; controller.enqueue(new TextEncoder().encode('data: {"type":"server.connected","data":{}}\n\n'));
      signal.addEventListener("abort", () => { closed++; controller.close(); }, { once: true });
    } }), { headers: { "content-type": "text/event-stream" } }),
    "GET /api/session": () => ({ data: [], cursor: {} }),
    "GET /api/session/:id/inbox": () => ({ data: [] }), "GET /api/session/active": () => ({}),
    "GET /api/permission/request": () => scoped([]), "GET /api/form": () => scoped([]),
    "GET /api/session/:id": ({ path: route }) => {
      const id = route.split("/").at(-1)!, index = chain.indexOf(id), boundary = id === "ses_leaf" ? state.boundary : state.hidden.get(id);
      if (state.unavailable === id) return new Response(null, { status: 503 });
      if (id === "ses_tail") return session(id, { parentID: "ses_leaf", cost: 0.125 });
      if (id === "ses_peer") return session(id, { parentID: chain.at(-2), cost: state.peerBoundary ? remaining : remaining + state.laterCost, ...(state.peerBoundary ? { revert: { messageID: state.peerBoundary } } : {}) });
      return session(id, { ...(index > 0 ? { parentID: state.foreignParent === id ? "ses_other" : chain[index - 1] } : {}),
        cost: id === "ses_leaf" ? state.boundary ? remaining : remaining + state.laterCost : 0,
        ...(boundary ? { revert: { messageID: boundary } } : {}), ...(state.foreignWorkspace === id ? { location: { directory: "/foreign" } } : {}) });
    },
    "GET /api/session/:id/message": ({ path: route }) => {
      const id = route.split("/").at(-2)!, index = chain.indexOf(id);
      if (id === "ses_root" && state.failRoot) return new Response(null, { status: 503 });
      if (id === "ses_tail") return { data: [{ id: "spend_tail", type: "assistant", model: { id: "tail-model" }, cost: 0.125, content: [], time: { created: 220 } }], cursor: {} };
      if (id === "ses_peer") return { data: [
        { id: "peer_first", type: "user", text: peer.content[0].state.input.prompt, time: { created: 100 } },
        { id: "peer_spend", type: "assistant", model: { id: "peer-model" }, cost: remaining, content: [], time: { created: 105 } },
        { id: "peer_later", type: "user", text: "Later peer work", time: { created: 200 } },
        { id: "peer_later_spend", type: "assistant", model: { id: "peer-model" }, cost: state.laterCost, content: [], time: { created: 205 } },
      ], cursor: {} };
      if (id === "ses_leaf") return { data: [
        { id: "prompt_first", type: "user", text: launches.at(-1)!.content[0].state.input.prompt, time: { created: 100 } },
        { id: "spend_first", type: "assistant", model: { id: "leaf-model" }, cost: shared ? remaining - 0.1 : remaining, content: [], time: { created: 105 } },
        ...(nestedTail && tailInPrefix ? [tail] : []),
        ...(shared ? [{ id: "prompt_continue", type: "user", text: "Continue first task", time: { created: 120 } },
          { id: "spend_continue", type: "assistant", model: { id: "leaf-model" }, cost: 0.1, content: [], time: { created: 125 } }] : []),
        { id: "prompt_later", type: "user", text: "Later work", time: { created: 200 } },
        { id: "spend_later", type: "assistant", model: { id: "leaf-model" }, cost: state.laterCost, content: [], time: { created: 205 } },
        ...(nestedTail && !tailInPrefix ? [tail] : []),
      ], cursor: {} };
      return { data: [...(index > 0 ? [{ id: `prompt_${id}`, type: "user", text: launches[index - 1]!.content[0].state.input.prompt, time: { created: launches[index - 1]!.time.created + 1 } }] : []),
        launches[index], ...(shared && index === chain.length - 2 ? [sibling] : []), ...(state.includeMiddleSibling && index === 1 ? [middleSibling] : []),
        ...(state.includeMiddleSibling && index === 2 ? [{ id: "middle_sibling_prompt", type: "user", text: middleSibling.content[0].state.input.prompt, time: { created: 66 } }] : []),
        ...(state.includePeer && index === chain.length - 2 ? [peer] : []), ...(id === "ses_root" && stagedRoot ? [{ id: "root_later", type: "user", text: "Later root work", time: { created: 500 } }] : [])], cursor: {} };
    },
    "POST /api/session/ses_leaf/revert/stage": ({ body }) => { state.boundary = (body as { messageID: string }).messageID; return { messageID: state.boundary }; },
    "POST /api/session/ses_peer/revert/stage": ({ body }) => { state.peerBoundary = (body as { messageID: string }).messageID; return { messageID: state.peerBoundary }; },
  });
  const provider = server.provider(), events = provider.events.bind(provider);
  provider.events = async function* (signal) { for await (const event of events(signal)) { yield event; if (event.eventType === "diagnostic.ancestor.applied") applied(); } };
  const adapter = new ChatAdapter({ provider, workspacePath: WORKSPACE, coalesceWindowMs: 0 });
  const history = adapter.history.bind(adapter), historyIds = new Set<string>();
  adapter.history = (...args) => { historyIds.add(args[0]); return history(...args); };
  const emit = async (batch: Array<Record<string, unknown>>) => {
    const ready = new Promise<void>(resolve => { applied = resolve; });
    for (const event of [...batch, { type: "diagnostic.ancestor.applied", data: {} }])
      wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ ...event, location: { directory: WORKSPACE } })}\n\n`));
    await ready;
  };
  const receipt = (items: import("../../types").ConversationItem[]) => {
    const row = items.find(item => item.id === "tool:root");
    return row?.type === "tool" ? row.descendants?.find(line => line.id === `tool:${launches.at(-1)!.content[0].id}`) : undefined;
  };
  const dispose = async () => { await adapter.dispose(); expect(closed).toBe(opened); };
  return { adapter, provider, server, state, launches, sibling, middleSibling, peer, chain, emit, receipt, historyIds, dispose };
}

for (const levels of [1, 3]) for (const remaining of [0.5, 0]) for (const inspect of [true, false])
test(`ancestor-only child undo retains its exact nested receipt without projecting the intermediate (${levels}/${remaining}/inspect=${inspect})`, async () => {
  const { adapter, server, receipt, historyIds, dispose } = ancestorRewriteFixture(levels, remaining);
  try {
    expect(receipt((await adapter.history("ses_root")).items)).toMatchObject({ usage: { costUsd: remaining + 0.25 }, model: "leaf-model" });
    if (inspect) expect(conversationTotals((await adapter.history("ses_leaf")).items)?.costUsd).toBeCloseTo(remaining + 0.25);
    expect(await adapter.undo("ses_leaf", "ancestor-only-undo")).toMatchObject({ outcome: "changed" });
    const leaf = await adapter.subscribe("ses_leaf"); leaf.events.cancel();
    if (remaining) expect(conversationTotals(leaf.snapshot.items)?.costUsd).toBeCloseTo(remaining);
    else expect(conversationTotals(leaf.snapshot.items)).toBeUndefined();
    const current = await adapter.subscribe("ses_root"); current.events.cancel();
    expect(receipt(current.snapshot.items)).toMatchObject({ usage: { costUsd: remaining }, model: "leaf-model" });
    expect([...historyIds].every(id => id === "ses_root" || id === "ses_leaf")).toBe(true);
    expect(server.calls.filter(call => call.method !== "GET").map(call => call.path)).toEqual(["/api/session/ses_leaf/revert/stage"]);
  } finally { await dispose(); }
});

for (const levels of [2, 4]) for (const remaining of [0.5, 0]) for (const laterCost of [0.25, 0])
for (const direct of [false, true]) for (const order of ["near-first", "far-first"] as const) for (const delivery of ["single", "coalesced", "replayed"] as const)
test(`mixed projected ancestors accept their own exact rewrite publications (${levels}/${remaining}/${laterCost}/direct=${direct}/${order}/${delivery})`, async () => {
  const { adapter, state, chain, server, historyIds, dispose } = ancestorRewriteFixture(levels, remaining);
  state.laterCost = laterCost;
  const ancestors = ["ses_root", ...chain.slice(1, -2).filter((_, index) => index % 2 === 0)];
  const projected = [...ancestors, ...(direct ? [chain.at(-2)!] : [])];
  const receipt = (items: import("../../types").ConversationItem[]) => items.flatMap(item => item.type === "tool"
    ? [...(item.childConversationId === "ses_leaf" ? [item] : []), ...(item.descendants ?? [])] : []).find(line => "conversationId" in line ? line.conversationId === "ses_leaf" : line.childConversationId === "ses_leaf");
  const pending: Array<{ id: string; updates: Parameters<ProviderUpdateCoalescer["push"]>[1] }> = [];
  const push = ProviderUpdateCoalescer.prototype.push;
  const pushed = spyOn(ProviderUpdateCoalescer.prototype, "push").mockImplementation(function(this: ProviderUpdateCoalescer, id, updates) {
    if (!state.boundary || !ancestors.includes(id) || !updates.some(update => update.kind === "upsert" && receipt([update.item])?.usage?.costUsd === remaining)) return push.call(this, id, updates);
    pending.push({ id, updates });
    if (id !== "ses_root") return;
    const ordered = pending.splice(0).sort((a, b) => (chain.indexOf(a.id) - chain.indexOf(b.id)) * (order === "near-first" ? -1 : 1));
    for (const entry of ordered) {
      push.call(this, entry.id, delivery === "coalesced" ? [...entry.updates, ...entry.updates] : entry.updates);
      if (delivery === "replayed") push.call(this, entry.id, entry.updates);
    }
  });
  const subscriptions: Array<Awaited<ReturnType<ChatAdapter["subscribe"]>>> = [];
  try {
    for (const id of projected) expect(receipt((await adapter.history(id)).items)).toMatchObject({ usage: { costUsd: remaining + laterCost }, model: "leaf-model" });
    await adapter.history("ses_leaf");
    for (const id of projected) subscriptions.push(await adapter.subscribe(id));
    expect(await adapter.undo("ses_leaf", "mixed-projected-undo")).toMatchObject({ outcome: "changed" });
    expect(pending).toEqual([]);
    for (const [index, id] of projected.entries()) {
      const current = await adapter.subscribe(id); current.events.cancel();
      expect(receipt(current.snapshot.items)).toMatchObject({ usage: { costUsd: remaining }, model: "leaf-model" });
      const subscription = subscriptions[index]!; subscription.events.cancel();
      const events: import("../../types").ChatEvent[] = [];
      for await (const event of subscription.events) events.push(event);
      expect(events.filter(event => event.type === "item.upsert")).toHaveLength(laterCost ? 1 : 0);
      expect(events.filter(event => event.type === "item.remove" || event.type === "resync")).toEqual([]);
      if (!laterCost) expect(current.snapshot.cursor).toBe(subscription.snapshot.cursor);
    }
    expect(historyIds.has(chain.at(-2)!)).toBe(direct);
    expect(server.calls.filter(call => call.method !== "GET").map(call => call.path)).toEqual(["/api/session/ses_leaf/revert/stage"]);
  } finally { subscriptions.forEach(subscription => subscription.events.cancel()); pushed.mockRestore(); await dispose(); }
});

for (const levels of [2, 4]) for (const outcome of ["healthy", "equivalent", "equivalent-during-apply", "clone-proof", "native-sibling", "foreign-parent", "foreign-workspace", "expired", "cancel", "generation", "replayed-rejected", "coalesced-rejected"] as const)
test(`mixed projected ancestors advance only their own accepted publication (${levels}/${outcome})`, async () => {
  const { adapter, provider, state, chain, launches, middleSibling, emit, dispose } = ancestorRewriteFixture(levels, 0.5, true);
  state.includeMiddleSibling = outcome === "native-sibling";
  const history = adapter.history.bind(adapter), list = provider.listMessages.bind(provider), events = provider.events.bind(provider);
  const near = chain[1]!;
  const receipt = (items: import("../../types").ConversationItem[]) => items.flatMap(item => item.type === "tool" ? item.descendants ?? [] : []).find(line => line.conversationId === "ses_leaf");
  let entered!: () => void, release!: () => void, published!: () => void, startupEntered!: () => void, releaseStartup!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const nearPublished = new Promise<void>(resolve => { published = resolve; });
  const startupReady = new Promise<void>(resolve => { startupEntered = resolve; }), startup = new Promise<void>(resolve => { releaseStartup = resolve; });
  let block = false, held = false, holdStartup = false, heldHistory: ReturnType<ChatAdapter["history"]> | undefined;
  provider.events = async function* (signal) { for await (const event of events(signal)) {
    if (holdStartup && event.eventType === "server.connected") { startupEntered(); await startup; }
    yield event;
  } };
  provider.listMessages = (...args) => state.failRoot && args[0] === "ses_root" ? Promise.reject(new Error("Held independent parent read unavailable")) : list(...args);
  adapter.history = (...args) => {
    if (!block || held || args[0] !== "ses_root") return history(...args);
    held = true; entered(); heldHistory = gate.then(() => history(...args)); void heldHistory.catch(() => undefined); return heldHistory;
  };
  let mutation: ReturnType<ChatAdapter["undo"]> | undefined, stopping: Promise<void> | undefined;
  let observed: ReturnType<typeof spyOn> | undefined;
  const push = ProviderUpdateCoalescer.prototype.push;
  let candidate: { owner: ProviderUpdateCoalescer; updates: Parameters<ProviderUpdateCoalescer["push"]>[1] } | undefined;
  const pushed = spyOn(ProviderUpdateCoalescer.prototype, "push").mockImplementation(function(this: ProviderUpdateCoalescer, id, updates) {
    if (id === "ses_root" && state.boundary && updates.some(update => update.kind === "upsert" && receipt([update.item])?.usage?.costUsd === 0.5)) candidate = { owner: this, updates };
    push.call(this, id, updates);
  });
  try {
    for (const id of ["ses_root", ...chain.slice(1, -2).filter((_, index) => index % 2 === 0)]) await adapter.history(id);
    await adapter.history("ses_leaf");
    const projection = adapter.projectionForTests(near), apply = projection.apply.bind(projection);
    observed = spyOn(projection, "apply").mockImplementation(update => {
      const event = apply(update);
      if (state.boundary && event?.type === "item.upsert" && event.item.type === "tool" && receipt([event.item])?.usage?.costUsd === 0.5) {
        if (outcome === "equivalent-during-apply") projection.refreshEquivalentTool(event.item, { ...event.item });
        published();
      }
      return event;
    });
    block = true;
    const root = launches[0]!;
    await emit([{ id: "evt_block_mixed_tail", created: root.time.created, type: "session.message.content.updated", durable: { aggregateID: "ses_root", seq: 1, version: 1 }, data: { sessionID: "ses_root", messageID: root.id, content: root.content } }]);
    await ready;
    mutation = adapter.undo("ses_leaf", "mixed-held-publication"); void mutation.catch(() => undefined);
    await nearPublished;
    const currentNear = await adapter.subscribe(near); currentNear.events.cancel();
    expect(receipt(currentNear.snapshot.items)).toMatchObject({ usage: { costUsd: 0.5 }, model: "leaf-model" });
    if (outcome === "equivalent" || outcome === "clone-proof" || outcome === "replayed-rejected" || outcome === "coalesced-rejected") {
      const row = currentNear.snapshot.items.find(item => item.type === "tool" && item.childConversationId === chain[2]) as import("../../types").ToolItem;
      projection.refreshEquivalentTool(row, { ...row, ...(outcome === "clone-proof" ? { descendants: row.descendants!.map(line => ({ ...line })) } : {}) });
    }
    if (outcome === "native-sibling") {
      const message = middleSibling;
      message.content[0].state.content = [{ type: "text", text: "New sibling presentation." }];
      await emit([{ id: "evt_mixed_sibling", created: message.time.created, type: "session.message.content.updated", durable: { aggregateID: near, seq: 1, version: 1 }, data: { sessionID: near, messageID: message.id, content: message.content } }]);
    }
    if (outcome === "foreign-parent") { state.foreignParent = near; await provider.getSession(near); }
    if (outcome === "foreign-workspace") { state.foreignWorkspace = "ses_leaf"; await provider.getSession("ses_leaf"); }
    if (outcome === "cancel" || outcome === "generation") stopping = adapter.stopEventPump();
    if (outcome === "expired" || outcome === "cancel" || outcome === "generation") expect(await mutation).toMatchObject({ outcome: "changed" });
    state.failRoot = true; release();
    await heldHistory?.catch(() => undefined);
    expect(await mutation).toMatchObject({ outcome: "changed" });
    await stopping; state.failRoot = false;
    if (outcome === "replayed-rejected" || outcome === "coalesced-rejected") {
      expect(candidate).toBeDefined();
      push.call(candidate!.owner, "ses_root", outcome === "coalesced-rejected" ? [...candidate!.updates, ...candidate!.updates] : candidate!.updates);
      candidate!.owner.flushAll(); await candidate!.owner.settled();
    }
    if (outcome === "generation") { holdStartup = true; void adapter.startEventPump(); await startupReady; }
    const current = await adapter.subscribe("ses_root"); current.events.cancel();
    expect(receipt(current.snapshot.items)).toMatchObject({ usage: { costUsd: outcome === "healthy" ? 0.5 : 0.75 }, model: "leaf-model" });
    if (outcome === "native-sibling") {
      const updated = await adapter.subscribe(near); updated.events.cancel();
      expect(updated.snapshot.items).toContainEqual(expect.objectContaining({ id: "tool:mixed_native_sibling", output: "New sibling presentation." }));
    }
    if (outcome === "generation") {
      releaseStartup();
      expect(receipt((await adapter.history("ses_root")).items)).toMatchObject({ usage: { costUsd: 0.5 }, model: "leaf-model" });
    }
  } finally { release(); releaseStartup(); await heldHistory?.catch(() => undefined); await mutation?.catch(() => undefined); await stopping; observed?.mockRestore(); pushed.mockRestore(); await dispose(); }
});

for (const levels of [2, 4]) for (const first of ["ses_leaf", "ses_peer"] as const)
test(`mixed projected ancestors do not borrow another rewrite context (${levels}/${first})`, async () => {
  const { adapter, provider, state, launches, emit, dispose } = ancestorRewriteFixture(levels, 0.5, true);
  state.includePeer = true;
  const pair = (items: import("../../types").ConversationItem[]) => {
    const lines = items.flatMap(item => item.type === "tool" ? item.descendants ?? [] : []);
    return ["ses_leaf", "ses_peer"].map(id => lines.find(line => line.conversationId === id)?.usage?.costUsd);
  };
  const history = adapter.history.bind(adapter), list = provider.listMessages.bind(provider), push = ProviderUpdateCoalescer.prototype.push;
  let entered!: () => void, release!: () => void, firstQueued!: () => void, bothQueued!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const firstReady = new Promise<void>(resolve => { firstQueued = resolve; }), bothReady = new Promise<void>(resolve => { bothQueued = resolve; });
  let block = false, held = false, roots = 0, heldHistory: ReturnType<ChatAdapter["history"]> | undefined;
  adapter.history = (...args) => {
    if (!block || held || args[0] !== "ses_root") return history(...args);
    held = true; entered(); heldHistory = gate.then(() => history(...args)); void heldHistory.catch(() => undefined); return heldHistory;
  };
  provider.listMessages = (...args) => state.failRoot && args[0] === "ses_root" ? Promise.reject(new Error("Held independent context read unavailable")) : list(...args);
  const candidates: Array<{ owner: ProviderUpdateCoalescer; id: string; updates: Parameters<ProviderUpdateCoalescer["push"]>[1]; child: string }> = [];
  const pushed = spyOn(ProviderUpdateCoalescer.prototype, "push").mockImplementation(function(this: ProviderUpdateCoalescer, id, updates) {
    const item = updates.find(update => update.kind === "upsert" && update.item.type === "tool");
    const costs = item?.kind === "upsert" ? pair([item.item]) : [];
    if ((id !== "ses_root" && id !== "ses_middle_0") || !costs.includes(0.5) || (!state.boundary && !state.peerBoundary)) return push.call(this, id, updates);
    candidates.push({ owner: this, id, updates, child: costs[0] === 0.5 ? "ses_leaf" : "ses_peer" });
    if (id === "ses_root") { if (++roots === 1) firstQueued(); if (roots === 2) bothQueued(); }
  });
  const subscriptions: Array<Awaited<ReturnType<ChatAdapter["subscribe"]>>> = [];
  const mutations: Array<ReturnType<ChatAdapter["undo"]>> = [];
  try {
    for (const id of ["ses_root", "ses_middle_0"]) {
      expect(pair((await adapter.history(id)).items)).toEqual([0.75, 0.75]);
      subscriptions.push(await adapter.subscribe(id));
    }
    await adapter.history("ses_leaf"); await adapter.history("ses_peer");
    block = true;
    const root = launches[0]!;
    await emit([{ id: "evt_block_duplicate_context", created: root.time.created, type: "session.message.content.updated", durable: { aggregateID: "ses_root", seq: 1, version: 1 }, data: { sessionID: "ses_root", messageID: root.id, content: root.content } }]);
    await ready;
    mutations.push(adapter.undo(first, `mixed-context-${first}`)); void mutations[0]!.catch(() => undefined);
    await firstReady;
    const other = first === "ses_leaf" ? "ses_peer" : "ses_leaf";
    mutations.push(adapter.undo(other, `mixed-context-${other}`)); void mutations[1]!.catch(() => undefined);
    await bothReady;
    const ordered = candidates.splice(0).sort((a, b) => Number(a.child !== first) - Number(b.child !== first) || Number(a.id === "ses_root") - Number(b.id === "ses_root"));
    for (const candidate of ordered) push.call(candidate.owner, candidate.id, candidate.updates);
    state.failRoot = true; release(); await heldHistory?.catch(() => undefined);
    expect(await Promise.all(mutations)).toEqual([expect.objectContaining({ outcome: "changed" }), expect.objectContaining({ outcome: "changed" })]);
    state.failRoot = false;
    const prices: Array<Array<number | undefined>> = [];
    for (const [index, id] of ["ses_root", "ses_middle_0"].entries()) {
      const current = await adapter.subscribe(id); current.events.cancel(); prices.push(pair(current.snapshot.items));
      const subscription = subscriptions[index]!; subscription.events.cancel();
      const events: import("../../types").ChatEvent[] = []; for await (const event of subscription.events) events.push(event);
      expect(events.filter(event => event.type === "item.upsert")).toHaveLength(1);
    }
    expect(prices[0]).toEqual(prices[1]);
    expect<ReadonlyArray<ReadonlyArray<number | undefined>>>([[0.5, 0.75], [0.75, 0.5]]).toContainEqual(prices[0]);
    // Both native mutations succeeded. A new coherent reader can recover the
    // other receipt, without promoting either old context by row ID/equality.
    expect(pair((await adapter.history("ses_root")).items)).toEqual([0.5, 0.5]);
  } finally { state.failRoot = true; release(); await heldHistory?.catch(() => undefined); await Promise.allSettled(mutations); subscriptions.forEach(subscription => subscription.events.cancel()); pushed.mockRestore(); await dispose(); }
});

for (const levels of [1, 3]) for (const change of ["input-root", "clock-root", "input-middle", "clock-middle", "input-leaf-launch", "clock-leaf-launch", "missing-proof", "hidden-root", "hidden-middle"] as const)
test(`ancestor-only rewrite withholds an unproven retained path (${levels}/${change})`, async () => {
  const { adapter, state, launches, chain, receipt, emit, dispose } = ancestorRewriteFixture(levels, 0.5);
  try {
    const initial = await adapter.history("ses_root");
    expect(receipt(initial.items)).toMatchObject({ usage: { costUsd: 0.75 }, model: "leaf-model" });
    await adapter.history("ses_leaf");
    const index = change.endsWith("root") ? 0 : change.endsWith("middle") ? Math.min(1, launches.length - 1) : launches.length - 1;
    const changed = launches[index]!, tool = changed.content[0];
    if (change.startsWith("input")) tool.state.input.prompt = "A different retained invocation";
    if (change.startsWith("clock")) { changed.time.created++; tool.time.created++; tool.time.completed++; }
    if (change.startsWith("input") || change.startsWith("clock")) await emit([{ type: "session.updated", data: { info: session(chain[index]!, index > 0 ? { parentID: chain[index - 1] } : {}) } }]);
    if (change === "hidden-root") state.hidden.set("ses_root", launches[0]!.id);
    if (change === "hidden-middle") state.hidden.set(chain.at(-2)!, launches.at(-1)!.id);
    if (change === "missing-proof") {
      const projection = adapter.projectionForTests("ses_root"), row = initial.items.find(item => item.type === "tool" && item.id === "tool:root") as import("../../types").ToolItem;
      projection.refreshEquivalentTool(row, { ...row, descendants: row.descendants!.map(line => ({ ...line })) });
    }
    expect(await adapter.undo("ses_leaf", "unproven-ancestor-undo")).toMatchObject({ outcome: "changed" });
    const current = await adapter.subscribe("ses_root"); current.events.cancel();
    expect(receipt(current.snapshot.items)).toMatchObject({ usage: { costUsd: 0.75 }, model: "leaf-model" });
  } finally { await dispose(); }
});

for (const levels of [1, 3]) for (const outcome of ["healthy", "expired", "cancel", "generation", "foreign-middle-parent", "foreign-middle-workspace", "foreign-leaf-parent", "foreign-leaf-workspace", "hidden-middle", "new-live-root", "new-live-middle"] as const)
test(`ancestor-only rewrite fences an asynchronous ancestor query (${levels}/${outcome})`, async () => {
  const { adapter, provider, state, chain, launches, receipt, emit, dispose } = ancestorRewriteFixture(levels, 0.5);
  const get = provider.getSession.bind(provider), watch = provider.watchWorkerAssociations.bind(provider), events = provider.events.bind(provider);
  const middle = chain.at(-2)!;
  let entered!: () => void, release!: () => void, startupEntered!: () => void, releaseStartup!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const startupReady = new Promise<void>(resolve => { startupEntered = resolve; }), startup = new Promise<void>(resolve => { releaseStartup = resolve; });
  let held = false, holdStartup = false, scopeSignal: AbortSignal | undefined;
  const queries: Promise<unknown>[] = [];
  provider.watchWorkerAssociations = (...args) => {
    if (state.boundary && args[0] === chain.at(-3) && args[1].includes(middle)) scopeSignal = args[2].signal;
    return watch(...args);
  };
  provider.events = async function* (signal) { for await (const event of events(signal)) {
    if (holdStartup && event.eventType === "server.connected") { startupEntered(); await startup; }
    yield event;
  } };
  provider.getSession = (...args) => {
    const reading = (async () => {
      const value = await get(...args);
      if (state.boundary && args[0] === middle && !held) { held = true; entered(); await gate; }
      return value;
    })();
    queries.push(reading); return reading;
  };
  let mutation: ReturnType<ChatAdapter["undo"]> | undefined;
  try {
    expect(receipt((await adapter.history("ses_root")).items)).toMatchObject({ usage: { costUsd: 0.75 } });
    await adapter.history("ses_leaf");
    mutation = adapter.undo("ses_leaf", "held-ancestor-undo"); void mutation.catch(() => undefined);
    await ready;
    expect(scopeSignal).toBeDefined();
    if (outcome === "expired") await new Promise<void>(resolve => { if (scopeSignal!.aborted) resolve(); else scopeSignal!.addEventListener("abort", () => resolve(), { once: true }); });
    if (outcome === "cancel" || outcome === "generation") {
      await adapter.stopEventPump();
      if (outcome === "generation") { holdStartup = true; void adapter.startEventPump(); await startupReady; }
    }
    if (outcome.startsWith("foreign")) {
      const target = outcome.startsWith("foreign-middle") ? middle : "ses_leaf";
      if (outcome.endsWith("workspace")) state.foreignWorkspace = target; else state.foreignParent = target;
      await provider.getSession(target);
    }
    if (outcome === "hidden-middle") state.hidden.set(middle, launches.at(-1)!.id);
    if (outcome === "new-live-root" || outcome === "new-live-middle") {
      const index = outcome === "new-live-root" ? 0 : launches.length - 1, message = launches[index]!;
      message.content[0].state.content = [{ type: "text", text: "Newer native presentation." }];
      if (outcome === "new-live-middle") message.content[0].state.input.prompt = "A newer middle invocation";
      await emit([{ id: "evt_held_ancestor", created: message.time.created, type: "session.message.content.updated", durable: { aggregateID: chain[index], seq: 1, version: 1 }, data: { sessionID: chain[index], messageID: message.id, content: message.content } }]);
    }
    if (outcome === "expired" || outcome === "cancel" || outcome === "generation") {
      expect(await mutation).toMatchObject({ outcome: "changed" });
      const beforeLate = await adapter.subscribe("ses_root"); beforeLate.events.cancel();
      expect(receipt(beforeLate.snapshot.items)).toMatchObject({ usage: { costUsd: 0.75 } });
    }
    release();
    expect(await mutation).toMatchObject({ outcome: "changed" });
    await Promise.allSettled(queries);
    const current = await adapter.subscribe("ses_root"); current.events.cancel();
    if (outcome === "healthy") expect(receipt(current.snapshot.items)).toMatchObject({ usage: { costUsd: 0.5 }, model: "leaf-model" });
    else expect(receipt(current.snapshot.items)?.usage?.costUsd).not.toBe(0.5);
    if (outcome === "new-live-root") expect(current.snapshot.items.find(item => item.id === "tool:root")).toMatchObject({ output: "Newer native presentation." });
    if (outcome === "generation") {
      releaseStartup();
      expect(receipt((await adapter.history("ses_root")).items)).toMatchObject({ usage: { costUsd: 0.5 }, model: "leaf-model" });
    }
  } finally { release(); releaseStartup(); await mutation?.catch(() => undefined); await Promise.allSettled(queries); await dispose(); }
});

for (const levels of [1, 3]) for (const outcome of ["healthy", "foreign-parent", "foreign-workspace", "clone-proof", "cancel", "expired"] as const)
test(`ancestor-only rewrite validates its lease at queued publication (${levels}/${outcome})`, async () => {
  const { adapter, provider, state, chain, launches, receipt, emit, dispose } = ancestorRewriteFixture(levels, 0.5, true);
  const history = adapter.history.bind(adapter), push = ProviderUpdateCoalescer.prototype.push, list = provider.listMessages.bind(provider);
  provider.listMessages = (...args) => state.failRoot && args[0] === "ses_root" ? Promise.reject(new Error("Held parent transcript unavailable")) : list(...args);
  let entered!: () => void, release!: () => void, queued!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const publicationReady = new Promise<void>(resolve => { queued = resolve; });
  let block = false, held = false, heldHistory: ReturnType<ChatAdapter["history"]> | undefined;
  adapter.history = (...args) => {
    if (!block || held || args[0] !== "ses_root") return history(...args);
    held = true; entered();
    heldHistory = gate.then(() => history(...args)); void heldHistory.catch(() => undefined);
    return heldHistory;
  };
  const pushed = spyOn(ProviderUpdateCoalescer.prototype, "push").mockImplementation(function(this: ProviderUpdateCoalescer, id, updates) {
    push.call(this, id, updates);
    if (id === "ses_root" && state.boundary && updates.some(update => update.kind === "upsert" && update.item.type === "tool"
      && receipt([update.item])?.usage?.costUsd === 0.5)) queued();
  });
  let mutation: ReturnType<ChatAdapter["undo"]> | undefined, stopping: Promise<void> | undefined;
  try {
    expect(receipt((await adapter.history("ses_root")).items)).toMatchObject({ usage: { costUsd: 0.75 } });
    await adapter.history("ses_leaf");
    block = true;
    const root = launches[0]!;
    await emit([{ id: "evt_block_root_tail", created: root.time.created, type: "session.message.content.updated", durable: { aggregateID: "ses_root", seq: 1, version: 1 }, data: { sessionID: "ses_root", messageID: root.id, content: root.content } }]);
    await ready;
    mutation = adapter.undo("ses_leaf", "queued-ancestor-undo"); void mutation.catch(() => undefined);
    await publicationReady;
    const before = await adapter.subscribe("ses_root"); before.events.cancel();
    expect(receipt(before.snapshot.items)).toMatchObject({ usage: { costUsd: 0.75 } });
    if (outcome === "foreign-parent" || outcome === "foreign-workspace") {
      if (outcome === "foreign-parent") state.foreignParent = chain.at(-2)!; else state.foreignWorkspace = "ses_leaf";
      await provider.getSession(outcome === "foreign-parent" ? chain.at(-2)! : "ses_leaf");
    }
    if (outcome === "clone-proof") {
      const projection = adapter.projectionForTests("ses_root"), row = before.snapshot.items.find(item => item.type === "tool" && item.id === "tool:root") as import("../../types").ToolItem;
      projection.refreshEquivalentTool(row, { ...row, descendants: row.descendants!.map(line => ({ ...line })) });
    }
    if (outcome === "cancel") stopping = adapter.stopEventPump();
    if (outcome === "expired" || outcome === "cancel") expect(await mutation).toMatchObject({ outcome: "changed" });
    // The preceding flush fails its required transcript read. It cannot be
    // the source of a successful reprice or alter the guarded row reference.
    state.failRoot = true; release();
    await heldHistory?.catch(() => undefined);
    expect(await mutation).toMatchObject({ outcome: "changed" });
    await stopping;
    state.failRoot = false;
    const current = await adapter.subscribe("ses_root"); current.events.cancel();
    expect(receipt(current.snapshot.items)).toMatchObject({ usage: { costUsd: outcome === "healthy" ? 0.5 : 0.75 }, model: "leaf-model" });
  } finally { state.failRoot = true; release(); await heldHistory?.catch(() => undefined); await mutation?.catch(() => undefined); await stopping; pushed.mockRestore(); await dispose(); }
});

for (const levels of [1, 3]) for (const outgoing of ["complete", "incomplete"] as const)
test(`ancestor-only rewrite cannot clear a positive cohort deficit (${levels}/${outgoing})`, async () => {
  const { adapter, state, chain, sibling, receipt, emit, dispose } = ancestorRewriteFixture(levels, 0.5, false, true, outgoing === "incomplete", true);
  const middle = chain.at(-2)!;
  const invalidate = () => emit([middle, "ses_leaf"].map(id => ({ type: "session.updated", data: { info: session(id, { parentID: chain[chain.indexOf(id) - 1] }) } })));
  try {
    expect(receipt((await adapter.history("ses_root")).items)).toMatchObject({ usage: { costUsd: 0.5 } });
    await adapter.history(middle);
    sibling.content[0].state.input.prompt = "A distinct second invocation"; state.unavailable = "ses_leaf";
    await invalidate();
    const degraded = await adapter.history(middle);
    expect(degraded.items.find(item => item.id === "tool:second")).not.toHaveProperty("usage");
    const degradedRoot = await adapter.history("ses_root");
    expect(degradedRoot.items.flatMap(item => item.type === "tool" ? item.descendants ?? [] : []).find(line => line.id === "tool:second")).not.toHaveProperty("usage");
    sibling.content[0].state.input.prompt = "Later work"; state.unavailable = outgoing === "incomplete" ? "ses_tail" : "";
    await invalidate();
    if (outgoing === "incomplete") {
      // Fresh own accounting is usable, but partial outgoing inventory cannot
      // rehabilitate the previously rejected second member of this cohort.
      const partial = await adapter.history(middle), following = await adapter.subscribe(middle); following.events.cancel();
      for (const items of [partial.items, following.snapshot.items]) {
        expect(items.find(item => item.id === `tool:nested_${levels}`)).not.toHaveProperty("usage");
        expect(items.find(item => item.id === "tool:second")).not.toHaveProperty("usage");
      }
    }
    expect(await adapter.undo("ses_leaf", "blocked-rewrite-second")).toMatchObject({ outcome: "changed" });
    expect(await adapter.undo("ses_leaf", "blocked-rewrite-continuation")).toMatchObject({ outcome: "changed" });
    const leaf = await adapter.subscribe("ses_leaf"); leaf.events.cancel();
    expect(conversationTotals(leaf.snapshot.items)?.costUsd).toBeCloseTo(0.4);
    const root = await adapter.subscribe("ses_root"); root.events.cancel();
    expect(receipt(root.snapshot.items)).toMatchObject({ usage: { costUsd: 0.5 } });
    const second = root.snapshot.items.flatMap(item => item.type === "tool" ? item.descendants ?? [] : []).find(line => line.id === "tool:second");
    expect(second).not.toHaveProperty("usage");
  } finally { await dispose(); }
});

for (const levels of [1, 3]) for (const laterCost of [0, 0.25])
test(`ancestor-only rewrite publishes a changed receipt once and an unchanged receipt never (${levels}/${laterCost})`, async () => {
  const { adapter, state, receipt, dispose } = ancestorRewriteFixture(levels, 0.5);
  state.laterCost = laterCost;
  let subscription: Awaited<ReturnType<ChatAdapter["subscribe"]>> | undefined;
  try {
    expect(receipt((await adapter.history("ses_root")).items)).toMatchObject({ usage: { costUsd: 0.5 + laterCost } });
    await adapter.history("ses_leaf");
    subscription = await adapter.subscribe("ses_root");
    expect(await adapter.undo("ses_leaf", "ancestor-replay-noop")).toMatchObject({ outcome: "changed" });
    subscription.events.cancel();
    const changes: import("../../types").ChatEvent[] = [];
    for await (const event of subscription.events) changes.push(event);
    expect(changes.filter(event => event.type === "item.upsert" && event.item.id === "tool:root")).toHaveLength(laterCost ? 1 : 0);
    expect(changes.filter(event => event.type === "item.remove" || event.type === "resync")).toEqual([]);
    const current = await adapter.subscribe("ses_root"); current.events.cancel();
    expect(receipt(current.snapshot.items)).toMatchObject({ usage: { costUsd: 0.5 }, model: "leaf-model" });
    if (!laterCost) expect(current.snapshot.cursor).toBe(subscription.snapshot.cursor);
  } finally { subscription?.events.cancel(); await dispose(); }
});

for (const levels of [1, 3]) for (const topology of ["hidden", "visible", "incomplete"] as const)
test(`ancestor-only rewrite withdraws only proven hidden descendants (${levels}/${topology})`, async () => {
  const { adapter, state, receipt, emit, dispose } = ancestorRewriteFixture(levels, 0.5, false, false, true, topology !== "hidden");
  const lines = (items: import("../../types").ConversationItem[]) => items.flatMap(item => item.type === "tool" ? item.descendants ?? [] : []);
  try {
    const initial = await adapter.history("ses_root");
    expect(lines(initial.items)).toContainEqual(expect.objectContaining({ id: "tool:tail", usage: { costUsd: 0.125 } }));
    await adapter.history("ses_leaf");
    if (topology === "incomplete") {
      state.unavailable = "ses_tail";
      await emit(["ses_leaf", "ses_tail"].map(id => ({ type: "session.updated", data: { info: session(id, { parentID: id === "ses_tail" ? "ses_leaf" : `ses_middle_${levels - 1}` }) } })));
    }
    expect(await adapter.undo("ses_leaf", "ancestor-hidden-tail")).toMatchObject({ outcome: "changed" });
    const current = await adapter.subscribe("ses_root"); current.events.cancel();
    expect(receipt(current.snapshot.items)).toMatchObject({ usage: { costUsd: topology === "incomplete" ? 0.75 : 0.5 } });
    if (topology === "hidden") expect(lines(current.snapshot.items).some(line => line.id === "tool:tail")).toBe(false);
    else expect(lines(current.snapshot.items)).toContainEqual(expect.objectContaining({ id: "tool:tail", usage: { costUsd: 0.125 } }));
  } finally { await dispose(); }
});

for (const depth of ["direct", "root"] as const) for (const initial of ["warm", "cold"] as const) for (const own of [0.5, 0])
for (const delayed of depth === "direct" ? ["grandchild", "own"] as const : ["grandchild"] as const)
test(`prompt own child accounting survives a slow grandchild accounting page (${depth}/${initial}/${own}/delay=${delayed})`, async () => {
  const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
  const launch = structuredClone(fixture.launch), tool = launch.content[0];
  tool.state.input.background = false; tool.state.metadata = { sessionID: "ses_child", status: "completed" };
  tool.state.content = [{ type: "text", text: "Foreground fixture checked." }];
  const nested = structuredClone(launch); nested.id = "msg_nested"; nested.time.created = 30;
  nested.content[0].id = "call_nested"; nested.content[0].time = { created: 30, completed: 35 };
  nested.content[0].state.metadata.sessionID = "ses_grandchild";
  const root = structuredClone(launch); root.id = "msg_root"; root.time.created = 10;
  root.content[0].id = "call_root"; root.content[0].time = { created: 10, completed: 15 };
  root.content[0].state.metadata.sessionID = "ses_parent";
  let slow = initial === "cold", opened = 0, closed = 0, slowReads = 0, abortedReads = 0;
  let ownCost = initial === "cold" ? own : 0.5;
  const nativeReads: Promise<unknown>[] = [];
  const slowPage = (signal: AbortSignal, page: () => unknown) => {
    slowReads++;
    const reading = Bun.sleep(1_500).then(page); nativeReads.push(reading);
    return Promise.race([reading, new Promise<never>((_resolve, reject) => {
      const abort = () => { abortedReads++; reject(new DOMException("Aborted", "AbortError")); };
      if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
    })]);
  };
  const server = fakeOpenCode({
    "GET /api/event": ({ signal }) => new Response(new ReadableStream<Uint8Array>({ start(controller) {
      opened++; controller.enqueue(new TextEncoder().encode('data: {"type":"server.connected","data":{}}\n\n'));
      signal.addEventListener("abort", () => { closed++; controller.close(); }, { once: true });
    } }), { headers: { "content-type": "text/event-stream" } }),
    "GET /api/session": () => ({ data: [], cursor: {} }),
    "GET /api/session/ses_root": () => session("ses_root"),
    "GET /api/session/ses_root/message": () => ({ data: [root], cursor: {} }),
    "GET /api/session/ses_parent": () => session("ses_parent", depth === "root" ? { parentID: "ses_root" } : {}),
    "GET /api/session/ses_child": () => session("ses_child", { parentID: "ses_parent", cost: 0.5 }),
    "GET /api/session/ses_grandchild": () => session("ses_grandchild", { parentID: "ses_child", cost: 0.25 }),
    "GET /api/session/ses_parent/message": () => ({ data: [launch], cursor: {} }),
    "GET /api/session/ses_child/message": ({ signal }) => {
      const page = () => ({ data: [
        { id: "prompt_first", type: "user", text: tool.state.input.prompt, time: { created: 22 } },
        { id: "spend_first", type: "assistant", model: { id: "child-model" }, cost: ownCost, content: [], time: { created: 25 } }, nested,
      ], cursor: {} });
      return slow && delayed === "own" ? slowPage(signal, page) : page();
    },
    "GET /api/session/ses_grandchild/message": ({ signal }) => {
      const page = () => ({ data: [{ id: "spend_nested", type: "assistant", model: { id: "grandchild-model" }, cost: 0.25, content: [], time: { created: 40 } }], cursor: {} });
      return slow && delayed === "grandchild" ? slowPage(signal, page) : page();
    },
    "GET /api/session/:id/inbox": () => ({ data: [] }), "GET /api/session/active": () => ({}),
    "GET /api/permission/request": () => scoped([]), "GET /api/form": () => scoped([]),
  });
  const adapter = new ChatAdapter({ provider: server.provider(), workspacePath: WORKSPACE, coalesceWindowMs: 0 });
  const now = Date.now(); let elapsed = 0;
  const clock = spyOn(Date, "now").mockImplementation(() => now + elapsed);
  const carrier = (items: import("../../types").ConversationItem[]) => items.find(item => item.id === "tool:call_worker");
  try {
    if (initial === "warm") {
      if (depth === "root") {
        const page = await adapter.history("ses_root"), row = page.items.find(item => item.id === "tool:call_root");
        expect(row?.type === "tool" ? row.descendants : undefined).toContainEqual(expect.objectContaining({ id: "tool:call_worker", usage: { costUsd: 0.5 }, model: "child-model" }));
      } else expect(carrier((await adapter.history("ses_parent")).items)).toMatchObject({ usage: { costUsd: 0.5 }, model: "child-model" });
      await adapter.stopEventPump(); slow = true; ownCost = own; elapsed = 31_000;
    }
    if (depth === "root") {
      const rootPage = await adapter.history("ses_root");
      const row = rootPage.items.find(item => item.id === "tool:call_root");
      expect(row?.type === "tool" ? row.descendants : undefined).toContainEqual(expect.objectContaining({ id: "tool:call_worker", model: "child-model", usage: { costUsd: own } }));
    }
    const current = await adapter.history("ses_parent");
    const next = await adapter.subscribe("ses_parent"); next.events.cancel();
    expect(slowReads).toBeGreaterThan(0); expect(abortedReads).toBeGreaterThan(0);
    const expectOwn = (items: import("../../types").ConversationItem[]) => {
      const row = carrier(items);
      if (delayed === "own" && initial === "cold") { expect(row).not.toHaveProperty("usage"); expect(row).not.toHaveProperty("model"); }
      else expect(row).toMatchObject({ usage: { costUsd: delayed === "own" ? 0.5 : own }, model: "child-model", workerSession: { costUsd: 0.5 } });
    };
    for (const items of [current.items, next.snapshot.items]) expectOwn(items);
    await Promise.allSettled(nativeReads);
    const late = await adapter.subscribe("ses_parent"); late.events.cancel();
    expectOwn(late.snapshot.items);
    // An incomplete descendant must retry immediately, not acquire the own
    // tally's completeness stamp or wait for the 30-second refresh age.
    slow = false;
    const reads = server.requests("GET", "/api/session/ses_grandchild/message").length;
    const recovered = await adapter.history("ses_parent");
    expect(server.requests("GET", "/api/session/ses_grandchild/message").length).toBeGreaterThan(reads);
    const row = carrier(recovered.items);
    expect(row).toMatchObject({ usage: { costUsd: own }, model: "child-model" });
    expect(row?.type === "tool" ? row.descendants : undefined).toContainEqual(expect.objectContaining({ id: "tool:call_nested", usage: { costUsd: 0.25 } }));
    expect(server.calls.every(call => call.method === "GET")).toBe(true);
  } finally { clock.mockRestore(); await adapter.dispose(); await Promise.allSettled(nativeReads); expect(closed).toBe(opened); }
});

for (const depth of ["direct", "root"] as const) for (const initial of ["warm", "cold"] as const) for (const own of [0.5, 0])
for (const ownership of ["unavailable", "foreign-parent", "foreign-workspace"] as const)
for (const binding of ownership === "unavailable" ? ["unchanged", "input", "occurrence"] as const : ["unchanged"] as const)
for (const fence of initial === "warm" && own === 0.5 && ownership === "unavailable" && binding === "unchanged"
  ? ["none", "expiry", "incoming-parent", "incoming-workspace", "cancel", "generation", "new-live"] as const : ["none"] as const)
test(`prompt own child accounting survives unavailable grandchild ownership (${depth}/${initial}/${own}/${ownership}/${binding}/${fence})`, async () => {
  const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
  const launch = structuredClone(fixture.launch), tool = launch.content[0];
  tool.state.input.background = false; tool.state.metadata = { sessionID: "ses_child", status: "completed" };
  tool.state.content = [{ type: "text", text: "Foreground fixture checked." }];
  const nested = structuredClone(launch); nested.id = "msg_nested"; nested.time.created = 30;
  nested.content[0].id = "call_nested"; nested.content[0].time = { created: 30, completed: 35 };
  nested.content[0].state.metadata.sessionID = "ses_grandchild";
  const root = structuredClone(launch); root.id = "msg_root"; root.time.created = 10;
  root.content[0].id = "call_root"; root.content[0].time = { created: 10, completed: 15 };
  root.content[0].state.metadata.sessionID = "ses_parent";
  let unavailable = initial === "cold", ownCost = initial === "cold" ? own : 0.5;
  let ownModel = "child-model", incomingForeign = false, holding = false;
  let entered!: () => void, release!: () => void, applied!: () => void;
  let holdStartup = false, startupEntered!: () => void, releaseStartup!: () => void;
  let wire!: ReadableStreamDefaultController<Uint8Array>;
  const captured = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const startupReady = new Promise<void>(resolve => { startupEntered = resolve; }), startup = new Promise<void>(resolve => { releaseStartup = resolve; });
  const readOwner = new AsyncLocalStorage<boolean>();
  let opened = 0, closed = 0;
  const server = fakeOpenCode({
    "GET /api/event": ({ signal }) => new Response(new ReadableStream<Uint8Array>({ start(controller) {
      wire = controller; opened++; controller.enqueue(new TextEncoder().encode('data: {"type":"server.connected","data":{}}\n\n'));
      signal.addEventListener("abort", () => { closed++; controller.close(); }, { once: true });
    } }), { headers: { "content-type": "text/event-stream" } }),
    "GET /api/session": () => ({ data: [], cursor: {} }),
    "GET /api/session/ses_root": () => session("ses_root"),
    "GET /api/session/ses_root/message": () => ({ data: [root], cursor: {} }),
    "GET /api/session/ses_parent": () => session("ses_parent", depth === "root" ? { parentID: "ses_root" } : {}),
    "GET /api/session/ses_parent/message": () => ({ data: [launch], cursor: {} }),
    "GET /api/session/ses_child": () => session("ses_child", {
      parentID: incomingForeign && fence === "incoming-parent" ? "ses_other" : "ses_parent", cost: 0.5,
      ...(incomingForeign && fence === "incoming-workspace" ? { location: { directory: "/foreign" } } : {}),
    }),
    "GET /api/session/ses_child/message": () => ({ data: [
      { id: "prompt_first", type: "user", text: tool.state.input.prompt, time: { created: 22 } },
      { id: "spend_first", type: "assistant", model: { id: ownModel }, cost: ownCost, content: [], time: { created: 25 } }, nested,
    ], cursor: {} }),
    "GET /api/session/ses_grandchild": () => unavailable && ownership === "unavailable" ? new Response(null, { status: 503 }) : session("ses_grandchild", {
      parentID: unavailable && ownership === "foreign-parent" ? "ses_other" : "ses_child",
      ...(unavailable && ownership === "foreign-workspace" ? { location: { directory: "/foreign" } } : {}),
    }),
    "GET /api/session/ses_grandchild/message": () => ({ data: [{ id: "spend_nested", type: "assistant", model: { id: "grandchild-model" }, cost: 0.25, content: [], time: { created: 40 } }], cursor: {} }),
    "GET /api/session/:id/inbox": () => ({ data: [] }), "GET /api/session/active": () => ({}),
    "GET /api/permission/request": () => scoped([]), "GET /api/form": () => scoped([]),
  });
  const provider = server.provider(), questions = provider.listQuestions!.bind(provider), events = provider.events.bind(provider);
  provider.listQuestions = async () => {
    const result = await questions();
    // This is after attribution has banked and consumed its own proof, but
    // before the enclosing history publication's final source/owner fences.
    if (holding && readOwner.getStore()) { holding = false; entered(); await gate; }
    return result;
  };
  provider.events = async function* (signal) { for await (const event of events(signal)) {
    if (holdStartup && event.eventType === "server.connected") { startupEntered(); await startup; }
    yield event; if (event.eventType === "diagnostic.own-proof.applied") applied();
  } };
  const adapter = new ChatAdapter({ provider, workspacePath: WORKSPACE, coalesceWindowMs: 0 });
  const now = Date.now(); let elapsed = 0;
  const clock = spyOn(Date, "now").mockImplementation(() => now + elapsed);
  const id = depth === "root" ? "ses_root" : "ses_parent";
  const carrier = (items: import("../../types").ConversationItem[]) => depth === "root"
    ? items.flatMap(item => item.type === "tool" ? item.descendants ?? [] : []).find(item => item.id === "tool:call_worker")
    : items.find((item): item is import("../../types").ToolItem => item.type === "tool" && item.id === "tool:call_worker");
  let reading: ReturnType<ChatAdapter["history"]> | undefined;
  try {
    if (initial === "warm") {
      expect(carrier((await adapter.history(id)).items)).toMatchObject({ usage: { costUsd: 0.5 }, model: "child-model" });
      if (fence === "none") await adapter.stopEventPump();
      unavailable = true; ownCost = fence === "none" ? own : 0.25; elapsed = 31_000;
    }
    // These changes have fresh own-page authority, not an old row receipt.
    if (binding === "input") tool.state.input.prompt = "Current source invocation";
    if (binding === "occurrence") { launch.time.created++; tool.time.created++; tool.time.completed++; }
    holding = fence !== "none";
    reading = readOwner.run(true, () => adapter.history(id));
    void reading.catch(() => undefined);
    if (fence !== "none") {
      await captured;
      if (fence === "expiry") { elapsed += 26_000; ownCost = 0.75; }
      if (fence.startsWith("incoming-")) { incomingForeign = true; await provider.getSession("ses_child"); }
      if (fence === "cancel" || fence === "generation") {
        await adapter.stopEventPump();
        if (fence === "generation") { holdStartup = true; void adapter.startEventPump(); await startupReady; }
      }
      if (fence === "new-live") {
        ownCost = 0.75; ownModel = "newer-model";
        const ready = new Promise<void>(resolve => { applied = resolve; });
        for (const event of [
          { type: "session.step.started", created: 25, data: { sessionID: "ses_child", assistantMessageID: "spend_first", started: 25, model: { providerID: "fixture", id: ownModel } } },
          { type: "session.step.ended", created: 25, data: { sessionID: "ses_child", assistantMessageID: "spend_first", cost: ownCost } },
          { type: "diagnostic.own-proof.applied", data: {} },
        ]) wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ ...event, location: { directory: WORKSPACE } })}\n\n`));
        await ready;
      }
      release();
    }
    if (fence === "cancel" || fence === "generation") {
      await expect(reading).rejects.toThrow();
      expect(carrier(adapter.projectionForTests(id).items())).toMatchObject({ usage: { costUsd: 0.5 }, model: "child-model" });
      ownCost = 0.75;
      releaseStartup();
      const fresh = await adapter.history(id), retained = await adapter.subscribe(id); retained.events.cancel();
      for (const items of [fresh.items, retained.snapshot.items]) expect(carrier(items)).toMatchObject({ usage: { costUsd: 0.75 }, model: "child-model" });
      return;
    }
    const current = await reading;
    const next = await adapter.subscribe(id); next.events.cancel();
    // Check both public handoff surfaces together, including authoritative zero.
    expect([current.items, next.snapshot.items].map(items => {
      const row = carrier(items); return { usage: row?.usage, model: row?.model };
    })).toEqual(Array.from({ length: 2 }, () => incomingForeign ? { usage: undefined, model: undefined }
      : { usage: { costUsd: fence === "none" ? own : fence === "expiry" ? 0.5 : 0.75 }, model: ownModel }));
    if (incomingForeign) return;
    const descendants = (items: import("../../types").ConversationItem[]) => items.flatMap(item => item.type === "tool" ? item.descendants ?? [] : []);
    if (ownership !== "unavailable") for (const items of [current.items, next.snapshot.items]) {
      expect(descendants(items).some(line => line.conversationId === "ses_grandchild")).toBe(false);
    }
    if (depth === "direct") for (const items of [current.items, next.snapshot.items]) {
      expect(carrier(items)).toMatchObject({ workerSession: { costUsd: 0.5 } });
    }
    unavailable = false;
    // Positive counterproof is authoritative absence, unlike a failed lookup;
    // recovery needs a new ownership observation and normal refresh admission.
    if (ownership !== "unavailable") elapsed += 31_000;
    if (fence === "expiry") await adapter.stopEventPump();
    const reads = server.requests("GET", "/api/session/ses_grandchild/message").length;
    const recovered = await adapter.history(id);
    expect(server.requests("GET", "/api/session/ses_grandchild/message").length).toBeGreaterThan(reads);
    expect(carrier(recovered.items)).toMatchObject({ usage: { costUsd: fence === "none" ? own : 0.75 }, model: ownModel });
    expect(descendants(recovered.items)).toContainEqual(expect.objectContaining({ id: "tool:call_nested", usage: { costUsd: 0.25 } }));
    expect(server.calls.every(call => call.method === "GET")).toBe(true);
  } finally { release(); releaseStartup(); await reading?.catch(() => undefined); clock.mockRestore(); await adapter.dispose(); expect(closed).toBe(opened); }
});

for (const depth of ["direct", "root", "deep"] as const) for (const binding of ["unchanged", "input", "occurrence"] as const)
for (const own of [0.5, 0]) for (const topology of ["unavailable", "complete"] as const)
for (const ordering of topology === "unavailable" ? ["history", "live-before", "live-after"] as const
  : depth === "direct" && binding !== "unchanged" ? ["history", "live-before"] as const : ["history"] as const)
for (const proof of topology === "unavailable" && binding === "unchanged" && own === 0.5 && ordering === "history"
  ? ["intact", "missing", "clone"] as const : ["intact"] as const)
for (const fence of depth !== "direct" && topology === "unavailable" && binding === "occurrence" && own === 0 && ordering === "history"
  ? ["none", "expiry", "incoming-parent", "cancel", "generation", "new-live"] as const : ["none"] as const)
test(`own-only inventory cannot renew a deeper receipt beneath an unproven parent occurrence (${depth}/${binding}/${own}/${topology}/${ordering}/${proof}/${fence})`, async () => {
  const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
  const launch = structuredClone(fixture.launch), tool = launch.content[0];
  tool.state.input.background = false; tool.state.metadata = { sessionID: "ses_child", status: "completed" };
  tool.state.content = [{ type: "text", text: "Foreground fixture checked." }];
  const nested = structuredClone(launch); nested.id = "msg_nested"; nested.time.created = 30;
  nested.content[0].id = "call_nested"; nested.content[0].time = { created: 30, completed: 35 };
  nested.content[0].state.metadata.sessionID = "ses_grandchild";
  const root = structuredClone(launch); root.id = "msg_root"; root.time.created = 10;
  root.content[0].id = "call_root"; root.content[0].time = { created: 10, completed: 15 };
  root.content[0].state.metadata.sessionID = "ses_parent";
  const prefixes = depth === "deep" ? ["ses_outer", "ses_outer_middle", "ses_root"] : depth === "root" ? ["ses_root"] : [];
  const id = prefixes[0] ?? "ses_parent";
  const ancestorLaunches = prefixes.map((parent, index) => {
    const message = structuredClone(root); message.id = `msg_${parent}`; message.content[0].id = `call_${parent}`;
    message.content[0].state.metadata.sessionID = prefixes[index + 1] ?? "ses_parent";
    return message;
  });
  let unavailable = false, incomingForeign = false, ownCost = 0.5, grandchildCost = 0.25, ownModel = "child-model";
  let wire!: ReadableStreamDefaultController<Uint8Array>, applied!: () => void;
  let holding = false, entered!: () => void, release!: () => void;
  let holdStartup = false, startupEntered!: () => void, releaseStartup!: () => void;
  const captured = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const startupReady = new Promise<void>(resolve => { startupEntered = resolve; }), startup = new Promise<void>(resolve => { releaseStartup = resolve; });
  const readOwner = new AsyncLocalStorage<boolean>();
  let opened = 0, closed = 0;
  const server = fakeOpenCode({
    "GET /api/event": ({ signal }) => new Response(new ReadableStream<Uint8Array>({ start(controller) {
      wire = controller; opened++; controller.enqueue(new TextEncoder().encode('data: {"type":"server.connected","data":{}}\n\n'));
      signal.addEventListener("abort", () => { closed++; controller.close(); }, { once: true });
    } }), { headers: { "content-type": "text/event-stream" } }),
    "GET /api/session": () => ({ data: [], cursor: {} }),
    ...Object.fromEntries(prefixes.flatMap((parent, index) => [
      [`GET /api/session/${parent}`, () => session(parent, index ? { parentID: prefixes[index - 1] } : {})],
      [`GET /api/session/${parent}/message`, () => ({ data: [
        { id: `prompt_${parent}`, type: "user", text: root.content[0].state.input.prompt, time: { created: 1 } },
        ancestorLaunches[index],
      ], cursor: {} })],
    ])),
    "GET /api/session/ses_parent": () => session("ses_parent", prefixes.length ? { parentID: prefixes.at(-1) } : {}),
    "GET /api/session/ses_parent/message": () => ({ data: [
      { id: "prompt_parent", type: "user", text: root.content[0].state.input.prompt, time: { created: 16 } }, launch,
    ], cursor: {} }),
    "GET /api/session/ses_child": () => session("ses_child", { parentID: incomingForeign ? "ses_other" : "ses_parent" }),
    "GET /api/session/ses_child/message": () => ({ data: [
      { id: "prompt_first", type: "user", text: tool.state.input.prompt, time: { created: 22 } },
      { id: "spend_first", type: "assistant", model: { id: ownModel }, cost: ownCost, content: [], time: { created: 25 } }, nested,
    ], cursor: {} }),
    "GET /api/session/ses_grandchild": () => unavailable ? new Response(null, { status: 503 }) : session("ses_grandchild", { parentID: "ses_child" }),
    "GET /api/session/ses_grandchild/message": () => ({ data: [{ id: "spend_nested", type: "assistant", model: { id: "grandchild-model" }, cost: grandchildCost, content: [], time: { created: 40 } }], cursor: {} }),
    "GET /api/session/:id/inbox": () => ({ data: [] }), "GET /api/session/active": () => ({}),
    "GET /api/permission/request": () => scoped([]), "GET /api/form": () => scoped([]),
  });
  const provider = server.provider(), questions = provider.listQuestions!.bind(provider), events = provider.events.bind(provider);
  provider.listQuestions = async () => {
    const result = await questions();
    if (holding && readOwner.getStore()) { holding = false; entered(); await gate; }
    return result;
  };
  provider.events = async function* (signal) { for await (const event of events(signal)) {
    if (holdStartup && event.eventType === "server.connected") { startupEntered(); await startup; }
    yield event; if (event.eventType === "diagnostic.deeper-binding.applied") applied();
  } };
  const adapter = new ChatAdapter({ provider, workspacePath: WORKSPACE, coalesceWindowMs: 0 });
  const now = Date.now(); let elapsed = 0;
  const clock = spyOn(Date, "now").mockImplementation(() => now + elapsed);
  const lines = (items: import("../../types").ConversationItem[]) => items.flatMap(item => item.type === "tool" ? item.descendants ?? [] : []);
  const history = adapter.history.bind(adapter);
  let isolate = false, explicitEntry = false, releaseIndependent!: () => void;
  const independentGate = new Promise<void>(resolve => { releaseIndependent = resolve; });
  const independentReads: Promise<unknown>[] = [];
  adapter.history = (...args) => {
    if (!isolate || explicitEntry) return history(...args);
    const reading = independentGate.then(() => history(...args)); independentReads.push(reading); void reading.catch(() => undefined); return reading;
  };
  const read = () => {
    explicitEntry = true;
    try { return readOwner.run(true, () => adapter.history(id)); }
    finally { explicitEntry = false; }
  };
  const carrier = (items: import("../../types").ConversationItem[]) => (depth === "direct" ? items.filter(item => item.type === "tool") : lines(items)).find(item => item.id === "tool:call_worker");
  const emit = async (updates: object[]) => {
    const ready = new Promise<void>(resolve => { applied = resolve; });
    for (const event of [...updates, { type: "diagnostic.deeper-binding.applied", data: {} }]) {
      wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ ...event, location: { directory: WORKSPACE } })}\n\n`));
    }
    await ready;
  };
  const toolEvent = () => ({ id: "evt_deeper_binding_tool", type: "session.message.content.updated", created: launch.time.created,
    durable: { aggregateID: "ses_parent", seq: 1, version: 1 },
    data: { sessionID: "ses_parent", messageID: launch.id, content: launch.content } });
  let reading: ReturnType<ChatAdapter["history"]> | undefined;
  try {
    expect(lines((await adapter.history(id)).items)).toContainEqual(expect.objectContaining({ id: "tool:call_nested", usage: { costUsd: 0.25 } }));
    // The retained native C launcher is materialized, not a fabricated adapter
    // row. No intermediate ancestor view is opened for root/deep recovery.
    await adapter.history("ses_child");
    if (proof !== "intact") {
      const projection = adapter.projectionForTests(id);
      for (const row of projection.items()) if (row.type === "tool" && row.descendants) projection.refreshEquivalentTool(row, { ...row,
        descendants: row.descendants.map(line => proof === "clone" || line.id === "tool:call_nested" ? { ...line } : line) });
    }
    await adapter.stopEventPump(); isolate = true; elapsed = 31_000; unavailable = topology === "unavailable"; ownCost = own;
    if (binding === "input") tool.state.input.prompt = "A different current invocation";
    if (binding === "occurrence") { launch.time.created++; tool.time.created++; tool.time.completed++; }
    if (ordering === "live-before") { void adapter.startEventPump(); await provider.waitForEventStream(new AbortController().signal); await emit([toolEvent()]); }
    holding = fence !== "none";
    reading = read(); void reading.catch(() => undefined);
    if (fence !== "none") {
      await captured;
      if (fence === "expiry") elapsed += 26_000;
      if (fence === "incoming-parent") { incomingForeign = true; await provider.getSession("ses_child"); }
      if (fence === "new-live") {
        ownCost = 0.75; ownModel = "newer-model";
        await emit([
          { type: "session.step.started", created: 25, data: { sessionID: "ses_child", assistantMessageID: "spend_first", started: 25, model: { providerID: "fixture", id: ownModel } } },
          { type: "session.step.ended", created: 25, data: { sessionID: "ses_child", assistantMessageID: "spend_first", cost: ownCost } },
        ]);
      }
      if (fence === "cancel" || fence === "generation") {
        await adapter.stopEventPump();
        if (fence === "generation") { holdStartup = true; void adapter.startEventPump(); await startupReady; }
      }
      release();
    }
    if (fence === "cancel" || fence === "generation") {
      await expect(reading).rejects.toThrow();
      expect(carrier(adapter.projectionForTests(id).items())).toMatchObject({ usage: { costUsd: 0.5 } });
      releaseStartup(); reading = read();
    }
    const current = await reading, next = await adapter.subscribe(id); next.events.cancel();
    const expectedOwn = fence === "new-live" ? 0.75 : own;
    const expectCurrent = (items: import("../../types").ConversationItem[]) => {
      if (incomingForeign) { expect(carrier(items)?.usage).toBeUndefined(); expect(lines(items).find(line => line.id === "tool:call_nested")).toBeUndefined(); return; }
      expect(carrier(items)).toMatchObject({ usage: { costUsd: expectedOwn }, model: ownModel });
      const descendant = lines(items).find(line => line.id === "tool:call_nested");
      if (topology === "complete" || binding === "unchanged" && proof === "intact") {
        expect(descendant).toMatchObject({ usage: { costUsd: 0.25 }, model: "grandchild-model" });
      } else expect(descendant).toBeUndefined();
    };
    for (const items of [current.items, next.snapshot.items]) {
      expectCurrent(items);
    }
    if (ordering === "live-after") {
      await emit([toolEvent(),
        { type: "session.step.started", created: 25, data: { sessionID: "ses_child", assistantMessageID: "spend_first", started: 25, model: { providerID: "fixture", id: ownModel } } },
        { type: "session.step.ended", created: 25, data: { sessionID: "ses_child", assistantMessageID: "spend_first", cost: ownCost } },
      ]);
      const live = await adapter.subscribe(id); live.events.cancel(); expectCurrent(live.snapshot.items);
    }
    if (incomingForeign) return;
    unavailable = false; grandchildCost = 0.375;
    const reads = server.requests("GET", "/api/session/ses_grandchild/message").length;
    // A separately admitted native read of the projected child is independent
    // authority. Release it only after the own-only reader's negative checks.
    isolate = false; releaseIndependent(); await Promise.allSettled(independentReads);
    await emit([{ type: "session.updated", data: { info: session("ses_grandchild", { parentID: "ses_child" }) } }]);
    const recovered = await adapter.history(id), retained = await adapter.subscribe(id); retained.events.cancel();
    if (topology === "unavailable") expect(server.requests("GET", "/api/session/ses_grandchild/message").length).toBeGreaterThan(reads);
    for (const items of [recovered.items, retained.snapshot.items]) {
      expect(carrier(items)).toMatchObject({ usage: { costUsd: expectedOwn }, model: ownModel });
      expect(lines(items)).toContainEqual(expect.objectContaining({ id: "tool:call_nested", usage: { costUsd: 0.375 }, model: "grandchild-model" }));
    }
    expect(server.calls.every(call => call.method === "GET")).toBe(true);
  } finally { release(); releaseStartup(); isolate = false; releaseIndependent(); await reading?.catch(() => undefined); await Promise.allSettled(independentReads); clock.mockRestore(); await adapter.dispose(); expect(closed).toBe(opened); }
});

for (const depth of ["direct", "root", "deep"] as const)
for (const change of depth === "root" ? ["input", "occurrence", "status", "completion", "prompt-origin", "unchanged"] as const : ["input", "occurrence", "status", "completion", "unchanged"] as const)
for (const own of [0.125, 0])
for (const projected of own === 0.125 && ["input", "occurrence", "unchanged"].includes(change) ? [true, false] : [true])
for (const initial of depth === "root" && !projected ? ["warm", "cold"] as const : ["warm"] as const)
for (const ordering of own === 0.125 && projected && ["input", "occurrence", "unchanged"].includes(change)
  ? ["history", "live-before", "live-after"] as const : ["history"] as const)
for (const outcome of depth === "root" && own === 0.125 && projected && change === "unchanged" && ordering === "history"
  ? ["unavailable", "foreign-parent", "foreign-workspace", "hidden", "committed", "changed-child", "ambiguous"] as const : ["unavailable"] as const)
for (const proof of depth === "root" && own === 0.125 && projected && change === "unchanged" && ordering === "history" && outcome === "unavailable"
  ? ["intact", "missing", "clone"] as const : ["intact"] as const)
for (const fence of depth === "root" && own === 0.125 && projected && change === "input" && ordering === "history"
  ? ["none", "expiry", "cancel", "generation", "new-live", "late-current"] as const : ["none"] as const)
for (const paging of depth === "root" && own === 0.125 && projected && ["input", "occurrence", "unchanged"].includes(change)
  && ordering === "history" && outcome === "unavailable" && proof === "intact" && fence === "none" ? ["single", "paged"] as const : ["single"] as const)
test(`readable deeper native occurrence invalidates only its old retained receipt (${depth}/${change}/${own}/${projected ? "projected" : "unprojected"}/${initial}/${ordering}/${outcome}/${proof}/${fence}/${paging})`, async () => {
  const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
  const launch = structuredClone(fixture.launch), tool = launch.content[0];
  tool.state.input.background = false; tool.state.metadata = { sessionID: "ses_child", status: "completed" };
  tool.state.content = [{ type: "text", text: "Foreground fixture checked." }];
  const nested = structuredClone(launch); nested.id = "msg_nested"; nested.time.created = 30;
  nested.content[0].id = "call_nested"; nested.content[0].time = { created: 30, completed: 35 };
  nested.content[0].state.metadata.sessionID = "ses_grandchild";
  const root = structuredClone(launch); root.id = "msg_root"; root.time.created = 10;
  root.content[0].id = "call_root"; root.content[0].time = { created: 10, completed: 15 };
  root.content[0].state.metadata.sessionID = "ses_parent";
  const sibling = structuredClone(nested); sibling.id = "msg_other"; sibling.time.created = 26;
  sibling.content[0].id = "call_other"; sibling.content[0].time = { created: 26, completed: 29 };
  sibling.content[0].state.metadata.sessionID = "ses_other";
  const leaf = structuredClone(nested); leaf.id = "msg_leaf"; leaf.time.created = 45;
  leaf.content[0].id = "call_leaf"; leaf.content[0].time = { created: 45, completed: 48 };
  leaf.content[0].state.metadata.sessionID = "ses_leaf";
  const prefixes = depth === "deep" ? ["ses_outer", "ses_outer_middle", "ses_root"] : depth === "root" ? ["ses_root"] : [];
  const id = prefixes[0] ?? "ses_parent";
  const ancestors = prefixes.map((parent, index) => {
    const message = structuredClone(root); message.id = `msg_${parent}`; message.content[0].id = `call_${parent}`;
    message.content[0].state.metadata.sessionID = prefixes[index + 1] ?? "ses_parent";
    return message;
  });
  let unavailable = false, freshAuthority = false, ownCost = 0.5, deeperCost = 0.25, opened = 0, closed = 0;
  let wire!: ReadableStreamDefaultController<Uint8Array>, applied!: () => void;
  let holding = false, entered!: () => void, release!: () => void;
  let holdStartup = false, startupEntered!: () => void, releaseStartup!: () => void;
  const captured = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const startupReady = new Promise<void>(resolve => { startupEntered = resolve; }), startup = new Promise<void>(resolve => { releaseStartup = resolve; });
  const readOwner = new AsyncLocalStorage<boolean>();
  const server = fakeOpenCode({
    "GET /api/event": ({ signal }) => new Response(new ReadableStream<Uint8Array>({ start(controller) {
      wire = controller; opened++; controller.enqueue(new TextEncoder().encode('data: {"type":"server.connected","data":{}}\n\n'));
      signal.addEventListener("abort", () => { closed++; controller.close(); }, { once: true });
    } }), { headers: { "content-type": "text/event-stream" } }),
    "GET /api/session": () => ({ data: [], cursor: {} }),
    ...Object.fromEntries(prefixes.flatMap((parent, index) => [
      [`GET /api/session/${parent}`, () => session(parent, index ? { parentID: prefixes[index - 1] } : {})],
      [`GET /api/session/${parent}/message`, () => ({ data: [
        { id: `prompt_${parent}`, type: "user", text: tool.state.input.prompt, time: { created: 1 } },
        { id: `spend_${parent}`, type: "assistant", model: { id: "ancestor-model" }, cost: 0.05, content: [], time: { created: 5 } }, ancestors[index],
      ], cursor: {} })],
    ])),
    "GET /api/session/ses_parent": () => session("ses_parent", prefixes.length ? { parentID: prefixes.at(-1) } : {}),
    "GET /api/session/ses_parent/message": () => ({ data: [
      { id: "prompt_parent", type: "user", text: tool.state.input.prompt, time: { created: 16 } },
      { id: "spend_parent", type: "assistant", model: { id: "parent-model" }, cost: 0.05, content: [], time: { created: 18 } }, launch, sibling,
    ], cursor: {} }),
    "GET /api/session/ses_child": () => session("ses_child", { parentID: "ses_parent", ...(unavailable && outcome === "hidden" ? { revert: { messageID: nested.id } } : {}) }),
    "GET /api/session/ses_child/message": ({ query }) => { const data = [
      { id: "prompt_first", type: "user", text: tool.state.input.prompt, time: { created: 22 } },
      { id: "spend_first", type: "assistant", model: { id: "child-model" }, cost: ownCost, content: [], time: { created: 25 } },
      ...(unavailable && change === "prompt-origin" ? [{ id: "prompt_rebinding", type: "user", text: "Another native prompt", time: { created: 29 } }] : []),
      ...(!unavailable || outcome !== "committed" ? [nested] : []),
      ...(unavailable && outcome === "ambiguous" ? [{ ...nested, id: "msg_reused", content: [{ ...nested.content[0], state: { ...nested.content[0].state, metadata: { sessionID: "ses_unavailable", status: "completed" } } }] }] : []),
      ...(freshAuthority ? [{ id: "prompt_fresh_authority", type: "user", text: "Fresh independent source", time: { created: 55 } }] : []),
    ]; return paging === "single" ? { data, cursor: {} } : query.get("cursor") === "native-deeper-page"
      ? { data: data.slice(2), cursor: {} } : { data: data.slice(0, 2), cursor: { next: "native-deeper-page" } }; },
    "GET /api/session/ses_grandchild": () => unavailable && !outcome.startsWith("foreign-") ? new Response(null, { status: 503 }) : session("ses_grandchild", {
      parentID: unavailable && outcome === "foreign-parent" ? "ses_foreign" : "ses_child",
      ...(unavailable && outcome === "foreign-workspace" ? { location: { directory: "/foreign" } } : {}),
    }),
    "GET /api/session/ses_grandchild/message": () => ({ data: [{ id: "spend_nested", type: "assistant", model: { id: "grandchild-model" }, cost: deeperCost, content: [], time: { created: 40 } }, leaf], cursor: {} }),
    "GET /api/session/ses_leaf": () => session("ses_leaf", { parentID: "ses_grandchild" }),
    "GET /api/session/ses_leaf/message": () => ({ data: [{ id: "spend_leaf", type: "assistant", model: { id: "leaf-model" }, cost: 0.03125, content: [], time: { created: 50 } }], cursor: {} }),
    "GET /api/session/ses_other": () => session("ses_other", { parentID: "ses_parent" }),
    "GET /api/session/ses_other/message": () => ({ data: [{ id: "spend_other", type: "assistant", model: { id: "other-model" }, cost: 0.0625, content: [], time: { created: 40 } }], cursor: {} }),
    "GET /api/session/ses_unavailable": () => new Response(null, { status: 503 }),
    "GET /api/session/:id/inbox": () => ({ data: [] }), "GET /api/session/active": () => ({}),
    "GET /api/permission/request": () => scoped([]), "GET /api/form": () => scoped([]),
  });
  const provider = server.provider(), events = provider.events.bind(provider), questions = provider.listQuestions!.bind(provider);
  provider.listQuestions = async () => {
    const result = await questions();
    if (holding && readOwner.getStore()) { holding = false; entered(); await gate; }
    return result;
  };
  provider.events = async function* (signal) { for await (const event of events(signal)) {
    if (holdStartup && event.eventType === "server.connected") { startupEntered(); await startup; }
    yield event; if (event.eventType === "diagnostic.current-deeper.applied") applied();
  } };
  const adapter = new ChatAdapter({ provider, workspacePath: WORKSPACE, coalesceWindowMs: 0 });
  const now = Date.now(); let elapsed = 0;
  const clock = spyOn(Date, "now").mockImplementation(() => now + elapsed);
  const lines = (items: import("../../types").ConversationItem[]) => items.flatMap(item => item.type === "tool" ? item.descendants ?? [] : []);
  const carrier = (items: import("../../types").ConversationItem[]) => (depth === "direct" ? items : lines(items)).find(item => item.id === "tool:call_worker");
  const history = adapter.history.bind(adapter);
  let isolate = false, explicitEntry = false, releaseIndependent!: () => void;
  const independentGate = new Promise<void>(resolve => { releaseIndependent = resolve; });
  const independentReads: Promise<unknown>[] = [];
  adapter.history = (...args) => {
    if (!isolate || explicitEntry) return history(...args);
    const reading = independentGate.then(() => history(...args)); independentReads.push(reading); void reading.catch(() => undefined); return reading;
  };
  const read = () => {
    explicitEntry = true;
    try { return readOwner.run(true, () => adapter.history(id)); } finally { explicitEntry = false; }
  };
  const emit = async (updates: object[]) => {
    const ready = new Promise<void>(resolve => { applied = resolve; });
    for (const event of [...updates, { type: "diagnostic.current-deeper.applied", data: {} }])
      wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ ...event, location: { directory: WORKSPACE } })}\n\n`));
    await ready;
  };
  const toolEvent = () => ({ id: "evt_current_deeper", type: "session.message.content.updated", created: nested.time.created,
    durable: { aggregateID: "ses_child", seq: 1, version: 1 }, data: { sessionID: "ses_child", messageID: nested.id, content: nested.content } });
  const parentEvent = () => ({ id: "evt_current_parent", type: "session.message.content.updated", created: launch.time.created,
    durable: { aggregateID: "ses_parent", seq: 1, version: 1 }, data: { sessionID: "ses_parent", messageID: launch.id, content: launch.content } });
  const siblingEvent = () => ({ id: "evt_current_other", type: "session.message.content.updated", created: sibling.time.created,
    durable: { aggregateID: "ses_parent", seq: 2, version: 2 }, data: { sessionID: "ses_parent", messageID: sibling.id, content: sibling.content } });
  let reading: ReturnType<ChatAdapter["history"]> | undefined;
  try {
    if (initial === "warm") {
      expect(lines((await adapter.history(id)).items)).toContainEqual(expect.objectContaining({ id: "tool:call_nested", usage: { costUsd: 0.25 } }));
      // Materialize B's C launcher through its real native history, retaining
      // the old object and proof while only deeper native input/clocks change.
      if (projected) await adapter.history("ses_child");
      // Live decoration retains exact direct-row receipts, not aggregate
      // inference from an unmaterialized sibling in an ancestor-only view.
      if (ordering === "live-after") await adapter.history("ses_parent");
      if (proof !== "intact") {
        const projection = adapter.projectionForTests(id);
        for (const row of projection.items()) if (row.type === "tool" && row.descendants) projection.refreshEquivalentTool(row, { ...row,
          descendants: row.descendants.map(line => proof === "clone" || line.id === "tool:call_nested" ? { ...line } : line) });
      }
      await adapter.stopEventPump();
    }
    isolate = true; elapsed = 31_000; unavailable = true;
    // A post-history restatement is not new allocation authority. Keep its
    // independently materialized own receipt unchanged while testing C's edge.
    ownCost = ordering === "live-after" ? 0.5 : own;
    if (change === "input") nested.content[0].state.input.prompt = "Changed deeper invocation";
    if (change === "occurrence") { nested.time.created++; nested.content[0].time.created++; nested.content[0].time.completed++; }
    if (change === "status") nested.content[0].state.status = "error";
    if (change === "completion") nested.content[0].time.completed++;
    if (outcome === "changed-child") nested.content[0].state.metadata.sessionID = "ses_unavailable";
    if (ordering === "live-before") { void adapter.startEventPump(); await provider.waitForEventStream(new AbortController().signal); await emit([toolEvent()]); }
    holding = fence !== "none";
    reading = read(); void reading.catch(() => undefined);
    if (fence !== "none") {
      await captured;
      if (fence === "expiry") elapsed += 26_000;
      if (fence === "late-current") { unavailable = false; deeperCost = 0.375; await provider.getSession("ses_grandchild"); }
      if (fence === "new-live") {
        ownCost = 0.875;
        await emit([parentEvent(), siblingEvent(),
          { type: "session.step.started", created: 25, data: { sessionID: "ses_child", assistantMessageID: "spend_first", started: 25, model: { providerID: "fixture", id: "child-model" } } },
          { type: "session.step.ended", created: 25, data: { sessionID: "ses_child", assistantMessageID: "spend_first", cost: ownCost } },
        ]);
      }
      if (fence === "cancel" || fence === "generation") {
        await adapter.stopEventPump();
        if (fence === "generation") { holdStartup = true; void adapter.startEventPump(); await startupReady; }
      }
      release();
    }
    if (fence === "cancel" || fence === "generation") {
      await expect(reading).rejects.toThrow();
      expect(carrier(adapter.projectionForTests(id).items())).toMatchObject({ usage: { costUsd: 0.5 } });
      releaseStartup(); reading = read();
    }
    const current = await reading, next = await adapter.subscribe(id); next.events.cancel();
    const expectCurrent = (items: import("../../types").ConversationItem[]) => {
      expect(carrier(items)).toMatchObject({ usage: { costUsd: ownCost }, model: "child-model" });
      const receipt = lines(items).find(line => line.id === "tool:call_nested");
      const retained = initial === "warm" && change === "unchanged" && outcome === "unavailable" && proof === "intact";
      if (fence === "late-current") expect(receipt).toMatchObject({ usage: { costUsd: 0.375 }, model: "grandchild-model" });
      else if (retained) {
        expect(receipt).toBeDefined();
        if (projected) expect(receipt).toMatchObject({ usage: { costUsd: 0.25 }, model: "grandchild-model" });
        else { expect(receipt?.usage).toBeUndefined(); expect(receipt?.model).toBeUndefined(); }
      }
      else expect(receipt).toBeUndefined();
      if (!retained && fence !== "late-current") expect(lines(items).some(line => line.id === "tool:call_leaf")).toBe(false);
      // A different outgoing branch remains usable, even at known own zero.
      expect(depth === "direct" ? items : lines(items)).toContainEqual(expect.objectContaining({ id: "tool:call_other", usage: { costUsd: 0.0625 } }));
    };
    for (const items of [current.items, next.snapshot.items]) expectCurrent(items);
    if (ordering === "live-after") {
      await emit([parentEvent(), siblingEvent(), toolEvent(),
        { type: "session.step.started", created: 25, data: { sessionID: "ses_child", assistantMessageID: "spend_first", started: 25, model: { providerID: "fixture", id: "child-model" } } },
        { type: "session.step.ended", created: 25, data: { sessionID: "ses_child", assistantMessageID: "spend_first", cost: ownCost } },
      ]);
      const live = await adapter.subscribe(id); live.events.cancel(); expectCurrent(live.snapshot.items);
    }
    if (projected) expect(independentReads.length).toBeGreaterThan(0);
    // A distinct source-current automatic recovery must still restore the
    // branch once ownership returns; the negative check cannot forbid it.
    const recoveredCost = own === 0 ? 0 : 0.375;
    unavailable = false; freshAuthority = true; ownCost = 0.75; deeperCost = recoveredCost; elapsed += 31_000;
    nested.content[0].state.metadata.sessionID = "ses_grandchild";
    await emit([{ type: "session.updated", data: { info: session("ses_grandchild", { parentID: "ses_child" }) } }]);
    isolate = false; releaseIndependent(); await Promise.all(independentReads);
    if (projected) {
      const automatic = await adapter.subscribe("ses_child"); automatic.events.cancel();
      expect(automatic.snapshot.items).toContainEqual(expect.objectContaining({ id: "message:prompt_fresh_authority", text: "Fresh independent source" }));
    }
    const fresh = await adapter.history(id), retained = await adapter.subscribe(id); retained.events.cancel();
    for (const items of [fresh.items, retained.snapshot.items]) {
      expect(carrier(items)).toMatchObject({ usage: { costUsd: 0.75 } });
      expect(lines(items)).toContainEqual(expect.objectContaining({ id: "tool:call_nested", usage: { costUsd: recoveredCost } }));
    }
    if (paging === "paged") expect(server.requests("GET", "/api/session/ses_child/message").some(call => call.query.get("cursor") === "native-deeper-page")).toBe(true);
    expect(server.calls.every(call => call.method === "GET")).toBe(true);
  } finally { release(); releaseStartup(); isolate = false; releaseIndependent(); await reading?.catch(() => undefined); await Promise.allSettled(independentReads); clock.mockRestore(); await adapter.dispose(); expect(closed).toBe(opened); }
});

for (const size of [1, 2]) for (const change of size === 1 ? ["input", "occurrence", "unchanged"] as const : ["input", "occurrence", "second-input", "second-occurrence", "unchanged"] as const)
for (const liveBeforeHistory of [false, true])
for (const ancestorFirst of [false, true])
for (const pressureCount of ancestorFirst ? [0] : size === 1 && !liveBeforeHistory && (change === "input" || change === "unchanged") ? [0, 511, 512] : [0, 512])
test(`expired foreground accounting does not price a changed launcher from its old tally (${size}/${change}${liveBeforeHistory ? "/live-before-history" : ""}${ancestorFirst ? "/ancestor-first" : ""}${pressureCount ? `/cache-pressure=${pressureCount}` : ""})`, async () => {
  const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
  const launch = structuredClone(fixture.launch), tool = launch.content[0];
  tool.state.input.background = false; tool.state.metadata = { sessionID: "ses_child", status: "completed" };
  tool.state.content = [{ type: "text", text: "Foreground fixture checked." }];
  const sibling = structuredClone(launch); sibling.id = "msg_sibling"; sibling.time.created = 60;
  sibling.content[0].id = "call_sibling"; sibling.content[0].time = { created: 60, completed: 70 };
  sibling.content[0].state.input.prompt = "A second task";
  const root = structuredClone(launch); root.id = "msg_root"; root.time.created = 10;
  root.content[0].id = "call_root"; root.content[0].time = { created: 10, completed: 15 };
  root.content[0].state.metadata.sessionID = "ses_parent"; root.content[0].state.input.prompt = "Root task";
  const changedLaunch = change.startsWith("second-") ? sibling : launch, changedTool = changedLaunch.content[0];
  let changed = false, fresh = false, zero = false, opened = 0, closed = 0, slowReads = 0, abortedReads = 0;
  let wire!: ReadableStreamDefaultController<Uint8Array>, applied!: () => void;
  const nativeReads: Promise<unknown>[] = [];
  const pressureParents = new Set<string>();
  const server = fakeOpenCode({
    "GET /api/event": ({ signal }) => new Response(new ReadableStream<Uint8Array>({ start(controller) {
      wire = controller; opened++; controller.enqueue(new TextEncoder().encode('data: {"type":"server.connected","data":{}}\n\n'));
      signal.addEventListener("abort", () => { closed++; controller.close(); }, { once: true });
    } }), { headers: { "content-type": "text/event-stream" } }),
    "GET /api/session": () => ({ data: [], cursor: {} }),
    "GET /api/session/ses_root": () => session("ses_root"),
    "GET /api/session/ses_root/message": () => ({ data: [root], cursor: {} }),
    "GET /api/session/ses_parent": () => session("ses_parent", ancestorFirst ? { parentID: "ses_root" } : {}),
    "GET /api/session/ses_child": () => session("ses_child", { parentID: "ses_parent", cost: zero ? 0 : (changed ? 0.25 : 0.125) + (size === 2 ? 0.2 : 0) }),
    "GET /api/session/ses_parent/message": () => ({ data: size === 2 ? [launch, sibling] : [launch], cursor: {} }),
    "GET /api/session/ses_child/message": ({ signal }) => {
      const page = () => ({ data: [
        { id: "prompt_first", type: "user", text: fresh ? tool.state.input.prompt : "Inspect the safe fixture", time: { created: 22 } },
        { id: "msg_priced", type: "assistant", time: { created: 25 }, model: { id: changed ? "new-model" : "old-model" }, cost: zero ? 0 : changed ? 0.25 : 0.125, content: [] },
        ...(size === 2 ? [{ id: "prompt_second", type: "user", text: fresh ? sibling.content[0].state.input.prompt : "A second task", time: { created: 62 } },
          { id: "msg_sibling_priced", type: "assistant", time: { created: 65 }, model: { id: "old-model" }, cost: zero ? 0 : 0.2, content: [] }] : []),
      ], cursor: {} });
      if (!changed || fresh || size === 2) return page();
      slowReads++;
      const reading = Bun.sleep(1_500).then(page); nativeReads.push(reading);
      // The native transport respects fetch cancellation, even if the healthy
      // server finishes producing its response after the optional deadline.
      return Promise.race([reading, new Promise<never>((_resolve, reject) => {
        const abort = () => { abortedReads++; reject(new DOMException("Aborted", "AbortError")); };
        if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
      })]);
    },
    "GET /api/session/:id": ({ path: route }) => {
      const id = route.split("/").at(-1)!;
      if (id.startsWith("ses_pressure_child_")) pressureParents.add(id);
      return session(id, id.startsWith("ses_pressure_child_") ? { parentID: "ses_pressure" } : {});
    },
    "GET /api/session/:id/message": () => ({ data: [], cursor: {} }),
    "GET /api/session/:id/inbox": () => ({ data: [] }), "GET /api/session/active": () => ({}),
    "GET /api/permission/request": () => scoped([]), "GET /api/form": () => scoped([]),
  });
  const provider = server.provider(), events = provider.events.bind(provider), list = provider.listMessages.bind(provider);
  provider.listMessages = async (...args) => {
    if (changed && !fresh && size === 2 && args[0] === "ses_child") {
      // Shared-child execution enrichment also reads this native transcript.
      // Delay only the public accounting page so that earlier enrichment does
      // not satisfy this test's optional accounting window via byte-cache reuse.
      slowReads++; args[1].signal?.addEventListener("abort", () => { abortedReads++; }, { once: true });
      const reading = Bun.sleep(1_500); nativeReads.push(reading); await reading;
    }
    const page = await list(...args);
    if (args[0] === "ses_parent") for (const row of page.items.filter(item => item.type === "tool")) {
      expect(row).not.toHaveProperty("usage"); expect(row).not.toHaveProperty("model");
    }
    return page;
  };
  provider.events = async function* (signal) { for await (const event of events(signal)) { yield event; if (event.eventType === "diagnostic.changed-launcher.applied") applied(); } };
  const emit = async (batch: Array<Record<string, unknown>>) => {
    const ready = new Promise<void>(resolve => { applied = resolve; });
    for (const event of [...batch, { type: "diagnostic.changed-launcher.applied", data: {} }])
      wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ ...event, location: { directory: WORKSPACE } })}\n\n`));
    await ready;
  };
  const adapter = new ChatAdapter({ provider, workspacePath: WORKSPACE, coalesceWindowMs: 0 });
  const now = Date.now(); let elapsed = 0;
  const clock = spyOn(Date, "now").mockImplementation(() => now + elapsed);
  const carrier = (items: import("../../types").ConversationItem[]) => items.find(item => item.id === "tool:call_worker");
  const costs = (items: import("../../types").ConversationItem[]) => ["tool:call_worker", ...(size === 2 ? ["tool:call_sibling"] : [])].map(id => {
    const item = items.find(item => item.id === id); return item?.type === "tool" ? item.usage?.costUsd : undefined;
  });
  const expected = change === "unchanged" ? size === 2 ? [0.125, 0.2] : [0.125]
    : size === 1 ? [undefined] : change.startsWith("second-") ? [0.125, undefined] : [undefined, 0.2];
  let pinned: Awaited<ReturnType<ChatAdapter["subscribe"]>> | undefined, pressureView: Awaited<ReturnType<ChatAdapter["subscribe"]>> | undefined;
  try {
    if (ancestorFirst) {
      const initial = await adapter.history("ses_root");
      const branch = initial.items.find(item => item.id === "tool:call_root");
      expect(branch?.type === "tool" ? branch.descendants?.find(line => line.id === "tool:call_worker") : undefined).toMatchObject({ model: "old-model", usage: { costUsd: 0.125 } });
    } else expect(carrier((await adapter.history("ses_parent")).items)).toMatchObject({ model: "old-model", usage: { costUsd: 0.125 } });
    if (pressureCount) {
      pinned = await adapter.subscribe("ses_parent"); pressureView = await adapter.subscribe("ses_pressure");
      // Real native prompt deliveries bank distinct child transcripts. The
      // existing 512-entry budget evicts accounting, not the pinned parent view.
      await emit(Array.from({ length: pressureCount }, (_, index) => {
        const sessionID = `ses_pressure_child_${index}`, inboxID = `pressure_prompt_${index}`;
        return [
          { id: `pressure_enqueued_${index}`, type: "session.inbox.enqueued", created: 1000 + index * 2, data: { sessionID, inboxID, item: { id: inboxID, type: "user", payload: { text: "Native pressure prompt" } } } },
          { id: `pressure_delivered_${index}`, type: "session.inbox.delivered", created: 1001 + index * 2, data: { sessionID, inboxID } },
        ];
      }).flat());
      expect(pressureParents.size).toBe(pressureCount);
      const last = await adapter.subscribe(`ses_pressure_child_${pressureCount - 1}`); last.events.cancel();
      expect(last.snapshot.items).toContainEqual(expect.objectContaining({ id: `message:pressure_prompt_${pressureCount - 1}`, type: "user_message" }));
      const retained = await adapter.subscribe("ses_parent"); retained.events.cancel();
      expect(costs(retained.snapshot.items)).toEqual(size === 2 ? [0.125, 0.2] : [0.125]);
      expect(opened).toBe(1); expect(closed).toBe(0);
    }
    changed = true; elapsed = 31_000;
    if (change.endsWith("input")) changedTool.state.input.prompt = "A distinct foreground invocation";
    if (change.endsWith("occurrence")) { changedLaunch.time.created++; changedTool.time.created++; changedTool.time.completed++; }
    await emit(["ses_parent", "ses_child"].map(id => ({ type: "session.updated", created: 90, data: { info: session(id, id === "ses_child" ? { parentID: "ses_parent" } : ancestorFirst ? { parentID: "ses_root" } : {}) } })));
    if (liveBeforeHistory) await emit([{ id: "evt_changed_launcher", type: "session.message.content.updated", created: changedLaunch.time.created,
      durable: { aggregateID: "ses_parent", seq: 1, version: 1 }, data: { sessionID: "ses_parent", messageID: changedLaunch.id, content: changedLaunch.content } }]);
    const refreshed = await adapter.history("ses_parent");
    const next = await adapter.subscribe("ses_parent"); next.events.cancel();
    expect(slowReads).toBeGreaterThan(0); expect(abortedReads).toBeGreaterThan(0);
    if (pressureCount) expect({ history: costs(refreshed.items), subscription: costs(next.snapshot.items) }).toEqual({ history: expected, subscription: expected });
    for (const items of [refreshed.items, next.snapshot.items]) {
      expect(costs(items)).toEqual(expected);
      expect(carrier(items)).toMatchObject({ input: JSON.stringify(tool.state.input), childConversationId: "ses_child", workerSession: { costUsd: size === 2 ? 0.325 : 0.125 } });
      for (const row of items.filter(item => item.type === "tool")) {
        if (row.id === `tool:${changedTool.id}` && change !== "unchanged") {
          expect(row).toMatchObject({ input: JSON.stringify(changedTool.state.input), createdAt: changedTool.time.created,
            completedAt: changedTool.time.completed, output: "Foreground fixture checked.", status: "completed", childConversationId: "ses_child" });
          expect(row).not.toHaveProperty("usage"); expect(row.model).toBeUndefined();
        } else expect(row).toMatchObject({ model: "old-model" });
      }
    }
    // Neither the retired transport's eventual response nor a native usage/
    // model restatement is current task accounting or occurrence proof.
    await Promise.allSettled(nativeReads);
    const late = await adapter.subscribe("ses_parent"); late.events.cancel(); expect(costs(late.snapshot.items)).toEqual(expected);
    if (change !== "unchanged") {
      await emit([
        { type: "session.step.started", created: 25, data: { sessionID: "ses_child", assistantMessageID: "msg_priced", started: 25, model: { providerID: "fixture", id: "restated-model" } } },
        { type: "session.step.ended", created: 25, data: { sessionID: "ses_child", assistantMessageID: "msg_priced", cost: 0.125 } },
      ]);
      const restated = await adapter.subscribe("ses_parent"); restated.events.cancel(); expect(costs(restated.snapshot.items)).toEqual(expected);
    }
    // Completed native accounting can recover the changed task, including an
    // explicit authoritative zero. Its lifetime session high-water is separate.
    fresh = true;
    for (const free of [false, true]) {
      zero = free; elapsed += 31_000;
      await emit(["ses_parent", "ses_child"].map(id => ({ type: "session.updated", created: free ? 110 : 100, data: { info: session(id, id === "ses_child" ? { parentID: "ses_parent" } : ancestorFirst ? { parentID: "ses_root" } : {}) } })));
      const recovered = await adapter.history("ses_parent");
      const subscription = await adapter.subscribe("ses_parent"); subscription.events.cancel();
      for (const items of [recovered.items, subscription.snapshot.items]) {
        expect(costs(items)).toEqual(size === 2 ? [zero ? 0 : 0.25, zero ? 0 : 0.2] : [zero ? 0 : 0.25]);
        expect(carrier(items)).toMatchObject({ model: "new-model", workerSession: { costUsd: size === 2 ? 0.45 : 0.25 } });
        if (zero) expect(conversationTotals(items)).toBeUndefined();
        else expect(conversationTotals(items)?.costUsd).toBeCloseTo(size === 2 ? 0.45 : 0.25);
      }
    }
    expect(server.calls.every(call => call.method === "GET")).toBe(true);
  } finally { pinned?.events.cancel(); pressureView?.events.cancel(); clock.mockRestore(); await adapter.dispose(); await Promise.allSettled(nativeReads); expect(closed).toBe(opened); }
}, pressureCount ? 20_000 : 5_000);

for (const outcome of ["unavailable", "healthy", "cold", "no-prior", "foreign-parent", "foreign-workspace", "hidden-origin", "changed-occurrence", "changed-child", "changed-input", "ambiguous-origin", "returned-new", "new-live"] as const)
test(`paged foreground reconnect retains only its exact known accounting carrier (${outcome})`, async () => {
  const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
  const launch = structuredClone(fixture.launch), tool = launch.content[0];
  tool.state.input.background = false; tool.state.metadata = { sessionID: "ses_child", status: "completed" };
  tool.state.content = [{ type: "text", text: "Foreground fixture checked." }];
  let changed = outcome === "cold", opened = 0, closed = 0, held = false;
  let wire!: ReadableStreamDefaultController<Uint8Array>, entered!: () => void, release!: () => void, applied!: () => void;
  const owner = new AsyncLocalStorage<boolean>(), captured = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; }), eventApplied = new Promise<void>(resolve => { applied = resolve; });
  const unavailable = () => changed && !["healthy", "foreign-parent", "foreign-workspace", "returned-new"].includes(outcome);
  const later = Array.from({ length: 51 }, (_, index) => ({ id: `msg_later_${index}`, type: "user", text: `Later turn ${index}`, time: { created: 100 + index } }));
  const server = fakeOpenCode({
    "GET /api/event": ({ signal }) => new Response(new ReadableStream<Uint8Array>({ start(controller) {
      wire = controller; opened++; controller.enqueue(new TextEncoder().encode('data: {"type":"server.connected","data":{}}\n\n'));
      signal.addEventListener("abort", () => { closed++; controller.close(); }, { once: true });
    } }), { headers: { "content-type": "text/event-stream" } }),
    "GET /api/session": () => ({ data: [], cursor: {} }),
    "GET /api/session/ses_parent": () => session("ses_parent", changed && outcome === "hidden-origin" ? { revert: { messageID: launch.id } } : {}),
    "GET /api/session/ses_child": () => unavailable() ? new Response(null, { status: 503 }) : session("ses_child", {
      parentID: changed && outcome === "foreign-parent" ? "ses_other" : "ses_parent", cost: changed && outcome === "returned-new" ? 0.25 : 0.125,
      ...(changed && outcome === "foreign-workspace" ? { location: { directory: "/foreign" } } : {}),
    }),
    "GET /api/session/ses_other_child": () => new Response(null, { status: 503 }),
    "GET /api/session/ses_parent/message": () => {
      const reused = structuredClone(launch); reused.id = "msg_reused_launch"; reused.content[0].state.metadata.sessionID = "ses_other_child";
      return { data: !changed && outcome === "no-prior" ? [] : [launch, ...(changed && outcome === "ambiguous-origin" ? [reused] : []), ...(changed ? later : [])], cursor: {} };
    },
    "GET /api/session/ses_child/message": () => ({ data: [{ id: "msg_priced", type: "assistant", time: { created: 25 },
      model: { id: changed && outcome === "returned-new" ? "new-model" : "fixture-model" }, cost: changed && outcome === "returned-new" ? 0.25 : 0.125, content: [] }], cursor: {} }),
    "GET /api/session/:id/inbox": () => ({ data: [] }), "GET /api/session/active": () => ({}),
    "GET /api/permission/request": () => scoped([]), "GET /api/form": async () => {
      if (changed && outcome === "new-live" && owner.getStore() && !held) { held = true; entered(); await gate; }
      return scoped([]);
    },
  });
  const provider = server.provider(), events = provider.events.bind(provider);
  provider.events = async function* (signal) { for await (const event of events(signal)) { if (event.eventType === "diagnostic.paged.foreground.complete") applied(); yield event; } };
  const adapter = new ChatAdapter({ provider, workspacePath: WORKSPACE, coalesceWindowMs: 0 });
  const carriers = (items: import("../../types").ConversationItem[]) => items.filter(item => item.id === "tool:call_worker");
  const known = expect.objectContaining({ id: "tool:call_worker", type: "tool", status: "completed", output: "Foreground fixture checked.",
    childConversationId: "ses_child", workerSession: expect.objectContaining({ costUsd: 0.125 }), model: "fixture-model", usage: expect.objectContaining({ costUsd: 0.125 }) });
  const now = Date.now(); let elapsed = 0;
  const clock = outcome === "returned-new" ? spyOn(Date, "now").mockImplementation(() => now + elapsed) : undefined;
  let reading: ReturnType<ChatAdapter["history"]> | undefined;
  try {
    if (outcome !== "cold") {
      expect(carriers((await adapter.history("ses_parent")).items)).toEqual(outcome === "no-prior" ? [] : [known]);
      await adapter.stopEventPump();
    }
    changed = true;
    if (outcome === "returned-new") elapsed = 31_000; // Exercise current accounting, not a still-complete cache hit.
    if (outcome === "changed-occurrence") { tool.time.created = 21; launch.time.created = 21; }
    if (outcome === "changed-child") tool.state.metadata.sessionID = "ses_other_child";
    if (outcome === "changed-input") tool.state.input.prompt = "A distinct foreground invocation";
    const sparse = await provider.listMessages("ses_parent", { limit: 50 });
    expect(carriers(sparse.items)).toEqual([]);
    if (unavailable() && outcome !== "hidden-origin") {
      const sparseTool = sparse.completeItems?.find(item => item.id === "tool:call_worker");
      expect(sparseTool).toMatchObject({ type: "tool", name: "subagent", status: "completed", output: "Foreground fixture checked." });
      expect(sparseTool).not.toHaveProperty("childConversationId");
    }
    reading = owner.run(true, () => adapter.history("ses_parent"));
    if (outcome === "new-live") {
      await captured;
      tool.state.content = [{ type: "text", text: "Newer live foreground report." }];
      for (const event of [
        { id: "evt_paged_foreground", created: 190, type: "session.message.content.updated", durable: { aggregateID: "ses_parent", seq: 1, version: 1 }, data: { sessionID: "ses_parent", messageID: launch.id, content: launch.content } },
        { type: "diagnostic.paged.foreground.complete", data: {} },
      ]) wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ ...event, location: { directory: WORKSPACE } })}\n\n`));
      await eventApplied; release();
    }
    const history = await reading;
    const next = await adapter.subscribe("ses_parent"); next.events.cancel();
    if (outcome !== "hidden-origin") {
      expect(history.olderCursor).toBeDefined();
      expect(history.items.filter(item => item.type === "user_message").map(item => item.id)).toEqual(later.slice(1).map(message => `message:${message.id}`));
    }
    expect(history.items.some(item => item.type === "background_task")).toBe(false);
    expect(next.snapshot.items.some(item => item.type === "background_task")).toBe(false);
    expect(server.calls.every(call => call.method === "GET")).toBe(true);
    // Check the first page before requesting older history: loading that page
    // must not be necessary to restore an already verified receipt/link.
    const expected = outcome === "unavailable" || outcome === "healthy" ? [known]
      : outcome === "returned-new" ? [expect.objectContaining({ id: "tool:call_worker", childConversationId: "ses_child", model: "new-model", usage: expect.objectContaining({ costUsd: 0.25 }), workerSession: expect.objectContaining({ costUsd: 0.25 }) })]
      : outcome === "new-live" ? [expect.objectContaining({ id: "tool:call_worker", output: "Newer live foreground report." })] : [];
    expect({ history: carriers(history.items), subscription: carriers(next.snapshot.items) }).toEqual({ history: expected, subscription: expected });
    if (outcome === "unavailable" || outcome === "healthy" || outcome === "returned-new") {
      const older = await adapter.history("ses_parent", { cursor: history.olderCursor });
      expect(older.olderCursor).toBeUndefined();
      expect(older.items.filter(item => item.type === "user_message").map(item => item.id)).toEqual(["message:msg_later_0"]);
      expect(carriers(older.items)).toEqual(expected);
      expect(new Map([...history.items, ...older.items].map(item => [item.id, item])).size).toBe(52);
      const after = await adapter.subscribe("ses_parent"); after.events.cancel();
      expect(carriers(after.snapshot.items)).toEqual(expected);
    }
  } finally { release(); await reading?.catch(() => undefined); clock?.mockRestore(); await adapter.dispose(); expect(closed).toBe(opened); }
});

for (const cold of [false, true]) for (const canonical of [false, true]) test(`visible result supersedes its fallback across ${cold ? "cold degradation" : "degraded reconnect"} (${canonical ? "canonical" : "notification"} worker)`, async () => {
  const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
  let unavailable = cold, opened = 0, closed = 0;
  const unrelated = { id: "msg_note", type: "synthetic", time: { created: 43 }, text: "An unrelated native note" };
  const unmatched = { ...fixture.stored, id: "msg_unmatched", metadata: { ...fixture.stored.metadata, childID: "ses_unverified" },
    text: fixture.stored.text.replaceAll("ses_child", "ses_unverified") };
  const server = fakeOpenCode({
    "GET /api/event": ({ signal }) => new Response(new ReadableStream<Uint8Array>({ start(controller) {
      opened++;
      signal.addEventListener("abort", () => { closed++; controller.close(); }, { once: true });
      controller.enqueue(new TextEncoder().encode('data: {"type":"server.connected","data":{}}\n\n'));
    } }), { headers: { "content-type": "text/event-stream" } }),
    "GET /api/session": () => ({ data: [session("ses_parent")], cursor: {} }),
    "GET /api/session/ses_parent": () => session("ses_parent"),
    "GET /api/session/ses_child": () => unavailable ? new Response(null, { status: 503 }) : session("ses_child", { parentID: "ses_parent" }),
    "GET /api/session/ses_unverified": () => new Response(null, { status: 503 }),
    "GET /api/session/ses_parent/message": () => ({ data: [...(canonical ? [fixture.launch] : []), fixture.stored, unrelated, unmatched], cursor: {} }),
    "GET /api/session/ses_child/message": () => ({ data: [], cursor: {} }),
    "GET /api/session/:id/inbox": () => ({ data: [] }),
    "GET /api/session/active": () => ({}),
    "GET /api/permission/request": () => scoped([]),
    "GET /api/form": () => scoped([]),
  });
  const adapter = new ChatAdapter({ provider: server.provider(), workspacePath: WORKSPACE, coalesceWindowMs: 0 });
  const lifetime = new AbortController();
  const workerId = canonical ? "task:v2:ses_parent:call_worker" : "task:v2:ses_parent:notification:msg_result";
  try {
    if (!cold) {
      const healthy = await adapter.history("ses_parent");
      expect(healthy.items).toContainEqual(expect.objectContaining({ id: workerId, type: "background_task", resultId: "msg_result" }));
      await adapter.stopEventPump();
      unavailable = true;
      void adapter.startEventPump();
    }
    const degraded = await adapter.history("ses_parent");
    expect(degraded.items.filter(item => item.id === "notice:msg_result" || item.id === workerId).map(item => item.id)).toEqual([cold ? "notice:msg_result" : workerId]);
    expect(degraded.items).toContainEqual(expect.objectContaining({ id: "notice:msg_unmatched", type: "notice" }));
    const existing = await adapter.subscribe("ses_parent", { signal: lifetime.signal });
    unavailable = false;
    const recovered = await adapter.history("ses_parent");
    const next = await adapter.subscribe("ses_parent", { signal: lifetime.signal });
    for (const snapshot of [recovered, next.snapshot]) {
      expect(snapshot.items.filter(item => item.id === "notice:msg_result" || item.type === "background_task" && item.resultId === "msg_result")).toEqual([
        expect.objectContaining({ id: workerId, type: "background_task", resultId: "msg_result", status: "completed" }),
      ]);
      expect(snapshot.items).toContainEqual(expect.objectContaining({ id: "notice:msg_unmatched", type: "notice" }));
      expect(snapshot.items).toContainEqual(expect.objectContaining({ id: "notice:msg_note", type: "notice", message: unrelated.text }));
    }
    existing.events.cancel();
    const delivered = [];
    for await (const event of existing.events) delivered.push(event);
    if (cold) expect(delivered).toContainEqual(expect.objectContaining({ type: "item.remove", itemId: "notice:msg_result" }));
    expect(delivered).not.toContainEqual(expect.objectContaining({ type: "item.remove", itemId: "notice:msg_unmatched" }));
    expect(server.calls.every(call => call.method === "GET")).toBe(true);
  } finally {
    lifetime.abort(); await adapter.dispose();
    expect(closed).toBe(opened);
  }
});

for (const eventOnly of [false, true]) for (const outcome of ["removed", "visible", "pending", "ordinary-synthetic", "ordinary-absent"] as const)
test(`fallback result source authority reconciles ordinary reconnect (${eventOnly ? "events" : "history"}/${outcome})`, async () => {
  const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
  const note = { id: "ordinary_note", type: "synthetic", text: "Keep the ordinary user note", time: { created: 2 } };
  let changed = false, blockReads = false, opened = 0, closed = 0;
  let wire!: ReadableStreamDefaultController<Uint8Array>, release!: () => void, delivered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), delivery = new Promise<void>(resolve => { delivered = resolve; });
  const server = fakeOpenCode({
    "GET /api/event": ({ signal }) => new Response(new ReadableStream<Uint8Array>({ start(controller) {
      wire = controller; opened++; controller.enqueue(new TextEncoder().encode('data: {"type":"server.connected","data":{}}\n\n'));
      signal.addEventListener("abort", () => { closed++; controller.close(); }, { once: true });
    } }), { headers: { "content-type": "text/event-stream" } }),
    "GET /api/session": () => ({ data: [], cursor: {} }),
    "GET /api/session/ses_parent": () => session("ses_parent"),
    "GET /api/session/ses_child": () => new Response(null, { status: 503 }),
    "GET /api/session/ses_parent/message": async () => {
      if (blockReads) await gate;
      return { data: [...(changed && outcome === "ordinary-absent" ? [] : [note]), ...(!changed && !eventOnly || changed && outcome === "visible" ? [fixture.stored]
        : changed && outcome === "ordinary-synthetic" ? [{ ...fixture.stored, metadata: {}, text: "Current unrelated synthetic text" }] : [])], cursor: {} };
    },
    "GET /api/session/:id/inbox": () => ({ data: changed && outcome === "pending" ? [fixture.pending] : [] }),
    "GET /api/session/active": () => ({}), "GET /api/permission/request": () => scoped([]), "GET /api/form": () => scoped([]),
  });
  const provider = server.provider(), events = provider.events.bind(provider);
  provider.events = async function* (signal) { for await (const event of events(signal)) { if (event.eventType === "diagnostic.delivery.complete") delivered(); yield event; } };
  const adapter = new ChatAdapter({ provider, workspacePath: WORKSPACE, coalesceWindowMs: eventOnly ? 10 : 0 });
  const lifetime = new AbortController();
  try {
    const initial = await adapter.history("ses_parent");
    const listener = await adapter.subscribe("ses_parent", { signal: lifetime.signal });
    if (eventOnly) {
      expect(initial.items.some(item => item.id === "notice:msg_result")).toBe(false);
      const observer = await adapter.subscribe("ses_parent", { signal: lifetime.signal });
      blockReads = true;
      const materialized = (async () => { for await (const event of observer.events) if (event.type === "item.upsert" && event.item.id === "notice:msg_result") return; throw new Error("Missing fallback notice"); })();
      for (const event of [
        { id: "evt_fallback", created: 41, type: "session.inbox.enqueued", data: { sessionID: "ses_parent", inboxID: fixture.pending.id, item: fixture.pending } },
        { id: "evt_fallback_repeat", created: 41, type: "session.inbox.enqueued", data: { sessionID: "ses_parent", inboxID: fixture.pending.id, item: fixture.pending } },
        { ...fixture.delivered, created: 42, data: { sessionID: "ses_parent", inboxID: fixture.pending.id } },
        { type: "diagnostic.delivery.complete", data: {} },
      ]) wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ ...event, location: { directory: WORKSPACE } })}\n\n`));
      await materialized; await delivery; observer.events.cancel();
    } else expect(initial.items).toContainEqual(expect.objectContaining({ id: "notice:msg_result", message: fixture.stored.text }));
    if (!eventOnly) expect(listener.snapshot.items).toContainEqual(expect.objectContaining({ id: "notice:msg_result", type: "notice" }));
    await adapter.stopEventPump(); changed = true; blockReads = false; release();
    const history = await adapter.history("ses_parent");
    const next = await adapter.subscribe("ses_parent", { signal: lifetime.signal }); next.events.cancel();
    for (const snapshot of [history, next.snapshot]) {
      if (outcome !== "ordinary-absent" || snapshot === next.snapshot) expect(snapshot.items).toContainEqual(expect.objectContaining({ id: "notice:ordinary_note", message: note.text }));
      const results = snapshot.items.filter(item => item.id === "notice:msg_result");
      if (outcome === "removed" || outcome === "ordinary-absent") expect(results).toEqual([]);
      else expect(results).toEqual([expect.objectContaining({ type: "notice", message: outcome === "ordinary-synthetic" ? "Current unrelated synthetic text" : fixture.stored.text })]);
      expect(snapshot.items.some(item => item.type === "background_task")).toBe(false);
    }
    listener.events.cancel(); const publications = []; for await (const event of listener.events) publications.push(event);
    if (outcome === "removed" || outcome === "ordinary-absent") expect(publications).toContainEqual(expect.objectContaining({ type: "item.remove", itemId: "notice:msg_result" }));
    expect(publications).not.toContainEqual(expect.objectContaining({ type: "item.remove", itemId: "notice:ordinary_note" }));
    expect(server.calls.every(call => call.method === "GET")).toBe(true);
  } finally { release(); lifetime.abort(); await adapter.dispose(); expect(closed).toBe(opened); }
});

for (const recovers of [false, true]) test(`same adapter removes reverted fallback result notices when ownership ${recovers ? "recovers" : "stays unavailable"}`, async () => {
  const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
  let reverted = false;
  const server = fakeOpenCode({
    "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"type":"server.connected","data":{}}\n\n'));
    } }), { headers: { "content-type": "text/event-stream" } }),
    "GET /api/session": () => ({ data: [session("ses_parent")], cursor: {} }),
    "GET /api/session/ses_parent": () => session("ses_parent", reverted ? { revert: { messageID: "msg_result" } } : {}),
    "GET /api/session/ses_child": () => reverted && recovers ? session("ses_child", { parentID: "ses_parent" }) : new Response(null, { status: 503 }),
    "GET /api/session/ses_parent/message": () => ({ data: [fixture.stored], cursor: {} }),
    "GET /api/session/ses_child/message": () => ({ data: [], cursor: {} }),
    "GET /api/session/:id/inbox": () => ({ data: [] }),
    "GET /api/session/active": () => ({}),
    "GET /api/permission/request": () => scoped([]),
    "GET /api/form": () => scoped([]),
  });
  const adapter = new ChatAdapter({ provider: server.provider(), workspacePath: WORKSPACE, coalesceWindowMs: 0 });
  const lifetime = new AbortController();
  try {
    const first = await adapter.history("ses_parent");
    expect(first.items).toEqual([expect.objectContaining({ id: "notice:msg_result", type: "notice", message: expect.stringContaining("Fixture checked.") })]);
    reverted = true;
    const history = await adapter.history("ses_parent");
    const subscription = await adapter.subscribe("ses_parent", { signal: lifetime.signal });
    expect(history.items).toEqual([]);
    expect(subscription.snapshot.items).toEqual([]);
    expect(server.calls.every(call => call.method === "GET")).toBe(true);
  } finally { lifetime.abort(); await adapter.dispose(); }
});

for (const paged of [false, true]) for (const canonical of [false, true]) for (const hidden of [false, true]) test(`degraded undo replacement ${hidden ? "removes hidden" : "retains visible"} settled ${canonical ? "canonical" : "notification"} workers (${paged ? "paged" : "complete"})`, async () => {
  const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
  const user = (id: string, created: number) => ({ ...STORED.find(message => message.type === "user"), id, sessionID: "ses_parent", text: id, time: { created } });
  const note = { id: "msg_old_note", type: "synthetic", text: "An unrelated removed transcript row", time: { created: 2 } };
  const work = [...(canonical ? [fixture.launch] : []), fixture.stored];
  let records = [user("msg_first", 1), note, ...(hidden ? [user("msg_later", 10), ...work] : [...work, user("msg_later", 70)])];
  let boundary: string | undefined, unavailable = false, opened = 0, closed = 0;
  const server = fakeOpenCode({
    "GET /api/event": ({ signal }) => new Response(new ReadableStream<Uint8Array>({ start(controller) {
      opened++;
      controller.enqueue(new TextEncoder().encode('data: {"type":"server.connected","data":{}}\n\n'));
      signal.addEventListener("abort", () => { closed++; controller.close(); }, { once: true });
    } }), { headers: { "content-type": "text/event-stream" } }),
    // This control owns its explicit history read. Unrelated startup inventory
    // must not race its initial accounting snapshot; live inventory has its own
    // public controls below and in the adapter suite.
    "GET /api/session": () => ({ data: [], cursor: {} }),
    "GET /api/session/ses_parent": () => session("ses_parent", boundary ? { revert: { messageID: boundary } } : {}),
    "GET /api/session/ses_child": () => unavailable ? new Response(null, { status: 503 }) : session("ses_child", { parentID: "ses_parent", cost: 0.125 }),
    "GET /api/session/ses_parent/message": () => ({ data: records, cursor: {} }),
    "GET /api/session/ses_child/message": () => ({ data: [], cursor: {} }),
    "GET /api/session/:id/inbox": () => ({ data: [] }),
    "GET /api/session/active": () => ({}),
    "GET /api/permission/request": () => scoped([]),
    "GET /api/form": () => scoped([]),
    "POST /api/session/ses_parent/revert/stage": ({ body }) => {
      boundary = (body as { messageID: string }).messageID;
      records = records.filter(message => message.id !== note.id);
      return { messageID: boundary };
    },
  });
  const provider = server.provider();
  const adapter = new ChatAdapter({ provider, workspacePath: WORKSPACE, coalesceWindowMs: 0 });
  const lifetime = new AbortController();
  const workerId = canonical ? "task:v2:ses_parent:call_worker" : "task:v2:ses_parent:notification:msg_result";
  try {
    const first = await adapter.history("ses_parent");
    const worker = first.items.find(item => item.id === workerId);
    expect(worker).toMatchObject({ type: "background_task", status: "completed", childConversationId: "ses_child", workerSession: { costUsd: 0.125 }, control: { available: false } });
    expect(first.items.some(item => item.id === "notice:msg_old_note")).toBe(true);
    const small = await provider.listMessages("ses_parent", { limit: 1 });
    expect(small.nextCursor).toBeDefined();
    if (paged) {
      // Exercise the public adapter seam without the provider's optional
      // whole-transcript optimization. Each page still comes from native IO.
      const listMessages = provider.listMessages.bind(provider);
      provider.listMessages = async (id, options) => {
        const { completeItems: _complete, ...page } = await listMessages(id, { ...options, limit: 1 });
        return page;
      };
    }
    // Reconnect retires healthy ownership reuse; the same projection survives.
    await adapter.stopEventPump();
    unavailable = true;
    void adapter.startEventPump();
    expect(await adapter.undo("ses_parent", "undo-degraded")).toMatchObject({ outcome: "changed", state: { staged: true } });
    const page = await provider.listMessages("ses_parent", { limit: 1 });
    expect(page.revertVisibility?.excludedItemIds).toContain("message:msg_later");
    if (hidden) expect(page.revertVisibility?.excludedItemIds).toContain(workerId);
    else expect(page.revertVisibility?.excludedItemIds).toEqual(["message:msg_later"]);
    const subscription = await adapter.subscribe("ses_parent", { signal: lifetime.signal });
    subscription.events.cancel();
    const after = subscription.snapshot.items;
    expect(after.some(item => item.id === "message:msg_later" || item.id === "notice:msg_old_note")).toBe(false);
    if (hidden) {
      expect(after.some(item => item.type === "background_task" || item.id === "notice:msg_result")).toBe(false);
    } else {
      expect(after.filter(item => item.id === workerId || item.id === "notice:msg_result")).toEqual([worker!]);
    }
    expect(server.calls.filter(call => call.method !== "GET").map(call => [call.method, call.path, call.body])).toEqual([
      ["POST", "/api/session/ses_parent/revert/stage", { messageID: "msg_later" }],
    ]);
  } finally {
    lifetime.abort(); await adapter.dispose();
    expect(closed).toBe(opened);
  }
});

test("fallback notice exclusions preserve visible native results after ownership recovers", async () => {
  const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
  const hidden = { ...fixture.stored, id: "msg_hidden_result" };
  const server = fakeOpenCode({
    "GET /api/session/ses_parent": () => session("ses_parent", { revert: { messageID: hidden.id } }),
    "GET /api/session/ses_child": () => session("ses_child", { parentID: "ses_parent" }),
    "GET /api/session/ses_parent/message": () => ({ data: [fixture.stored, hidden], cursor: {} }),
  });
  const provider = server.provider();
  try {
    const page = await provider.listMessages("ses_parent", { limit: 100 });
    expect(page.items).toContainEqual(expect.objectContaining({ type: "background_task", resultId: "msg_result", status: "completed" }));
    expect(page.revertVisibility?.excludedItemIds).toContain("notice:msg_hidden_result");
    expect(page.revertVisibility?.excludedItemIds).not.toContain("notice:msg_result");
    expect(server.calls.every(call => call.method === "GET")).toBe(true);
  } finally { await provider.dispose(); }
});

for (const canonical of [false, true]) for (const scenario of ["removed", "events-only", "visible-503", "reused-child", "reused-call", "inbox", ...(canonical ? ["running", "shell", "shell-notification", "shell-notification-visible", "shell-notification-reused", "shell-notification-inbox", "shell-notification-events", "delayed-inventory", "delayed-boundary"] : [])])
test(`missed staged source reconciles ${canonical ? "canonical" : "notification"} worker origins (${scenario})`, async () => {
  const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
  const user = (id: string, created: number) => ({ ...STORED.find(message => message.type === "user"), id, sessionID: "ses_parent", text: id, time: { created } });
  const shellResult = { id: "msg_shell_result", type: "synthetic", time: { created: 90 }, text: "<shell>\nShell finished\n</shell>", metadata: { source: "shell", shellID: "sh_fixture", state: "completed", exit: 0 } };
  const shellNotification = scenario.startsWith("shell-notification");
  const eventOnly = scenario === "events-only" || scenario === "shell-notification-events";
  const visibleShell = scenario === "shell-notification-visible";
  if (shellNotification) {
    // Membership is established by the earlier stored message, but this
    // result predates the invocation's immutable start: it has no call alias.
    fixture.shell.content[0].time.created = 100;
    fixture.shell.content[0].time.completed = 110;
  }
  const work = scenario === "shell" || shellNotification ? [fixture.shell, shellResult] : [...(canonical ? [fixture.launch] : []), ...(scenario === "running" ? [] : [fixture.stored])];
  let records = scenario === "visible-503" ? [user("msg_first", 1), ...work, user("msg_discarded", 70)]
    : visibleShell ? [user("msg_first", 1), ...work, user("msg_discarded", 120)]
    : [user("msg_first", 1), user("msg_discarded", 10), ...work];
  let wire!: ReadableStreamDefaultController<Uint8Array>, opened = 0, closed = 0, committed = false;
  let unavailable = false;
  let releaseReads!: () => void;
  const readGate = new Promise<void>(resolve => { releaseReads = resolve; });
  let blockReads = false;
  let holdInventory = false, inventoryEntered!: () => void, releaseInventory!: () => void, sourceEntered!: () => void;
  const inventoryCaptured = new Promise<void>(resolve => { inventoryEntered = resolve; });
  const inventoryGate = new Promise<void>(resolve => { releaseInventory = resolve; });
  const currentSourceRead = new Promise<void>(resolve => { sourceEntered = resolve; });
  let inventory: Promise<unknown> | undefined;
  const sources: string[][] = [];
  const server = fakeOpenCode({
    "GET /api/event": ({ signal }) => new Response(new ReadableStream<Uint8Array>({ start(controller) {
      wire = controller; opened++;
      controller.enqueue(new TextEncoder().encode('data: {"type":"server.connected","data":{}}\n\n'));
      signal.addEventListener("abort", () => { closed++; controller.close(); }, { once: true });
    } }), { headers: { "content-type": "text/event-stream" } }),
    "GET /api/session": () => ({ data: [], cursor: {} }),
    "GET /api/session/ses_parent": () => session("ses_parent"), // No reader can observe the staged boundary.
    "GET /api/session/ses_child": () => unavailable ? new Response(null, { status: 503 }) : session("ses_child", { parentID: "ses_parent", cost: 0.125 }),
    "GET /api/session/ses_parent/message": async () => {
      if (blockReads) await readGate;
      if (committed) { sources.push(records.map(message => message.id)); sourceEntered(); }
      return { data: eventOnly && !blockReads && !committed ? [] : records, cursor: {} };
    },
    "GET /api/session/ses_child/message": () => ({ data: [], cursor: {} }),
    "GET /api/session/:id/inbox": () => ({ data: committed && scenario === "inbox" ? [fixture.pending]
      : committed && scenario === "shell-notification-inbox" ? [{ id: shellResult.id, type: "synthetic", payload: { text: shellResult.text, metadata: shellResult.metadata }, time: shellResult.time }] : [] }),
    "GET /api/shell/sh_fixture": () => new Response(null, { status: 503 }),
    "GET /api/session/active": async () => {
      if (holdInventory) { inventoryEntered(); await inventoryGate; }
      return scenario === "running" ? { ses_child: {} } : {};
    },
    "GET /api/permission/request": () => scoped([]),
    "GET /api/form": () => scoped([]),
  });
  const provider = server.provider();
  const adapter = new ChatAdapter({ provider, workspacePath: WORKSPACE, coalesceWindowMs: 0 });
  const lifetime = new AbortController();
  const workerId = shellNotification ? "task:v2:ses_parent:notification:msg_shell_result" : scenario === "shell" ? "task:v2:ses_parent:call_shell" : canonical ? "task:v2:ses_parent:call_worker" : "task:v2:ses_parent:notification:msg_result";
  let holdBoundary = false;
  if (scenario === "delayed-boundary") {
    const boundary = provider.getHistoryRevertBoundary.bind(provider);
    provider.getHistoryRevertBoundary = async (...args) => {
      const marker = await boundary(...args);
      if (holdBoundary) { holdBoundary = false; inventoryEntered(); await inventoryGate; }
      return marker;
    };
  }
  let recoveryJoined!: () => void;
  const joined = new Promise<void>(resolve => { recoveryJoined = resolve; });
  if (scenario === "delayed-inventory") {
    const recover = provider.reconcileBackgroundTasks.bind(provider);
    provider.reconcileBackgroundTasks = (...args) => {
      const pending = recover(...args);
      if (committed) recoveryJoined();
      return pending;
    };
  }
  try {
    const first = await adapter.history("ses_parent");
    const existing = await adapter.subscribe("ses_parent", { signal: lifetime.signal });
    if (eventOnly) {
      expect(first.items).toEqual([]);
      const observer = await adapter.subscribe("ses_parent", { signal: lifetime.signal });
      blockReads = true;
      const settled = (async () => {
        for await (const event of observer.events) if (event.type === "item.upsert" && event.item.id === workerId
          && event.item.type === "background_task" && event.item.status === "completed" && (shellNotification || !canonical || event.item.workerSession?.costUsd === 0.125)) return;
        throw new Error("Expected settled worker and live accounting");
      })();
      const launch = shellNotification ? fixture.shell : fixture.launch;
      const pending = shellNotification ? { id: shellResult.id, type: "synthetic", payload: { text: shellResult.text, metadata: shellResult.metadata } } : fixture.pending;
      const events = [
        ...(canonical ? [{ id: "evt_launch", created: shellNotification ? 80 : 30, type: "session.message.content.updated", durable: { aggregateID: "ses_parent", seq: 1, version: 1 }, data: { sessionID: "ses_parent", messageID: launch.id, content: launch.content } }] : []),
        { id: "evt_result", created: shellNotification ? 90 : 41, type: "session.inbox.enqueued", data: { sessionID: "ses_parent", inboxID: pending.id, item: pending } },
        { ...fixture.delivered, created: shellNotification ? 91 : 42, data: { sessionID: "ses_parent", inboxID: pending.id } },
        ...(!shellNotification ? [{ id: "evt_usage", created: 43, type: "session.usage.updated", data: { sessionID: "ses_child", cost: 0.125 } }] : []),
      ];
      for (const event of events) wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ ...event, location: { directory: WORKSPACE } })}\n\n`));
      await settled;
    } else if (scenario === "shell" || shellNotification) {
      const result = first.items.find(item => item.id === workerId);
      expect(result).toMatchObject({ status: "completed", taskType: "shell", outputFile: "shell:sh_fixture" });
      if (shellNotification) { expect(result).not.toHaveProperty("toolUseId"); expect(result).not.toHaveProperty("childConversationId"); }
      const raw = await provider.listMessages("ses_parent", { limit: 1 });
      const origin = raw.workerOriginCoverage?.find(origin => origin.messageId === shellResult.id);
      expect(origin).toEqual({ messageId: shellResult.id, taskType: "shell", outputFile: "shell:sh_fixture" });
    }
    else expect(first.items).toContainEqual(expect.objectContaining({ id: workerId, status: scenario === "running" ? "running" : "completed", childConversationId: "ses_child", workerSession: { effort: null, costUsd: 0.125 } }));
    if (scenario === "visible-503" || scenario.startsWith("reused-")) {
      await adapter.stopEventPump(); unavailable = true; void adapter.startEventPump();
      await adapter.history("ses_parent");
    }
    if (scenario === "running") expect((await provider.reconcileBackgroundTasks("ses_parent"))[0]).toMatchObject({ activity: { kind: "working" }, control: { available: true } });
    if (scenario.startsWith("delayed-")) {
      holdInventory = scenario === "delayed-inventory";
      holdBoundary = scenario === "delayed-boundary";
      inventory = provider.reconcileBackgroundTasks("ses_parent").catch(error => error);
      await inventoryCaptured;
    }
    const replaced = (async () => {
      for await (const event of existing.events) if (event.type === "resync" && event.reason === "conversation-rewritten") return;
      throw new Error("Expected native replacement resync");
    })();
    records = [user("msg_first", 1), user("msg_replacement", 80)];
    if (scenario === "visible-503" || visibleShell) records.splice(1, 0, ...work);
    if (scenario === "shell-notification-reused" || scenario === "shell-notification-inbox") {
      const launch = structuredClone(fixture.shell);
      launch.id = "msg_reused_shell"; launch.time.created = 200;
      launch.content[0].id = "new_shell_call";
      launch.content[0].time.created = 200; launch.content[0].time.completed = 210;
      records.push(launch);
    }
    if (scenario.startsWith("reused-")) {
      const launch = structuredClone(fixture.launch);
      launch.id = "msg_new_launch"; launch.time.created = 90;
      launch.content[0].time.created = 90;
      if (scenario === "reused-child") launch.content[0].id = "new_call";
      records.push(launch);
    }
    const expectedSource = records.map(message => message.id);
    committed = true;
    releaseReads();
    for (const [type, data] of [
      ["session.revert.staged", { sessionID: "ses_parent", revert: { messageID: "msg_discarded" } }],
      ["session.revert.committed", { sessionID: "ses_parent", to: "msg_discarded" }],
    ]) wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ id: type, created: 1000, type, data, location: { directory: WORKSPACE } })}\n\n`));
    if (scenario === "delayed-inventory") { await currentSourceRead; await joined; releaseInventory(); }
    if (scenario === "delayed-boundary") { await currentSourceRead; releaseInventory(); }
    await replaced;
    if (scenario.startsWith("delayed-")) expect(await inventory).toBeInstanceOf(Error);
    const page = await provider.listMessages("ses_parent", { limit: 1 });
    expect(page.revertVisibility).toMatchObject({ boundaryId: null, excludedItemIds: [] });
    expect(sources.length).toBeGreaterThan(0);
    expect(sources.every(ids => JSON.stringify(ids) === JSON.stringify(expectedSource))).toBe(true);
    // Raw coverage spans the full source even though the requested page has
    // one message, and remains present when ownership enrichment is absent.
    expect(page.workerOriginCoverage?.some(origin => origin.messageId === "msg_result")).toBe(scenario === "visible-503");
    if (canonical) expect(page.workerOriginCoverage?.some(origin => origin.messageId === "msg_launch" && origin.toolUseId === "call_worker")).toBe(scenario === "visible-503");
    const next = await adapter.subscribe("ses_parent", { signal: lifetime.signal });
    next.events.cancel();
    const workers = next.snapshot.items.filter(item => item.type === "background_task");
    if (["visible-503", "inbox", "running"].includes(scenario)) {
      expect(workers).toHaveLength(1);
      expect(workers).toContainEqual(expect.objectContaining({ status: scenario === "running" ? "running" : "completed", childConversationId: "ses_child" }));
      if (scenario === "running") expect(workers[0]).toMatchObject({ stateUncertain: true, activity: { kind: "unavailable" }, control: { available: false } });
      else expect(workers[0]).toMatchObject({ workerSession: { costUsd: 0.125 } });
    } else if (shellNotification) {
      const reports = workers.filter(item => item.resultId === shellResult.id);
      if (visibleShell || scenario === "shell-notification-inbox") {
        expect(reports).toHaveLength(1);
        expect(reports[0]).toMatchObject({ id: workerId, taskType: "shell", status: "completed", summary: "Shell finished", outputFile: "shell:sh_fixture", control: { available: false } });
      } else expect(reports).toEqual([]);
    } else expect(workers).toEqual([]);
    expect(next.snapshot).not.toHaveProperty("workerOriginCoverage");
    expect(next.snapshot.items.some(item => item.id === "message:msg_discarded")).toBe(false);
    expect(server.calls.every(call => call.method === "GET")).toBe(true);
  } finally { releaseReads(); releaseInventory(); lifetime.abort(); await inventory; await adapter.dispose(); expect(closed).toBe(opened); }
});

for (const canonical of [false, true]) for (const outcome of ["removed", "visible-503", "running", "inbox"] as const)
test(`ordinary reconnect reconciles committed worker origins (${canonical}/${outcome})`, async () => {
  const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
  const prompt = (id: string, created: number) => ({ id, type: "user", text: id, time: { created } });
  const work = [...(canonical || outcome === "running" ? [fixture.launch] : []), ...(outcome === "running" ? [] : [fixture.stored])];
  let records = [prompt("first", 1), ...work, prompt("later", 70)], committed = false, opened = 0, closed = 0;
  const server = fakeOpenCode({
    "GET /api/event": ({ signal }) => new Response(new ReadableStream<Uint8Array>({ start(controller) {
      opened++; controller.enqueue(new TextEncoder().encode('data: {"type":"server.connected","data":{}}\n\n'));
      signal.addEventListener("abort", () => { closed++; controller.close(); }, { once: true });
    } }), { headers: { "content-type": "text/event-stream" } }),
    "GET /api/session": () => ({ data: [], cursor: {} }),
    "GET /api/session/ses_parent": () => session("ses_parent"),
    "GET /api/session/ses_child": () => committed && outcome === "visible-503" ? new Response(null, { status: 503 }) : session("ses_child", { parentID: "ses_parent", cost: 0.125 }),
    "GET /api/session/ses_parent/message": () => ({ data: records, cursor: {} }),
    "GET /api/session/ses_child/message": () => ({ data: [], cursor: {} }),
    "GET /api/session/:id/inbox": () => ({ data: committed && outcome === "inbox" ? [fixture.pending] : [] }),
    "GET /api/session/active": () => outcome === "running" ? { ses_child: {} } : {},
    "GET /api/permission/request": () => scoped([]), "GET /api/form": () => scoped([]),
  });
  const provider = server.provider(), adapter = new ChatAdapter({ provider, workspacePath: WORKSPACE, coalesceWindowMs: 0 });
  const lifetime = new AbortController();
  try {
    const first = await adapter.history("ses_parent");
    expect(first.items.filter(item => item.type === "background_task")).toHaveLength(1);
    const listener = await adapter.subscribe("ses_parent", { signal: lifetime.signal });
    await adapter.stopEventPump();
    // Another client staged and committed while Uatu could observe neither
    // event. Only the complete current transcript remains as authority.
    committed = true; records = [prompt("first", 1), ...(outcome === "visible-503" ? work : []), prompt("replacement", 80)];
    const history = await adapter.history("ses_parent", { limit: 1 });
    const next = await adapter.subscribe("ses_parent", { signal: lifetime.signal }); next.events.cancel();
    const workers = (items: typeof history.items) => items.filter(item => item.type === "background_task");
    expect(workers(history.items)).toHaveLength(outcome === "removed" ? 0 : 1);
    expect(workers(next.snapshot.items)).toEqual(workers(history.items));
    if (outcome === "removed") {
      // The already-connected subscriber must learn the deletion too.
      const event = await listener.events[Symbol.asyncIterator]().next();
      expect(event.value).toMatchObject({ type: "item.remove", itemId: workers(first.items)[0]!.id });
      const upsert = await listener.events[Symbol.asyncIterator]().next();
      expect(upsert.value).toMatchObject({ type: "item.upsert", item: { id: "message:replacement" } });
      const resync = await listener.events[Symbol.asyncIterator]().next();
      expect(resync.value).toMatchObject({ type: "resync", reason: "conversation-rewritten" });
    } else expect(workers(next.snapshot.items)[0]).toMatchObject({ childConversationId: "ses_child", status: outcome === "running" ? "running" : "completed" });
    expect(server.calls.every(call => call.method === "GET")).toBe(true);
  } finally { lifetime.abort(); await adapter.dispose(); expect(closed).toBe(opened); }
});

for (const ownership of ["healthy", "unavailable", "foreign-parent", "foreign-workspace"] as const)
for (const hidden of [false, true]) for (const commit of [false, true])
test(`worker source authority separates launch/report (${ownership}/${hidden ? "hidden-report" : "visible-report"}/${commit ? "commit" : "undo"})`, async () => {
  const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
  const user = (id: string, created: number) => ({ ...STORED.find(message => message.type === "user"), id, sessionID: "ses_parent", text: id, time: { created } });
  let records = hidden ? [user("msg_first", 1), fixture.launch, user("msg_later", 30), fixture.stored]
    : [user("msg_first", 1), fixture.launch, fixture.stored, user("msg_later", 70)];
  let boundary: string | undefined, changed = false, contradicted = false, childReadsAfterContradiction = 0, opened = 0, closed = 0;
  let wire!: ReadableStreamDefaultController<Uint8Array>;
  const server = fakeOpenCode({
    "GET /api/event": ({ signal }) => new Response(new ReadableStream<Uint8Array>({ start(controller) {
      wire = controller; opened++; controller.enqueue(new TextEncoder().encode('data: {"type":"server.connected","data":{}}\n\n'));
      signal.addEventListener("abort", () => { closed++; controller.close(); }, { once: true });
    } }), { headers: { "content-type": "text/event-stream" } }),
    "GET /api/session": () => ({ data: [], cursor: {} }),
    "GET /api/session/ses_parent": () => session("ses_parent", boundary ? { revert: { messageID: boundary } } : {}),
    "GET /api/session/ses_child": () => {
      if (changed && ownership === "unavailable") return new Response(null, { status: 503 });
      contradicted ||= changed && ownership.startsWith("foreign-");
      return session("ses_child", { parentID: changed && ownership === "foreign-parent" ? "ses_other" : "ses_parent", cost: 0.125,
        ...(changed && ownership === "foreign-workspace" ? { location: { directory: "/foreign" } } : {}) });
    },
    "GET /api/session/ses_other": () => session("ses_other"),
    "GET /api/session/ses_other/message": () => ({ data: [
      { ...fixture.launch, id: "msg_other_launch", sessionID: "ses_other", content: [{ ...fixture.launch.content[0], id: "other_call" }] },
      { ...fixture.stored, id: "msg_other_result", sessionID: "ses_other" },
    ], cursor: {} }),
    "GET /api/session/ses_parent/message": () => ({ data: records, cursor: {} }),
    "GET /api/session/ses_child/message": () => { if (contradicted) childReadsAfterContradiction++; return { data: [], cursor: {} }; },
    "GET /api/session/:id/inbox": () => ({ data: [] }), "GET /api/session/active": () => ({}),
    "GET /api/permission/request": () => scoped([]), "GET /api/form": () => scoped([]),
    "POST /api/session/ses_parent/revert/stage": ({ body }) => { boundary = (body as { messageID: string }).messageID; return { messageID: boundary }; },
  });
  const provider = server.provider();
  const adapter = new ChatAdapter({ provider, workspacePath: WORKSPACE, coalesceWindowMs: 0 });
  const lifetime = new AbortController();
  const staleOwner = new AsyncLocalStorage<boolean>();
  let holdNegative = false, negativeEntered!: () => void, releaseNegative!: () => void;
  const negativeCaptured = new Promise<void>(resolve => { negativeEntered = resolve; });
  const negativeGate = new Promise<void>(resolve => { releaseNegative = resolve; });
  let sourceUpdated!: () => void;
  const sourceReady = new Promise<void>(resolve => { sourceUpdated = resolve; });
  const events = provider.events.bind(provider);
  provider.events = async function* (signal) {
    for await (const event of events(signal)) { if (event.eventType === "session.updated") sourceUpdated(); yield event; }
  };
  let stale: ReturnType<ChatAdapter["history"]> | undefined;
  const listMessages = provider.listMessages.bind(provider);
  provider.listMessages = async (...args) => {
    const page = await listMessages(...args);
    if (holdNegative && staleOwner.getStore() && args[0] === "ses_parent") { holdNegative = false; negativeEntered(); await negativeGate; }
    return page;
  };
  try {
    expect((await adapter.history("ses_parent")).items).toContainEqual(expect.objectContaining({ id: "task:v2:ses_parent:call_worker", resultId: "msg_result", status: "completed" }));
    await adapter.stopEventPump(); changed = true; void adapter.startEventPump();
    if (commit) {
      const existing = await adapter.subscribe("ses_parent", { signal: lifetime.signal });
      const replaced = (async () => { for await (const event of existing.events) if (event.type === "resync") return; throw new Error("Missing replacement resync"); })();
      records = records.slice(0, records.findIndex(message => message.id === "msg_later"));
      for (const [type, data] of [["session.revert.staged", { sessionID: "ses_parent", revert: { messageID: "msg_later" } }], ["session.revert.committed", { sessionID: "ses_parent", to: "msg_later" }]])
        wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ id: type, created: 1000, type, data, location: { directory: WORKSPACE } })}\n\n`));
      await replaced;
    } else await adapter.undo("ses_parent", "source-authority");
    const next = await adapter.subscribe("ses_parent", { signal: lifetime.signal }); next.events.cancel();
    const items = next.snapshot.items;
    if (ownership.startsWith("foreign-")) {
      expect(childReadsAfterContradiction).toBe(0);
      expect(items.some(item => (item.type === "tool" || item.type === "background_task") && item.childConversationId === "ses_child")).toBe(false);
      expect(items.filter(item => item.type === "notice" && item.id === "notice:msg_result")).toHaveLength(hidden ? 0 : 1);
      if (!hidden) {
        if (ownership === "foreign-parent") {
          const other = await adapter.history("ses_other");
          expect(other.items).toContainEqual(expect.objectContaining({ type: "background_task", childConversationId: "ses_child", resultId: "msg_other_result" }));
          const scoped = await provider.listMessages("ses_parent", { limit: 100, signal: lifetime.signal });
          expect(scoped.workerAssociationContradictions).toContain("ses_child");
        }
        holdNegative = true;
        stale = staleOwner.run(true, () => adapter.history("ses_parent", { limit: 97 }));
        await negativeCaptured;
        changed = false; contradicted = false;
        if (ownership === "foreign-parent") {
          // The prior healthy owner lookup is cached for the other parent.
          // Native membership change invalidates that cache before refresh.
          wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ id: "evt_owner_restored", created: 1100, type: "session.updated", location: { directory: WORKSPACE }, data: { sessionID: "ses_child", parentID: "ses_parent", title: "Child", location: { directory: WORKSPACE } } })}\n\n`));
          await sourceReady;
        }
        const recovered = await adapter.history("ses_parent", { limit: 98 });
        expect(recovered.items).toContainEqual(expect.objectContaining({ type: "background_task", childConversationId: "ses_child", resultId: "msg_result" }));
        releaseNegative();
        expect((await stale).items).toContainEqual(expect.objectContaining({ type: "background_task", childConversationId: "ses_child", resultId: "msg_result" }));
        const after = await adapter.subscribe("ses_parent", { signal: lifetime.signal }); after.events.cancel();
        expect(after.snapshot.items.filter(item => item.type === "background_task" && item.resultId === "msg_result")).toHaveLength(1);
        expect(after.snapshot.items.some(item => item.id === "notice:msg_result")).toBe(false);
      }
    } else {
      const worker = items.find(item => item.id === "task:v2:ses_parent:call_worker");
      expect(worker).toBeDefined();
      if (hidden) {
        expect(worker).not.toHaveProperty("resultId"); expect(worker).not.toHaveProperty("summary");
        expect(worker).not.toHaveProperty("terminalReportedAt"); expect(worker).not.toHaveProperty("usage");
        // This fixture's price is the child's independently reported session
        // spend, not report usage. A later fresh attribution may still place
        // that known spend on the visible launch; it is not reverted to zero.
        if (worker?.type === "background_task" && worker.workerSession) expect(worker.workerSession.costUsd).toBe(0.125);
        expect(worker).toMatchObject({ status: "running", stateUncertain: true, control: { available: false } });
      } else expect(worker).toMatchObject({ resultId: "msg_result", status: "completed", summary: "Fixture checked." });
    }
    expect(items.some(item => item.id === "message:msg_later")).toBe(false);
  } finally { releaseNegative(); lifetime.abort(); await stale?.catch(() => undefined); await adapter.dispose(); expect(closed).toBe(opened); }
});

for (const read of ["history", "undo"] as const) for (const source of ["inbox", "live"] as const)
for (const outcome of ["foreign-parent", "foreign-workspace", "healthy", "unavailable", "successor", "cancel"] as const)
test(`recovered source authority reaches final parent publication (${read}/${source}/${outcome})`, async () => {
  const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
  const prompt = (id: string, created: number) => ({ id, type: "user", text: id, time: { created } });
  let available = false, mode = "healthy", committed = false, nativeLaunch = false, opened = 0, closed = 0, foreignReads = 0, accountingFinished = false, childPages = 0;
  const server = fakeOpenCode({
    "GET /api/event": ({ signal }) => new Response(new ReadableStream<Uint8Array>({ start(controller) {
      opened++; controller.enqueue(new TextEncoder().encode('data: {"type":"server.connected","data":{}}\n\n'));
      signal.addEventListener("abort", () => { closed++; controller.close(); }, { once: true });
    } }), { headers: { "content-type": "text/event-stream" } }),
    "GET /api/session": () => ({ data: [], cursor: {} }),
    "GET /api/session/ses_parent": () => session("ses_parent"),
    "GET /api/session/ses_child": () => mode === "unavailable" ? new Response(null, { status: 503 }) : session("ses_child", {
      parentID: mode === "foreign-parent" ? "ses_other" : "ses_parent", cost: 0.125,
      ...(mode === "foreign-workspace" ? { location: { directory: "/foreign" } } : {}),
    }),
    "GET /api/session/ses_parent/message": () => ({ data: [prompt("first", 1), ...(nativeLaunch ? [fixture.launch] : []), ...(!committed ? [prompt("later", 70)] : [])], cursor: {} }),
    "GET /api/session/ses_child/message": () => { if (mode.startsWith("foreign-")) foreignReads++; return { data: [], cursor: {} }; },
    "GET /api/session/:id/inbox": () => ({ data: available && source === "inbox" ? [fixture.pending] : [] }),
    "GET /api/session/active": () => available && source === "live" ? { ses_child: {} } : {},
    "GET /api/permission/request": () => scoped([]), "GET /api/form": () => scoped([]),
    // Model an immediately committed stage by another client: the replacement
    // read never observes a staged marker or a raw result/launcher for inbox.
    "POST /api/session/ses_parent/revert/stage": ({ body }) => { committed = true; return { messageID: (body as { messageID: string }).messageID }; },
  });
  const provider = server.provider(), owner = new AsyncLocalStorage<boolean>();
  const recover = provider.reconcileBackgroundTasks.bind(provider);
  let switchSource = false, recovered = false, recoveryCalls = 0;
  provider.reconcileBackgroundTasks = (...args) => owner.run(false, async () => {
    const fresh = switchSource && source === "live";
    if (switchSource) { switchSource = false; nativeLaunch = source === "live"; }
    const tasks = await recover(args[0], { ...args[1], ...(fresh ? { fresh: true } : {}) });
    if (available) { recoveryCalls++; recovered ||= tasks.some(task => task.childConversationId === "ses_child"); }
    return tasks;
  });
  const list = provider.listMessages.bind(provider);
  provider.listMessages = async (...args) => {
    const page = await list(...args);
    if (owner.getStore() && args[0] === "ses_child") {
      childPages++; args[1].signal?.addEventListener("abort", () => { accountingFinished = true; }, { once: true });
    }
    return page;
  };
  let armed = false, entered!: () => void, release!: () => void;
  const captured = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const boundary = provider.getHistoryRevertBoundary.bind(provider);
  provider.getHistoryRevertBoundary = async (...args) => {
    const marker = await boundary(...args);
    if (armed && owner.getStore() && args[0] === "ses_parent") { armed = false; entered(); await gate; }
    return marker;
  };
  const adapter = new ChatAdapter({ provider, workspacePath: WORKSPACE, coalesceWindowMs: 0 });
  let pending: Promise<unknown> | undefined;
  try {
    expect((await adapter.history("ses_parent")).items.some(item => item.type === "background_task")).toBe(false);
    available = true; switchSource = true; armed = true;
    pending = owner.run(true, () => read === "history" ? adapter.history("ses_parent", { limit: 97 }) : adapter.undo("ses_parent", "recovered-source"));
    await captured;
    expect(recovered).toBe(true); expect(childPages).toBeGreaterThan(0); expect(accountingFinished).toBe(true);
    const callsAtGate = recoveryCalls;
    mode = outcome === "cancel" ? "foreign-parent" : outcome;
    await provider.getSession("ses_child").catch(error => { if (outcome !== "unavailable") throw error; });
    if (outcome === "successor") {
      mode = "foreign-parent"; await provider.getSession("ses_child");
      mode = "healthy"; await provider.getSession("ses_child");
      expect((await adapter.history("ses_parent", { limit: 98 })).items).toContainEqual(expect.objectContaining({ type: "background_task", childConversationId: "ses_child" }));
    }
    if (outcome === "cancel") await adapter.stopEventPump();
    release(); const result = await pending.catch(error => error);
    if (outcome === "cancel") {
      if (read === "history") expect(result).toBeInstanceOf(Error);
      mode = "healthy"; await adapter.history("ses_parent");
    } else expect(result).not.toBeInstanceOf(Error);
    const next = await adapter.subscribe("ses_parent"); next.events.cancel();
    const foreign = outcome.startsWith("foreign-");
    const assert = (items: import("../../types").ConversationItem[]) => {
      expect(items.some(item => (item.type === "background_task" || item.type === "tool") && item.childConversationId === "ses_child")).toBe(!foreign);
      if (!foreign) expect(items).toContainEqual(expect.objectContaining({ type: "background_task", workerSession: expect.objectContaining({ costUsd: 0.125 }) }));
    };
    assert(next.snapshot.items); if (read === "history" && outcome !== "cancel") assert((result as Awaited<ReturnType<ChatAdapter["history"]>>).items);
    expect(foreignReads).toBe(0);
    if (outcome === "healthy" || outcome === "unavailable") expect(recoveryCalls).toBe(callsAtGate);
  } finally { release(); await pending?.catch(() => undefined); await adapter.dispose(); expect(closed).toBe(opened); }
});

for (const foreign of ["parent", "workspace"] as const) for (const direction of ["revoke", "restore", "pending-revoke", "pending-confirm", "pending-stable"] as const)
for (const observation of direction === "pending-stable" ? ["ordinary"] as const : ["ordinary", "lifecycle"] as const)
test(`${observation} session observation fences final replacement (${foreign}/${direction})`, async () => {
  const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
  const user = (id: string, created: number) => ({ ...STORED.find(message => message.type === "user"), id, sessionID: "ses_parent", text: id, time: { created } });
  let negative = false, boundary: string | undefined, foreignReads = 0, opened = 0, closed = 0;
  let unavailable = false, cost = 0.125, ownedReads = 0;
  let wire!: ReadableStreamDefaultController<Uint8Array>;
  const server = fakeOpenCode({
    "GET /api/event": ({ signal }) => new Response(new ReadableStream<Uint8Array>({ start(controller) {
      wire = controller; opened++; controller.enqueue(new TextEncoder().encode('data: {"type":"server.connected","data":{}}\n\n'));
      signal.addEventListener("abort", () => { closed++; controller.close(); }, { once: true });
    } }), { headers: { "content-type": "text/event-stream" } }),
    "GET /api/session": () => ({ data: [], cursor: {} }),
    "GET /api/session/ses_parent": () => session("ses_parent", boundary ? { revert: { messageID: boundary } } : {}),
    "GET /api/session/ses_child": () => unavailable ? new Response(null, { status: 503 }) : session("ses_child", { parentID: negative && foreign === "parent" ? "ses_other" : "ses_parent", cost,
      ...(negative && foreign === "workspace" ? { location: { directory: "/foreign" } } : {}) }),
    "GET /api/session/ses_parent/message": () => ({ data: [user("first", 1), fixture.launch, fixture.stored, user("later", 70)], cursor: {} }),
    "GET /api/session/ses_child/message": () => { if (negative) foreignReads++; return { data: [], cursor: {} }; },
    "GET /api/session/:id/inbox": () => ({ data: [] }), "GET /api/session/active": () => ({}),
    "GET /api/permission/request": () => scoped([]), "GET /api/form": () => scoped([]),
    "POST /api/session/ses_parent/revert/stage": ({ body }) => { boundary = (body as { messageID: string }).messageID; return { messageID: boundary }; },
  });
  const provider = server.provider(), owner = new AsyncLocalStorage<boolean>();
  const list = provider.listMessages.bind(provider);
  provider.listMessages = (...args) => { if (owner.getStore() && args[0] === "ses_parent") ownedReads++; return list(...args); };
  let observed!: () => void;
  const lifecycleObserved = new Promise<void>(resolve => { observed = resolve; });
  const events = provider.events.bind(provider);
  provider.events = async function* (signal) { for await (const event of events(signal)) { if (event.eventType === "session.updated") observed(); yield event; } };
  const recover = provider.reconcileBackgroundTasks.bind(provider);
  provider.reconcileBackgroundTasks = (...args) => owner.run(false, () => recover(...args));
  let entered!: () => void, release!: () => void, armed = false;
  const captured = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const getBoundary = provider.getHistoryRevertBoundary.bind(provider);
  provider.getHistoryRevertBoundary = async (...args) => {
    const marker = await getBoundary(...args);
    if (armed && owner.getStore() && args[0] === "ses_parent") { armed = false; entered(); await gate; }
    return marker;
  };
  const adapter = new ChatAdapter({ provider, workspacePath: WORKSPACE, coalesceWindowMs: 0 });
  const lifetime = new AbortController();
  let mutation: ReturnType<ChatAdapter["undo"]> | undefined;
  try {
    await adapter.history("ses_parent"); await adapter.stopEventPump();
    negative = direction === "restore"; unavailable = direction.startsWith("pending-"); void adapter.startEventPump(); armed = true;
    mutation = owner.run(true, () => adapter.undo("ses_parent", "ordinary-observation"));
    await captured;
    negative = direction === "revoke" || direction === "pending-revoke";
    unavailable = direction === "pending-stable";
    if (direction === "pending-confirm") cost = 0.25;
    if (observation === "ordinary") await provider.getSession("ses_child").catch(error => { if (!unavailable) throw error; }); // Not verifiedChild().
    else {
      const info = session("ses_child", { parentID: negative && foreign === "parent" ? "ses_other" : "ses_parent",
        ...(negative && foreign === "workspace" ? { location: { directory: "/foreign" } } : {}) });
      wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ id: "evt_ownership", type: "session.updated", created: 1000, location: { directory: WORKSPACE }, data: { info } })}\n\n`));
      await lifecycleObserved;
    }
    release(); await mutation;
    const next = await adapter.subscribe("ses_parent", { signal: lifetime.signal }); next.events.cancel();
    expect(foreignReads).toBe(0);
    if (direction === "revoke" || direction === "pending-revoke") {
      expect(next.snapshot.items.some(item => (item.type === "tool" || item.type === "background_task") && item.childConversationId === "ses_child")).toBe(false);
      expect(next.snapshot.items.filter(item => item.id === "notice:msg_result")).toHaveLength(1);
    } else {
      expect(next.snapshot.items).toContainEqual(expect.objectContaining({ type: "background_task", childConversationId: "ses_child", resultId: "msg_result" }));
      if (direction === "pending-confirm") expect(next.snapshot.items.find(item => item.type === "background_task")?.workerSession?.costUsd).toBe(0.25);
      if (direction === "pending-stable") expect(ownedReads).toBe(1);
    }
  } finally { release(); lifetime.abort(); await mutation?.catch(() => undefined); await adapter.dispose(); expect(closed).toBe(opened); }
});

describe("native reversible replacement coverage", () => {
  function setup(options: { gate?: boolean; running?: boolean; cold?: boolean } = {}) {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    const user = (id: string, created: number) => ({ ...STORED.find(message => message.type === "user"), id, sessionID: "ses_parent", text: id, time: { created } });
    const state = { boundary: undefined as string | undefined, unavailable: options.cold ?? false,
      records: [user("msg_first", 1), fixture.launch, ...(options.running ? [] : [fixture.stored]), user("msg_later", 70)] as Array<Record<string, unknown>> };
    let release!: () => void, entered!: (signal: AbortSignal) => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const captured = new Promise<AbortSignal>(resolve => { entered = resolve; });
    let armed = false, parentReads = 0, opened = 0, closed = 0;
    // Pin the gate to the public mutation, not an ambient inventory read.
    const mutationReads = new AsyncLocalStorage<boolean>();
    const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
    const server = fakeOpenCode({
      "GET /api/event": ({ signal }) => new Response(new ReadableStream<Uint8Array>({ start(controller) {
        opened++; streams.add(controller);
        controller.enqueue(new TextEncoder().encode('data: {"type":"server.connected","data":{}}\n\n'));
        signal.addEventListener("abort", () => { closed++; streams.delete(controller); controller.close(); }, { once: true });
      } }), { headers: { "content-type": "text/event-stream" } }),
      "GET /api/session": () => ({ data: [session("ses_parent")], cursor: {} }),
      "GET /api/session/ses_parent": async ({ signal }) => {
        const info = session("ses_parent", state.boundary ? { revert: { messageID: state.boundary } } : {});
        if (armed && mutationReads.getStore() && options.gate && ++parentReads === 2) {
          armed = false; entered(signal); await gate;
        }
        return info;
      },
      "GET /api/session/ses_child": () => state.unavailable ? new Response(null, { status: 503 }) : session("ses_child", { parentID: "ses_parent", cost: 0.125 }),
      "GET /api/session/ses_parent/message": () => ({ data: [...state.records], cursor: {} }),
      "GET /api/session/ses_child/message": () => ({ data: [], cursor: {} }),
      "GET /api/session/:id/inbox": () => ({ data: [] }),
      "GET /api/session/active": () => ({}),
      "GET /api/permission/request": () => scoped([]),
      "GET /api/form": () => scoped([]),
      "POST /api/session/ses_parent/revert/stage": ({ body }) => {
        state.boundary = (body as { messageID: string }).messageID;
        armed = true; parentReads = 0;
        return { messageID: state.boundary };
      },
    });
    const provider = server.provider();
    const adapter = new ChatAdapter({ provider, workspacePath: WORKSPACE, coalesceWindowMs: 0 });
    const lifetime = new AbortController();
    return { state, server, provider, adapter, captured, release, lifetime,
      undo(requestId: string) { return mutationReads.run(true, () => adapter.undo("ses_parent", requestId)); },
      finish() {
        state.records.splice(state.records.length - 1, 0, fixture.stored);
        const events = [
          { id: "evt_launch", created: 30, type: "session.message.content.updated", durable: { aggregateID: "ses_parent", seq: 1, version: 1 }, data: { sessionID: "ses_parent", messageID: fixture.launch.id, content: fixture.launch.content } },
          fixture.terminal,
          { id: "evt_result", created: 41, type: "session.inbox.enqueued", data: { sessionID: "ses_parent", inboxID: fixture.pending.id, item: fixture.pending } },
          fixture.delivered,
        ];
        for (const event of events) for (const stream of streams) stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ ...event, location: { directory: WORKSPACE } })}\n\n`));
      },
      async dispose() {
        release(); lifetime.abort(); await adapter.dispose();
        expect(closed).toBe(opened);
        expect(server.calls.filter(call => call.method !== "GET").map(call => [call.method, call.path])).toEqual([["POST", "/api/session/ses_parent/revert/stage"]]);
      },
    };
  }

  test("undo supersedes a cold fallback when ownership recovers", async () => {
    const context = setup({ cold: true });
    const { adapter, state, lifetime } = context;
    try {
      expect((await adapter.history("ses_parent")).items.some(item => item.id === "notice:msg_result")).toBe(true);
      state.unavailable = false;
      const existing = await adapter.subscribe("ses_parent", { signal: lifetime.signal });
      await adapter.undo("ses_parent", "recover-undo");
      const next = await adapter.subscribe("ses_parent", { signal: lifetime.signal });
      next.events.cancel(); existing.events.cancel();
      expect(next.snapshot.items.filter(item => item.id === "notice:msg_result" || item.type === "background_task")).toEqual([
        expect.objectContaining({ id: "task:v2:ses_parent:call_worker", status: "completed", resultId: "msg_result", childConversationId: "ses_child", workerSession: { effort: null, costUsd: 0.125 } }),
      ]);
      const delivered = [];
      for await (const event of existing.events) delivered.push(event);
      expect(delivered).toContainEqual(expect.objectContaining({ type: "item.remove", itemId: "notice:msg_result" }));
    } finally { await context.dispose(); }
  });

  test("undo rereads a captured view when its native boundary changes", async () => {
    const context = setup({ gate: true });
    const { adapter, state, captured, release, lifetime } = context;
    let mutation: ReturnType<ChatAdapter["undo"]> | undefined;
    try {
      await adapter.history("ses_parent");
      mutation = context.undo("changed-context");
      await captured;
      // Another client's native boundary now hides the earlier worker too.
      state.boundary = "msg_first";
      release();
      expect(await mutation).toMatchObject({ state: { staged: true, canUndo: false } });
      const next = await adapter.subscribe("ses_parent", { signal: lifetime.signal });
      next.events.cancel();
      expect(next.snapshot.items).toEqual([]);
    } finally { release(); await mutation; await context.dispose(); }
  });

  test("cancelled undo coverage cannot publish its late transcript into a new generation", async () => {
    const context = setup({ gate: true });
    const { adapter, state, captured, release, lifetime } = context;
    let mutation: ReturnType<ChatAdapter["undo"]> | undefined;
    try {
      await adapter.history("ses_parent");
      mutation = context.undo("cancelled-context");
      const transport = await captured;
      await adapter.stopEventPump();
      expect(await mutation).toMatchObject({ outcome: "changed" });
      expect(transport.aborted).toBe(true);
      state.boundary = "msg_first";
      void adapter.startEventPump();
      const current = await adapter.history("ses_parent");
      expect(current.items).toEqual([]);
      release();
      const next = await adapter.subscribe("ses_parent", { signal: lifetime.signal });
      next.events.cancel();
      expect(next.snapshot.items).toEqual([]);
    } finally { release(); await mutation; await context.dispose(); }
  });

  test("paged undo retains exact exclusions when a new turn commits its staged suffix during the read", async () => {
    const context = setup({ gate: true });
    const { adapter, provider, state, captured, release, lifetime } = context;
    // Put this settled worker in the later turn, so undo must remove it.
    state.records.splice(1, 0, state.records.pop()!);
    state.records[1] = { ...state.records[1]!, time: { created: 10 } };
    let mutation: ReturnType<ChatAdapter["undo"]> | undefined;
    try {
      expect((await adapter.history("ses_parent")).items).toContainEqual(expect.objectContaining({ id: "task:v2:ses_parent:call_worker" }));
      const listMessages = provider.listMessages.bind(provider);
      provider.listMessages = async (id, options) => {
        const { completeItems: _complete, ...page } = await listMessages(id, { ...options, limit: 1 });
        return page;
      };
      mutation = context.undo("committed-context");
      await captured;
      // A native replacement commits the discarded branch out of storage.
      // Its new complete source cannot restate the old suffix's exclusions.
      state.records = [state.records[0]!, { ...state.records[1]!, id: "msg_replacement", text: "New committed turn", time: { created: 80 } }];
      state.boundary = undefined;
      release();
      expect(await mutation).toMatchObject({ state: { staged: false } });
      const next = await adapter.subscribe("ses_parent", { signal: lifetime.signal });
      next.events.cancel();
      expect(next.snapshot.items.map(item => item.id)).toEqual(["message:msg_first", "message:msg_replacement"]);
    } finally { release(); await mutation; await context.dispose(); }
  });

  test("undo replacement keeps a newer worker terminal event over its captured running row", async () => {
    const context = setup({ gate: true, running: true });
    const { adapter, captured, release, lifetime } = context;
    let mutation: ReturnType<ChatAdapter["undo"]> | undefined;
    try {
      const initial = await adapter.history("ses_parent");
      expect(initial.items).toContainEqual(expect.objectContaining({ id: "task:v2:ses_parent:call_worker", status: "running" }));
      const existing = await adapter.subscribe("ses_parent", { signal: lifetime.signal });
      const terminal = (async () => {
        for await (const event of existing.events) if (event.type === "item.upsert" && event.item.id === "task:v2:ses_parent:call_worker"
          && event.item.type === "background_task" && event.item.status === "completed") return;
        throw new Error("worker terminal event was not delivered");
      })();
      mutation = context.undo("terminal-context");
      await captured;
      context.finish();
      await terminal;
      release(); await mutation;
      const next = await adapter.subscribe("ses_parent", { signal: lifetime.signal });
      next.events.cancel();
      expect(next.snapshot.items).toContainEqual(expect.objectContaining({ id: "task:v2:ses_parent:call_worker", status: "completed", resultId: "msg_result", control: { available: false } }));
      expect(next.snapshot.items.some(item => item.id === "notice:msg_result" || item.id === "message:msg_later")).toBe(false);
    } finally { release(); await mutation; await context.dispose(); }
  });
});

test("required child history survives a shared optional enrichment deadline", async () => {
  const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
  let captured!: () => void, release!: () => void, transportSignal: AbortSignal | undefined;
  const started = new Promise<void>(resolve => { captured = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const server = fakeOpenCode({
    "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"type":"server.connected","data":{}}\n\n'));
    } }), { headers: { "content-type": "text/event-stream" } }),
    "GET /api/session/:id": ({ path }) => session(path.split("/").at(-1)!, path.endsWith("ses_child") ? { parentID: "ses_parent" } : {}),
    "GET /api/session/ses_parent/message": () => ({ data: [fixture.launch], cursor: {} }),
    "GET /api/session/ses_child/message": async ({ signal }) => {
      transportSignal = signal; captured(); await gate;
      return { data: [{ id: "child_prompt", type: "user", text: "Healthy child", time: { created: 1 } }], cursor: {} };
    },
  });
  const provider = server.provider(), stream = observedNativeStream(provider);
  let parent: Promise<unknown> | undefined, child: Promise<unknown> | undefined;
  try {
    await provider.waitForEventStream(AbortSignal.timeout(3_000));
    parent = provider.listMessages("ses_parent", { limit: 100 });
    await started;
    const required = AbortSignal.timeout(3_000);
    child = provider.listMessages("ses_child", { limit: 100, signal: required });
    void child.catch(() => undefined);
    await parent; // The optional one-second window has now expired.
    expect(required.aborted).toBe(false);
    expect(transportSignal?.aborted).toBe(false);
    release();
    expect(await child).toMatchObject({ items: [expect.objectContaining({ text: "Healthy child" })] });
    expect(server.requests("GET", "/api/session/ses_child/message")).toHaveLength(1);
  } finally {
    release(); await Promise.allSettled([parent, child]);
    stream.lifetime.abort(); await stream.pump; await provider.dispose();
  }
}, 6_000);

test("abandoned public message reads cancel transport and cannot bank over or remove a retry", async () => {
  const started = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const returned = Promise.withResolvers<void>();
  const signals: AbortSignal[] = [];
  const server = fakeOpenCode({
    "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"type":"server.connected","data":{}}\n\n'));
    } }), { headers: { "content-type": "text/event-stream" } }),
    "GET /api/session/ses_parent": () => session("ses_parent"),
    "GET /api/session/ses_parent/message": async ({ signal }) => {
      const index = signals.length; signals.push(signal); started[index]!.resolve();
      // Deliberately ignore cancellation to exercise late-owner fencing.
      await gates[index]!.promise;
      if (index === 0) returned.resolve();
      return { data: [{ id: "prompt", type: "user", text: index === 0 ? "Stale" : "Current", time: { created: 1 } }], cursor: {} };
    },
  });
  const provider = server.provider(), stream = observedNativeStream(provider);
  const controller = new AbortController();
  let abandoned: Promise<unknown> | undefined, retry: Promise<unknown> | undefined, peer: Promise<unknown> | undefined;
  try {
    await provider.waitForEventStream(AbortSignal.timeout(3_000));
    abandoned = provider.listMessages("ses_parent", { limit: 100, signal: controller.signal });
    void abandoned.catch(() => undefined); await started[0]!.promise;
    controller.abort(); await expect(abandoned).rejects.toThrow();
    expect(signals[0]!.aborted).toBe(true);
    retry = provider.listMessages("ses_parent", { limit: 100 });
    await started[1]!.promise;
    gates[0]!.resolve(); await returned.promise;
    peer = provider.listMessages("ses_parent", { limit: 100 });
    gates[1]!.resolve();
    for (const page of await Promise.all([retry, peer])) expect(page).toMatchObject({ items: [expect.objectContaining({ text: "Current" })] });
    expect(await provider.listMessages("ses_parent", { limit: 100 })).toMatchObject({ items: [expect.objectContaining({ text: "Current" })] });
    expect(signals).toHaveLength(2);
  } finally {
    for (const gate of gates) gate.resolve();
    await Promise.allSettled([abandoned, retry, peer]);
    stream.lifetime.abort(); await stream.pump; await provider.dispose();
  }
});

for (const outcome of [
  "second-input", "second-occurrence", "first-input", "first-occurrence", "second-input-deeper", "first-leaf-known",
  "healthy", "unchanged-unavailable", "fresh-recovery", "zero-recovery", "continuation",
  "reused-leaf-occurrence", "reused-leaf-input", "reused-leaf-status", "reused-leaf-completion",
  "reused-leaf-new-id", "reused-leaf-recovery", "reused-leaf-zero-recovery", "retained-leaf-fresh-usage", "retained-leaf-fresh-zero",
  "reused-leaf-prompt-context", "reused-parent-occurrence", "retained-leaf-prompt-shift", "retained-leaf-coalesced",
  "retained-leaf-replacement", "retained-leaf-generation", "reused-leaf-generation", "reused-leaf-eviction",
  "renewed-leaf-history", "renewed-leaf-live", "renewed-leaf-amount", "renewed-leaf-zero", "renewed-leaf-unchanged",
  "renewed-leaf-no-rebinding", "renewed-leaf-expired", "renewed-leaf-retired-generation",
  "renewed-leaf-clone",
  "renewed-leaf-repeat", "renewed-leaf-newer-reference", "renewed-leaf-read-fence",
] as const)
for (const surface of ["reused-parent-occurrence", "retained-leaf-prompt-shift", "retained-leaf-coalesced", "retained-leaf-replacement", "retained-leaf-generation", "reused-leaf-generation", "reused-leaf-eviction", "renewed-leaf-expired", "renewed-leaf-retired-generation", "renewed-leaf-clone", "renewed-leaf-newer-reference", "renewed-leaf-read-fence"].includes(outcome)
  ? ["subscription"] as const : ["live", "subscription", "history"] as const)
test(`deep cohort parent binding stays fenced (${outcome}/${surface})`, async () => {
  const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
  const launch = (parent: string, child: string, call: string, prompt: string, created: number) => {
    const message = structuredClone(fixture.launch); message.sessionID = parent; message.id = `msg_${call}`; message.time.created = created;
    const tool = message.content[0]; tool.id = call; tool.time = { created, completed: created + 10 };
    tool.state.input = { ...tool.state.input, prompt, background: false };
    tool.state.metadata = { sessionID: child, status: "completed" }; tool.state.content = [{ type: "text", text: `${call} result` }];
    return message;
  };
  const root = launch("ses_root", "ses_child", "root", "Root task", 10);
  const first = launch("ses_child", "ses_grandchild", "first", "First task", 20);
  const second = launch("ses_child", "ses_grandchild", "second", "Second task", 60);
  const reusedLeaf = outcome.startsWith("reused-leaf-");
  const renewedProof = outcome.startsWith("renewed-leaf-");
  const expiredRenewal = outcome === "renewed-leaf-expired", retiredGeneration = outcome === "renewed-leaf-retired-generation";
  const newerReference = outcome === "renewed-leaf-newer-reference";
  const clonedRenewal = outcome === "renewed-leaf-clone";
  const noRenewal = outcome === "renewed-leaf-no-rebinding" || expiredRenewal || retiredGeneration || clonedRenewal;
  const initialLeafCost = outcome === "renewed-leaf-zero" ? 0 : 0.07;
  let renewalCost = initialLeafCost;
  const reusedParent = outcome === "reused-parent-occurrence";
  const promptContext = outcome === "reused-leaf-prompt-context";
  const moveLeaf = reusedLeaf && !promptContext;
  const generation = outcome === "retained-leaf-generation" || outcome === "reused-leaf-generation", eviction = outcome.endsWith("-eviction");
  const replacement = outcome === "retained-leaf-replacement", coalesced = outcome === "retained-leaf-coalesced";
  const refreshLeaf = reusedLeaf || reusedParent || outcome.startsWith("retained-leaf-");
  const firstLeaf = outcome === "first-leaf-known" || refreshLeaf || renewedProof;
  const deeper = outcome === "second-input-deeper";
  const leaf = launch("ses_grandchild", "ses_leaf", "leaf", "Leaf task", firstLeaf ? 28 : 68);
  const deep = launch("ses_leaf", "ses_deep", "deep", "Deep task", 74);
  const prompt = (id: string, text: string, created: number) => ({ id, type: "user", text, time: { created } });
  const spend = (id: string, cost: number, created: number) => ({ id, type: "assistant", model: { id: "fixture-model" }, cost, time: { created }, content: [] });
  const healthy = outcome === "healthy" || outcome === "continuation";
  const unchanged = outcome === "unchanged-unavailable";
  const recovery = outcome.endsWith("-recovery"), zero = outcome === "zero-recovery" || outcome === "reused-leaf-zero-recovery";
  const leafCost = () => fresh && zero || leafChanged && outcome === "retained-leaf-fresh-zero" ? 0 : leafChanged ? 0.09 : renewalCost;
  const changedFirst = outcome.startsWith("first-") && !firstLeaf;
  const occurrence = outcome.endsWith("-occurrence");
  const changed = changedFirst ? first : second;
  let degraded = false, fresh = false, leafChanged = false, opened = 0, closed = 0, sequence = 0, boundary: string | undefined;
  let wire!: ReadableStreamDefaultController<Uint8Array>;
  const server = fakeOpenCode({
    "GET /api/event": ({ signal }) => new Response(new ReadableStream<Uint8Array>({ start(controller) {
      wire = controller; opened++; controller.enqueue(new TextEncoder().encode('data: {"type":"server.connected","data":{}}\n\n'));
      signal.addEventListener("abort", () => { closed++; controller.close(); }, { once: true });
    } }), { headers: { "content-type": "text/event-stream" } }),
    "GET /api/session": () => ({ data: [], cursor: {} }),
    "GET /api/session/ses_root": () => session("ses_root"),
    "GET /api/session/ses_child": () => session("ses_child", { parentID: "ses_root", cost: 0.05, ...(boundary ? { revert: { messageID: boundary } } : {}) }),
    "GET /api/session/ses_grandchild": () => degraded ? new Response(null, { status: 503 }) : session("ses_grandchild", { parentID: "ses_child", cost: fresh ? zero ? 0.5 : 0.9 : 0.3 }),
    "GET /api/session/ses_leaf": () => session("ses_leaf", { parentID: "ses_grandchild", cost: leafCost() }),
    "GET /api/session/ses_deep": () => session("ses_deep", { parentID: "ses_leaf", cost: 0.03 }),
    "GET /api/session/ses_root/message": () => ({ data: [root], cursor: {} }),
    "GET /api/session/ses_child/message": () => ({ data: [prompt("child_prompt", "Root task", 11), spend("child_spend", 0.05, 15), first, second,
      ...(replacement ? [prompt("later", "Later user message", 120)] : [])], cursor: {} }),
    "GET /api/session/ses_grandchild/message": () => ({ data: [
      ...(leafChanged && outcome === "retained-leaf-prompt-shift" ? [prompt("preamble", "Continue", 19)] : []),
      prompt(leafChanged && promptContext ? "first_prompt_replaced" : "first_prompt", fresh ? first.content[0].state.input.prompt : "First task", 21), spend("first_spend", fresh ? zero ? 0 : 0.4 : 0.1, 25),
      ...(firstLeaf && !(leafChanged && moveLeaf) ? [leaf] : []),
      ...(outcome === "continuation" ? [prompt("continue_prompt", "Please continue", 40)] : []),
      prompt("second_prompt", fresh ? second.content[0].state.input.prompt : "Second task", 61), spend("second_spend", fresh ? 0.5 : 0.2, 65),
      ...(firstLeaf && !(leafChanged && moveLeaf) ? [] : [leaf]),
    ], cursor: {} }),
    "GET /api/session/ses_leaf/message": () => ({ data: [prompt("leaf_prompt", leaf.content[0].state.input.prompt, firstLeaf ? 29 : 69), spend("leaf_spend", leafCost(), firstLeaf ? 32 : 72), ...(deeper ? [deep] : [])], cursor: {} }),
    "GET /api/session/ses_deep/message": () => ({ data: [prompt("deep_prompt", "Deep task", 75), spend("deep_spend", 0.03, 76)], cursor: {} }),
    "GET /api/session/:id/inbox": () => ({ data: [] }), "GET /api/session/active": () => ({}),
    "GET /api/permission/request": () => scoped([]), "GET /api/form": () => scoped([]),
    "POST /api/session/ses_child/revert/stage": ({ body }) => { boundary = (body as { messageID: string }).messageID; return { messageID: boundary }; },
    "GET /api/session/:id": ({ path }) => { const id = path.split("/").at(-1)!; return session(id, id.startsWith("ses_proof_pressure_") ? { parentID: "ses_proof_pressure" } : {}); },
    "GET /api/session/:id/message": () => ({ data: [], cursor: {} }),
  });
  const provider = server.provider(), events = provider.events.bind(provider), list = provider.listMessages.bind(provider);
  const renewalOwner = new AsyncLocalStorage<boolean>(), boundaryRead = provider.getHistoryRevertBoundary.bind(provider);
  let holdRenewal = false, renewalEntered!: () => void, releaseRenewal!: () => void, renewalSignal: AbortSignal | undefined;
  const renewalReady = new Promise<void>(resolve => { renewalEntered = resolve; });
  const renewalGate = new Promise<void>(resolve => { releaseRenewal = resolve; });
  provider.getHistoryRevertBoundary = async (...args) => {
    const value = await boundaryRead(...args);
    if (holdRenewal && renewalOwner.getStore() && args[0] === "ses_child" && args[1]?.expectedBoundary === null) {
      holdRenewal = false; renewalSignal = args[1]?.signal; renewalEntered(); await renewalGate;
    }
    return value;
  };
  let observedLeaf: import("../../types").ToolItem | undefined;
  let childHistoryReads = 0;
  provider.listMessages = async (...args) => {
    if (args[0] === "ses_child") childHistoryReads++;
    const page = await list(...args);
    if ((leafChanged || renewedProof) && args[0] === "ses_grandchild") observedLeaf = page.completeItems?.find((item): item is import("../../types").ToolItem => item.type === "tool" && item.id === `tool:${leaf.content[0].id}`);
    return page;
  };
  let applied!: () => void;
  provider.events = async function* (signal) { for await (const event of events(signal)) {
    yield event;
    if (event.eventType === "diagnostic.deep.cohort.applied") applied();
  } };
  const emit = async (batch: Array<Record<string, unknown>>) => {
    const ready = new Promise<void>(resolve => { applied = resolve; });
    for (const event of [...batch, { type: "diagnostic.deep.cohort.applied", data: {} }])
      wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ ...event, location: { directory: WORKSPACE } })}\n\n`));
    await ready;
  };
  const adapter = new ChatAdapter({ provider, workspacePath: WORKSPACE, coalesceWindowMs: coalesced ? 25 : 0,
    ...(eviction ? { maxProjections: 2 } : {}), ...(expiredRenewal ? { historyReadTimeoutMs: 500 } : {}) });
  const history = adapter.history.bind(adapter);
  let reconnectReads: Array<ReturnType<ChatAdapter["history"]>> | undefined;
  if (retiredGeneration) adapter.history = (...args) => {
    const pending = history(...args);
    reconnectReads?.push(pending);
    return pending;
  };
  const now = Date.now(); let elapsed = 0;
  const clock = recovery ? spyOn(Date, "now").mockImplementation(() => now + elapsed) : undefined;
  let observer: Awaited<ReturnType<ChatAdapter["subscribe"]>> | undefined;
  let pinnedRoot: Awaited<ReturnType<ChatAdapter["subscribe"]>> | undefined;
  let pinnedNative: Awaited<ReturnType<ChatAdapter["subscribe"]>> | undefined;
  let priorLine: import("../../types").SubagentLine | undefined, projectedLine: import("../../types").SubagentLine | undefined;
  let renewing: ReturnType<ChatAdapter["history"]> | undefined;
  let proofReadFence: ReturnType<ReturnType<ChatAdapter["projectionForTests"]>["beginHistoryRead"]> | undefined;
  const tools = (items: import("../../types").ConversationItem[]) => items.filter((item): item is import("../../types").ToolItem => item.type === "tool");
  const rootRow = (items: import("../../types").ConversationItem[]) => tools(items).find(row => row.id === "tool:root")!;
  const direct = (items: import("../../types").ConversationItem[]) => ["first", "second"].map(id => tools(items).find(row => row.id === `tool:${id}`)?.usage?.costUsd);
  try {
    const initial = await adapter.history("ses_root");
    expect(rootRow(initial.items)).toMatchObject({ usage: { costUsd: 0.05 }, workerSession: { costUsd: 0.05 } });
    expect(rootRow(initial.items).descendants).toContainEqual(expect.objectContaining({ id: "tool:leaf", parentId: firstLeaf ? "tool:first" : "tool:second", conversationId: "ses_leaf", usage: { costUsd: initialLeafCost } }));
    if (deeper) expect(rootRow(initial.items).descendants).toContainEqual(expect.objectContaining({ id: "tool:deep", parentId: "tool:leaf", usage: { costUsd: 0.03 } }));
    const initialChild = await adapter.history("ses_child");
    expect(direct(initialChild.items)).toEqual([0.1, 0.2]);
    if (renewedProof) {
      const beforeChild = await adapter.subscribe("ses_child"), beforeRoot = await adapter.subscribe("ses_root");
      const firstRow = tools(initialChild.items).find(row => row.id === "tool:first")!;
      priorLine = firstRow.descendants!.find(line => line.id === "tool:leaf")!;
      if (outcome === "renewed-leaf-read-fence") proofReadFence = adapter.projectionForTests("ses_child").beginHistoryRead();
      const reads = ["ses_grandchild", "ses_leaf"].map(id => server.requests("GET", `/api/session/${id}/message`).length);
      // Both authoritative histories observe the new occurrence. Its parent,
      // public description and known amount are unchanged, so no wire frame
      // is needed, but the projected private binding must become current.
      if (outcome !== "renewed-leaf-unchanged" && !clonedRenewal) { leaf.time.created++; leaf.content[0].time.created++; leaf.content[0].time.completed++; }
      if (clonedRenewal) {
        // The public projection test seam simulates a genuine in-memory line
        // clone; IDs and wire equality alone must not recreate private proof.
        adapter.projectionForTests("ses_child").upsert({ ...firstRow, descendants: structuredClone(firstRow.descendants) });
      }
      if (outcome === "renewed-leaf-amount") renewalCost = 0.09;
      await emit(["ses_grandchild", "ses_leaf"].map(id => ({ type: "session.updated", created: 90, data: { info: session(id, { parentID: id === "ses_leaf" ? "ses_grandchild" : "ses_child", cost: id === "ses_leaf" ? renewalCost : 0.3 }) } })));
      if (outcome === "renewed-leaf-live") {
        await emit([{ id: "evt_healthy_leaf", type: "session.message.content.updated", created: leaf.time.created,
          durable: { aggregateID: "ses_grandchild", seq: ++sequence, version: 1 }, data: { sessionID: "ses_grandchild", messageID: leaf.id, content: leaf.content } }]);
        expect(["ses_grandchild", "ses_leaf"].map(id => server.requests("GET", `/api/session/${id}/message`).length)).toEqual(reads);
        const nativeView = await adapter.subscribe("ses_grandchild"); nativeView.events.cancel();
        expect(tools(nativeView.snapshot.items).find(row => row.id === "tool:leaf")).toMatchObject({ createdAt: leaf.time.created, completedAt: leaf.content[0].time.completed, childConversationId: "ses_leaf" });
      } else if (expiredRenewal || retiredGeneration || newerReference) {
        holdRenewal = true; renewing = renewalOwner.run(true, () => adapter.history("ses_child"));
        void renewing.catch(() => undefined); await renewalReady;
        if (newerReference) {
          leaf.time.created++; leaf.content[0].time.created++; leaf.content[0].time.completed++;
          await emit([{ id: "evt_newer_leaf", type: "session.message.content.updated", created: leaf.time.created,
            durable: { aggregateID: "ses_grandchild", seq: ++sequence, version: 1 }, data: { sessionID: "ses_grandchild", messageID: leaf.id, content: leaf.content } }]);
          const current = await adapter.subscribe("ses_child"); current.events.cancel();
          const newerLine = tools(current.snapshot.items).find(row => row.id === "tool:first")!.descendants!.find(line => line.id === "tool:leaf");
          pinnedNative = await adapter.subscribe("ses_grandchild");
          // Retire the old read's cached attribution owner without evicting
          // either pinned projection. Its captured private references are
          // now protected by the read-change fence, not a late cache reprice.
          await emit(Array.from({ length: 512 }, (_, index) => {
            const sessionID = `ses_proof_pressure_${index}`, inboxID = `proof_prompt_${index}`;
            return [
              { id: `proof_enqueued_${index}`, type: "session.inbox.enqueued", created: 1000 + index * 2, data: { sessionID, inboxID, item: { id: inboxID, type: "user", payload: { text: "Native proof pressure" } } } },
              { id: `proof_delivered_${index}`, type: "session.inbox.delivered", created: 1001 + index * 2, data: { sessionID, inboxID } },
            ];
          }).flat());
          const last = await adapter.subscribe("ses_proof_pressure_511"); last.events.cancel();
          expect(last.snapshot.items).toContainEqual(expect.objectContaining({ id: "message:proof_prompt_511", type: "user_message" }));
          const nativePrompt = (sessionID: string, inboxID: string, text: string, created: number) => [
            { id: `restore_${inboxID}`, type: "session.inbox.enqueued", created, data: { sessionID, inboxID, item: { id: inboxID, type: "user", payload: { text } } } },
            { id: `deliver_${inboxID}`, type: "session.inbox.delivered", created, data: { sessionID, inboxID } },
          ];
          // Restore current prompt topology and exact direct-row amounts via
          // native restatements, not a successful history/cohort publication.
          // The retired read still cannot reprice from its old cached owner.
          await emit([
            ...nativePrompt("ses_grandchild", "first_prompt", "First task", 21),
            { id: "evt_restore_newer_leaf", type: "session.message.content.updated", created: leaf.time.created,
              durable: { aggregateID: "ses_grandchild", seq: ++sequence, version: 1 }, data: { sessionID: "ses_grandchild", messageID: leaf.id, content: leaf.content } },
            ...nativePrompt("ses_grandchild", "second_prompt", "Second task", 61),
            ...nativePrompt("ses_leaf", "leaf_prompt", "Leaf task", 29),
          ]);
          const beforeOlder = await adapter.subscribe("ses_child"); beforeOlder.events.cancel();
          expect(tools(beforeOlder.snapshot.items).find(row => row.id === "tool:first")!.descendants!.find(line => line.id === "tool:leaf")).toBe(newerLine);
          releaseRenewal(); await renewing;
          const afterOlder = await adapter.subscribe("ses_child"); afterOlder.events.cancel();
          expect(tools(afterOlder.snapshot.items).find(row => row.id === "tool:first")!.descendants!.find(line => line.id === "tool:leaf")).toBe(newerLine);
        } else if (expiredRenewal) {
          await new Promise<void>(resolve => { if (renewalSignal!.aborted) resolve(); else renewalSignal!.addEventListener("abort", () => resolve(), { once: true }); });
        } else await adapter.stopEventPump();
        if (!newerReference) { releaseRenewal(); await expect(renewing).rejects.toThrow(); }
        if (retiredGeneration) {
          second.content[0].state.input.prompt = "Changed second task"; degraded = true;
          reconnectReads = [];
          void adapter.startEventPump(); await provider.waitForEventStream(AbortSignal.timeout(3_000));
          // Readiness only covers the stream. The connected event also starts
          // independent history recoveries; finish those while still degraded,
          // before the later restatement's exact no-extra-read baseline.
          await emit([]);
          const recovering = reconnectReads; reconnectReads = undefined;
          expect(recovering).toHaveLength(2);
          await Promise.all(recovering);
        }
      } else if (!noRenewal) {
        const healthyChild = await adapter.history("ses_child"), healthyRoot = await adapter.history("ses_root");
        if (outcome === "renewed-leaf-amount") {
          expect(tools(healthyChild.items).find(row => row.id === "tool:first")?.descendants).toContainEqual(expect.objectContaining({ id: "tool:leaf", usage: { costUsd: 0.09 } }));
        } else {
          expect(JSON.stringify(tools(healthyChild.items).find(row => row.id === "tool:first"))).toBe(JSON.stringify(firstRow));
          expect(JSON.stringify(rootRow(healthyRoot.items))).toBe(JSON.stringify(rootRow(initial.items)));
        }
        for (const [index, id] of ["ses_grandchild", "ses_leaf"].entries()) expect(server.requests("GET", `/api/session/${id}/message`).length).toBeGreaterThan(reads[index]!);
      }
      if (((!noRenewal && outcome !== "renewed-leaf-live") || expiredRenewal || retiredGeneration) && !newerReference) expect(observedLeaf).toMatchObject({ createdAt: leaf.time.created, completedAt: leaf.content[0].time.completed, childConversationId: "ses_leaf" });
      const after = await adapter.subscribe("ses_child"); after.events.cancel();
      projectedLine = tools(after.snapshot.items).find(row => row.id === "tool:first")!.descendants!.find(line => line.id === "tool:leaf");
      if (proofReadFence) {
        expect(proofReadFence.changed("tool:first")).toBe(true);
        expect(proofReadFence.merge([firstRow])).toEqual([tools(after.snapshot.items).find(row => row.id === "tool:first")!]);
        expect(proofReadFence.merge([firstRow])[0]).toBe(tools(after.snapshot.items).find(row => row.id === "tool:first")!);
      }
      if (outcome === "renewed-leaf-repeat") for (let index = 0; index < 3; index++) {
        const before = childHistoryReads;
        await adapter.history("ses_child", { limit: 51 + index });
        expect(childHistoryReads - before).toBe(1);
        const repeated = await adapter.subscribe("ses_child"); repeated.events.cancel();
        expect(tools(repeated.snapshot.items).find(row => row.id === "tool:first")!.descendants!.find(line => line.id === "tool:leaf")).toBe(projectedLine);
      }
      if (outcome !== "renewed-leaf-amount" && !retiredGeneration && !clonedRenewal) expect(after.snapshot.cursor).toBe(beforeChild.snapshot.cursor);
      beforeChild.events.cancel(); beforeRoot.events.cancel();
      for (const subscription of [beforeChild, beforeRoot]) {
        const events = []; for await (const event of subscription.events) events.push(event);
        const items = events.filter(event => event.type === "item.upsert" || event.type === "item.remove");
        if (outcome === "renewed-leaf-amount") expect(items.some(event => event.type === "item.upsert")).toBe(true);
        else if (!retiredGeneration && !clonedRenewal) expect(items).toEqual([]);
      }
    }
    if (generation) {
      await adapter.stopEventPump(); void adapter.startEventPump();
      await provider.waitForEventStream(AbortSignal.timeout(3_000));
      await adapter.history("ses_root"); await adapter.history("ses_child");
    }
    if (coalesced) {
      const subscription = await adapter.subscribe("ses_child");
      const applied = (async () => { for await (const event of subscription.events) if (event.type === "item.upsert" && event.item.type === "tool"
        && event.item.id === "tool:first" && event.item.output === "Coalesced current first output") return; })();
      const running = structuredClone(first.content); running[0].state.status = "running";
      first.content[0].state.content = [{ type: "text", text: "Coalesced current first output" }];
      try {
        await emit([running, first.content].map(content => ({ id: `evt_coalesced_${++sequence}`, type: "session.message.content.updated", created: first.time.created,
          durable: { aggregateID: "ses_child", seq: sequence, version: 1 }, data: { sessionID: "ses_child", messageID: first.id, content } })));
        await applied;
      } finally { subscription.events.cancel(); await applied; }
      const current = await adapter.subscribe("ses_child"); current.events.cancel();
      expect(tools(current.snapshot.items).find(row => row.id === "tool:first")?.descendants).toContainEqual(expect.objectContaining({ id: "tool:leaf", usage: { costUsd: 0.07 } }));
    }
    if (replacement) {
      expect(await adapter.undo("ses_child", "binding-replacement")).toMatchObject({ outcome: "changed", state: { staged: true } });
      const current = await adapter.subscribe("ses_child"); current.events.cancel();
      expect(current.snapshot.items.some(item => item.id === "message:later")).toBe(false);
      expect(tools(current.snapshot.items).find(row => row.id === "tool:first")?.descendants).toContainEqual(expect.objectContaining({ id: "tool:leaf", usage: { costUsd: 0.07 } }));
    }
    await emit(["ses_grandchild", "ses_child"].map(id => ({ type: "session.updated", created: 90, data: { info: session(id, { parentID: id === "ses_child" ? "ses_root" : "ses_child" }) } })));
    if (!healthy && !unchanged) {
      if (occurrence) { changed.time.created++; changed.content[0].time.created++; changed.content[0].time.completed++; }
      else changed.content[0].state.input.prompt = `Changed ${changedFirst ? "first" : "second"} task`;
    }
    degraded = !healthy;
    const withdrawn = await adapter.history("ses_child");
    const retained = healthy || unchanged ? [0.1, 0.2] : changedFirst ? [undefined, 0.2] : [0.1, undefined];
    expect(direct(withdrawn.items)).toEqual(retained);
    if (!healthy && !unchanged) {
      const rejected = tools(withdrawn.items).find(row => row.id === `tool:${changedFirst ? "first" : "second"}`)!;
      expect(rejected).toMatchObject({ input: JSON.stringify(changed.content[0].state.input), createdAt: changed.content[0].time.created });
      for (const key of ["childConversationId", "usage", "model", "workerSession", "descendants"]) expect(rejected).not.toHaveProperty(key);
    }
    const reads = ["ses_grandchild", "ses_leaf"].map(id => server.requests("GET", `/api/session/${id}/message`).length);
    degraded = false;
    if (surface === "live" && !recovery) observer = await adapter.subscribe("ses_root");
    await emit(replacement ? [] : [{ id: "evt_deep_restatement", type: "session.message.content.updated", created: changed.time.created,
      durable: { aggregateID: "ses_child", seq: ++sequence, version: 1 }, data: { sessionID: "ses_child", messageID: changed.id, content: changed.content } }]);
    expect(["ses_grandchild", "ses_leaf"].map(id => server.requests("GET", `/api/session/${id}/message`).length)).toEqual(reads);
    const currentChild = await adapter.subscribe("ses_child"); currentChild.events.cancel();
    expect(direct(currentChild.snapshot.items)).toEqual(retained);
    if (noRenewal) await emit([{ id: "evt_unproven_leaf", type: "session.message.content.updated", created: leaf.time.created,
      durable: { aggregateID: "ses_grandchild", seq: ++sequence, version: 1 }, data: { sessionID: "ses_grandchild", messageID: leaf.id, content: leaf.content } }]);
    let reusedHistory: Awaited<ReturnType<ChatAdapter["history"]>> | undefined;
    if (noRenewal) reusedHistory = await adapter.history("ses_root");
    if (refreshLeaf) {
      const firstRow = tools(currentChild.snapshot.items).find(row => row.id === "tool:first")!;
      expect(firstRow.descendants).toContainEqual(expect.objectContaining({ id: "tool:leaf", parentId: firstRow.id, usage: { costUsd: 0.07 } }));
      // Reused native occurrences follow the sibling task; unchanged-signature
      // controls stay under the first. Its enclosing call never changes.
      leafChanged = true;
      if (moveLeaf) { leaf.id = "msg_leaf_reused"; leaf.time.created = 68; }
      if (outcome === "reused-leaf-input") leaf.content[0].state.input.prompt = "Changed leaf task";
      else if (outcome === "reused-leaf-status") { leaf.content[0].state.status = "error"; leaf.content[0].state.error = { message: "Reused leaf failed" }; }
      else if (outcome === "reused-leaf-completion") leaf.content[0].time.completed++;
      else if (outcome === "reused-leaf-new-id") leaf.content[0].id = "leaf_new";
      else if (moveLeaf) leaf.content[0].time = { created: 68, completed: 78 };
      if (reusedParent) {
        first.time.created++; first.content[0].time.created++; first.content[0].time.completed++;
        await emit([{ id: "evt_parent_occurrence", type: "session.message.content.updated", created: first.time.created,
          durable: { aggregateID: "ses_child", seq: ++sequence, version: 1 }, data: { sessionID: "ses_child", messageID: first.id, content: first.content } }]);
      }
      if (eviction) {
        pinnedRoot = await adapter.subscribe("ses_root");
        await adapter.history("ses_binding_pressure");
        const reset = await adapter.subscribe("ses_child"); reset.events.cancel();
        expect(reset.snapshot.items).toEqual([]);
      }
      await emit(["ses_grandchild", "ses_leaf"].map(id => ({ type: "session.updated", created: 100, data: { info: session(id, { parentID: id === "ses_leaf" ? "ses_grandchild" : "ses_child" }) } })));
      reusedHistory = await adapter.history("ses_root");
      expect(observedLeaf).toMatchObject({ createdAt: leaf.time.created, completedAt: leaf.content[0].time.completed,
        input: JSON.stringify(leaf.content[0].state.input), status: leaf.content[0].state.status === "error" ? "failed" : leaf.content[0].state.status, childConversationId: "ses_leaf" });
      for (const [index, id] of ["ses_grandchild", "ses_leaf"].entries()) expect(server.requests("GET", `/api/session/${id}/message`).length).toBeGreaterThan(reads[index]!);
      const current = await adapter.subscribe("ses_child"); current.events.cancel();
      const exactFirst = tools(current.snapshot.items).find(row => row.id === "tool:first")!;
      if (eviction) expect(current.snapshot.items).toEqual([]);
      else {
        expect(exactFirst).toMatchObject({ createdAt: reusedParent ? first.time.created : firstRow.createdAt, input: firstRow.input, usage: { costUsd: 0.1 } });
        expect(direct(current.snapshot.items)).toEqual(retained);
      }
    }
    let expected = eviction ? [undefined, undefined] : retained;
    if (recovery) {
      fresh = true; elapsed = 31_000;
      await emit(["ses_grandchild", "ses_child", "ses_leaf"].map(id => ({ type: "session.updated", created: 100, data: { info: session(id, { parentID: id === "ses_child" ? "ses_root" : id === "ses_leaf" ? "ses_grandchild" : "ses_child" }) } })));
      expected = [zero ? 0 : 0.4, 0.5];
      expect(direct((await adapter.history("ses_child")).items)).toEqual(expected);
      expect(server.requests("GET", "/api/session/ses_grandchild/message").length).toBeGreaterThan(reads[0]!);
      if (surface === "live") observer = await adapter.subscribe("ses_root");
      await emit([{ type: "session.step.ended", created: 25, data: { sessionID: "ses_grandchild", assistantMessageID: "first_spend", cost: zero ? 0 : 0.4 } }]);
    }
    let ancestorItems: import("../../types").ConversationItem[];
    if (surface === "history") ancestorItems = (!recovery && reusedHistory ? reusedHistory : await adapter.history("ses_root")).items;
    else if (surface === "subscription") { const next = await adapter.subscribe("ses_root"); next.events.cancel(); ancestorItems = next.snapshot.items; }
    else {
      observer!.events.cancel();
      const projected = new Map(observer!.snapshot.items.map(item => [item.id, item]));
      for await (const event of observer!.events) {
        if (event.type === "item.upsert") projected.set(event.item.id, event.item);
        if (event.type === "item.remove") projected.delete(event.itemId);
      }
      ancestorItems = [...projected.values()];
    }
    const row = rootRow(ancestorItems);
    expect(row).toMatchObject({ usage: { costUsd: 0.05 }, workerSession: { costUsd: 0.05 } });
    for (const [index, id] of ["first", "second"].entries()) {
      const line = row.descendants?.find(line => line.id === `tool:${id}`);
      if (expected[index] === undefined) expect(line).not.toHaveProperty("usage");
      else expect(line).toMatchObject({ usage: { costUsd: expected[index] } });
    }
    expect(server.calls.filter(call => call.method !== "GET").map(call => [call.method, call.path])).toEqual(replacement ? [["POST", "/api/session/ses_child/revert/stage"]] : []);
    if (((reusedLeaf || reusedParent) && !recovery) || noRenewal) {
      expect(row.descendants?.filter(line => line.conversationId === "ses_leaf" && line.usage !== undefined) ?? []).toEqual([]);
    } else if (refreshLeaf) {
      expect(row.descendants).toContainEqual(expect.objectContaining({ id: `tool:${leaf.content[0].id}`, parentId: recovery ? "tool:second" : "tool:first", usage: { costUsd: leafCost() } }));
    } else if (healthy || unchanged || recovery || firstLeaf || changedFirst) {
      expect(row.descendants).toContainEqual(expect.objectContaining({ id: "tool:leaf", parentId: firstLeaf ? "tool:first" : "tool:second", usage: { costUsd: fresh && zero ? 0 : renewalCost } }));
    } else {
      expect(row.descendants?.filter(line => (line.conversationId === "ses_leaf" || line.conversationId === "ses_deep") && line.usage !== undefined) ?? []).toEqual([]);
    }
    expect(opened).toBe(generation || retiredGeneration ? 2 : 1);
    if (renewedProof && !noRenewal && outcome !== "renewed-leaf-unchanged") expect(projectedLine).not.toBe(priorLine);
  } finally { releaseRenewal(); await renewing?.catch(() => undefined); proofReadFence?.release(); observer?.events.cancel(); pinnedRoot?.events.cancel(); pinnedNative?.events.cancel(); clock?.mockRestore(); await adapter.dispose(); expect(closed).toBe(opened); }
});

for (const outcome of ["second-input", "first-input", "second-occurrence", "first-occurrence", "healthy", "fresh-recovery", "zero-recovery", "root-only-recovery", "root-only-zero-recovery", "root-only-held-recovery", "root-only-tied-delivery-recovery",
  "root-only-unavailable", "root-only-foreign-parent", "root-only-foreign-workspace", "root-only-restatement", "root-only-missing-member",
  "root-only-retired", "root-only-generation", "root-only-changed-source", "root-only-newer-proof", "root-only-newer-private", "root-only-reused-earlier"] as const)
for (const surface of outcome.startsWith("root-only-") && !outcome.endsWith("-recovery") ? ["subscription"] as const
  : outcome.endsWith("-occurrence") ? ["live", "subscription"] as const : ["live", "subscription", "history"] as const)
test(`recursive allocation eligibility survives degraded nested history (${outcome}/${surface})`, async () => {
  const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
  const launch = (parent: string, child: string, call: string, prompt: string, created: number) => {
    const message = structuredClone(fixture.launch); message.sessionID = parent; message.id = `msg_${call}`; message.time.created = created;
    const tool = message.content[0]; tool.id = call; tool.time = { created, completed: created + 10 };
    tool.state.input = { ...tool.state.input, prompt, background: false };
    tool.state.metadata = { sessionID: child, status: "completed" }; tool.state.content = [{ type: "text", text: `${call} result` }];
    return message;
  };
  const root = launch("ses_root", "ses_child", "root", "Root task", 10);
  const first = launch("ses_child", "ses_grandchild", "first", "First task", 20);
  const second = launch("ses_child", "ses_grandchild", "second", "Second task", 60);
  const prompt = (id: string, text: string, created: number) => ({ id, type: "user", text, time: { created } });
  const spend = (id: string, cost: number, created: number) => ({ id, type: "assistant", model: { id: "fixture-model" }, cost, time: { created }, content: [] });
  const rootOnly = outcome.startsWith("root-only-");
  const unavailable = outcome === "root-only-unavailable", foreignParent = outcome === "root-only-foreign-parent", foreignWorkspace = outcome === "root-only-foreign-workspace";
  const restatement = outcome === "root-only-restatement", missingMember = outcome === "root-only-missing-member";
  const retired = outcome === "root-only-retired", rootGeneration = outcome === "root-only-generation", changedSource = outcome === "root-only-changed-source", newerProof = outcome === "root-only-newer-proof";
  const heldRecovery = outcome === "root-only-held-recovery";
  const newerPrivate = outcome === "root-only-newer-private";
  const reusedEarlier = outcome === "root-only-reused-earlier", tiedDelivery = outcome === "root-only-tied-delivery-recovery";
  const rootBlocked = unavailable || restatement || missingMember || retired || rootGeneration || newerProof || newerPrivate || reusedEarlier;
  const rootDenied = foreignParent || foreignWorkspace || changedSource;
  const changedFirst = outcome.startsWith("first-"), occurrence = outcome.endsWith("-occurrence"), healthy = outcome === "healthy", recovery = outcome.endsWith("-recovery") || rootOnly, zero = outcome === "zero-recovery" || outcome === "root-only-zero-recovery";
  const changed = changedFirst ? first : second;
  let degraded = false, fresh = false, lateForeign = false, freshSecondPrompt = "Second task", opened = 0, closed = 0, sequence = 0;
  let wire!: ReadableStreamDefaultController<Uint8Array>;
  const server = fakeOpenCode({
    "GET /api/event": ({ signal }) => new Response(new ReadableStream<Uint8Array>({ start(controller) {
      wire = controller; opened++; controller.enqueue(new TextEncoder().encode('data: {"type":"server.connected","data":{}}\n\n'));
      signal.addEventListener("abort", () => { closed++; controller.close(); }, { once: true });
    } }), { headers: { "content-type": "text/event-stream" } }),
    "GET /api/session": () => ({ data: [], cursor: {} }),
    "GET /api/session/ses_root": () => session("ses_root"),
    "GET /api/session/ses_child": () => session("ses_child", { parentID: "ses_root", cost: 0.05 }),
    "GET /api/session/ses_grandchild": () => degraded ? new Response(null, { status: 503 }) : session("ses_grandchild", {
      parentID: (rootPhase && foreignParent) || lateForeign ? "ses_other" : "ses_child", cost: fresh ? zero ? 0.5 : 0.9 : 0.3,
      ...(rootPhase && foreignWorkspace ? { location: { directory: "/foreign" } } : {}),
    }),
    "GET /api/session/ses_root/message": () => ({ data: [root], cursor: {} }),
    "GET /api/session/ses_child/message": () => ({ data: [prompt("child_prompt", "Root task", 11), spend("child_spend", 0.05, 15), first, ...(rootPhase && missingMember ? [] : [second])], cursor: {} }),
    "GET /api/session/ses_grandchild/message": () => ({ data: [
      prompt("first_prompt", fresh ? first.content[0].state.input.prompt : "First task", rootPhase && tiedDelivery ? 20 : 21), spend("first_spend", fresh ? zero ? 0 : 0.4 : 0.1, 25),
      prompt("second_prompt", fresh ? freshSecondPrompt : "Second task", 61), spend("second_spend", fresh ? 0.5 : 0.2, 65),
    ], cursor: {} }),
    "GET /api/session/:id/inbox": () => ({ data: [] }), "GET /api/session/active": () => ({}),
    "GET /api/permission/request": () => scoped([]), "GET /api/form": () => scoped([]),
  });
  const provider = server.provider(), events = provider.events.bind(provider), list = provider.listMessages.bind(provider);
  let rootPhase = false, explicitIntermediateReads = 0, completedIntermediateReads = 0, holdFreshHistory = false;
  let freshAccounting: Array<number | undefined> = [], freshMembers: Array<{ id: string; child: string | undefined; name: string; status: string; createdAt: number; completedAt: number | undefined; input: string | undefined }> = [];
  let freshPrompts: string[] = [], contradictions: readonly string[] = [];
  const completePages = [false, false];
  const rootOwner = new AsyncLocalStorage<boolean>(), boundaryRead = provider.getHistoryRevertBoundary.bind(provider);
  let holdRoot = false, rootEntered!: () => void, releaseRoot!: () => void, releaseFreshHistory!: () => void, rootSignal: AbortSignal | undefined;
  const rootReady = new Promise<void>(resolve => { rootEntered = resolve; }), rootGate = new Promise<void>(resolve => { releaseRoot = resolve; });
  const freshGate = new Promise<void>(resolve => { releaseFreshHistory = resolve; });
  provider.getHistoryRevertBoundary = async (...args) => {
    const value = await boundaryRead(...args);
    if (holdRoot && rootOwner.getStore() && args[0] === "ses_root" && args[1]?.expectedBoundary === null) {
      holdRoot = false; rootSignal = args[1]?.signal; rootEntered(); await rootGate;
    }
    return value;
  };
  provider.listMessages = async (...args) => {
    if (holdFreshHistory && !rootOwner.getStore() && (args[0] === "ses_root" || args[0] === "ses_child")) await freshGate;
    const page = await list(...args);
    if (rootPhase && args[0] === "ses_grandchild") {
      freshAccounting = page.accounting.filter(row => row.usage).map(row => row.usage?.costUsd);
      freshPrompts = (page.completeItems ?? page.items).flatMap(item => item.type === "user_message" ? [item.text] : []);
      completePages[1] = page.visibleDescendantsIncomplete !== true;
    }
    if (rootPhase && args[0] === "ses_child") {
      freshMembers = (page.completeItems ?? page.items).flatMap(item => item.type === "tool"
        ? [{ id: item.id, child: item.childConversationId, name: item.name, status: item.status, createdAt: item.createdAt, completedAt: item.completedAt, input: item.input }] : []);
      contradictions = page.workerAssociationContradictions ?? [];
      completePages[0] = page.visibleDescendantsIncomplete !== true;
    }
    return page;
  };
  let applied!: () => void;
  provider.events = async function* (signal) { for await (const event of events(signal)) {
    if (!rootOnly && event.eventType === "diagnostic.recursive.applied") applied();
    yield event;
    if (rootOnly && event.eventType === "diagnostic.recursive.applied") applied();
  } };
  const emit = async (batch: Array<Record<string, unknown>>) => {
    const ready = new Promise<void>(resolve => { applied = resolve; });
    for (const event of [...batch, { type: "diagnostic.recursive.applied", data: {} }])
      wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ ...event, location: { directory: WORKSPACE } })}\n\n`));
    await ready;
  };
  const adapter = new ChatAdapter({ provider, workspacePath: WORKSPACE, coalesceWindowMs: 0, ...(retired ? { historyReadTimeoutMs: 500 } : {}) });
  const history = adapter.history.bind(adapter);
  adapter.history = (...args) => {
    const tracked = rootPhase && args[0] === "ses_child";
    if (tracked) explicitIntermediateReads++;
    const read = history(...args);
    return tracked ? read.then(snapshot => { completedIntermediateReads++; return snapshot; }) : read;
  };
  const now = Date.now(); let elapsed = 0;
  const clock = spyOn(Date, "now").mockImplementation(() => now + elapsed);
  let observer: Awaited<ReturnType<ChatAdapter["subscribe"]>> | undefined;
  let pendingRoot: ReturnType<ChatAdapter["history"]> | undefined;
  const tools = (items: import("../../types").ConversationItem[]) => items.filter((item): item is import("../../types").ToolItem => item.type === "tool");
  const direct = (items: import("../../types").ConversationItem[]) => ["first", "second"].map(id => tools(items).find(row => row.id === `tool:${id}`)?.usage?.costUsd);
  const nested = (items: import("../../types").ConversationItem[]) => ["first", "second"].map(id => tools(items).find(row => row.id === "tool:root")?.descendants?.find(line => line.id === `tool:${id}`)?.usage?.costUsd);
  try {
    expect(nested((await adapter.history("ses_root")).items)).toEqual([0.1, 0.2]);
    expect(direct((await adapter.history("ses_child")).items)).toEqual([0.1, 0.2]);
    // Invalidate native lookup/page reuse without retiring the stream generation.
    await emit(["ses_grandchild", "ses_child"].map(id => ({ type: "session.updated", created: 90, data: { info: session(id, { parentID: id === "ses_child" ? "ses_root" : "ses_child" }) } })));
    if (!healthy) {
      if (occurrence) { changed.time.created++; changed.content[0].time.created++; changed.content[0].time.completed++; }
      else changed.content[0].state.input.prompt = `Changed ${changedFirst ? "first" : "second"} task`;
      degraded = true;
    }
    const withdrawn = await adapter.history("ses_child");
    const retained = healthy ? [0.1, 0.2] : changedFirst ? [undefined, 0.2] : [0.1, undefined];
    expect(direct(withdrawn.items)).toEqual(retained);
    if (!healthy) {
      const rejected = tools(withdrawn.items).find(row => row.id === `tool:${changedFirst ? "first" : "second"}`);
      for (const key of ["childConversationId", "usage", "model", "workerSession"]) expect(rejected).not.toHaveProperty(key);
    }
    const reads = server.requests("GET", "/api/session/ses_grandchild/message").length;
    degraded = false;
    if (surface === "live" && !recovery) observer = await adapter.subscribe("ses_root");
    // A newly verified launcher restatement is not new grandchild task evidence.
    await emit([{ id: "evt_recursive_restatement", type: "session.message.content.updated", created: changed.time.created,
      durable: { aggregateID: "ses_child", seq: ++sequence, version: 1 }, data: { sessionID: "ses_child", messageID: changed.id, content: changed.content } }]);
    expect(server.requests("GET", "/api/session/ses_grandchild/message").length).toBe(reads);
    const child = await adapter.subscribe("ses_child"); child.events.cancel();
    expect(direct(child.snapshot.items)).toEqual(retained);
    expect(tools(child.snapshot.items).find(row => row.id === `tool:${changedFirst ? "first" : "second"}`)).toMatchObject({
      input: JSON.stringify(changed.content[0].state.input), output: `${changedFirst ? "first" : "second"} result`,
    });
    let expected = retained;
    let rootHistory: Awaited<ReturnType<ChatAdapter["history"]>> | undefined, rootRepeat: Awaited<ReturnType<ChatAdapter["history"]>> | undefined;
    if (recovery) {
      rootPhase = rootOnly; freshSecondPrompt = second.content[0].state.input.prompt; fresh = !restatement; elapsed = rootOnly ? 0 : 31_000;
      if (reusedEarlier) { second.time.created--; second.content[0].time.created--; second.content[0].time.completed--; }
      if (unavailable) degraded = true;
      await emit(["ses_grandchild", "ses_child"].map(id => ({ type: "session.updated", created: 100, data: { info: session(id, { parentID: id === "ses_child" ? "ses_root" : "ses_child" }) } })));
      expected = rootDenied ? [undefined, undefined] : rootBlocked ? retained : [zero ? 0 : 0.4, 0.5];
      if (rootOnly) {
        if (surface === "live") observer = await adapter.subscribe("ses_root");
        if (retired || rootGeneration || changedSource || newerProof || newerPrivate || heldRecovery) {
          holdRoot = true; pendingRoot = rootOwner.run(true, () => adapter.history("ses_root"));
          void pendingRoot.catch(() => undefined); await rootReady;
          // Both nested inventories have completed, but no root publication
          // has happened. Reconstruction must not clear the deficit early.
          const beforePublication = await adapter.subscribe("ses_root"); beforePublication.events.cancel();
          expect(nested(beforePublication.snapshot.items)).toEqual(retained);
          const beforeChildPublication = await adapter.subscribe("ses_child"); beforeChildPublication.events.cancel();
          expect(direct(beforeChildPublication.snapshot.items)).toEqual(retained);
          if (retired || rootGeneration) {
            await emit([{ type: "session.step.ended", created: 25, data: { sessionID: "ses_grandchild", assistantMessageID: "first_spend", cost: 0.4 } }]);
            const restated = await adapter.subscribe("ses_root"); restated.events.cancel();
            expect(nested(restated.snapshot.items)).toEqual(retained);
          }
          if (retired) await new Promise<void>(resolve => { if (rootSignal!.aborted) resolve(); else rootSignal!.addEventListener("abort", () => resolve(), { once: true }); });
          else if (rootGeneration) { await adapter.stopEventPump(); holdFreshHistory = true; }
          else if (changedSource) { lateForeign = true; await provider.getSession("ses_grandchild"); }
          else if (newerPrivate) {
            const projection = adapter.projectionForTests("ses_root");
            const previous = tools(projection.items()).find(row => row.id === "tool:root")!;
            // Wire-equal replacement, but its cloned lines have no private
            // proof. The held read must not overwrite/retroactively renew it.
            projection.refreshEquivalentTool(previous, { ...previous, descendants: previous.descendants!.map(line => ({ ...line })) });
            expect(projection.get(previous.id)).toEqual(previous);
            expect(projection.get(previous.id)).not.toBe(previous);
          }
          else if (newerProof) {
            second.content[0].state.input.prompt = "A newer unproven second task";
            await emit([{ id: "evt_newer_nested_member", type: "session.message.content.updated", created: second.time.created,
              durable: { aggregateID: "ses_child", seq: ++sequence, version: 1 }, data: { sessionID: "ses_child", messageID: second.id, content: second.content } }]);
          }
          releaseRoot();
          if (retired || rootGeneration) await expect(pendingRoot).rejects.toThrow();
          else rootHistory = await pendingRoot;
          if (rootGeneration) { void adapter.startEventPump(); await provider.waitForEventStream(AbortSignal.timeout(3_000)); }
        } else rootHistory = await adapter.history("ses_root");
        if (!retired && !rootGeneration) rootRepeat = await adapter.history("ses_root", { limit: 49 });
        if (rootGeneration) expect(completedIntermediateReads).toBe(0); else expect(explicitIntermediateReads).toBe(0);
        expect(freshAccounting).toEqual(unavailable || foreignParent || foreignWorkspace ? [] : restatement ? [0.1, 0.2] : [zero ? 0 : 0.4, 0.5]);
        if (rootDenied) expect(contradictions).toContain("ses_grandchild");
        else if (!unavailable && !missingMember) expect(freshMembers).toEqual([
          { id: "tool:first", child: "ses_grandchild", name: "subagent", status: "completed", createdAt: 20, completedAt: 30, input: JSON.stringify(first.content[0].state.input) },
          { id: "tool:second", child: "ses_grandchild", name: "subagent", status: "completed", createdAt: reusedEarlier ? 59 : 60, completedAt: reusedEarlier ? 69 : 70, input: JSON.stringify(second.content[0].state.input) },
        ]);
        if (!unavailable && !rootDenied) {
          expect(completePages).toEqual([true, true]);
          expect(freshPrompts).toEqual(["First task", restatement ? "Second task" : freshSecondPrompt]);
        }
        expect(elapsed).toBe(0);
      } else expect(direct((await adapter.history("ses_child")).items)).toEqual(expected);
      if (!unavailable && !foreignParent && !foreignWorkspace) expect(server.requests("GET", "/api/session/ses_grandchild/message").length).toBeGreaterThan(reads);
      if (surface === "live" && !rootOnly) observer = await adapter.subscribe("ses_root");
      // Reuse freshly published accounting; the restatement itself is still
      // not what grants allocation eligibility.
      await emit(unavailable || rootDenied ? [] : [
        ...(restatement ? [{ type: "session.step.started", created: 25, data: { sessionID: "ses_grandchild", assistantMessageID: "first_spend", started: 25, model: { providerID: "fixture", id: "restated-model" } } }] : []),
        { type: "session.step.ended", created: 25, data: { sessionID: "ses_grandchild", assistantMessageID: "first_spend", cost: zero ? 0 : 0.4 } },
      ]);
      if (retired || rootGeneration || restatement) {
        const current = await adapter.subscribe("ses_child"); current.events.cancel();
        expect(direct(current.snapshot.items)).toEqual(retained);
      }
    }
    let ancestorItems: import("../../types").ConversationItem[];
    if (surface === "history") ancestorItems = (rootHistory ?? await adapter.history("ses_root")).items;
    else if (surface === "live") {
      observer!.events.cancel();
      const projected = new Map(observer!.snapshot.items.map(item => [item.id, item]));
      for await (const event of observer!.events) {
        if (event.type === "item.upsert") projected.set(event.item.id, event.item);
        if (event.type === "item.remove") projected.delete(event.itemId);
      }
      ancestorItems = [...projected.values()];
    } else { const ancestor = await adapter.subscribe("ses_root"); ancestor.events.cancel(); ancestorItems = ancestor.snapshot.items; }
    expect(tools(ancestorItems).find(row => row.id === "tool:root")).toMatchObject({ usage: { costUsd: 0.05 }, workerSession: { costUsd: 0.05 } });
    expect(opened).toBe(rootGeneration ? 2 : 1);
    expect(server.calls.every(call => call.method === "GET")).toBe(true);
    if (rootOnly) {
      const following = await adapter.subscribe("ses_root"); following.events.cancel();
      const snapshots = [...(rootHistory ? [rootHistory] : []), ...(rootRepeat ? [rootRepeat] : []), following.snapshot];
      for (const snapshot of snapshots) {
        expect(tools(snapshot.items).find(row => row.id === "tool:root")).toMatchObject({ usage: { costUsd: 0.05 }, workerSession: { costUsd: 0.05 } });
        const ids = tools(snapshot.items).find(row => row.id === "tool:root")?.descendants?.map(line => line.id) ?? [];
        if (missingMember) expect(ids).toContain("tool:first");
        else expect(ids).toEqual(rootDenied ? [] : ["tool:first", "tool:second"]);
      }
      if (rootGeneration) expect(completedIntermediateReads).toBe(0); else expect(explicitIntermediateReads).toBe(0);
      expect(snapshots.map(snapshot => nested(snapshot.items))).toEqual(snapshots.map(() => expected));
      for (const snapshot of snapshots) expect(conversationTotals(snapshot.items)?.costUsd).toBeCloseTo(0.05 + (expected[0] ?? 0) + (expected[1] ?? 0));
    }
    if (!recovery && surface !== "history") expect(server.requests("GET", "/api/session/ses_grandchild/message").length).toBe(reads);
    expect(nested(ancestorItems)).toEqual(expected);
    const lines = tools(ancestorItems).find(row => row.id === "tool:root")?.descendants;
    if (!rootDenied && !missingMember) expect(lines).toHaveLength(2);
    for (const [index, id] of ["first", "second"].entries()) {
      const line = lines?.find(line => line.id === `tool:${id}`);
      if (rootDenied || missingMember && line === undefined) { expect(line).toBeUndefined(); continue; }
      expect(line).toMatchObject({ parentId: "tool:root", conversationId: "ses_grandchild" });
      if (expected[index] === undefined) {
        expect(line).not.toHaveProperty("usage");
        expect(line).not.toHaveProperty("model");
      }
    }
  } finally { releaseRoot(); releaseFreshHistory(); await pendingRoot?.catch(() => undefined); observer?.events.cancel(); clock.mockRestore(); await adapter.dispose(); expect(closed).toBe(opened); }
});

for (const outcome of ["foreign-parent", "foreign-workspace", "unavailable", "pending-parent", "pending-workspace"] as const)
for (const stale of outcome.startsWith("pending-") ? [true] : outcome === "unavailable" ? [false] : [false, true])
test(`nested accounting reconciles scoped source authority (${outcome}/stale=${stale})`, async () => {
  const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
  const launch = (parent: string, child: string, call: string, created: number) => {
    const message = structuredClone(fixture.launch); message.sessionID = parent; message.id = `msg_${call}`; message.time.created = created;
    const tool = message.content[0]; tool.id = call; tool.state.input.background = false;
    tool.state.metadata = { sessionID: child, status: "completed" }; tool.state.content = [{ type: "text", text: "Done" }]; return message;
  };
  const prompt = (id: string, created = 1) => ({ id, type: "user", text: id, time: { created } });
  const priced = (cost: number) => ({ id: "priced", type: "assistant", time: { created: 2 }, model: { id: "stored" }, cost, content: [] });
  let mode: "foreign-parent" | "foreign-workspace" | "unavailable" | "healthy" = "healthy", boundary: string | undefined, foreignReads = 0, opened = 0, closed = 0;
  const pending = outcome.startsWith("pending-");
  let wire!: ReadableStreamDefaultController<Uint8Array>;
  const server = fakeOpenCode({
    "GET /api/event": ({ signal }) => new Response(new ReadableStream<Uint8Array>({ start(controller) {
      wire = controller; opened++; controller.enqueue(new TextEncoder().encode('data: {"type":"server.connected","data":{}}\n\n'));
      signal.addEventListener("abort", () => { closed++; controller.close(); }, { once: true });
    } }), { headers: { "content-type": "text/event-stream" } }),
    "GET /api/session": () => ({ data: [], cursor: {} }),
    "GET /api/session/ses_parent": () => session("ses_parent", boundary ? { revert: { messageID: boundary } } : {}),
    "GET /api/session/ses_child": () => session("ses_child", { parentID: "ses_parent", cost: 0.5 }),
    "GET /api/session/ses_grandchild": () => mode === "unavailable" ? new Response(null, { status: 503 }) : session("ses_grandchild", {
      parentID: mode === "foreign-parent" ? "ses_other" : "ses_child", cost: 0.25,
      ...(mode === "foreign-workspace" ? { location: { directory: "/foreign" } } : {}),
    }),
    "GET /api/session/ses_parent/message": () => ({ data: [prompt("first"), launch("ses_parent", "ses_child", "root", 20), prompt("later", 70)], cursor: {} }),
    "GET /api/session/ses_child/message": () => ({ data: [prompt("child"), priced(0.5), launch("ses_child", "ses_grandchild", "nested", 30)], cursor: {} }),
    "GET /api/session/ses_grandchild/message": () => { if (mode.startsWith("foreign-")) foreignReads++; return { data: [prompt("grandchild"), priced(0.25)], cursor: {} }; },
    "GET /api/session/:id/inbox": () => ({ data: [] }), "GET /api/session/active": () => ({}),
    "GET /api/permission/request": () => scoped([]), "GET /api/form": () => scoped([]),
    "POST /api/session/ses_parent/revert/stage": ({ body }) => { boundary = (body as { messageID: string }).messageID; return { messageID: boundary }; },
  });
  const provider = server.provider(), owner = new AsyncLocalStorage<boolean>();
  let invalidated!: () => void;
  const cacheInvalidated = new Promise<void>(resolve => { invalidated = resolve; });
  const events = provider.events.bind(provider);
  provider.events = async function* (signal) { for await (const event of events(signal)) { if (event.eventType === "session.updated") invalidated(); yield event; } };
  let armed = false, entered!: () => void, release!: () => void;
  const captured = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const list = provider.listMessages.bind(provider);
  provider.listMessages = async (...args) => {
    const page = await list(...args);
    if (armed && owner.getStore() && args[0] === "ses_child") { armed = false; entered(); await gate; }
    return page;
  };
  const adapter = new ChatAdapter({ provider, workspacePath: WORKSPACE, coalesceWindowMs: 0 });
  const now = Date.now(); let elapsed = 0;
  const clock = spyOn(Date, "now").mockImplementation(() => now + elapsed);
  let mutation: ReturnType<ChatAdapter["undo"]> | undefined;
  const row = (page: Awaited<ReturnType<ChatAdapter["history"]>>) => page.items.find(item => item.id === "tool:root") as import("../../types").ToolItem;
  try {
    const initial = await adapter.history("ses_parent");
    expect(row(initial).descendants).toContainEqual(expect.objectContaining({ conversationId: "ses_grandchild", usage: expect.objectContaining({ costUsd: 0.25 }) }));
    expect(row(initial).workerSession?.costUsd).toBe(0.5);
    elapsed = 31_000; mode = pending ? "unavailable" : outcome as typeof mode;
    if (pending) {
      // Expire ownership reuse through the real native invalidation seam;
      // failed verification must leave a captured unavailable observation.
      wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ id: "evt_refresh_nested", type: "session.updated", created: 1000, location: { directory: WORKSPACE }, data: { info: session("ses_grandchild", { parentID: "ses_child" }) } })}\n\n`));
      await cacheInvalidated;
    }
    await provider.getSession("ses_grandchild").catch(() => undefined);
    armed = stale;
    mutation = owner.run(true, () => adapter.undo("ses_parent", "nested-authority"));
    if (stale) { await captured; mode = pending ? outcome === "pending-parent" ? "foreign-parent" : "foreign-workspace" : "healthy"; await provider.getSession("ses_grandchild"); release(); }
    await mutation;
    const nextView = await adapter.subscribe("ses_parent"); nextView.events.cancel();
    const next = nextView.snapshot;
    expect(foreignReads).toBe(0);
    expect(row(next).workerSession?.costUsd).toBe(0.5);
    if (stale && !pending || outcome === "unavailable") expect(row(next).descendants).toContainEqual(expect.objectContaining({ conversationId: "ses_grandchild", usage: expect.objectContaining({ costUsd: 0.25 }) }));
    else expect((row(next).descendants ?? []).some(line => line.conversationId === "ses_grandchild")).toBe(false);
    mode = "healthy"; elapsed += 31_000; await provider.getSession("ses_grandchild");
    expect(row(await adapter.history("ses_parent")).descendants).toContainEqual(expect.objectContaining({ conversationId: "ses_grandchild", usage: expect.objectContaining({ costUsd: 0.25 }) }));
  } finally { release(); await mutation?.catch(() => undefined); clock.mockRestore(); await adapter.dispose(); expect(closed).toBe(opened); }
});

for (const read of ["history", "undo"] as const)
for (const outcome of ["foreign-parent", "foreign-workspace", "healthy", "unavailable", "unrelated", "restore", "successor", "cached", "cancel"] as const)
test(`nested source authority survives accounting until parent publication (${read}/${outcome})`, async () => {
  const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
  const launch = (parent: string, child: string, call: string, created: number) => {
    const message = structuredClone(fixture.launch); message.sessionID = parent; message.id = `msg_${call}`; message.time.created = created;
    const tool = message.content[0]; tool.id = call; tool.state.input.background = false;
    tool.state.metadata = { sessionID: child, status: "completed" }; tool.state.content = [{ type: "text", text: "Done" }]; return message;
  };
  const prompt = (id: string, created = 1) => ({ id, type: "user", text: id, time: { created } });
  const priced = (cost: number) => ({ id: "priced", type: "assistant", time: { created: 2 }, model: { id: "stored" }, cost, content: [] });
  let mode = "healthy", boundary: string | undefined, opened = 0, closed = 0, childReads = 0, grandchildReads = 0, foreignReads = 0;
  const server = fakeOpenCode({
    "GET /api/event": ({ signal }) => new Response(new ReadableStream<Uint8Array>({ start(controller) {
      opened++; controller.enqueue(new TextEncoder().encode('data: {"type":"server.connected","data":{}}\n\n'));
      signal.addEventListener("abort", () => { closed++; controller.close(); }, { once: true });
    } }), { headers: { "content-type": "text/event-stream" } }),
    "GET /api/session": () => ({ data: [], cursor: {} }),
    "GET /api/session/ses_parent": () => session("ses_parent", boundary ? { revert: { messageID: boundary } } : {}),
    "GET /api/session/ses_child": () => session("ses_child", { parentID: "ses_parent", cost: 0.5 }),
    "GET /api/session/ses_unrelated": () => session("ses_unrelated", { parentID: "ses_other" }),
    "GET /api/session/ses_grandchild": () => mode === "unavailable" ? new Response(null, { status: 503 }) : session("ses_grandchild", {
      parentID: mode === "foreign-parent" ? "ses_other" : "ses_child", cost: 0.25,
      ...(mode === "foreign-workspace" ? { location: { directory: "/foreign" } } : {}),
    }),
    "GET /api/session/ses_parent/message": () => ({ data: [prompt("first"), launch("ses_parent", "ses_child", "root", 20), prompt("later", 70)], cursor: {} }),
    "GET /api/session/ses_child/message": () => { childReads++; return { data: [prompt("child"), priced(0.5), launch("ses_child", "ses_grandchild", "nested", 30)], cursor: {} }; },
    "GET /api/session/ses_grandchild/message": () => { grandchildReads++; if (mode.startsWith("foreign-")) foreignReads++; return { data: [prompt("grandchild"), priced(0.25)], cursor: {} }; },
    "GET /api/session/:id/inbox": () => ({ data: [] }), "GET /api/session/active": () => ({}),
    "GET /api/permission/request": () => scoped([]), "GET /api/form": () => scoped([]),
    "POST /api/session/ses_parent/revert/stage": ({ body }) => { boundary = (body as { messageID: string }).messageID; return { messageID: boundary }; },
  });
  const provider = server.provider(), owner = new AsyncLocalStorage<boolean>();
  const recover = provider.reconcileBackgroundTasks.bind(provider);
  provider.reconcileBackgroundTasks = (...args) => owner.run(false, () => recover(...args));
  let armed = false, entered!: () => void, release!: () => void, accountingFinished = false, childPages = 0, grandchildPages = 0, foreignPages = 0;
  const captured = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const list = provider.listMessages.bind(provider);
  provider.listMessages = async (...args) => {
    if (args[0] === "ses_grandchild" && mode.startsWith("foreign-")) foreignPages++;
    const page = await list(...args);
    if (args[0] === "ses_child") childPages++;
    if (args[0] === "ses_grandchild") grandchildPages++;
    if (owner.getStore() && args[0] === "ses_child") {
      accountingFinished = false;
      args[1].signal?.addEventListener("abort", () => { accountingFinished = true; }, { once: true });
    }
    return page;
  };
  const adapter = new ChatAdapter({ provider, workspacePath: WORKSPACE, coalesceWindowMs: 0 });
  const now = Date.now(); let elapsed = 0;
  const clock = spyOn(Date, "now").mockImplementation(() => now + elapsed);
  const getBoundary = provider.getHistoryRevertBoundary.bind(provider);
  let boundaryCalls = 0, initialChildPages = 0, initialGrandchildPages = 0;
  provider.getHistoryRevertBoundary = async (...args) => {
    const marker = await getBoundary(...args);
    if (owner.getStore() && args[0] === "ses_parent") {
      boundaryCalls++;
      if (armed) {
        armed = false;
        // This is the parent FINAL boundary: both child accounting transport
        // owners have completed and the parent row has already been decorated.
        entered(); await gate;
      }
    }
    return marker;
  };
  let pending: Promise<unknown> | undefined;
  const row = (items: import("../../types").ConversationItem[]) => items.find(item => item.id === "tool:root") as import("../../types").ToolItem;
  try {
    const initial = await adapter.history("ses_parent");
    expect(row(initial.items).descendants).toContainEqual(expect.objectContaining({ conversationId: "ses_grandchild", usage: expect.objectContaining({ costUsd: 0.25 }) }));
    initialChildPages = childPages; initialGrandchildPages = grandchildPages;
    if (outcome !== "cached") elapsed = 31_000;
    armed = true;
    pending = owner.run(true, () => read === "undo" ? adapter.undo("ses_parent", "nested-final") : adapter.history("ses_parent", { limit: 97 }));
    await captured;
    expect(childReads).toBeGreaterThan(0); expect(grandchildReads).toBeGreaterThan(0);
    expect(accountingFinished || outcome === "cached").toBe(true);
    if (outcome !== "cached") {
      // The native message bytes may be reused within their covered stream;
      // these new public pages revalidate ownership and complete accounting.
      expect(childPages).toBeGreaterThan(initialChildPages);
      expect(grandchildPages).toBeGreaterThan(initialGrandchildPages);
    }
    const callsAtGate = boundaryCalls;
    mode = outcome === "cached" || outcome === "cancel" ? "foreign-parent" : outcome;
    if (outcome === "unrelated") await provider.getSession("ses_unrelated");
    else await provider.getSession("ses_grandchild").catch(error => { if (outcome !== "unavailable") throw error; });
    if (outcome === "restore" || outcome === "successor") {
      mode = "foreign-parent"; await provider.getSession("ses_grandchild");
      mode = "healthy"; await provider.getSession("ses_grandchild");
      if (outcome === "successor") {
        const newer = await adapter.history("ses_parent", { limit: 98 });
        expect(row(newer.items).descendants).toContainEqual(expect.objectContaining({ conversationId: "ses_grandchild", usage: expect.objectContaining({ costUsd: 0.25 }) }));
      }
    }
    if (outcome === "cancel") await adapter.stopEventPump();
    release(); const result = await pending.catch(error => error);
    if (outcome === "cancel") {
      if (read === "history") expect(result).toBeInstanceOf(Error);
      mode = "healthy";
      await adapter.history("ses_parent");
    } else expect(result).not.toBeInstanceOf(Error);
    const next = await adapter.subscribe("ses_parent"); next.events.cancel();
    const current = row(next.snapshot.items);
    expect(current.workerSession?.costUsd).toBe(0.5); expect(foreignReads).toBe(0); expect(foreignPages).toBe(0);
    expect(next.snapshot).not.toHaveProperty("workerSource");
    expect(next.snapshot).not.toHaveProperty("isWorkerSourceCurrent");
    if (outcome.startsWith("foreign-") || outcome === "cached") expect((current.descendants ?? []).some(line => line.conversationId === "ses_grandchild")).toBe(false);
    else expect(current.descendants).toContainEqual(expect.objectContaining({ conversationId: "ses_grandchild", usage: expect.objectContaining({ costUsd: 0.25 }) }));
    if (["healthy", "unavailable", "unrelated"].includes(outcome)) expect(boundaryCalls).toBe(callsAtGate);
    if (read === "history" && outcome !== "cancel") expect(row((result as Awaited<ReturnType<ChatAdapter["history"]>>).items)).toEqual(current);
  } finally { release(); await pending?.catch(() => undefined); clock.mockRestore(); await adapter.dispose(); expect(closed).toBe(opened); }
});

for (const read of ["history", "undo"] as const) for (const target of ["ses_grandchild", "ses_leaf"] as const)
for (const outcome of ["foreign-parent", "foreign-workspace", "unavailable", "healthy", "successor", "cancel", "cached-foreign"] as const)
test(`cached nested source authority survives expiry before page transfer (${read}/${target}/${outcome})`, async () => {
  const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
  const launch = (parent: string, child: string, call: string, created: number) => {
    const message = structuredClone(fixture.launch); message.sessionID = parent; message.id = `msg_${call}`; message.time.created = created;
    const tool = message.content[0]; tool.id = call; tool.state.input.background = false;
    tool.state.metadata = { sessionID: child, status: "completed" }; tool.state.content = [{ type: "text", text: "Done" }]; return message;
  };
  const prompt = (id: string, created = 1) => ({ id, type: "user", text: id, time: { created } });
  const priced = (cost: number) => ({ id: "priced", type: "assistant", time: { created: 2 }, model: { id: "stored" }, cost, content: [] });
  const owners: Record<string, string> = { ses_child: "ses_parent", ses_grandchild: "ses_child", ses_leaf: "ses_grandchild" };
  const prices: Record<string, number> = { ses_child: 0.5, ses_grandchild: 0.25, ses_leaf: 0.125 };
  let mode = "healthy", boundary: string | undefined, holdChild = false, opened = 0, closed = 0, heldReads = 0, expiredReads = 0, childPages = 0, expiredPages = 0, foreignReads = 0;
  let freshOwn = 0.5, releaseAutomatic!: () => void;
  const isolateAutomatic = read === "undo" && outcome === "unavailable";
  const automaticGate = new Promise<void>(resolve => { releaseAutomatic = resolve; });
  let releaseChild!: () => void;
  const childGate = new Promise<void>(resolve => { releaseChild = resolve; });
  const nativeBodies: Promise<unknown>[] = [], reads: Promise<unknown>[] = [];
  const owner = new AsyncLocalStorage<boolean>();
  const server = fakeOpenCode({
    "GET /api/event": ({ signal }) => new Response(new ReadableStream<Uint8Array>({ start(controller) {
      opened++; controller.enqueue(new TextEncoder().encode('data: {"type":"server.connected","data":{}}\n\n'));
      signal.addEventListener("abort", () => { closed++; controller.close(); }, { once: true });
    } }), { headers: { "content-type": "text/event-stream" } }),
    "GET /api/session": () => ({ data: [], cursor: {} }),
    "GET /api/session/ses_parent": () => session("ses_parent", boundary ? { revert: { messageID: boundary } } : {}),
    "GET /api/session/:id": ({ path: route }) => {
      const id = route.split("/").at(-1)!;
      if (id === target && mode === "unavailable") return new Response(null, { status: 503 });
      return session(id, { parentID: id === target && mode === "foreign-parent" ? "ses_other" : owners[id], cost: prices[id],
        ...(id === target && mode === "foreign-workspace" ? { location: { directory: "/foreign" } } : {}) });
    },
    "GET /api/session/ses_parent/message": () => ({ data: [prompt("first"), launch("ses_parent", "ses_child", "root", 20), prompt("later", 70)], cursor: {} }),
    "GET /api/session/ses_other/message": () => ({ data: [prompt("other"), launch("ses_other", target, "other", 20)], cursor: {} }),
    "GET /api/session/ses_child/message": ({ signal }) => {
      if (!holdChild) return { data: [prompt("child"), priced(freshOwn), launch("ses_child", "ses_grandchild", "nested", 30)], cursor: {} };
      heldReads++; signal.addEventListener("abort", () => { expiredReads++; }, { once: true });
      // Deliberately uncooperative native transport. No source page can be
      // transferred before the unchanged one-second accounting deadline.
      const body = childGate.then(() => ({ data: [prompt("child"), priced(99), launch("ses_child", "ses_grandchild", "nested", 30)], cursor: {} }));
      nativeBodies.push(body); return body;
    },
    "GET /api/session/ses_grandchild/message": () => { if (target === "ses_grandchild" && mode.startsWith("foreign-")) foreignReads++; return { data: [prompt("grandchild"), priced(0.25), launch("ses_grandchild", "ses_leaf", "leaf", 30)], cursor: {} }; },
    "GET /api/session/ses_leaf/message": () => { if (target === "ses_leaf" && mode.startsWith("foreign-")) foreignReads++; return { data: [prompt("leaf"), priced(0.125)], cursor: {} }; },
    "GET /api/session/:id/inbox": () => ({ data: [] }), "GET /api/session/active": () => ({}),
    "GET /api/permission/request": () => scoped([]), "GET /api/form": () => scoped([]),
    "POST /api/session/ses_parent/revert/stage": ({ body }) => { boundary = (body as { messageID: string }).messageID; return { messageID: boundary }; },
  });
  const provider = server.provider(), recover = provider.reconcileBackgroundTasks.bind(provider);
  provider.reconcileBackgroundTasks = (...args) => owner.run(false, () => recover(...args));
  const list = provider.listMessages.bind(provider);
  provider.listMessages = async (...args) => {
    // A reconnect retry can legitimately start a new owner after the first
    // expires, for either unavailable nested target. Keep its current page
    // out of the expired-owner assertions, then verify fresh recovery below.
    if (isolateAutomatic && holdChild && args[0] === "ses_child" && !owner.getStore() && expiredReads > 0) await automaticGate;
    const pending = list(...args).then(page => {
      if (holdChild && args[0] === "ses_child") { childPages++; if (args[1].signal?.aborted) expiredPages++; }
      return page;
    });
    reads.push(pending); void pending.catch(() => undefined); return pending;
  };
  let armed = false, entered!: () => void, releaseBoundary!: () => void, finalBoundaries = 0;
  const captured = new Promise<void>(resolve => { entered = resolve; }), boundaryGate = new Promise<void>(resolve => { releaseBoundary = resolve; });
  const getBoundary = provider.getHistoryRevertBoundary.bind(provider);
  provider.getHistoryRevertBoundary = async (...args) => {
    const marker = await getBoundary(...args);
    if (owner.getStore() && args[0] === "ses_parent") {
      finalBoundaries++;
      if (armed) { armed = false; entered(); await boundaryGate; }
    }
    return marker;
  };
  const adapter = new ChatAdapter({ provider, workspacePath: WORKSPACE, coalesceWindowMs: 0 });
  let pending: Promise<unknown> | undefined;
  const row = (items: import("../../types").ConversationItem[]) => items.find(item => item.id === "tool:root") as import("../../types").ToolItem;
  const assert = (items: import("../../types").ConversationItem[], foreign: boolean) => {
    const root = row(items);
    expect(root.workerSession?.costUsd).toBe(0.5);
    const lines = root.descendants ?? [];
    expect(lines.some(line => line.conversationId === target)).toBe(!foreign);
    if (foreign && target === "ses_grandchild") expect(lines.some(line => line.conversationId === "ses_leaf")).toBe(false);
    else expect(lines).toContainEqual(expect.objectContaining({ conversationId: "ses_grandchild", usage: expect.objectContaining({ costUsd: 0.25 }) }));
    if (!foreign) expect(lines).toContainEqual(expect.objectContaining({ conversationId: "ses_leaf", usage: expect.objectContaining({ costUsd: 0.125 }) }));
  };
  try {
    assert((await adapter.history("ses_parent")).items, false);
    await adapter.stopEventPump(); // Force a fresh native child GET, retaining the cached tree.
    holdChild = true;
    // Keep automatic reconnect work outside this operation's AsyncLocalStorage
    // owner: only the requested history/undo may enter the final-boundary gate.
    void adapter.startEventPump();
    await provider.waitForEventStream!(AbortSignal.timeout(5_000));
    if (outcome === "cached-foreign") {
      // A healthy lookup for another parent is positive counterproof for this
      // cached edge. The watch must consume it even with no later observation.
      mode = "foreign-parent";
      const lifetime = new AbortController();
      try { await provider.listMessages("ses_other", { limit: 100, signal: lifetime.signal }); }
      finally { lifetime.abort(); }
    }
    armed = true;
    pending = owner.run(true, () => read === "history" ? adapter.history("ses_parent", { limit: 97 }) : adapter.undo("ses_parent", "expired-nested"));
    void pending.catch(() => undefined);
    await captured;
    expect(heldReads).toBeGreaterThan(0); expect(expiredReads).toBe(heldReads); expect(childPages).toBe(0);
    const boundariesAtGate = finalBoundaries;
    mode = outcome === "cancel" || outcome === "successor" || outcome === "cached-foreign" ? "foreign-parent" : outcome;
    if (outcome !== "cached-foreign") await provider.getSession(target).catch(error => { if (outcome !== "unavailable") throw error; });
    if (outcome === "successor") {
      mode = "healthy"; await provider.getSession(target);
      assert((await adapter.history("ses_parent", { limit: 98 })).items, false);
    }
    if (outcome === "cancel") {
      await adapter.stopEventPump(); mode = "healthy";
      assert((await adapter.history("ses_parent", { limit: 98 })).items, false);
    }
    releaseBoundary(); const result = await pending.catch(error => error);
    if (outcome === "cancel") { if (read === "history") expect(result).toBeInstanceOf(Error); }
    else expect(result).not.toBeInstanceOf(Error);
    const next = await adapter.subscribe("ses_parent"); next.events.cancel();
    const foreign = outcome.startsWith("foreign-") || outcome === "cached-foreign";
    assert(next.snapshot.items, foreign);
    if (read === "history" && outcome !== "cancel") assert((result as Awaited<ReturnType<ChatAdapter["history"]>>).items, foreign);
    if (outcome === "healthy" || outcome === "unavailable") expect(finalBoundaries).toBe(boundariesAtGate);
    releaseChild(); await Promise.allSettled(nativeBodies); await Promise.allSettled(reads);
    const afterLate = await adapter.subscribe("ses_parent"); afterLate.events.cancel();
    assert(afterLate.snapshot.items, foreign);
    expect(foreignReads).toBe(0); expect(expiredPages).toBe(0);
    if (isolateAutomatic) {
      // New authority remains able to publish, independently of the retired
      // $99 response and without inheriting a permanent retry barrier.
      holdChild = false; mode = "healthy"; freshOwn = 0.625; prices.ses_child = 0.625;
      releaseAutomatic(); await adapter.stopEventPump();
      const fresh = await adapter.history("ses_parent", { limit: 98 });
      expect(row(fresh.items)).toMatchObject({ usage: { costUsd: 0.625 }, workerSession: { costUsd: 0.625 } });
      expect(row(fresh.items).descendants).toContainEqual(expect.objectContaining({ conversationId: "ses_grandchild", usage: { costUsd: 0.25 } }));
      expect(row(fresh.items).descendants).toContainEqual(expect.objectContaining({ conversationId: "ses_leaf", usage: { costUsd: 0.125 } }));
    }
  } finally { releaseAutomatic(); releaseChild(); releaseBoundary(); await pending?.catch(() => undefined); await Promise.allSettled(nativeBodies); await Promise.allSettled(reads); await adapter.dispose(); expect(closed).toBe(opened); }
}, 10_000);

for (const read of ["history", "undo"] as const) for (const target of ["ses_grandchild", "ses_leaf"] as const)
for (const outcome of ["foreign-parent", "foreign-workspace", "unavailable", "healthy", "unrelated", "new-positive", "new-generation"] as const)
for (const arrival of read === "undo" && target === "ses_leaf" && outcome.startsWith("foreign-") ? ["bank", "seed", "replace", "upsert"] as const : ["bank"] as const)
test(`concurrent cached source authority covers newly published nested edges (${read}/${target}/${outcome}/${arrival})`, async () => {
  const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
  const launch = (parent: string, child: string, call: string, created: number) => {
    const message = structuredClone(fixture.launch); message.sessionID = parent; message.id = `msg_${call}`; message.time.created = created;
    const tool = message.content[0]; tool.id = call; tool.state.input.background = false;
    tool.state.metadata = { sessionID: child, status: "completed" }; tool.state.content = [{ type: "text", text: "Done" }]; return message;
  };
  const prompt = (id: string, created = 1) => ({ id, type: "user", text: id, time: { created } });
  const priced = (cost: number) => ({ id: "priced", type: "assistant", time: { created: 2 }, model: { id: "stored" }, cost, content: [] });
  const parents: Record<string, string> = { ses_child: "ses_parent", ses_grandchild: "ses_child", ses_leaf: "ses_grandchild" };
  const prices: Record<string, number> = { ses_child: 0.5, ses_grandchild: 0.25, ses_leaf: 0.125 };
  const owner = new AsyncLocalStorage<"older" | "newer" | undefined>();
  let mode = "healthy", boundary: string | undefined, opened = 0, closed = 0, heldReads = 0, expiredReads = 0, oldPages = 0, foreignReads = 0;
  let releaseChild!: () => void, releaseBoundary!: () => void, entered!: () => void;
  const childGate = new Promise<void>(resolve => { releaseChild = resolve; }), finalGate = new Promise<void>(resolve => { releaseBoundary = resolve; }), captured = new Promise<void>(resolve => { entered = resolve; });
  const nativeBodies: Promise<unknown>[] = [], messageReads: Promise<unknown>[] = [];
  const server = fakeOpenCode({
    "GET /api/event": ({ signal }) => new Response(new ReadableStream<Uint8Array>({ start(controller) {
      opened++; controller.enqueue(new TextEncoder().encode('data: {"type":"server.connected","data":{}}\n\n'));
      signal.addEventListener("abort", () => { closed++; controller.close(); }, { once: true });
    } }), { headers: { "content-type": "text/event-stream" } }),
    "GET /api/session": () => ({ data: [], cursor: {} }),
    "GET /api/session/ses_parent": () => session("ses_parent", boundary ? { revert: { messageID: boundary } } : {}),
    "GET /api/session/ses_unrelated": () => session("ses_unrelated", { parentID: "ses_other" }),
    "GET /api/session/:id": ({ path: route }) => {
      const id = route.split("/").at(-1)!;
      if (id === target && mode === "unavailable") return new Response(null, { status: 503 });
      return session(id, { parentID: id === target && mode === "foreign-parent" ? "ses_other" : parents[id], cost: prices[id],
        ...(id === target && mode === "foreign-workspace" ? { location: { directory: "/foreign" } } : {}) });
    },
    "GET /api/session/ses_parent/message": () => ({ data: [prompt("first"), launch("ses_parent", "ses_child", "root", 20), prompt("later", 70)], cursor: {} }),
    "GET /api/session/ses_child/message": ({ signal }) => {
      const data = [prompt("child"), priced(0.5), launch("ses_child", "ses_grandchild", "nested", 30), launch("ses_child", "ses_grandchild", "nested_alias", 40)];
      if (owner.getStore() !== "older" || heldReads) return { data, cursor: {} };
      heldReads++; signal.addEventListener("abort", () => { expiredReads++; }, { once: true });
      const body = childGate.then(() => ({ data, cursor: {} })); nativeBodies.push(body); return body;
    },
    "GET /api/session/ses_grandchild/message": () => { if (target === "ses_grandchild" && mode.startsWith("foreign-")) foreignReads++; return { data: [prompt("grandchild"), priced(0.25), launch("ses_grandchild", "ses_leaf", "leaf", 30)], cursor: {} }; },
    "GET /api/session/ses_leaf/message": () => { if (target === "ses_leaf" && mode.startsWith("foreign-")) foreignReads++; return { data: [prompt("leaf"), priced(0.125)], cursor: {} }; },
    "GET /api/session/:id/inbox": () => ({ data: [] }), "GET /api/session/active": () => ({}),
    "GET /api/permission/request": () => scoped([]), "GET /api/form": () => scoped([]),
    "POST /api/session/ses_parent/revert/stage": ({ body }) => { boundary = (body as { messageID: string }).messageID; return { messageID: boundary }; },
  });
  const provider = server.provider(), recover = provider.reconcileBackgroundTasks.bind(provider);
  provider.reconcileBackgroundTasks = (...args) => owner.run(undefined, () => recover(...args));
  const producerProvider = arrival === "bank" ? provider : server.provider();
  const producerSignals: AbortSignal[] = [], producerGuards: Array<() => boolean> = [];
  for (const observed of new Set([provider, producerProvider])) {
    const list = observed.listMessages.bind(observed);
    observed.listMessages = (...args) => {
      const tag = owner.getStore();
      const pending = list(...args).then(page => {
        if (tag === "older" && args[0] === "ses_child") oldPages++;
        if (tag === "newer") { if (args[1].signal) producerSignals.push(args[1].signal); if (page.isWorkerSourceCurrent) producerGuards.push(page.isWorkerSourceCurrent); }
        return page;
      });
      messageReads.push(pending); void pending.catch(() => undefined); return pending;
    };
  }
  let armed = true, oldBoundaries = 0;
  const getBoundary = provider.getHistoryRevertBoundary.bind(provider);
  provider.getHistoryRevertBoundary = async (...args) => {
    const marker = await getBoundary(...args);
    if (owner.getStore() === "older" && args[0] === "ses_parent") {
      oldBoundaries++;
      if (armed) { armed = false; entered(); await finalGate; }
    }
    return marker;
  };
  const adapter = new ChatAdapter({ provider, workspacePath: WORKSPACE, coalesceWindowMs: 0 });
  const producer = arrival === "bank" ? adapter : new ChatAdapter({ provider: producerProvider, workspacePath: WORKSPACE, coalesceWindowMs: 0 });
  let older: Promise<unknown> | undefined;
  const assert = (items: import("../../types").ConversationItem[], foreign: boolean) => {
    const row = items.find(item => item.id === "tool:root") as import("../../types").ToolItem;
    expect(row.workerSession?.costUsd).toBe(0.5);
    const lines = row.descendants ?? [];
    expect(lines.some(line => line.conversationId === target)).toBe(!foreign);
    if (foreign && target === "ses_grandchild") expect(lines.some(line => line.conversationId === "ses_leaf")).toBe(false);
    else expect(lines).toContainEqual(expect.objectContaining({ conversationId: "ses_grandchild", usage: expect.objectContaining({ costUsd: 0.25 }) }));
    if (!foreign) { expect(lines.filter(line => line.conversationId === "ses_grandchild")).toHaveLength(2); expect(lines.some(line => line.conversationId === "ses_leaf")).toBe(true); }
  };
  try {
    void adapter.startEventPump(); await provider.waitForEventStream!(AbortSignal.timeout(5_000));
    const cold = await adapter.subscribe("ses_parent"); cold.events.cancel(); expect(cold.snapshot.items).toEqual([]);
    older = owner.run("older", () => read === "history" ? adapter.history("ses_parent", { limit: 97 }) : adapter.undo("ses_parent", "concurrent-nested"));
    void older.catch(() => undefined);
    await captured;
    expect(heldReads).toBe(1); expect(expiredReads).toBe(1); expect(oldPages).toBe(0);
    const beforeProducer = await adapter.subscribe("ses_parent"); beforeProducer.events.cancel(); expect(beforeProducer.snapshot.items).toEqual([]);
    const newer = await owner.run("newer", () => producer.history("ses_parent", { limit: 98 }));
    assert(newer.items, false);
    if (arrival !== "bank") {
      // The receiving adapter has no accounting graph for these rows. Exercise
      // the projection's public publication paths with a real decorated copy.
      const projection = adapter.projectionForTests("ses_parent");
      if (arrival === "seed") projection.seed(newer.items);
      if (arrival === "replace") projection.replace(newer.items);
      if (arrival === "upsert") for (const item of newer.items) projection.upsert(item);
      await producer.dispose();
    }
    expect(producerSignals.length).toBeGreaterThan(2); expect(producerSignals.every(signal => signal.aborted)).toBe(true);
    expect(producerGuards.every(current => !current())).toBe(true); // Publishing reader has retired its sources.
    const boundariesAtGate = oldBoundaries;
    mode = outcome === "new-positive" || outcome === "new-generation" ? "foreign-parent" : outcome;
    if (outcome === "unrelated") await provider.getSession("ses_unrelated");
    else await provider.getSession(target).catch(error => { if (outcome !== "unavailable") throw error; });
    if (outcome === "new-positive" || outcome === "new-generation") {
      mode = "healthy"; await provider.getSession(target);
      if (outcome === "new-generation") await adapter.stopEventPump();
      assert((await adapter.history("ses_parent", { limit: 99 })).items, false);
    }
    releaseBoundary(); const result = await older.catch(error => error);
    if (outcome === "new-generation" && read === "history") expect(result).toBeInstanceOf(Error);
    else expect(result).not.toBeInstanceOf(Error);
    const next = await adapter.subscribe("ses_parent"); next.events.cancel(); assert(next.snapshot.items, outcome.startsWith("foreign-"));
    if (read === "history" && outcome !== "new-generation") assert((result as Awaited<ReturnType<ChatAdapter["history"]>>).items, outcome.startsWith("foreign-"));
    if (["healthy", "unavailable", "unrelated"].includes(outcome)) expect(oldBoundaries).toBe(boundariesAtGate);
    releaseChild(); await Promise.allSettled(nativeBodies); await Promise.allSettled(messageReads);
    const late = await adapter.subscribe("ses_parent"); late.events.cancel(); assert(late.snapshot.items, outcome.startsWith("foreign-"));
    expect(foreignReads).toBe(0);
  } finally { releaseChild(); releaseBoundary(); await older?.catch(() => undefined); await Promise.allSettled(nativeBodies); await Promise.allSettled(messageReads); if (producer !== adapter) await producer.dispose(); await adapter.dispose(); expect(closed).toBe(opened); }
}, 10_000);

for (const read of ["history", "undo"] as const) for (const target of ["ses_grandchild", "ses_leaf"] as const)
for (const outcome of ["foreign-parent", "foreign-workspace", "unavailable", "healthy", ...(read === "history" && target === "ses_leaf" ? ["new-positive", "new-generation"] : []), ...(read === "undo" && target === "ses_grandchild" ? ["returned-page"] : [])])
test(`projected source authority survives real attribution eviction (${read}/${target}/${outcome})`, async () => {
  const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
  const launch = (parent: string, child: string, call: string, created: number) => {
    const message = structuredClone(fixture.launch); message.sessionID = parent; message.id = `msg_${call}`; message.time.created = created;
    const tool = message.content[0]; tool.id = call; tool.state.input.background = false;
    tool.state.metadata = { sessionID: child, status: "completed" }; tool.state.content = [{ type: "text", text: "Done" }]; return message;
  };
  const prompt = (id: string, created = 1) => ({ id, type: "user", text: id, time: { created } });
  const priced = (cost: number) => ({ id: "priced", type: "assistant", time: { created: 2 }, model: { id: "stored" }, cost, content: [] });
  const parents: Record<string, string> = { ses_child: "ses_parent", ses_grandchild: "ses_child", ses_leaf: "ses_grandchild" };
  const prices: Record<string, number> = { ses_child: 0.5, ses_grandchild: 0.25, ses_leaf: 0.125 };
  const owner = new AsyncLocalStorage<boolean>();
  let mode = "healthy", boundary: string | undefined, holdChild = false, opened = 0, closed = 0, held = 0, expired = 0, pages = 0, transferred = 0, foreignReads = 0;
  let wire!: ReadableStreamDefaultController<Uint8Array>, releaseChild!: () => void, releaseBoundary!: () => void, entered!: () => void, pressureDone!: () => void;
  const childGate = new Promise<void>(resolve => { releaseChild = resolve; }), finalGate = new Promise<void>(resolve => { releaseBoundary = resolve; }), captured = new Promise<void>(resolve => { entered = resolve; }), pressureBarrier = new Promise<void>(resolve => { pressureDone = resolve; });
  const bodies: Promise<unknown>[] = [], reads: Promise<unknown>[] = [], pressureParents = new Set<string>();
  const server = fakeOpenCode({
    "GET /api/event": ({ signal }) => new Response(new ReadableStream<Uint8Array>({ start(controller) {
      wire = controller; opened++; controller.enqueue(new TextEncoder().encode('data: {"type":"server.connected","data":{}}\n\n'));
      signal.addEventListener("abort", () => { closed++; controller.close(); }, { once: true });
    } }), { headers: { "content-type": "text/event-stream" } }),
    "GET /api/session": () => ({ data: [], cursor: {} }),
    "GET /api/session/ses_parent": () => session("ses_parent", boundary ? { revert: { messageID: boundary } } : {}),
    "GET /api/session/ses_fresh": () => session("ses_fresh", { parentID: "ses_child" }),
    "GET /api/session/:id": ({ path: route }) => {
      const id = route.split("/").at(-1)!;
      if (id.startsWith("ses_pressure_child_")) { pressureParents.add(id); return session(id, { parentID: "ses_pressure" }); }
      if (id === target && mode === "unavailable") return new Response(null, { status: 503 });
      return session(id, { parentID: id === target && mode === "foreign-parent" ? "ses_other" : parents[id], cost: prices[id],
        ...(id === "ses_child" && holdChild && outcome === "returned-page" ? { revert: { messageID: "msg_nested" } } : {}),
        ...(id === target && mode === "foreign-workspace" ? { location: { directory: "/foreign" } } : {}) });
    },
    "GET /api/session/ses_parent/message": () => ({ data: [prompt("first"), launch("ses_parent", "ses_child", "root", 20), prompt("later", 70)], cursor: {} }),
    "GET /api/session/ses_child/message": ({ signal }) => {
      const data = [prompt("child"), priced(0.5), launch("ses_child", "ses_grandchild", "nested", 30), launch("ses_child", "ses_grandchild", "nested_alias", 40)];
      if (!holdChild) return { data, cursor: {} };
      if (outcome === "returned-page") return { data: [...data.slice(0, 2), launch("ses_child", "ses_fresh", "fresh", 25), ...data.slice(2)], cursor: {} };
      held++; signal.addEventListener("abort", () => { expired++; }, { once: true });
      const body = childGate.then(() => ({ data, cursor: {} })); bodies.push(body); return body;
    },
    "GET /api/session/ses_fresh/message": ({ signal }) => {
      held++; signal.addEventListener("abort", () => { expired++; }, { once: true });
      const body = childGate.then(() => ({ data: [], cursor: {} })); bodies.push(body); return body;
    },
    "GET /api/session/ses_grandchild/message": () => { if (target === "ses_grandchild" && mode.startsWith("foreign-")) foreignReads++; return { data: [prompt("grandchild"), priced(0.25), launch("ses_grandchild", "ses_leaf", "leaf", 30)], cursor: {} }; },
    "GET /api/session/ses_leaf/message": () => { if (target === "ses_leaf" && mode.startsWith("foreign-")) foreignReads++; return { data: [prompt("leaf"), priced(0.125)], cursor: {} }; },
    "GET /api/session/:id/message": () => ({ data: [], cursor: {} }),
    "GET /api/session/:id/inbox": () => ({ data: [] }), "GET /api/session/active": () => ({}),
    "GET /api/permission/request": () => scoped([]), "GET /api/form": () => scoped([]),
    "POST /api/session/ses_parent/revert/stage": ({ body }) => { boundary = (body as { messageID: string }).messageID; return { messageID: boundary }; },
  });
  const provider = server.provider(), recover = provider.reconcileBackgroundTasks.bind(provider);
  provider.reconcileBackgroundTasks = (...args) => owner.run(false, () => recover(...args));
  const events = provider.events.bind(provider);
  provider.events = async function* (signal) { for await (const event of events(signal)) { if (event.eventType === "diagnostic.pressure.complete") pressureDone(); yield event; } };
  const list = provider.listMessages.bind(provider);
  provider.listMessages = (...args) => {
    const pending = list(...args).then(page => {
      if (holdChild && args[0] === "ses_child") { transferred++; if (args[1].signal?.aborted) pages++; }
      return page;
    });
    reads.push(pending); void pending.catch(() => undefined); return pending;
  };
  let armed = false, boundaries = 0;
  const getBoundary = provider.getHistoryRevertBoundary.bind(provider);
  provider.getHistoryRevertBoundary = async (...args) => {
    const marker = await getBoundary(...args);
    if (owner.getStore() && args[0] === "ses_parent") { boundaries++; if (armed) { armed = false; entered(); await finalGate; } }
    return marker;
  };
  const adapter = new ChatAdapter({ provider, workspacePath: WORKSPACE, coalesceWindowMs: 0 });
  const lifetime = new AbortController(); let pending: Promise<unknown> | undefined;
  const root = (items: import("../../types").ConversationItem[]) => items.find(item => item.id === "tool:root") as import("../../types").ToolItem;
  const assert = (items: import("../../types").ConversationItem[], foreign: boolean) => {
    const row = root(items), lines = row.descendants ?? [];
    expect(row.workerSession?.costUsd).toBe(0.5);
    expect(lines.some(line => line.conversationId === target)).toBe(!foreign);
    if (foreign && target === "ses_grandchild") expect(lines.some(line => line.conversationId === "ses_leaf")).toBe(false);
    if (foreign && target === "ses_leaf") {
      expect(lines.filter(line => line.conversationId === "ses_grandchild")).toHaveLength(2);
      expect(lines).toContainEqual(expect.objectContaining({ conversationId: "ses_grandchild", usage: expect.objectContaining({ costUsd: 0.25 }) }));
    }
    if (!foreign) { expect(lines.filter(line => line.conversationId === "ses_grandchild")).toHaveLength(2); expect(lines.some(line => line.conversationId === "ses_leaf")).toBe(true); }
  };
  try {
    assert((await adapter.history("ses_parent")).items, false);
    const retained = await adapter.subscribe("ses_parent", { signal: lifetime.signal });
    const pressureOwner = await adapter.subscribe("ses_pressure", { signal: lifetime.signal });
    // Each delivered prompt traverses the real stream/parentage path and banks
    // a distinct child transcript under ses_pressure. The public 512-key budget
    // evicts the original tree; the subscribed parent projection stays pinned.
    for (let index = 0; index < 512; index++) {
      const sessionID = `ses_pressure_child_${index}`, inboxID = `pressure_prompt_${index}`;
      for (const event of [
        { id: `pressure_enqueued_${index}`, type: "session.inbox.enqueued", created: 1000 + index * 2, data: { sessionID, inboxID, item: { id: inboxID, type: "user", payload: { text: "Native pressure prompt" } } } },
        { id: `pressure_delivered_${index}`, type: "session.inbox.delivered", created: 1001 + index * 2, data: { sessionID, inboxID } },
      ]) wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ ...event, location: { directory: WORKSPACE } })}\n\n`));
    }
    wire.enqueue(new TextEncoder().encode('data: {"type":"diagnostic.pressure.complete","data":{}}\n\n'));
    await pressureBarrier;
    expect(pressureParents.size).toBe(512);
    const last = await adapter.subscribe("ses_pressure_child_511"); last.events.cancel();
    expect(last.snapshot.items).toContainEqual(expect.objectContaining({ id: "message:pressure_prompt_511", type: "user_message" }));
    const projectedOnly = await adapter.subscribe("ses_parent"); projectedOnly.events.cancel(); assert(projectedOnly.snapshot.items, false);
    // Invalidate native message reuse through its public fresh-read option,
    // without reconnect publications reintroducing watches for the old row.
    await provider.reconcileBackgroundTasks("ses_pressure", { fresh: true });
    holdChild = true;
    armed = true;
    pending = owner.run(true, () => read === "history" ? adapter.history("ses_parent", { limit: 97 }) : adapter.undo("ses_parent", "projected-eviction"));
    void pending.catch(() => undefined);
    await captured;
    expect(held).toBeGreaterThan(0); expect(expired).toBe(held); expect(pages).toBe(0);
    if (outcome === "returned-page") expect(transferred).toBeGreaterThan(0); else expect(transferred).toBe(0);
    const boundariesAtGate = boundaries;
    mode = outcome.startsWith("new-") ? "foreign-parent" : outcome;
    await provider.getSession(target).catch(error => { if (outcome !== "unavailable") throw error; });
    if (outcome.startsWith("new-")) {
      mode = "healthy"; await provider.getSession(target);
      if (outcome === "new-generation") await adapter.stopEventPump();
    }
    releaseBoundary(); const result = await pending.catch(error => error);
    if (outcome === "new-generation" && read === "history") expect(result).toBeInstanceOf(Error);
    else expect(result).not.toBeInstanceOf(Error);
    const foreign = outcome.startsWith("foreign-");
    const next = await adapter.subscribe("ses_parent"); next.events.cancel(); assert(next.snapshot.items, foreign || outcome === "returned-page");
    if (foreign && read === "history") expect((root((result as Awaited<ReturnType<ChatAdapter["history"]>>).items).descendants ?? []).some(line => line.conversationId === target)).toBe(false);
    if (outcome === "healthy" || outcome === "unavailable") expect(boundaries).toBe(boundariesAtGate);
    pressureOwner.events.cancel(); retained.events.cancel(); const publications = []; for await (const event of retained.events) publications.push(event);
    if (foreign) expect(publications.some(event => event.type === "resync" || event.type === "item.remove" && event.itemId === "tool:root")).toBe(true);
    if (foreign && read === "history") {
      expect(publications).toContainEqual(expect.objectContaining({ type: "item.remove", itemId: "tool:root" }));
      expect(publications.some(event => event.type === "item.upsert" && event.item.type === "tool" && event.item.id === "tool:root"
        && !(event.item.descendants ?? []).some(line => line.conversationId === target))).toBe(true);
    }
    releaseChild(); await Promise.allSettled(bodies); await Promise.allSettled(reads);
    const late = await adapter.subscribe("ses_parent"); late.events.cancel(); assert(late.snapshot.items, foreign || outcome === "returned-page");
    expect(foreignReads).toBe(0); expect(pages).toBe(0);
  } finally { releaseChild(); releaseBoundary(); lifetime.abort(); await pending?.catch(() => undefined); await Promise.allSettled(bodies); await Promise.allSettled(reads); await adapter.dispose(); expect(closed).toBe(opened); }
}, 20_000);

for (const read of ["history", "undo"] as const)
for (const outcome of ["lookup-503", "message-503", "returned-unknown", "returned-new", "foreign-parent", "foreign-workspace", "committed-away", "hidden-report", "changed-result", "reused-launch"] as const)
test(`worker accounting source authority survives real cache eviction (${read}/${outcome})`, async () => {
  const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
  const prompt = (id: string, created: number) => ({ id, type: "user", text: id, time: { created } });
  let changed = false, boundary: string | undefined, opened = 0, closed = 0, transferred = 0, foreignReads = 0;
  let wire!: ReadableStreamDefaultController<Uint8Array>, pressureDone!: () => void;
  const pressureBarrier = new Promise<void>(resolve => { pressureDone = resolve; }), pressureParents = new Set<string>();
  const workerId = "task:v2:ses_parent:call_worker";
  const server = fakeOpenCode({
    "GET /api/event": ({ signal }) => new Response(new ReadableStream<Uint8Array>({ start(controller) {
      wire = controller; opened++; controller.enqueue(new TextEncoder().encode('data: {"type":"server.connected","data":{}}\n\n'));
      signal.addEventListener("abort", () => { closed++; controller.close(); }, { once: true });
    } }), { headers: { "content-type": "text/event-stream" } }),
    "GET /api/session": () => ({ data: [], cursor: {} }),
    "GET /api/session/ses_parent": () => session("ses_parent", boundary ? { revert: { messageID: boundary } } : {}),
    "GET /api/session/ses_child": () => changed && outcome === "lookup-503" ? new Response(null, { status: 503 }) : session("ses_child", {
      parentID: changed && outcome === "foreign-parent" ? "ses_other" : "ses_parent",
      cost: changed && outcome === "returned-unknown" ? undefined : changed && outcome === "returned-new" ? 0.25 : 0.125,
      ...(changed && outcome === "foreign-workspace" ? { location: { directory: "/foreign" } } : {}),
    }),
    "GET /api/session/:id": ({ path: route }) => {
      const id = route.split("/").at(-1)!;
      if (id.startsWith("ses_pressure_child_")) { pressureParents.add(id); return session(id, { parentID: "ses_pressure" }); }
      return session(id);
    },
    "GET /api/session/ses_parent/message": () => {
      if (changed && outcome === "committed-away") return { data: [prompt("first", 1), prompt("replacement", 100)], cursor: {} };
      const launch = structuredClone(fixture.launch), report = structuredClone(fixture.stored);
      if (changed && outcome === "changed-result") { report.id = "msg_new_result"; report.time.created = 60; }
      if (changed && outcome === "reused-launch") {
        launch.time.created = 50; launch.content[0].time.created = 50; launch.content[0].time.completed = 55;
        report.time.created = 60; // Reused ids/child are not the old occurrence.
      }
      return { data: [prompt("first", 1), launch, ...(outcome === "hidden-report" ? [prompt("later", 30), report] : [report, prompt("later", 70)])], cursor: {} };
    },
    "GET /api/session/ses_child/message": () => {
      if (changed && outcome.startsWith("foreign-")) foreignReads++;
      if (changed && outcome !== "lookup-503" && !outcome.startsWith("returned-")) return new Response(null, { status: 503 });
      return { data: [prompt("child", 1), { id: "child-priced", type: "assistant", time: { created: 2 }, content: [],
        ...(changed && outcome === "returned-unknown" ? {} : { model: { id: changed ? "new-model" : "initial-model", variant: "high" }, cost: changed ? 0.25 : 0.125 }) }], cursor: {} };
    },
    "GET /api/session/:id/message": () => ({ data: [], cursor: {} }),
    "GET /api/session/:id/inbox": () => ({ data: [] }), "GET /api/session/active": () => ({}),
    "GET /api/permission/request": () => scoped([]), "GET /api/form": () => scoped([]),
    "POST /api/session/ses_parent/revert/stage": ({ body }) => { boundary = (body as { messageID: string }).messageID; return { messageID: boundary }; },
  });
  const provider = server.provider(), events = provider.events.bind(provider), list = provider.listMessages.bind(provider);
  provider.events = async function* (signal) { for await (const event of events(signal)) { if (event.eventType === "diagnostic.pressure.complete") pressureDone(); yield event; } };
  provider.listMessages = async (...args) => { const page = await list(...args); if (changed && args[0] === "ses_child") transferred++; return page; };
  const adapter = new ChatAdapter({ provider, workspacePath: WORKSPACE, coalesceWindowMs: 0 });
  const lifetime = new AbortController();
  const worker = (items: import("../../types").ConversationItem[]) => items.find(item => item.id === workerId) as import("../../types").BackgroundTaskItem | undefined;
  try {
    const initial = await adapter.history("ses_parent"), known = worker(initial.items)!.workerSession;
    expect(known).toMatchObject({ costUsd: 0.125, model: "initial-model" });
    const listener = await adapter.subscribe("ses_parent", { signal: lifetime.signal });
    await adapter.subscribe("ses_pressure", { signal: lifetime.signal });
    // Exercise the real 512-key budgets for transcripts, model metadata and
    // session totals. Keep the parent projections pinned throughout pressure.
    for (let index = 0; index < 512; index++) {
      const sessionID = `ses_pressure_child_${index}`, inboxID = `pressure_prompt_${index}`;
      for (const event of [
        { id: `pressure_enqueued_${index}`, type: "session.inbox.enqueued", created: 1000 + index * 4, data: { sessionID, inboxID, item: { id: inboxID, type: "user", payload: { text: "Native pressure prompt" } } } },
        { id: `pressure_delivered_${index}`, type: "session.inbox.delivered", created: 1001 + index * 4, data: { sessionID, inboxID } },
        { id: `pressure_model_${index}`, type: "session.step.started", created: 1002 + index * 4, data: { sessionID, assistantMessageID: `pressure_model_${index}`, model: { providerID: "fake", id: "pressure-model" } } },
        { id: `pressure_cost_${index}`, type: "session.usage.updated", created: 1003 + index * 4, data: { sessionID, cost: 0.01 } },
      ]) wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ ...event, location: { directory: WORKSPACE } })}\n\n`));
    }
    wire.enqueue(new TextEncoder().encode('data: {"type":"diagnostic.pressure.complete","data":{}}\n\n'));
    await pressureBarrier; expect(pressureParents.size).toBe(512);
    const retained = await adapter.subscribe("ses_parent"); retained.events.cancel(); expect(worker(retained.snapshot.items)?.workerSession).toEqual(known);
    await provider.reconcileBackgroundTasks("ses_pressure", { fresh: true });
    changed = true;
    if (outcome.startsWith("foreign-") || outcome === "message-503") await provider.getSession("ses_child");
    if (read === "history" && outcome === "hidden-report") boundary = "later";
    const action = read === "history" ? await adapter.history("ses_parent") : await adapter.undo("ses_parent", "worker-accounting-eviction");
    const next = await adapter.subscribe("ses_parent"); next.events.cancel();
    const history = await adapter.history("ses_parent");
    for (const snapshot of [...(read === "history" ? [action as Awaited<ReturnType<ChatAdapter["history"]>>] : []), next.snapshot, history]) {
      const current = worker(snapshot.items);
      if (outcome.startsWith("foreign-") || outcome === "committed-away") { expect(current).toBeUndefined(); continue; }
      expect(current).toBeDefined();
      if (outcome === "lookup-503" || outcome === "message-503") {
        expect(current?.workerSession).toEqual(known);
        expect(current).toMatchObject({ childConversationId: "ses_child", resultId: "msg_result", status: "completed", control: { available: false } });
      } else if (outcome === "returned-new") expect(current?.workerSession).toMatchObject({ costUsd: 0.25, model: "new-model" });
      else {
        expect(current?.workerSession?.costUsd ?? null).toBeNull(); expect(current?.workerSession?.model).not.toBe("initial-model");
        if (outcome === "hidden-report") {
          expect(current).not.toHaveProperty("resultId"); expect(current).not.toHaveProperty("summary"); expect(current).not.toHaveProperty("terminalReportedAt");
          expect(current).not.toHaveProperty("usage"); expect(current).toMatchObject({ status: "running", stateUncertain: true, control: { available: false } });
        }
      }
    }
    if (outcome.startsWith("returned-")) expect(transferred).toBeGreaterThan(0); else expect(transferred).toBe(0);
    expect(foreignReads).toBe(0);
    listener.events.cancel();
  } finally { lifetime.abort(); await adapter.dispose(); expect(closed).toBe(opened); }
}, 20_000);

for (const foreign of ["parent", "workspace"] as const)
test(`worker source authority cached watches snapshot revisions independently (${foreign})`, async () => {
  let negative = false;
  const server = fakeOpenCode({
    "GET /api/session/ses_child": () => session("ses_child", { parentID: negative && foreign === "parent" ? "ses_other" : "ses_parent",
      ...(negative && foreign === "workspace" ? { location: { directory: "/foreign" } } : {}) }),
    "GET /api/session/ses_unrelated": () => session("ses_unrelated", { parentID: "ses_elsewhere" }),
  });
  const provider = server.provider(), first = new AbortController(), second = new AbortController(), leases = new AbortController();
  try {
    const watch = provider.watchWorkerAssociations("ses_parent", [], { signal: first.signal });
    const peer = provider.watchWorkerAssociations("ses_parent", ["ses_child"], { signal: second.signal });
    const before = watch.snapshot(), sibling = peer.snapshot();
    expect(before.contradictedChildren).toEqual([]); expect(before.workerSource.isCurrent()).toBe(true);
    watch.include(["ses_child"]); // Extending a live snapshot is not itself a dirty read.
    expect(before.workerSource.isCurrent()).toBe(true);
    await provider.getSession("ses_child"); // Compatible first proof is not a retry loop.
    expect(before.workerSource.isCurrent()).toBe(true);
    await provider.getSession("ses_unrelated"); expect(before.workerSource.isCurrent()).toBe(true);
    negative = true; await provider.getSession("ses_child");
    expect(before.workerSource.isCurrent()).toBe(false); expect(sibling.workerSource.isCurrent()).toBe(false);
    const denied = watch.snapshot();
    expect(denied.contradictedChildren).toEqual(["ses_child"]); expect(denied.workerSource.isCurrent()).toBe(true);
    watch.include(["ses_child"]); // A repeated bank must not reset counterproof.
    expect(watch.snapshot().contradictedChildren).toEqual(["ses_child"]);
    expect(before.workerSource.retain(leases.signal).isCurrent()).toBe(false);
    first.abort(); expect(denied.workerSource.isCurrent()).toBe(false);
    expect(peer.snapshot().workerSource.isCurrent()).toBe(true);
    negative = false; await provider.getSession("ses_child");
    const renewed = peer.snapshot(); expect(renewed.contradictedChildren).toEqual([]); expect(renewed.workerSource.isCurrent()).toBe(true);
    expect(sibling.workerSource.isCurrent()).toBe(false);
  } finally { first.abort(); second.abort(); leases.abort(); await provider.dispose(); }
});

test("worker source authority cached watch consumes healthy foreign-parent cache without admitting ownership", async () => {
  const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
  const server = fakeOpenCode({
    "GET /api/event": ({ signal }) => new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"type":"server.connected","data":{}}\n\n'));
      signal.addEventListener("abort", () => { controller.close(); }, { once: true });
    } }), { headers: { "content-type": "text/event-stream" } }),
    "GET /api/session/ses_parent": () => session("ses_parent"),
    "GET /api/session/ses_child": () => session("ses_child", { parentID: "ses_parent" }),
    "GET /api/session/ses_parent/message": () => ({ data: [fixture.launch, fixture.stored], cursor: {} }),
    "GET /api/session/ses_child/message": () => ({ data: [], cursor: {} }),
  });
  const provider = server.provider(), lifetime = new AbortController(), stream = observedNativeStream(provider);
  try {
    await stream.seen(event => event.eventType === "server.connected");
    await provider.listMessages("ses_parent", { limit: 100, signal: lifetime.signal });
    const reads = server.calls.length;
    const snapshot = provider.watchWorkerAssociations("ses_wrong", ["ses_child"], { signal: lifetime.signal }).snapshot();
    expect(snapshot.contradictedChildren).toEqual(["ses_child"]); expect(snapshot.workerSource.isCurrent()).toBe(true);
    expect(server.calls).toHaveLength(reads); // Pure invalidation evidence: no I/O or ownership admission.
  } finally { lifetime.abort(); stream.lifetime.abort(); await stream.pump; await provider.dispose(); }
});

for (const foreign of ["parent", "workspace"] as const)
test(`worker source authority leases retire independently (${foreign})`, async () => {
  const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
  let negative = false;
  const server = fakeOpenCode({
    "GET /api/session/ses_parent": () => session("ses_parent"),
    "GET /api/session/ses_child": () => session("ses_child", { parentID: negative && foreign === "parent" ? "ses_other" : "ses_parent",
      ...(negative && foreign === "workspace" ? { location: { directory: "/foreign" } } : {}) }),
    "GET /api/session/ses_parent/message": () => ({ data: [fixture.launch, fixture.stored], cursor: {} }),
    "GET /api/session/ses_unrelated": () => session("ses_unrelated", { parentID: "ses_elsewhere" }),
  });
  const provider = server.provider(), transport = new AbortController(), enclosing = new AbortController(), sibling = new AbortController(), retired = new AbortController();
  try {
    const page = await provider.listMessages("ses_parent", { limit: 100, signal: transport.signal });
    expect(page.isWorkerSourceCurrent?.()).toBe(true);
    const lease = page.workerSource!.retain(enclosing.signal), peer = page.workerSource!.retain(sibling.signal);
    transport.abort();
    expect(page.isWorkerSourceCurrent?.()).toBe(false);
    expect(lease.isCurrent()).toBe(true); expect(peer.isCurrent()).toBe(true);
    enclosing.abort();
    expect(lease.isCurrent()).toBe(false); expect(peer.isCurrent()).toBe(true);
    expect(lease.retain(retired.signal).isCurrent()).toBe(false);
    await provider.getSession("ses_unrelated"); expect(peer.isCurrent()).toBe(true);
    negative = true; await provider.getSession("ses_child");
    expect(peer.isCurrent()).toBe(false);
    sibling.abort();
    negative = false;
    const current = await provider.listMessages("ses_parent", { limit: 100, signal: retired.signal });
    expect(current.isWorkerSourceCurrent?.()).toBe(true);
    // A retired negative lease cannot carry its invalidation into a successor.
    expect(peer.retain(retired.signal).isCurrent()).toBe(false);
    expect(current.isWorkerSourceCurrent?.()).toBe(true);
  } finally { transport.abort(); enclosing.abort(); sibling.abort(); retired.abort(); await provider.dispose(); }
});

for (const hidden of [false, true]) test(`same adapter retries incomplete visible descendant accounting (hidden=${hidden})`, async () => {
  const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
  const launch = (parent: string, child: string, call: string, created: number) => {
    const message = structuredClone(fixture.launch);
    message.sessionID = parent; message.id = `msg_${call}`; message.time.created = created;
    const tool = message.content[0]; tool.id = call;
    tool.state.input.background = false; tool.state.metadata = { sessionID: child, status: "completed" };
    tool.state.content = [{ type: "text", text: "Done" }];
    return message;
  };
  const prompt = (id: string) => ({ id: `${id}_prompt`, type: "user", text: "Inspect the safe fixture", time: { created: 1 } });
  const priced = (cost: number) => ({ id: "priced", type: "assistant", time: { created: 2 }, model: { id: "stored" }, cost, content: [] });
  let unavailable = true;
  const server = fakeOpenCode({
    "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"type":"server.connected","data":{}}\n\n'));
    } }), { headers: { "content-type": "text/event-stream" } }),
    "GET /api/session": () => ({ data: [session("ses_parent")], cursor: {} }),
    "GET /api/session/ses_parent": () => session("ses_parent"),
    "GET /api/session/ses_child": () => session("ses_child", { parentID: "ses_parent", cost: 0.5, ...(hidden ? { revert: { messageID: "msg_nested" } } : {}) }),
    "GET /api/session/ses_grandchild": () => unavailable ? new Response(null, { status: 503 }) : session("ses_grandchild", { parentID: "ses_child", cost: 0.25 }),
    "GET /api/session/ses_parent/message": () => ({ data: [prompt("parent"), launch("ses_parent", "ses_child", "root", 20)], cursor: {} }),
    "GET /api/session/ses_child/message": () => ({ data: [prompt("child"), priced(0.5), launch("ses_child", "ses_grandchild", "nested", 30)], cursor: {} }),
    "GET /api/session/ses_grandchild/message": () => ({ data: [prompt("grandchild"), priced(0.25)], cursor: {} }),
    "GET /api/session/:id/inbox": () => ({ data: [] }),
    "GET /api/session/active": () => ({}),
    "GET /api/permission/request": () => scoped([]),
    "GET /api/form": () => scoped([]),
  });
  const provider = server.provider();
  const adapter = new ChatAdapter({ provider, workspacePath: WORKSPACE, coalesceWindowMs: 0 });
  const row = (page: Awaited<ReturnType<ChatAdapter["history"]>>) => page.items.find(item => item.id === "tool:root") as import("../../types").ToolItem;
  try {
    const first = await adapter.history("ses_parent");
    expect(row(first).workerSession?.costUsd).toBe(0.5);
    expect(row(first).descendants ?? []).toEqual([]);
    const reads = server.requests("GET", "/api/session/ses_child").length;
    unavailable = false;
    const retry = await adapter.history("ses_parent");
    expect(row(retry).workerSession?.costUsd).toBe(0.5);
    if (hidden) {
      expect(row(retry).descendants ?? []).toEqual([]);
      // No accounting reconstruction merely because hidden suffix enrichment failed.
      expect(server.requests("GET", "/api/session/ses_child").length - reads).toBe(0);
    } else {
      expect(row(retry).descendants).toContainEqual(expect.objectContaining({ conversationId: "ses_grandchild", usage: expect.objectContaining({ costUsd: 0.25 }) }));
    }
    expect(server.calls.every(call => call.method === "GET")).toBe(true);
  } finally { await adapter.dispose(); }
}, 6_000);

for (const outcome of ["unavailable", "denied", "foreign-parent", "foreign-workspace", "mismatched-id", "missing"] as const) test(`visible descendant completeness distinguishes ${outcome} ownership`, async () => {
  const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
  const server = fakeOpenCode({
    "GET /api/session/ses_parent": () => session("ses_parent"),
    "GET /api/session/ses_parent/message": () => ({ data: [fixture.launch], cursor: {} }),
    "GET /api/session/ses_child": () => {
      if (outcome === "unavailable") return new Response(null, { status: 503 });
      if (outcome === "denied") return new Response(null, { status: 403 });
      if (outcome === "missing") return notFound("ses_child");
      return session(outcome === "mismatched-id" ? "other" : "ses_child", {
        parentID: outcome === "foreign-parent" ? "other" : "ses_parent",
        ...(outcome === "foreign-workspace" ? { location: { directory: "/foreign" } } : {}),
      });
    },
  });
  const provider = server.provider();
  try {
    const page = await provider.listMessages("ses_parent", { limit: 100 });
    expect(page.visibleDescendantsIncomplete === true).toBe(outcome === "unavailable");
    expect(page.items.some(item => "childConversationId" in item && item.childConversationId)).toBe(false);
    expect(server.requests("GET", "/api/session/ses_child/message")).toHaveLength(0);
  } finally { await provider.dispose(); }
});

// Fresh native reads legitimately advance last-positive-observation clocks;
// projection/filtering assertions still compare every other task/control fact.
const withoutObservationClock = (tasks: import("../../types").BackgroundTaskItem[]) => tasks.map(task => ({ ...task,
  ...(task.activity ? { activity: { ...task.activity, observedAt: undefined } } : {}) }));

describe("newborn worker activity", () => {
  type Native = FormCancelled | FormCreated | FormReplied | PermissionAsked | PermissionReplied | SessionCreated | SessionExecutionStarted | SessionExecutionSucceeded | SessionToolInputStarted | SessionToolCalled | SessionToolSuccess | SessionMessageContentUpdated;
  for (const timing of [
    { created: 20, ran: 20, birth: 20, completed: 30, started: 23 },
    { created: 20, ran: 20, birth: 22, completed: 30, started: 23 },
    { created: 20, ran: 20, birth: 20, completed: 30, started: 31 },
    { created: 100, ran: 292, birth: 308, completed: 317, started: 318 },
    { created: 1_790_000_000_100, ran: 1_790_000_000_292, birth: 1_790_000_000_308, completed: 1_790_000_000_317, started: 1_790_000_000_318 },
  ]) for (const historyFirst of [false, true]) for (const order of ["content-first", "success-first", "start-between-success-content", "snapshot"] as const) test(`first native execution ${JSON.stringify(timing)} historyFirst=${historyFirst} ${order}`, async () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    const launch = fixture.launch, tool = launch.content[0];
    launch.time.created = timing.created;
    tool.time = { created: timing.created, ran: timing.ran, completed: timing.completed };
    let history: unknown[] = [], wire!: ReadableStreamDefaultController<Uint8Array>, sequence = 0, lastFrame!: Uint8Array;
    let activeUnavailable = false;
    let permissions: PermissionAsked["data"][] = [];
    let forms: FormCreated["data"]["form"][] = [];
    const sequences = new Map<string, number>();
    const frame = (type: string, data: unknown, created: number) => {
      const aggregateID = (data as { sessionID?: string }).sessionID;
      const seq = aggregateID ? (sequences.get(aggregateID) ?? 0) + 1 : undefined;
      if (aggregateID) sequences.set(aggregateID, seq!);
      lastFrame = new TextEncoder().encode(`data: ${JSON.stringify({ id: `evt_newborn_${++sequence}`, type, data, created,
        ...(aggregateID && type.startsWith("session.") ? { durable: { aggregateID, seq, version: type === "session.tool.success" ? 2 : 1 } } : {}), location: { directory: WORKSPACE } })}\n\n`);
      wire.enqueue(lastFrame);
    };
    const server = fakeOpenCode({
      "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) { wire = controller; frame("server.connected", {}, 1); } }), { headers: { "content-type": "text/event-stream" } }),
      "GET /api/session/active": () => activeUnavailable ? new Response(null, { status: 500 }) : ({ ses_child: { type: "running" } }),
      "GET /api/session/:id": ({ path }) => session(path.split("/").at(-1)!, path.endsWith("ses_child") ? { parentID: "ses_parent", time: { created: timing.birth, updated: timing.started } } : { time: { created: 2, updated: 3 } }),
      "GET /api/session/ses_parent/message": () => ({ data: history, cursor: {} }),
      "GET /api/session/ses_child/message": () => ({ data: [], cursor: {} }),
      "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
      "GET /api/permission/request": () => scoped(permissions),
      "GET /api/form": () => scoped(forms),
    });
    const provider = server.provider(), abort = new AbortController();
    const canonical: import("../../types").ConversationItem[] = [], workers: import("../../types").BackgroundTaskItem[] = [];
    let ack: { session: string; type: string; done: () => void } | undefined;
    const pump = (async () => { for await (const event of provider.events(abort.signal)) {
      for (const update of event.updates) if (update.kind === "upsert") {
        if (update.item.type === "permission" || update.item.type === "question") canonical.push(update.item);
        if (update.item.type === "background_task") workers.push(update.item);
      }
      if (event.eventType === ack?.type && event.conversationId === ack.session) { const done = ack.done; ack = undefined; done(); }
    } })();
    const send = <K extends Native["type"]>(type: K, data: Extract<Native, { type: K }>["data"], at: number) => new Promise<void>(resolve => { ack = { session: "sessionID" in data ? data.sessionID : data.form.sessionID, type, done: resolve }; frame(type, data, at); });
    const common = { sessionID: "ses_parent", assistantMessageID: launch.id, id: tool.id };
    const creation = { projectID: "global", slug: "synthetic-newborn", version: "2.1.2", location: { directory: WORKSPACE } };
    try {
      await provider.waitForEventStream(abort.signal);
      await send("session.created", { ...creation, sessionID: "ses_parent" }, 2);
      if (order !== "snapshot") {
        await send("session.tool.input.started", { ...common, name: "subagent" }, timing.created);
        await send("session.tool.called", { ...common, input: tool.state.input, executed: true }, timing.ran);
      }
      await send("session.created", { ...creation, sessionID: "ses_child", parentID: "ses_parent" }, timing.birth);
      let startFrame!: Uint8Array;
      const start = async () => { await send("session.execution.started", { sessionID: "ses_child" }, timing.started); startFrame = lastFrame; };
      if (timing.started <= timing.completed) await start();
      history = [launch];
      if (historyFirst) await provider.reconcileBackgroundTasks("ses_parent", { fresh: true });
      const content = () => send("session.message.content.updated", { sessionID: "ses_parent", messageID: launch.id, content: launch.content }, timing.completed);
      const success = () => send("session.tool.success", { ...common, executed: true, content: tool.state.content, metadata: tool.state.metadata }, timing.completed);
      if (order !== "success-first" && order !== "start-between-success-content") await content();
      if (order !== "snapshot") await success();
      if (order === "start-between-success-content" && timing.started > timing.completed) await start();
      if (order === "success-first" || order === "start-between-success-content") await content();
      if (timing.started > timing.completed && order !== "start-between-success-content") await start();
      const rows = await provider.reconcileBackgroundTasks("ses_parent", { fresh: true });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: "running", activity: { kind: "working" } });
      if (order === "snapshot") expect(rows[0]?.stateUncertain).toBe(false);
      await new Promise<void>(resolve => { ack = { session: "ses_child", type: "session.execution.started", done: resolve }; wire.enqueue(startFrame); });
      const repeat = await provider.reconcileBackgroundTasks("ses_parent", { fresh: true });
      expect(repeat[0]?.activity).toMatchObject({ kind: "working", executionId: rows[0]?.activity?.executionId });
      const childTool = { sessionID: "ses_child", assistantMessageID: "child-message", id: "child-tool" };
      await send("session.tool.input.started", { ...childTool, name: "question" }, timing.started + 1);
      const permission: PermissionAsked["data"] = { id: "canonical-permission", sessionID: "ses_child", action: "question", resources: ["*"], source: { type: "tool", messageID: childTool.assistantMessageID, id: childTool.id } };
      const unlinkedPermission = { ...permission, id: "unlinked-permission", source: { ...permission.source!, messageID: "old-message" } };
      permissions = [unlinkedPermission];
      await send("permission.asked", unlinkedPermission, timing.started + 2);
      expect((await provider.reconcileBackgroundTasks("ses_parent", { fresh: true }))[0]?.activity?.kind).toBe("working");
      expect(canonical).toContainEqual(expect.objectContaining({ type: "permission", requestId: unlinkedPermission.id, status: "pending" }));
      permissions = [permission];
      await send("permission.asked", permission, timing.started + 3);
      const blocked = await provider.reconcileBackgroundTasks("ses_parent", { fresh: true });
      expect(blocked[0]?.activity).toMatchObject({ kind: "needs-answer", request: { id: permission.id, kind: "permission" } });
      expect(workers.at(-1)?.activity).toMatchObject({ kind: "needs-answer", request: { id: permission.id, kind: "permission" } });
      expect(canonical).toContainEqual(expect.objectContaining({ type: "permission", requestId: permission.id, conversationId: "ses_child", status: "pending" }));
      expect(canonical.filter(item => item.type === "permission" && item.requestId === permission.id && item.status === "pending")).toHaveLength(1);
      activeUnavailable = true;
      expect((await provider.reconcileBackgroundTasks("ses_parent", { fresh: true }))[0]).toMatchObject({ activity: { kind: "needs-answer", request: { id: permission.id, kind: "permission" } }, control: { available: false } });
      activeUnavailable = false;
      permissions = [];
      await send("permission.replied", { sessionID: "ses_child", requestID: permission.id, reply: "once" }, timing.started + 4);
      const resumed = await provider.reconcileBackgroundTasks("ses_parent", { fresh: true });
      expect(resumed[0]?.activity?.kind).toBe("working");
      expect(workers.at(-1)?.activity?.request).toBeUndefined();
      expect(canonical).toContainEqual(expect.objectContaining({ type: "permission", requestId: permission.id, status: "resolved" }));
      await send("session.tool.called", { ...childTool, input: { questions: [{ header: "Choose", question: "Proceed?", options: [{ label: "Yes", description: "Proceed" }] }] }, executed: true }, timing.started + 5);
      // QuestionTool producer at a517687f: native ephemeral permission/form
      // events reference the durable tool via this exact context tuple.
      const question: FormCreated["data"]["form"] = { id: "canonical-question", sessionID: "ses_child", title: "Questions", fields: [{ key: "q0", type: "string", title: "Choose", description: "Proceed?", custom: true, options: [{ value: "Yes", label: "Yes", description: "Proceed" }] }],
        metadata: { kind: "question", tool: { messageID: childTool.assistantMessageID, id: childTool.id } } };
      forms = [question];
      await send("form.created", { form: question }, timing.started + 5);
      expect((await provider.reconcileBackgroundTasks("ses_parent", { fresh: true }))[0]?.activity).toMatchObject({ kind: "needs-answer", request: { id: question.id, kind: "question" } });
      expect(workers.at(-1)?.activity).toMatchObject({ kind: "needs-answer", request: { id: question.id, kind: "question" } });
      expect(canonical).toContainEqual(expect.objectContaining({ type: "question", requestId: question.id, conversationId: "ses_child", status: "pending" }));
      expect(canonical.filter(item => item.type === "question" && item.requestId === question.id && item.status === "pending")).toHaveLength(1);
      forms = [];
      if (order === "snapshot") await send("form.cancelled", { sessionID: "ses_child", id: question.id }, timing.started + 6);
      else await send("form.replied", { sessionID: "ses_child", id: question.id, answer: { q0: "Yes" } }, timing.started + 6);
      const answered = await provider.reconcileBackgroundTasks("ses_parent", { fresh: true });
      expect(answered[0]?.activity?.kind).toBe("working");
      expect(workers.at(-1)?.activity?.request).toBeUndefined();
      expect(canonical).toContainEqual(expect.objectContaining({ type: "question", requestId: question.id, status: "resolved" }));
      const unrelated = { ...question, id: "unlinked-question", metadata: { kind: "question", tool: { messageID: "old-message", id: childTool.id } } };
      forms = [unrelated];
      await send("form.created", { form: unrelated }, timing.started + 7);
      expect((await provider.reconcileBackgroundTasks("ses_parent", { fresh: true }))[0]?.activity?.kind).toBe("working");
      expect(canonical).toContainEqual(expect.objectContaining({ type: "question", requestId: unrelated.id, status: "pending" }));
      const arbitraryMetadata = { ...question, id: "arbitrary-form-metadata", metadata: { ...question.metadata, kind: "unrelated" } };
      forms = [arbitraryMetadata];
      await send("form.created", { form: arbitraryMetadata }, timing.started + 8);
      expect((await provider.reconcileBackgroundTasks("ses_parent", { fresh: true }))[0]?.activity?.kind).toBe("working");
      const lastPositive = await provider.reconcileBackgroundTasks("ses_parent", { fresh: true });
      expect(rows[0]?.activity?.observedAt).toBeGreaterThan(timing.completed);
      activeUnavailable = true;
      const unavailable = await provider.reconcileBackgroundTasks("ses_parent", { fresh: true });
      expect(unavailable[0]?.activity).toMatchObject({ kind: "unavailable", observedAt: lastPositive[0]?.activity?.observedAt });
      expect(unavailable[0]?.control).toEqual({ available: false, reason: "Worker control is unverified" });
      activeUnavailable = false;
      expect((await provider.reconcileBackgroundTasks("ses_parent", { fresh: true }))[0]?.activity?.kind).toBe("working");
      if (order === "snapshot" && timing.birth === 22 && !historyFirst) {
        await send("session.execution.succeeded", { sessionID: "ses_child" }, timing.started + 10);
        const ended = await provider.reconcileBackgroundTasks("ses_parent", { fresh: true });
        expect(ended[0]).toMatchObject({ status: "running", activity: { kind: "ended", endedAt: timing.started + 10 }, control: { available: false } });
      } else {
        // Current child activity must not redirect the old task to a new run.
        await send("session.execution.started", { sessionID: "ses_child" }, timing.started + 10);
        const reused = await provider.reconcileBackgroundTasks("ses_parent", { fresh: true });
        expect(reused[0]).toMatchObject({ activity: { kind: "session-active" }, control: { available: false } });
        permissions = [permission];
        await send("permission.asked", permission, timing.started + 11);
        expect((await provider.reconcileBackgroundTasks("ses_parent", { fresh: true }))[0]?.activity?.kind).toBe("session-active");
        forms = [question];
        await send("form.created", { form: question }, timing.started + 12);
        expect((await provider.reconcileBackgroundTasks("ses_parent", { fresh: true }))[0]?.activity?.kind).toBe("session-active");
      }
      await expect(provider.stopTask("ses_parent", rows[0]!.taskId)).rejects.toThrow();
      expect(server.calls.every(call => call.method === "GET")).toBe(true);
    } finally { abort.abort(); await pump; await provider.dispose(); }
  });
});

for (const kind of ["permission", "question"] as const) for (const scenario of ["exact", "resolved", "later-start", "reused", "gap", "foreign", "unowned", "competing"] as const) test(`native prelaunch blocking request links only its first execution (${kind}/${scenario})`, async () => {
  const launch = historyWorkerLaunch("prelaunch-call", 20);
  launch.content[0]!.time.completed = 30;
  let history: unknown[] = [], pending = true, wire!: ReadableStreamDefaultController<Uint8Array>, seq = 0;
  const source = { messageID: "child-question-message", id: "child-question-tool" };
  const permission: PermissionAsked["data"] = { id: "prelaunch-request", sessionID: "ses_child", action: "question", resources: ["*"], source: { type: "tool", ...source } };
  const form: FormCreated["data"]["form"] = { id: permission.id, sessionID: "ses_child", title: "Choose", fields: [{ key: "q0", type: "string", title: "Continue?", custom: true }], metadata: { kind: "question", tool: source } };
  const frame = (type: string, data: unknown, at: number, directory = WORKSPACE) => wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ id: `prelaunch-${++seq}`, type, data, created: at, location: { directory },
    ...(type.startsWith("session.") ? { durable: { aggregateID: (data as { sessionID: string }).sessionID, seq, version: 1 } } : {}) })}\n\n`));
  const server = fakeOpenCode({
    "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) { wire = controller; frame("server.connected", {}, 1); } }), { headers: { "content-type": "text/event-stream" } }),
    "GET /api/session/active": () => ({ ses_child: { type: "running" } }),
    "GET /api/session/:id": ({ path }) => session(path.split("/").at(-1)!, path.endsWith("ses_child") ? { parentID: "ses_parent", time: { created: 22, updated: 23 } } : {}),
    "GET /api/session/ses_parent/message": () => ({ data: history, cursor: {} }),
    "GET /api/session/ses_child/message": () => ({ data: [], cursor: {} }),
    "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
    "GET /api/permission/request": () => scoped(pending && kind === "permission" ? [permission] : []),
    "GET /api/form": () => scoped(pending && kind === "question" ? [form] : []),
    "GET /api/session/:id/form/:form": () => ({ ...form, state: { status: "pending" } }),
    "POST /api/session/:id/form/:form/reply": () => { pending = false; },
    "POST /api/session/:id/permission/:request/reply": () => { pending = false; },
  });
  const provider = server.provider();
  let stream = observedNativeStream(provider);
  const canonicalEvents = stream.events;
  const drain = async (label: string) => {
    frame("session.text.delta", { sessionID: "ses_parent", assistantMessageID: label, id: label, delta: label }, 29);
    await stream.seen(event => event.updates.some(update => update.kind === "text" && update.text === label));
  };
  try {
    await stream.seen(event => event.eventType === "server.connected");
    frame("session.created", { sessionID: "ses_child", parentID: scenario === "unowned" ? "ses_other" : "ses_parent", projectID: "global", slug: "prelaunch", version: "2.1.2", location: { directory: WORKSPACE } }, 22);
    if (scenario !== "later-start") frame("session.execution.started", { sessionID: "ses_child" }, 23);
    frame("session.tool.input.started", { sessionID: "ses_child", assistantMessageID: source.messageID, id: source.id, name: "question" }, 24, scenario === "foreign" ? "/foreign" : WORKSPACE);
    frame(kind === "permission" ? "permission.asked" : "form.created", kind === "permission" ? permission : { form }, 25);
    await stream.seen(event => event.updates.some(update => update.kind === "upsert" && update.item.type === kind && update.item.requestId === permission.id && update.item.status === "pending"));
    const canonical = () => canonicalEvents.flatMap(event => event.updates).filter(update => update.kind === "upsert" && update.item.type === kind && update.item.requestId === permission.id && update.item.status === "pending");
    // The request is canonical before a worker row exists; worker association
    // must not manufacture a second interaction card or reply path.
    expect(canonical()).toHaveLength(1);
    if (scenario === "resolved") {
      pending = false;
      frame(kind === "permission" ? "permission.replied" : "form.cancelled", kind === "permission" ? { sessionID: "ses_child", requestID: permission.id, reply: "once" } : { sessionID: "ses_child", id: permission.id }, 26);
    }
    if (scenario === "later-start" || scenario === "reused") frame("session.execution.started", { sessionID: "ses_child" }, 27);
    if (scenario === "competing") {
      frame("session.tool.input.started", { sessionID: "ses_parent", assistantMessageID: "competitor", id: "competing-call", name: "subagent" }, 26);
      frame("session.tool.called", { sessionID: "ses_parent", assistantMessageID: "competitor", id: "competing-call", input: { sessionID: "ses_child" }, executed: true }, 27);
    }
    await drain("prelaunch-drained");
    if (scenario === "gap") { stream.lifetime.abort(); await stream.pump; stream = observedNativeStream(provider); await stream.seen(event => event.eventType === "server.connected"); }
    history = [launch];
    frame("session.message.content.updated", { sessionID: "ses_parent", messageID: launch.id, content: launch.content }, 30);
    let firstWorker: import("../../types").BackgroundTaskItem | undefined;
    await stream.seen(event => event.updates.some(update => {
      if (update.kind !== "upsert" || update.item.type !== "background_task") return false;
      firstWorker = update.item;
      return true;
    }));
    if (scenario === "exact") expect(firstWorker?.activity).toMatchObject({ kind: "needs-answer", request: { id: permission.id, kind } });
    for (let read = 0; read < 2; read++) {
      const [task] = await provider.reconcileBackgroundTasks("ses_parent", { fresh: true });
      if (scenario === "exact") expect(task?.activity).toMatchObject({ kind: "needs-answer", request: { id: permission.id, kind } });
      else { expect(task?.activity?.kind).not.toBe("needs-answer"); expect(task?.activity?.request).toBeUndefined(); }
    }
    expect(canonical()).toHaveLength(1);
    if (pending) {
      const canonicalPending = kind === "permission" ? await provider.listPermissions() : await provider.listQuestions();
      expect(canonicalPending).toEqual([expect.objectContaining({ requestId: permission.id, conversationId: "ses_child" })]);
    }
    if (scenario === "exact") {
      if (kind === "permission") await provider.replyPermission("ses_child", permission.id, "once");
      else await provider.replyQuestion("ses_child", form.id, [["Yes"]]);
      expect(server.calls.filter(call => call.method === "POST")).toHaveLength(1);
      expect((await provider.reconcileBackgroundTasks("ses_parent", { fresh: true }))[0]?.activity?.request).toBeUndefined();
    } else expect(server.calls.every(call => call.method === "GET")).toBe(true);
  } finally { stream.lifetime.abort(); await stream.pump; await provider.dispose(); }
});

for (const surface of ["history", "inventory", "terminal-history", "terminal-inventory"] as const) for (const change of ["owner", "ran", "input"] as const) test(`public V2 dismissal identity isolates changed ${change} through restart (${surface})`, async () => {
  const original = historyWorkerLaunch("same-call", 20), changed = structuredClone(original);
  if (change === "owner") changed.id = "different-owning-message";
  if (change === "ran") changed.content[0]!.time.ran = 21.5;
  if (change === "input") changed.content[0]!.state.input.description = "Different immutable invocation input";
  const read = async (message: typeof original) => {
    const terminal = surface.startsWith("terminal");
    const server = fakeOpenCode({
      "GET /api/session/:id": ({ path }) => session(path.split("/").at(-1)!, path.endsWith("ses_child") ? { parentID: "ses_parent" } : {}),
      "GET /api/session/ses_parent/message": () => ({ data: terminal ? [message, historyWorkerResult("same-result", 40)] : [message], cursor: {} }),
      "GET /api/session/ses_child/message": () => ({ data: [], cursor: {} }),
      "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
      // Lack of current activity must not erase a recorded launch identity.
      "GET /api/session/active": () => ({}),
    });
    const provider = server.provider();
    try {
      const rows = surface.endsWith("inventory") ? await provider.reconcileBackgroundTasks("ses_parent", { fresh: true })
        : (await provider.listMessages("ses_parent", { limit: 100 })).items.filter(item => item.type === "background_task");
      expect(rows).toHaveLength(1);
      expect(rows[0]?.type).toBe("background_task");
      if (rows[0]?.type === "background_task") {
        expect(rows[0].activity?.kind).not.toBe("working");
        expect(rows[0].activity?.kind).not.toBe("needs-answer");
        if (surface === "history") expect(rows[0].activity).toMatchObject({ kind: "unavailable" });
      }
      expect(server.calls.every(call => call.method === "GET")).toBe(true);
      return rows[0]!;
    } finally { await provider.dispose(); }
  };
  const first = await read(original), second = await read(changed), reopened = await read(original);
  const firstIds = workerDismissalIdentities(first), secondIds = workerDismissalIdentities(second);
  expect(firstIds.length).toBeGreaterThan(0);
  expect(firstIds.every(id => /^v1:[a-f0-9]{64}$/.test(id))).toBe(true);
  expect(secondIds.length).toBeGreaterThan(0);
  // A persisted qualified A mark still hides A, never a restarted B which
  // reuses its native call/result ids with contradictory immutable facts.
  const saved = new Set([firstIds[0]!]);
  expect(workerDismissalIdentities(reopened).some(id => saved.has(id))).toBe(true);
  expect(secondIds.some(id => saved.has(id))).toBe(false);
  expect(visibleWorkers(compactWorkers([reopened]), saved)).toHaveLength(0);
  expect(visibleWorkers(compactWorkers([second]), saved)).toHaveLength(1);
});

for (const settled of [false, true]) test(`public native history with missing run proof withholds qualified dismissal aliases (${settled ? "terminal" : "unavailable"})`, async () => {
  const message = historyWorkerLaunch("sparse-call", 20);
  // A valid sparse native record is not repaired with display/envelope clocks.
  Reflect.deleteProperty(message.content[0]!.time, "ran");
  const server = fakeOpenCode({
    "GET /api/session/:id": ({ path }) => session(path.split("/").at(-1)!, path.endsWith("ses_child") ? { parentID: "ses_parent" } : {}),
    "GET /api/session/ses_parent/message": () => ({ data: settled ? [message, historyWorkerResult("result", 40)] : [message], cursor: {} }),
    "GET /api/session/ses_child/message": () => ({ data: [], cursor: {} }),
    "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
    "GET /api/session/active": () => ({}),
  });
  const provider = server.provider();
  try {
    const history = (await provider.listMessages("ses_parent", { limit: 100 })).items.filter(item => item.type === "background_task");
    const inventory = await provider.reconcileBackgroundTasks("ses_parent", { fresh: true });
    expect(history).toHaveLength(1); expect(inventory).toHaveLength(1);
    for (const task of [...history, ...inventory]) {
      expect(task.activity?.executionId).toBeUndefined();
      expect(task.activity?.executionAliases).toBeUndefined();
      expect(task.activity?.kind).not.toBe("working");
    }
    expect(server.calls.every(call => call.method === "GET")).toBe(true);
  } finally { await provider.dispose(); }
});

test("native notification-only dismissal identity survives inbox delivery and restart without launch alias transfer", async () => {
  const result = historyWorkerResult("native-inbox-result", 40), launch = historyWorkerLaunch("late-launch", 20);
  let history: unknown[] = [], inbox: unknown[] = [], wire!: ReadableStreamDefaultController<Uint8Array>;
  const frame = (type: string, data: unknown, created: number) => wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ id: `notification-event-${created}`, type, data, created, location: { directory: WORKSPACE } })}\n\n`));
  const server = fakeOpenCode({
    "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) { wire = controller; frame("server.connected", {}, 1); } }), { headers: { "content-type": "text/event-stream" } }),
    "GET /api/session/active": () => ({}),
    "GET /api/session/:id": ({ path }) => session(path.split("/").at(-1)!, path.endsWith("ses_child") ? { parentID: "ses_parent" } : {}),
    "GET /api/session/ses_parent/message": () => ({ data: history, cursor: {} }),
    "GET /api/session/ses_child/message": () => ({ data: [], cursor: {} }),
    "GET /api/session/ses_parent/inbox": () => ({ data: inbox }),
  });
  const provider = server.provider(), stream = observedNativeStream(provider);
  const pending = { id: result.id, type: "synthetic", time: result.time, delivery: "steer", payload: { text: result.text, metadata: result.metadata } };
  let live: import("../../types").BackgroundTaskItem | undefined;
  try {
    await stream.seen(event => event.eventType === "server.connected");
    frame("session.inbox.enqueued", { sessionID: "ses_parent", inboxID: result.id, item: pending }, 41);
    await stream.seen(event => event.updates.some(update => {
      if (update.kind !== "upsert" || update.item.type !== "background_task") return false;
      live = update.item; return true;
    }));
    expect(live?.activity?.executionId).toMatch(/^v1:notification:[a-f0-9]{64}$/);
    expect(live?.activity?.executionAliases).toEqual([live!.activity!.executionId!]);
    expect(live?.activity?.kind).toBe("ended");
    expect(live?.activity?.observedAt).toBeUndefined();
    expect(live?.control?.available).toBe(false);
  } finally { stream.lifetime.abort(); await stream.pump; await provider.dispose(); }
  const saved = new Set(workerDismissalIdentities(live));
  expect(saved.size).toBe(1);
  for (const mode of ["pending", "stored", "weak-fold", "reordered-weak-fold", "changed-launch"] as const) {
    const changed = structuredClone(launch); changed.id = "different-owning-message";
    history = mode === "pending" ? [] : mode === "stored" ? [result]
      : mode === "weak-fold" ? [launch, result] : mode === "reordered-weak-fold" ? [result, launch] : [result, changed];
    inbox = mode === "pending" ? [pending] : [];
    const restarted = server.provider();
    try {
      const rows = mode === "pending" ? await restarted.reconcileBackgroundTasks("ses_parent", { fresh: true })
        : (await restarted.listMessages("ses_parent", { limit: 100 })).items.filter(item => item.type === "background_task");
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row.activity?.kind).toBe("ended");
      expect(row.control?.available).toBe(false);
      if (mode === "pending" || mode === "stored") {
        expect(row.activity?.executionAliases).toEqual(live!.activity!.executionAliases);
        expect(visibleWorkers(compactWorkers([row]), saved)).toHaveLength(0);
      } else {
        expect(row.activity?.executionId).toMatch(/^v1:[a-f0-9]{64}$/);
        expect(workerDismissalIdentities(row).some(id => saved.has(id))).toBe(false);
        expect(visibleWorkers(compactWorkers([row]), saved)).toHaveLength(1);
      }
    } finally { await restarted.dispose(); }
  }
  expect(server.calls.every(call => call.method === "GET")).toBe(true);
});

test("notification fingerprints depend only on complete native parent/source/inbox/worker identity", async () => {
  type Facts = { parent: string; source: "subagent" | "shell"; worker: string; inbox: string; at: number; state: string; text: string; description: string };
  const original: Facts = { parent: "parent", source: "subagent", worker: "worker", inbox: "native-result", at: 40, state: "completed", text: "Done", description: "Result" };
  const read = async (facts: Facts) => {
    const result = { id: facts.inbox, type: "synthetic", time: { created: facts.at }, text: facts.text, description: facts.description,
      metadata: { source: facts.source, ...(facts.source === "shell" ? { shellID: facts.worker } : { childID: facts.worker }), state: facts.state } };
    // Shell results need independently established background membership to
    // become visible. A later launch reveals this earlier, uncorrelated note;
    // membership does not establish its exact launch occurrence.
    const shellLaunch = { id: "shell-owner", type: "assistant", time: { created: 100 }, content: [{ id: "shell-call", type: "tool", name: "shell", time: { created: 100, ran: 101, completed: 110 }, state: {
      status: "completed", input: { command: "printf fixture" }, metadata: { shellID: facts.worker, status: "running" },
    } }] };
    const server = fakeOpenCode({
      "GET /api/session/active": () => ({}),
      "GET /api/session/:id": ({ path }) => session(path.split("/").at(-1)!, path.endsWith(`/${facts.worker}`) ? { parentID: facts.parent } : {}),
      "GET /api/session/:id/message": ({ path }) => ({ data: path === `/api/session/${facts.parent}/message` ? facts.source === "shell" ? [shellLaunch, result] : [result] : [], cursor: {} }),
      "GET /api/session/:id/inbox": () => ({ data: [] }),
    });
    const provider = server.provider();
    try {
      const rows = (await provider.listMessages(facts.parent, { limit: 100 })).items.filter((item): item is import("../../types").BackgroundTaskItem => item.type === "background_task" && item.resultId === facts.inbox);
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row.activity?.executionId).toMatch(/^v1:notification:[a-f0-9]{64}$/);
      expect(row.activity?.executionAliases).toEqual([row.activity!.executionId!]);
      expect(row.control?.available).toBe(false);
      expect(server.calls.every(call => call.method === "GET")).toBe(true);
      return row;
    } finally { await provider.dispose(); }
  };
  const first = await read(original), marks = new Set(workerDismissalIdentities(first));
  // Independent first admissions test hash invariance. This is not a claim
  // that native inbox payload/status is mutable after admission.
  for (const change of [{ at: 80 }, { state: "error" }, { text: "Different summary", description: "Different name" }]) {
    const same = await read({ ...original, ...change });
    expect(workerDismissalIdentities(same)).toEqual([...marks]);
    expect(visibleWorkers(compactWorkers([same]), marks)).toHaveLength(0);
  }
  for (const change of [{ parent: "other-parent" }, { source: "shell" as const }, { worker: "other-worker" }, { inbox: "other-inbox" }]) {
    const different = await read({ ...original, ...change });
    expect(workerDismissalIdentities(different).some(id => marks.has(id))).toBe(false);
    expect(visibleWorkers(compactWorkers([different]), marks)).toHaveLength(1);
  }
});

test("public native recovered launch identity is independent of result ordering, not a child-only notification alias", async () => {
  const launch = historyWorkerLaunch("stable-call", 20), result = historyWorkerResult("stable-result", 40);
  let history: unknown[] = [];
  const server = fakeOpenCode({
    "GET /api/session/:id": ({ path }) => session(path.split("/").at(-1)!, path.endsWith("ses_child") ? { parentID: "ses_parent" } : {}),
    "GET /api/session/ses_parent/message": () => ({ data: history, cursor: {} }),
    "GET /api/session/ses_child/message": () => ({ data: [], cursor: {} }),
    "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
  });
  const read = async (messages: unknown[]) => {
    history = messages;
    const provider = server.provider();
    try {
      const rows = (await provider.listMessages("ses_parent", { limit: 100 })).items.filter(item => item.type === "background_task");
      expect(rows).toHaveLength(1);
      return rows[0]!;
    } finally { await provider.dispose(); }
  };
  const provisional = await read([result]);
  // Native inbox identity names only this notification, never its launcher.
  expect(provisional.activity?.executionId).toMatch(/^v1:notification:[a-f0-9]{64}$/);
  const accepted = await read([launch]), reportFirst = await read([result, launch]), launchFirst = await read([launch, result]);
  expect(accepted.activity?.executionId).toMatch(/^v1:[a-f0-9]{64}$/);
  expect(reportFirst.activity?.executionAliases).toEqual(accepted.activity?.executionAliases);
  expect(launchFirst.activity?.executionAliases).toEqual(accepted.activity?.executionAliases);
  expect(reportFirst.activity?.executionAliases).not.toContain(provisional.activity!.executionId!);
  expect(launchFirst.activity?.executionAliases).not.toContain(provisional.activity!.executionId!);
  expect(reportFirst).toMatchObject({ status: "completed", resultId: result.id });
  expect(launchFirst).toMatchObject({ status: "completed", resultId: result.id });
  expect(workerDismissalIdentities(reportFirst)).not.toContain(`worker-dismissal:result:${result.id}`);
  expect(server.calls.every(call => call.method === "GET")).toBe(true);
});

test("public terminal history preserves every proven dismissal alias across reordered restart", async () => {
  const first = historyWorkerLaunch("restart-alias-a", 20), second = historyWorkerLaunch("restart-alias-b", 25);
  const result = historyWorkerResult("restart-result", 40);
  let history: unknown[] = [first];
  const server = fakeOpenCode({
    "GET /api/session/:id": ({ path }) => session(path.split("/").at(-1)!, path.endsWith("ses_child") ? { parentID: "ses_parent" } : {}),
    "GET /api/session/ses_parent/message": () => ({ data: history, cursor: {} }),
    "GET /api/session/ses_child/message": () => ({ data: [], cursor: {} }),
    "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
    "GET /api/session/active": () => ({}),
  });
  const read = async () => {
    const provider = server.provider();
    try {
      const rows = (await provider.listMessages("ses_parent", { limit: 100 })).items.filter(item => item.type === "background_task");
      expect(rows).toHaveLength(1);
      return rows[0]!;
    } finally { await provider.dispose(); }
  };
  const initial = await read(), saved = new Set(workerDismissalIdentities(initial));
  expect(saved.size).toBe(1);
  for (const messages of [[first, second, result], [result, second, first], [second, result, first]]) {
    history = messages;
    const settled = await read();
    expect(settled.status).toBe("completed");
    expect(settled.activity?.executionAliases).toHaveLength(2);
    expect(settled.activity?.executionAliases).toContain(initial.activity!.executionId!);
    expect(visibleWorkers(compactWorkers([settled]), saved)).toHaveLength(0);
  }
  // Reusing both result and call ids does not bridge a different owning
  // message into the old execution, including after the terminal fold.
  const replacement = structuredClone(first);
  replacement.id = "replacement-owner";
  history = [result, replacement];
  const changed = await read();
  expect(changed.activity?.executionAliases).toHaveLength(1);
  expect(workerDismissalIdentities(changed).some(id => saved.has(id))).toBe(false);
  expect(visibleWorkers(compactWorkers([changed]), saved)).toHaveLength(1);
  expect(server.calls.every(call => call.method === "GET")).toBe(true);
});

function historyWorkerLaunch(id: string, at: number) {
  return { id: `msg_${id}`, type: "assistant", time: { created: at }, content: [
    { id, type: "tool", name: "subagent", time: { created: at, ran: at + 1, completed: at + 2 }, state: {
      status: "completed", input: { description: "Fixture worker", background: true }, metadata: { sessionID: "ses_child", status: "running" },
    } },
  ] };
}

test("cold worker inventory failure retains the last positive server observation without authorizing Stop", async () => {
  let unavailable = false, now = 1_000;
  const server = fakeOpenCode({
    "GET /api/session/active": () => unavailable ? new Response(null, { status: 500 }) : ({ ses_child: { type: "running" } }),
    "GET /api/session/:id": ({ path }) => session(path.split("/").at(-1)!, path.endsWith("ses_child") ? { parentID: "ses_parent" } : {}),
    "GET /api/session/ses_parent/message": () => ({ data: [historyWorkerLaunch("cold", 20)], cursor: {} }),
    "GET /api/session/ses_child/message": () => ({ data: [], cursor: {} }),
    "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
  });
  const provider = server.provider(), clock = spyOn(Date, "now").mockImplementation(() => now);
  try {
    const [initial] = await provider.reconcileBackgroundTasks("ses_parent", { fresh: true });
    expect(initial).toMatchObject({ activity: { kind: "working", observedAt: 1_000 }, control: { available: true } });
    expect(initial!.control).toEqual({ available: true });
    unavailable = true;
    for (now of [2_000, 3_000]) {
      const [lost] = await provider.reconcileBackgroundTasks("ses_parent", { fresh: true });
      expect(lost).toMatchObject({ activity: { kind: "unavailable", observedAt: 1_000, executionId: initial!.activity!.executionId }, control: { available: false, reason: "Worker control is unverified" } });
      expect(lost!.control).toEqual({ available: false, reason: "Worker control is unverified" });
    }
    await expect(provider.stopTask("ses_parent", initial!.taskId)).rejects.toThrow();
    expect(server.calls.every(call => call.method === "GET")).toBe(true);
  } finally { await provider.dispose(); clock.mockRestore(); }
});

for (const scenario of ["new execution", "changed launch clock", "ambiguous aliases", "foreign ownership", "execution boundary", "stream generation", "observation gap"] as const) test(`cold last-seen does not cross ${scenario}`, async () => {
  const first = historyWorkerLaunch("cold", 20);
  let history = [first], idle: unknown[] = [], unavailable = false, foreign = false, now = 1_000;
  const server = fakeOpenCode({
    "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "server.connected", data: {} })}\n\n`));
    } }), { headers: { "content-type": "text/event-stream" } }),
    "GET /api/session/active": () => unavailable ? new Response(null, { status: 500 }) : ({ ses_child: { type: "running" } }),
    "GET /api/session/:id": ({ path }) => session(path.split("/").at(-1)!, path.endsWith("ses_child") ? { parentID: foreign ? "ses_foreign" : "ses_parent" } : {}),
    "GET /api/session/ses_parent/message": () => ({ data: history, cursor: {} }),
    "GET /api/session/ses_child/message": () => ({ data: idle, cursor: {} }),
    "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
  });
  const provider = server.provider(), clock = spyOn(Date, "now").mockImplementation(() => now);
  let stream: ReturnType<typeof observedNativeStream> | undefined;
  try {
    if (scenario === "observation gap") {
      stream = observedNativeStream(provider);
      await stream.seen(event => event.eventType === "server.connected");
    }
    expect((await provider.reconcileBackgroundTasks("ses_parent", { fresh: true }))[0]?.activity).toMatchObject({ kind: "working", observedAt: 1_000 });
    now = 2_000; unavailable = true;
    if (scenario === "new execution") history = [historyWorkerLaunch("cold", 50)];
    if (scenario === "changed launch clock") { history = [structuredClone(first)]; history[0]!.content[0]!.time.ran = 29; }
    if (scenario === "ambiguous aliases") history = [first, historyWorkerLaunch("other", 21)];
    if (scenario === "foreign ownership") foreign = true;
    if (scenario === "execution boundary") idle = [{ id: "later-idle", type: "idle", time: { created: 40 } }];
    if (scenario === "stream generation") {
      stream = observedNativeStream(provider);
      await stream.seen(event => event.eventType === "server.connected");
    }
    if (scenario === "observation gap") { stream!.lifetime.abort(); await stream!.pump; }
    const tasks = await provider.reconcileBackgroundTasks("ses_parent", { fresh: true });
    if (scenario === "foreign ownership") expect(tasks).toEqual([]);
    else {
      expect(tasks.length).toBeGreaterThan(0);
      for (const task of tasks) {
        expect(task.activity?.observedAt).toBeUndefined();
        expect(task.activity?.kind).not.toBe("working");
        expect(task.control).toEqual({ available: false, reason: "Worker control is unverified" });
      }
    }
    await expect(provider.stopTask("ses_parent", "v2:ses_parent:cold")).rejects.toThrow();
    expect(server.calls.every(call => call.method === "GET")).toBe(true);
  } finally { stream?.lifetime.abort(); await stream?.pump; await provider.dispose(); clock.mockRestore(); }
});

test("cold last-seen retention is bounded and losing a caption never restores control", async () => {
  let index = 0, unavailable = false;
  const server = fakeOpenCode({
    "GET /api/session/active": () => unavailable ? new Response(null, { status: 500 }) : ({ ses_child: { type: "running" } }),
    "GET /api/session/:id": ({ path }) => session(path.split("/").at(-1)!, path.endsWith("ses_child") ? { parentID: "ses_parent" } : {}),
    "GET /api/session/ses_parent/message": () => ({ data: [historyWorkerLaunch(`bounded_${index}`, 20)], cursor: {} }),
    "GET /api/session/ses_child/message": () => ({ data: [], cursor: {} }),
    "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
  });
  const provider = server.provider(), clock = spyOn(Date, "now").mockReturnValue(1_000);
  try {
    for (index = 0; index < 129; index++) expect((await provider.reconcileBackgroundTasks("ses_parent", { fresh: true }))[0]?.activity?.kind).toBe("working");
    unavailable = true; clock.mockReturnValue(2_000);
    for (index of [0, 128]) {
      const [task] = await provider.reconcileBackgroundTasks("ses_parent", { fresh: true });
      expect(task?.activity?.kind).toBe("unavailable");
      expect(task?.activity?.observedAt).toBe(index === 0 ? undefined : 1_000);
      expect(task?.control).toEqual({ available: false, reason: "Worker control is unverified" });
      await expect(provider.stopTask("ses_parent", task!.taskId)).rejects.toThrow();
    }
    expect(server.calls.every(call => call.method === "GET")).toBe(true);
  } finally { await provider.dispose(); clock.mockRestore(); }
});

test("proven execution aliases bridge reversed live arrival and chronological history without merging reuse", async () => {
  const run = async (reverse: boolean) => {
    const first = historyWorkerLaunch("alias_a", 20), second = historyWorkerLaunch("alias_b", 25);
    let history: unknown[] = [first, second], idle: unknown[] = [], wire!: ReadableStreamDefaultController<Uint8Array>, seq = 0;
    const frame = (type: string, data: unknown) => wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ id: `alias-event-${++seq}`, created: 30,
      type, data, location: { directory: WORKSPACE }, ...(type === "server.connected" ? {} : { durable: { aggregateID: "ses_parent", seq, version: 1 } }) })}\n\n`));
    const server = fakeOpenCode({
      "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) { wire = controller; frame("server.connected", {}); } }), { headers: { "content-type": "text/event-stream" } }),
      "GET /api/session/active": () => ({ ses_child: { type: "running" } }),
      "GET /api/session/:id": ({ path }) => session(path.split("/").at(-1)!, path.endsWith("ses_child") ? { parentID: "ses_parent" } : {}),
      "GET /api/session/ses_parent/message": () => ({ data: history, cursor: {} }),
      "GET /api/session/ses_child/message": () => ({ data: idle, cursor: {} }),
      "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
    });
    const provider = server.provider(), stream = observedNativeStream(provider);
    try {
      await stream.seen(event => event.eventType === "server.connected");
      let initial: string | undefined, final: import("../../types").WorkerActivity | undefined;
      for (const message of reverse ? [second, first] : [first, second]) {
        frame("session.message.content.updated", { sessionID: "ses_parent", messageID: message.id, content: message.content });
        await stream.seen(event => event.updates.some(update => {
          if (update.kind !== "upsert" || update.item.type !== "background_task" || !update.item.toolUseIds?.includes(message.content[0]!.id) && update.item.toolUseId !== message.content[0]!.id) return false;
          final = update.item.activity;
          initial ??= final?.executionId;
          return true;
        }));
      }
      const recovered = (await provider.reconcileBackgroundTasks("ses_parent", { fresh: true }))[0]?.activity;
      expect(final?.executionAliases).toHaveLength(2);
      expect(final?.executionAliases).toContain(initial!);
      expect(recovered?.executionAliases).toEqual(final?.executionAliases);
      expect(recovered?.executionId).toBe(final?.executionId);
      history = [first, second, historyWorkerResult("old-result", 40), historyWorkerLaunch("separate", 50)];
      idle = [{ id: "idle-boundary", type: "idle", time: { created: 40 } }];
      const later = await provider.reconcileBackgroundTasks("ses_parent", { fresh: true });
      const settled = later.find(task => task.status === "completed");
      expect(settled?.activity).toMatchObject({ kind: "ended", executionId: recovered?.executionId, executionAliases: recovered?.executionAliases });
      expect(settled?.activity?.endedAt).toBeUndefined();
      const current = later.find(task => task.status === "running");
      expect(current?.activity?.executionId).toBeDefined();
      expect(final?.executionAliases).not.toContain(current?.activity?.executionId!);
      expect(current?.activity?.executionAliases).toHaveLength(1);
      expect(server.calls.every(call => call.method === "GET")).toBe(true);
      return recovered;
    } finally { stream.lifetime.abort(); await stream.pump; await provider.dispose(); }
  };
  const chronological = await run(false), reversed = await run(true);
  expect(reversed?.executionAliases).toEqual(chronological?.executionAliases);
  expect(reversed?.executionId).toBe(chronological?.executionId);
});

for (const scenario of ["activity revocation", "canonical request linkage", "contradictory canonical ran", "partial alias set"] as const) test(`reversed proven aliases retain ${scenario} across chronological recovery`, async () => {
  const request = scenario === "canonical request linkage";
  const first = historyWorkerLaunch("alias_a", 20), second = historyWorkerLaunch("alias_b", 21);
  first.content[0]!.time.completed = 30; second.content[0]!.time.completed = 31;
  let history = [first, second];
  let wire!: ReadableStreamDefaultController<Uint8Array>, seq = 0, pending = false;
  const sequences = new Map<string, number>();
  const permission: PermissionAsked["data"] = { id: "alias-permission", sessionID: "ses_child", action: "question", resources: ["*"], source: { type: "tool", messageID: "child-message", id: "child-tool" } };
  const frame = (type: string, data: Record<string, unknown>, created: number) => {
    const aggregateID = String(data.sessionID ?? ""), next = (sequences.get(aggregateID) ?? 0) + 1;
    sequences.set(aggregateID, next);
    wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ id: `reversed-${++seq}`, type, data, created, location: { directory: WORKSPACE },
      ...(type.startsWith("session.") ? { durable: { aggregateID, seq: next, version: 1 } } : {}) })}\n\n`));
  };
  const server = fakeOpenCode({
    "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) { wire = controller; frame("server.connected", {}, 1); } }), { headers: { "content-type": "text/event-stream" } }),
    "GET /api/session/active": () => ({ ses_child: { type: "running" } }),
    "GET /api/session/:id": ({ path }) => session(path.split("/").at(-1)!, path.endsWith("ses_child") ? { parentID: "ses_parent" } : {}),
    "GET /api/session/ses_parent/message": () => ({ data: history, cursor: {} }),
    "GET /api/session/ses_child/message": () => ({ data: [], cursor: {} }),
    "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
    "GET /api/permission/request": () => scoped(pending ? [permission] : []),
  });
  const provider = server.provider(), abort = new AbortController();
  let ack: { type: string; session: string; done: () => void } | undefined, now = 1_000;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const pump = (async () => { for await (const event of provider.events(abort.signal)) if (event.eventType === ack?.type && event.conversationId === ack.session) { const done = ack.done; ack = undefined; done(); } })();
  const send = (type: string, data: Record<string, unknown>, created: number) => new Promise<void>(done => { ack = { type, session: String(data.sessionID), done }; frame(type, data, created); });
  try {
    await provider.waitForEventStream(abort.signal);
    await send("session.execution.started", { sessionID: "ses_child" }, 25);
    for (const message of [second, first]) await send("session.message.content.updated", { sessionID: "ses_parent", messageID: message.id, content: message.content }, 31);
    if (request) {
      await send("session.tool.input.started", { sessionID: "ses_child", assistantMessageID: "child-message", id: "child-tool", name: "question" }, 26);
      pending = true;
      await send("permission.asked", permission, 27);
    }
    const initial = (await provider.reconcileBackgroundTasks("ses_parent", { fresh: true }))[0]!;
    expect(initial.taskId).toBe("v2:ses_parent:alias_a");
    expect(initial.activity).toMatchObject({ kind: request ? "needs-answer" : "working", observedAt: 1_000,
      ...(request ? { request: { id: permission.id, kind: "permission" } } : {}) });
    if (request) {
      pending = false;
      await send("permission.replied", { sessionID: "ses_child", requestID: permission.id, reply: "once" }, 28);
      expect((await provider.reconcileBackgroundTasks("ses_parent", { fresh: true }))[0]?.activity).toMatchObject({ kind: "working", observedAt: 1_000 });
    }
    now = 2_000;
    if (scenario === "contradictory canonical ran" || scenario === "partial alias set") {
      const changed = structuredClone(first); changed.content[0]!.time.ran = 29;
      history = scenario === "partial alias set" ? [first] : [changed, second];
      const changedOccurrence = (await provider.reconcileBackgroundTasks("ses_parent", { fresh: true }))[0]!;
      expect(changedOccurrence.activity?.kind).toBe("session-active");
      expect(changedOccurrence.activity?.observedAt).toBeUndefined();
      expect(server.calls.every(call => call.method === "GET")).toBe(true);
      return;
    }
    await send("session.execution.started", { sessionID: "ses_child" }, 40);
    if (request) { pending = true; await send("permission.asked", permission, 41); }
    for (let index = 0; index < 2; index++) {
      const recovered = (await provider.reconcileBackgroundTasks("ses_parent", { fresh: true }))[0]!;
      expect(recovered).toMatchObject({ taskId: "v2:ses_parent:alias_a", activity: { kind: "session-active", observedAt: 1_000 }, control: { available: false } });
      expect(recovered.activity?.request).toBeUndefined();
      now++;
    }
    await expect(provider.stopTask("ses_parent", initial.taskId)).rejects.toThrow();
    expect(server.calls.every(call => call.method === "GET")).toBe(true);
  } finally { abort.abort(); await pump; await provider.dispose(); clock.mockRestore(); }
});
const historyWorkerResult = (id: string, at: number) => ({ id, type: "synthetic", time: { created: at }, text: "Fixture done.", metadata: { source: "subagent", childID: "ses_child", state: "completed" } });
function workerHistoryServer(messages: unknown[], idle: unknown[], pending: unknown[] = []) {
  return fakeOpenCode({
    "GET /api/session/active": () => ({ ses_child: { status: "running" } }),
    "GET /api/session/:id": ({ path }) => session(path.split("/").at(-1)!, path.endsWith("ses_child") ? { parentID: "ses_parent" } : {}),
    "GET /api/session/ses_parent/inbox": () => ({ data: pending }),
    "GET /api/session/ses_parent/message": () => ({ data: messages, cursor: {} }),
    "GET /api/session/ses_child/message": () => ({ data: idle, cursor: {} }),
  });
}

// Complete native Info for synthetic healthy shell fixtures. Birth evidence is
// still emitted explicitly; current inventory alone never supplies its baseline.
const nativeShellInfo = (id = "sh_fixture", parent = "ses_parent", command = "printf fixture", started = 71): ShellInfo => ({
  id, command, cwd: WORKSPACE, shell: "/bin/sh", file: `/fixture/${id}.out`, status: "running", metadata: { sessionID: parent }, time: { started },
});
const emitNativeShellBirths = (wire: ReadableStreamDefaultController<Uint8Array>, ids: string[] = ["sh_fixture"], parent = "ses_parent") => {
  for (const id of ids) wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ id: `birth:${id}`, created: 71, type: "shell.created",
    location: { directory: WORKSPACE }, data: { info: nativeShellInfo(id, parent) } })}\n\n`));
};

function workerRecoveryServer() {
  const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
  const state = { failure: "", childParent: "ses_parent", shellParent: "ses_parent", messages: [fixture.launch, fixture.shell] as unknown[], revert: undefined as string | undefined };
  let wire!: ReadableStreamDefaultController<Uint8Array>;
  let held: { path: string; entered: () => void; gate: Promise<void> } | undefined;
  const frame = (type: string, data: unknown, created = 90) => wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ id: `${type}:${created}`, type, data, created, location: { directory: WORKSPACE } })}\n\n`));
  const answer = async (path: string, value: unknown) => {
    const result = state.failure === path ? new Response(null, { status: 500 }) : value;
    if (held?.path === path) { const pending = held; held = undefined; pending.entered(); await pending.gate; }
    return result;
  };
  const server = fakeOpenCode({
    "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) { wire = controller; frame("server.connected", {}); frame("shell.created", { info: nativeShellInfo() }, 71); } }), { headers: { "content-type": "text/event-stream" } }),
    "GET /api/session/ses_parent": () => session("ses_parent", state.revert ? { revert: { messageID: state.revert } } : {}),
    "GET /api/session/ses_child": () => session("ses_child", { parentID: state.childParent }),
    "GET /api/session/ses_parent/message": () => ({ data: state.messages, cursor: {} }),
    "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
    "GET /api/session/ses_child/message": ({ path }) => answer(path, { data: [], cursor: {} }),
    "GET /api/session/active": ({ path }) => answer(path, { ses_child: { status: "running" } }),
    "GET /api/shell/sh_fixture": ({ path }) => answer(path, scoped(nativeShellInfo("sh_fixture", state.shellParent))),
    "DELETE /api/shell/sh_fixture": () => undefined,
    "POST /api/session/ses_child/interrupt": () => ({ interrupted: true }),
  });
  return { ...server, fixture, state, frame, disconnect: () => wire.close(), holdNext: (path: string) => {
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    held = { path, entered, gate }; return { started, release };
  } };
}

type StopEvidence = {
  parent: string; taskId: string; child?: string; launchCalls?: readonly string[]; occurrence?: unknown;
  pendingChanges: Set<string>;
  pendingLaunches: Map<string, { child?: string; call?: string; background?: boolean; selectedOnly?: boolean }>;
  pendingBytes: number;
  changed: boolean;
};
// Resource-budget inspection only; behavior still runs through the real SDK
// fetch/SSE seam. Independently serialize the retained evidence, not its ledger.
const stopEvidence = (provider: OpenCodeV2Provider) => [...(provider as unknown as { stopValidations: Set<StopEvidence> }).stopValidations];
const evidencePayloadBytes = (evidence: StopEvidence) => JSON.stringify([evidence.parent, evidence.taskId, evidence.child ?? null, evidence.launchCalls ?? null, evidence.occurrence ?? null, evidence.changed, [...evidence.pendingChanges], [...evidence.pendingLaunches]]).length * 2;

// The shared browser native fixture, real client, provider and adapter;
// capture only the fake's transport so these tests open no listener/service.
function nativeBackgroundStack() {
  let handle!: (request: Request) => Response | Promise<Response>;
  const serve = spyOn(Bun, "serve").mockImplementation((options: any) => {
    handle = options.fetch;
    return { port: 42400, stop: async () => undefined } as ReturnType<typeof Bun.serve>;
  });
  let fake: ReturnType<typeof startOpenCodeV2Fake>;
  try { fake = startOpenCodeV2Fake({ directory: WORKSPACE }); } finally { serve.mockRestore(); }
  const fetch = (async (input: Request | URL | string, init?: RequestInit) => {
    const request = new Request(input, init);
    expect(new URL(request.url).origin).toBe(fake.url);
    return handle(request);
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory: WORKSPACE, fetch }) as OpenCodeV2Provider;
  const adapter = new ChatAdapter({ provider, workspacePath: WORKSPACE, generation: "native-bootstrap", coalesceWindowMs: 0 });
  return { fake, provider, adapter };
}

function observedNativeStream(provider: OpenCodeV2Provider) {
  const lifetime = new AbortController(), events: import("../../provider").NormalizedProviderEvent[] = [];
  const waiting = new Set<{ matches: (event: import("../../provider").NormalizedProviderEvent) => boolean; resolve: () => void }>();
  const pump = (async () => {
    for await (const event of provider.events(lifetime.signal)) {
      events.push(event);
      for (const waiter of waiting) if (waiter.matches(event)) { waiting.delete(waiter); waiter.resolve(); }
    }
  })();
  void pump.catch(() => undefined);
  return { lifetime, pump, events, seen: (matches: (event: import("../../provider").NormalizedProviderEvent) => boolean) =>
    events.some(matches) ? Promise.resolve() : new Promise<void>(resolve => waiting.add({ matches, resolve })) };
}

for (const scenario of ["single-known", "browser-two-reports", "known-zero-cost", "known-unpriced", "history-recovery", "no-reported-usage"] as const)
test(`native browser worker reports retain known own tokens beside current effort and session cost (${scenario})`, async () => {
  const { fake, provider, adapter } = nativeBackgroundStack();
  const nativeEvents: import("../../provider").NormalizedProviderEvent[] = [], processed: import("../../provider").NormalizedProviderEvent[] = [], events = provider.events.bind(provider);
  const nativeWaiters = new Set<{ matches: () => boolean; resolve: () => void }>();
  provider.events = async function* (signal) { for await (const event of events(signal)) {
    nativeEvents.push(event); yield event; processed.push(event);
    for (const waiter of nativeWaiters) if (waiter.matches()) { nativeWaiters.delete(waiter); waiter.resolve(); }
  } };
  const nativeProcessed = (matches: () => boolean) => matches() ? Promise.resolve() : new Promise<void>(resolve => nativeWaiters.add({ matches, resolve }));
  let observer: Awaited<ReturnType<ChatAdapter["subscribe"]>> | undefined, observing: Promise<void> | undefined;
  const rows: import("../../types").BackgroundTaskItem[] = [];
  const waiters = new Set<{ matches: (item: import("../../types").BackgroundTaskItem) => boolean; resolve: () => void }>();
  const seen = (matches: (item: import("../../types").BackgroundTaskItem) => boolean) => rows.some(matches) ? Promise.resolve() : new Promise<void>(resolve => waiters.add({ matches, resolve }));
  try {
    const parent = (await provider.createSession("Native browser token regression")).id;
    await adapter.history(parent);
    observer = await adapter.subscribe(parent);
    observing = (async () => { for await (const event of observer!.events) if (event.type === "item.upsert" && event.item.type === "background_task") {
      rows.push(event.item);
      for (const waiter of waiters) if (waiter.matches(event.item)) { waiters.delete(waiter); waiter.resolve(); }
    } })();
    if (scenario === "browser-two-reports") await provider.prompt(parent, { id: "fixture-work", text: "Start fixture work", delivery: "queue" });
    const worker = fake.launchWorker(parent, true);
    await seen(item => item.taskId === worker.taskId);
    if (scenario === "browser-two-reports") {
      fake.workerReport(worker.childId, "Fixture Model", "high", 0);
      await seen(item => item.taskId === worker.taskId && item.workerSession?.effort === "high" && item.workerSession.costUsd === 0);
    }
    if (scenario !== "no-reported-usage") {
      const cost = scenario === "known-zero-cost" ? 0 : scenario === "known-unpriced" ? undefined : 0.0012;
      fake.workerReport(worker.childId, "Fixture Model", "medium", cost);
      await seen(item => item.taskId === worker.taskId && item.workerSession?.effort === "medium" && item.workerSession.costUsd === (cost ?? null));
      // Resume past the final native event, not an elapsed-time guess. Both
      // token-bearing step end and the later session-cost update are handled.
      const lastType = cost === undefined ? "session.step.ended" : "session.usage.updated";
      const count = scenario === "browser-two-reports" ? 2 : 1;
      await nativeProcessed(() => processed.filter(event => event.conversationId === worker.childId && event.eventType === lastType).length >= count);
      expect(nativeEvents).toContainEqual(expect.objectContaining({ conversationId: worker.childId, assistantUsage: expect.objectContaining({ usage: expect.objectContaining({ input: 1200, output: 100, reasoning: 20 }) }) }));
      if (scenario === "history-recovery") await adapter.history(parent);
      const next = await adapter.subscribe(parent); next.events.cancel();
      // Match the browser's launcher/background fold, including known zero
      // spend. Each report has 1200 input + 100 output + 20 reasoning tokens.
      const display = compactWorkers(next.snapshot.items).find(item => item.taskId === worker.taskId)!;
      expect({ model: display.model, effort: display.effort, costUsd: display.costUsd, tokens: display.tokens }).toEqual({
        model: "Fixture Model", effort: "medium", costUsd: cost ?? null, tokens: 1320 * count,
      });
    } else {
      const next = await adapter.subscribe(parent); next.events.cancel();
      expect(compactWorkers(next.snapshot.items).find(item => item.taskId === worker.taskId)?.tokens).toBeUndefined();
      expect(nativeEvents.some(event => event.conversationId === worker.childId && event.assistantUsage)).toBe(false);
    }
    expect(fake.state().unhandled).toEqual([]);
  } finally { observer?.events.cancel(); await adapter.dispose(); await observing; await fake.stop(); }
});

for (const evidence of ["model", "usage", "descendants", "session-model", "session-effort", "session-zero", "session-cost"] as const)
test(`native live tokens cannot reuse retained allocation evidence after owner loss (${evidence})`, async () => {
  const { fake, provider, adapter } = nativeBackgroundStack();
  const processed: import("../../provider").NormalizedProviderEvent[] = [], events = provider.events.bind(provider);
  const waiters = new Set<{ matches: () => boolean; resolve: () => void }>();
  provider.events = async function* (signal) { for await (const event of events(signal)) {
    yield event; processed.push(event);
    for (const waiter of waiters) if (waiter.matches()) { waiters.delete(waiter); waiter.resolve(); }
  } };
  const handled = (matches: (event: import("../../provider").NormalizedProviderEvent) => boolean) => processed.some(matches)
    ? Promise.resolve() : new Promise<void>(resolve => waiters.add({ matches: () => processed.some(matches), resolve }));
  try {
    const parent = (await provider.createSession("Retained allocation evidence")).id;
    await adapter.history(parent);
    const worker = fake.launchWorker(parent, true);
    await handled(event => event.conversationId === parent && event.eventType === "session.message.content.updated");
    const projection = adapter.projectionForTests(parent), launcher = projection.get(`tool:${worker.callId}`);
    if (launcher?.type !== "tool") throw new Error("Expected native launcher");
    const retained: Partial<import("../../types").ToolItem> = evidence === "model" ? { model: "Retained model" }
      : evidence === "usage" ? { usage: { input: 77, output: 3, costUsd: 0.03 } }
      : evidence === "descendants" ? { descendants: [{ id: "retained-line", parentId: launcher.id, description: "Retained usage", conversationId: "retained-child", usage: { input: 11 } }] }
      : { workerSession: { effort: evidence === "session-effort" ? "high" : null,
        costUsd: evidence === "session-zero" ? 0 : evidence === "session-cost" ? 0.03 : null,
        ...(evidence === "session-model" ? { model: "Retained session model" } : {}) } };
    // Simulate the retained projection side of owner/cache loss, not an empty
    // placeholder. The real eviction/generation matrix exercises its lifecycle.
    projection.upsert({ ...launcher, ...retained });
    fake.workerReport(worker.childId, "Fixture Model", "medium", 0.0012);
    await handled(event => event.conversationId === worker.childId && event.eventType === "session.usage.updated");
    const next = await adapter.subscribe(parent); next.events.cancel();
    const current = next.snapshot.items.find(item => item.id === launcher.id);
    if (current?.type !== "tool") throw new Error("Expected retained launcher");
    expect({ usage: current.usage, model: current.model, descendants: current.descendants }).toEqual({
      usage: retained.usage, model: retained.model, descendants: retained.descendants,
    });
    expect(current.workerSession).toEqual({ model: "Fixture Model", effort: "medium", costUsd: 0.0012 });
    expect(fake.state().unhandled).toEqual([]);
  } finally { await adapter.dispose(); await fake.stop(); }
});

test("native browser fixture shell completion reaches provider inventory without timestamp repair", async () => {
  let now = 10_000;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const { fake, provider, adapter } = nativeBackgroundStack();
  try {
    const parent = (await provider.createSession("Native inventory clocks")).id;
    const worker = fake.launchShell(parent, true);
    const [running] = await provider.reconcileBackgroundTasks(parent, { fresh: true });
    expect(running?.activity?.kind).toBe("working");
    expect(running?.createdAt).toBeGreaterThanOrEqual(10_000);
    now = 20_000;
    fake.shellPhase(worker.shellId, "exit");
    // No SSE consumer: only the fixture's unmodified ShellInfo can supply end.
    const [ended] = await provider.reconcileBackgroundTasks(parent, { fresh: true });
    expect(ended).toMatchObject({ taskId: worker.taskId, status: "running", activity: { kind: "ended", endedAt: 20_000 } });
    expect(fake.state().unhandled).toEqual([]);
  } finally { await adapter.dispose(); await fake.stop(); clock.mockRestore(); }
});

test("interrupted child observation does not settle an occurrence from child session outcome alone", async () => {
  const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
  let wire!: ReadableStreamDefaultController<Uint8Array>, settled = false;
  const frame = (type: string, data: unknown) => wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type, data, created: 30, location: { directory: WORKSPACE } })}\n\n`));
  const server = fakeOpenCode({
    "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) { wire = controller; frame("server.connected", {}); } }), { headers: { "content-type": "text/event-stream" } }),
    "GET /api/session/ses_parent": () => session("ses_parent"),
    "GET /api/session/ses_child": () => session("ses_child", { parentID: "ses_parent", ...(settled ? { outcome: "succeeded", time: { created: 10, updated: 40, idle: 40 } } : {}) }),
    "GET /api/session/ses_parent/message": () => ({ data: [fixture.launch], cursor: {} }),
    "GET /api/session/ses_child/message": () => ({ data: [], cursor: {} }),
    "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
    "GET /api/session/active": () => settled ? {} : { ses_child: { type: "running" } },
  });
  const provider = server.provider();
  let stream = observedNativeStream(provider);
  try {
    await stream.seen(event => event.eventType === "server.connected");
    frame("session.message.content.updated", { sessionID: "ses_parent", messageID: fixture.launch.id, content: fixture.launch.content });
    await stream.seen(event => event.updates.some(update => update.kind === "upsert" && update.item.type === "background_task"));
    expect(await provider.reconcileBackgroundTasks("ses_parent", { fresh: true })).toContainEqual(expect.objectContaining({ status: "running", stateUncertain: false }));
    wire.close(); await stream.pump;
    settled = true; // The terminal SSE frame was lost while disconnected; streams do not replay it.
    stream = observedNativeStream(provider);
    await stream.seen(event => event.eventType === "server.connected");
    const recovered = await provider.reconcileBackgroundTasks("ses_parent", { fresh: true });
    await expect(provider.stopTask("ses_parent", "v2:ses_parent:call_worker")).rejects.toThrow();
    expect(server.calls.every(call => call.method === "GET")).toBe(true);
    expect(recovered).toContainEqual(expect.objectContaining({ taskId: "v2:ses_parent:call_worker", status: "running", stateUncertain: true }));
  } finally { stream.lifetime.abort(); await stream.pump.catch(() => undefined); await provider.dispose(); }
});

test("a cancelled child ownership reader does not cancel a concurrent history reader", async () => {
  const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const server = fakeOpenCode({
    "GET /api/session/ses_parent": () => session("ses_parent"),
    "GET /api/session/ses_parent/message": () => ({ data: [fixture.launch], cursor: {} }),
    "GET /api/session/ses_child": async ({ signal }) => { entered(); await gate; signal.throwIfAborted(); return session("ses_child", { parentID: "ses_parent" }); },
    "GET /api/session/ses_child/message": () => ({ data: [], cursor: {} }),
  });
  const provider = server.provider(), first = new AbortController();
  const cancelled = provider.listMessages("ses_parent", { limit: 10, signal: first.signal });
  void cancelled.catch(() => undefined);
  let concurrent: ReturnType<typeof provider.listMessages> | undefined;
  try {
    await started;
    concurrent = provider.listMessages("ses_parent", { limit: 10 });
    void concurrent.catch(() => undefined);
    const deadline = Date.now() + 1_000;
    while ((provider as unknown as { ownershipChecks: Set<unknown> }).ownershipChecks.size < 2 && Date.now() < deadline) await Bun.sleep(0);
    expect((provider as unknown as { ownershipChecks: Set<unknown> }).ownershipChecks.size).toBe(2);
    first.abort();
    await expect(cancelled).rejects.toThrow();
    release();
    expect((await concurrent).completeItems).toContainEqual(expect.objectContaining({ type: "background_task", childConversationId: "ses_child" }));
    expect(server.requests("GET", "/api/session/ses_child")).toHaveLength(1);
  } finally { release(); await Promise.allSettled([cancelled, ...(concurrent ? [concurrent] : [])]); await provider.dispose(); }
});

for (const matchingFirst of [false, true]) test(`cancelled matching-parent reader leaves foreign-parent ownership false (${matchingFirst ? "matching" : "foreign"} parent first)`, async () => {
  const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const server = fakeOpenCode({
    "GET /api/session/:id/message": () => ({ data: [fixture.launch], cursor: {} }),
    "GET /api/session/:id": async ({ path, signal }) => {
      const id = path.split("/").at(-1)!;
      if (id !== "ses_child") return session(id);
      entered(); await gate; signal.throwIfAborted();
      return session(id, { parentID: "ses_parent" });
    },
  });
  const provider = server.provider(), matching = new AbortController();
  const state = provider as unknown as { ownershipChecks: Set<unknown>; childParentReads: Map<string, { users: number }> };
  let cancelled: ReturnType<typeof provider.listMessages> | undefined, foreign: ReturnType<typeof provider.listMessages> | undefined;
  const startMatching = () => { cancelled = provider.listMessages("ses_parent", { limit: 10, signal: matching.signal }); void cancelled.catch(() => undefined); };
  const startForeign = () => { foreign = provider.listMessages("ses_other", { limit: 10 }); void foreign.catch(() => undefined); };
  try {
    (matchingFirst ? startMatching : startForeign)();
    await started;
    (matchingFirst ? startForeign : startMatching)();
    const deadline = Date.now() + 1_000;
    while (state.ownershipChecks.size < 2 && Date.now() < deadline) await Bun.sleep(0);
    expect(state.ownershipChecks.size).toBe(2);
    expect(state.childParentReads.get("ses_child")?.users).toBe(2);
    matching.abort();
    await expect(cancelled!).rejects.toThrow();
    expect(state.ownershipChecks.size).toBe(1);
    expect(state.childParentReads.get("ses_child")?.users).toBe(1);
    expect(server.requests("GET", "/api/session/ses_child")[0]!.signal.aborted).toBe(false);
    release();
    expect((await foreign!).completeItems?.some(item => item.type === "background_task")).toBe(false);
    expect(server.requests("GET", "/api/session/ses_child")).toHaveLength(1);
    expect(server.requests("GET", "/api/session/ses_child/message")).toHaveLength(0);
    expect(state.ownershipChecks.size).toBe(0);
    expect(state.childParentReads.size).toBe(0);
    expect(server.calls.every(call => call.method === "GET")).toBe(true);
  } finally { release(); await Promise.allSettled([...(cancelled ? [cancelled] : []), ...(foreign ? [foreign] : [])]); await provider.dispose(); }
});

for (const setup of ["readSignal", "childParents.read"] as const) test(`synchronous child ownership ${setup} failure retires only its unjoined guard`, async () => {
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const server = fakeOpenCode({
    "GET /api/session/ses_child": async ({ signal }) => { entered(); await gate; signal.throwIfAborted(); return session("ses_child", { parentID: "ses_parent" }); },
  });
  const provider = server.provider();
  // Inject only a synchronous setup fault; normal reads still use the real SDK.
  const state = provider as unknown as {
    verifiedChild(child: string, parent: string, signal: AbortSignal): Promise<boolean>;
    readSignal(signal?: AbortSignal): AbortSignal;
    childParents: { read(...args: unknown[]): Promise<readonly [string, string]> };
    ownershipChecks: Set<unknown>;
    childParentReads: Map<string, { users: number }>;
  };
  const signal = new AbortController().signal;
  const existing = state.verifiedChild("ses_child", "ses_parent", signal);
  let later: Promise<boolean> | undefined;
  try {
    await started;
    const fault = setup === "readSignal" ? spyOn(state, "readSignal") : spyOn(state.childParents, "read");
    fault.mockImplementation(() => { throw new Error("injected shared-read setup failure"); });
    try {
      // More failures than the guard capacity must not crowd out later checks.
      for (let index = 0; index < 16; index++) {
        await expect(state.verifiedChild("ses_failed", "ses_parent", signal)).rejects.toThrow("injected shared-read setup failure");
        expect(state.ownershipChecks.size).toBe(1);
        expect(state.childParentReads.size).toBe(1);
        expect(state.childParentReads.get("ses_child")?.users).toBe(1);
        expect(server.requests("GET", "/api/session/ses_child")[0]!.signal.aborted).toBe(false);
      }
    } finally { fault.mockRestore(); }
    later = state.verifiedChild("ses_child", "ses_parent", signal);
    expect(state.ownershipChecks.size).toBe(2);
    expect(state.childParentReads.get("ses_child")?.users).toBe(2);
    release();
    expect(await existing).toBe(true);
    expect(await later).toBe(true);
    expect(state.ownershipChecks.size).toBe(0);
    expect(state.childParentReads.size).toBe(0);
    expect(server.requests("GET", "/api/session/ses_child")).toHaveLength(1);
    expect(server.calls.every(call => call.method === "GET")).toBe(true);
  } finally { release(); await Promise.allSettled([existing, ...(later ? [later] : [])]); await provider.dispose(); }
});

for (const foreignWorkspace of [false, true]) test(`shared child ownership checks each caller's parent (${foreignWorkspace ? "foreign workspace" : "foreign parent first"})`, async () => {
  const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const server = fakeOpenCode({
    "GET /api/session/:id/message": ({ path }) => ({ data: path.includes("ses_child/") ? [] : [fixture.launch], cursor: {} }),
    "GET /api/session/:id": async ({ path }) => {
      const id = path.split("/").at(-1)!;
      if (id !== "ses_child") return session(id);
      entered(); await gate;
      return session(id, { parentID: "ses_parent", ...(foreignWorkspace ? { location: { directory: "/foreign" } } : {}) });
    },
  });
  const provider = server.provider();
  const foreign = provider.listMessages("ses_other", { limit: 10 });
  let owned: ReturnType<typeof provider.listMessages> | undefined;
  try {
    await started;
    owned = provider.listMessages("ses_parent", { limit: 10 });
    const deadline = Date.now() + 1_000;
    while ((provider as unknown as { ownershipChecks: Set<unknown> }).ownershipChecks.size < 2 && Date.now() < deadline) await Bun.sleep(0);
    expect((provider as unknown as { ownershipChecks: Set<unknown> }).ownershipChecks.size).toBe(2);
    release();
    expect((await foreign).completeItems?.some(item => item.type === "background_task")).toBe(false);
    expect((await owned).completeItems?.some(item => item.type === "background_task")).toBe(!foreignWorkspace);
    expect(server.requests("GET", "/api/session/ses_child")).toHaveLength(1);
    if (foreignWorkspace) expect(server.requests("GET", "/api/session/ses_child/message")).toHaveLength(0);
  } finally { release(); await Promise.allSettled([foreign, ...(owned ? [owned] : [])]); await provider.dispose(); }
});

test("a stream child deadline leaves a concurrent history recovery alive", async () => {
  const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
  let wire!: ReadableStreamDefaultController<Uint8Array>, entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const frame = (type: string, data: unknown) => wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type, data, created: 30, location: { directory: WORKSPACE } })}\n\n`));
  const server = fakeOpenCode({
    "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) { wire = controller; frame("server.connected", {}); } }), { headers: { "content-type": "text/event-stream" } }),
    "GET /api/session/ses_parent": () => session("ses_parent"),
    "GET /api/session/ses_parent/message": () => ({ data: [fixture.launch], cursor: {} }),
    "GET /api/session/ses_child": async ({ signal }) => { entered(); await gate; signal.throwIfAborted(); return session("ses_child", { parentID: "ses_parent" }); },
    "GET /api/session/ses_child/message": () => ({ data: [], cursor: {} }),
  });
  const provider = server.provider(), stream = observedNativeStream(provider);
  let recovery: ReturnType<typeof provider.listMessages> | undefined;
  try {
    await stream.seen(event => event.eventType === "server.connected");
    frame("session.message.content.updated", { sessionID: "ses_parent", messageID: fixture.launch.id, content: [{ type: "text", text: "Survives deadline" }, ...fixture.launch.content] });
    await started;
    recovery = provider.listMessages("ses_parent", { limit: 10 });
    void recovery.catch(() => undefined);
    const deadline = Date.now() + 800;
    while ((provider as unknown as { ownershipChecks: Set<unknown> }).ownershipChecks.size < 2 && Date.now() < deadline) await Bun.sleep(0);
    expect((provider as unknown as { ownershipChecks: Set<unknown> }).ownershipChecks.size).toBe(2);
    await stream.seen(event => event.updates.some(update => update.kind === "text" && update.text === "Survives deadline"));
    expect(server.requests("GET", "/api/session/ses_child")[0]!.signal.aborted).toBe(false);
    release();
    expect((await recovery).completeItems).toContainEqual(expect.objectContaining({ type: "background_task", childConversationId: "ses_child" }));
    expect(server.requests("GET", "/api/session/ses_child")).toHaveLength(1);
    expect(server.calls.every(call => call.method === "GET")).toBe(true);
  } finally { release(); await recovery?.catch(() => undefined); stream.lifetime.abort(); await stream.pump.catch(() => undefined); await provider.dispose(); }
});

for (const kind of ["agent", "shell"] as const) for (const reconnect of [false, true]) test(`new live ${kind} is stoppable ${reconnect ? "after a native observation gap" : "without a gap"}`, async () => {
  const { fake, provider, adapter } = nativeBackgroundStack();
  let stream = observedNativeStream(provider);
  try {
    await stream.seen(event => event.eventType === "server.connected");
    const parent = (await provider.createSession("Fresh worker coverage")).id;
    if (reconnect) {
      fake.disconnect(); await stream.pump;
      stream = observedNativeStream(provider);
      await stream.seen(event => event.eventType === "server.connected");
    }
    const worker = kind === "agent" ? fake.launchWorker(parent, true) : fake.launchShell(parent, true);
    await stream.seen(event => event.updates.some(update => update.kind === "upsert" && update.item.type === "background_task" && update.item.taskId === worker.taskId));
    const rows = await provider.reconcileBackgroundTasks(parent, { fresh: true });
    let failure: unknown;
    try { await provider.stopTask(parent, worker.taskId); } catch (error) { failure = error; }
    const calls = fake.state().calls.filter(call => "childId" in worker
      ? call.startsWith(`POST /api/session/${worker.childId}/interrupt?`)
      : call.startsWith(`DELETE /api/shell/${worker.shellId}?`));
    expect(calls).toHaveLength(1);
    expect(failure).toBeUndefined();
    expect(rows).toContainEqual(expect.objectContaining({ taskId: worker.taskId, status: "running", stateUncertain: false }));
    expect(fake.state().unhandled).toEqual([]);
  } finally {
    stream.lifetime.abort(); await stream.pump.catch(() => undefined);
    await adapter.dispose(); await fake.stop();
  }
});

for (const kind of ["agent", "shell"] as const) test(`history alone cannot authorize a ${kind} born while the native stream was disconnected`, async () => {
  const { fake, provider, adapter } = nativeBackgroundStack();
  let stream = observedNativeStream(provider);
  try {
    await stream.seen(event => event.eventType === "server.connected");
    const parent = (await provider.createSession("Uncovered worker")).id;
    fake.disconnect(); await stream.pump;
    const worker = kind === "agent" ? fake.launchWorker(parent, true) : fake.launchShell(parent, true);
    stream = observedNativeStream(provider);
    await stream.seen(event => event.eventType === "server.connected");
    expect(await provider.reconcileBackgroundTasks(parent, { fresh: true })).toContainEqual(expect.objectContaining({ taskId: worker.taskId, stateUncertain: true }));
    await expect(provider.stopTask(parent, worker.taskId)).rejects.toThrow();
    expect(fake.state().calls.filter(call => "childId" in worker
      ? call.startsWith(`POST /api/session/${worker.childId}/interrupt?`)
      : call.startsWith(`DELETE /api/shell/${worker.shellId}?`))).toEqual([]);
    expect(fake.state().unhandled).toEqual([]);
  } finally {
    stream.lifetime.abort(); await stream.pump.catch(() => undefined);
    await adapter.dispose(); await fake.stop();
  }
});

for (const kind of ["agent", "shell"] as const) for (const veto of ["none", "initial-snapshot", "initial-pending", "initial-sparse", "initial-input", "initial-clock", "initial-completed", "initial-unwitnessed", "history-first", "history-first-input", "foreign-parent", "input", "new-run", "gap", "settled", "revoked", "inflight-input"] as const) test(`fresh native-shaped ${kind} sparse launch keeps activity and owned Stop (${veto})`, async () => {
  // Native 2.2.2 persisted shape/relative chronology; delivery envelopes and
  // identities are synthetic, not a recording of the native event stream.
  const input = kind === "agent" ? { agent: "worker", prompt: "Check fixture", background: true } : { command: "sleep 30", background: true };
  const metadata = { status: "running", truncated: false, ...(kind === "agent" ? { sessionID: "ses_child" } : { shellID: "sh_child" }) };
  const tool = { id: "fresh-call", type: "tool", name: kind === "agent" ? "subagent" : "shell", executed: false,
    time: { created: 103, ran: 113, completed: 151 }, state: { status: "completed", input, metadata, content: [] } };
  const launch = { id: "fresh-message", type: "assistant", time: { created: 97 }, content: [tool] };
  let history: unknown[] = [], wire!: ReadableStreamDefaultController<Uint8Array>, sequence = 0, foreignParent = false;
  let ownershipRead: (() => Promise<void>) | undefined;
  const frame = (type: string, data: unknown, created: number) => wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ id: `fresh-event-${++sequence}`, type, data, created,
    location: { directory: WORKSPACE }, ...(type.startsWith("session.") ? { durable: { aggregateID: (data as { sessionID: string }).sessionID, seq: sequence, version: 1 } } : {}) })}\n\n`));
  const server = fakeOpenCode({
    "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) { wire = controller; frame("server.connected", {}, 1); } }), { headers: { "content-type": "text/event-stream" } }),
    "GET /api/session/active": () => kind === "agent" ? { ses_child: { type: "running" } } : {},
    "GET /api/session/:id": async ({ path }) => {
      if (path.endsWith("ses_child")) await ownershipRead?.();
      return session(path.split("/").at(-1)!, path.endsWith("ses_child") ? { parentID: foreignParent ? "ses_foreign" : "ses_parent", time: { created: 147, updated: 153 } } : { time: { created: 2, updated: 3 } });
    },
    "GET /api/session/ses_parent/message": () => ({ data: history, cursor: {} }),
    "GET /api/session/ses_child/message": () => ({ data: [], cursor: {} }),
    "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
    "GET /api/permission/request": () => scoped([]), "GET /api/form": () => scoped([]),
    "GET /api/shell/sh_child": async () => { await ownershipRead?.(); return scoped({ id: "sh_child", command: "sleep 30", cwd: WORKSPACE, shell: "/bin/sh", file: "/fixture/output", status: "running", metadata: { sessionID: foreignParent ? "ses_foreign" : "ses_parent" }, time: { started: 147 } } satisfies ShellInfo); },
    "POST /api/session/ses_child/interrupt": () => ({ interrupted: true }),
    "DELETE /api/shell/sh_child": () => undefined,
  });
  const provider = server.provider(), stream = observedNativeStream(provider);
  const send = async (type: string, data: unknown, created: number) => {
    const start = stream.events.length;
    frame(type, data, created);
    await stream.seen(event => stream.events.indexOf(event) >= start && event.eventType === type);
  };
  const common = { sessionID: "ses_parent", assistantMessageID: launch.id, id: tool.id };
  try {
    await stream.seen(event => event.eventType === "server.connected");
    await send("session.created", { sessionID: "ses_parent", projectID: "global", slug: "fixture", version: "2.2.2", location: { directory: WORKSPACE } }, 2);
    await send("session.tool.input.started", { ...common, name: tool.name }, 103);
    if (veto.startsWith("initial-")) {
      // Synthetic delivery of a native pending/running part, before its child
      // exists. These envelopes are not inferred from persisted part clocks.
      const initial = { ...tool, time: { created: veto === "initial-clock" ? 102 : 103,
        ...(veto === "initial-completed" ? { completed: 110 } : {}) }, state: {
        status: veto === "initial-completed" ? "completed" : veto === "initial-pending" ? "pending" : "running",
        ...(veto === "initial-sparse" ? {} : { input: veto === "initial-input" ? { ...input, background: false } : input }),
      } };
      await send("session.message.content.updated", { sessionID: "ses_parent", messageID: launch.id, content: [initial] }, 110);
      if (veto === "initial-pending") await send("session.message.content.updated", { sessionID: "ses_parent", messageID: launch.id,
        content: [{ ...initial, state: { ...initial.state, status: "running" } }] }, 111);
    }
    if (veto !== "initial-unwitnessed") await send("session.tool.called", { ...common, input, executed: false }, 113);
    if (kind === "agent") await send("session.created", { sessionID: "ses_child", parentID: "ses_parent", projectID: "global", slug: "fixture-child", version: "2.2.2", location: { directory: WORKSPACE } }, 147);
    else await send("shell.created", { info: { id: "sh_child", command: "sleep 30", cwd: WORKSPACE, shell: "/bin/sh", file: "/fixture/output", status: "running", time: { started: 147 }, metadata: { sessionID: "ses_parent" } } }, 147);
    if (veto === "history-first") { history = [launch]; await provider.reconcileBackgroundTasks("ses_parent", { fresh: true }); }
    if (veto === "history-first-input") {
      history = [{ ...launch, content: [{ ...tool, state: { ...tool.state, input: { ...input, background: false } } }] }];
      await provider.reconcileBackgroundTasks("ses_parent", { fresh: true });
    }
    await send("session.tool.success", { ...common, executed: false, content: [], metadata }, 151);
    const partial = stream.events.flatMap(event => event.updates.flatMap(update => update.kind === "upsert" && update.item.type === "background_task" ? [update.item] : [])).at(-1);
    const partialRef = partial?.activity?.launchRef;
    if (veto === "none") {
      expect(partial?.activity?.executionId).toBeUndefined();
      expect(partialRef).toMatch(/^v1:launch:/);
    }
    if (kind === "agent") await send("session.execution.started", { sessionID: "ses_child" }, 153);
    history = [launch];
    const [row] = await provider.reconcileBackgroundTasks("ses_parent", { fresh: true });
    expect(row?.activity?.kind).toBe("working");
    expect(row?.control?.available).toBe(!["history-first-input", "initial-input", "initial-clock", "initial-completed", "initial-unwitnessed"].includes(veto));
    if (veto === "none") {
      expect(row?.activity?.launchRef).toBe(partialRef);
      const items = (await provider.listMessages("ses_parent", { limit: 100 })).items;
      const task = items.find(item => item.type === "background_task");
      expect(task?.type === "background_task" && task.activity?.launchRef).toBe(partialRef);
    }
    const changed = () => send("session.message.content.updated", { sessionID: "ses_parent", messageID: launch.id,
      content: [{ ...tool, state: { ...tool.state, input: kind === "agent" ? { ...input, prompt: "Different invocation" } : { ...input, command: "different command" } } }] }, 160);
    if (veto === "foreign-parent") foreignParent = true;
    if (veto === "input") await changed();
    if (veto === "new-run") {
      if (kind === "agent") await send("session.execution.started", { sessionID: "ses_child" }, 160);
      else await send("shell.created", { info: { id: "sh_child", command: "sleep 30", cwd: WORKSPACE, shell: "/bin/sh", file: "/fixture/reused", status: "running", time: { started: 160 }, metadata: { sessionID: "ses_parent" } } }, 160);
    }
    if (veto === "settled") {
      const payload = { type: "synthetic", text: "Fixture finished", metadata: { source: kind === "agent" ? "subagent" : "shell", state: "completed", ...(kind === "agent" ? { childID: "ses_child" } : { shellID: "sh_child", exit: 0 }) } };
      await send("session.inbox.enqueued", { sessionID: "ses_parent", inboxID: "fresh-result", item: { type: "synthetic", payload } }, 160);
      history.push({ ...payload, id: "fresh-result", time: { created: 160 } });
    }
    if (veto === "revoked") await send("session.moved", { sessionID: "ses_parent", location: { directory: "/foreign" } }, 160);
    if (veto === "gap") { wire.close(); await stream.pump; }
    if (veto === "inflight-input") ownershipRead = async () => { ownershipRead = undefined; await changed(); };
    const stoppable = ["none", "initial-snapshot", "initial-pending", "initial-sparse", "history-first"].includes(veto);
    if (stoppable) await provider.stopTask("ses_parent", row!.taskId);
    else await expect(provider.stopTask("ses_parent", row!.taskId)).rejects.toThrow();
    if (["foreign-parent", "input", "new-run", "gap", "revoked", "inflight-input"].includes(veto)) {
      const recovered = (await provider.reconcileBackgroundTasks("ses_parent", { fresh: true })).find(item => item.taskId === row!.taskId);
      expect(recovered?.activity?.launchRef).toBeUndefined();
    }
    expect(server.calls.filter(call => call.method !== "GET").map(call => `${call.method} ${call.path}`)).toEqual(stoppable ? [kind === "agent" ? "POST /api/session/ses_child/interrupt" : "DELETE /api/shell/sh_child"] : []);
  } finally { stream.lifetime.abort(); await stream.pump; await provider.dispose(); }
});

for (const live of ["cold", "content", "tool-success"] as const) for (const executed of [false, true]) test(`native 2.2.2 background shell launcher remains working with current inventory (executed=${executed}/live=${live})`, async () => {
  // Stored native 2.2.2 launcher, with sanitized IDs/output and relative clocks.
  // Live envelopes are synthetic: original delivery clocks were not retained.
  // Inventory contains the ownership/command/running facts verified live.
  const command = "sleep 30; printf 'Timer task finished\\n'";
  const launch = { id: "message-timer", type: "assistant", time: {
    created: 1_790_000_000_000, streamed: 1_790_000_002_310, completed: 1_790_000_002_338,
  }, content: [{
    id: "call-timer", type: "tool", name: "shell", executed,
    time: { created: 1_790_000_002_071, ran: 1_790_000_002_264, completed: 1_790_000_002_305 },
    state: { status: "completed", input: { command, background: true },
      metadata: { status: "running", truncated: false, shellID: "sh_timer" },
      content: [{ type: "text", text: "Moved to background. Output file: /fixture/timer.out" }] },
  }] };
  const server = fakeOpenCode({
    "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) {
      const common = { sessionID: "ses_parent", assistantMessageID: launch.id, id: "call-timer" };
      const events = live === "tool-success" ? [
        { type: "session.tool.input.started", data: { ...common, name: "shell" } },
        { type: "session.tool.called", data: { ...common, input: { command, background: true }, executed } },
        { type: "session.tool.success", data: { ...common, executed, metadata: launch.content[0]!.state.metadata, content: launch.content[0]!.state.content } },
      ].map((event, index) => ({ ...event, id: `event-timer-${index}`, created: 1_790_000_002_306 + index,
        location: { directory: WORKSPACE }, durable: { aggregateID: "ses_parent", seq: index + 1, version: 1 } })) : [{
        id: "event-timer-launch", type: "session.message.content.updated", created: 1_790_000_002_309,
        location: { directory: WORKSPACE }, durable: { aggregateID: "ses_parent", seq: 1, version: 1 },
        data: { sessionID: "ses_parent", messageID: launch.id, content: launch.content },
      }];
      for (const event of [{ type: "server.connected", data: {} }, ...events]) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
    } }), { headers: { "content-type": "text/event-stream" } }),
    "GET /api/session/ses_parent": () => session("ses_parent"),
    "GET /api/session/ses_parent/message": () => ({ data: [launch], cursor: {} }),
    "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
    "GET /api/session/active": () => ({}),
    "GET /api/shell/sh_timer": () => scoped({ id: "sh_timer", command, cwd: WORKSPACE,
      shell: "/bin/sh", file: "/fixture/timer.out", status: "running", metadata: { sessionID: "ses_parent" },
      time: { started: 1_790_000_002_265 } } satisfies ShellInfo),
  });
  const provider = server.provider();
  let stream: ReturnType<typeof observedNativeStream> | undefined;
  try {
    if (live !== "cold") {
      stream = observedNativeStream(provider);
      await stream.seen(event => event.eventType === (live === "content" ? "session.message.content.updated" : "session.tool.success"));
    }
    const rows = await provider.reconcileBackgroundTasks("ses_parent", { fresh: true });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "running", activity: { kind: "working" } });
    if (live === "tool-success") {
      expect(rows[0]?.control?.available).toBe(false);
      await expect(provider.stopTask("ses_parent", rows[0]!.taskId)).rejects.toThrow();
      // Subsequent readback must not downgrade independently verified activity.
      expect((await provider.reconcileBackgroundTasks("ses_parent", { fresh: true }))[0]?.activity?.kind).toBe("working");
    }
    expect(server.calls.every(call => call.method === "GET")).toBe(true);
  } finally { stream?.lifetime.abort(); await stream?.pump; await provider.dispose(); }
});

for (const unavailableControl of [false, true]) test(`exact shell inventory end remains unresolved independently of control (unavailable=${unavailableControl})`, async () => {
  const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
  let exited = false;
  const server = fakeOpenCode({
    "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) {
      for (const event of [{ type: "server.connected", data: {} }, { id: "parent-birth", created: 2, type: "session.created", location: { directory: WORKSPACE }, data: {
        sessionID: "ses_parent", projectID: "global", slug: "fixture-parent", version: "2.1.2", location: { directory: WORKSPACE } } }])
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
      if (!unavailableControl) for (const event of [
        { id: "shell-birth", created: 71, type: "shell.created", data: { info: { ...nativeShellInfo(), file: "/fixture/output" } } },
        { id: "shell-launch", created: 80, type: "session.message.content.updated", data: { sessionID: "ses_parent", messageID: fixture.shell.id, content: fixture.shell.content } },
      ]) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ ...event, location: { directory: WORKSPACE } })}\n\n`));
    } }), { headers: { "content-type": "text/event-stream" } }),
    "GET /api/session/ses_parent": () => session("ses_parent"),
    "GET /api/session/ses_parent/message": () => ({ data: [fixture.shell], cursor: {} }),
    "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
    "GET /api/session/active": () => ({}),
    "GET /api/shell/sh_fixture": () => scoped({ id: "sh_fixture", command: "printf fixture", cwd: WORKSPACE, shell: "/bin/sh", file: "/fixture/output",
      status: exited ? "exited" : "running", metadata: { sessionID: "ses_parent" }, time: { started: 71, ...(exited ? { completed: 90 } : {}) } } satisfies ShellInfo),
    "DELETE /api/shell/sh_fixture": () => undefined,
  });
  const provider = server.provider();
  let stream: ReturnType<typeof observedNativeStream> | undefined;
  try {
    stream = observedNativeStream(provider);
    if (unavailableControl) {
      // A covered startup with no retained live launcher does not authorize
      // Stop, although complete inventory can independently verify activity.
      await stream.seen(event => event.eventType === "session.created");
    } else await stream.seen(event => event.eventType === "session.message.content.updated");
    expect((await provider.reconcileBackgroundTasks("ses_parent", { fresh: true }))[0]?.activity?.kind).toBe("working");
    exited = true;
    const [ended] = await provider.reconcileBackgroundTasks("ses_parent", { fresh: true });
    expect(ended).toMatchObject({ status: "running", activity: { kind: "ended", endedAt: 90 } });
    expect(ended?.control).toEqual(unavailableControl ? { available: false, reason: "Worker control is unverified" } : { available: true });
    if (unavailableControl) {
      await expect(provider.stopTask("ses_parent", ended!.taskId)).rejects.toThrow();
      expect(server.calls.every(call => call.method === "GET")).toBe(true);
    } else {
      await provider.stopTask("ses_parent", ended!.taskId);
      expect(server.requests("DELETE", "/api/shell/sh_fixture")).toHaveLength(1);
    }
  } finally { stream?.lifetime.abort(); await stream?.pump; await provider.dispose(); }
});

for (const birthScope of ["owned", "foreign", "foreign-only"] as const) for (const ordering of ["live", "history-activity", "history-control"] as const) for (const replacementStatus of ["running", "exited"] as const) test(`distinct prelaunch shell births cannot lend replacement activity to a delayed old launcher (${replacementStatus}/${ordering}/${birthScope})`, async () => {
  const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
  let wire!: ReadableStreamDefaultController<Uint8Array>;
  const first: ShellInfo = { id: "sh_fixture", status: "running", command: "printf fixture", cwd: WORKSPACE,
    shell: "/bin/sh", file: "/fixture/old.out", metadata: { sessionID: "ses_parent" }, time: { started: 65 } };
  const replacement = { ...first, file: "/fixture/replacement.out", time: { started: 95 } };
  const adjacent = { ...first, id: "sh_adjacent", file: "/fixture/adjacent.out", time: { started: 120 } };
  const adjacentMessage = { id: "message-adjacent", type: "assistant", time: { created: 119 }, content: [{ type: "tool", id: "call_adjacent", name: "shell",
    time: { created: 119, ran: 119, completed: 122 }, state: { status: "completed", input: { command: "printf fixture" }, metadata: { shellID: adjacent.id, status: "running" } } }] };
  let history: unknown[] = [fixture.shell];
  const frame = (id: string, type: string, data: unknown, created: number, directory = WORKSPACE) => wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ id, type, data, created, location: { directory } })}\n\n`));
  const server = fakeOpenCode({
    "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) { wire = controller; frame("connected", "server.connected", {}, 1); } }), { headers: { "content-type": "text/event-stream" } }),
    "GET /api/session/ses_parent": () => session("ses_parent"),
    "GET /api/session/ses_parent/message": () => ({ data: history, cursor: {} }),
    "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
    "GET /api/session/active": () => ({}),
    "GET /api/shell/sh_fixture": () => scoped({ ...replacement, status: replacementStatus,
      time: { ...replacement.time, ...(replacementStatus === "exited" ? { completed: 110 } : {}) } }),
    "DELETE /api/shell/sh_fixture": () => undefined,
    "GET /api/shell/sh_adjacent": () => scoped(adjacent),
    "DELETE /api/shell/sh_adjacent": () => undefined,
  });
  const provider = server.provider(), taskId = "v2:ses_parent:call_shell";
  let stream = observedNativeStream(provider);
  try {
    await stream.seen(event => event.eventType === "server.connected");
    if (birthScope !== "foreign-only") frame("birth-A", "shell.created", { info: first }, 66);
    frame("birth-B", "shell.created", { info: replacement }, 96, birthScope === "owned" ? WORKSPACE : "/foreign");
    let live: import("../../types").BackgroundTaskItem | undefined;
    if (ordering === "live") {
      frame("delayed-launch-A", "session.message.content.updated", { sessionID: "ses_parent", messageID: fixture.shell.id, content: fixture.shell.content }, 80);
      await stream.seen(event => event.updates.some(update => {
        if (update.kind !== "upsert" || update.item.type !== "background_task" || update.item.taskId !== taskId) return false;
        live = update.item; return true;
      }));
    } else {
      // Drain both native births before any task is projected. Only the API
      // history read below introduces A's delayed launcher to the provider.
      frame("birth-barrier", "session.text.delta", { sessionID: "ses_parent", assistantMessageID: "barrier", id: "barrier-text", delta: "births drained" }, 100);
      await stream.seen(event => event.updates.some(update => update.kind === "text" && update.text === "births drained"));
      live = (await provider.reconcileBackgroundTasks("ses_parent", { fresh: true }))[0];
    }
    if (ordering === "history-control") {
      let failure: unknown;
      try { await provider.stopTask("ses_parent", taskId); } catch (error) { failure = error; }
      expect(server.requests("DELETE", "/api/shell/sh_fixture")).toHaveLength(0);
      expect(failure).toBeDefined();
    }
    const check = (row: import("../../types").BackgroundTaskItem | undefined) => {
      expect(row).toBeDefined();
      expect(row?.activity?.kind).not.toBe("working");
      expect(row?.activity?.kind).not.toBe("needs-answer");
      expect(row?.activity?.observedAt).toBeUndefined();
      expect(row?.activity?.endedAt).toBeUndefined();
      expect(row?.control?.available).toBe(false);
    };
    check(live);
    for (let read = 0; read < 2; read++) check((await provider.reconcileBackgroundTasks("ses_parent", { fresh: true }))[0]);
    await expect(provider.stopTask("ses_parent", taskId)).rejects.toThrow();
    expect(server.calls.every(call => call.method === "GET")).toBe(true);
    if (ordering === "history-control") {
      wire.close(); await stream.pump;
      stream = observedNativeStream(provider);
      await stream.seen(event => event.eventType === "server.connected");
      check((await provider.reconcileBackgroundTasks("ses_parent", { fresh: true }))[0]);
      await expect(provider.stopTask("ses_parent", taskId)).rejects.toThrow();
      expect(server.requests("DELETE", "/api/shell/sh_fixture")).toHaveLength(0);
      // The contradiction is per native job, not a permanent global closure.
      history = [fixture.shell, adjacentMessage];
      frame("adjacent-birth", "shell.created", { info: adjacent }, 121);
      frame("adjacent-launch", "session.message.content.updated", { sessionID: "ses_parent", messageID: adjacentMessage.id, content: adjacentMessage.content }, 122);
      await stream.seen(event => event.updates.some(update => update.kind === "upsert" && update.item.type === "background_task" && update.item.taskId === "v2:ses_parent:call_adjacent"));
      // Re-receiving the exact consumed native birth is not a second birth.
      frame("adjacent-birth", "shell.created", { info: adjacent }, 121);
      frame("replay-barrier", "session.text.delta", { sessionID: "ses_parent", assistantMessageID: "replay", id: "replay-text", delta: "replay drained" }, 123);
      await stream.seen(event => event.updates.some(update => update.kind === "text" && update.text === "replay drained"));
      const recovered = await provider.reconcileBackgroundTasks("ses_parent", { fresh: true });
      check(recovered.find(row => row.taskId === taskId));
      expect(recovered.find(row => row.taskId === "v2:ses_parent:call_adjacent")).toMatchObject({ activity: { kind: "working" }, control: { available: true } });
      await provider.stopTask("ses_parent", "v2:ses_parent:call_adjacent");
      expect(server.requests("DELETE", "/api/shell/sh_adjacent")).toHaveLength(1);
      expect(server.requests("DELETE", "/api/shell/sh_fixture")).toHaveLength(0);
    }
  } finally { stream.lifetime.abort(); await stream.pump; await provider.dispose(); }
});

for (const knownEnd of [false, true]) for (const change of ["command-stop", "command-readback", "foreign-owner", "started", "file", "started-file", "inflight-started", "cwd", "shell", "pid", "native-id", "missing-command", "missing-file", "missing-started", "malformed-started", "malformed-pid", "missing-status", "missing-cwd", "missing-shell", "missing-id", "missing-owner", "failed-read"] as const) test(`fresh shell inventory fences retained command without a replacement birth (${change}/old end=${knownEnd})`, async () => {
  const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
  const adjacent = structuredClone(fixture.shell);
  adjacent.id = "msg_adjacent";
  adjacent.content[0].id = "call_adjacent";
  adjacent.content[0].state.input.command = "healthy job";
  adjacent.content[0].state.metadata.shellID = "sh_adjacent";
  let wire!: ReadableStreamDefaultController<Uint8Array>;
  const original: ShellInfo = { id: "sh_fixture", status: "running", command: "printf fixture", cwd: WORKSPACE,
    shell: "/bin/sh", file: "/fixture/old.out", pid: 123, metadata: { sessionID: "ses_parent" }, time: { started: 75 } };
  let shell: Record<string, unknown> = original, failed = false;
  let heldRead: (() => Promise<void>) | undefined, releaseRead: (() => void) | undefined, pendingStop: Promise<void> | undefined;
  const frame = (id: string, type: string, data: unknown, created: number) => wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ id, type, data, created, location: { directory: WORKSPACE } })}\n\n`));
  const server = fakeOpenCode({
    "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) { wire = controller; frame("connected", "server.connected", {}, 1); } }), { headers: { "content-type": "text/event-stream" } }),
    "GET /api/session/ses_parent": () => session("ses_parent"),
    "GET /api/session/ses_parent/message": () => ({ data: [fixture.shell, adjacent], cursor: {} }),
    "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
    "GET /api/session/active": () => ({}),
    "GET /api/shell/sh_fixture": async () => { const held = heldRead; heldRead = undefined; await held?.(); return failed ? Response.json({ _tag: "ShellNotFoundError" }, { status: 404 }) : scoped(shell); },
    "DELETE /api/shell/sh_fixture": () => undefined,
    "GET /api/shell/sh_adjacent": () => scoped({ ...original, id: "sh_adjacent", command: "healthy job" }),
    "DELETE /api/shell/sh_adjacent": () => undefined,
  });
  const provider = server.provider(), stream = observedNativeStream(provider), taskId = "v2:ses_parent:call_shell";
  try {
    await stream.seen(event => event.eventType === "server.connected");
    frame("old-input", "session.tool.input.started", { sessionID: "ses_parent", assistantMessageID: fixture.shell.id, id: "call_shell", name: "shell" }, 70);
    frame("old-call", "session.tool.called", { sessionID: "ses_parent", assistantMessageID: fixture.shell.id, id: "call_shell", input: { command: original.command }, executed: false }, 71);
    frame("old-birth", "shell.created", { info: original }, 75);
    frame("old-launch", "session.message.content.updated", { sessionID: "ses_parent", messageID: fixture.shell.id, content: fixture.shell.content }, 80);
    frame("healthy-birth", "shell.created", { info: { ...original, id: "sh_adjacent", command: "healthy job" } }, 75);
    frame("healthy-launch", "session.message.content.updated", { sessionID: "ses_parent", messageID: adjacent.id, content: adjacent.content }, 80);
    await stream.seen(event => event.updates.some(update => update.kind === "upsert" && update.item.type === "background_task" && update.item.taskId === taskId));
    await stream.seen(event => event.updates.some(update => update.kind === "upsert" && update.item.type === "background_task" && update.item.taskId === "v2:ses_parent:call_adjacent"));
    const [initial] = await provider.reconcileBackgroundTasks("ses_parent", { fresh: true });
    expect(initial?.control?.available).toBe(true);
    expect(initial?.activity?.kind).toBe("working");
    expect(initial?.activity?.launchRef).toBeDefined();
    if (knownEnd) {
      frame("old-exit", "shell.exited", { id: original.id, status: "exited", exit: 0 }, 90);
      await stream.seen(event => event.eventType === "shell.exited");
    }
    if (change === "inflight-started") {
      let entered!: () => void;
      const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { releaseRead = resolve; });
      heldRead = async () => { entered(); await gate; };
      pendingStop = provider.stopTask("ses_parent", taskId); void pendingStop.catch(() => undefined);
      await started;
    }
    const identityChange = ["started", "file", "started-file", "inflight-started", "cwd", "shell", "pid", "native-id"].includes(change);
    const contradiction = change.startsWith("command") || change === "foreign-owner" || identityChange;
    shell = { ...original, ...(change.startsWith("command") ? { command: "replacement job B", time: { started: 95 } }
      : ["started", "file", "started-file", "inflight-started"].includes(change) ? { ...(change !== "file" ? { time: { started: 95 } } : {}), ...(["file", "started-file"].includes(change) ? { file: "/fixture/replacement.out" } : {}) }
      : change === "cwd" ? { cwd: "/replacement/cwd" } : change === "shell" ? { shell: "/bin/replacement" } : change === "pid" ? { pid: 456 }
      : change === "native-id" ? { id: "sh_replacement" }
      : change === "foreign-owner" ? { metadata: { sessionID: "ses_foreign" } }
      : change === "missing-command" ? { command: undefined } : change === "missing-file" ? { file: undefined }
      : change === "missing-started" ? { time: {} } : change === "malformed-started" ? { time: { started: "75" } }
      : change === "malformed-pid" ? { pid: "123" } : change === "missing-status" ? { status: undefined }
      : change === "missing-cwd" ? { cwd: undefined } : change === "missing-shell" ? { shell: undefined }
      : change === "missing-id" ? { id: undefined } : change === "missing-owner" ? { metadata: undefined } : {}) };
    failed = change === "failed-read";
    releaseRead?.();
    // Stop itself must consume the contradiction; no replacement birth or
    // preparatory readback is required to invalidate A's retained permission.
    if (change === "command-stop" || identityChange) {
      const stops = await Promise.allSettled([pendingStop ?? provider.stopTask("ses_parent", taskId), provider.stopTask("ses_parent", taskId)]);
      expect(stops.map(result => result.status)).toEqual(["rejected", "rejected"]);
      expect(server.requests("DELETE", "/api/shell/sh_fixture")).toHaveLength(0);
    }
    const [old] = await provider.reconcileBackgroundTasks("ses_parent", { fresh: true });
    if (!contradiction) {
      expect(old?.control?.available).toBe(false);
      await expect(provider.stopTask("ses_parent", taskId)).rejects.toThrow();
      expect(server.requests("DELETE", "/api/shell/sh_fixture")).toHaveLength(0);
      if (!knownEnd && !["failed-read", "missing-owner", "missing-command", "missing-status"].includes(change)) expect(old?.activity?.kind).toBe("working");
    }
    if (contradiction) {
      expect(old?.activity?.kind).toBe(knownEnd ? "ended" : "unavailable");
      expect(old?.activity?.endedAt).toBe(knownEnd ? 90 : undefined);
      expect(old?.activity?.launchRef).toBeUndefined();
      expect(old?.control?.available).toBe(false);
      await expect(provider.stopTask("ses_parent", taskId)).rejects.toThrow();
      expect(server.requests("DELETE", "/api/shell/sh_fixture")).toHaveLength(0);
    }
    // Inconclusive reads are not positive contradictions. Conversely a later
    // stale A inventory must not resurrect permission after B was observed.
    failed = false; shell = original;
    const [recovered] = await provider.reconcileBackgroundTasks("ses_parent", { fresh: true });
    expect(recovered?.control?.available).toBe(!contradiction);
    if (contradiction) {
      expect(recovered?.activity?.launchRef).toBeUndefined();
      await expect(provider.stopTask("ses_parent", taskId)).rejects.toThrow();
    } else await provider.stopTask("ses_parent", taskId);
    expect(server.requests("DELETE", "/api/shell/sh_fixture")).toHaveLength(contradiction ? 0 : 1);
    expect(await provider.reconcileBackgroundTasks("ses_parent", { fresh: true })).toContainEqual(expect.objectContaining({
      taskId: "v2:ses_parent:call_adjacent", activity: expect.objectContaining({ kind: "working" }), control: { available: true },
    }));
    await provider.stopTask("ses_parent", "v2:ses_parent:call_adjacent");
    expect(server.requests("DELETE", "/api/shell/sh_adjacent")).toHaveLength(1);
  } finally { releaseRead?.(); await pendingStop?.catch(() => undefined); stream.lifetime.abort(); await stream.pump; await provider.dispose(); }
});

for (const birth of ["full", "missing", "partial", "enriched", "optional"] as const) test(`private shell birth identity preserves independent activity and compatible live enrichment (${birth})`, async () => {
  const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
  const original = nativeShellInfo("sh_fixture", "ses_parent", "printf fixture", 75);
  let current: Record<string, unknown> = original, wire!: ReadableStreamDefaultController<Uint8Array>;
  const frame = (id: string, type: string, data: unknown, created: number) => wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ id, type, data, created, location: { directory: WORKSPACE } })}\n\n`));
  const server = fakeOpenCode({
    "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) { wire = controller; frame("connected", "server.connected", {}, 1); } }), { headers: { "content-type": "text/event-stream" } }),
    "GET /api/session/ses_parent": () => session("ses_parent"),
    "GET /api/session/ses_parent/message": () => ({ data: [fixture.shell], cursor: {} }),
    "GET /api/session/ses_parent/inbox": () => ({ data: [] }), "GET /api/session/active": () => ({}),
    "GET /api/shell/sh_fixture": () => scoped(current), "DELETE /api/shell/sh_fixture": () => undefined,
  });
  const provider = server.provider(), stream = observedNativeStream(provider), taskId = "v2:ses_parent:call_shell";
  try {
    await stream.seen(event => event.eventType === "server.connected");
    frame("input", "session.tool.input.started", { sessionID: "ses_parent", assistantMessageID: fixture.shell.id, id: "call_shell", name: "shell" }, 70);
    frame("call", "session.tool.called", { sessionID: "ses_parent", assistantMessageID: fixture.shell.id, id: "call_shell", input: { command: original.command }, executed: false }, 71);
    if (birth !== "missing") frame("birth", "shell.created", { info: { ...original, ...(["partial", "enriched"].includes(birth) ? { file: undefined } : {}) } }, 75);
    frame("launch", "session.message.content.updated", { sessionID: "ses_parent", messageID: fixture.shell.id, content: fixture.shell.content }, 80);
    await stream.seen(event => event.updates.some(update => update.kind === "upsert" && update.item.type === "background_task" && update.item.taskId === taskId));
    const [initial] = await provider.reconcileBackgroundTasks("ses_parent", { fresh: true });
    expect(initial?.activity?.kind).toBe("working");
    expect(initial?.control?.available).toBe(birth === "full" || birth === "optional");
    const reference = initial?.activity?.launchRef;
    if (birth !== "missing") expect(reference).toBeDefined();
    if (["missing", "partial", "enriched"].includes(birth)) {
      await expect(provider.stopTask("ses_parent", taskId)).rejects.toThrow();
      expect(server.requests("DELETE", "/api/shell/sh_fixture")).toHaveLength(0);
    }
    if (birth === "enriched" || birth === "optional") {
      current = { ...original, pid: 123 };
      frame("birth", "shell.created", { info: current }, 75);
      frame("barrier", "session.text.delta", { sessionID: "ses_parent", assistantMessageID: "barrier", id: "text", delta: "enriched" }, 90);
      await stream.seen(event => event.updates.some(update => update.kind === "text" && update.text === "enriched"));
    }
    // Repeated complete GET/history cannot fill an unobserved birth baseline.
    await provider.listMessages("ses_parent", { limit: 100 });
    const [recovered] = await provider.reconcileBackgroundTasks("ses_parent", { fresh: true });
    const available = birth !== "missing" && birth !== "partial";
    expect(recovered?.activity?.kind).toBe("working");
    expect(recovered?.activity?.launchRef).toBe(reference);
    expect(recovered?.control?.available).toBe(available);
    if (available) await provider.stopTask("ses_parent", taskId);
    else await expect(provider.stopTask("ses_parent", taskId)).rejects.toThrow();
    expect(server.requests("DELETE", "/api/shell/sh_fixture")).toHaveLength(available ? 1 : 0);
    if (birth === "optional") {
      // Optional omission is compatible, not a known conflicting PID.
      current = original;
      expect((await provider.reconcileBackgroundTasks("ses_parent", { fresh: true }))[0]?.control?.available).toBe(true);
    }
  } finally { stream.lifetime.abort(); await stream.pump; await provider.dispose(); }
});

for (const knownEnd of [false, true]) test(`replacement shell inventory cannot lend its end to an old occurrence (known old end=${knownEnd})`, async () => {
  const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
  let wire!: ReadableStreamDefaultController<Uint8Array>;
  let shell: ShellInfo = { id: "sh_fixture", status: "running", command: "printf fixture", cwd: WORKSPACE,
    shell: "/bin/sh", file: "/fixture/old.out", metadata: { sessionID: "ses_parent" }, time: { started: 65 } };
  const frame = (id: string, type: string, data: unknown, created: number) => wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ id, type, data, created, location: { directory: WORKSPACE } })}\n\n`));
  const server = fakeOpenCode({
    "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) { wire = controller; frame("connected", "server.connected", {}, 1); } }), { headers: { "content-type": "text/event-stream" } }),
    "GET /api/session/ses_parent": () => session("ses_parent"),
    "GET /api/session/ses_parent/message": () => ({ data: [fixture.shell], cursor: {} }),
    "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
    "GET /api/session/active": () => ({}),
    "GET /api/shell/sh_fixture": () => scoped(shell),
  });
  const provider = server.provider(), stream = observedNativeStream(provider);
  const taskId = "v2:ses_parent:call_shell";
  try {
    await stream.seen(event => event.eventType === "server.connected");
    frame("old-birth", "shell.created", { info: shell }, 66);
    frame("old-launch", "session.message.content.updated", { sessionID: "ses_parent", messageID: fixture.shell.id, content: fixture.shell.content }, 80);
    await stream.seen(event => event.updates.some(update => update.kind === "upsert" && update.item.type === "background_task" && update.item.taskId === taskId));
    const [initial] = await provider.reconcileBackgroundTasks("ses_parent", { fresh: true });
    expect(initial?.activity?.kind).toBe("working");
    if (knownEnd) {
      frame("old-exit", "shell.exited", { id: shell.id, status: "exited", exit: 0 }, 90);
      await stream.seen(event => event.eventType === "shell.exited");
      expect((await provider.reconcileBackgroundTasks("ses_parent", { fresh: true }))[0]?.activity).toMatchObject({ kind: "ended", endedAt: 90 });
    }
    shell = { ...shell, status: "exited", file: "/fixture/replacement.out", time: { started: 95, completed: 110 } };
    frame("replacement-birth", "shell.created", { info: { ...shell, status: "running", time: { started: 95 } } }, 96);
    frame("barrier", "session.text.delta", { sessionID: "ses_parent", assistantMessageID: "barrier", id: "barrier-text", delta: "replacement observed" }, 111);
    await stream.seen(event => event.updates.some(update => update.kind === "text" && update.text === "replacement observed"));
    const [old] = await provider.reconcileBackgroundTasks("ses_parent", { fresh: true });
    expect(old?.activity?.kind).toBe(knownEnd ? "ended" : "unavailable");
    expect(old?.activity?.endedAt).toBe(knownEnd ? 90 : undefined);
    expect(old?.activity?.executionId).toBe(initial?.activity?.executionId);
    expect(old?.control).toEqual({ available: false, reason: "Worker control is unverified" });
    await expect(provider.stopTask("ses_parent", taskId)).rejects.toThrow();
    expect(server.requests("GET", "/api/shell/sh_fixture").length).toBeGreaterThan(0);
    expect(server.calls.every(call => call.method === "GET")).toBe(true);
  } finally { stream.lifetime.abort(); await stream.pump; await provider.dispose(); }
});

for (const change of ["replay", "new-envelope", "command", "started", "foreign-parent", "foreign-scope", "missing-proof", "during-owned-read", "user-after-rebirth"] as const) {
  test(`native shell rebirth fences the retained Stop: ${change}`, async () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    let wire!: ReadableStreamDefaultController<Uint8Array>, armed = false, entered!: () => void, release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
    const frame = (raw: unknown) => wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(raw)}\n\n`));
    const shell = nativeShellInfo("sh_fixture", "ses_parent", fixture.shell.content[0].state.input.command, 65);
    const birth = { id: "shell-birth", created: 66, type: "shell.created", location: { directory: WORKSPACE }, data: { info: shell } };
    const server = fakeOpenCode({
      "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) { wire = controller; frame({ type: "server.connected", data: {} }); } }), { headers: { "content-type": "text/event-stream" } }),
      "GET /api/session/ses_parent": () => session("ses_parent"),
      "GET /api/session/ses_parent/message": () => ({ data: [fixture.shell], cursor: {} }),
      "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
      "GET /api/session/active": () => ({}),
      "GET /api/shell/sh_fixture": async () => { const owned = scoped(shell); if (armed) { armed = false; entered(); await gate; } return owned; },
      "DELETE /api/shell/sh_fixture": () => undefined,
    });
    const provider = server.provider();
    let stream = observedNativeStream(provider), stop: Promise<void> | undefined;
    const taskId = "v2:ses_parent:call_shell";
    const barrier = async (label: string) => {
      frame({ id: `barrier-${label}`, created: 100, type: "session.text.delta", location: { directory: WORKSPACE },
        data: { sessionID: "ses_parent", assistantMessageID: `message-${label}`, id: `text-${label}`, delta: label } });
      await stream.seen(event => event.updates.some(update => update.kind === "text" && update.text === label));
    };
    try {
      await stream.seen(event => event.eventType === "server.connected");
      wire.close(); await stream.pump;
      stream = observedNativeStream(provider);
      await stream.seen(event => event.eventType === "server.connected");
      frame(birth);
      frame({ id: "launcher", created: 80, type: "session.message.content.updated", location: { directory: WORKSPACE }, data: {
        sessionID: "ses_parent", messageID: fixture.shell.id, content: fixture.shell.content } });
      await stream.seen(event => event.updates.some(update => update.kind === "upsert" && update.item.type === "background_task" && update.item.taskId === taskId));
      expect(await provider.reconcileBackgroundTasks("ses_parent", { fresh: true })).toContainEqual(expect.objectContaining({ taskId, stateUncertain: false }));
      if (change === "during-owned-read") {
        armed = true; stop = provider.stopTask("ses_parent", taskId); void stop.catch(() => undefined); await started;
      }
      const changed = structuredClone(birth) as { id?: string; created: number; type: string; location: { directory: string }; data: { info: typeof shell } };
      if (["new-envelope", "during-owned-read", "user-after-rebirth"].includes(change)) changed.id = "different-birth";
      if (change === "command") changed.data.info.command = "a replacement shell";
      if (change === "started") changed.data.info.time.started = 95;
      if (change === "foreign-parent") changed.data.info.metadata.sessionID = "foreign-parent";
      if (change === "foreign-scope") changed.location.directory = "/foreign";
      if (change === "missing-proof") delete changed.id;
      frame(changed); await barrier("after-rebirth");
      if (change === "user-after-rebirth") {
        frame({ id: "user-shell", created: 101, type: "session.shell.ended", location: { directory: WORKSPACE }, data: { sessionID: "ses_parent", shell, output: { output: "User output" } } });
        frame({ id: "user-note", created: 102, type: "session.inbox.enqueued", location: { directory: WORKSPACE }, data: { sessionID: "ses_parent", inboxID: "user-result", item: {
          type: "synthetic", payload: { text: "User output", metadata: { source: "shell", shellID: "sh_fixture", state: "completed", exit: 0 } } } } });
        await barrier("after-user-note");
      }
      release();
      if (change === "replay") {
        await provider.stopTask("ses_parent", taskId);
        expect(server.requests("DELETE", "/api/shell/sh_fixture")).toHaveLength(1);
      } else {
        await expect(stop ?? provider.stopTask("ses_parent", taskId)).rejects.toThrow();
        expect(server.requests("DELETE", "/api/shell/sh_fixture")).toHaveLength(0);
        expect(await provider.reconcileBackgroundTasks("ses_parent", { fresh: true })).toContainEqual(expect.objectContaining({ taskId, stateUncertain: true }));
      }
    } finally {
      release(); await stop?.catch(() => undefined);
      stream.lifetime.abort(); await stream.pump.catch(() => undefined); await provider.dispose();
    }
  });
}

for (const change of ["compatible", "old-command", "missing-birth-command", "missing-launch-command", "alias-command"] as const) {
  test(`first-seen public shell Stop binds its command despite fresh same-ID ownership: ${change}`, async () => {
    let wire!: ReadableStreamDefaultController<Uint8Array>;
    const frame = (raw: unknown) => wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(raw)}\n\n`));
    const info = nativeShellInfo("SH", "P", "NEW", 30);
    const birth = { id: "new-birth", created: 31, type: "shell.created", location: { directory: WORKSPACE }, data: { info: {
      ...info, command: change === "missing-birth-command" ? undefined : "NEW" } } };
    const message = { id: "owning-message", type: "assistant", time: { created: change === "old-command" ? 10 : 29 }, content: [{ type: "tool", id: "call", name: "shell",
      time: { created: change === "old-command" ? 10 : 29, completed: 32 }, state: { status: "completed", input: (change === "missing-launch-command" ? {} : { command: change === "old-command" ? "OLD" : "NEW" }) as Record<string, unknown>,
        metadata: { shellID: "SH", status: "running" } } }] };
    if (change === "alias-command") { const alias = structuredClone(message.content[0]!); alias.id = "alias"; alias.state.input.command = "OLD"; message.content.push(alias); }
    const server = fakeOpenCode({
      "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) { wire = controller; frame({ type: "server.connected", data: {} }); } }), { headers: { "content-type": "text/event-stream" } }),
      "GET /api/session/P": () => session("P"),
      "GET /api/session/P/message": () => ({ data: [message], cursor: {} }),
      "GET /api/session/P/inbox": () => ({ data: [] }),
      "GET /api/session/active": () => ({}),
      "GET /api/shell/SH": () => scoped(info),
      "DELETE /api/shell/SH": () => undefined,
    });
    const provider = server.provider();
    let stream = observedNativeStream(provider);
    try {
      await stream.seen(event => event.eventType === "server.connected");
      wire.close(); await stream.pump;
      stream = observedNativeStream(provider);
      await stream.seen(event => event.eventType === "server.connected");
      frame(birth);
      frame({ id: "live-launch", created: 40, type: "session.message.content.updated", location: { directory: WORKSPACE }, data: { sessionID: "P", messageID: message.id, content: message.content } });
      const taskId = "v2:P:call";
      await stream.seen(event => event.updates.some(update => update.kind === "upsert" && update.item.type === "background_task" && update.item.taskId === taskId));
      const rows = await provider.reconcileBackgroundTasks("P", { fresh: true });
      let failure: unknown;
      try { await provider.stopTask("P", taskId); } catch (error) { failure = error; }
      expect(server.requests("DELETE", "/api/shell/SH")).toHaveLength(change === "compatible" ? 1 : 0);
      expect(rows).toContainEqual(expect.objectContaining({ taskId, stateUncertain: change !== "compatible" }));
      if (change === "compatible") expect(failure).toBeUndefined(); else expect(failure).toBeDefined();
    } finally {
      stream.lifetime.abort(); await stream.pump.catch(() => undefined); await provider.dispose();
    }
  });
}

for (const kind of ["agent", "shell"] as const) test(`reverted live ${kind} remains independently inspectable and stoppable until settlement`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory }) as OpenCodeV2Provider;
  let stream: ReturnType<typeof observedNativeStream> | undefined;
  try {
    const parent = (await provider.createSession("Live work survives transcript revert")).id;
    if (kind === "shell") { stream = observedNativeStream(provider); await stream.seen(event => event.eventType === "server.connected"); }
    const branch = await provider.prompt(parent, { id: "live-branch", text: "Revert the launch transcript", delivery: "queue" });
    const worker = kind === "agent" ? fake.launchWorker(parent, true) : fake.launchShell(parent, true);
    if (stream) await stream.seen(event => event.updates.some(update => update.kind === "upsert" && update.item.type === "background_task" && update.item.taskId === worker.taskId));
    expect(await provider.reconcileBackgroundTasks(parent, { fresh: true })).toContainEqual(expect.objectContaining({ taskId: worker.taskId, status: "running", stateUncertain: false }));
    await provider.interrupt(parent, { resume: false });
    fake.externalRevert(parent, branch.messageId);
    const transcript = await provider.listMessages(parent, { limit: 100 });
    expect(transcript.items).toEqual([]);
    const live = await provider.reconcileBackgroundTasks(parent, { fresh: true });
    expect(live).toEqual([expect.objectContaining({ taskId: worker.taskId, status: "running", stateUncertain: false })]);
    await provider.stopTask(parent, worker.taskId);
    const mutation = kind === "agent" ? `POST /api/session/${"childId" in worker ? worker.childId : ""}/interrupt?resume=false` : `DELETE /api/shell/${"shellId" in worker ? worker.shellId : ""}`;
    expect(fake.state().calls.filter(call => kind === "agent" ? call === mutation : call.split("?")[0] === mutation)).toHaveLength(1);
    if ("childId" in worker) fake.settleWorker(worker.childId, "completed", "Hidden worker finished");
    else { fake.shellPhase(worker.shellId, "exit"); fake.shellPhase(worker.shellId, "capture"); }
    expect(await provider.reconcileBackgroundTasks(parent, { fresh: true })).toEqual([]);
    fake.externalRevert(parent, null);
    expect(await provider.reconcileBackgroundTasks(parent, { fresh: true })).toContainEqual(expect.objectContaining({ taskId: worker.taskId, status: kind === "agent" ? "completed" : "failed" }));
    expect(fake.state().unhandled).toEqual([]);
  } finally { stream?.lifetime.abort(); await stream?.pump; await provider.dispose(); await fake.stop(); }
});

for (const phase of [2, 3, 4]) test(`public visibility abort retires cancellation-ignoring parent read ${phase} and its control guard`, async () => {
  const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
  let reads = 0, entered!: () => void, release!: () => void, returned!: () => void;
  const capture = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; }), late = new Promise<void>(resolve => { returned = resolve; });
  const server = fakeOpenCode({
    "GET /api/session/ses_parent": async () => { if (++reads === phase) { entered(); await gate; returned(); } return session("ses_parent", { revert: { messageID: fixture.converted.id } }); },
    "GET /api/session/ses_parent/message": () => ({ data: [fixture.launch, fixture.converted], cursor: {} }),
    "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
    "GET /api/session/active": () => ({ ses_child: { status: "running" } }),
    "GET /api/session/ses_child": () => session("ses_child", { parentID: "ses_parent" }),
    "GET /api/session/ses_child/message": () => ({ data: [], cursor: {} }),
  });
  const provider = server.provider(), controller = new AbortController();
  const controls = (provider as unknown as { controls: { activeReads: number; usage: unknown; basis(id: string): unknown } }).controls;
  let retired = false;
  const read = provider.reconcileBackgroundTasks("ses_parent", { fresh: true, signal: controller.signal }).finally(() => { retired = true; });
  void read.catch(() => undefined);
  try {
    await capture; controller.abort();
    await Promise.race([read.catch(() => undefined), Bun.sleep(50)]);
    expect(retired).toBe(true);
    expect(controls.activeReads).toBe(0);
    const usage = structuredClone(controls.usage), basis = controls.basis("v2:ses_parent:call_worker");
    release(); await late;
    await expect(read).rejects.toThrow();
    // A subsequent covered read gives the ignored SDK response time to decode;
    // the retired owner must not resume folding or recreate its control guard.
    await provider.getHistoryRevertBoundary("ses_parent", { signal: new AbortController().signal });
    expect(controls.activeReads).toBe(0);
    expect(controls.usage).toEqual(usage);
    expect(controls.basis("v2:ses_parent:call_worker")).toBe(basis);
    expect(server.calls.every(call => call.method === "GET")).toBe(true);
  } finally { release(); await read.catch(() => undefined); await provider.dispose(); }
});

test("public visibility abort also bounds waiting for an older fresh snapshot owner", async () => {
  let entered!: () => void, release!: () => void;
  const capture = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const server = fakeOpenCode({
    "GET /api/session/ses_parent": () => session("ses_parent"),
    "GET /api/session/ses_parent/message": async () => { entered(); await gate; return { data: [], cursor: {} }; },
    "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
    "GET /api/session/active": () => ({}),
  });
  const provider = server.provider(), controller = new AbortController();
  const previous = (provider as unknown as { backgroundSnapshot(id: string): Promise<unknown> }).backgroundSnapshot("ses_parent");
  let retired = false;
  const current = provider.reconcileBackgroundTasks("ses_parent", { fresh: true, signal: controller.signal }).finally(() => { retired = true; });
  void current.catch(() => undefined);
  try {
    await capture; controller.abort();
    await Promise.race([current.catch(() => undefined), Bun.sleep(50)]);
    expect(retired).toBe(true);
    expect((provider as unknown as { controls: { activeReads: number } }).controls.activeReads).toBe(1);
    release(); await previous;
    await expect(current).rejects.toThrow();
    expect(server.requests("GET", "/api/session/ses_parent")).toHaveLength(1);
    expect(server.requests("GET", "/api/session/ses_parent/message")).toHaveLength(1);
    expect((provider as unknown as { controls: { activeReads: number } }).controls.activeReads).toBe(0);
  } finally { release(); await previous.catch(() => undefined); await current.catch(() => undefined); await provider.dispose(); }
});

for (const kind of ["agent", "shell"] as const) for (const readSite of (kind === "agent" ? ["reverted"] : ["reverted", "output"]) as Array<"reverted" | "output">)
for (const knownEnd of (kind === "shell" ? [false, true] : [false]))
for (const change of (kind === "agent" ? ["foreign", "wrong-id", "foreign-workspace", "missing-workspace", "missing-parent", "missing-id", "healthy"] : ["foreign", "command", "started", "file", "wrong-id", "missing-command", "missing-started", "malformed-started", "healthy"]))
test(`authoritative ${readSite} ${kind} read fences an older Stop (${change}/old-end=${knownEnd})`, async () => {
  const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
  const launch = kind === "agent" ? fixture.launch : fixture.shell;
  const adjacent = structuredClone(fixture.shell); adjacent.id = "msg_adjacent"; adjacent.content[0].id = "call_adjacent";
  adjacent.content[0].state.metadata.shellID = "sh_adjacent";
  const original: ShellInfo = { id: "sh_fixture", command: "printf fixture", status: "running", cwd: WORKSPACE,
    shell: "/bin/sh", file: "/fixture/old.out", pid: 123, metadata: { sessionID: "ses_parent" }, time: { started: 75 } };
  const healthy = { ...original, id: "sh_adjacent" };
  const changedAgent = session(change === "wrong-id" ? "different_child" : "ses_child", {
    parentID: change === "foreign" ? "ses_foreign" : change === "missing-parent" ? undefined : "ses_parent",
    ...(change === "missing-id" ? { id: undefined } : {}),
    ...(change === "foreign-workspace" ? { location: { directory: "/foreign" } } : change === "missing-workspace" ? { location: {} } : {}),
  });
  const changedShell = { ...original, ...(change === "foreign" ? { metadata: { sessionID: "ses_foreign" } }
    : change === "command" ? { command: "replacement B" } : change === "started" ? { time: { started: 95 } }
    : change === "file" ? { file: "/fixture/replacement.out" } : change === "wrong-id" ? { id: "sh_replacement" }
    : change === "missing-command" ? { command: undefined } : change === "missing-started" ? { time: {} }
    : change === "malformed-started" ? { time: { started: "75" } } : {}) };
  const contradiction = ["foreign", "wrong-id", "foreign-workspace", "command", "started", "file"].includes(change);
  let marker: string | undefined, armed = false, targetReads = 0, stopping = false, heldAdjacent = false;
  let wire!: ReadableStreamDefaultController<Uint8Array>, acknowledge: (() => void) | undefined, sequence = 0;
  let observedRead!: () => void, releaseObserved!: () => void, stopRead!: () => void, releaseStop!: () => void;
  const observedStarted = new Promise<void>(resolve => { observedRead = resolve; }), observedGate = new Promise<void>(resolve => { releaseObserved = resolve; });
  const stopStarted = new Promise<void>(resolve => { stopRead = resolve; }), stopGate = new Promise<void>(resolve => { releaseStop = resolve; });
  const frame = (type: string, data: unknown, created = 80) => wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ id: `read-fence-${++sequence}`, type, data, created, location: { directory: WORKSPACE } })}\n\n`));
  const server = fakeOpenCode({
    "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) { wire = controller; frame("server.connected", {}, 1); } }), { headers: { "content-type": "text/event-stream" } }),
    "GET /api/session/ses_parent": () => session("ses_parent", marker ? { revert: { messageID: marker } } : {}),
    "GET /api/session/active": () => ({ ses_child: { type: "running" } }),
    "GET /api/session/ses_child": async () => {
      if (!armed) return session("ses_child", { parentID: "ses_parent" });
      if (++targetReads === 1) { observedRead(); await observedGate; return changedAgent; }
      stopRead(); await stopGate; return session("ses_child", { parentID: "ses_parent" });
    },
    "GET /api/session/ses_parent/message": () => ({ data: [launch, ...(kind === "shell" ? [adjacent] : [])], cursor: {} }),
    "GET /api/session/ses_child/message": () => ({ data: [], cursor: {} }),
    "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
    "GET /api/shell/sh_fixture": async () => {
      if (!armed || ++targetReads !== 2) return scoped(original);
      observedRead(); await observedGate; return scoped(changedShell);
    },
    "GET /api/shell/sh_adjacent": async () => {
      if (stopping && !heldAdjacent) { heldAdjacent = true; stopRead(); await stopGate; }
      return scoped(healthy);
    },
    "GET /api/shell/sh_fixture/output": () => scoped({ output: "owned output", size: 12, cursor: 12, truncated: false }),
    "POST /api/session/ses_child/interrupt": () => ({ interrupted: true }),
    "DELETE /api/shell/:id": () => undefined,
  });
  const provider = server.provider(), lifetime = new AbortController();
  const pump = (async () => { for await (const event of provider.events(lifetime.signal)) if (event.eventType !== "server.connected") { acknowledge?.(); acknowledge = undefined; } })();
  const send = (type: string, data: unknown, at?: number) => new Promise<void>(resolve => { acknowledge = resolve; frame(type, data, at); });
  let read: Promise<unknown> | undefined, stop: Promise<unknown> | undefined;
  const taskId = `v2:ses_parent:${kind === "agent" ? "call_worker" : "call_shell"}`;
  try {
    await provider.waitForEventStream(lifetime.signal);
    if (kind === "shell") {
      await send("session.tool.input.started", { sessionID: "ses_parent", assistantMessageID: launch.id, id: "call_shell", name: "shell" }, 70);
      await send("session.tool.called", { sessionID: "ses_parent", assistantMessageID: launch.id, id: "call_shell", input: { command: original.command }, executed: false }, 71);
      await send("shell.created", { info: original }, 75);
    }
    await send("session.message.content.updated", { sessionID: "ses_parent", messageID: launch.id, content: launch.content });
    if (kind === "shell") {
      await send("shell.created", { info: healthy }, 75);
      await send("session.message.content.updated", { sessionID: "ses_parent", messageID: adjacent.id, content: adjacent.content });
    }
    expect((await provider.reconcileBackgroundTasks("ses_parent", { fresh: true })).find(task => task.taskId === taskId)?.control?.available).toBe(true);
    if (knownEnd) await send("shell.exited", { id: original.id, status: "exited", exit: 0 }, 90);
    if (readSite === "reverted") marker = launch.id;
    armed = true;
    read = (readSite === "reverted" ? provider.reconcileBackgroundTasks("ses_parent", { fresh: true }) : provider.taskOutput("ses_parent", taskId, { tailBytes: 1024 })).catch(error => error);
    await observedStarted;
    // The observing read has finished its healthy snapshot, but not its final
    // visibility/output check. Stop now consumes A and waits on another read.
    stopping = true;
    stop = provider.stopTask("ses_parent", taskId).catch(error => error);
    await stopStarted;
    releaseObserved(); const observed = await read;
    releaseStop(); const result = await stop;
    expect(server.requests(kind === "agent" ? "POST" : "DELETE", kind === "agent" ? "/api/session/ses_child/interrupt" : "/api/shell/sh_fixture")).toHaveLength(contradiction ? 0 : 1);
    if (contradiction) expect(result).toMatchObject({ name: "BackgroundTaskUnavailableError" });
    else expect(result).toBeUndefined();
    if (readSite === "output") {
      if (contradiction || change === "missing-command") {
        expect(observed).toMatchObject({ name: "BackgroundTaskUnavailableError" });
        expect(server.requests("GET", "/api/shell/sh_fixture/output")).toHaveLength(0);
      } else expect(observed).toMatchObject({ text: "owned output" });
    }
    if (readSite === "reverted" && kind === "shell") {
      const row = (observed as import("../../types").BackgroundTaskItem[]).find(task => task.taskId === taskId)!;
      expect(row.activity?.kind).toBe(knownEnd ? "ended" : contradiction ? "unavailable" : "working");
      expect(workerState(row.status, row.stateUncertain, row.activity)).toBe(knownEnd || contradiction ? "unknown" : "working");
      expect(workerExecutionClockRuns(row)).toBe(!knownEnd && !contradiction);
      expect(compactWorkers([row]).filter(worker => worker.state === "working")).toHaveLength(!knownEnd && !contradiction ? 1 : 0);
      if (contradiction) expect(row.activity?.launchRef).toBeUndefined();
      else if (!knownEnd) expect(row.activity?.launchRef).toBeDefined();
    }
    armed = false; stopping = false; marker = undefined;
    const recovered = await provider.reconcileBackgroundTasks("ses_parent", { fresh: true });
    expect(recovered.find(task => task.taskId === taskId)?.control?.available).toBe(!contradiction);
    if (contradiction) {
      expect(recovered.find(task => task.taskId === taskId)?.activity?.launchRef).toBeUndefined();
      await expect(provider.stopTask("ses_parent", taskId)).rejects.toMatchObject({ name: "BackgroundTaskUnavailableError" });
    }
    if (kind === "shell") {
      await provider.stopTask("ses_parent", "v2:ses_parent:call_adjacent");
      expect(server.requests("DELETE", "/api/shell/sh_adjacent")).toHaveLength(1);
    }
  } finally { releaseObserved(); releaseStop(); await Promise.allSettled([read, stop]); lifetime.abort(); await pump; await provider.dispose(); }
});

for (const view of ["unreverted-boundary", "reverted-final", "visible-prefix-final"] as const) for (const knownEnd of [false, true])
for (const change of ["command", "started", "file", "foreign-workspace", "missing-started", "healthy"] as const)
test(`reverted activity rechecks native provenance after its final boundary await (${view}/${change}/old-end=${knownEnd})`, async () => {
  const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
  const original: ShellInfo = { id: "sh_fixture", command: "printf fixture", status: "running", cwd: "/owned/other-cwd",
    shell: "/bin/sh", file: "/fixture/old.out", pid: 123, metadata: { sessionID: "ses_parent" }, time: { started: 75 } };
  const reverted = view !== "unreverted-boundary", boundaryId = view === "visible-prefix-final" ? "msg_boundary" : fixture.shell.id;
  let current: unknown = original, marker = false, reads = 0, armed = false, foreign = false;
  let wire!: ReadableStreamDefaultController<Uint8Array>, acknowledge: (() => void) | undefined, sequence = 0, entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const frame = (type: string, data: unknown, created = 80) => wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ id: `activity-fence-${++sequence}`, type, data, created, location: { directory: WORKSPACE } })}\n\n`));
  const server = fakeOpenCode({
    "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) { wire = controller; frame("server.connected", {}, 1); } }), { headers: { "content-type": "text/event-stream" } }),
    "GET /api/session/ses_parent": async () => {
      const captured = session("ses_parent", { ...(marker ? { revert: { messageID: boundaryId } } : {}), ...(foreign ? { location: { directory: "/foreign" } } : {}) });
      if (armed && ++reads === (reverted ? 4 : 2)) { entered(); await gate; }
      return captured;
    },
    "GET /api/session/active": () => ({}),
    "GET /api/session/ses_parent/message": () => ({ data: [fixture.shell, ...(view === "visible-prefix-final" ? [{ id: "msg_boundary", type: "user", text: "Hidden suffix", time: { created: 100 } }] : [])], cursor: {} }),
    "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
    "GET /api/shell/sh_fixture": () => scoped(current),
    "DELETE /api/shell/sh_fixture": () => undefined,
  });
  const provider = server.provider(), lifetime = new AbortController();
  const pump = (async () => { for await (const event of provider.events(lifetime.signal)) if (event.eventType !== "server.connected") { acknowledge?.(); acknowledge = undefined; } })();
  const send = (type: string, data: unknown, at?: number) => new Promise<void>(resolve => { acknowledge = resolve; frame(type, data, at); });
  let pending: ReturnType<typeof provider.reconcileBackgroundTasks> | undefined;
  const taskId = "v2:ses_parent:call_shell", contradiction = ["command", "started", "file", "foreign-workspace"].includes(change);
  try {
    await provider.waitForEventStream(lifetime.signal);
    await send("session.tool.input.started", { sessionID: "ses_parent", assistantMessageID: fixture.shell.id, id: "call_shell", name: "shell" }, 70);
    await send("session.tool.called", { sessionID: "ses_parent", assistantMessageID: fixture.shell.id, id: "call_shell", input: { command: original.command }, executed: false }, 71);
    await send("shell.created", { info: original }, 75);
    await send("session.message.content.updated", { sessionID: "ses_parent", messageID: fixture.shell.id, content: fixture.shell.content });
    if (knownEnd) await send("shell.exited", { id: original.id, status: "exited", exit: 0 }, 90);
    marker = reverted; armed = true; pending = provider.reconcileBackgroundTasks("ses_parent", { fresh: true }); await started;
    current = { ...original, ...(change === "command" ? { command: "replacement B" } : change === "started" ? { time: { started: 95 } }
      : change === "file" ? { file: "/replacement.out" } : change === "missing-started" ? { time: {} } : {}) };
    if (change === "foreign-workspace") {
      foreign = true; expect(await provider.getSession("ses_parent")).toBeNull(); foreign = false;
    } else {
      const stop = await provider.stopTask("ses_parent", taskId).catch(error => error);
      if (contradiction || change === "missing-started") expect(stop).toMatchObject({ name: "BackgroundTaskUnavailableError" });
    }
    current = original; release(); const [row] = await pending;
    expect(row?.activity?.kind).toBe(knownEnd ? "ended" : contradiction ? "unavailable" : "working");
    expect(workerExecutionClockRuns(row!)).toBe(!knownEnd && !contradiction);
    expect(compactWorkers([row!]).filter(worker => worker.state === "working")).toHaveLength(!knownEnd && !contradiction ? 1 : 0);
    if (contradiction) expect(row?.activity?.launchRef).toBeUndefined();
    else if (!knownEnd) expect(row?.activity?.launchRef).toBeDefined();
    if (knownEnd) expect(row?.activity?.endedAt).toBe(90);
    expect(row?.control?.available).toBe(!contradiction);
    expect(row?.stateUncertain).toBe(contradiction);
    expect(workerCanStop(row!)).toBe(!contradiction);
    if (contradiction) {
      expect(row?.control?.reason).toBeString();
      await expect(provider.stopTask("ses_parent", taskId)).rejects.toMatchObject({ name: "BackgroundTaskUnavailableError" });
      expect(server.requests("DELETE", "/api/shell/sh_fixture")).toHaveLength(0);
    }
  } finally { release(); await pending?.catch(() => undefined); lifetime.abort(); await pump; await provider.dispose(); }
});

for (const kind of ["shell", "agent"] as const) for (const view of ["initial", "hidden-final", "prefix-final"] as const)
for (const change of (kind === "shell" ? ["end", "unmatched-end", "foreign-end", "quiet", "historical-end", "reused-end", "end-then-contradiction", "contradiction-then-end"]
  : ["end", "unmatched-end", "foreign-end", "quiet", "historical-end", "reused-end", "initial-start", "permission-arrival", "permission-resolution", "question-arrival", "question-resolution", "end-then-contradiction", "contradiction-then-end"]))
test(`visibility returns current compatible activity after its last await (${kind}/${view}/${change})`, async () => {
  const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
  const launch = kind === "shell" ? fixture.shell : fixture.launch;
  if (kind === "agent") launch.content[0].time = { created: 20, ran: 20, completed: 30 };
  const info: ShellInfo = { id: "sh_fixture", command: "printf fixture", status: "running", cwd: WORKSPACE, shell: "/bin/sh",
    file: "/fixture/old.out", pid: 123, metadata: { sessionID: "ses_parent" }, time: { started: 75 } };
  let armed = false, parentReads = 0, foreign = false, wire!: ReadableStreamDefaultController<Uint8Array>, acknowledge: (() => void) | undefined, sequence = 0;
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const boundaryId = view === "prefix-final" ? "msg_boundary" : launch.id, sequences = new Map<string, number>();
  const frame = (type: string, data: unknown, created: number, directory = WORKSPACE) => {
    const aggregateID = (data as { sessionID?: string }).sessionID;
    const seq = aggregateID ? (sequences.get(aggregateID) ?? 0) + 1 : undefined;
    if (aggregateID && type.startsWith("session.")) sequences.set(aggregateID, seq!);
    wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ id: `current-activity-${++sequence}`, type, data, created,
      ...(aggregateID && type.startsWith("session.") ? { durable: { aggregateID, seq, version: 1 } } : {}), location: { directory } })}\n\n`));
  };
  const childTool = { sessionID: "ses_child", assistantMessageID: "child-message", id: "child-tool" };
  const permission: PermissionAsked["data"] = { id: "canonical-permission", sessionID: "ses_child", action: "question", resources: ["*"], source: { type: "tool", messageID: childTool.assistantMessageID, id: childTool.id } };
  const question: FormCreated["data"]["form"] = { id: "canonical-question", sessionID: "ses_child", title: "Questions", fields: [{ key: "q0", type: "string", title: "Choose", description: "Proceed?", custom: true, options: [{ value: "Yes", label: "Yes", description: "Proceed" }] }], metadata: { kind: "question", tool: { messageID: childTool.assistantMessageID, id: childTool.id } } };
  let permissions: PermissionAsked["data"][] = [], forms: FormCreated["data"]["form"][] = [];
  const canonical = new Map<string, import("../../types").ConversationItem>();
  const server = fakeOpenCode({
    "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) { wire = controller; frame("server.connected", {}, 1); } }), { headers: { "content-type": "text/event-stream" } }),
    "GET /api/session/active": () => change === "initial-start" ? {} : ({ ses_child: { type: "running" } }),
    "GET /api/session/ses_parent": async () => {
      const captured = session("ses_parent", { ...(view === "initial" ? {} : { revert: { messageID: boundaryId } }), ...(foreign ? { location: { directory: "/foreign" } } : {}) });
      if (armed && ++parentReads === (view === "initial" ? 2 : 4)) { entered(); await gate; }
      return captured;
    },
    "GET /api/session/ses_child": () => session("ses_child", { parentID: "ses_parent", time: { created: 22, updated: 23 } }),
    "GET /api/session/ses_parent/message": () => ({ data: [launch, ...(view === "prefix-final" ? [{ id: "msg_boundary", type: "user", text: "Hidden suffix", time: { created: 100 } }] : [])], cursor: {} }),
    "GET /api/session/ses_child/message": () => ({ data: [], cursor: {} }),
    "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
    "GET /api/shell/sh_fixture": () => scoped(info),
    "GET /api/permission/request": () => scoped(permissions),
    "GET /api/form": () => scoped(forms),
    "DELETE /api/shell/sh_fixture": () => undefined,
    "POST /api/session/ses_child/interrupt": () => ({ interrupted: true }),
  });
  const provider = server.provider(), lifetime = new AbortController();
  const pump = (async () => { for await (const event of provider.events(lifetime.signal)) {
    for (const update of event.updates) if (update.kind === "upsert" && (update.item.type === "permission" || update.item.type === "question")) canonical.set(update.item.id, update.item);
    if (event.eventType !== "server.connected") { acknowledge?.(); acknowledge = undefined; }
  } })();
  const send = (type: string, data: unknown, at: number, directory?: string) => new Promise<void>(resolve => { acknowledge = resolve; frame(type, data, at, directory); });
  const nativeEnd = () => kind === "shell" ? send("shell.exited", { id: info.id, status: "exited", exit: 0 }, 90)
    : send("session.execution.succeeded", { sessionID: "ses_child" }, 90);
  const contradiction = async () => { foreign = true; expect(await provider.getSession("ses_parent")).toBeNull(); foreign = false; };
  const arrive = async () => {
    if (change.startsWith("permission")) { permissions = [permission]; await send("permission.asked", permission, 34); }
    else { forms = [question]; await send("form.created", { form: question }, 34); }
  };
  let pending: ReturnType<typeof provider.reconcileBackgroundTasks> | undefined;
  const taskId = kind === "shell" ? "v2:ses_parent:call_shell" : "v2:ses_parent:call_worker";
  try {
    await provider.waitForEventStream(lifetime.signal);
    const common = { sessionID: "ses_parent", assistantMessageID: launch.id, id: launch.content[0].id };
    await send("session.tool.input.started", { ...common, name: kind === "shell" ? "shell" : "subagent" }, kind === "shell" ? 70 : 20);
    await send("session.tool.called", { ...common, input: launch.content[0].state.input, executed: kind === "agent" }, kind === "shell" ? 71 : 20);
    if (kind === "shell") await send("shell.created", { info }, 75);
    else {
      await send("session.created", { sessionID: "ses_child", parentID: "ses_parent", projectID: "global", slug: "child", version: "2.1.2", location: { directory: WORKSPACE } }, 22);
      if (change !== "initial-start") await send("session.execution.started", { sessionID: "ses_child" }, 23);
    }
    await send("session.message.content.updated", { sessionID: "ses_parent", messageID: launch.id, content: launch.content }, kind === "shell" ? 80 : 30);
    if (change === "historical-end") {
      if (kind === "shell") await send("shell.exited", { id: info.id, status: "exited", exit: 0 }, 85);
      else await send("session.execution.succeeded", { sessionID: "ses_child" }, 85);
    }
    if (change.startsWith("permission") || change.startsWith("question")) {
      await send("session.tool.input.started", { ...childTool, name: "question" }, 31);
      await send("session.tool.called", { ...childTool, input: { questions: [{ header: "Choose", question: "Proceed?", options: [{ label: "Yes", description: "Proceed" }] }] }, executed: true }, 32);
      if (change.endsWith("resolution")) {
        await arrive();
        expect((await provider.reconcileBackgroundTasks("ses_parent", { fresh: true }))[0]?.activity?.kind).toBe("needs-answer");
      }
    }
    armed = true; pending = provider.reconcileBackgroundTasks("ses_parent", { fresh: true }); await started;
    if (change === "end" || change === "historical-end") await nativeEnd();
    else if (change === "unmatched-end") await send(kind === "shell" ? "shell.exited" : "session.execution.succeeded", kind === "shell" ? { id: "sh_other", status: "exited", exit: 0 } : { sessionID: "ses_other" }, 90);
    else if (change === "foreign-end") await send(kind === "shell" ? "shell.exited" : "session.execution.succeeded", kind === "shell" ? { id: info.id, status: "exited", exit: 0 } : { sessionID: "ses_child" }, 90, "/foreign");
    else if (change === "initial-start") await send("session.execution.started", { sessionID: "ses_child" }, 23);
    else if (change === "reused-end") {
      if (kind === "shell") await send("shell.created", { info: { ...info, time: { started: 85 }, file: "/fixture/replacement.out" } }, 85);
      else await send("session.execution.started", { sessionID: "ses_child" }, 85);
      await nativeEnd();
    }
    else if (change.endsWith("arrival")) await arrive();
    else if (change.endsWith("resolution")) {
      permissions = []; forms = [];
      if (change.startsWith("permission")) await send("permission.replied", { sessionID: "ses_child", requestID: permission.id, reply: "once" }, 35);
      else await send("form.replied", { sessionID: "ses_child", id: question.id, answer: { q0: "Yes" } }, 35);
    } else if (change === "end-then-contradiction") { await nativeEnd(); await contradiction(); }
    else if (change === "contradiction-then-end") { await contradiction(); await nativeEnd(); }
    release(); const [row] = await pending;
    const ended = change === "end" || change === "historical-end" || change === "end-then-contradiction", revoked = change.includes("contradiction") || change === "reused-end";
    expect(row?.status).toBe("running");
    expect(row?.activity?.kind).toBe(ended ? "ended" : revoked ? "unavailable" : change.endsWith("arrival") ? "needs-answer" : "working");
    expect(workerExecutionClockRuns(row!)).toBe(!ended && !revoked && !change.endsWith("arrival"));
    if (ended) {
      expect(row?.activity?.endedAt).toBe(change === "historical-end" ? 85 : 90);
      expect(workerStateLabel(row!.status, row!.stateUncertain, row!.activity)).toBe("Ended · result unavailable");
    } else expect(row?.activity?.endedAt).toBeUndefined();
    if (revoked) { expect(row?.activity?.launchRef).toBeUndefined(); expect(workerCanStop(row!)).toBe(false); }
    if (change === "end" || change === "historical-end") {
      expect(workerCanStop(row!)).toBe(kind === "shell");
      if (kind === "shell") { await provider.stopTask("ses_parent", taskId); expect(server.requests("DELETE", "/api/shell/sh_fixture")).toHaveLength(1); }
    }
    if (change.endsWith("arrival") || change.endsWith("resolution")) {
      const request: NonNullable<import("../../types").WorkerActivity["request"]> = change.startsWith("permission") ? { id: permission.id, kind: "permission" } : { id: question.id, kind: "question" };
      if (change.endsWith("arrival")) expect(row?.activity?.request).toEqual(request); else expect(row?.activity?.request).toBeUndefined();
      expect([...canonical.values()].filter(item => (item.type === "permission" || item.type === "question") && item.requestId === request.id)).toEqual([expect.objectContaining({ requestId: request.id, status: change.endsWith("arrival") ? "pending" : "resolved" })]);
    }
  } finally { release(); await pending?.catch(() => undefined); lifetime.abort(); await pump; await provider.dispose(); }
});

test("post-boundary control projection cannot borrow a newer valid alias basis", async () => {
  const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
  let history = [fixture.launch], armed = false, parentReads = 0, wire!: ReadableStreamDefaultController<Uint8Array>, acknowledge: (() => void) | undefined;
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const frame = (type: string, data: unknown) => wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type, data, created: 60, location: { directory: WORKSPACE } })}\n\n`));
  const server = fakeOpenCode({
    "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) { wire = controller; frame("server.connected", {}); } }), { headers: { "content-type": "text/event-stream" } }),
    "GET /api/session/active": () => ({ ses_child: { type: "running" } }),
    "GET /api/session/ses_parent": async () => { if (armed && ++parentReads === 2) { entered(); await gate; } return session("ses_parent"); },
    "GET /api/session/ses_child": () => session("ses_child", { parentID: "ses_parent" }),
    "GET /api/session/ses_parent/message": () => ({ data: history, cursor: {} }),
    "GET /api/session/ses_child/message": () => ({ data: [], cursor: {} }),
    "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
  });
  const provider = server.provider(), lifetime = new AbortController();
  const pump = (async () => { for await (const event of provider.events(lifetime.signal)) if (event.eventType !== "server.connected") { acknowledge?.(); acknowledge = undefined; } })();
  const send = (message: typeof fixture.launch) => new Promise<void>(resolve => { acknowledge = resolve; frame("session.message.content.updated", { sessionID: "ses_parent", messageID: message.id, content: message.content }); });
  let pending: ReturnType<typeof provider.reconcileBackgroundTasks> | undefined;
  try {
    await provider.waitForEventStream(lifetime.signal);
    await send(fixture.launch);
    expect((await provider.reconcileBackgroundTasks("ses_parent", { fresh: true }))[0]?.control?.available).toBe(true);
    armed = true; pending = provider.reconcileBackgroundTasks("ses_parent", { fresh: true }); await started;
    armed = false; history = [fixture.launch, fixture.converted]; await send(fixture.converted);
    const [latest] = await provider.reconcileBackgroundTasks("ses_parent", { fresh: true });
    expect(latest?.toolUseIds).toEqual(["call_worker", "call_converted"]); expect(latest?.control?.available).toBe(true);
    release(); const [old] = await pending;
    expect(old?.toolUseIds).toBeUndefined(); expect(old?.control?.available).toBe(false);
    expect(old?.stateUncertain).toBe(true); expect(workerCanStop(old!)).toBe(false);
    expect(old?.control?.reason).toBeString();
  } finally { release(); await pending?.catch(() => undefined); lifetime.abort(); await pump; await provider.dispose(); }
});

for (const view of ["none", "hidden", "prefix"] as const) test(`current control reprojection cannot create cold shell authority or erase independent Working (${view})`, async () => {
  const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
  const server = fakeOpenCode({
    "GET /api/session/active": () => ({}),
    "GET /api/session/ses_parent": () => session("ses_parent", view === "none" ? {} : { revert: { messageID: view === "hidden" ? fixture.shell.id : "msg_boundary" } }),
    "GET /api/session/ses_parent/message": () => ({ data: [fixture.shell, ...(view === "prefix" ? [{ id: "msg_boundary", type: "user", text: "Hidden suffix", time: { created: 100 } }] : [])], cursor: {} }),
    "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
    "GET /api/shell/sh_fixture": () => scoped({ ...nativeShellInfo(), cwd: "/owned/other-cwd" }),
    "DELETE /api/shell/sh_fixture": () => undefined,
  });
  const provider = server.provider();
  try {
    const [row] = await provider.reconcileBackgroundTasks("ses_parent", { fresh: true });
    expect(row?.activity?.kind).toBe("working"); expect(workerExecutionClockRuns(row!)).toBe(true);
    expect(row?.control?.available).toBe(false); expect(row?.stateUncertain).toBe(true); expect(workerCanStop(row!)).toBe(false);
    await expect(provider.stopTask("ses_parent", "v2:ses_parent:call_shell")).rejects.toMatchObject({ name: "BackgroundTaskUnavailableError" });
    expect(server.requests("DELETE", "/api/shell/sh_fixture")).toHaveLength(0);
  } finally { await provider.dispose(); }
});

for (const site of ["ordinary", "configuration", "inventory", "create", "history", "stream", "reverted", "final"] as const)
for (const change of (site === "inventory" || site === "create" ? ["parent", "workspace", "missing-parent", "healthy"] as const : ["parent", "workspace", "wrong-id", "missing-parent", "healthy"] as const))
test(`parent-only ownership contradiction preserves independently proven nested workers (${site}/${change})`, async () => {
  const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
  const outer = structuredClone(fixture.launch), nested = structuredClone(fixture.launch);
  outer.content[0].time = { created: 20, ran: 20, completed: 30 };
  nested.id = "msg_nested"; nested.sessionID = "ses_child"; nested.time.created = 40;
  nested.content[0].id = "call_nested"; nested.content[0].time = { created: 40, ran: 40, completed: 50 };
  nested.content[0].state.metadata.sessionID = "ses_nested";
  let changed = false, reverted = false, wire!: ReadableStreamDefaultController<Uint8Array>, acknowledge: (() => void) | undefined, sequence = 0;
  const frame = (type: string, data: unknown, created: number) => wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ id: `nested-owner-${++sequence}`, type, data, created, location: { directory: WORKSPACE } })}\n\n`));
  const record = (id: string) => session(id, id === "ses_child" ? {
    parentID: changed && change === "parent" ? "ses_new_parent" : changed && change === "missing-parent" ? undefined : "ses_parent", time: { created: 22, updated: 23 },
    ...(changed && change === "workspace" ? { location: { directory: "/foreign" } } : changed && change === "wrong-id" ? { id: "wrong_child" } : {}),
  } : id === "ses_nested" ? { parentID: "ses_child", time: { created: 42, updated: 43 } }
    : id === "ses_parent" && reverted ? { revert: { messageID: outer.id } } : {});
  const server = fakeOpenCode({
    "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) { wire = controller; frame("server.connected", {}, 1); } }), { headers: { "content-type": "text/event-stream" } }),
    "GET /api/session/active": () => ({ ses_child: { type: "running" }, ses_nested: { type: "running" } }),
    "GET /api/session/ses_parent/message": () => ({ data: [outer], cursor: {} }),
    "GET /api/session/ses_child/message": () => ({ data: [nested], cursor: {} }),
    "GET /api/session/ses_nested/message": () => ({ data: [], cursor: {} }),
    "GET /api/session/:id/inbox": () => ({ data: [] }),
    "GET /api/session": () => ({ data: [record("ses_child")], cursor: {} }),
    "POST /api/session": () => record("ses_child"),
    "GET /api/session/:id": ({ path }) => record(path.split("/").at(-1)!),
    "POST /api/session/:id/interrupt": () => ({ interrupted: true }),
  });
  const provider = server.provider(), lifetime = new AbortController();
  const pump = (async () => { for await (const event of provider.events(lifetime.signal)) if (event.eventType !== "server.connected") { acknowledge?.(); acknowledge = undefined; } })();
  const send = (type: string, data: unknown, at: number) => new Promise<void>(resolve => { acknowledge = resolve; frame(type, data, at); });
  const launch = async (parent: string, child: string, message: typeof outer, created: number) => {
    const common = { sessionID: parent, assistantMessageID: message.id, id: message.content[0].id };
    await send("session.tool.input.started", { ...common, name: "subagent" }, created);
    await send("session.tool.called", { ...common, input: message.content[0].state.input, executed: true }, created);
    await send("session.created", { sessionID: child, parentID: parent, projectID: "global", slug: child, version: "2.1.2", location: { directory: WORKSPACE } }, created + 2);
    await send("session.execution.started", { sessionID: child }, created + 3);
    await send("session.message.content.updated", { sessionID: parent, messageID: message.id, content: message.content }, created + 10);
  };
  const contradiction = ["parent", "workspace", "wrong-id"].includes(change), subtree = change === "workspace" || change === "wrong-id";
  try {
    await provider.waitForEventStream(lifetime.signal);
    await launch("ses_parent", "ses_child", outer, 20);
    await launch("ses_child", "ses_nested", nested, 40);
    const [oldOuter] = await provider.reconcileBackgroundTasks("ses_parent", { fresh: true });
    const [before] = await provider.reconcileBackgroundTasks("ses_child", { fresh: true });
    expect(oldOuter?.activity?.kind).toBe("working"); expect(workerCanStop(oldOuter!)).toBe(true);
    expect(before?.activity?.kind).toBe("working"); expect(before?.activity?.launchRef).toBeDefined(); expect(workerCanStop(before!)).toBe(true);
    if (site === "history" || site === "stream") await send("session.moved", { sessionID: "unrelated" }, 60);
    changed = true;
    if (site === "ordinary") await provider.getSession("ses_child");
    else if (site === "configuration") await provider.getConversationConfiguration("ses_child");
    else if (site === "inventory") await provider.listSessions();
    else if (site === "create") await provider.createSession("server-generated-id").catch(() => undefined);
    else if (site === "history") await provider.listMessages("ses_parent", { limit: 100 });
    else if (site === "stream") await send("session.message.content.updated", { sessionID: "ses_parent", messageID: outer.id, content: outer.content }, 60);
    else if (site === "reverted") { reverted = true; await provider.reconcileBackgroundTasks("ses_parent", { fresh: true }).catch(() => undefined); }
    else await provider.stopTask("ses_parent", "v2:ses_parent:call_worker").catch(() => undefined);
    if (change !== "parent") changed = false;
    const [after] = await provider.reconcileBackgroundTasks("ses_child", { fresh: true });
    if (subtree) {
      expect(after?.activity?.kind).not.toBe("working"); expect(after?.activity?.launchRef).toBeUndefined();
      expect(workerCanStop(after!)).toBe(false);
      await expect(provider.stopTask("ses_child", "v2:ses_child:call_nested")).rejects.toMatchObject({ name: "BackgroundTaskUnavailableError" });
    } else {
      expect(after?.activity?.kind).toBe("working"); expect(after?.activity?.launchRef).toBe(before?.activity?.launchRef);
      expect(after?.control?.available).toBe(true); expect(workerCanStop(after!)).toBe(true);
      await provider.stopTask("ses_child", "v2:ses_child:call_nested");
    }
    if (contradiction) {
      await expect(provider.stopTask("ses_parent", "v2:ses_parent:call_worker")).rejects.toMatchObject({ name: "BackgroundTaskUnavailableError" });
      const history = await provider.listMessages("ses_parent", { limit: 100 });
      expect(history.completeItems?.filter(item => item.type === "background_task").every(item => item.activity?.launchRef === undefined)).toBe(true);
    }
    const expected = subtree ? [] : ["/api/session/ses_nested/interrupt"];
    if (site === "final" && change === "healthy") expected.unshift("/api/session/ses_child/interrupt");
    expect(server.calls.filter(call => call.method === "POST" && call.path.endsWith("/interrupt")).map(call => call.path)).toEqual(expected);
  } finally { lifetime.abort(); await pump; await provider.dispose(); }
});

for (const alias of [false, true]) for (const change of ["foreign", "wrong-id", "foreign-workspace", "missing-workspace", "missing-parent", "missing-id", "healthy", "unrelated-foreign", "unrelated-wrong-id", "unrelated-foreign-workspace"] as const)
test(`stream ownership verification fences only its associated retained occurrence (${change}/alias=${alias})`, async () => {
  const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
  let history = alias ? [fixture.launch, fixture.converted] : [fixture.launch];
  let armed = false, lookups = 0, wire!: ReadableStreamDefaultController<Uint8Array>, acknowledge: (() => void) | undefined, sequence = 0;
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const frame = (type: string, data: unknown) => wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ id: `stream-owner-${++sequence}`, type, data, created: 60, location: { directory: WORKSPACE } })}\n\n`));
  const unrelated = change.startsWith("unrelated-");
  const changed = (child: string) => session(change.endsWith("wrong-id") ? "wrong_child" : child, {
    parentID: change.endsWith("foreign") ? "foreign_parent" : change === "missing-parent" ? undefined : "ses_parent",
    ...(change === "missing-id" ? { id: undefined } : {}),
    ...(change.endsWith("foreign-workspace") ? { location: { directory: "/foreign" } } : change === "missing-workspace" ? { location: {} } : {}),
  });
  const server = fakeOpenCode({
    "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) { wire = controller; frame("server.connected", {}); } }), { headers: { "content-type": "text/event-stream" } }),
    "GET /api/session/active": () => ({ ses_child: { type: "running" } }),
    "GET /api/session/ses_child": async () => {
      if (!armed) return session("ses_child", { parentID: "ses_parent" });
      if (++lookups === 1) { entered(); await gate; return session("ses_child", { parentID: "ses_parent" }); }
      return unrelated ? session("ses_child", { parentID: "ses_parent" }) : changed("ses_child");
    },
    "GET /api/session/new_child": () => changed("new_child"),
    "GET /api/session/ses_parent": () => session("ses_parent"),
    "GET /api/session/ses_parent/message": () => ({ data: history, cursor: {} }),
    "GET /api/session/ses_child/message": () => ({ data: [], cursor: {} }),
    "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
    "POST /api/session/ses_child/interrupt": () => ({ interrupted: true }),
  });
  const provider = server.provider(), lifetime = new AbortController();
  const pump = (async () => { for await (const event of provider.events(lifetime.signal)) if (event.eventType !== "server.connected") { acknowledge?.(); acknowledge = undefined; } })();
  const send = (type: string, data: unknown) => new Promise<void>(resolve => { acknowledge = resolve; frame(type, data); });
  let stop: Promise<unknown> | undefined;
  const taskId = "v2:ses_parent:call_worker", contradiction = !unrelated && ["foreign", "wrong-id", "foreign-workspace"].includes(change);
  try {
    await provider.waitForEventStream(lifetime.signal);
    await send("session.message.content.updated", { sessionID: "ses_parent", messageID: fixture.launch.id, content: fixture.launch.content });
    if (alias) await send("session.message.content.updated", { sessionID: "ses_parent", messageID: fixture.converted.id, content: fixture.converted.content });
    expect((await provider.reconcileBackgroundTasks("ses_parent", { fresh: true })).find(task => task.taskId === taskId)?.control?.available).toBe(true);
    armed = true;
    stop = provider.stopTask("ses_parent", taskId).catch(error => error);
    await started;
    await send("session.moved", { sessionID: "unrelated" });
    const selected = structuredClone(alias ? fixture.converted : fixture.launch);
    if (unrelated) { selected.id = "msg_unrelated"; selected.content[0].id = "call_unrelated"; selected.content[0].state.metadata.sessionID = "new_child"; }
    await send("session.message.content.updated", { sessionID: "ses_parent", messageID: selected.id, content: selected.content });
    release(); const result = await stop;
    expect(server.requests("POST", "/api/session/ses_child/interrupt")).toHaveLength(contradiction ? 0 : 1);
    if (contradiction) expect(result).toMatchObject({ name: "BackgroundTaskUnavailableError" });
    else expect(result).toBeUndefined();
    armed = false;
    if (alias && contradiction) history = [fixture.converted];
    const recoveredId = alias && contradiction ? "v2:ses_parent:call_converted" : taskId;
    expect((await provider.reconcileBackgroundTasks("ses_parent", { fresh: true })).find(task => task.taskId === recoveredId)?.control?.available).toBe(!contradiction);
    if (contradiction) await expect(provider.stopTask("ses_parent", recoveredId)).rejects.toMatchObject({ name: "BackgroundTaskUnavailableError" });
  } finally { release(); await stop; lifetime.abort(); await pump; await provider.dispose(); }
});

for (const unavailable of ["foreign", "revoked", "incomplete"] as const) test(`reverted live inventory never enables an ${unavailable} native target`, async () => {
  const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
  const launch = structuredClone(fixture.launch);
  if (unavailable === "incomplete") delete launch.content[0].state.input;
  let marker: string | undefined, owner = "ses_parent", wire!: ReadableStreamDefaultController<Uint8Array>;
  const frame = (event: unknown) => wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
  const server = fakeOpenCode({
    "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) { wire = controller; frame({ type: "server.connected", data: {} }); } }), { headers: { "content-type": "text/event-stream" } }),
    "GET /api/session/ses_parent": () => session("ses_parent", marker ? { revert: { messageID: marker } } : {}),
    "GET /api/session/ses_parent/message": () => ({ data: [launch], cursor: {} }),
    "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
    "GET /api/session/active": () => ({ ses_child: { status: "running" } }),
    "GET /api/session/ses_child": () => session("ses_child", { parentID: owner }),
    "GET /api/session/ses_child/message": () => ({ data: [], cursor: {} }),
    "POST /api/session/ses_child/interrupt": () => ({ interrupted: true }),
  });
  const provider = server.provider(), controller = new AbortController();
  let events: AsyncIterator<import("../../provider").NormalizedProviderEvent> | undefined;
  try {
    if (unavailable !== "incomplete") expect(await provider.reconcileBackgroundTasks("ses_parent")).toEqual([expect.objectContaining({ stateUncertain: false })]);
    if (unavailable === "foreign") owner = "another_parent";
    if (unavailable === "revoked") {
      events = provider.events(controller.signal)[Symbol.asyncIterator](); await events.next();
      const next = events.next();
      frame({ type: "session.moved", location: { directory: WORKSPACE }, data: { sessionID: "ses_child", location: { directory: "/foreign" } } });
      await next;
    }
    marker = launch.id;
    const rows = await provider.reconcileBackgroundTasks("ses_parent", { fresh: true });
    expect(rows.every(item => item.stateUncertain === true)).toBe(true);
    if (unavailable === "incomplete" || unavailable === "foreign") expect(rows).toEqual([]);
    else expect(rows).toEqual([expect.objectContaining({ status: "running", stateUncertain: true })]);
    await expect(provider.stopTask("ses_parent", "v2:ses_parent:call_worker")).rejects.toThrow();
    expect(server.requests("POST", "/api/session/ses_child/interrupt")).toHaveLength(0);
    expect(server.calls.every(call => call.method === "GET")).toBe(true);
  } finally { controller.abort(); await events?.return?.(); await provider.dispose(); }
});

test("public recovery excludes an exactly reverted completed worker while its private evidence remains", async () => {
  const directory = process.cwd();
  const fake = startOpenCodeV2Fake({ directory });
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory }) as OpenCodeV2Provider;
  try {
    const parent = (await provider.createSession("Public revert visibility")).id;
    const branch = await provider.prompt(parent, { id: "branch-to-revert", text: "Externally reverted turn", delivery: "queue" });
    const worker = fake.launchWorker(parent, true);
    fake.settleWorker(worker.childId, "completed", "Terminal worker report");
    fake.step(parent);
    const taskId = `task:${worker.taskId}`;
    expect(await provider.reconcileBackgroundTasks(parent, { fresh: true })).toContainEqual(expect.objectContaining({ id: taskId, status: "completed" }));
    fake.externalRevert(parent, branch.messageId);
    const visible = await provider.listMessages(parent, { limit: 100 });
    expect(visible.revertVisibility?.excludedItemIds).toContain(taskId);
    expect(visible.completeItems?.some(item => item.id === taskId)).toBe(false);
    // Inspection only: public hiding must not erase the private Stop basis.
    const privateSnapshot = await (provider as unknown as { backgroundSnapshot(id: string, options: { fresh: boolean }): Promise<{ tasks: unknown[]; occurrences: ReadonlyMap<string, unknown>; controls: ReadonlyMap<string, unknown> }> }).backgroundSnapshot(parent, { fresh: true });
    expect(privateSnapshot.tasks).toContainEqual(expect.objectContaining({ id: taskId, status: "completed" }));
    const recovered = await provider.reconcileBackgroundTasks(parent, { fresh: true });
    expect(recovered.filter(item => item.id === taskId)).toHaveLength(0);
    fake.externalRevert(parent, null);
    expect(await provider.reconcileBackgroundTasks(parent, { fresh: true })).toContainEqual(expect.objectContaining({ id: taskId, status: "completed" }));
    expect(fake.state().unhandled).toEqual([]);
  } finally { await provider.dispose(); await fake.stop(); }
});

for (const kind of ["running", "shell", "reused-child"] as const) test(`public revert visibility preserves retained work and private evidence: ${kind}`, async () => {
  const directory = process.cwd();
  const fake = startOpenCodeV2Fake({ directory });
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory }) as OpenCodeV2Provider;
  const privateRead = () => (provider as unknown as { backgroundSnapshot(id: string, options: { fresh: boolean }): Promise<{ tasks: import("../../types").BackgroundTaskItem[]; occurrences: ReadonlyMap<string, unknown>; controls: ReadonlyMap<string, unknown> }> }).backgroundSnapshot(parent, { fresh: true });
  let parent: string;
  let stream: ReturnType<typeof observedNativeStream> | undefined;
  try {
    parent = (await provider.createSession("Retained public worker prefix")).id;
    if (kind === "shell") { stream = observedNativeStream(provider); await stream.seen(event => event.eventType === "server.connected"); }
    await provider.prompt(parent, { id: "retained", text: "Keep this turn", delivery: "queue" });
    const kept = fake.launchWorker(parent, true);
    fake.settleWorker(kept.childId, "completed", "Retained completion");
    fake.step(parent); fake.finish(parent);
    const branch = await provider.prompt(parent, { id: "hidden", text: "Revert only this suffix", delivery: "queue" });
    if (kind === "shell") {
      const shell = fake.launchShell(parent, true);
      await stream!.seen(event => event.updates.some(update => update.kind === "upsert" && update.item.type === "background_task" && update.item.taskId === shell.taskId));
    }
    else fake.launchWorker(parent, true, kind === "reused-child" ? kept.childId : undefined);
    const full = await privateRead();
    expect(full.tasks.some(item => item.status === "running")).toBe(true);
    fake.externalRevert(parent, branch.messageId);
    const history = await provider.listMessages(parent, { limit: 1 });
    const publicRows = await provider.reconcileBackgroundTasks(parent, { fresh: true });
    // User-approved: the completed retained prefix and independently current
    // detached suffix are both listed; only its launch transcript is hidden.
    expect(publicRows).toHaveLength(2);
    expect(publicRows).toContainEqual(expect.objectContaining({ id: `task:${kept.taskId}`, status: "completed" }));
    expect(publicRows.filter(item => item.status === "running")).toEqual([expect.objectContaining({ stateUncertain: false })]);
    expect(publicRows.filter(item => !history.revertVisibility!.excludedItemIds.includes(item.id)).map(item => [item.id, item.status, item.toolUseIds])).toEqual(history.completeItems!.filter(item => item.type === "background_task").map(item => [item.id, item.status, item.toolUseIds]));
    // Filtering never mutates/clears the full fold, occurrences or Stop witnesses.
    const reread = await privateRead();
    expect({ ...reread, tasks: withoutObservationClock(reread.tasks) }).toEqual({ ...full, tasks: withoutObservationClock(full.tasks) });
    if (kind === "reused-child") {
      await expect(provider.stopTask(parent, kept.taskId)).rejects.toThrow();
      expect(fake.state().calls.filter(call => call.startsWith(`POST /api/session/${kept.childId}/interrupt`))).toEqual([]);
    }
    fake.externalRevert(parent, null);
    expect(withoutObservationClock(await provider.reconcileBackgroundTasks(parent, { fresh: true }))).toEqual(withoutObservationClock(full.tasks));
    expect(fake.state().unhandled).toEqual([]);
  } finally { stream?.lifetime.abort(); await stream?.pump; await provider.dispose(); await fake.stop(); }
});

test("public revert visibility uses the visible prefix of a folded alias without erasing its private suffix", async () => {
  const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
  let boundary: string | undefined = fixture.converted.id;
  const server = fakeOpenCode({
    "GET /api/session/ses_parent": () => session("ses_parent", boundary ? { revert: { messageID: boundary } } : {}),
    "GET /api/session/ses_parent/message": () => ({ data: [fixture.launch, fixture.converted], cursor: {} }),
    "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
    "GET /api/session/active": () => ({ ses_child: { status: "running" } }),
    "GET /api/session/ses_child": () => session("ses_child", { parentID: "ses_parent" }),
    "GET /api/session/ses_child/message": () => ({ data: [], cursor: {} }),
  });
  const provider = server.provider();
  const privateRead = () => (provider as unknown as { backgroundSnapshot(id: string, options: { fresh: boolean }): Promise<{ tasks: import("../../types").BackgroundTaskItem[] }> }).backgroundSnapshot("ses_parent", { fresh: true });
  try {
    const full = await privateRead();
    expect(full.tasks[0]?.toolUseIds).toEqual(["call_worker", "call_converted"]);
    const prefix = await provider.reconcileBackgroundTasks("ses_parent", { fresh: true });
    expect(prefix).toHaveLength(1);
    expect(prefix[0]?.taskId).toBe("v2:ses_parent:call_worker");
    expect(prefix[0]?.toolUseId).toBe("call_worker");
    expect(prefix[0]?.toolUseIds).toBeUndefined();
    const reread = await privateRead();
    expect({ ...reread, tasks: withoutObservationClock(reread.tasks) }).toEqual({ ...full, tasks: withoutObservationClock(full.tasks) });
    boundary = fixture.launch.id;
    expect(await provider.reconcileBackgroundTasks("ses_parent", { fresh: true })).toEqual([expect.objectContaining({ taskId: "v2:ses_parent:call_worker", status: "running", stateUncertain: false })]);
    boundary = undefined;
    expect(withoutObservationClock(await provider.reconcileBackgroundTasks("ses_parent", { fresh: true }))).toEqual(withoutObservationClock(full.tasks));
  } finally { await provider.dispose(); }
});

for (const change of ["boundary", "restore", "stream-generation", "parent-unavailable", "child-unavailable"] as const) test(`public revert visibility refuses a captured view changed during filtering: ${change}`, async () => {
  const directory = process.cwd();
  const fake = startOpenCodeV2Fake({ directory });
  let parent: string, child: string, unavailable = false, unavailableChild = false, hold = false, reads = 0, captured!: () => void, release!: () => void;
  const capture = new Promise<void>(resolve => { captured = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const isParent = new URL(request.url).pathname === `/api/session/${parent}`;
    if (unavailable && isParent) return Response.json({ _tag: "InternalError", message: "Fixture native parent unavailable" }, { status: 500 });
    if (unavailableChild && new URL(request.url).pathname === `/api/session/${child}`) return Response.json({ _tag: "InternalError", message: "Fixture native child unavailable" }, { status: 500 });
    const response = await fetch(request);
    if (hold && isParent && ++reads === 3) {
      hold = false;
      const body = await response.text(); captured(); await gate;
      return new Response(body, { status: response.status, headers: response.headers });
    }
    return response;
  }) as typeof fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport }) as OpenCodeV2Provider;
  const controller = new AbortController();
  let events: AsyncIterator<import("../../provider").NormalizedProviderEvent> | undefined;
  let recovery: Promise<unknown> | undefined;
  try {
    parent = (await provider.createSession("Captured public visibility")).id;
    const branch = await provider.prompt(parent, { id: "branch", text: "Revert boundary", delivery: "queue" });
    child = fake.launchWorker(parent, true).childId;
    // Keep the launcher visible for a failed canonical ownership read: absence
    // from an incomplete fold must not authorize its private inventory copy.
    if (change === "child-unavailable") fake.appendHistory(parent, 1);
    fake.externalRevert(parent, change === "child-unavailable" ? fake.state().sessions[parent]!.messages.at(-1)!.id : branch.messageId);
    hold = true;
    recovery = provider.reconcileBackgroundTasks(parent, { fresh: true });
    void recovery.catch(() => undefined);
    await capture;
    if (change === "stream-generation") { events = provider.events(controller.signal)[Symbol.asyncIterator](); await events.next(); }
    else if (change === "parent-unavailable") unavailable = true;
    else if (change === "child-unavailable") unavailableChild = true;
    else fake.externalRevert(parent, change === "restore" ? null : fake.state().sessions[parent]!.messages.at(-1)!.id);
    release();
    await expect(recovery).rejects.toThrow(change === "parent-unavailable" || change === "child-unavailable" ? "OpenCode session lookup failed" : "Background visibility changed");
    expect(fake.state().unhandled).toEqual([]);
  } finally { release(); await recovery?.catch(() => undefined); controller.abort(); await events?.return?.(); await provider.dispose(); await fake.stop(); }
});

for (const failRevalidation of [false, true]) test(`public revert visibility rereads the native parent after an older worker snapshot: ${failRevalidation ? "unavailable" : "reverted"}`, async () => {
  const directory = process.cwd();
  const fake = startOpenCodeV2Fake({ directory });
  let hold = false, fail = false, captured!: () => void, release!: () => void;
  const capture = new Promise<void>(resolve => { captured = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let parent: string;
  const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init), pathname = new URL(request.url).pathname;
    if (fail && pathname === `/api/session/${parent}`) return Response.json({ _tag: "InternalError", message: "Fixture native parent unavailable" }, { status: 500 });
    const response = await fetch(request);
    if (hold && pathname === "/api/session/active") {
      hold = false;
      const body = await response.text(); captured(); await gate;
      return new Response(body, { status: response.status, headers: response.headers });
    }
    return response;
  }) as typeof fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport }) as OpenCodeV2Provider;
  let recovery: Promise<unknown> | undefined;
  try {
    parent = (await provider.createSession("Delayed native worker snapshot")).id;
    const branch = await provider.prompt(parent, { id: "branch", text: "Revert during inventory read", delivery: "queue" });
    const worker = fake.launchWorker(parent, true);
    hold = true;
    recovery = provider.reconcileBackgroundTasks(parent, { fresh: true });
    void recovery.catch(() => undefined);
    await capture;
    fake.externalRevert(parent, branch.messageId);
    fail = failRevalidation;
    release();
    if (failRevalidation) await expect(recovery).rejects.toThrow("OpenCode session lookup failed");
    else {
      expect(await recovery).toEqual([expect.objectContaining({ taskId: worker.taskId, status: "running", stateUncertain: false })]);
      expect((await provider.listMessages(parent, { limit: 100 })).items).toEqual([]);
    }
    expect(fake.state().unhandled).toEqual([]);
  } finally { release(); await recovery?.catch(() => undefined); await provider.dispose(); await fake.stop(); }
});

describe("native bootstrap admission through the real adapter", () => {
  for (const [missing, uncertain] of [["created", true], ["input", true], ["both", true], ["native-zero-empty", false], ["native-created-empty", false]] as const) test(`cold immutable invocation proof: ${missing}`, async () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    const complete = structuredClone(fixture.launch);
    delete complete.content[0].time.ran; delete complete.content[0].time.completed;
    if (!uncertain) { complete.content[0].time.created = missing === "native-zero-empty" ? 0 : 20; complete.content[0].state.input = {}; }
    const partial = structuredClone(complete);
    if (missing === "created" || missing === "both") delete partial.content[0].time.created;
    if (missing === "input" || missing === "both") delete partial.content[0].state.input;
    let history = partial, wire!: ReadableStreamDefaultController<Uint8Array>, acknowledge: (() => void) | undefined, sequence = 0;
    const frame = (type: string, data: unknown) => wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ id: `cold-proof-${++sequence}`, type, data, created: 30, location: { directory: WORKSPACE } })}\n\n`));
    const send = (type: string, data: unknown) => new Promise<void>(resolve => { acknowledge = resolve; frame(type, data); });
    const snapshot = (message: typeof complete) => send("session.message.content.updated", { sessionID: "ses_parent", messageID: message.id, content: message.content });
    const server = fakeOpenCode({
      "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) { wire = controller; frame("server.connected", {}); } }), { headers: { "content-type": "text/event-stream" } }),
      "GET /api/session/active": () => ({ ses_child: { status: "running" } }),
      "GET /api/session/:id": ({ path }) => session(path.split("/").at(-1)!, { ...(path.endsWith("ses_child") ? { parentID: "ses_parent" } : {}), time: { created: 0, updated: 30 } }),
      "GET /api/session/ses_parent/message": () => ({ data: [history], cursor: {} }),
      "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
      "GET /api/session/ses_child/message": () => ({ data: [], cursor: {} }),
      "POST /api/session/ses_child/interrupt": () => ({ interrupted: true }),
    });
    const provider = server.provider(), lifetime = new AbortController();
    const pump = (async () => { for await (const event of provider.events(lifetime.signal)) if (event.eventType !== "server.connected") { const done = acknowledge; acknowledge = undefined; done?.(); } })();
    const recovered = () => provider.reconcileBackgroundTasks("ses_parent", { fresh: true });
    try {
      await provider.waitForEventStream(lifetime.signal);
      expect(await recovered()).toEqual([expect.objectContaining({ taskId: "v2:ses_parent:call_worker", stateUncertain: uncertain })]);
      if (uncertain) {
        await expect(provider.stopTask("ses_parent", "v2:ses_parent:call_worker")).rejects.toThrow(/no longer/);
        expect(server.requests("POST", "/api/session/ses_child/interrupt")).toHaveLength(0);
        // Display clocks and lookalike proof fields are not canonical native evidence.
        history = structuredClone(partial);
        history.content[0].createdAt = 20;
        history.content[0].inputFingerprint = "f".repeat(64);
        expect(await recovered()).toEqual([expect.objectContaining({ stateUncertain: true })]);
        await expect(provider.stopTask("ses_parent", "v2:ses_parent:call_worker")).rejects.toThrow(/no longer/);
        expect(server.requests("POST", "/api/session/ses_child/interrupt")).toHaveLength(0);
        history = complete;
        await snapshot(complete);
        expect(await recovered()).toEqual([expect.objectContaining({ stateUncertain: false })]);
      }
      await provider.stopTask("ses_parent", "v2:ses_parent:call_worker");
      expect(server.requests("POST", "/api/session/ses_child/interrupt")).toHaveLength(1);
      // Sparse progress neither erases nor replaces the now-complete retained basis.
      await send("session.tool.progress", { sessionID: "ses_parent", assistantMessageID: complete.id, id: "call_worker", metadata: { sessionID: "ses_child", status: "running" } });
      expect(await recovered()).toEqual([expect.objectContaining({ stateUncertain: false })]);
      await provider.stopTask("ses_parent", "v2:ses_parent:call_worker");
      expect(server.requests("POST", "/api/session/ses_child/interrupt")).toHaveLength(2);
      // Completing/forging fields cannot repair a subsequently revoked native owner.
      await snapshot({ ...complete, id: "different_native_owner" });
      await snapshot(complete);
      await expect(provider.stopTask("ses_parent", "v2:ses_parent:call_worker")).rejects.toThrow(/no longer/);
      expect(server.requests("POST", "/api/session/ses_child/interrupt")).toHaveLength(2);
    } finally { lifetime.abort(); await pump; await provider.dispose(); }
  });

  for (const change of ["foreign-payload-birth", "move", "delete", "new-generation"] as const) test(`pre-admission ${change} cannot authorize a stale native occurrence`, async () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    let wire!: ReadableStreamDefaultController<Uint8Array>, acknowledge: (() => void) | undefined, sequence = 0;
    const frame = (type: string, data: unknown, created: number) => wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ id: `negative-${++sequence}`, type, data, created, location: { directory: WORKSPACE } })}\n\n`));
    const send = (type: string, data: unknown, created: number) => new Promise<void>(resolve => { acknowledge = resolve; frame(type, data, created); });
    const server = fakeOpenCode({
      "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) { wire = controller; frame("server.connected", {}, 1); } }), { headers: { "content-type": "text/event-stream" } }),
      "GET /api/session/active": () => ({ ses_child: { status: "running" } }),
      "GET /api/session/:id": ({ path }) => session(path.split("/").at(-1)!, path.endsWith("ses_child") ? { parentID: "ses_parent" } : {}),
      "GET /api/session/ses_parent/message": () => ({ data: [fixture.launch], cursor: {} }),
      "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
      "GET /api/session/ses_child/message": () => ({ data: [], cursor: {} }),
      "POST /api/session/ses_child/interrupt": () => ({ interrupted: true }),
    });
    const provider = server.provider(), lifetime = new AbortController();
    const pump = (async () => { for await (const event of provider.events(lifetime.signal)) if (event.eventType !== "server.connected") { const done = acknowledge; acknowledge = undefined; done?.(); } })();
    try {
      await provider.waitForEventStream(lifetime.signal);
      const type = change === "move" ? "session.moved" : change === "delete" ? "session.deleted" : "session.created";
      await send(type, { sessionID: "ses_child", parentID: "ses_parent", location: { directory: change === "foreign-payload-birth" ? "/foreign" : WORKSPACE } }, change === "new-generation" ? 40 : 10);
      await send("session.message.content.updated", { sessionID: "ses_parent", messageID: fixture.launch.id, content: fixture.launch.content }, 50);
      for (let attempt = 0; attempt < 2; attempt++) {
        await expect(provider.stopTask("ses_parent", "v2:ses_parent:call_worker")).rejects.toThrow(/no longer/);
        expect(await provider.reconcileBackgroundTasks("ses_parent", { fresh: true })).toEqual([expect.objectContaining({ stateUncertain: true })]);
      }
      expect(server.requests("POST", "/api/session/ses_child/interrupt")).toHaveLength(0);
    } finally { lifetime.abort(); await pump; await provider.dispose(); }
  });

  test("native initial foreground work stays certain and detaches with its original identity", async () => {
    const { fake, provider, adapter } = nativeBackgroundStack();
    const pump = adapter.startEventPump(); void pump.catch(() => undefined);
    try {
      await provider.waitForEventStream(new AbortController().signal);
      const parent = (await adapter.createConversation()).conversation.id;
      await adapter.prompt(parent, "fixture-prompt", "Start fixture work");
      const worker = fake.launchWorker(parent, false);
      await adapter.history(parent);
      expect(workerSummary(compactWorkers(adapter.projectionForTests(parent).items()))).toBe("1 working");
      expect((await provider.reconcileBackgroundTasks(parent)).filter(item => item.status === "running")).toEqual([]);
      await provider.backgroundBlockingWork(parent);
      let rows = await provider.reconcileBackgroundTasks(parent, { fresh: true });
      for (let attempt = 0; attempt < 100 && rows.some(row => row.stateUncertain); attempt++) {
        await Bun.sleep(1); rows = await provider.reconcileBackgroundTasks(parent, { fresh: true });
      }
      expect(rows).toEqual([expect.objectContaining({ taskId: worker.taskId, childConversationId: worker.childId, stateUncertain: false })]);
      await adapter.history(parent);
      expect(workerSummary(compactWorkers(adapter.projectionForTests(parent).items()))).toBe("1 working");
      await provider.stopTask(parent, worker.taskId);
      expect(fake.state().sessions[parent]?.running).toBe(true);
      expect(fake.state().calls.filter(call => call.startsWith(`POST /api/session/${worker.childId}/interrupt?`))).toHaveLength(1);
    } finally {
      await adapter.dispose(); await pump.catch(error => { expect(String(error)).toMatch(/aborted/i); }); await fake.stop();
    }
  });

  test("history overtaking child creation and first start stays pending until the exact live occurrence binds", async () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    let wire!: ReadableStreamDefaultController<Uint8Array>, acknowledge: (() => void) | undefined, sequence = 0;
    const frame = (type: string, data: unknown, created: number) => wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ id: `bootstrap-${++sequence}`, type, data, created, location: { directory: WORKSPACE } })}\n\n`));
    const send = (type: string, data: unknown, created: number) => new Promise<void>(resolve => { acknowledge = resolve; frame(type, data, created); });
    const server = fakeOpenCode({
      "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) { wire = controller; frame("server.connected", {}, 1); } }), { headers: { "content-type": "text/event-stream" } }),
      "GET /api/session/active": () => ({ ses_child: { status: "running" } }),
      "GET /api/session/:id": ({ path }) => session(path.split("/").at(-1)!, path.endsWith("ses_child") ? { parentID: "ses_parent" } : {}),
      "GET /api/session/ses_parent/message": () => ({ data: [fixture.launch], cursor: {} }),
      "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
      "GET /api/session/ses_child/message": () => ({ data: [], cursor: {} }),
      "POST /api/session/ses_child/interrupt": () => ({ interrupted: true }),
    });
    const provider = server.provider(), lifetime = new AbortController();
    const pump = (async () => { for await (const event of provider.events(lifetime.signal)) if (event.eventType !== "server.connected") { const done = acknowledge; acknowledge = undefined; done?.(); } })();
    try {
      await provider.waitForEventStream(lifetime.signal);
      await send("session.created", { sessionID: "ses_parent", location: { directory: WORKSPACE } }, 2);
      await send("session.execution.started", { sessionID: "ses_parent" }, 3);
      await send("session.created", { sessionID: "ses_child", parentID: "ses_parent", location: { directory: WORKSPACE } }, 10);
      expect(await provider.reconcileBackgroundTasks("ses_parent")).toEqual([expect.objectContaining({ stateUncertain: true })]);
      await send("session.execution.started", { sessionID: "ses_child" }, 21);
      expect(await provider.reconcileBackgroundTasks("ses_parent", { fresh: true })).toEqual([expect.objectContaining({ stateUncertain: true })]);
      await send("session.message.content.updated", { sessionID: "ses_parent", messageID: fixture.launch.id, content: fixture.launch.content }, 30);
      expect(await provider.reconcileBackgroundTasks("ses_parent", { fresh: true })).toEqual([expect.objectContaining({ stateUncertain: false })]);
      await provider.stopTask("ses_parent", "v2:ses_parent:call_worker");
      expect(server.requests("POST", "/api/session/ses_child/interrupt")).toHaveLength(1);
      await send("session.execution.started", { sessionID: "ses_child" }, 40);
      await expect(provider.stopTask("ses_parent", "v2:ses_parent:call_worker")).rejects.toThrow(/no longer/);
      expect(await provider.reconcileBackgroundTasks("ses_parent", { fresh: true })).toEqual([expect.objectContaining({ stateUncertain: true })]);
      expect(server.requests("POST", "/api/session/ses_child/interrupt")).toHaveLength(1);
    } finally { lifetime.abort(); await pump; await provider.dispose(); }
  });

  for (const order of ["live", "cold-history"] as const) test(`native bootstrap ${order} preserves three working rows and confined Stops`, async () => {
    const { fake, provider, adapter } = nativeBackgroundStack();
    let pump: Promise<void> | undefined;
    try {
      let parent: string;
      if (order === "live") {
        pump = adapter.startEventPump(); void pump.catch(() => undefined);
        await provider.waitForEventStream(new AbortController().signal);
        parent = (await adapter.createConversation()).conversation.id;
        await adapter.prompt(parent, "fixture-prompt", "Start fixture work");
        await adapter.history(parent);
      } else {
        parent = (await provider.createSession("ignored")).id;
        await provider.prompt(parent, { id: "fixture-prompt", text: "Start fixture work", delivery: "queue" });
      }
      const shell = fake.launchShell(parent, true), first = fake.launchWorker(parent, true), active = fake.launchWorker(parent, true);
      if (order === "cold-history") { pump = adapter.startEventPump(); void pump.catch(() => undefined); await provider.waitForEventStream(new AbortController().signal); }
      let summary = "";
      for (let attempt = 0; attempt < 100; attempt++) {
        await adapter.history(parent);
        summary = workerSummary(compactWorkers(adapter.projectionForTests(parent).items()));
        if (summary === "3 working") break;
        await Bun.sleep(1);
      }
      expect(summary).toBe("3 working");
      fake.settleWorker(first.childId, "completed", "Safe native report");
      await adapter.history(parent);
      expect(workerSummary(compactWorkers(adapter.projectionForTests(parent).items()))).toBe("2 working · 1 finished");
      // Working is no longer a Stop-readiness signal. Wait for this separate
      // native control cohort rather than making activity depend on its ledger.
      let controllable = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const rows = await provider.reconcileBackgroundTasks(parent, { fresh: true });
        controllable = [active.taskId, ...(order === "live" ? [shell.taskId] : [])].every(id => rows.find(row => row.taskId === id)?.control?.available === true);
        if (order === "cold-history") expect(rows.find(row => row.taskId === shell.taskId)?.control?.available).toBe(false);
        if (controllable) break;
        await Bun.sleep(1);
      }
      expect(controllable).toBe(true);
      await provider.stopTask(parent, active.taskId);
      if (order === "live") await provider.stopTask(parent, shell.taskId);
      else await expect(provider.stopTask(parent, shell.taskId)).rejects.toThrow(/no longer confirmed/);
      expect(fake.state().sessions[parent]?.running).toBe(true);
      expect(fake.state().calls.filter(call => call.startsWith(`POST /api/session/${active.childId}/interrupt?`))).toHaveLength(1);
      expect(fake.state().calls.filter(call => call.startsWith(`DELETE /api/shell/${shell.shellId}?`))).toHaveLength(order === "live" ? 1 : 0);
      expect(fake.state().unhandled).toEqual([]);
    } finally {
      await adapter.dispose();
      await pump?.catch(error => { expect(String(error)).toMatch(/aborted/i); });
      await fake.stop();
    }
  });
});

describe("OpenCode 2.x provider: identity and catalogs", () => {
  test("event readiness requires a consumed native handshake in the current generation", async () => {
    let push!: ReadableStreamDefaultController<Uint8Array>, opened!: () => void, heartbeat!: () => void;
    let opening = new Promise<void>(resolve => { opened = resolve; });
    const frame = (type: string) => push.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type, data: {} })}\n\n`));
    const server = fakeOpenCode({
      "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) { push = controller; opened(); } }), { headers: { "content-type": "text/event-stream" } }),
    });
    const provider = server.provider();
    const lifetime = new AbortController();
    // A readiness read never creates a stream itself.
    await expect(provider.waitForEventStream(lifetime.signal)).rejects.toThrow("unavailable");
    expect(server.calls).toHaveLength(0);
    let controller = new AbortController();
    const consume = () => (async () => { for await (const event of provider.events(controller.signal)) if (event.eventType === "server.heartbeat") heartbeat(); })();
    let pump = consume();
    try {
      await opening;
      let ready = false;
      const waiting = provider.waitForEventStream(lifetime.signal).then(() => { ready = true; });
      const observed = new Promise<void>(resolve => { heartbeat = resolve; });
      frame("server.heartbeat");
      await observed;
      expect(ready).toBe(false);
      frame("server.connected");
      await waiting;
      expect(ready).toBe(true);
      await provider.waitForEventStream(lifetime.signal);
      controller.abort();
      // Even before generator cleanup, an aborted generation is not ready.
      await expect(provider.waitForEventStream(lifetime.signal)).rejects.toThrow("unavailable");
      await pump;
      opening = new Promise<void>(resolve => { opened = resolve; });
      controller = new AbortController();
      pump = consume();
      await opening;
      const cancelled = new AbortController();
      const aborted = provider.waitForEventStream(cancelled.signal).catch(error => error);
      cancelled.abort();
      expect(await aborted).toBeInstanceOf(Error);
      const ended = provider.waitForEventStream(lifetime.signal).catch(error => error);
      push.close();
      expect(await ended).toBeInstanceOf(Error);
      await pump;
      expect(server.requests("GET", "/api/event")).toHaveLength(2);
    } finally { controller.abort(); await pump; await provider.dispose(); }
  });

  test("side generation uses the native isolated endpoint, never prompt/interrupt/background", async () => {
    const server = fakeOpenCode({
      "POST /api/session/ses/generate": call => {
        expect(call.body).toEqual({ prompt: "Side question" });
        return { data: { text: "Side answer" } };
      },
    });
    expect(await server.provider().generate("ses", "Side question")).toBe("Side answer");
    expect(server.calls.map(call => `${call.method} ${call.path}`)).toEqual(["POST /api/session/ses/generate"]);
  });
  test("declares the capabilities the 2.x stack backs", () => {
    const { provider } = fakeOpenCode({});
    expect(provider().describe()).toMatchObject({ id: "opencode", name: "OpenCode" });
    expect(provider().describe().capabilities).toEqual(["modes", "models", "commands", "questions", "permissions", "subagents", "variants", "context", "conversation-rename", "attachments", "reversible-history", "steering", "send-now", "background-tasks", "background-blocking-work", "side-generation"]);
    expect(provider().describe().permissionScopeNote).toContain("until OpenCode restarts");
  });

  test("every catalog call is scoped to the workspace directory and authenticated", async () => {
    const server = fakeOpenCode({
      "GET /api/command": () => scoped([{ name: "review", description: "review changes" }, { name: "bad name" }, { name: "review" }]),
      // 2.x keeps skills apart from commands: listed under their id, a
      // config command's name wins, and so does a skill's over a built-in.
      "GET /api/skill": () => scoped([
        skillInfo("openspec-apply-change", { description: "Apply a change" }),
        skillInfo("review", { description: "shadowed by the config command" }),
        skillInfo("pdf", { name: "PDF tools", description: "Work with PDFs" }),
        skillInfo("compact", { description: "shadows the built-in" }),
        skillInfo("bad id"),
      ]),
      "GET /api/agent": () => scoped([
        { id: "build", name: "Build", description: "The default agent", mode: "primary", hidden: false },
        { id: "plan", name: "Plan", description: "Plans", mode: "primary", hidden: false },
        { id: "title", name: "Title", mode: "primary", hidden: true },
        { id: "explore", name: "Explore", mode: "subagent", hidden: false },
      ]),
    });
    const provider = server.provider();
    expect(await provider.listCommands()).toEqual([
      { name: "review", description: "review changes", argumentHint: "", kind: "command" },
      { name: "openspec-apply-change", description: "Apply a change", argumentHint: "", kind: "skill" },
      { name: "pdf", description: "PDF tools — Work with PDFs", argumentHint: "", kind: "skill" },
      { name: "compact", description: "shadows the built-in", argumentHint: "", kind: "skill" },
      { name: "reload", description: "Reload OpenCode's configuration for this workspace", argumentHint: "", kind: "command" },
    ]);
    expect(await provider.listModes()).toEqual([
      { name: "build", description: "The default agent" },
      { name: "plan", description: "Plans" },
    ]);
    for (const call of server.calls) {
      expect(call.path.startsWith("/api/")).toBe(true);
      expect(call.headers.get("authorization")).toBe(AUTH);
      expect(call.query.get("location[directory]")).toBe(WORKSPACE);
    }
  });

  test("models carry provider names, variants, context limits, and image input", async () => {
    const { provider } = fakeOpenCode({
      "GET /api/model": () => scoped([
        { id: "flash", modelID: "flash", providerID: "opencode", name: "Flash", capabilities: { tools: true, input: ["text", "image"], output: ["text"] }, variants: [], limit: { context: 200000, output: 32000 }, status: "active", enabled: true, cost: [], time: { released: 0 } },
        { id: "think", modelID: "think", providerID: "berget", name: "Thinker", capabilities: { tools: true, input: ["text"], output: ["text"] }, variants: [{ id: "high" }, { id: "low" }], limit: { context: 128000, output: 8000 }, status: "active", enabled: true, cost: [], time: { released: 0 } },
        { id: "old", modelID: "old", providerID: "berget", name: "Old", capabilities: { tools: true, input: ["text"], output: ["text"] }, variants: [], limit: { context: 8000, output: 800 }, status: "deprecated", enabled: true, cost: [], time: { released: 0 } },
        { id: "off", modelID: "off", providerID: "berget", name: "Off", capabilities: { tools: true, input: ["text"], output: ["text"] }, variants: [], limit: { context: 8000, output: 800 }, status: "active", enabled: false, cost: [], time: { released: 0 } },
      ]),
      "GET /api/provider": () => scoped([{ id: "opencode", name: "OpenCode Zen", activation: "auto", package: "x" }, { id: "berget", name: "Berget", activation: "enabled", package: "y" }]),
    });
    expect(await provider().listModels()).toEqual([
      { selection: { providerId: "berget", modelId: "think" }, provider: "Berget", name: "Thinker", variants: ["high", "low"], contextLimit: 128000, contextWindow: { source: "catalog", freshness: "current" } },
      { selection: { providerId: "opencode", modelId: "flash" }, provider: "OpenCode Zen", name: "Flash", contextLimit: 200000, contextWindow: { source: "catalog", freshness: "current" }, imageInput: true },
    ]);
  });

  test("a new conversation takes the build agent and its model, else the server default", async () => {
    const withAgentModel = fakeOpenCode({
      "GET /api/model/default": () => scoped({ id: "flash", modelID: "flash", providerID: "opencode" }),
      "GET /api/agent": () => scoped([{ id: "build", name: "Build", mode: "primary", hidden: false, model: { id: "think", providerID: "berget" } }]),
    });
    expect(await withAgentModel.provider().newConversationConfiguration()).toEqual({ model: { providerId: "berget", modelId: "think" }, mode: "build" });

    const fallback = fakeOpenCode({
      "GET /api/model/default": () => scoped({ id: "flash", modelID: "flash", providerID: "opencode" }),
      "GET /api/agent": () => scoped([{ id: "plan", name: "Plan", mode: "primary", hidden: false }]),
    });
    expect(await fallback.provider().newConversationConfiguration()).toEqual({ model: { providerId: "opencode", modelId: "flash" }, mode: "plan" });
  });
});

describe("OpenCode 2.x provider: sessions", () => {
  test("repeated child references reuse verified parentage without dropping unrelated streamed text", async () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    const frames = [{ type: "server.connected", data: {} }, ...[1, 2, 3].map(index => ({
      type: "session.message.content.updated", location: { directory: WORKSPACE }, created: index,
      data: { sessionID: "ses_parent", messageID: `answer${index}`, content: [{ type: "text", id: `text${index}`, text: `Answer ${index}` }, ...fixture.launch.content] },
    }))];
    let lookups = 0;
    const server = fakeOpenCode({
      "GET /api/event": () => new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } }),
      "GET /api/session/ses_child": () => ++lookups === 3 ? new Response(null, { status: 500 }) : session("ses_child", { parentID: "ses_parent" }),
    });
    const provider = server.provider();
    try {
      const events = [];
      for await (const event of provider.events(new AbortController().signal)) events.push(event);
      expect(events.slice(1)).toHaveLength(3);
      for (const [index, event] of events.slice(1).entries()) {
        expect(event).toMatchObject({ conversationId: "ses_parent", eventType: "session.message.content.updated", outcome: "handled" });
        expect(event.updates).toContainEqual(expect.objectContaining({ kind: "text", text: `Answer ${index + 1}` }));
      }
      expect(lookups).toBe(1);
    } finally { await provider.dispose(); }
  });
  test("a failed child lookup preserves the frame and retries ownership on the next frame", async () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    let reads = 0;
    const frames = ["server.connected", ...Array(2).fill("session.message.content.updated")].map((type, index) => ({
      type, location: { directory: WORKSPACE }, created: index,
      data: index ? { sessionID: "ses_parent", messageID: `answer${index}`, content: [{ type: "text", text: `Answer ${index}` }, ...fixture.launch.content] } : {},
    }));
    const server = fakeOpenCode({
      "GET /api/event": () => new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } }),
      "GET /api/session/ses_child": () => ++reads === 1 ? new Response(null, { status: 500 }) : session("ses_child", { parentID: "ses_parent" }),
    });
    const provider = server.provider();
    try {
      const events = [];
      for await (const event of provider.events(new AbortController().signal)) events.push(event);
      for (const [index, event] of events.slice(1).entries()) {
        expect(event).toMatchObject({ conversationId: "ses_parent", eventType: "session.message.content.updated" });
        expect(event.updates).toContainEqual(expect.objectContaining({ kind: "text", text: `Answer ${index + 1}` }));
      }
      expect(events[1]!.updates.some(update => update.kind === "upsert" && update.item.type === "background_task")).toBe(false);
      expect(events[2]!.updates).toContainEqual(expect.objectContaining({ kind: "upsert", item: expect.objectContaining({ type: "background_task" }) }));
      expect(reads).toBe(2);
    } finally { await provider.dispose(); }
  });
  for (const abort of [false, true]) test(`hung child verification has a batch deadline, bounded fanout, and stream cancellation (${abort ? "abort" : "deadline"})`, async () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    const content = Array.from({ length: 12 }, (_, index) => {
      const part = structuredClone(fixture.launch.content[0]);
      part.id = `call${index}`;
      part.state.metadata.sessionID = `child${index}`;
      return part;
    });
    let reading!: () => void;
    const started = new Promise<void>(resolve => { reading = resolve; });
    const frame = { type: "session.message.content.updated", location: { directory: WORKSPACE }, data: { sessionID: "ses_parent", messageID: "answer", content: [{ type: "text", text: "Still readable" }, ...content, ...content] } };
    const frames = [{ type: "server.connected", data: {} }, frame, { type: "session.text.delta", data: { sessionID: "other", messageID: "other-answer", id: "other-text", delta: "Other conversation" } }];
    const server = fakeOpenCode({
      "GET /api/event": () => new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } }),
      // Deliberately ignore cancellation to cover transports that never settle.
      "GET /api/session/:id": () => { reading(); return new Promise(() => {}); },
    });
    const provider = server.provider();
    const controller = new AbortController();
    const events: Array<{ eventType: string; conversationId?: string; updates: unknown[] }> = [];
    const pump = (async () => { for await (const event of provider.events(controller.signal)) events.push(event); })();
    try {
      await started;
      if (abort) controller.abort();
      await pump;
      const children = server.calls.filter(call => call.path.startsWith("/api/session/"));
      expect(children).toHaveLength(4);
      expect(children.every(call => call.signal.aborted)).toBe(true);
      if (abort) expect(events.map(event => event.eventType)).toEqual(["server.connected"]);
      else {
        expect(events[1]).toMatchObject({ conversationId: "ses_parent", eventType: frame.type });
        expect(events[1]!.updates).toContainEqual(expect.objectContaining({ kind: "text", text: "Still readable" }));
        expect(events[2]).toMatchObject({ conversationId: "other", eventType: "session.text.delta" });
      }
    } finally { controller.abort(); await pump; await provider.dispose(); }
  }, 5_000);
  test("underlying child lookup slots remain bounded across timed-out frames, history reads, reconnect, and late settlement", async () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    let stream!: ReadableStreamDefaultController<Uint8Array>, acknowledge: (() => void) | undefined;
    let outstanding = 0, peak = 0, hanging = true;
    const held: Array<{ release: () => void; settled: Promise<void> }> = [];
    const frame = (type: string, data: unknown) => stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type, data, location: { directory: WORKSPACE }, created: 30 })}\n\n`));
    const launch = (child: string) => {
      const part = structuredClone(fixture.launch.content[0]);
      part.id = `call_${child}`; part.state.metadata.sessionID = child;
      return part;
    };
    const send = (children: string[], text: string) => new Promise<void>(resolve => {
      acknowledge = resolve;
      frame("session.message.content.updated", { sessionID: "ses_parent", messageID: text, content: [{ type: "text", text }, ...children.map(launch)] });
    });
    const server = fakeOpenCode({
      "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; frame("server.connected", {}); } }), { headers: { "content-type": "text/event-stream" } }),
      "GET /api/session/ses_parent": () => session("ses_parent"),
      "GET /api/session/ses_parent/message": () => ({ data: [{ ...fixture.launch, content: [{ type: "text", id: "parent_text", text: "Parent history remains readable" }, launch("history_child")] }], cursor: {} }),
      "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
      "GET /api/session/active": () => ({}),
      "GET /api/session/:id": async ({ path }) => {
        outstanding++; peak = Math.max(peak, outstanding);
        try {
          if (hanging) {
            let release!: () => void, settled!: () => void;
            const gate = new Promise<void>(resolve => { release = resolve; });
            held.push({ release, settled: new Promise<void>(resolve => { settled = resolve; }) });
            // This transport ignores cancellation; only actual settlement frees it.
            try { await gate; } finally { settled(); }
          }
          return session(path.split("/").at(-1)!, { parentID: "ses_parent" });
        } finally { outstanding--; }
      },
    });
    const provider = server.provider();
    let controller = new AbortController();
    const events: Array<{ updates: unknown[] }> = [];
    const consume = () => (async () => { for await (const event of provider.events(controller.signal)) {
      events.push(event);
      if (event.eventType === "session.message.content.updated") { acknowledge?.(); acknowledge = undefined; }
    } })();
    let pump = consume();
    const childCalls = () => server.calls.filter(call => /^\/api\/session\/(child|history_child)/.test(call.path) && !call.path.endsWith("/message"));
    try {
      await provider.waitForEventStream(controller.signal);
      const counts = [];
      for (let batch = 0; batch < 3; batch++) {
        await send(Array.from({ length: 4 }, (_, index) => `child${batch}_${index}`), `Text ${batch}`);
        counts.push(outstanding);
      }
      expect(counts).toEqual([4, 4, 4]);
      expect(childCalls()).toHaveLength(4);
      for (let batch = 0; batch < 3; batch++) expect(events.flatMap(event => event.updates)).toContainEqual(expect.objectContaining({ kind: "text", text: `Text ${batch}` }));
      // Optional child enrichment must not make the parent's transcript depend
      // on a free ownership slot. No unverified worker target may escape.
      for (let attempt = 0; attempt < 2; attempt++) {
        const history = await provider.listMessages("ses_parent", { limit: 1 });
        expect(history.items).toContainEqual(expect.objectContaining({ type: "assistant_message", markdown: "Parent history remains readable" }));
        expect(history.items.some(item => item.type === "background_task")).toBe(false);
        expect(history.items).toContainEqual(expect.objectContaining({ type: "tool", output: expect.stringContaining("The subagent is working") }));
        expect(history.items.some(item => "childConversationId" in item && item.childConversationId)).toBe(false);
      }
      // Inventory and Stop recovery still require positive ownership coverage.
      await expect(provider.reconcileBackgroundTasks("ses_parent", { fresh: true })).rejects.toThrow("capacity");
      expect(childCalls()).toHaveLength(4);
      controller.abort(); await pump;
      controller = new AbortController(); pump = consume();
      await provider.waitForEventStream(controller.signal);
      await send(["child_after_reconnect"], "Still readable after reconnect");
      expect(childCalls()).toHaveLength(4);
      hanging = false;
      held[0]!.release(); await held[0]!.settled;
      // Retry read-only frames until the actual SDK promise (including response
      // decoding) settles, not merely the fake handler's gate.
      const deadline = Date.now() + 2_000;
      while (childCalls().length === 4 && Date.now() < deadline) {
        await send(["child0_0"], "Fresh retry");
        if (childCalls().length === 4) await Bun.sleep(0);
      }
      expect(childCalls()).toHaveLength(5);
      expect(server.requests("GET", "/api/session/child0_0")).toHaveLength(2);
      expect(events.flatMap(event => event.updates)).toContainEqual(expect.objectContaining({ kind: "upsert", item: expect.objectContaining({ type: "background_task", childConversationId: "child0_0" }) }));
      expect(peak).toBe(4);
      expect(outstanding).toBe(3);
      controller.abort(); await pump; await provider.dispose();
      const count = events.length;
      held.forEach(read => read.release()); await Promise.all(held.map(read => read.settled));
      await expect(provider.listMessages("ses_parent", { limit: 1 })).rejects.toThrow();
      expect(events).toHaveLength(count);
      expect(childCalls()).toHaveLength(5);
      expect(server.calls.every(call => call.method === "GET")).toBe(true);
    } finally { controller.abort(); held.forEach(read => read.release()); await pump; await provider.dispose(); }
  }, 10_000);
  for (const unavailable of ["ownership", "execution boundaries"] as const) test(`parent history survives hung child ${unavailable} and later recovers enrichment`, async () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    let hanging = true;
    const held: Array<() => void> = [];
    const wait = () => new Promise<void>(resolve => { held.push(resolve); });
    const server = fakeOpenCode({
      "GET /api/session/ses_parent": () => session("ses_parent"),
      "GET /api/session/ses_parent/message": () => ({ data: [{ ...fixture.launch, content: [{ type: "text", text: "Parent answer" }, ...fixture.launch.content] }], cursor: {} }),
      "GET /api/session/ses_child": async () => {
        if (hanging && unavailable === "ownership") await wait();
        return session("ses_child", { parentID: "ses_parent" });
      },
      "GET /api/session/ses_child/message": async () => {
        if (hanging && unavailable === "execution boundaries") await wait();
        return { data: [], cursor: {} };
      },
    });
    const provider = server.provider();
    try {
      // A caller deadline outlives the optional enrichment budget, not vice versa.
      const signal = AbortSignal.timeout(2_500);
      const history = await provider.listMessages("ses_parent", { limit: 50, signal });
      expect(signal.aborted).toBe(false);
      expect(history.items).toContainEqual(expect.objectContaining({ type: "assistant_message", markdown: "Parent answer" }));
      expect(history.items).toContainEqual(expect.objectContaining({ type: "tool", output: expect.stringContaining("The subagent is working") }));
      if (unavailable === "ownership") {
        expect(history.items.some(item => item.type === "background_task" || "childConversationId" in item && item.childConversationId)).toBe(false);
        expect(server.requests("GET", "/api/session/ses_child/message")).toHaveLength(0);
      } else {
        expect(history.items).toContainEqual(expect.objectContaining({ type: "background_task", status: "running", stateUncertain: true }));
      }
      hanging = false;
      held.forEach(release => release());
      const recovered = await provider.listMessages("ses_parent", { limit: 50 });
      expect(recovered.items).toContainEqual(expect.objectContaining({ type: "background_task", status: "running", childConversationId: "ses_child" }));
      expect(recovered.items).toContainEqual(expect.objectContaining({ type: "tool", childConversationId: "ses_child" }));
      expect(server.requests("GET", "/api/session/ses_child/message").length).toBeGreaterThan(0);
      expect(server.calls.every(call => call.method === "GET")).toBe(true);
    } finally { held.forEach(release => release()); await provider.dispose(); }
  }, 5_000);
  for (const required of ["transcript", "session"] as const) test(`optional enrichment does not hide an unavailable parent ${required}`, async () => {
    const server = fakeOpenCode({
      "GET /api/session/ses_parent": () => required === "session" ? new Response(null, { status: 500 }) : session("ses_parent"),
      "GET /api/session/ses_parent/message": () => required === "transcript" ? new Response(null, { status: 500 }) : { data: [], cursor: {} },
    });
    const provider = server.provider();
    try { await expect(provider.listMessages("ses_parent", { limit: 50 })).rejects.toThrow(); }
    finally { await provider.dispose(); }
  });
  for (const suffix of ["none", "worker", "reused-worker", "alias"] as const) test(`partial prefix enrichment cannot authorize worker exclusions (${suffix})`, async () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    const hidden = structuredClone(suffix === "alias" ? fixture.converted : fixture.launch);
    hidden.id = "hidden_launch"; hidden.time.created = 110;
    hidden.content[0].id = "hidden_call";
    hidden.content[0].state.metadata.sessionID = suffix === "alias" || suffix === "reused-worker" ? "ses_child" : "hidden_child";
    if (suffix === "reused-worker") hidden.content[0].time = { created: 110, completed: 120 };
    let reads = 0;
    const server = fakeOpenCode({
      "GET /api/session/ses_parent": () => session("ses_parent", { revert: { messageID: "boundary" } }),
      "GET /api/session/ses_parent/message": () => ({ data: [fixture.launch, { id: "boundary", type: "user", time: { created: 100 }, payload: { text: "Hidden turn" } }, ...(suffix !== "none" ? [hidden] : [])], cursor: {} }),
      "GET /api/session/ses_child": () => ++reads === 1 ? new Response(null, { status: 500 }) : session("ses_child", { parentID: "ses_parent" }),
      "GET /api/session/hidden_child": () => session("hidden_child", { parentID: "ses_parent" }),
      "GET /api/session/ses_child/message": () => ({ data: suffix === "reused-worker" ? [{ id: "child_idle", type: "idle", time: { created: 40 } }] : [], cursor: {} }),
      "GET /api/session/hidden_child/message": () => ({ data: [], cursor: {} }),
    });
    const provider = server.provider();
    try {
      const history = await provider.listMessages("ses_parent", { limit: 50 });
      expect(history.revertVisibility?.excludedItemIds.toSorted()).toEqual([
        "message:boundary", ...(suffix === "worker" || suffix === "reused-worker" ? ["task:v2:ses_parent:hidden_call"] : []), ...(suffix !== "none" ? ["tool:hidden_call"] : []),
      ].toSorted());
      expect(history.items.map(item => item.id)).toEqual(["tool:call_worker"]);
      expect(history.completeItems?.map(item => item.id)).toEqual(["tool:call_worker"]);
      expect(history.items.some(item => "childConversationId" in item && item.childConversationId)).toBe(false);
      // The next independent read can recover metadata; this snapshot never
      // turns a transient prefix omission into deletion authority.
      const recovered = await provider.listMessages("ses_parent", { limit: 50 });
      expect(recovered.items).toContainEqual(expect.objectContaining({ type: "background_task", id: "task:v2:ses_parent:call_worker" }));
      expect(recovered.revertVisibility?.excludedItemIds).not.toContain("task:v2:ses_parent:call_worker");
      expect(server.calls.every(call => call.method === "GET")).toBe(true);
    } finally { await provider.dispose(); }
  });
  for (const retainLaunch of [false, true]) test(`raw task visibility survives unavailable ownership (${retainLaunch ? "retained launch" : "hidden launch"})`, async () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    const server = fakeOpenCode({
      "GET /api/session/ses_parent": () => session("ses_parent", { revert: { messageID: retainLaunch ? fixture.stored.id : fixture.launch.id } }),
      "GET /api/session/ses_parent/message": () => ({ data: [fixture.launch, fixture.stored], cursor: {} }),
      "GET /api/session/ses_child": () => new Response(null, { status: 500 }),
    });
    const provider = server.provider();
    try {
      const history = await provider.listMessages("ses_parent", { limit: 50 });
      expect(history.items.map(item => item.id)).toEqual(retainLaunch ? ["tool:call_worker"] : []);
      expect(history.revertVisibility?.excludedItemIds.includes("task:v2:ses_parent:call_worker")).toBe(!retainLaunch);
      expect(history.revertVisibility?.excludedItemIds).toContain("task:v2:ses_parent:notification:msg_result");
      expect(server.requests("GET", "/api/session/ses_child/message")).toHaveLength(0);
      expect(server.calls.every(call => call.method === "GET")).toBe(true);
    } finally { await provider.dispose(); }
  });
  for (const origin of ["launcher", "notification"] as const) test(`unverified revert exclusions match previously emitted ${origin} identities without granting Stop`, async () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    const message = origin === "launcher" ? fixture.launch : fixture.stored;
    const makeServer = (verified: boolean) => fakeOpenCode({
      "GET /api/session/ses_parent": () => session("ses_parent", verified ? {} : { revert: { messageID: message.id } }),
      "GET /api/session/ses_parent/message": () => ({ data: [message], cursor: {} }),
      "GET /api/session/ses_child": () => verified ? session("ses_child", { parentID: "ses_parent" }) : new Response(null, { status: 500 }),
      "GET /api/session/ses_child/message": () => ({ data: [], cursor: {} }),
    });
    const healthy = makeServer(true).provider();
    const unavailable = makeServer(false), provider = unavailable.provider();
    try {
      const emitted = (await healthy.listMessages("ses_parent", { limit: 50 })).items.filter(item => item.type === "background_task");
      expect(emitted).toHaveLength(1);
      const task = emitted[0]!;
      const hidden = await provider.listMessages("ses_parent", { limit: 50 });
      expect(hidden.items).toEqual([]);
      expect(hidden.revertVisibility?.excludedItemIds).toContain(task.id);
      expect(unavailable.requests("GET", "/api/session/ses_child/message")).toHaveLength(0);
      await expect(provider.stopTask("ses_parent", task.taskId)).rejects.toThrow();
      expect(unavailable.calls.every(call => call.method === "GET")).toBe(true);
    } finally { await healthy.dispose(); await provider.dispose(); }
  });
  test("successful prefix enrichment followed by unavailable full enrichment preserves retained worker visibility", async () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    let reads = 0;
    const server = fakeOpenCode({
      "GET /api/session/ses_parent": () => session("ses_parent", { revert: { messageID: "boundary" } }),
      "GET /api/session/ses_parent/message": () => ({ data: [fixture.launch, { id: "boundary", type: "user", time: { created: 100 }, payload: { text: "Hidden turn" } }], cursor: {} }),
      "GET /api/session/ses_child": () => ++reads === 2 ? new Response(null, { status: 500 }) : session("ses_child", { parentID: "ses_parent" }),
      "GET /api/session/ses_child/message": () => ({ data: [], cursor: {} }),
    });
    const provider = server.provider();
    try {
      const history = await provider.listMessages("ses_parent", { limit: 50 });
      expect(history.revertVisibility?.excludedItemIds).toEqual(["message:boundary"]);
      expect(history.items).toContainEqual(expect.objectContaining({ type: "background_task", id: "task:v2:ses_parent:call_worker" }));
      expect(reads).toBe(2);
      const recovered = await provider.listMessages("ses_parent", { limit: 50 });
      expect(recovered.revertVisibility?.excludedItemIds).toEqual(["message:boundary"]);
      expect(recovered.items).toContainEqual(expect.objectContaining({ type: "background_task", id: "task:v2:ses_parent:call_worker" }));
    } finally { await provider.dispose(); }
  });
  test("paged and staged-revert folds reuse only parentage while refreshing cost and visible worker state", async () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    let boundary: string | undefined;
    let cost = 1;
    const server = fakeOpenCode({
      "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "server.connected", data: {} })}\n\n`));
      } }), { headers: { "content-type": "text/event-stream" } }),
      "GET /api/session/ses_parent": () => session("ses_parent", { cost, ...(boundary ? { revert: { messageID: boundary } } : {}) }),
      "GET /api/session/ses_child": () => session("ses_child", { parentID: "ses_parent" }),
      "GET /api/session/ses_parent/message": () => ({ data: [fixture.launch, fixture.stored], cursor: {} }),
    });
    const provider = server.provider();
    const controller = new AbortController();
    const events = provider.events(controller.signal)[Symbol.asyncIterator]();
    try {
      await events.next();
      const first = await provider.listMessages("ses_parent", { limit: 1 });
      expect(first.completeItems).toContainEqual(expect.objectContaining({ type: "background_task", status: "completed" }));
      expect(first.sessionCostUsd).toBe(1);
      await provider.listMessages("ses_parent", { limit: 1, cursor: first.nextCursor });
      cost = 2;
      boundary = fixture.stored.id;
      for (let index = 0; index < 3; index++) {
        const staged = await provider.listMessages("ses_parent", { limit: 1 });
        expect(staged.completeItems).toContainEqual(expect.objectContaining({ type: "background_task", status: "running" }));
        expect(staged.completeItems?.some(item => item.type === "background_task" && item.status === "completed")).toBe(false);
        expect(staged.sessionCostUsd).toBe(2);
        expect(staged.revertVisibility?.boundaryId).toBe(boundary);
      }
      expect(server.requests("GET", "/api/session/ses_parent")).toHaveLength(5);
      expect(server.requests("GET", "/api/session/ses_child")).toHaveLength(1);
      expect(server.requests("GET", "/api/session/ses_parent/message")).toHaveLength(1);
    } finally { controller.abort(); await events.return?.(); await provider.dispose(); }
  });
  test("moved and deleted session events retire cached ownership, including foreign-location events", async () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    const launch = { type: "session.message.content.updated", location: { directory: WORKSPACE }, data: { sessionID: "ses_parent", messageID: "answer", content: fixture.launch.content } };
    const frames = [
      { type: "server.connected", data: {} }, launch,
      { type: "session.moved", location: { directory: "/other" }, data: { sessionID: "ses_child", location: { directory: "/other" } } }, launch,
      { type: "session.deleted", data: { sessionID: "ses_child" } }, launch,
    ];
    let reads = 0;
    const server = fakeOpenCode({
      "GET /api/event": () => new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } }),
      "GET /api/session/ses_child": () => ++reads === 3 ? notFound("ses_child") : session("ses_child", { parentID: "ses_parent", location: { directory: reads === 1 ? WORKSPACE : "/other" } }),
    });
    const provider = server.provider();
    try {
      const launches = [];
      for await (const event of provider.events(new AbortController().signal)) {
        if (event.eventType === launch.type) launches.push(event);
      }
      expect(launches.map(event => event.updates.some(update => update.kind === "upsert" && update.item.type === "background_task"))).toEqual([true, false, false]);
      expect(reads).toBe(3);
    } finally { await provider.dispose(); }
  });
  for (const lifecycle of ["session.moved", "session.deleted", "session.updated", "location.shutdown"]) test(`unrelated foreign ${lifecycle} preserves terminal worker occurrences and notice tombstones`, async () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    const launch = { type: "session.message.content.updated", location: { directory: WORKSPACE }, created: 30, data: { sessionID: "ses_parent", messageID: "answer", content: fixture.launch.content } };
    const report = { type: "session.inbox.enqueued", location: { directory: WORKSPACE }, created: 41, data: { sessionID: "ses_parent", inboxID: fixture.pending.id, item: fixture.pending } };
    const frames = [
      { type: "server.connected", data: {} }, launch, report,
      { type: lifecycle, location: { directory: "/other" }, data: { sessionID: "unrelated_foreign", location: { directory: "/other" } } },
      { ...launch, created: 43 }, { ...report, created: 44 },
    ];
    const server = fakeOpenCode({
      "GET /api/event": () => new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } }),
      "GET /api/session/ses_child": () => session("ses_child", { parentID: "ses_parent" }),
    });
    const provider = server.provider();
    try {
      const observed = [];
      for await (const event of provider.events(new AbortController().signal)) {
        observed.push(event.updates.flatMap(update => update.kind === "upsert" && update.item.type === "background_task" ? [{ status: update.item.status, resultId: update.item.resultId }] : []));
      }
      expect(observed).toEqual([[], [{ status: "running", resultId: undefined }], [{ status: "completed", resultId: fixture.pending.id }], [], [{ status: "completed", resultId: fixture.pending.id }], []]);
      expect(server.requests("GET", "/api/event")).toHaveLength(1);
      expect(server.calls.every(call => call.method === "GET")).toBe(true);
    } finally { await provider.dispose(); }
  });
  test("lifecycle invalidation cannot leave a saturated worker stream's recovery-only mode", async () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    const launch = { type: "session.message.content.updated", location: { directory: WORKSPACE }, created: 30, data: { sessionID: "ses_parent", messageID: "answer", content: fixture.launch.content } };
    const frames: unknown[] = Array.from({ length: 2200 }, (_, index) => ({ type: "session.created", location: { directory: WORKSPACE }, data: { sessionID: `filler${index}`.padEnd(500, "x"), parentID: "p".repeat(500) } }));
    frames.push({ type: "server.connected", data: {} }, launch,
      { type: "session.moved", location: { directory: "/other" }, data: { sessionID: "unrelated_foreign", location: { directory: "/other" } } }, launch,
      { type: "session.moved", location: { directory: WORKSPACE }, data: { sessionID: "ses_child", location: { directory: WORKSPACE } } }, launch);
    const server = fakeOpenCode({
      "GET /api/event": () => new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } }),
      "GET /api/session/ses_child": () => session("ses_child", { parentID: "ses_parent" }),
    });
    const provider = server.provider();
    try {
      const observed = [];
      for await (const event of provider.events(new AbortController().signal)) {
        if (event.eventType === launch.type) observed.push(event.updates.filter(update => update.kind === "upsert" && update.item.type === "background_task"));
      }
      expect(observed).toEqual([[], [], []]);
      expect(server.requests("GET", "/api/event")).toHaveLength(1);
      expect(server.calls.every(call => call.method === "GET")).toBe(true);
    } finally { await provider.dispose(); }
  });
  for (const foreign of [false, true]) test(`history never caches unverified child ownership (${foreign ? "foreign workspace" : "wrong parent"})`, async () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    const server = fakeOpenCode({
      "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('data: {"type":"server.connected","data":{}}\n\n')); } }), { headers: { "content-type": "text/event-stream" } }),
      "GET /api/session/ses_parent": () => session("ses_parent"),
      "GET /api/session/ses_child": () => session("ses_child", { parentID: foreign ? "ses_parent" : "other", location: { directory: foreign ? "/other" : WORKSPACE } }),
      "GET /api/session/ses_parent/message": () => ({ data: [fixture.launch, fixture.stored], cursor: {} }),
      "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
      "GET /api/session/active": () => ({ ses_child: { status: "running" } }),
    });
    const provider = server.provider();
    const controller = new AbortController();
    const events = provider.events(controller.signal)[Symbol.asyncIterator]();
    try {
      await events.next();
      for (let index = 0; index < 2; index++) {
        expect((await provider.listMessages("ses_parent", { limit: 1 })).completeItems?.some(item => item.type === "background_task")).toBe(false);
        expect(await provider.reconcileBackgroundTasks("ses_parent")).toEqual([]);
      }
      expect(server.requests("GET", "/api/session/ses_child")).toHaveLength(4);
      expect(server.requests("GET", "/api/session/ses_child/message")).toHaveLength(0);
      expect(server.calls.every(call => call.method === "GET")).toBe(true);
    } finally { controller.abort(); await events.return?.(); await provider.dispose(); }
  });
  test("failed recovery ownership reads stay unknown and retry rather than caching an empty inventory", async () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    let reads = 0, active = true;
    const server = fakeOpenCode({
      "GET /api/session/ses_parent": () => session("ses_parent"),
      "GET /api/session/ses_child": () => ++reads === 1 ? new Response(null, { status: 500 }) : session("ses_child", { parentID: "ses_parent" }),
      "GET /api/session/ses_parent/message": () => ({ data: [fixture.launch], cursor: {} }),
      "GET /api/session/ses_child/message": () => ({ data: [], cursor: {} }),
      "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
      "GET /api/session/active": () => active ? { ses_child: { status: "running" } } : {},
    });
    const provider = server.provider();
    try {
      await expect(provider.reconcileBackgroundTasks("ses_parent")).rejects.toThrow("lookup failed");
      expect(await provider.reconcileBackgroundTasks("ses_parent")).toContainEqual(expect.objectContaining({ type: "background_task", status: "running", stateUncertain: false }));
      active = false;
      expect(await provider.reconcileBackgroundTasks("ses_parent")).toContainEqual(expect.objectContaining({ type: "background_task", status: "running", stateUncertain: true }));
      expect(server.requests("GET", "/api/session/active")).toHaveLength(3);
    } finally { await provider.dispose(); }
  });
  for (const path of ["/api/shell/sh_fixture", "/api/session/active", "/api/session/ses_child/message"]) {
    test(`partial first live inventory recovers after ${path} succeeds without another launcher frame`, async () => {
      const server = workerRecoveryServer(), provider = server.provider(), stream = observedNativeStream(provider);
      const failedType = path.includes("/shell/") ? "shell" : "agent";
      try {
        await stream.seen(event => event.eventType === "server.connected"); server.state.failure = path;
        const initial = await provider.reconcileBackgroundTasks("ses_parent", { fresh: true });
        expect(initial.find(task => task.taskType === failedType)).toMatchObject({ status: "running", stateUncertain: true });
        expect(initial.find(task => task.taskType !== failedType)).toMatchObject({ status: "running", stateUncertain: false });
        server.state.failure = "";
        for (let retry = 0; retry < 3; retry++) {
          const recovered = await provider.reconcileBackgroundTasks("ses_parent", { fresh: true });
          expect(recovered).toHaveLength(2);
          expect(recovered.every(task => task.status === "running" && task.stateUncertain === false)).toBe(true);
          expect(compactWorkers(recovered).every(worker => worker.state === "working")).toBe(true);
        }
        await provider.stopTask("ses_parent", failedType === "shell" ? "v2:ses_parent:call_shell" : "v2:ses_parent:call_worker");
        expect(server.calls.filter(call => call.method !== "GET").map(call => `${call.method} ${call.path}`)).toEqual([
          failedType === "shell" ? "DELETE /api/shell/sh_fixture" : "POST /api/session/ses_child/interrupt",
        ]);
      } finally { stream.lifetime.abort(); await stream.pump.catch(() => undefined); await provider.dispose(); }
    });
  }

  test("partial first live transcript history does not consume recovery's initial inventory", async () => {
    const server = workerRecoveryServer(), provider = server.provider(), stream = observedNativeStream(provider);
    try {
      await stream.seen(event => event.eventType === "server.connected"); server.state.failure = "/api/session/ses_child/message";
      const page = await provider.listMessages("ses_parent", { limit: 100 });
      expect(page.completeItems).toContainEqual(expect.objectContaining({ type: "background_task", taskType: "agent", stateUncertain: true }));
      server.state.failure = "";
      for (let retry = 0; retry < 3; retry++) expect((await provider.reconcileBackgroundTasks("ses_parent", { fresh: true })).every(task => task.stateUncertain === false)).toBe(true);
    } finally { stream.lifetime.abort(); await stream.pump.catch(() => undefined); await provider.dispose(); }
  });

  for (const removed of [true, false]) test(`failed first shell inventory cannot be replaced by transcript proof for a ${removed ? "removed" : "running"} target`, async () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    let failure = true, gone = false;
    const healthy = structuredClone(fixture.shell);
    healthy.id = "healthy_shell_message";
    healthy.content[0].id = "healthy_shell";
    healthy.content[0].state.metadata.shellID = "sh_healthy";
    const server = fakeOpenCode({
      "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"type":"server.connected","data":{}}\n\n'));
        emitNativeShellBirths(controller, ["sh_fixture", "sh_healthy"]);
      } }), { headers: { "content-type": "text/event-stream" } }),
      "GET /api/session/active": () => ({ ses_child: { status: "running" } }),
      "GET /api/session/:id": ({ path }) => session(path.split("/").at(-1)!, path.endsWith("ses_child") ? { parentID: "ses_parent" } : {}),
      "GET /api/session/ses_parent/message": () => ({ data: [fixture.launch, fixture.shell, healthy], cursor: {} }),
      "GET /api/session/ses_child/message": () => ({ data: [], cursor: {} }),
      "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
      "GET /api/shell/:id": ({ path }) => path.endsWith("sh_fixture") && failure ? new Response(null, { status: 500 })
        : path.endsWith("sh_fixture") && gone ? new Response(null, { status: 404 })
          : scoped(nativeShellInfo(path.split("/").at(-1)!)),
    });
    const provider = server.provider(), stream = observedNativeStream(provider);
    const controls = (provider as unknown as { controls: { current(taskId: string): boolean } }).controls;
    try {
      await stream.seen(event => event.eventType === "server.connected");
      expect(await provider.reconcileBackgroundTasks("ses_parent", { fresh: true })).toContainEqual(expect.objectContaining({ toolUseId: "call_shell", stateUncertain: true }));
      expect(controls.current("v2:ses_parent:call_shell")).toBe(false);
      failure = false; gone = removed;
      const reads = server.requests("GET", "/api/shell/sh_fixture").length;
      for (let retry = 0; retry < 2; retry++) {
        const page = await provider.listMessages("ses_parent", { limit: 100 });
        expect(page.completeItems).toContainEqual(expect.objectContaining({ toolUseId: "call_shell", status: "running", stateUncertain: true }));
        expect(controls.current("v2:ses_parent:call_shell")).toBe(false);
        for (const call of ["call_worker", "healthy_shell"]) {
          expect(page.completeItems).toContainEqual(expect.objectContaining({ toolUseId: call, status: "running", stateUncertain: false }));
          expect(controls.current(`v2:ses_parent:${call}`)).toBe(true);
        }
      }
      expect(server.requests("GET", "/api/shell/sh_fixture")).toHaveLength(reads);
      const recovered = await provider.reconcileBackgroundTasks("ses_parent", { fresh: true });
      expect(recovered.find(task => task.toolUseId === "call_shell")).toMatchObject({ status: "running", stateUncertain: removed });
      expect(controls.current("v2:ses_parent:call_shell")).toBe(!removed);
      expect(server.requests("GET", "/api/shell/sh_fixture")).toHaveLength(reads + 1);
      expect(server.calls.every(call => call.method === "GET")).toBe(true);
    } finally { stream.lifetime.abort(); await stream.pump.catch(() => undefined); await provider.dispose(); }
  });

  for (const target of ["removed", "running", "foreign"] as const) test(`sixteen held reads cannot let transcript proof replace rejected inventory for a ${target} shell`, async () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    const healthy = structuredClone(fixture.shell);
    healthy.id = "healthy_message"; healthy.content[0].id = "healthy_call"; healthy.content[0].state.metadata.shellID = "sh_healthy";
    let failure = true, held = 0, wire!: ReadableStreamDefaultController<Uint8Array>, entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const server = fakeOpenCode({
      "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) {
        wire = controller; controller.enqueue(new TextEncoder().encode('data: {"type":"server.connected","data":{}}\n\n'));
        emitNativeShellBirths(controller, ["sh_fixture", "sh_healthy"]);
      } }), { headers: { "content-type": "text/event-stream" } }),
      "GET /api/session/:id": ({ path }) => session(path.split("/").at(-1)!),
      "GET /api/session/ses_parent/message": () => ({ data: [fixture.shell, healthy], cursor: {} }),
      "GET /api/session/:id/message": async () => { if (++held === 16) entered(); await gate; return { data: [], cursor: {} }; },
      "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
      "GET /api/session/active": () => ({}),
      "GET /api/shell/:id": ({ path }) => path.endsWith("sh_fixture") && failure ? new Response(null, { status: 500 })
        : path.endsWith("sh_fixture") && target === "removed" ? new Response(null, { status: 404 })
          : scoped(nativeShellInfo(path.split("/").at(-1)!, path.endsWith("sh_fixture") && target === "foreign" ? "other_parent" : "ses_parent")),
    });
    const provider = server.provider(), stream = observedNativeStream(provider), blockers: ReturnType<typeof provider.listMessages>[] = [];
    const controls = (provider as unknown as { controls: { current(taskId: string): boolean; activeReads: number } }).controls;
    try {
      await stream.seen(event => event.eventType === "server.connected");
      // Seed only the healthy sibling through native live evidence, leaving
      // initial inventory open for the previously unobserved target.
      wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ id: "healthy_launch", created: 81, type: "session.message.content.updated",
        location: { directory: WORKSPACE }, data: { sessionID: "ses_parent", messageID: healthy.id, content: healthy.content } })}\n\n`));
      await stream.seen(event => event.updates.some(update => update.kind === "upsert" && update.item.type === "background_task" && update.item.toolUseId === "healthy_call"));
      expect(controls.current("v2:ses_parent:healthy_call")).toBe(true);
      for (let index = 0; index < 16; index++) blockers.push(provider.listMessages(`ses_block_${index}`, { limit: 1 }));
      await started; expect(controls.activeReads).toBe(16);
      expect(await provider.reconcileBackgroundTasks("ses_parent", { fresh: true })).toContainEqual(expect.objectContaining({ toolUseId: "call_shell", stateUncertain: true }));
      expect(controls.current("v2:ses_parent:call_shell")).toBe(false);
      expect(controls.current("v2:ses_parent:healthy_call")).toBe(true);
      release(); await Promise.all(blockers); failure = false;
      const reads = server.requests("GET", "/api/shell/sh_fixture").length;
      for (let retry = 0; retry < 2; retry++) {
        const page = await provider.listMessages("ses_parent", { limit: 100 });
        expect(page.completeItems).toContainEqual(expect.objectContaining({ toolUseId: "call_shell", status: "running", stateUncertain: true }));
        expect(page.completeItems).toContainEqual(expect.objectContaining({ toolUseId: "healthy_call", status: "running", stateUncertain: false }));
        expect(controls.current("v2:ses_parent:call_shell")).toBe(false);
        expect(controls.current("v2:ses_parent:healthy_call")).toBe(true);
      }
      expect(server.requests("GET", "/api/shell/sh_fixture")).toHaveLength(reads);
      const fresh = await provider.reconcileBackgroundTasks("ses_parent", { fresh: true });
      expect(fresh.find(task => task.toolUseId === "call_shell")).toMatchObject({ status: "running", stateUncertain: target !== "running" });
      expect(fresh.find(task => task.toolUseId === "healthy_call")).toMatchObject({ status: "running", stateUncertain: false });
      expect(controls.current("v2:ses_parent:call_shell")).toBe(target === "running");
      expect(server.requests("GET", "/api/shell/sh_fixture")).toHaveLength(reads + 1);
      expect(server.calls.every(call => call.method === "GET")).toBe(true);
    } finally { release(); await Promise.allSettled(blockers); stream.lifetime.abort(); await stream.pump.catch(() => undefined); await provider.dispose(); }
  });

  for (const target of ["removed", "running", "foreign"] as const) test(`older in-flight transcript respects a newer ${target} shell inventory`, async () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    const healthy = structuredClone(fixture.shell);
    healthy.id = "healthy_message"; healthy.content[0].id = "healthy_call"; healthy.content[0].state.metadata.shellID = "sh_healthy";
    let failure = true, held = 0, holdParent = true, wire!: ReadableStreamDefaultController<Uint8Array>;
    let entered!: () => void, release!: () => void, parentEntered!: () => void, releaseParent!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const parentStarted = new Promise<void>(resolve => { parentEntered = resolve; }), parentGate = new Promise<void>(resolve => { releaseParent = resolve; });
    const server = fakeOpenCode({
      "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) {
        wire = controller; controller.enqueue(new TextEncoder().encode('data: {"type":"server.connected","data":{}}\n\n'));
        emitNativeShellBirths(controller, ["sh_fixture", "sh_healthy"]);
      } }), { headers: { "content-type": "text/event-stream" } }),
      "GET /api/session/:id": ({ path }) => session(path.split("/").at(-1)!),
      "GET /api/session/ses_parent/message": async () => {
        if (holdParent) { holdParent = false; parentEntered(); await parentGate; }
        return { data: [fixture.shell, healthy], cursor: {} };
      },
      "GET /api/session/:id/message": async () => { if (++held === 15) entered(); await gate; return { data: [], cursor: {} }; },
      "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
      "GET /api/session/active": () => ({}),
      "GET /api/shell/:id": ({ path }) => path.endsWith("sh_fixture") && failure ? new Response(null, { status: 500 })
        : path.endsWith("sh_fixture") && target === "removed" ? new Response(null, { status: 404 })
          : scoped(nativeShellInfo(path.split("/").at(-1)!, path.endsWith("sh_fixture") && target === "foreign" ? "other_parent" : "ses_parent")),
    });
    const provider = server.provider(), stream = observedNativeStream(provider), blockers: ReturnType<typeof provider.listMessages>[] = [];
    const controls = (provider as unknown as { controls: { current(taskId: string): boolean; activeReads: number } }).controls;
    let older: ReturnType<typeof provider.listMessages> | undefined;
    try {
      await stream.seen(event => event.eventType === "server.connected");
      wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ id: "healthy_launch", created: 81, type: "session.message.content.updated",
        location: { directory: WORKSPACE }, data: { sessionID: "ses_parent", messageID: healthy.id, content: healthy.content } })}\n\n`));
      await stream.seen(event => event.updates.some(update => update.kind === "upsert" && update.item.type === "background_task" && update.item.toolUseId === "healthy_call"));
      older = provider.listMessages("ses_parent", { limit: 100 }); await parentStarted;
      for (let index = 0; index < 15; index++) blockers.push(provider.listMessages(`ses_block_${index}`, { limit: 1 }));
      await started; expect(controls.activeReads).toBe(16);
      expect(await provider.reconcileBackgroundTasks("ses_parent", { fresh: true })).toContainEqual(expect.objectContaining({ toolUseId: "call_shell", stateUncertain: true }));
      release(); await Promise.all(blockers); failure = false;
      // This inventory must not discharge outstanding verification merely
      // because the transport returned a shell owned by another parent.
      const fresh = await provider.reconcileBackgroundTasks("ses_parent", { fresh: true });
      expect(fresh.find(task => task.toolUseId === "call_shell")).toMatchObject({ status: "running", stateUncertain: target !== "running" });
      expect(fresh.find(task => task.toolUseId === "healthy_call")).toMatchObject({ status: "running", stateUncertain: false });
      const shellReads = server.requests("GET", "/api/shell/sh_fixture").length;
      releaseParent(); const page = await older;
      expect(page.completeItems).toContainEqual(expect.objectContaining({ toolUseId: "call_shell", status: "running", stateUncertain: target !== "running" }));
      expect(page.completeItems).toContainEqual(expect.objectContaining({ toolUseId: "healthy_call", status: "running", stateUncertain: false }));
      expect(controls.current("v2:ses_parent:call_shell")).toBe(target === "running");
      expect(controls.current("v2:ses_parent:healthy_call")).toBe(true);
      expect(server.requests("GET", "/api/shell/sh_fixture")).toHaveLength(shellReads);
      if (target !== "running") await expect(provider.stopTask("ses_parent", "v2:ses_parent:call_shell")).rejects.toThrow();
      expect(server.calls.every(call => call.method === "GET")).toBe(true);
    } finally {
      release(); releaseParent(); await Promise.allSettled([...blockers, ...(older ? [older] : [])]);
      stream.lifetime.abort(); await stream.pump.catch(() => undefined); await provider.dispose();
    }
  });

  for (const connected of [false, true]) for (const active of [false, true]) test(`older agent transcript requires positive active inventory: ${active ? "active" : "absent"}/${connected ? "connected" : "standalone"}`, async () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    const healthy = structuredClone(fixture.launch);
    healthy.id = "healthy_message"; healthy.content[0].id = "healthy_agent"; healthy.content[0].state.metadata.sessionID = "ses_healthy";
    let includeTarget = false, holdParent = false, failActive = true, targetActive = active, entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const server = fakeOpenCode({
      "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"type":"server.connected","data":{}}\n\n'));
      } }), { headers: { "content-type": "text/event-stream" } }),
      "GET /api/session/active": () => failActive ? new Response(null, { status: 500 })
        : { ses_healthy: { status: "running" }, ...(targetActive ? { ses_child: { status: "running" } } : {}) },
      "GET /api/session/:id": ({ path }) => session(path.split("/").at(-1)!, path.endsWith("ses_child") || path.endsWith("ses_healthy") ? { parentID: "ses_parent" } : {}),
      "GET /api/session/ses_parent/message": async () => {
        if (holdParent) { holdParent = false; entered(); await gate; }
        return { data: [...(includeTarget ? [fixture.launch] : []), healthy, fixture.shell], cursor: {} };
      },
      "GET /api/session/:id/message": () => ({ data: [], cursor: {} }),
      "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
      "GET /api/shell/sh_fixture": () => scoped({ id: "sh_fixture", command: "printf fixture", status: "running", time: { started: 71 }, metadata: { sessionID: "ses_parent" } }),
    });
    const provider = server.provider(), controls = (provider as unknown as { controls: { current(taskId: string): boolean } }).controls;
    let stream: ReturnType<typeof observedNativeStream> | undefined, older: ReturnType<typeof provider.listMessages> | undefined;
    // The standalone shell has no observed native birth. Its activity can be
    // current, but fresh inventory cannot manufacture its Stop identity.
    const healthyCalls = ["healthy_agent"];
    try {
      // Retain both healthy kinds without closing initial live inventory.
      await provider.listMessages("ses_parent", { limit: 100 });
      for (const call of healthyCalls) expect(controls.current(`v2:ses_parent:${call}`)).toBe(true);
      if (connected) { stream = observedNativeStream(provider); await stream.seen(event => event.eventType === "server.connected"); }
      includeTarget = holdParent = true;
      older = provider.listMessages("ses_parent", { limit: 100 }); await started;
      expect(await provider.reconcileBackgroundTasks("ses_parent", { fresh: true })).toContainEqual(expect.objectContaining({ toolUseId: "call_worker", stateUncertain: true }));
      failActive = false;
      const fresh = await provider.reconcileBackgroundTasks("ses_parent", { fresh: true });
      expect(fresh.find(task => task.toolUseId === "call_worker")).toMatchObject({ status: "running", stateUncertain: !active });
      for (const call of healthyCalls) expect(fresh.find(task => task.toolUseId === call)).toMatchObject({ status: "running", stateUncertain: false });
      const activeReads = server.requests("GET", "/api/session/active").length;
      release(); const page = await older;
      expect(page.completeItems).toContainEqual(expect.objectContaining({ toolUseId: "call_worker", status: "running", stateUncertain: !active }));
      expect(controls.current("v2:ses_parent:call_worker")).toBe(active);
      for (const call of healthyCalls) {
        expect(page.completeItems).toContainEqual(expect.objectContaining({ toolUseId: call, status: "running", stateUncertain: false }));
        expect(controls.current(`v2:ses_parent:${call}`)).toBe(true);
      }
      expect(server.requests("GET", "/api/session/active")).toHaveLength(activeReads);
      if (!active) await expect(provider.stopTask("ses_parent", "v2:ses_parent:call_worker")).rejects.toThrow();
      // Missing activity is not completion or revocation. Positive fresh
      // verification can still recover the unchanged target without a frame.
      targetActive = true;
      expect(await provider.reconcileBackgroundTasks("ses_parent", { fresh: true })).toContainEqual(expect.objectContaining({ toolUseId: "call_worker", status: "running", stateUncertain: false }));
      expect(controls.current("v2:ses_parent:call_worker")).toBe(true);
      expect(server.calls.every(call => call.method === "GET")).toBe(true);
    } finally { release(); await older?.catch(() => undefined); stream?.lifetime.abort(); await stream?.pump.catch(() => undefined); await provider.dispose(); }
  });

  for (const negative of ["foreign-directory", "failed-history", "malformed-idle"] as const) test(`filtered or inconclusive ${negative} child evidence cannot discharge outstanding inventory`, async () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    let holdParent = true, phase: "failed-active" | "negative" | "owned" = "failed-active", entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const server = fakeOpenCode({
      "GET /api/session/active": () => phase === "failed-active" ? new Response(null, { status: 500 }) : phase === "owned" ? { ses_child: { status: "running" } } : {},
      "GET /api/session/ses_parent": () => session("ses_parent"),
      "GET /api/session/ses_child": () => session("ses_child", { parentID: "ses_parent", location: { directory: phase === "negative" && negative === "foreign-directory" ? "/other" : WORKSPACE } }),
      "GET /api/session/ses_parent/message": async () => {
        if (holdParent) { holdParent = false; entered(); await gate; }
        return { data: [fixture.launch, fixture.shell], cursor: {} };
      },
      "GET /api/session/ses_child/message": () => phase === "negative" && negative === "failed-history" ? new Response(null, { status: 500 })
        : { data: phase === "negative" && negative === "malformed-idle" ? [{ id: "idle", type: "idle", time: {} }] : [], cursor: {} },
      "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
      "GET /api/shell/sh_fixture": () => scoped({ id: "sh_fixture", command: "printf fixture", status: "running", time: { started: 71 }, metadata: { sessionID: "ses_parent" } }),
    });
    const provider = server.provider(), controls = (provider as unknown as { controls: { current(taskId: string): boolean } }).controls;
    let older: ReturnType<typeof provider.listMessages> | undefined;
    try {
      older = provider.listMessages("ses_parent", { limit: 100 }); await started;
      expect(await provider.reconcileBackgroundTasks("ses_parent", { fresh: true })).toContainEqual(expect.objectContaining({ toolUseId: "call_worker", stateUncertain: true }));
      phase = "negative";
      const fresh = await provider.reconcileBackgroundTasks("ses_parent", { fresh: true });
      if (negative === "foreign-directory") expect(fresh.some(task => task.toolUseId === "call_worker")).toBe(false);
      else expect(fresh.find(task => task.toolUseId === "call_worker")).toMatchObject({ status: "running", stateUncertain: true });
      expect(fresh.find(task => task.toolUseId === "call_shell")).toMatchObject({ status: "running", stateUncertain: true });
      // Without a subscription, a session may move out of this directory and
      // back before the older caller verifies it. Parentage and IDs stay fixed;
      // recovered ownership/history alone cannot replace pending active proof.
      phase = "owned"; release(); const page = await older;
      expect(page.completeItems).toContainEqual(expect.objectContaining({ toolUseId: "call_worker", status: "running", stateUncertain: true }));
      expect(page.completeItems).toContainEqual(expect.objectContaining({ toolUseId: "call_shell", status: "running" }));
      expect(controls.current("v2:ses_parent:call_worker")).toBe(false);
      expect(await provider.reconcileBackgroundTasks("ses_parent", { fresh: true })).toContainEqual(expect.objectContaining({ toolUseId: "call_worker", status: "running", stateUncertain: false }));
      expect(controls.current("v2:ses_parent:call_worker")).toBe(true);
      expect(server.calls.every(call => call.method === "GET")).toBe(true);
    } finally { release(); await older?.catch(() => undefined); await provider.dispose(); }
  });

  for (const path of ["/api/shell/sh_fixture", "/api/session/active", "/api/session/ses_child/message"]) {
    test(`queued fresh mixed-worker recovery follows partial ${path} evidence`, async () => {
      const server = workerRecoveryServer(), provider = server.provider(), stream = observedNativeStream(provider), hold = server.holdNext(path);
      let first: ReturnType<typeof provider.reconcileBackgroundTasks> | undefined, next: typeof first;
      try {
        await stream.seen(event => event.eventType === "server.connected"); server.state.failure = path;
        first = provider.reconcileBackgroundTasks("ses_parent", { fresh: true }); await hold.started;
        server.state.failure = ""; next = provider.reconcileBackgroundTasks("ses_parent", { fresh: true }); hold.release();
        expect((await first).some(task => task.stateUncertain === true)).toBe(true);
        const recovered = await next;
        expect(recovered).toHaveLength(2); expect(recovered.every(task => task.stateUncertain === false)).toBe(true);
        expect(server.requests("GET", path)).toHaveLength(2);
        expect(server.calls.every(call => call.method === "GET")).toBe(true);
      } finally { hold.release(); await Promise.allSettled([first, next].filter(Boolean)); stream.lifetime.abort(); await stream.pump.catch(() => undefined); await provider.dispose(); }
    });
  }

  test("partial first live inventory stays retryable through public revert visibility filtering", async () => {
    const server = workerRecoveryServer(), provider = server.provider(), stream = observedNativeStream(provider);
    server.state.messages.push({ id: "reverted_prompt", type: "user", text: "Synthetic hidden turn", time: { created: 100 } });
    server.state.revert = "reverted_prompt";
    try {
      await stream.seen(event => event.eventType === "server.connected"); server.state.failure = "/api/session/ses_child/message";
      expect(await provider.reconcileBackgroundTasks("ses_parent", { fresh: true })).toContainEqual(expect.objectContaining({ taskType: "agent", stateUncertain: true }));
      server.state.failure = "";
      for (let retry = 0; retry < 3; retry++) {
        const recovered = await provider.reconcileBackgroundTasks("ses_parent", { fresh: true });
        expect(recovered).toHaveLength(2); expect(recovered.every(task => task.stateUncertain === false)).toBe(true);
      }
    } finally { stream.lifetime.abort(); await stream.pump.catch(() => undefined); await provider.dispose(); }
  });

  test("partial first inventory cannot authorize pre-gap workers after reconnect", async () => {
    const server = workerRecoveryServer(), provider = server.provider();
    let stream = observedNativeStream(provider);
    try {
      await stream.seen(event => event.eventType === "server.connected"); server.state.failure = "/api/shell/sh_fixture";
      expect(await provider.reconcileBackgroundTasks("ses_parent", { fresh: true })).toContainEqual(expect.objectContaining({ taskType: "shell", stateUncertain: true }));
      server.disconnect(); await stream.pump;
      server.state.failure = ""; stream = observedNativeStream(provider); await stream.seen(event => event.eventType === "server.connected");
      for (let retry = 0; retry < 3; retry++) {
        const recovered = await provider.reconcileBackgroundTasks("ses_parent", { fresh: true });
        expect(recovered).toHaveLength(2); expect(recovered.every(task => task.stateUncertain === true)).toBe(true);
      }
      for (const call of ["call_shell", "call_worker"]) await expect(provider.stopTask("ses_parent", `v2:ses_parent:${call}`)).rejects.toThrow(/no longer confirmed/);
      expect(server.calls.every(call => call.method === "GET")).toBe(true);
    } finally { stream.lifetime.abort(); await stream.pump.catch(() => undefined); await provider.dispose(); }
  });

  for (const kind of ["agent", "shell"] as const) test(`partial first inventory does not restore ${kind} controls after changed native ownership`, async () => {
    const server = workerRecoveryServer(), provider = server.provider(), stream = observedNativeStream(provider);
    try {
      await stream.seen(event => event.eventType === "server.connected"); server.state.failure = kind === "shell" ? "/api/shell/sh_fixture" : "/api/session/active";
      expect(await provider.reconcileBackgroundTasks("ses_parent", { fresh: true })).toContainEqual(expect.objectContaining({ taskType: kind, stateUncertain: true }));
      server.state.failure = "";
      if (kind === "agent") {
        server.state.childParent = "foreign_parent";
        server.frame("session.updated", { sessionID: "ses_child", parentID: "foreign_parent" });
        await stream.seen(event => event.eventType === "session.updated");
      } else server.state.shellParent = "foreign_parent";
      for (let retry = 0; retry < 3; retry++) {
        const recovered = await provider.reconcileBackgroundTasks("ses_parent", { fresh: true });
        if (kind === "agent") expect(recovered.some(task => task.taskType === "agent")).toBe(false);
        else expect(recovered.find(task => task.taskType === "shell")).toMatchObject({ status: "running", stateUncertain: true });
        expect(recovered.find(task => task.taskType !== kind)).toMatchObject({ status: "running", stateUncertain: false });
      }
      await expect(provider.stopTask("ses_parent", kind === "shell" ? "v2:ses_parent:call_shell" : "v2:ses_parent:call_worker")).rejects.toThrow();
      expect(server.calls.every(call => call.method === "GET")).toBe(true);
    } finally { stream.lifetime.abort(); await stream.pump.catch(() => undefined); await provider.dispose(); }
  });

  test("ownership reuse evicts at the incumbent worker entry limit and reconnect starts cold", async () => {
    const reference = (index: number) => ({ type: "tool", name: "subagent", id: `call${index}`, state: { status: "running", input: {}, metadata: { sessionID: `child${index}` } } });
    const frame = (content: unknown[]) => ({ type: "session.message.content.updated", location: { directory: WORKSPACE }, data: { sessionID: "ses_parent", messageID: "answer", content } });
    const frames: unknown[] = [{ type: "server.connected", data: {} }];
    for (let start = 0; start < 8_193; start += 128) frames.push(frame(Array.from({ length: Math.min(128, 8_193 - start) }, (_, offset) => reference(start + offset))));
    frames.push(frame([reference(0)]));
    let subscriptions = 0;
    const server = fakeOpenCode({
      "GET /api/event": () => new Response((subscriptions++ === 0 ? frames : [{ type: "server.connected", data: {} }, frame([reference(0)])]).map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } }),
      "GET /api/session/:id": ({ path }) => session(path.split("/").at(-1)!, { parentID: "ses_parent" }),
    });
    const provider = server.provider();
    try {
      for await (const _event of provider.events(new AbortController().signal)) { /* consume the actual SDK subscription */ }
      expect(server.requests("GET", "/api/session/child0")).toHaveLength(2);
      expect(server.calls.filter(call => call.path.startsWith("/api/session/"))).toHaveLength(8_194);
      for await (const _event of provider.events(new AbortController().signal)) { /* a new generation revalidates */ }
      expect(server.requests("GET", "/api/session/child0")).toHaveLength(3);
    } finally { await provider.dispose(); }
  }, 15_000);
  test("a failed stream child lookup preserves text and triggers read-only adapter worker recovery on the same subscription", async () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    let messages: unknown[] = [], pending: unknown[] = [];
    let childReads = 0;
    const frame = (type: string, data: unknown, created = 30) => stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type, data, created, location: { directory: WORKSPACE } })}\n\n`));
    const server = fakeOpenCode({
      "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; frame("server.connected", {}); } }), { headers: { "content-type": "text/event-stream" } }),
      "GET /api/session": () => ({ data: [session("ses_parent")], cursor: {} }),
      "GET /api/session/ses_parent": () => session("ses_parent"),
      "GET /api/session/ses_child": () => ++childReads === 1 ? new Response(null, { status: 500 }) : session("ses_child", { parentID: "ses_parent" }),
      "GET /api/session/ses_parent/message": () => ({ data: messages, cursor: {} }),
      "GET /api/session/ses_child/message": () => ({ data: [], cursor: {} }),
      "GET /api/session/ses_parent/inbox": () => ({ data: pending }),
      "GET /api/session/active": () => ({ ses_child: { status: "running" } }),
      "GET /api/permission/request": () => scoped([]),
      "GET /api/form": () => scoped([]),
    });
    const adapter = new ChatAdapter({ provider: server.provider(), workspacePath: WORKSPACE, generation: "child-lookup", coalesceWindowMs: 0 });
    const pump = adapter.startEventPump();
    const items = () => adapter.projectionForTests("ses_parent").items();
    const until = async (predicate: () => boolean) => {
      const deadline = Date.now() + 4_000;
      while (!predicate() && Date.now() < deadline) await Bun.sleep(5);
      expect(predicate()).toBe(true);
    };
    try {
      await until(() => server.requests("GET", "/api/session/ses_parent/message").length > 0);
      messages = [fixture.launch];
      frame("session.message.content.updated", { sessionID: "ses_parent", messageID: fixture.launch.id, content: [{ type: "text", text: "Not lost" }, ...fixture.launch.content] });
      await until(() => items().some(item => item.type === "background_task" && item.status === "running" && item.stateUncertain === false));
      expect(items()).toContainEqual(expect.objectContaining({ type: "assistant_message", markdown: "Not lost" }));
      pending = [fixture.pending];
      frame("session.inbox.enqueued", { sessionID: "ses_parent", inboxID: fixture.pending.id, item: fixture.pending }, 41);
      await until(() => items().some(item => item.type === "background_task" && item.status === "completed"));
      expect(childReads).toBe(2);
      expect(server.requests("GET", "/api/event")).toHaveLength(1);
      expect(server.calls.every(call => call.method === "GET")).toBe(true);
    } finally { await adapter.dispose(); await pump; }
  }, 10_000);
  for (const active of [false, true]) test(`lost relevant control observation stays unavailable across later Stops and public recovery (${active ? "active Stop" : "before Stop"})`, async () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    const healthy = structuredClone(fixture.launch);
    healthy.id = "healthy_message"; healthy.content[0].id = "healthy_call"; healthy.content[0].state.metadata.sessionID = "healthy_child";
    let wire!: ReadableStreamDefaultController<Uint8Array>, acknowledge: (() => void) | undefined, armed = false, used = false, entered!: () => void, release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
    let sequence = 0;
    const frame = (type: string, data: unknown) => wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ id: `gap${++sequence}`, type, data, created: 40, durable: { aggregateID: "ses_parent", seq: sequence, version: 1 }, location: { directory: WORKSPACE } })}\n\n`));
    const server = fakeOpenCode({
      "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) { wire = controller; frame("server.connected", {}); } }), { headers: { "content-type": "text/event-stream" } }),
      "GET /api/session/ses_parent": async () => { if (armed && !used) { used = true; entered(); await gate; } return session("ses_parent"); },
      "GET /api/session/ses_parent/message": () => ({ data: [fixture.launch, healthy], cursor: {} }),
      "GET /api/session/:id/message": () => ({ data: [], cursor: {} }),
      "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
      "GET /api/session/active": () => ({ ses_child: { type: "running" }, healthy_child: { type: "running" } }),
      "GET /api/session/:id": ({ path }) => session(path.split("/").at(-1)!, { parentID: "ses_parent" }),
      "POST /api/session/:id/interrupt": () => ({ interrupted: true }),
    });
    const provider = server.provider();
    let controller = new AbortController();
    const rows = new Map<string, import("../../types").BackgroundTaskItem>();
    const consume = () => (async () => { for await (const event of provider.events(controller.signal)) {
      for (const update of event.updates) if (update.kind === "upsert" && update.item.type === "background_task") rows.set(update.item.taskId, update.item);
      if (event.eventType !== "server.connected") { acknowledge?.(); acknowledge = undefined; }
    } })();
    let pump = consume(), first: Promise<unknown> | undefined;
    const send = (type: string, data: unknown) => new Promise<void>(resolve => { acknowledge = resolve; frame(type, data); });
    try {
      await provider.waitForEventStream(controller.signal);
      await send("session.message.content.updated", { sessionID: "ses_parent", messageID: fixture.launch.id, content: fixture.launch.content });
      await send("session.message.content.updated", { sessionID: "ses_parent", messageID: healthy.id, content: healthy.content });
      if (active) { armed = true; first = provider.stopTask("ses_parent", "v2:ses_parent:call_worker").catch(error => error); await started; }
      for (let index = 0; index < 2_049; index++) await send("session.tool.called", { sessionID: "ses_parent", id: `unknown${index}`, input: {} });
      await send("session.tool.input.started", { sessionID: "ses_parent", id: "new_relevant_call", name: "subagent" });
      await send("session.tool.called", { sessionID: "ses_parent", id: "new_relevant_call", assistantMessageID: "new_message", executed: true, input: { sessionID: "ses_child", prompt: "Different invocation" } });
      release();
      if (first) expect(await first).toMatchObject({ name: "BackgroundTaskUnavailableError" });
      else await expect(provider.stopTask("ses_parent", "v2:ses_parent:call_worker")).rejects.toMatchObject({ name: "BackgroundTaskUnavailableError" });
      await send("session.message.content.updated", { sessionID: "ses_parent", messageID: fixture.launch.id, content: fixture.launch.content });
      expect(rows.get("v2:ses_parent:call_worker")).toMatchObject({ status: "running", stateUncertain: true });
      expect((await provider.listMessages("ses_parent", { limit: 100 })).items).toContainEqual(expect.objectContaining({ taskId: "v2:ses_parent:call_worker", status: "running", stateUncertain: true }));
      expect(await provider.reconcileBackgroundTasks("ses_parent", { fresh: true })).toContainEqual(expect.objectContaining({ taskId: "v2:ses_parent:call_worker", status: "running", stateUncertain: true }));
      await expect(provider.stopTask("ses_parent", "v2:ses_parent:call_worker")).rejects.toMatchObject({ name: "BackgroundTaskUnavailableError" });
      expect(server.requests("POST", "/api/session/ses_child/interrupt")).toHaveLength(0);
      await provider.stopTask("ses_parent", "v2:ses_parent:healthy_call");
      expect(server.requests("POST", "/api/session/healthy_child/interrupt")).toHaveLength(1);
      expect(server.requests("GET", "/api/event")).toHaveLength(1);
      controller.abort(); await pump; controller = new AbortController(); pump = consume();
      await provider.waitForEventStream(controller.signal);
      await send("session.message.content.updated", { sessionID: "ses_parent", messageID: fixture.converted.id, content: fixture.converted.content });
      await expect(provider.stopTask("ses_parent", "v2:ses_parent:call_worker")).rejects.toMatchObject({ name: "BackgroundTaskUnavailableError" });
      expect(server.calls.filter(call => call.method === "POST")).toHaveLength(1);
    } finally { release(); controller.abort(); await first; await pump; await provider.dispose(); }
  });

  for (const kind of ["agent", "shell"] as const) for (const warm of [false, true]) for (const alias of [false, true]) {
    const phases = kind === "agent" ? ["parent", "parent-history", "inbox", "active", "ownership", "child-history", "final-ownership"] : ["parent", "parent-history", "inbox", "active", "shell-ownership"];
    for (const phase of [...(warm ? ["before-stop"] : []), ...phases]) for (const change of ["kind", "message", "typed-message", "progress", "replay", "new-id-old-clock"] as const) test(`Stop binds immutable native identity: ${kind}/${warm ? "warm" : "cold"}/${alias ? "alias" : "direct"}/${phase}/${change}`, async () => {
      const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
      const original = structuredClone(fixture.launch), converted = structuredClone(fixture.converted);
      const setKind = (part: { name: string; state: { metadata: Record<string, unknown> } }, workerKind: "agent" | "shell") => { part.name = workerKind === "agent" ? "subagent" : "shell"; part.state.metadata = { [workerKind === "agent" ? "sessionID" : "shellID"]: "ses_child", status: "running" }; };
      if (kind === "shell") { setKind(original.content[0], kind); setKind(converted.content[0], kind); }
      if (kind === "shell") for (const message of [original, converted]) message.content[0].state.input.command = "printf fixture";
      let history = alias ? [original, converted] : [original];
      const selected = alias ? converted : original;
      let wire!: ReadableStreamDefaultController<Uint8Array>, acknowledge: (() => void) | undefined, armed = false, used = false, entered!: () => void, release!: () => void, lookups = 0;
      const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
      const waitAt = async (point: string) => { if (armed && !used && phase === point) { used = true; entered(); await gate; } };
      let sequence = 0;
      const raw = (type: string, data: unknown, created = 60) => ({ id: `identity${++sequence}`, type, data, created, durable: { aggregateID: "ses_parent", seq: sequence, version: 1 }, location: { directory: WORKSPACE } });
      const frame = (event: unknown) => wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
      const server = fakeOpenCode({
        "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) { wire = controller; frame(raw("server.connected", {})); } }), { headers: { "content-type": "text/event-stream" } }),
        "GET /api/session/ses_parent": async () => { await waitAt("parent"); return session("ses_parent"); },
        "GET /api/session/ses_parent/message": async () => { await waitAt("parent-history"); return { data: history, cursor: {} }; },
        "GET /api/session/ses_parent/inbox": async () => { await waitAt("inbox"); return { data: [] }; },
        "GET /api/session/active": async () => { await waitAt("active"); return { ses_child: { type: "running" } }; },
        "GET /api/session/ses_child/message": async () => { await waitAt("child-history"); return { data: [], cursor: {} }; },
        "GET /api/session/ses_child": async () => { if (armed) { lookups++; if (phase === "ownership") await waitAt("ownership"); else if (lookups === (warm ? 1 : 2)) await waitAt("final-ownership"); } return session("ses_child", { parentID: "ses_parent" }); },
        "GET /api/shell/ses_child": async () => { await waitAt("shell-ownership"); return scoped(nativeShellInfo("ses_child")); },
        "POST /api/session/ses_child/interrupt": () => ({ interrupted: true }),
        "DELETE /api/shell/ses_child": () => undefined,
      });
      const provider = server.provider(), controller = new AbortController();
      const published: import("../../types").BackgroundTaskItem[] = [];
      const pump = (async () => { for await (const event of provider.events(controller.signal)) {
        for (const update of event.updates) if (update.kind === "upsert" && update.item.type === "background_task") published.push(update.item);
        if (event.eventType !== "server.connected") { acknowledge?.(); acknowledge = undefined; }
      } })();
      const sendRaw = (event: unknown) => new Promise<void>(resolve => { acknowledge = resolve; frame(event); });
      const send = (type: string, data: unknown, created?: number) => sendRaw(raw(type, data, created));
      let stop: Promise<unknown> | undefined;
      try {
        await provider.waitForEventStream(controller.signal);
        if (kind === "shell") await sendRaw({ id: "shell-birth", created: 71, type: "shell.created", location: { directory: WORKSPACE }, data: { info: nativeShellInfo("ses_child") } });
        await send("session.tool.input.started", { sessionID: "ses_parent", id: selected.content[0].id, name: kind === "agent" ? "subagent" : "shell", assistantMessageID: selected.id });
        if (warm) {
          await send("session.message.content.updated", { sessionID: "ses_parent", messageID: original.id, content: original.content });
          if (alias) await send("session.message.content.updated", { sessionID: "ses_parent", messageID: converted.id, content: converted.content });
        }
        if (phase === "ownership") await send("session.moved", { sessionID: "unrelated" });
        if (phase !== "before-stop") { armed = true; stop = provider.stopTask("ses_parent", "v2:ses_parent:call_worker").catch(error => error); await started; }
        const changed = structuredClone(selected);
        if (change === "kind") setKind(changed.content[0], kind === "agent" ? "shell" : "agent");
        if (change === "message" || change === "typed-message") changed.id = "different_native_owner";
        if (change === "typed-message" || change === "progress") await send("session.tool.progress", { sessionID: "ses_parent", id: changed.content[0].id, assistantMessageID: changed.id, metadata: changed.content[0].state.metadata });
        else if (change === "new-id-old-clock") await send("session.tool.called", { sessionID: "ses_parent", id: selected.content[0].id, assistantMessageID: selected.id, executed: true, input: selected.content[0].state.input }, 1);
        else {
          const event = raw("session.message.content.updated", { sessionID: "ses_parent", messageID: changed.id, content: changed.content });
          await sendRaw(event);
          if (change === "replay") await sendRaw(structuredClone(event));
        }
        if (phase === "before-stop" && (change === "kind" || change === "message")) history = alias ? [original, changed] : [changed];
        release();
        stop ??= provider.stopTask("ses_parent", "v2:ses_parent:call_worker").catch(error => error);
        const result = await stop, allowed = change === "progress" || change === "replay";
        expect(server.requests("POST", "/api/session/ses_child/interrupt")).toHaveLength(allowed && kind === "agent" ? 1 : 0);
        expect(server.requests("DELETE", "/api/shell/ses_child")).toHaveLength(allowed && kind === "shell" ? 1 : 0);
        if (allowed) expect(result).toBeUndefined();
        else {
          expect(result).toMatchObject({ name: "BackgroundTaskUnavailableError" });
          // Exercise a live restatement after recovery has bound the cold
          // occurrence. A cold alias can publish under its own canonical id.
          await send("session.message.content.updated", { sessionID: "ses_parent", messageID: original.id, content: original.content });
          expect(published.filter(item => item.taskId === "v2:ses_parent:call_worker" || item.toolUseId === "call_worker" || item.toolUseIds?.includes("call_worker")).at(-1)).toMatchObject({ stateUncertain: true });
          expect((await provider.listMessages("ses_parent", { limit: 100 })).items).toContainEqual(expect.objectContaining({ taskId: "v2:ses_parent:call_worker", stateUncertain: true }));
          expect(await provider.reconcileBackgroundTasks("ses_parent", { fresh: true })).toContainEqual(expect.objectContaining({ taskId: "v2:ses_parent:call_worker", stateUncertain: true }));
          await expect(provider.stopTask("ses_parent", "v2:ses_parent:call_worker")).rejects.toMatchObject({ name: "BackgroundTaskUnavailableError" });
        }
      } finally { release(); controller.abort(); await stop; await pump; await provider.dispose(); }
    });
  }

  test("cold alias with a missing native owner cannot weaken a subsequently confirmed owner", async () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    let history = [fixture.launch], wire!: ReadableStreamDefaultController<Uint8Array>, acknowledge: (() => void) | undefined, sequence = 0;
    const frame = (type: string, data: unknown) => wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ id: `partial${++sequence}`, type, data, created: 60,
      durable: { aggregateID: "ses_parent", seq: sequence, version: type === "session.tool.success" ? 2 : 1 }, location: { directory: WORKSPACE } })}\n\n`));
    const server = fakeOpenCode({
      "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) { wire = controller; frame("server.connected", {}); } }), { headers: { "content-type": "text/event-stream" } }),
      "GET /api/session/ses_parent/message": () => ({ data: history, cursor: {} }),
      "GET /api/session/ses_child/message": () => ({ data: [], cursor: {} }),
      "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
      "GET /api/session/active": () => ({ ses_child: { type: "running" } }),
      "GET /api/session/:id": ({ path }) => session(path.split("/").at(-1)!, { parentID: "ses_parent" }),
      "POST /api/session/ses_child/interrupt": () => ({ interrupted: true }),
    });
    const provider = server.provider(), controller = new AbortController();
    const pump = (async () => { for await (const event of provider.events(controller.signal)) if (event.eventType !== "server.connected") { acknowledge?.(); acknowledge = undefined; } })();
    const send = (type: string, data: unknown) => new Promise<void>(resolve => { acknowledge = resolve; frame(type, data); });
    try {
      await provider.waitForEventStream(controller.signal);
      expect(await provider.reconcileBackgroundTasks("ses_parent", { fresh: true })).toContainEqual(expect.objectContaining({ taskId: "v2:ses_parent:call_worker", stateUncertain: false }));
      await send("session.tool.input.started", { sessionID: "ses_parent", id: fixture.converted.content[0].id, name: "subagent" });
      await send("session.tool.success", { sessionID: "ses_parent", id: fixture.converted.content[0].id, executed: true, input: fixture.converted.content[0].state.input, metadata: fixture.converted.content[0].state.metadata });
      await send("session.message.content.updated", { sessionID: "ses_parent", messageID: fixture.launch.id, content: fixture.launch.content });
      history = [fixture.launch, fixture.converted];
      expect(await provider.reconcileBackgroundTasks("ses_parent", { fresh: true })).toContainEqual(expect.objectContaining({ taskId: "v2:ses_parent:call_worker", stateUncertain: false }));
      const replacement = structuredClone(fixture.converted); replacement.id = "different_confirmed_owner";
      history = [fixture.launch, replacement];
      await expect(provider.stopTask("ses_parent", "v2:ses_parent:call_worker")).rejects.toMatchObject({ name: "BackgroundTaskUnavailableError" });
      expect(server.requests("POST", "/api/session/ses_child/interrupt")).toHaveLength(0);
      expect((await provider.listMessages("ses_parent", { limit: 100 })).items).toContainEqual(expect.objectContaining({ taskId: "v2:ses_parent:call_worker", stateUncertain: true }));
      expect(server.requests("GET", "/api/event")).toHaveLength(1);
    } finally { controller.abort(); await pump; await provider.dispose(); }
  });

  test("control-cohort growth revokes only its target and keeps another parent's shell stoppable", async () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    let wire!: ReadableStreamDefaultController<Uint8Array>, acknowledge: (() => void) | undefined;
    const frame = (type: string, data: unknown) => wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type, data, created: 60, location: { directory: WORKSPACE } })}\n\n`));
    const rows = new Map<string, import("../../types").BackgroundTaskItem>();
    const server = fakeOpenCode({
      "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) { wire = controller; frame("server.connected", {}); } }), { headers: { "content-type": "text/event-stream" } }),
      "GET /api/session/ses_parent/message": () => ({ data: [fixture.launch], cursor: {} }),
      "GET /api/session/other/message": () => ({ data: [fixture.shell], cursor: {} }),
      "GET /api/session/ses_child/message": () => ({ data: [], cursor: {} }),
      "GET /api/session/:id/inbox": () => ({ data: [] }),
      "GET /api/session/active": () => ({ ses_child: { type: "running" } }),
      "GET /api/session/:id": ({ path }) => session(path.split("/").at(-1)!, { parentID: "ses_parent" }),
      "GET /api/shell/sh_fixture": () => scoped(nativeShellInfo("sh_fixture", "other")),
      "DELETE /api/shell/sh_fixture": () => undefined,
      "POST /api/session/ses_child/interrupt": () => ({ interrupted: true }),
    });
    const provider = server.provider(), controller = new AbortController();
    const pump = (async () => { for await (const event of provider.events(controller.signal)) {
      for (const update of event.updates) if (update.kind === "upsert" && update.item.type === "background_task") rows.set(update.item.taskId, update.item);
      if (event.eventType === "session.message.content.updated") { acknowledge?.(); acknowledge = undefined; }
    } })();
    const send = (parent: string, content: unknown[]) => new Promise<void>(resolve => { acknowledge = resolve; frame("session.message.content.updated", { sessionID: parent, messageID: parent === "other" ? fixture.shell.id : fixture.launch.id, content }); });
    try {
      await provider.waitForEventStream(controller.signal);
      await send("ses_parent", fixture.launch.content);
      emitNativeShellBirths(wire, ["sh_fixture"], "other");
      await send("other", fixture.shell.content);
      expect(rows.get("v2:ses_parent:call_worker")?.stateUncertain).toBe(false);
      expect(rows.get("v2:other:call_shell")?.stateUncertain).toBe(false);
      await send("ses_parent", Array.from({ length: 1_100 }, (_, index) => ({ ...structuredClone(fixture.launch.content[0]), id: `alias${index}` })));
      expect(rows.get("v2:ses_parent:call_worker")?.stateUncertain).toBe(true);
      expect((await provider.listMessages("ses_parent", { limit: 100 })).items).toContainEqual(expect.objectContaining({ taskId: "v2:ses_parent:call_worker", stateUncertain: true }));
      expect(await provider.reconcileBackgroundTasks("ses_parent", { fresh: true })).toContainEqual(expect.objectContaining({ taskId: "v2:ses_parent:call_worker", stateUncertain: true }));
      await expect(provider.stopTask("ses_parent", "v2:ses_parent:call_worker")).rejects.toMatchObject({ name: "BackgroundTaskUnavailableError" });
      await send("ses_parent", fixture.launch.content);
      expect(rows.get("v2:ses_parent:call_worker")?.stateUncertain).toBe(true);
      await provider.stopTask("other", "v2:other:call_shell");
      expect(server.requests("DELETE", "/api/shell/sh_fixture")).toHaveLength(1);
      expect(server.requests("POST", "/api/session/ses_child/interrupt")).toHaveLength(0);
      expect(server.requests("GET", "/api/event")).toHaveLength(1);
    } finally { controller.abort(); await pump; await provider.dispose(); }
  });

  test("provider-lifetime revocations survive stream replacement and ordinary history or progress", async () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    let wire!: ReadableStreamDefaultController<Uint8Array>, acknowledge: (() => void) | undefined;
    const frame = (content: unknown[]) => wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "session.message.content.updated", data: { sessionID: "ses_parent", messageID: fixture.launch.id, content }, created: 60, location: { directory: WORKSPACE } })}\n\n`));
    const server = fakeOpenCode({
      "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) { wire = controller; wire.enqueue(new TextEncoder().encode('data: {"type":"server.connected","data":{}}\n\n')); } }), { headers: { "content-type": "text/event-stream" } }),
      "GET /api/session/ses_parent/message": () => ({ data: [fixture.launch], cursor: {} }),
      "GET /api/session/ses_child/message": () => ({ data: [], cursor: {} }),
      "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
      "GET /api/session/active": () => ({ ses_child: { type: "running" } }),
      "GET /api/session/:id": ({ path }) => session(path.split("/").at(-1)!, { parentID: "ses_parent" }),
      "POST /api/session/ses_child/interrupt": () => ({ interrupted: true }),
    });
    const provider = server.provider();
    let controller = new AbortController();
    const rows: import("../../types").BackgroundTaskItem[] = [];
    const consume = () => (async () => { for await (const event of provider.events(controller.signal)) {
      for (const update of event.updates) if (update.kind === "upsert" && update.item.type === "background_task") rows.push(update.item);
      if (event.eventType === "session.message.content.updated") { acknowledge?.(); acknowledge = undefined; }
    } })();
    let pump = consume();
    const send = (content: unknown[]) => new Promise<void>(resolve => { acknowledge = resolve; frame(content); });
    try {
      await provider.waitForEventStream(controller.signal);
      await send(fixture.launch.content);
      const changed = structuredClone(fixture.launch.content[0]); changed.time.ran = 90;
      await send([changed]);
      expect(rows.at(-1)?.stateUncertain).toBe(true);
      controller.abort(); await pump;
      controller = new AbortController(); pump = consume();
      await provider.waitForEventStream(controller.signal);
      await send(fixture.launch.content);
      expect(rows.at(-1)?.stateUncertain).toBe(true);
      expect(await provider.reconcileBackgroundTasks("ses_parent", { fresh: true })).toContainEqual(expect.objectContaining({ taskId: "v2:ses_parent:call_worker", stateUncertain: true }));
      expect((await provider.listMessages("ses_parent", { limit: 100 })).items).toContainEqual(expect.objectContaining({ taskId: "v2:ses_parent:call_worker", stateUncertain: true }));
      await expect(provider.stopTask("ses_parent", "v2:ses_parent:call_worker")).rejects.toMatchObject({ name: "BackgroundTaskUnavailableError" });
      expect(server.requests("GET", "/api/event")).toHaveLength(2);
      expect(server.calls.filter(call => call.method === "POST")).toHaveLength(0);
    } finally { controller.abort(); await pump; await provider.dispose(); }
    expect((provider as unknown as { controls: { usage: { entries: number } } }).controls.usage.entries).toBe(0);
  });

  for (const alias of [false, true]) for (const change of ["foreign", "wrong-id", "foreign-workspace", "missing-workspace", "healthy"] as const) test(`stream contradiction reaches retained controls without an aggregate worker or active Stop (${change}/alias=${alias})`, async () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    let history = alias ? [fixture.launch, fixture.converted] : [fixture.launch];
    let changed = false, wire!: ReadableStreamDefaultController<Uint8Array>, acknowledge: (() => void) | undefined;
    const frame = (type: string, data: unknown) => wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type, data, created: 60, location: { directory: WORKSPACE } })}\n\n`));
    const server = fakeOpenCode({
      "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) { wire = controller; frame("server.connected", {}); } }), { headers: { "content-type": "text/event-stream" } }),
      "GET /api/session/active": () => ({ ses_child: { type: "running" } }),
      "GET /api/session/ses_child": () => session(changed && change === "wrong-id" ? "wrong_child" : "ses_child", { parentID: changed && change === "foreign" ? "foreign_parent" : "ses_parent",
        ...(changed && change === "foreign-workspace" ? { location: { directory: "/foreign" } } : changed && change === "missing-workspace" ? { location: {} } : {}) }),
      "GET /api/session/ses_parent": () => session("ses_parent"),
      "GET /api/session/ses_parent/message": () => ({ data: history, cursor: {} }),
      "GET /api/session/ses_child/message": () => ({ data: [], cursor: {} }),
      "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
      "POST /api/session/ses_child/interrupt": () => ({ interrupted: true }),
    });
    const provider = server.provider(), lifetime = new AbortController();
    const pump = (async () => { for await (const event of provider.events(lifetime.signal)) if (["server.heartbeat", "session.message.content.updated", "session.moved"].includes(event.eventType ?? "")) { acknowledge?.(); acknowledge = undefined; } })();
    const send = (type: string, data: unknown) => new Promise<void>(resolve => { acknowledge = resolve; frame(type, data); });
    const taskId = "v2:ses_parent:call_worker";
    const contradiction = ["foreign", "wrong-id", "foreign-workspace"].includes(change);
    const state = provider as unknown as { controls: { basis(id: string): unknown }; stopValidations: Set<unknown>;
      eventMemory: { workers: { controlEvidenceAvailable: boolean; childTasks(child: string): unknown[]; occurrence(id: string): unknown } } };
    try {
      await provider.waitForEventStream(lifetime.signal);
      await send("session.message.content.updated", { sessionID: "ses_parent", messageID: fixture.launch.id, content: fixture.launch.content });
      if (alias) await send("session.message.content.updated", { sessionID: "ses_parent", messageID: fixture.converted.id, content: fixture.converted.content });
      expect((await provider.reconcileBackgroundTasks("ses_parent", { fresh: true })).find(task => task.taskId === taskId)?.control?.available).toBe(true);
      for (let index = 0; index < 2_200; index++) frame("session.created", { sessionID: `filler${index}`.padEnd(500, "x"), parentID: "p".repeat(500) });
      await send("server.heartbeat", {});
      expect(state.eventMemory.workers.controlEvidenceAvailable).toBe(false);
      expect(state.eventMemory.workers.childTasks("ses_child")).toEqual([]);
      expect(state.eventMemory.workers.occurrence(taskId)).toBeUndefined();
      expect(state.controls.basis(taskId)).toBeDefined();
      expect(state.stopValidations.size).toBe(0);
      await send("session.moved", { sessionID: "unrelated" });
      changed = true;
      const selected = alias ? fixture.converted : fixture.launch;
      await send("session.message.content.updated", { sessionID: "ses_parent", messageID: selected.id, content: selected.content });
      expect(state.stopValidations.size).toBe(0);
      changed = false;
      if (alias && contradiction) history = [fixture.converted];
      const recoveredId = alias && contradiction ? "v2:ses_parent:call_converted" : taskId;
      const recovered = await provider.reconcileBackgroundTasks("ses_parent", { fresh: true });
      const result = await provider.stopTask("ses_parent", recoveredId).catch(error => error);
      expect(server.requests("POST", "/api/session/ses_child/interrupt")).toHaveLength(contradiction ? 0 : 1);
      expect(recovered.find(task => task.taskId === recoveredId)?.control?.available).toBe(!contradiction);
      if (!contradiction) expect(result).toBeUndefined();
      else expect(result).toMatchObject({ name: "BackgroundTaskUnavailableError" });
    } finally { lifetime.abort(); await pump; await provider.dispose(); }
  });
  for (const relevant of [false, true]) test(`projection saturation during retained Stop preserves per-target fences (${relevant ? "relevant negative" : "unrelated capacity"})`, async () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    let wire!: ReadableStreamDefaultController<Uint8Array>, acknowledge: (() => void) | undefined, entered!: () => void, release!: () => void, armed = false;
    const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
    const frame = (type: string, data: unknown) => wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type, data, created: 60, location: { directory: WORKSPACE } })}\n\n`));
    const server = fakeOpenCode({
      "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) { wire = controller; frame("server.connected", {}); } }), { headers: { "content-type": "text/event-stream" } }),
      "GET /api/session/ses_parent": async () => { if (armed) { entered(); await gate; } return session("ses_parent"); },
      "GET /api/session/ses_parent/message": () => ({ data: [fixture.launch], cursor: {} }),
      "GET /api/session/ses_child/message": () => ({ data: [], cursor: {} }),
      "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
      "GET /api/session/active": () => ({ ses_child: { type: "running" } }),
      "GET /api/session/:id": ({ path }) => session(path.split("/").at(-1)!, { parentID: "ses_parent" }),
      "POST /api/session/ses_child/interrupt": () => ({ interrupted: true }),
    });
    const provider = server.provider(), controller = new AbortController();
    const updates: import("../../types").BackgroundTaskItem[] = [];
    const pump = (async () => { for await (const event of provider.events(controller.signal)) {
      for (const update of event.updates) if (update.kind === "upsert" && update.item.type === "background_task") updates.push(update.item);
      if (event.eventType === "session.message.content.updated" || event.eventType === "server.heartbeat" || event.eventType === "session.tool.progress") { acknowledge?.(); acknowledge = undefined; }
    } })();
    const send = (type: string, data: unknown) => new Promise<void>(resolve => { acknowledge = resolve; frame(type, data); });
    let stop: Promise<unknown> | undefined;
    try {
      await provider.waitForEventStream(controller.signal);
      await send("session.message.content.updated", { sessionID: "ses_parent", messageID: fixture.launch.id, content: fixture.launch.content });
      armed = true;
      stop = provider.stopTask("ses_parent", "v2:ses_parent:call_worker").catch(error => error);
      await started;
      for (let index = 0; index < 2_200; index++) frame("session.created", { sessionID: `filler${index}`.padEnd(500, "x"), parentID: "p".repeat(500) });
      await send("server.heartbeat", {});
      expect((provider as unknown as { eventMemory: { workers: { controlEvidenceAvailable: boolean } } }).eventMemory.workers.controlEvidenceAvailable).toBe(false);
      if (relevant) await send("session.tool.progress", { sessionID: "ses_parent", assistantMessageID: fixture.launch.id, id: "call_worker", metadata: { sessionID: "replacement", status: "running" } });
      release();
      const result = await stop;
      if (!relevant) expect(result).toBeUndefined();
      expect(server.requests("POST", "/api/session/ses_child/interrupt")).toHaveLength(relevant ? 0 : 1);
      if (relevant) {
        expect(result).toMatchObject({ name: "BackgroundTaskUnavailableError" });
        expect(updates.at(-1)).toMatchObject({ taskId: "v2:ses_parent:call_worker", stateUncertain: true });
        expect(await provider.reconcileBackgroundTasks("ses_parent", { fresh: true })).toContainEqual(expect.objectContaining({ taskId: "v2:ses_parent:call_worker", stateUncertain: true }));
      } else expect(result).toBeUndefined();
      expect(server.requests("GET", "/api/event")).toHaveLength(1);
    } finally { release(); controller.abort(); await stop; await pump; await provider.dispose(); }
  });

  test("a saturated native stream keeps discovering and completing later workers through adapter recovery without reconnecting", async () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    const encoder = new TextEncoder();
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const retainedLaunch = structuredClone(fixture.launch);
    retainedLaunch.id = "retained_message";
    retainedLaunch.content[0].id = "retained_call";
    retainedLaunch.content[0].state.metadata.sessionID = "ses_retained";
    let messages: unknown[] = [retainedLaunch];
    let pending: unknown[] = [];
    let unavailable = false;
    const frame = (type: string, data: unknown, created = 30) => stream.enqueue(encoder.encode(`data: ${JSON.stringify({ type, data, created, location: { directory: WORKSPACE } })}\n\n`));
    const server = fakeOpenCode({
      "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) {
        stream = controller;
        frame("server.connected", {});
      } }), { headers: { "content-type": "text/event-stream" } }),
      "GET /api/session": () => ({ data: [session("ses_parent")], cursor: {} }),
      "GET /api/session/active": () => ({ ses_retained: { status: "running" }, ses_child: { status: "running" }, ses_later: { status: "running" } }),
      "GET /api/session/:id": ({ path }) => session(path.split("/").at(-1)!, path.endsWith("ses_parent") ? {} : { parentID: "ses_parent" }),
      "GET /api/session/ses_parent/message": () => unavailable ? new Response(null, { status: 503 }) : { data: messages, cursor: {} },
      "GET /api/session/ses_parent/inbox": () => ({ data: pending }),
      "GET /api/session/:id/message": () => ({ data: [], cursor: {} }),
      "GET /api/permission/request": () => scoped([]),
      "GET /api/form": () => scoped([]),
      "POST /api/session/ses_retained/interrupt": () => ({ interrupted: true }),
    });
    const provider = server.provider();
    const nativeEvents = provider.events.bind(provider);
    const liveWorkerIds: string[] = [];
    provider.events = async function* (signal) {
      for await (const event of nativeEvents(signal)) {
        for (const update of event.updates) if (update.kind === "upsert" && update.item.type === "background_task") liveWorkerIds.push(update.item.id);
        yield event;
      }
    };
    const adapter = new ChatAdapter({ provider, workspacePath: WORKSPACE, generation: "saturation", coalesceWindowMs: 0 });
    const pump = adapter.startEventPump();
    const until = async (predicate: () => boolean) => {
      const deadline = Date.now() + 4000;
      while (!predicate() && Date.now() < deadline) await Bun.sleep(5);
      if (!predicate()) throw new Error(`Saturation recovery stalled: ${JSON.stringify(rows().map(({ taskId, status, stateUncertain, resultId }) => ({ taskId, status, stateUncertain, resultId })))}; recent reads ${server.calls.slice(-12).map(call => `${call.method} ${call.path}`).join(", ")}`);
      expect(predicate()).toBe(true);
    };
    const rows = () => adapter.projectionForTests("ses_parent").items().filter(item => item.type === "background_task");
    try {
      await until(() => !!stream && server.requests("GET", "/api/session/ses_parent/message").length > 0);
      await until(() => rows().some(item => item.toolUseId === "retained_call" && !item.stateUncertain));
      // Saturate only disposable correlation after this target has acquired
      // its bounded control basis. Recovery must not reset the live latch.
      for (let i = 0; i < 2200; i++) frame("session.created", { sessionID: `filler${i}`.padEnd(500, "x"), parentID: "p".repeat(500) });
      await until(() => !(provider as unknown as { eventMemory?: { workers: { controlEvidenceAvailable: boolean } } }).eventMemory?.workers.controlEvidenceAvailable);
      await provider.reconcileBackgroundTasks("ses_parent", { fresh: true });
      await provider.stopTask("ses_parent", "v2:ses_parent:retained_call");
      expect(server.requests("POST", "/api/session/ses_retained/interrupt")).toHaveLength(1);
      for (const [index, child] of ["ses_child", "ses_later"].entries()) {
        const launch = structuredClone(fixture.launch);
        launch.id = `launch${index}`;
        launch.content[0].id = `worker${index}`;
        launch.content[0].state.metadata.sessionID = child;
        const result = structuredClone(fixture.pending);
        result.id = `result${index}`;
        result.payload.metadata.childID = child;
        messages = [...messages, launch];
        frame("session.message.content.updated", { sessionID: "ses_parent", messageID: launch.id, content: launch.content });
        await until(() => rows().some(item => item.toolUseId === `worker${index}` && item.status === "running"));
        // The saturated live detector cannot create this later row: only a
        // successful authoritative read can discover it on this subscription.
        expect(rows().find(item => item.toolUseId === `worker${index}`)).toMatchObject({ childConversationId: child, stateUncertain: true });
        await expect(provider.stopTask("ses_parent", `v2:ses_parent:worker${index}`)).rejects.toMatchObject({ name: "BackgroundTaskUnavailableError" });
        expect(server.calls.filter(call => call.method === "POST")).toHaveLength(1);
        unavailable = true;
        const reads = server.requests("GET", "/api/session/ses_parent/message").length;
        frame("session.message.content.updated", { sessionID: "ses_parent", messageID: `invalidate${index}`, content: [] });
        await until(() => server.requests("GET", "/api/session/ses_parent/message").length > reads && rows().some(item => item.toolUseId === `worker${index}` && item.stateUncertain));
        expect(rows().find(item => item.toolUseId === `worker${index}`)?.status).toBe("running");
        unavailable = false;
        pending = [...pending, result];
        frame("session.inbox.enqueued", { sessionID: "ses_parent", inboxID: result.id, item: result }, 41);
        await until(() => rows().some(item => item.toolUseId === `worker${index}` && item.status === "completed"));
        expect(rows().find(item => item.toolUseId === `worker${index}`)).toMatchObject({ resultId: result.id, summary: "Fixture checked.", stateUncertain: false });
      }
      expect(server.requests("GET", "/api/event")).toHaveLength(1);
      expect(liveWorkerIds).toEqual([]);
      expect(server.calls.filter(call => call.method === "POST")).toEqual([expect.objectContaining({ path: "/api/session/ses_retained/interrupt" })]);
    } finally {
      await adapter.dispose();
      await pump;
    }
  }, 30_000);
  test("post-admission fresh worker evidence cannot join a read begun before the action", async () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    let release!: () => void, entered!: () => void, reads = 0;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const server = fakeOpenCode({
      "GET /api/session/:id": ({ path }) => session(path.split("/").at(-1)!, path.endsWith("ses_child") ? { parentID: "ses_parent" } : {}),
      "GET /api/session/ses_parent/message": async () => {
        const first = reads++ === 0;
        if (first) { entered(); await gate; }
        return { data: first ? [] : [fixture.stored], cursor: {} };
      },
      "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
      "GET /api/session/active": () => ({}),
    });
    const provider = server.provider();
    const earlier = provider.reconcileBackgroundTasks("ses_parent");
    await started;
    const fresh = provider.reconcileBackgroundTasks("ses_parent", { fresh: true });
    release();
    expect(await earlier).toEqual([]);
    expect(await fresh).toEqual([expect.objectContaining({ status: "completed", resultId: fixture.stored.id })]);
    expect(reads).toBe(2);
    await provider.dispose();
  });
  test("steer and resume response loss is unknown, explicit refusal stays definitive, and resume preserves native acceptance evidence", async () => {
    for (const operation of ["prompt", "interrupt"] as const) {
      for (const refused of [false, true]) {
        const server = fakeOpenCode({
          [`POST /api/session/ses_parent/${operation}`]: () => refused ? notFound("ses_parent") : new Response("lost after application", { status: 502 }),
        });
        const provider = server.provider();
        const mutation = operation === "prompt" ? provider.prompt("ses_parent", { id: "stable", text: "steer", delivery: "steer" }) : provider.interrupt("ses_parent", { resume: true });
        await expect(mutation).rejects.toMatchObject({ ...(refused ? { _tag: "SessionNotFoundError" } : { name: "OperationOutcomeUnknownError" }) });
        expect(server.requests("POST", `/api/session/ses_parent/${operation}`)).toHaveLength(1);
      }
    }
    for (const interrupted of [true, false]) {
      const server = fakeOpenCode({ "POST /api/session/ses_parent/interrupt": () => ({ interrupted }) });
      expect(await server.provider().interrupt("ses_parent", { resume: true })).toEqual({ interrupted });
    }
  });
  test("SDK transport refusal and undeclared 403 remain definitive for steer and resume without replay", async () => {
    for (const operation of ["prompt", "interrupt"] as const) for (const failure of ["socket", "forbidden"] as const) {
      const server = fakeOpenCode({
        [`POST /api/session/ses_parent/${operation}`]: () => {
          if (failure === "socket") throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ConnectionRefused" });
          return Response.json({ _tag: "ForbiddenError", message: "Forbidden" }, { status: 403 });
        },
      });
      const provider = server.provider();
      try {
        const error = await (operation === "prompt"
          ? provider.prompt("ses_parent", { id: "stable", text: "steer", delivery: "steer" })
          : provider.interrupt("ses_parent", { resume: true })).catch(error => error);
        expect(error).toBeInstanceOf(ClientError);
        expect(error).toMatchObject({ reason: failure === "socket" ? "Transport" : "UnexpectedStatus", cause: failure === "socket" ? { code: "ConnectionRefused" } : { status: 403 } });
        expect(server.requests("POST", `/api/session/ses_parent/${operation}`)).toHaveLength(1);
      } finally { await provider.dispose(); }
    }
  });
  test("steer and resume preserve known request refusals but keep timeout, disconnect, and server failures unknown", async () => {
    for (const operation of ["prompt", "interrupt"] as const) for (const failure of [400, 401, 404, 500, 503, "timeout", "disconnect"] as const) {
      const tag = failure === 400 ? "InvalidRequestError" : failure === 401 ? "UnauthorizedError" : "SessionNotFoundError";
      const server = fakeOpenCode({
        [`POST /api/session/ses_parent/${operation}`]: () => {
          if (failure === "timeout") throw new DOMException("Timed out after dispatch", "TimeoutError");
          if (failure === "disconnect") throw new TypeError("Socket closed after dispatch");
          return Response.json({ _tag: tag, message: "Request failed", sessionID: "ses_parent" }, { status: failure });
        },
      });
      const provider = server.provider();
      try {
        const result = operation === "prompt"
          ? provider.prompt("ses_parent", { id: "stable", text: "steer", delivery: "steer" })
          : provider.interrupt("ses_parent", { resume: true });
        await expect(result).rejects.toMatchObject(typeof failure === "number" && failure < 500 ? { _tag: tag } : { name: "OperationOutcomeUnknownError" });
        expect(server.requests("POST", `/api/session/ses_parent/${operation}`)).toHaveLength(1);
      } finally { await provider.dispose(); }
    }
  });
  test("background-all is one parent-scoped native mutation, including an accepted empty no-op", async () => {
    const server = fakeOpenCode({
      "GET /api/session/ses_parent": () => session("ses_parent"),
      "POST /api/session/ses_parent/background": () => undefined,
    });
    await server.provider().backgroundBlockingWork("ses_parent");
    expect(server.calls.filter(call => call.method === "POST")).toEqual([expect.objectContaining({ path: "/api/session/ses_parent/background", body: undefined })]);
    expect(server.calls.some(call => /prompt|interrupt|inbox/.test(call.path))).toBe(false);
  });
  test("background parent validation refuses foreign sessions before mutation; dispatched response loss is unknown", async () => {
    const server = fakeOpenCode({
      "GET /api/session/ses_parent": () => session("ses_parent", { location: { directory: "/other" } }),
      "POST /api/session/ses_parent/background": () => undefined,
    });
    await expect(server.provider().backgroundBlockingWork("ses_parent")).rejects.toThrow(/unavailable/);
    expect(server.calls.some(call => call.method === "POST")).toBe(false);
    const lost = fakeOpenCode({
      "GET /api/session/ses_parent": () => session("ses_parent"),
      "POST /api/session/ses_parent/background": () => new Response("lost", { status: 502 }),
    });
    await expect(lost.provider().backgroundBlockingWork("ses_parent")).rejects.toMatchObject({ name: "OperationOutcomeUnknownError" });
    expect(lost.requests("POST", "/api/session/ses_parent/background")).toHaveLength(1);
  });
  for (const method of ["inventory", "create", "rename"] as const)
  for (const observation of (method === "inventory" ? ["parent", "workspace", "missing-parent", "missing-location", "absence", "unrelated", "malformed", "healthy"] as const
    : method === "create" ? ["parent", "workspace", "unrelated", "healthy"] as const : ["parent", "workspace"] as const))
  test(`all native SessionInfo inputs fence older owned Stop responses (${method}/${observation})`, async () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    let armed = false, reads = 0, renamed = false, entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const returned = () => session(observation === "unrelated" ? "unrelated" : "ses_child", {
      parentID: observation === "parent" ? "foreign_parent" : observation === "missing-parent" ? undefined : "ses_parent",
      ...(observation === "workspace" ? { title: "private-foreign-title", location: { directory: "/foreign/private" } } : observation === "missing-location" ? { location: {} } : observation === "malformed" ? { id: undefined, parentID: "foreign_parent" } : {}),
    });
    const server = fakeOpenCode({
      "GET /api/session": () => ({ data: observation === "absence" ? [] : [returned()], cursor: {} }),
      "POST /api/session": () => returned(),
      "PATCH /api/session/ses_child": () => { renamed = true; return undefined; },
      "GET /api/session/active": () => ({ ses_child: { type: "running" } }),
      "GET /api/session/ses_parent": () => session("ses_parent"),
      "GET /api/session/ses_child": async () => {
        const owned = session("ses_child", { parentID: "ses_parent" });
        if (armed && ++reads === 2) { entered(); await gate; return owned; }
        return renamed ? returned() : owned;
      },
      "GET /api/session/ses_parent/message": () => ({ data: [fixture.launch], cursor: {} }),
      "GET /api/session/ses_child/message": () => ({ data: [], cursor: {} }),
      "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
      "POST /api/session/ses_child/interrupt": () => ({ interrupted: true }),
    });
    const provider = server.provider(); let stop: Promise<unknown> | undefined;
    const contradiction = observation === "parent" || observation === "workspace";
    try {
      expect((await provider.reconcileBackgroundTasks("ses_parent", { fresh: true }))[0]?.control?.available).toBe(true);
      armed = true; stop = provider.stopTask("ses_parent", "v2:ses_parent:call_worker").catch(error => error); await started;
      if (method === "inventory") {
        const listed = await provider.listSessions();
        if (observation === "workspace" || observation === "missing-location" || observation === "absence") expect(listed).toEqual([]);
        if (observation === "parent") expect(listed[0]?.parentId).toBe("foreign_parent");
      } else if (method === "create") {
        const created = await provider.createSession("client-id-not-a-native-session-id").catch(error => error);
        if (observation === "workspace") { expect(created).toBeInstanceOf(Error); expect(String(created)).not.toContain("private-foreign-title"); expect(String(created)).not.toContain("/foreign/private"); }
        else expect(created.id).toBe(observation === "unrelated" ? "unrelated" : "ses_child");
      } else await provider.renameSession("ses_child", "renamed").catch(() => undefined);
      release(); const result = await stop;
      expect(server.requests("POST", "/api/session/ses_child/interrupt")).toHaveLength(contradiction ? 0 : 1);
      if (contradiction) expect(result).toMatchObject({ name: "BackgroundTaskUnavailableError" }); else expect(result).toBeUndefined();
    } finally { release(); await stop; await provider.dispose(); }
  });

  for (const stage of ["birth", "verified-parent", "cache-only"] as const) for (const reader of ["session", "configuration", "inventory"] as const)
  for (const target of (stage === "verified-parent" ? ["child", "parent"] as const : ["child"] as const))
  for (const change of (reader === "inventory" ? ["workspace", "parent", "missing", "unrelated", "healthy"] as const : ["workspace", "parent", "wrong-id", "missing", "unrelated", "healthy"] as const))
  test(`ordinary prelaunch observation fences only retained ownership facts (${stage}/${reader}/${target}/${change})`, async () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    const launch = structuredClone(fixture.launch); launch.content[0].time = { created: 20, ran: 20, completed: 30 };
    const foreground = structuredClone(launch); foreground.content[0].state.input.background = false; foreground.content[0].state.metadata.status = "completed"; foreground.content[0].state.content = [{ type: "text", text: "Foreground work" }];
    let history: unknown[] = stage === "cache-only" ? [foreground] : [], changed = false;
    let wire!: ReadableStreamDefaultController<Uint8Array>, acknowledge: (() => void) | undefined, sequence = 0;
    const sequences = new Map<string, number>();
    const raw = (type: string, data: unknown, created: number, proof = true) => {
      const aggregateID = (data as { sessionID?: string }).sessionID, seq = aggregateID ? (sequences.get(aggregateID) ?? 0) + 1 : undefined;
      if (aggregateID && type.startsWith("session.")) sequences.set(aggregateID, seq!);
      return { ...(proof ? { id: `prelaunch-owner-${++sequence}` } : {}), type, data, created, location: { directory: WORKSPACE },
        ...(aggregateID && type.startsWith("session.") ? { durable: { aggregateID, seq, version: type === "session.tool.success" ? 2 : 1 } } : {}) };
    };
    const frame = (event: unknown) => wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
    const observedId = change === "unrelated" ? "unrelated" : target === "parent" ? "ses_parent" : "ses_child";
    const record = (id: string) => {
      const selected = id === observedId;
      return session(changed && selected && change === "wrong-id" ? "wrong_child" : id, {
        parentID: changed && selected && change === "parent" ? "foreign_parent" : id === "ses_child" || id === "ses_healthy" ? "ses_parent" : undefined,
        time: id === "ses_healthy" ? { created: 42, updated: 43 } : id === "ses_parent" ? { created: 2, updated: 3 } : { created: 22, updated: 23 },
        ...(changed && selected && (change === "workspace" || change === "unrelated") ? { location: { directory: "/foreign" } } : changed && selected && change === "missing" ? { location: {} } : {}),
      });
    };
    const server = fakeOpenCode({
      "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) { wire = controller; frame(raw("server.connected", {}, 1)); } }), { headers: { "content-type": "text/event-stream" } }),
      "GET /api/session/active": () => ({ ses_child: { type: "running" }, ses_healthy: { type: "running" } }),
      "GET /api/session": () => ({ data: [record(observedId)], cursor: {} }),
      "GET /api/session/:id": ({ path }) => record(path.split("/").at(-1)!),
      "GET /api/session/ses_parent/message": () => ({ data: history, cursor: {} }),
      "GET /api/session/ses_child/message": () => ({ data: [], cursor: {} }),
      "GET /api/session/ses_healthy/message": () => ({ data: [], cursor: {} }),
      "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
      "POST /api/session/ses_child/interrupt": () => ({ interrupted: true }),
      "POST /api/session/ses_healthy/interrupt": () => ({ interrupted: true }),
    });
    const provider = server.provider(), lifetime = new AbortController();
    const pump = (async () => { for await (const event of provider.events(lifetime.signal)) if (event.eventType !== "server.connected") { acknowledge?.(); acknowledge = undefined; } })();
    const sendRaw = (event: unknown) => new Promise<void>(resolve => { acknowledge = resolve; frame(event); });
    const send = (type: string, data: unknown, at: number, proof = true) => sendRaw(raw(type, data, at, proof));
    const state = provider as unknown as { controls: { basis(id: string): unknown }; childParents: { size: number }; eventMemory: { workers: { births: Map<string, unknown>; parents: Map<string, string>; childTasks(id: string): unknown[] } } };
    const contradiction = change === "workspace" || change === "wrong-id" || change === "parent" && target === "child", taskId = "v2:ses_parent:call_worker";
    try {
      await provider.waitForEventStream(lifetime.signal);
      const common = { sessionID: "ses_parent", assistantMessageID: launch.id, id: "call_worker" };
      let calledFrame: ReturnType<typeof raw> | undefined, birthFrame: ReturnType<typeof raw> | undefined;
      if (stage === "cache-only") {
        await provider.listMessages("ses_parent", { limit: 100 });
        expect(state.childParents.size).toBe(1); expect(state.eventMemory.workers.births.size).toBe(0); expect(state.eventMemory.workers.parents.size).toBe(0);
      } else {
        await send("session.tool.input.started", { ...common, name: "subagent" }, 20);
        calledFrame = raw("session.tool.called", { ...common, input: launch.content[0].state.input, executed: true }, 20); await sendRaw(calledFrame);
        birthFrame = raw("session.created", { sessionID: "ses_child", parentID: "ses_parent", projectID: "global", slug: "child", version: "2.1.2", location: { directory: WORKSPACE } }, 22, stage === "birth"); await sendRaw(birthFrame);
        if (stage === "birth") await send("session.execution.started", { sessionID: "ses_child" }, 23);
        expect(state.eventMemory.workers.parents.get("ses_child")).toBe("ses_parent");
        expect(state.eventMemory.workers.births.size).toBe(stage === "birth" ? 1 : 0);
      }
      expect(state.controls.basis(taskId)).toBeUndefined(); expect(state.eventMemory.workers.childTasks("ses_child")).toEqual([]);
      const births = state.eventMemory.workers.births.size;
      changed = true;
      const observed = reader === "session" ? await provider.getSession(observedId) : reader === "configuration" ? await provider.getConversationConfiguration(observedId) : await provider.listSessions();
      if (reader === "session" && ["workspace", "missing", "unrelated"].includes(change)) expect(observed).toBeNull();
      if (change === "unrelated") expect(state.eventMemory.workers.births.size).toBe(births);
      if (stage !== "cache-only") changed = false;
      if (contradiction && stage === "birth") { await sendRaw(calledFrame!); await sendRaw(birthFrame!); }
      history = [launch];
      if (stage !== "cache-only") {
        await send("session.tool.success", { ...common, executed: true, input: launch.content[0].state.input, metadata: launch.content[0].state.metadata, content: launch.content[0].state.content }, 30);
        await send("session.message.content.updated", { sessionID: "ses_parent", messageID: launch.id, content: launch.content }, 30);
      }
      const [row] = await provider.reconcileBackgroundTasks("ses_parent", { fresh: true });
      const result = await provider.stopTask("ses_parent", taskId).catch(error => error);
      expect(server.requests("POST", "/api/session/ses_child/interrupt")).toHaveLength(!contradiction && stage === "birth" ? 1 : 0);
      if (contradiction) {
        expect(row?.activity?.kind).not.toBe("working"); expect(row?.activity?.launchRef).toBeUndefined();
        expect(row?.control?.available).not.toBe(true); expect(result).toMatchObject({ name: "BackgroundTaskUnavailableError" });
        changed = false;
        history = [fixture.converted];
        const [alias] = await provider.reconcileBackgroundTasks("ses_parent", { fresh: true });
        expect(alias?.activity?.kind).not.toBe("working"); expect(alias?.activity?.launchRef).toBeUndefined(); expect(alias?.control?.available).not.toBe(true);
        await expect(provider.stopTask("ses_parent", "v2:ses_parent:call_converted")).rejects.toMatchObject({ name: "BackgroundTaskUnavailableError" });
        const healthy = structuredClone(launch); healthy.id = "msg_healthy"; healthy.time.created = 40;
        healthy.content[0].id = "call_healthy"; healthy.content[0].time = { created: 40, ran: 40, completed: 50 }; healthy.content[0].state.metadata.sessionID = "ses_healthy";
        const next = { sessionID: "ses_parent", assistantMessageID: healthy.id, id: "call_healthy" };
        await send("session.tool.input.started", { ...next, name: "subagent" }, 40);
        await send("session.tool.called", { ...next, input: healthy.content[0].state.input, executed: true }, 40);
        await send("session.created", { sessionID: "ses_healthy", parentID: "ses_parent", projectID: "global", slug: "healthy", version: "2.1.2", location: { directory: WORKSPACE } }, 42);
        await send("session.execution.started", { sessionID: "ses_healthy" }, 43);
        history = [fixture.converted, healthy]; await send("session.message.content.updated", { sessionID: "ses_parent", messageID: healthy.id, content: healthy.content }, 50);
        const healthyRows = await provider.reconcileBackgroundTasks("ses_parent", { fresh: true });
        expect(healthyRows.find(task => task.taskId === "v2:ses_parent:call_healthy")?.control?.available).toBe(true);
        await provider.stopTask("ses_parent", "v2:ses_parent:call_healthy");
        expect(server.requests("POST", "/api/session/ses_healthy/interrupt")).toHaveLength(1);
        expect(server.requests("POST", "/api/session/ses_child/interrupt")).toHaveLength(0);
      } else expect(row?.activity?.kind).toBe("working");
    } finally { lifetime.abort(); await pump; await provider.dispose(); }
  });

  for (const saturated of [false, true]) for (const alias of [false, true]) for (const reader of ["session", "configuration"] as const)
  for (const target of ["child", "parent", "unrelated"] as const) for (const scope of (!saturated && !alias
    ? ["foreign", "missing", "wrong-id", "foreign-parent", "missing-id", "missing-parent"] as const : ["foreign", "missing"] as const))
  test(`ordinary session observation fences only known worker associations (${reader}/${target}/${scope}/alias=${alias}/saturated=${saturated})`, async () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    let changed = false, held = false, wire!: ReadableStreamDefaultController<Uint8Array>, acknowledge: (() => void) | undefined;
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const frame = (type: string, data: unknown) => wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type, data, created: 60, location: { directory: WORKSPACE } })}\n\n`));
    const server = fakeOpenCode({
      "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) { wire = controller; frame("server.connected", {}); } }), { headers: { "content-type": "text/event-stream" } }),
      "GET /api/session/active": () => ({ ses_child: { type: "running" } }),
      "GET /api/session/:id": async ({ path }) => {
        const id = path.split("/").at(-1)!;
        const owned = session(id, id === "ses_child" ? { parentID: "ses_parent" } : {});
        if (id === "ses_child" && held) { held = false; entered(); await gate; return owned; }
        const selected = target === "child" ? id === "ses_child" : target === "parent" ? id === "ses_parent" : id.startsWith("unrelated");
        return changed && selected ? { ...owned, title: "private-foreign-title",
          ...(scope === "foreign" ? { location: { directory: "/foreign/private" } } : scope === "missing" ? { location: {} }
            : scope === "wrong-id" ? { id: "different_session" } : scope === "foreign-parent" ? { parentID: "foreign_parent" }
            : scope === "missing-id" ? { id: undefined } : { parentID: undefined }) } : owned;
      },
      "GET /api/session/ses_parent/message": () => ({ data: alias ? [fixture.launch, fixture.converted] : [fixture.launch], cursor: {} }),
      "GET /api/session/ses_child/message": () => ({ data: [], cursor: {} }),
      "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
      "POST /api/session/ses_child/interrupt": () => ({ interrupted: true }),
    });
    const provider = server.provider(), lifetime = new AbortController();
    const pump = (async () => { for await (const event of provider.events(lifetime.signal)) if (["server.heartbeat", "session.message.content.updated"].includes(event.eventType ?? "")) { acknowledge?.(); acknowledge = undefined; } })();
    const send = (type: string, data: unknown) => new Promise<void>(resolve => { acknowledge = resolve; frame(type, data); });
    const state = provider as unknown as { controls: { basis(id: string): unknown }; eventMemory: { workers: { births: Map<string, unknown>; controlEvidenceAvailable: boolean } } };
    let stop: Promise<unknown> | undefined;
    const contradiction = (scope === "foreign" || scope === "wrong-id") && target !== "unrelated"
      || scope === "foreign-parent" && target === "child", taskId = "v2:ses_parent:call_worker";
    try {
      await provider.waitForEventStream(lifetime.signal);
      await send("session.message.content.updated", { sessionID: "ses_parent", messageID: fixture.launch.id, content: fixture.launch.content });
      if (alias) await send("session.message.content.updated", { sessionID: "ses_parent", messageID: fixture.converted.id, content: fixture.converted.content });
      await provider.reconcileBackgroundTasks("ses_parent", { fresh: true });
      if (saturated) {
        for (let index = 0; index < 2_200; index++) frame("session.created", { sessionID: `filler${index}`.padEnd(500, "x"), parentID: "p".repeat(500) });
        await send("server.heartbeat", {});
        expect(state.eventMemory.workers.controlEvidenceAvailable).toBe(false);
      }
      expect(state.controls.basis(taskId)).toBeDefined();
      held = true; stop = provider.stopTask("ses_parent", taskId).catch(error => error); await started;
      const births = state.eventMemory.workers.births.size;
      changed = true;
      for (let index = 0; index < (target === "unrelated" ? 32 : 1); index++) {
        const id = target === "child" ? "ses_child" : target === "parent" ? "ses_parent" : `unrelated-${index}`;
        const record = reader === "session" ? await provider.getSession(id) : await provider.getConversationConfiguration(id);
        if (reader === "session") {
          if (scope === "foreign" || scope === "missing") expect(record).toBeNull();
          else expect(record).not.toBeNull();
        } else expect(record).toEqual({});
        if (scope === "foreign" || scope === "missing") expect(JSON.stringify(record)).not.toContain("private-foreign");
      }
      if (target === "unrelated") expect(state.eventMemory.workers.births.size).toBe(births);
      changed = false; release(); const result = await stop;
      expect(server.requests("POST", "/api/session/ses_child/interrupt")).toHaveLength(contradiction ? 0 : 1);
      if (contradiction) expect(result).toMatchObject({ name: "BackgroundTaskUnavailableError" }); else expect(result).toBeUndefined();
      expect((await provider.reconcileBackgroundTasks("ses_parent", { fresh: true })).find(task => task.taskId === taskId)?.control?.available).toBe(!contradiction);
    } finally { release(); await stop; lifetime.abort(); await pump; await provider.dispose(); }
  });

  for (const location of [{ directory: "/foreign/private" }, {}, undefined, { directory: "/ws/nested/.." }]) test(`classified worker lookup preserves ordinary session concealment (${JSON.stringify(location)})`, async () => {
    const server = fakeOpenCode({ "GET /api/session/ses_parent": () => session("ses_parent", { location, title: "foreign-private-title", agent: "private-agent" }) });
    const provider = server.provider();
    try {
      const record = await provider.getSession("ses_parent"), configuration = await provider.getConversationConfiguration("ses_parent");
      if (location?.directory === "/ws/nested/..") expect(record?.id).toBe("ses_parent");
      else { expect(record).toBeNull(); expect(configuration).toEqual({}); }
    } finally { await provider.dispose(); }
  });

  for (const alias of [false, true]) for (const foreignRead of [1, 2, 3, 4]) for (const scope of ["foreign", "missing", "healthy"] as const)
  test(`occurrence-aware parent workspace read fences an older owned Stop (${foreignRead}/${scope}/alias=${alias})`, async () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    const healthy = structuredClone(fixture.launch); healthy.sessionID = "healthy_parent"; healthy.content[0].state.metadata.sessionID = "healthy_child";
    let armed = false, parentReads = 0, held = false, wire!: ReadableStreamDefaultController<Uint8Array>, acknowledge: (() => void) | undefined;
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const frame = (type: string, data: unknown) => wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type, data, created: 60, location: { directory: WORKSPACE } })}\n\n`));
    const server = fakeOpenCode({
      "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) { wire = controller; frame("server.connected", {}); } }), { headers: { "content-type": "text/event-stream" } }),
      "GET /api/session/ses_parent": () => session("ses_parent", { ...(armed ? { revert: { messageID: fixture.launch.id } } : {}),
        ...(armed && ++parentReads === foreignRead ? { location: scope === "foreign" ? { directory: "/foreign" } : scope === "missing" ? {} : { directory: WORKSPACE } } : {}) }),
      "GET /api/session/active": () => ({ ses_child: { type: "running" }, healthy_child: { type: "running" } }),
      "GET /api/session/ses_child": async () => { if (held) { held = false; entered(); await gate; } return session("ses_child", { parentID: "ses_parent" }); },
      "GET /api/session/healthy_child": () => session("healthy_child", { parentID: "healthy_parent" }),
      "GET /api/session/healthy_parent": () => session("healthy_parent"),
      "GET /api/session/ses_parent/message": () => ({ data: alias ? [fixture.launch, fixture.converted] : [fixture.launch], cursor: {} }),
      "GET /api/session/healthy_parent/message": () => ({ data: [healthy], cursor: {} }),
      "GET /api/session/:id/message": () => ({ data: [], cursor: {} }),
      "GET /api/session/:id/inbox": () => ({ data: [] }),
      "POST /api/session/:id/interrupt": () => ({ interrupted: true }),
    });
    const provider = server.provider(), lifetime = new AbortController();
    const pump = (async () => { for await (const event of provider.events(lifetime.signal)) if (event.eventType !== "server.connected") { acknowledge?.(); acknowledge = undefined; } })();
    const send = (type: string, data: unknown) => new Promise<void>(resolve => { acknowledge = resolve; frame(type, data); });
    let stop: Promise<unknown> | undefined;
    try {
      await provider.waitForEventStream(lifetime.signal);
      await send("session.message.content.updated", { sessionID: "ses_parent", messageID: fixture.launch.id, content: fixture.launch.content });
      if (alias) await send("session.message.content.updated", { sessionID: "ses_parent", messageID: fixture.converted.id, content: fixture.converted.content });
      await provider.reconcileBackgroundTasks("ses_parent", { fresh: true });
      held = true; stop = provider.stopTask("ses_parent", "v2:ses_parent:call_worker").catch(error => error); await started;
      armed = true;
      await provider.reconcileBackgroundTasks("ses_parent", { fresh: true }).catch(() => undefined);
      armed = false; release(); const result = await stop;
      expect(server.requests("POST", "/api/session/ses_child/interrupt")).toHaveLength(scope === "foreign" ? 0 : 1);
      if (scope === "foreign") expect(result).toMatchObject({ name: "BackgroundTaskUnavailableError" });
      else expect(result).toBeUndefined();
      expect((await provider.reconcileBackgroundTasks("ses_parent", { fresh: true })).find(task => task.taskId === "v2:ses_parent:call_worker")?.control?.available).toBe(scope !== "foreign");
      await provider.stopTask("healthy_parent", "v2:healthy_parent:call_worker");
      expect(server.requests("POST", "/api/session/healthy_child/interrupt")).toHaveLength(1);
    } finally { release(); await stop; lifetime.abort(); await pump; await provider.dispose(); }
  });

  for (const alias of [false, true]) for (const phase of ["final", "snapshot"] as const) for (const observation of ["foreign-parent", "wrong-child", "foreign-workspace", "missing-workspace", "missing-parent", "empty-parent", "missing-child", "missing", "owned"] as const) test(`positive agent ownership contradiction fences retained Stop (${phase}/${observation}/alias=${alias})`, async () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    const healthy = structuredClone(fixture.launch);
    healthy.sessionID = "healthy_parent"; healthy.content[0].state.metadata.sessionID = "healthy_child";
    let history = alias ? [fixture.launch, fixture.converted] : [fixture.launch];
    let wire!: ReadableStreamDefaultController<Uint8Array>, acknowledge: (() => void) | undefined, sequence = 0;
    let armed = false, lookups = 0, entered!: () => void, releaseFirst!: () => void, releaseSecond!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    const secondGate = new Promise<void>(resolve => { releaseSecond = resolve; });
    const frame = (type: string, data: unknown) => wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ id: `owner-fence-${++sequence}`, type, data, created: 60, location: { directory: WORKSPACE } })}\n\n`));
    const changed = () => observation === "missing" ? notFound("ses_child") : session(observation === "wrong-child" ? "different_child" : "ses_child", {
      parentID: observation === "foreign-parent" ? "ses_foreign" : observation === "missing-parent" ? undefined : observation === "empty-parent" ? "" : "ses_parent",
      ...(observation === "missing-child" ? { id: undefined } : {}),
      ...(observation === "foreign-workspace" ? { location: { directory: "/foreign" } } : observation === "missing-workspace" ? { location: {} } : {}),
    });
    const server = fakeOpenCode({
      "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) { wire = controller; frame("server.connected", {}); } }), { headers: { "content-type": "text/event-stream" } }),
      "GET /api/session/ses_child": async () => {
        if (!armed) return session("ses_child", { parentID: "ses_parent" });
        const index = ++lookups;
        if (phase === "final") {
          if (index === 2) entered();
          await (index === 1 ? firstGate : secondGate);
          return index === 1 ? changed() : session("ses_child", { parentID: "ses_parent" });
        }
        if (index === 1) { entered(); await firstGate; return session("ses_child", { parentID: "ses_parent" }); }
        return changed();
      },
      "GET /api/session/ses_parent/message": () => ({ data: history, cursor: {} }),
      "GET /api/session/healthy_parent/message": () => ({ data: [healthy], cursor: {} }),
      "GET /api/session/:id/message": () => ({ data: [], cursor: {} }),
      "GET /api/session/:id/inbox": () => ({ data: [] }),
      "GET /api/session/active": () => ({ ses_child: { type: "running" }, healthy_child: { type: "running" } }),
      "GET /api/session/:id": ({ path }) => session(path.split("/").at(-1)!, path.endsWith("healthy_child") ? { parentID: "healthy_parent" } : {}),
      "POST /api/session/:id/interrupt": () => ({ interrupted: true }),
    });
    const provider = server.provider(), controller = new AbortController();
    const pump = (async () => { for await (const event of provider.events(controller.signal)) if (event.eventType !== "server.connected") { acknowledge?.(); acknowledge = undefined; } })();
    const send = (type: string, data: unknown) => new Promise<void>(resolve => { acknowledge = resolve; frame(type, data); });
    // Proven launch aliases initially fold to one published task identity.
    const taskId = "v2:ses_parent:call_worker";
    const contradiction = observation === "foreign-parent" || observation === "wrong-child" || observation === "foreign-workspace";
    let first: Promise<unknown> | undefined, second: Promise<unknown> | undefined;
    try {
      await provider.waitForEventStream(controller.signal);
      await send("session.message.content.updated", { sessionID: "ses_parent", messageID: fixture.launch.id, content: fixture.launch.content });
      if (alias) await send("session.message.content.updated", { sessionID: "ses_parent", messageID: fixture.converted.id, content: fixture.converted.content });
      expect(await provider.reconcileBackgroundTasks("ses_parent", { fresh: true })).toContainEqual(expect.objectContaining({ taskId, stateUncertain: false, control: { available: true } }));
      armed = true;
      first = provider.stopTask("ses_parent", taskId).catch(error => error);
      if (phase === "final") second = provider.stopTask("ses_parent", taskId).catch(error => error);
      await started;
      expect(lookups).toBe(phase === "final" ? 2 : 1);
      if (phase === "final") {
        releaseFirst();
        const result = await first;
        if (observation === "owned") expect(result).toBeUndefined();
        else expect(result).toMatchObject({ name: "BackgroundTaskUnavailableError" });
        releaseSecond();
        const stale = await second;
        if (contradiction) expect(stale).toMatchObject({ name: "BackgroundTaskUnavailableError" });
        else expect(stale).toBeUndefined();
      } else {
        // Retire immutable relationship reuse without revoking this worker.
        // A separate fresh snapshot now learns the contradiction while Stop's
        // older final ownership response remains held.
        await send("session.moved", { sessionID: "unrelated" });
        await provider.reconcileBackgroundTasks("ses_parent", { fresh: true });
        expect(lookups).toBe(2);
        releaseFirst();
        const stale = await first;
        if (contradiction) expect(stale).toMatchObject({ name: "BackgroundTaskUnavailableError" });
        else expect(stale).toBeUndefined();
      }
      expect(server.requests("POST", "/api/session/ses_child/interrupt")).toHaveLength(contradiction ? 0 : phase === "final" && observation === "owned" ? 2 : 1);
      armed = false;
      const recovered = await provider.reconcileBackgroundTasks("ses_parent", { fresh: true });
      expect(recovered.find(task => task.taskId === taskId)?.control?.available).toBe(!contradiction);
      if (contradiction) {
        expect(recovered.find(task => task.taskId === taskId)?.activity?.launchRef).toBeUndefined();
        await expect(provider.stopTask("ses_parent", taskId)).rejects.toMatchObject({ name: "BackgroundTaskUnavailableError" });
        if (alias) {
          // Restating only the other proven launcher changes the canonical
          // wire identity, not the occurrence's sticky revocation.
          history = [fixture.converted];
          const aliasId = "v2:ses_parent:call_converted";
          expect((await provider.reconcileBackgroundTasks("ses_parent", { fresh: true })).find(task => task.taskId === aliasId)?.control?.available).toBe(false);
          await expect(provider.stopTask("ses_parent", aliasId)).rejects.toMatchObject({ name: "BackgroundTaskUnavailableError" });
        }
      } else await provider.stopTask("ses_parent", taskId);
      // A contradiction is occurrence-local, not a provider-wide closure.
      await send("session.message.content.updated", { sessionID: "healthy_parent", messageID: healthy.id, content: healthy.content });
      await provider.stopTask("healthy_parent", "v2:healthy_parent:call_worker");
      expect(server.requests("POST", "/api/session/healthy_child/interrupt")).toHaveLength(1);
      expect(stopEvidence(provider)).toHaveLength(0);
    } finally { releaseFirst(); releaseSecond(); await Promise.allSettled([first, second]); controller.abort(); await pump; await provider.dispose(); }
  });
  test("worker stop verifies its occurrence and interrupts only its child without resuming", async () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    let completed = false;
    const server = fakeOpenCode({
      "GET /api/session/active": () => ({ ses_child: { status: "running" } }),
      "GET /api/session/:id": ({ path }) => session(path.split("/").at(-1)!, path.endsWith("ses_child") ? { parentID: "ses_parent" } : {}),
      "GET /api/session/ses_parent/message": () => ({ data: completed ? [fixture.launch, fixture.stored] : [fixture.launch], cursor: {} }),
      "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
      "GET /api/session/ses_child/message": () => ({ data: [], cursor: {} }),
      "POST /api/session/ses_child/interrupt": () => ({ interrupted: true }),
    });
    const provider = server.provider();
    await provider.stopTask("ses_parent", "v2:ses_parent:call_worker");
    expect(server.calls.filter(call => call.method === "POST")).toEqual([expect.objectContaining({ path: "/api/session/ses_child/interrupt", body: undefined })]);
    expect(server.requests("POST", "/api/session/ses_child/interrupt")[0]!.query.get("resume")).toBe("false");
    completed = true;
    await expect(provider.stopTask("ses_parent", "v2:ses_parent:call_worker")).rejects.toThrow(/no longer/);
    expect(server.calls.filter(call => call.method === "POST")).toHaveLength(1);
  });
  for (const type of ["session.execution.started", "session.execution.succeeded"]) test(`Stop refuses ${type} already known before validation without trusting lagging history`, async () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    let wire!: ReadableStreamDefaultController<Uint8Array>;
    const acknowledgements = new Map<string, () => void>();
    const frame = (type: string, data: unknown, created = 30) => wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ id: `native-${type}`, type, data, created, location: { directory: WORKSPACE } })}\n\n`));
    const send = (type: string, data: unknown, created?: number) => new Promise<void>(resolve => { acknowledgements.set(type, resolve); frame(type, data, created); });
    const server = fakeOpenCode({
      "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) { wire = controller; frame("server.connected", {}); } }), { headers: { "content-type": "text/event-stream" } }),
      "GET /api/session/ses_child": () => session("ses_child", { parentID: "ses_parent" }),
      "GET /api/session/ses_parent": () => session("ses_parent"),
      "GET /api/session/ses_parent/message": () => ({ data: [fixture.launch], cursor: {} }),
      "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
      "GET /api/session/active": () => ({ ses_child: { status: "running" } }),
      "GET /api/session/ses_child/message": () => ({ data: [], cursor: {} }),
      "POST /api/session/ses_child/interrupt": () => ({ interrupted: true }),
    });
    const provider = server.provider(), controller = new AbortController();
    const pump = (async () => { for await (const event of provider.events(controller.signal)) { acknowledgements.get(event.eventType)?.(); acknowledgements.delete(event.eventType); } })();
    try {
      await provider.waitForEventStream(controller.signal);
      await send("session.message.content.updated", { sessionID: "ses_parent", messageID: fixture.launch.id, content: fixture.launch.content });
      await send(type, { sessionID: "ses_child" }, 40);
      await expect(provider.stopTask("ses_parent", "v2:ses_parent:call_worker")).rejects.toMatchObject({ name: "BackgroundTaskUnavailableError" });
      expect(server.calls.filter(call => call.method === "POST")).toHaveLength(0);
      expect(server.requests("GET", "/api/session/ses_parent/message")).toHaveLength(0);
    } finally { controller.abort(); await pump; await provider.dispose(); }
  });
  for (const alias of [false, true]) for (const change of ["foreground", "foreground-no-child", "changed-child-progress", "changed-child-progress-in-flight", "ambiguous-backdated-notification", "same-child-progress"] as const) test(`Stop retains pre-validation ${change} through progress and stale recovery (${alias ? "alias" : "direct"})`, async () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    let wire!: ReadableStreamDefaultController<Uint8Array>, sequence = 0;
    const acknowledgements: Array<() => void> = [];
    let entered!: () => void, release!: () => void, pendingProgress: Promise<void> | undefined;
    const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const frame = (type: string, data: unknown, created = 100) => wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ id: `retained${++sequence}`, type, data, created, durable: { aggregateID: "ses_parent", seq: sequence, version: 1 }, location: { directory: WORKSPACE } })}\n\n`));
    const send = (type: string, data: unknown, created?: number) => new Promise<void>(resolve => { acknowledgements.push(resolve); frame(type, data, created); });
    const server = fakeOpenCode({
      "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) { wire = controller; frame("server.connected", {}); } }), { headers: { "content-type": "text/event-stream" } }),
      "GET /api/session/ses_parent/message": () => ({ data: alias ? [fixture.launch, fixture.converted] : [fixture.launch], cursor: {} }),
      "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
      "GET /api/session/active": () => ({ ses_child: { status: "running" } }),
      "GET /api/session/ses_child/message": () => ({ data: [], cursor: {} }),
      "GET /api/session/new_child": async () => { if (change.endsWith("in-flight")) { entered(); await gate; } return session("new_child", { parentID: "ses_parent" }); },
      "GET /api/session/:id": ({ path }) => session(path.split("/").at(-1)!, path.endsWith("ses_parent") ? {} : { parentID: "ses_parent" }),
      "POST /api/session/ses_child/interrupt": () => ({ interrupted: true }),
    });
    const provider = server.provider(), controller = new AbortController();
    const pump = (async () => { for await (const event of provider.events(controller.signal)) if (event.eventType !== "server.connected") acknowledgements.shift()?.(); })();
    try {
      await provider.waitForEventStream(controller.signal);
      await send("session.message.content.updated", { sessionID: "ses_parent", messageID: fixture.launch.id, content: fixture.launch.content });
      if (alias) await send("session.message.content.updated", { sessionID: "ses_parent", messageID: fixture.converted.id, content: fixture.converted.content });
      const selected = alias ? fixture.converted : fixture.launch, part = structuredClone(selected.content[0]);
      await send("session.tool.input.started", { sessionID: "ses_parent", id: part.id, name: "subagent", assistantMessageID: selected.id });
      const common = { sessionID: "ses_parent", id: part.id, assistantMessageID: selected.id };
      if (change.startsWith("foreground")) {
        part.state.status = "running"; part.state.input.background = false;
        if (change === "foreground-no-child") delete part.state.metadata.sessionID;
        await send("session.message.content.updated", { sessionID: "ses_parent", messageID: selected.id, content: [part] });
      } else if (change === "ambiguous-backdated-notification") {
        await send("session.inbox.enqueued", { sessionID: "ses_parent", inboxID: "unproven_old_report", item: fixture.pending }, 1);
      } else {
        pendingProgress = send("session.tool.progress", { ...common, metadata: { sessionID: change.startsWith("changed-child") ? "new_child" : "ses_child", status: "running" } });
        if (change.endsWith("in-flight")) {
          await started;
          await expect(provider.stopTask("ses_parent", "v2:ses_parent:call_worker")).rejects.toMatchObject({ name: "BackgroundTaskUnavailableError" });
          expect(server.calls.filter(call => call.method === "POST")).toHaveLength(0);
          release();
        }
        await pendingProgress;
      }
      await send("session.tool.progress", { ...common, metadata: { sessionID: "ses_child", status: "running" } });
      await send("session.message.content.updated", { sessionID: "ses_parent", messageID: selected.id, content: selected.content });
      await provider.reconcileBackgroundTasks("ses_parent");
      const result = await provider.stopTask("ses_parent", "v2:ses_parent:call_worker").catch(error => error);
      const allowed = change === "same-child-progress";
      expect(server.calls.filter(call => call.method === "POST")).toHaveLength(allowed ? 1 : 0);
      if (!allowed) expect(result).toMatchObject({ name: "BackgroundTaskUnavailableError" });
      else expect(result).toBeUndefined();
      expect(stopEvidence(provider)).toHaveLength(0);
    } finally { release(); await pendingProgress; controller.abort(); await pump; await provider.dispose(); }
  });
  test("a processed ownership revocation fences Stop while its child execution history is in flight", async () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    let stream!: ReadableStreamDefaultController<Uint8Array>, entered!: () => void, release!: () => void, revoked!: () => void;
    let foreign = false;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const observed = new Promise<void>(resolve => { revoked = resolve; });
    const frame = (type: string, data: unknown) => stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type, data, location: { directory: WORKSPACE }, created: 30 })}\n\n`));
    const server = fakeOpenCode({
      "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; frame("server.connected", {}); } }), { headers: { "content-type": "text/event-stream" } }),
      "GET /api/session/ses_parent": () => session("ses_parent"),
      "GET /api/session/ses_child": () => session("ses_child", { parentID: "ses_parent", location: { directory: foreign ? "/other" : WORKSPACE } }),
      "GET /api/session/ses_parent/message": () => ({ data: [fixture.launch], cursor: {} }),
      "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
      "GET /api/session/active": () => ({ ses_child: { status: "running" } }),
      "GET /api/session/ses_child/message": async () => { entered(); await gate; return { data: [], cursor: {} }; },
      "POST /api/session/ses_child/interrupt": () => ({ interrupted: true }),
    });
    const provider = server.provider();
    const controller = new AbortController();
    let primed!: () => void;
    const priming = new Promise<void>(resolve => { primed = resolve; });
    const pump = (async () => { for await (const event of provider.events(controller.signal)) {
      if (event.eventType === "session.message.content.updated") primed();
      if (event.eventType === "session.moved") revoked();
    } })();
    let stop: Promise<unknown> | undefined;
    try {
      await provider.waitForEventStream(controller.signal);
      frame("session.message.content.updated", { sessionID: "ses_parent", messageID: fixture.launch.id, content: fixture.launch.content });
      await priming;
      stop = provider.stopTask("ses_parent", "v2:ses_parent:call_worker").catch(error => error);
      await started;
      foreign = true;
      frame("session.moved", { sessionID: "ses_child", location: { directory: "/other" } });
      await observed;
      release();
      const result = await stop;
      expect(server.requests("POST", "/api/session/ses_child/interrupt")).toHaveLength(0);
      expect(result).toMatchObject({ name: "BackgroundTaskUnavailableError" });
    } finally { release(); controller.abort(); await stop; await pump; await provider.dispose(); }
  });
  test("Stop cannot interrupt a reused child execution observed during final ownership verification", async () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    let stream!: ReadableStreamDefaultController<Uint8Array>, entered!: () => void, release!: () => void, childReads = 0;
    const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const acknowledgements = new Map<string, () => void>();
    const frame = (type: string, data: unknown, created = 30) => stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type, data, created, location: { directory: WORKSPACE } })}\n\n`));
    const send = (type: string, data: unknown, created?: number) => new Promise<void>(resolve => { acknowledgements.set(type, resolve); frame(type, data, created); });
    const server = fakeOpenCode({
      "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; frame("server.connected", {}); } }), { headers: { "content-type": "text/event-stream" } }),
      "GET /api/session/ses_parent": () => session("ses_parent"),
      "GET /api/session/ses_child": async () => { if (++childReads === 2) { entered(); await gate; } return session("ses_child", { parentID: "ses_parent" }); },
      "GET /api/session/ses_parent/message": () => ({ data: [fixture.launch], cursor: {} }),
      "GET /api/session/ses_child/message": () => ({ data: [], cursor: {} }),
      "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
      "GET /api/session/active": () => ({ ses_child: { status: "running" } }),
      "POST /api/session/ses_child/interrupt": () => ({ interrupted: true }),
    });
    const provider = server.provider(), controller = new AbortController();
    const facts: unknown[] = [];
    const pump = (async () => { for await (const event of provider.events(controller.signal)) {
      facts.push(...event.updates.flatMap(update => update.kind === "upsert" && update.item.type === "background_task" ? [update.item] : []));
      acknowledgements.get(event.eventType)?.(); acknowledgements.delete(event.eventType);
    } })();
    let stop: Promise<unknown> | undefined;
    try {
      await provider.waitForEventStream(controller.signal);
      await send("session.message.content.updated", { sessionID: "ses_parent", messageID: fixture.launch.id, content: fixture.launch.content });
      stop = provider.stopTask("ses_parent", "v2:ses_parent:call_worker").catch(error => error);
      await started;
      await send("session.execution.succeeded", { sessionID: "ses_child" }, 40);
      await send("session.message.content.updated", { sessionID: "ses_parent", messageID: fixture.converted.id, content: fixture.converted.content }, 60);
      expect(facts).toContainEqual(expect.objectContaining({ taskId: "v2:ses_parent:call_worker", stateUncertain: true }));
      expect(facts).toContainEqual(expect.objectContaining({ taskId: "v2:ses_parent:call_converted", status: "running" }));
      release();
      const result = await stop;
      expect(server.requests("POST", "/api/session/ses_child/interrupt")).toHaveLength(0);
      expect(result).toMatchObject({ name: "BackgroundTaskUnavailableError" });
    } finally { release(); controller.abort(); await stop; await pump; await provider.dispose(); }
  });
  for (const phase of ["parent-history", "child-history", "final-ownership"] as const) {
    for (const change of ["terminal", "restart", "launcher", "notification", "unrelated", "alias"] as const) test(`Stop scopes ${change} evidence during ${phase} to the requested occurrence`, async () => {
      const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
      let stream!: ReadableStreamDefaultController<Uint8Array>, entered!: () => void, release!: () => void, childReads = 0;
      const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
      const acknowledgements = new Map<string, () => void>();
      const frame = (type: string, data: unknown, created = 30) => stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type, data, created, location: { directory: WORKSPACE } })}\n\n`));
      const send = (type: string, data: unknown, created?: number) => new Promise<void>(resolve => { acknowledgements.set(type, resolve); frame(type, data, created); });
      const waitAt = async (point: string) => { if (point === phase) { entered(); await gate; } };
      const server = fakeOpenCode({
        "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; frame("server.connected", {}); } }), { headers: { "content-type": "text/event-stream" } }),
        "GET /api/session/ses_parent": () => session("ses_parent"),
        "GET /api/session/ses_child": async () => { if (++childReads === 2) await waitAt("final-ownership"); return session("ses_child", { parentID: "ses_parent" }); },
        "GET /api/session/ses_parent/message": async () => { await waitAt("parent-history"); return { data: change === "alias" ? [fixture.launch, fixture.converted] : [fixture.launch], cursor: {} }; },
        "GET /api/session/ses_child/message": async () => { await waitAt("child-history"); return { data: [], cursor: {} }; },
        "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
        "GET /api/session/active": () => ({ ses_child: { status: "running" } }),
        "GET /api/session/:id": ({ path }) => session(path.split("/").at(-1)!, { parentID: "ses_parent" }),
        "POST /api/session/ses_child/interrupt": () => ({ interrupted: true }),
      });
      const provider = server.provider(), controller = new AbortController();
      const pump = (async () => { for await (const event of provider.events(controller.signal)) {
        acknowledgements.get(event.eventType)?.(); acknowledgements.delete(event.eventType);
      } })();
      let stop: Promise<unknown> | undefined;
      try {
        await provider.waitForEventStream(controller.signal);
        await send("session.message.content.updated", { sessionID: "ses_parent", messageID: fixture.launch.id, content: fixture.launch.content });
        if (change === "alias") await send("session.message.content.updated", { sessionID: "ses_parent", messageID: fixture.converted.id, content: fixture.converted.content }, 60);
        stop = provider.stopTask("ses_parent", "v2:ses_parent:call_worker").catch(error => error);
        await started;
        if (change === "terminal" || change === "restart") await send(change === "terminal" ? "session.execution.succeeded" : "session.execution.started", { sessionID: "ses_child" }, 40);
        if (change === "launcher") {
          // Observe supersession inside the selected validation window. A
          // terminal already known before Stop now refuses before these reads.
          await send("session.execution.succeeded", { sessionID: "ses_child" }, 40);
          await send("session.message.content.updated", { sessionID: "ses_parent", messageID: fixture.converted.id, content: fixture.converted.content }, 60);
        }
        if (change === "alias") await send("session.message.content.updated", { sessionID: "ses_parent", messageID: fixture.converted.id, content: fixture.converted.content }, 61);
        if (change === "notification") await send("session.inbox.enqueued", { sessionID: "ses_parent", inboxID: fixture.pending.id, item: fixture.pending }, 41);
        if (change === "unrelated") {
          await send("session.execution.started", { sessionID: "unrelated_child" }, 40);
          const other = structuredClone(fixture.converted.content[0]); other.state.metadata.sessionID = "other_child";
          await send("session.message.content.updated", { sessionID: "ses_parent", messageID: "other_worker", content: [other] }, 60);
          await send("session.message.content.updated", { sessionID: "ses_parent", messageID: fixture.launch.id, content: [{ type: "text", text: "Still the same occurrence" }, ...fixture.launch.content] }, 61);
          await send("session.execution.succeeded", { sessionID: "another_parent" }, 62);
        }
        release();
        const result = await stop;
        const allowed = change === "unrelated" || change === "alias";
        expect(server.requests("POST", "/api/session/ses_child/interrupt")).toHaveLength(allowed ? 1 : 0);
        if (!allowed) expect(result).toMatchObject({ name: "BackgroundTaskUnavailableError" });
        else expect(result).toBeUndefined();
      } finally { release(); controller.abort(); await stop; await pump; await provider.dispose(); }
    });
  }
  for (const phase of ["parent", "parent-history", "inbox", "active", "ownership", "child-history", "final-ownership"] as const) {
    for (const change of ["child", "alias-child", "alias-foreground-missing-child", "foreground", "foreground-missing-child", "new-created", "new-ran", "alias-new-created", "alias-new-ran", "cold-new-created", "cold-new-ran", "cold-unchanged", "cold-alias-unchanged", "unchanged", "sibling-updated", "sibling-moved", "sibling-created", "sibling-deleted", "foreign-shutdown", "parent-updated", "parent-moved", "parent-created", "parent-deleted",
      "new-ran-then-progress", "new-created-then-progress", "changed-input-then-progress",
      "alias-new-ran-then-progress", "alias-new-created-then-progress", "alias-changed-input-then-progress",
      "cold-new-ran-then-progress", "cold-new-created-then-progress", "cold-changed-input-then-progress",
      "cold-alias-new-ran-then-progress", "cold-alias-new-created-then-progress", "cold-alias-changed-input-then-progress",
    ] as const) test(`Stop compares same-call target identity during ${phase} (${change})`, async () => {
      const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
      let stream!: ReadableStreamDefaultController<Uint8Array>, entered!: () => void, release!: () => void;
      let armed = false, used = false;
      const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
      const waitAt = async (point: string) => { if (armed && !used && phase === point) { used = true; entered(); await gate; } };
      const acknowledgements = new Map<string, () => void>();
      const frame = (type: string, data: unknown, created = 30, directory = WORKSPACE) => stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type, data, created, location: { directory } })}\n\n`));
      const send = (type: string, data: unknown, created?: number, directory?: string) => new Promise<void>(resolve => { acknowledgements.set(type, resolve); frame(type, data, created, directory); });
      const server = fakeOpenCode({
        "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; frame("server.connected", {}); } }), { headers: { "content-type": "text/event-stream" } }),
        "GET /api/session/ses_parent": async () => { await waitAt("parent"); return session("ses_parent"); },
        "GET /api/session/ses_parent/message": async () => { await waitAt("parent-history"); return { data: change.includes("alias-") ? [fixture.launch, fixture.converted] : [fixture.launch], cursor: {} }; },
        "GET /api/session/ses_parent/inbox": async () => { await waitAt("inbox"); return { data: [] }; },
        "GET /api/session/active": async () => { await waitAt("active"); return { ses_child: { status: "running" } }; },
        "GET /api/session/ses_child/message": async () => { await waitAt("child-history"); return { data: [], cursor: {} }; },
        "GET /api/session/ses_child": async () => { await waitAt(phase === "ownership" ? "ownership" : "final-ownership"); return session("ses_child", { parentID: "ses_parent" }); },
        "GET /api/session/:id": ({ path }) => session(path.split("/").at(-1)!, { parentID: "ses_parent" }),
        "POST /api/session/ses_child/interrupt": () => ({ interrupted: true }),
      });
      const provider = server.provider(), controller = new AbortController();
      const facts: unknown[] = [];
      const pump = (async () => { for await (const event of provider.events(controller.signal)) {
        facts.push(...event.updates);
        acknowledgements.get(event.eventType)?.(); acknowledgements.delete(event.eventType);
      } })();
      let stop: Promise<unknown> | undefined;
      try {
        await provider.waitForEventStream(controller.signal);
        const selected = change.includes("alias-") ? fixture.converted : fixture.launch;
        if (change.endsWith("then-progress")) await send("session.tool.input.started", { sessionID: "ses_parent", id: selected.content[0].id, name: "subagent", assistantMessageID: selected.id });
        if (!change.startsWith("cold-")) await send("session.message.content.updated", { sessionID: "ses_parent", messageID: fixture.launch.id, content: fixture.launch.content });
        if (!change.startsWith("cold-") && change.includes("alias-")) await send("session.message.content.updated", { sessionID: "ses_parent", messageID: fixture.converted.id, content: fixture.converted.content }, 60);
        if (phase === "ownership") await send("session.moved", { sessionID: "unrelated" });
        armed = true;
        stop = provider.stopTask("ses_parent", "v2:ses_parent:call_worker").catch(error => error);
        await started;
        const part = structuredClone(selected.content[0]);
        if (change === "child" || change === "alias-child") part.state.metadata.sessionID = "new_child";
        if (change.includes("foreground")) { part.state.status = "running"; part.state.input.background = false; }
        if (change.endsWith("missing-child")) delete part.state.metadata.sessionID;
        if (change.includes("new-created") || change.includes("new-ran")) { part.time[change.includes("new-created") ? "created" : "ran"] = 81; part.time.completed = 90; }
        if (change.includes("changed-input")) part.state.input.prompt = "Not the selected invocation";
        if (change.startsWith("sibling-")) await send(`session.${change.slice(8)}`, { sessionID: "other_sibling", title: "Unrelated update" }, 60);
        else if (change.startsWith("parent-")) await send(`session.${change.slice(7)}`, { sessionID: "ses_parent" }, 60);
        else if (change === "foreign-shutdown") await send("location.shutdown", {}, 60, "/other");
        else await send("session.message.content.updated", { sessionID: "ses_parent", messageID: change === "cold-alias-unchanged" ? selected.id : fixture.launch.id, content: [part] }, 60);
        if (change.endsWith("then-progress")) {
          await send("session.tool.progress", { sessionID: "ses_parent", id: part.id, assistantMessageID: selected.id, metadata: { sessionID: "ses_child", status: "running" } }, 100);
          // Neither ordinary progress nor a lagging restatement may erase the
          // native contradiction while recovery is still discovering aliases.
          await send("session.message.content.updated", { sessionID: "ses_parent", messageID: selected.id, content: selected.content }, 110);
          for (const evidence of stopEvidence(provider)) {
            expect(evidence.pendingBytes).toBe(evidencePayloadBytes(evidence));
            expect(evidence.pendingBytes).toBeLessThanOrEqual(1024 * 1024);
            expect(evidence.pendingChanges.size + evidence.pendingLaunches.size).toBeLessThanOrEqual(2_048);
          }
        }
        if (change === "child" || change === "alias-child") expect(facts).toContainEqual(expect.objectContaining({ kind: "upsert", item: expect.objectContaining({ type: "tool", id: `tool:${part.id}`, childConversationId: "new_child" }) }));
        release();
        const result = await stop;
        const allowed = change !== "child" && !change.startsWith("alias-") && !change.startsWith("foreground") && !change.startsWith("parent-") && !change.includes("new-") && !change.includes("changed-input");
        expect(server.requests("POST", "/api/session/ses_child/interrupt")).toHaveLength(allowed ? 1 : 0);
        if (!allowed) expect(result).toMatchObject({ name: "BackgroundTaskUnavailableError" });
        else expect(result).toBeUndefined();
        if (change.endsWith("then-progress")) expect(stopEvidence(provider)).toHaveLength(0);
      } finally { release(); controller.abort(); await stop; await pump; await provider.dispose(); }
    });
  }
  for (const phase of ["parent", "parent-history", "inbox", "active", "ownership", "child-history", "final-ownership"] as const) {
    for (const alias of [false, true]) for (const [form, allowed] of [
      ["foreground invocation", false], ["background invocation", false], ["invocation child replacement", false],
      ["invocation without child", false], ["invocation without background", false], ["invocation without name", false],
      ["same-child progress", true], ["changed-child progress", false], ["lowercase-child progress", false], ["empty progress", true],
      ["same-child success", true], ["success without metadata", true], ["changed-child success", false],
      ["same-child failure", true], ["failure without metadata", true], ["changed-child failure", false],
      ["input delta", true], ["input ended", true], ["input started", true],
      ["unrelated invocation", true], ["unknown unrelated invocation", true], ["other-child invocation", true],
      ["new foreground launcher", false], ["new background launcher", false],
      ["empty progress after invocation", false], ["metadata-free success after invocation", false],
      ["properties changed-child progress", false], ["sessionId changed-child progress", false],
      ["properties same-child progress", true], ["sessionId same-child progress", true],
      ["properties execution restart", false], ["sessionId execution restart", false], ["lifecycle info identity", false],
      ["foreign lifecycle info identity", false],
      ["consumed invocation replay", true], ["new identity old-clock invocation", false], ["contradictory consumed invocation", false],
      ["consumed terminal replay", true], ["consumed notification replay", true],
      ["consumed execution-start replay", true],
      ["first-seen backdated terminal", false], ["first-seen backdated notification", false],
    ] as const) test(`Stop observes typed ${form} during ${phase} (${alias ? "folded alias" : "selected call"})`, async () => {
      const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
      let stream!: ReadableStreamDefaultController<Uint8Array>, entered!: () => void, release!: () => void;
      let armed = false, used = false;
      const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
      const waitAt = async (point: string) => { if (armed && !used && phase === point) { used = true; entered(); await gate; } };
      const acknowledgements = new Map<string, () => void>();
      let sequence = 0;
      let lastFrame: Record<string, unknown>;
      const frame = (type: string, data: unknown, created = 30) => { lastFrame = {
        id: `typed_event${++sequence}`, type, data, created, location: { directory: WORKSPACE },
        ...(["session.message.content.updated", "session.tool.input.started", "session.tool.input.ended", "session.tool.called", "session.tool.success", "session.tool.failed"].includes(type)
          ? { durable: { aggregateID: "ses_parent", seq: sequence, version: type === "session.tool.success" || type === "session.tool.failed" ? 2 : 1 } } : {}),
      }; stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(lastFrame)}\n\n`)); };
      const send = (type: string, data: unknown) => new Promise<void>(resolve => { acknowledgements.set(type, resolve); frame(type, data, 60); });
      const server = fakeOpenCode({
        "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; frame("server.connected", {}); } }), { headers: { "content-type": "text/event-stream" } }),
        "GET /api/session/ses_parent": async () => { await waitAt("parent"); return session("ses_parent"); },
        "GET /api/session/ses_parent/message": async () => { await waitAt("parent-history"); return { data: alias ? [fixture.launch, fixture.converted] : [fixture.launch], cursor: {} }; },
        "GET /api/session/ses_parent/inbox": async () => { await waitAt("inbox"); return { data: [] }; },
        "GET /api/session/active": async () => { await waitAt("active"); return { ses_child: { status: "running" } }; },
        "GET /api/session/ses_child/message": async () => { await waitAt("child-history"); return { data: [], cursor: {} }; },
        "GET /api/session/ses_child": async () => { await waitAt(phase === "ownership" ? "ownership" : "final-ownership"); return session("ses_child", { parentID: "ses_parent" }); },
        "GET /api/session/:id": ({ path }) => session(path.split("/").at(-1)!, { parentID: "ses_parent" }),
        "POST /api/session/ses_child/interrupt": () => ({ interrupted: true }),
      });
      const provider = server.provider(), controller = new AbortController();
      const facts: unknown[] = [];
      const pump = (async () => { for await (const event of provider.events(controller.signal)) {
        facts.push(...event.updates);
        acknowledgements.get(event.eventType)?.(); acknowledgements.delete(event.eventType);
      } })();
      let stop: Promise<unknown> | undefined;
      try {
        await provider.waitForEventStream(controller.signal);
        let consumed: Record<string, unknown> | undefined;
        if (form === "consumed execution-start replay") {
          await new Promise<void>(resolve => { acknowledgements.set("session.execution.started", resolve); frame("session.execution.started", { sessionID: "ses_child" }, 10); });
          consumed = structuredClone(lastFrame!);
        }
        if (form === "consumed terminal replay" || form === "consumed notification replay") {
          const old = structuredClone(fixture.launch);
          old.id = "old_message"; old.content[0].id = "old_call"; old.content[0].time = { created: 1, completed: 2 };
          await send("session.message.content.updated", { sessionID: "ses_parent", messageID: old.id, content: old.content });
          const type = form === "consumed terminal replay" ? "session.execution.succeeded" : "session.inbox.enqueued";
          const data = form === "consumed terminal replay" ? { sessionID: "ses_child" } : { sessionID: "ses_parent", inboxID: "old_notice", item: fixture.pending };
          await new Promise<void>(resolve => { acknowledgements.set(type, resolve); frame(type, data, 3); });
          consumed = structuredClone(lastFrame!);
        }
        if (form === "consumed invocation replay" || form === "contradictory consumed invocation") {
          const prior = alias ? fixture.converted : fixture.launch;
          await send("session.tool.input.started", { sessionID: "ses_parent", id: prior.content[0].id, name: "subagent" });
          await send("session.tool.called", { sessionID: "ses_parent", id: prior.content[0].id, assistantMessageID: prior.id, executed: true, input: prior.content[0].state.input });
          consumed = structuredClone(lastFrame!);
        }
        await send("session.message.content.updated", { sessionID: "ses_parent", messageID: fixture.launch.id, content: fixture.launch.content });
        if (alias) await send("session.message.content.updated", { sessionID: "ses_parent", messageID: fixture.converted.id, content: fixture.converted.content });
        const part = alias ? fixture.converted.content[0] : fixture.launch.content[0];
        const assistantMessageID = alias ? fixture.converted.id : fixture.launch.id;
        if (form !== "invocation without name") await send("session.tool.input.started", { sessionID: "ses_parent", id: part.id, name: "subagent", assistantMessageID });
        const otherCall = form === "unrelated invocation" || form === "unknown unrelated invocation" || form === "other-child invocation" || form === "new foreground launcher" || form === "new background launcher";
        if (otherCall && form !== "unknown unrelated invocation") await send("session.tool.input.started", { sessionID: "ses_parent", id: "another_call", name: form === "unrelated invocation" ? "read" : "subagent", assistantMessageID });
        if (phase === "ownership") await send("session.moved", { sessionID: "unrelated" });
        armed = true;
        stop = provider.stopTask("ses_parent", "v2:ses_parent:call_worker").catch(error => error);
        await started;
        const common = { sessionID: "ses_parent", id: otherCall ? "another_call" : part.id, assistantMessageID };
        const input: Record<string, unknown> = { ...part.state.input, background: form === "background invocation" || form === "new background launcher", sessionID: form === "invocation child replacement" ? "new_child" : form === "other-child invocation" ? "other_child" : "ses_child" };
        if (form === "invocation without child") delete input.sessionID;
        if (form === "invocation without background") delete input.background;
        switch (form) {
          case "properties changed-child progress": case "sessionId changed-child progress": case "properties same-child progress": case "sessionId same-child progress": case "properties execution restart": case "sessionId execution restart": case "lifecycle info identity": case "foreign lifecycle info identity": {
            const restart = form.includes("restart");
            const type = form.includes("lifecycle info") ? "session.updated" : restart ? "session.execution.started" : "session.tool.progress";
            const data = form.includes("lifecycle info") ? { info: { id: "ses_child", directory: "/foreign", parentID: "other", title: "Moved" } }
              : restart ? { [form.startsWith("sessionId") ? "sessionId" : "sessionID"]: "ses_child" }
                : { ...common, ...(form.startsWith("sessionId") ? { sessionID: undefined, sessionId: "ses_parent" } : {}), metadata: { sessionID: form.includes("same-child") ? "ses_child" : "new_child", status: "running" } };
            await new Promise<void>(resolve => { acknowledgements.set(type, resolve); const raw = { type, created: 60, location: { directory: form.startsWith("foreign") ? "/foreign" : WORKSPACE }, [form.startsWith("properties") ? "properties" : "data"]: data }; stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(raw)}\n\n`)); });
            break;
          }
          case "consumed invocation replay": case "contradictory consumed invocation": {
            const raw = structuredClone(consumed!);
            if (form === "contradictory consumed invocation") (raw.data as Record<string, unknown>).input = { ...input, prompt: "Not the consumed invocation" };
            await new Promise<void>(resolve => { acknowledgements.set("session.tool.called", resolve); stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(raw)}\n\n`)); });
            break;
          }
          case "consumed terminal replay": case "consumed notification replay": case "consumed execution-start replay": {
            await new Promise<void>(resolve => { acknowledgements.set(consumed!.type as string, resolve); stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(consumed)}\n\n`)); });
            break;
          }
          case "first-seen backdated terminal": case "first-seen backdated notification": {
            const type = form === "first-seen backdated terminal" ? "session.execution.succeeded" : "session.inbox.enqueued";
            const data = form === "first-seen backdated terminal" ? { sessionID: "ses_child" } : { sessionID: "ses_parent", inboxID: "unseen_notice", item: fixture.pending };
            await new Promise<void>(resolve => { acknowledgements.set(type, resolve); frame(type, data, 1); });
            break;
          }
          case "new identity old-clock invocation": await new Promise<void>(resolve => { acknowledgements.set("session.tool.called", resolve); frame("session.tool.called", { ...common, executed: true, input }, 1); }); break;
          case "same-child progress": case "changed-child progress": case "lowercase-child progress": case "empty progress":
            await send("session.tool.progress", { ...common, metadata: form === "empty progress" ? {} : form === "lowercase-child progress" ? { sessionId: "new_child", status: "running" } : { sessionID: form === "changed-child progress" ? "new_child" : "ses_child", status: "running" } });
            break;
          case "same-child success": case "success without metadata": case "changed-child success":
            await send("session.tool.success", { ...common, executed: true, content: [{ type: "text", text: "Previously reported launcher result" }], ...(form === "success without metadata" ? {} : { metadata: { sessionID: form === "changed-child success" ? "new_child" : "ses_child", status: "running" } }) });
            break;
          case "same-child failure": case "failure without metadata": case "changed-child failure":
            await send("session.tool.failed", { ...common, executed: true, error: { type: "unknown", message: "Previously reported launcher error" }, ...(form === "failure without metadata" ? {} : { metadata: { sessionID: form === "changed-child failure" ? "new_child" : "ses_child", status: "running" } }) });
            break;
          case "input delta": await send("session.tool.input.delta", { ...common, delta: JSON.stringify(input) }); break;
          case "input ended": await send("session.tool.input.ended", { ...common, text: JSON.stringify(input) }); break;
          case "input started": await send("session.tool.input.started", { ...common, name: "subagent" }); break;
          case "empty progress after invocation":
            await send("session.tool.called", { ...common, executed: true, input });
            await send("session.tool.progress", { ...common, metadata: {} });
            break;
          case "metadata-free success after invocation":
            await send("session.tool.called", { ...common, executed: true, input });
            await send("session.tool.success", { ...common, executed: true, content: [{ type: "text", text: "Old report cannot clear the new invocation" }] });
            break;
          default: await send("session.tool.called", { ...common, executed: true, input });
        }
        if (form === "foreground invocation") expect(facts).toContainEqual(expect.objectContaining({ kind: "upsert", item: expect.objectContaining({ id: `tool:${part.id}`, type: "tool", name: "subagent", status: "running" }) }));
        if (form === "invocation child replacement") expect(server.requests("GET", "/api/session/new_child")).toHaveLength(0); // Request intent is never ownership proof.
        release();
        const result = await stop;
        expect(server.requests("POST", "/api/session/ses_child/interrupt")).toHaveLength(allowed ? 1 : 0);
        if (allowed) expect(result).toBeUndefined();
        else expect(result).toMatchObject({ name: "BackgroundTaskUnavailableError" });
      } finally { release(); controller.abort(); await stop; await pump; await provider.dispose(); }
    });
  }
  test("Stop discovery overflow keeps unretained targets unavailable while retained healthy controls survive the same flood", async () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    const retained = structuredClone(fixture.launch);
    retained.id = "retained_message"; retained.content[0].id = "retained_call"; retained.content[0].state.metadata.sessionID = "retained_child";
    let stream!: ReadableStreamDefaultController<Uint8Array>, entered!: () => void, release!: () => void, acknowledge: (() => void) | undefined;
    let history = [fixture.launch, retained];
    const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const frame = (type: string, data: unknown) => stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type, data, created: 40, location: { directory: WORKSPACE } })}\n\n`));
    const server = fakeOpenCode({
      "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; frame("server.connected", {}); } }), { headers: { "content-type": "text/event-stream" } }),
      "GET /api/session/ses_parent/message": async () => { entered(); await gate; return { data: history, cursor: {} }; },
      "GET /api/session/:id/message": () => ({ data: [], cursor: {} }),
      "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
      "GET /api/session/active": () => ({ ses_child: { status: "running" }, later_child: { status: "running" }, retained_child: { status: "running" } }),
      "GET /api/session/:id": ({ path }) => session(path.split("/").at(-1)!, { parentID: "ses_parent" }),
      "POST /api/session/:id/interrupt": () => ({ interrupted: true }),
    });
    const provider = server.provider(), controller = new AbortController();
    const published: import("../../types").BackgroundTaskItem[] = [];
    const pump = (async () => { for await (const event of provider.events(controller.signal)) {
      for (const update of event.updates) if (update.kind === "upsert" && update.item.type === "background_task") published.push(update.item);
      if (event.eventType === "session.execution.started" || event.eventType === "session.message.content.updated") { acknowledge?.(); acknowledge = undefined; }
    } })();
    let stop: Promise<unknown> | undefined;
    try {
      await provider.waitForEventStream(controller.signal);
      await new Promise<void>(resolve => { acknowledge = resolve; frame("session.message.content.updated", { sessionID: "ses_parent", messageID: retained.id, content: retained.content }); });
      expect(published).toContainEqual(expect.objectContaining({ taskId: "v2:ses_parent:retained_call", status: "running", stateUncertain: false }));
      stop = provider.stopTask("ses_parent", "v2:ses_parent:call_worker").catch(error => error);
      await started;
      for (let index = 0; index <= 2_048; index++) await new Promise<void>(resolve => { acknowledge = resolve; frame("session.execution.started", { sessionID: index === 2_048 ? "ses_child" : `candidate${index}` }); });
      release();
      expect(await stop).toMatchObject({ name: "BackgroundTaskUnavailableError" });
      expect(server.calls.filter(call => call.method === "POST")).toHaveLength(0);
      const later = structuredClone(fixture.launch);
      later.id = "later_message"; later.content[0].id = "later_call"; later.content[0].state.metadata.sessionID = "later_child";
      history = [later, retained];
      // Lead-approved bounded-cohort policy: the old expectation admitted this
      // previously unretained identity from history after 2,049 unknown facts.
      // Lost coverage now stays unavailable for this provider's lifetime;
      // retiring the transient Stop guard must not recreate control trust.
      const recovered = await provider.reconcileBackgroundTasks("ses_parent", { fresh: true });
      expect(recovered).toContainEqual(expect.objectContaining({ taskId: "v2:ses_parent:later_call", status: "running", stateUncertain: true }));
      expect(recovered).toContainEqual(expect.objectContaining({ taskId: "v2:ses_parent:retained_call", status: "running", stateUncertain: false }));
      await expect(provider.stopTask("ses_parent", "v2:ses_parent:later_call")).rejects.toMatchObject({ name: "BackgroundTaskUnavailableError" });
      expect(server.requests("POST", "/api/session/later_child/interrupt")).toHaveLength(0);
      expect(server.calls.filter(call => call.method === "POST")).toHaveLength(0);
      await provider.stopTask("ses_parent", "v2:ses_parent:retained_call");
      expect(server.requests("POST", "/api/session/retained_child/interrupt")).toHaveLength(1);
      expect(server.calls.filter(call => call.method === "POST")).toEqual([expect.objectContaining({ path: "/api/session/retained_child/interrupt" })]);
      expect(server.requests("GET", "/api/event")).toHaveLength(1);
    } finally { release(); controller.abort(); await stop; await pump; await provider.dispose(); }
  });
  test("Stop admits at most four concurrent authorizations without an unbounded validation queue", async () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const history = Array.from({ length: 4 }, (_, index) => {
      const message = structuredClone(fixture.launch);
      message.id = `message${index}`; message.content[0].id = `call${index}`; message.content[0].state.metadata.sessionID = `child${index}`;
      return message;
    });
    const server = fakeOpenCode({
      "GET /api/session/ses_parent": async () => { entered(); await gate; return session("ses_parent"); },
      "GET /api/session/ses_parent/message": () => ({ data: history, cursor: {} }),
      "GET /api/session/:id/message": () => ({ data: [], cursor: {} }),
      "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
      "GET /api/session/active": () => Object.fromEntries(Array.from({ length: 4 }, (_, index) => [`child${index}`, { status: "running" }])),
      "GET /api/session/:id": ({ path }) => session(path.split("/").at(-1)!, { parentID: "ses_parent" }),
      "POST /api/session/:id/interrupt": () => ({ interrupted: true }),
    });
    const provider = server.provider();
    const stops = Array.from({ length: 4 }, (_, index) => provider.stopTask("ses_parent", `v2:ses_parent:call${index}`));
    try {
      await started;
      await expect(provider.stopTask("ses_parent", "v2:ses_parent:call0")).rejects.toThrow("capacity");
      expect(server.calls.filter(call => call.method === "POST")).toHaveLength(0);
      release(); await Promise.all(stops);
      expect(server.calls.filter(call => call.method === "POST")).toHaveLength(4);
    } finally { release(); await Promise.allSettled(stops); await provider.dispose(); }
  });
  for (const escaped of [false, true]) test(`Stop accounts complete candidate payloads at the byte limit (${escaped ? "escaped Unicode" : "maximum strings"})`, async () => {
    let stream!: ReadableStreamDefaultController<Uint8Array>, entered!: () => void, release!: () => void, acknowledge: (() => void) | undefined;
    let fail = false;
    const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const frame = (type: string, data: unknown) => stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type, data, created: 30, location: { directory: WORKSPACE } })}\n\n`));
    const server = fakeOpenCode({
      "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; frame("server.connected", {}); } }), { headers: { "content-type": "text/event-stream" } }),
      "GET /api/session/ses_parent/message": async () => { entered(); await gate; if (fail) throw new Error("Intentional history failure"); return { data: [], cursor: {} }; },
      "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
      "GET /api/session/active": () => ({}),
      "GET /api/session/:id": ({ path }) => session(path.split("/").at(-1)!, { parentID: "ses_parent" }),
    });
    const provider = server.provider(), controller = new AbortController();
    const pump = (async () => { for await (const event of provider.events(controller.signal)) if (event.eventType === "session.tool.progress") { acknowledge?.(); acknowledge = undefined; } })();
    const stops: Promise<unknown>[] = [];
    try {
      await provider.waitForEventStream(controller.signal);
      for (let index = 0; index < 4; index++) stops.push(provider.stopTask("ses_parent", `v2:ses_parent:target${index}`).catch(error => error));
      await started;
      const retained = stopEvidence(provider);
      expect(retained).toHaveLength(4);
      let overflow = false;
      for (let index = 0; index < 600; index++) {
        const call = `${index}:`.padEnd(512, escaped ? '\\"\n\ud800' : "x").slice(0, 512);
        await new Promise<void>(resolve => { acknowledge = resolve; frame("session.tool.progress", { sessionID: "ses_parent", id: call, metadata: { sessionID: "c".repeat(512) } }); });
        for (const evidence of retained) {
          const payload = evidencePayloadBytes(evidence);
          expect(evidence.pendingBytes).toBe(payload);
          expect(payload).toBeLessThanOrEqual(1024 * 1024);
          expect(evidence.pendingChanges.size + evidence.pendingLaunches.size).toBeLessThanOrEqual(2_048);
        }
        expect(retained.reduce((bytes, evidence) => bytes + evidencePayloadBytes(evidence), 0)).toBeLessThanOrEqual(4 * 1024 * 1024);
        if (retained.every(evidence => evidence.changed)) { overflow = true; break; }
      }
      expect(overflow).toBe(true);
      release();
      for (const result of await Promise.all(stops)) expect(result).toMatchObject({ name: "BackgroundTaskUnavailableError" });
      expect(stopEvidence(provider)).toHaveLength(0);
      for (const evidence of retained) {
        expect(evidence.pendingChanges.size + evidence.pendingLaunches.size).toBe(0);
        expect(evidence.pendingBytes).toBe(evidencePayloadBytes(evidence));
      }
      fail = true;
      for (let index = 0; index < 5; index++) {
        await expect(provider.stopTask("ses_parent", "v2:ses_parent:failed")).rejects.toThrow();
        expect(stopEvidence(provider)).toHaveLength(0);
      }
      expect(server.calls.every(call => call.method === "GET")).toBe(true);
    } finally { release(); controller.abort(); await Promise.allSettled(stops); await pump; await provider.dispose(); }
  });
  test("Stop evidence replacement and pruning keep an exact incremental payload ledger", async () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    let stream!: ReadableStreamDefaultController<Uint8Array>, entered!: () => void, release!: () => void;
    let ownershipEntered!: () => void, releaseOwnership!: () => void, finalEntered!: () => void, releaseFinal!: () => void, reads = 0;
    const started = new Promise<void>(resolve => { entered = resolve; }), historyGate = new Promise<void>(resolve => { release = resolve; });
    const ownershipStarted = new Promise<void>(resolve => { ownershipEntered = resolve; }), ownershipGate = new Promise<void>(resolve => { releaseOwnership = resolve; });
    const finalStarted = new Promise<void>(resolve => { finalEntered = resolve; }), finalGate = new Promise<void>(resolve => { releaseFinal = resolve; });
    const acknowledgements = new Map<string, () => void>();
    const frame = (type: string, data: unknown) => stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type, data, created: 30, location: { directory: WORKSPACE } })}\n\n`));
    const send = (type: string, data: unknown) => new Promise<void>(resolve => { acknowledgements.set(type, resolve); frame(type, data); });
    const server = fakeOpenCode({
      "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; frame("server.connected", {}); } }), { headers: { "content-type": "text/event-stream" } }),
      "GET /api/session/ses_parent/message": async () => { entered(); await historyGate; return { data: [fixture.launch], cursor: {} }; },
      "GET /api/session/ses_child": async () => {
        if (++reads === 2) { ownershipEntered(); await ownershipGate; }
        if (reads === 3) { finalEntered(); await finalGate; }
        return session("ses_child", { parentID: "ses_parent" });
      },
      "GET /api/session/:id/message": () => ({ data: [], cursor: {} }),
      "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
      "GET /api/session/active": () => ({ ses_child: { status: "running" } }),
      "GET /api/session/:id": ({ path }) => session(path.split("/").at(-1)!, { parentID: "ses_parent" }),
      "POST /api/session/ses_child/interrupt": () => ({ interrupted: true }),
    });
    const provider = server.provider(), controller = new AbortController();
    const pump = (async () => { for await (const event of provider.events(controller.signal)) { acknowledgements.get(event.eventType)?.(); acknowledgements.delete(event.eventType); } })();
    let stop: Promise<unknown> | undefined;
    try {
      await provider.waitForEventStream(controller.signal);
      stop = provider.stopTask("ses_parent", "v2:ses_parent:call_worker").catch(error => error);
      await started;
      const evidence = stopEvidence(provider)[0]!;
      const exact = () => { expect(evidence.pendingBytes).toBe(evidencePayloadBytes(evidence)); expect(evidence.changed).toBe(false); };
      await send("session.execution.started", { sessionID: "other_execution" }); exact();
      await send("session.tool.called", { sessionID: "ses_parent", assistantMessageID: "third_message", id: "restricted_call", executed: true, input: { sessionID: "third_child", background: false } }); exact();
      expect(server.requests("GET", "/api/session/third_child")).toHaveLength(0);
      const restrictedBytes = evidence.pendingBytes;
      await send("session.tool.progress", { sessionID: "ses_parent", assistantMessageID: "third_message", id: "restricted_call", metadata: { sessionID: "third_child", status: "running" } }); exact();
      expect(evidence.pendingBytes).toBeLessThan(restrictedBytes); // Stronger reported provenance removes the restriction field.
      const part = structuredClone(fixture.launch.content[0]);
      part.id = 'other\\"call🚀'; part.state.metadata.sessionID = "other_child";
      await send("session.tool.progress", { sessionID: "ses_parent", id: part.id, metadata: { sessionID: "other_child" } }); exact();
      const before = evidence.pendingBytes;
      await send("session.message.content.updated", { sessionID: "ses_parent", messageID: "other_message", content: [part] }); exact();
      expect(evidence.pendingBytes).toBeGreaterThan(before);
      const backgroundBytes = evidence.pendingBytes;
      part.state.status = "running";
      await send("session.message.content.updated", { sessionID: "ses_parent", messageID: "other_message", content: [part] }); exact();
      expect(evidence.pendingBytes).toBe(backgroundBytes + 2); // JSON false versus true.
      const foregroundBytes = evidence.pendingBytes;
      part.state.status = "completed";
      await send("session.message.content.updated", { sessionID: "ses_parent", messageID: "other_message", content: [part] }); exact();
      expect(evidence.pendingBytes).toBe(foregroundBytes); // Preserve the earlier contradictory fact.
      await send("session.tool.progress", { sessionID: "ses_parent", id: "call_worker", metadata: { sessionID: "ses_child" } }); exact();
      await send("session.moved", { sessionID: "unrelated" }); exact();
      expect(evidence.pendingChanges.size).toBeGreaterThan(0);
      release(); await ownershipStarted;
      expect(evidence.pendingChanges.size).toBe(0);
      expect(evidence.pendingLaunches.size).toBe(3); exact();
      releaseOwnership(); await finalStarted;
      expect(evidence.pendingChanges.size + evidence.pendingLaunches.size).toBe(0); exact();
      releaseFinal();
      expect(await stop).toBeUndefined();
      expect(stopEvidence(provider)).toHaveLength(0);
      expect(evidence.pendingBytes).toBe(evidencePayloadBytes(evidence));
      expect(server.requests("POST", "/api/session/ses_child/interrupt")).toHaveLength(1);
    } finally { release(); releaseOwnership(); releaseFinal(); controller.abort(); await stop; await pump; await provider.dispose(); }
  });
  for (const phase of ["previous-recovery", "parent", "history", "inbox", "active", "ownership", "child-history", "final-ownership"] as const) {
    for (const lifecycle of ["session.moved", "session.deleted", "location.shutdown", "reconnect"] as const) test(`Stop refuses ${lifecycle} during ${phase} without dispatching a child mutation`, async () => {
      const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
      let stream!: ReadableStreamDefaultController<Uint8Array>, entered!: () => void, release!: () => void;
      let blocking = false, enteredOnce = false, foreign = false, childReads = 0;
      const started = new Promise<void>(resolve => { entered = resolve; });
      const gate = new Promise<void>(resolve => { release = resolve; });
      const waitAt = async (point: string) => {
        if (!blocking || enteredOnce || point !== (phase === "previous-recovery" ? "child-history" : phase)) return;
        enteredOnce = true; entered(); await gate;
      };
      const acknowledgements = new Map<string, () => void>();
      const frame = (type: string, data: unknown) => stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type, data, location: { directory: WORKSPACE }, created: 30 })}\n\n`));
      const send = (type: string, data: unknown) => new Promise<void>(resolve => { acknowledgements.set(type, resolve); frame(type, data); });
      const server = fakeOpenCode({
        "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; frame("server.connected", {}); } }), { headers: { "content-type": "text/event-stream" } }),
        "GET /api/session/ses_parent": async () => { await waitAt("parent"); return session("ses_parent"); },
        "GET /api/session/ses_child": async () => {
          if (++childReads > 1) await waitAt(phase === "ownership" ? "ownership" : "final-ownership");
          return session("ses_child", { parentID: "ses_parent", location: { directory: foreign ? "/other" : WORKSPACE } });
        },
        "GET /api/session/ses_parent/message": async () => { await waitAt("history"); return { data: [fixture.launch], cursor: {} }; },
        "GET /api/session/ses_parent/inbox": async () => { await waitAt("inbox"); return { data: [] }; },
        "GET /api/session/active": async () => { await waitAt("active"); return { ses_child: { status: "running" } }; },
        "GET /api/session/ses_child/message": async () => { await waitAt("child-history"); return { data: [], cursor: {} }; },
        "POST /api/session/ses_child/interrupt": () => ({ interrupted: true }),
      });
      const provider = server.provider();
      let controller = new AbortController();
      const consume = () => (async () => { for await (const event of provider.events(controller.signal)) {
        acknowledgements.get(event.eventType)?.(); acknowledgements.delete(event.eventType);
      } })();
      let pump = consume(), stop: Promise<unknown> | undefined, previous: Promise<unknown> | undefined;
      try {
        await provider.waitForEventStream(controller.signal);
        await send("session.message.content.updated", { sessionID: "ses_parent", messageID: fixture.launch.id, content: fixture.launch.content });
        // Force a new ordinary verification only for the lookup-await case;
        // other cases deliberately exercise already-cached ownership.
        if (phase === "ownership") await send("session.moved", { sessionID: "unrelated" });
        blocking = true;
        if (phase === "previous-recovery") {
          previous = provider.reconcileBackgroundTasks("ses_parent").catch(error => error);
          await started;
        }
        stop = provider.stopTask("ses_parent", "v2:ses_parent:call_worker").catch(error => error);
        await started;
        foreign = true;
        if (lifecycle === "reconnect") {
          controller.abort(); await pump;
          controller = new AbortController(); pump = consume();
          await provider.waitForEventStream(controller.signal);
        } else await send(lifecycle, lifecycle === "location.shutdown" ? {} : { sessionID: "ses_child", location: { directory: "/other" } });
        release();
        const result = await stop;
        expect(server.requests("POST", "/api/session/ses_child/interrupt")).toHaveLength(0);
        expect(result).toMatchObject({ name: "BackgroundTaskUnavailableError" });
      } finally { release(); controller.abort(); await stop; await previous; await pump; await provider.dispose(); }
    });
  }
  for (const foreign of ["workspace", "parent"] as const) test(`Stop bypasses cached ownership and refuses a fresh mismatched ${foreign}`, async () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    let childReads = 0;
    const server = fakeOpenCode({
      "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('data: {"type":"server.connected","data":{}}\n\n')); } }), { headers: { "content-type": "text/event-stream" } }),
      "GET /api/session/ses_parent": () => session("ses_parent"),
      "GET /api/session/ses_child": () => session("ses_child", { parentID: ++childReads > 1 && foreign === "parent" ? "other" : "ses_parent", location: { directory: childReads > 1 && foreign === "workspace" ? "/other" : WORKSPACE } }),
      "GET /api/session/ses_parent/message": () => ({ data: [fixture.launch], cursor: {} }),
      "GET /api/session/ses_child/message": () => ({ data: [], cursor: {} }),
      "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
      "GET /api/session/active": () => ({ ses_child: { status: "running" } }),
      "POST /api/session/ses_child/interrupt": () => ({ interrupted: true }),
    });
    const provider = server.provider(), controller = new AbortController();
    const events = provider.events(controller.signal)[Symbol.asyncIterator]();
    try {
      await events.next();
      expect(await provider.reconcileBackgroundTasks("ses_parent")).toContainEqual(expect.objectContaining({ status: "running", stateUncertain: false }));
      await expect(provider.stopTask("ses_parent", "v2:ses_parent:call_worker")).rejects.toMatchObject({ name: "BackgroundTaskUnavailableError" });
      expect(childReads).toBe(2);
      expect(server.requests("POST", "/api/session/ses_child/interrupt")).toHaveLength(0);
    } finally { controller.abort(); await events.return?.(); await provider.dispose(); }
  });
  test("worker stop does not authorize from a recovery read that predates the stop request", async () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const reading = new Promise<void>(resolve => { started = resolve; });
    let reads = 0;
    const server = fakeOpenCode({
      "GET /api/session/active": () => ({ ses_child: { status: "running" } }),
      "GET /api/session/:id": ({ path }) => session(path.split("/").at(-1)!, path.endsWith("ses_child") ? { parentID: "ses_parent" } : {}),
      "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
      "GET /api/session/ses_child/message": () => ({ data: [{ id: "idle", type: "idle", time: { created: 40 } }], cursor: {} }),
      "GET /api/session/ses_parent/message": async () => {
        if (++reads === 1) { started(); await gate; return { data: [fixture.launch], cursor: {} }; }
        return { data: [fixture.launch, fixture.stored, fixture.converted], cursor: {} };
      },
      "POST /api/session/ses_child/interrupt": () => ({ interrupted: true }),
    });
    const provider = server.provider();
    const recovery = provider.reconcileBackgroundTasks("ses_parent");
    await reading;
    const stop = provider.stopTask("ses_parent", "v2:ses_parent:call_worker");
    release();
    // Even the older parent read cannot authorize a task past the child's
    // independently observed execution boundary.
    expect(await recovery).toContainEqual(expect.objectContaining({ toolUseId: "call_worker", stateUncertain: true }));
    await expect(stop).rejects.toThrow(/no longer confirmed/);
    expect(server.requests("POST", "/api/session/ses_child/interrupt")).toHaveLength(0);
  });
  for (const withForegroundLauncher of [false, true]) test(`an unresolved old background task cannot stop a newer child occurrence (${withForegroundLauncher ? "foreground launcher running" : "external child continuation"})`, async () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    const foreground = structuredClone(fixture.converted);
    foreground.content[0].state.status = "running";
    foreground.content[0].time = { created: 50 };
    foreground.time = { created: 50 };
    const server = fakeOpenCode({
      "GET /api/session/active": () => ({ ses_child: { status: "running" } }),
      "GET /api/session/:id": ({ path }) => session(path.split("/").at(-1)!, path.endsWith("ses_child") ? { parentID: "ses_parent" } : {}),
      "GET /api/session/ses_parent/message": () => ({ data: withForegroundLauncher ? [fixture.launch, foreground] : [fixture.launch], cursor: {} }),
      "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
      "GET /api/session/ses_child/message": () => ({ data: [
        { id: "idle-old", type: "idle", time: { created: 40 } },
        { id: "prompt-new", type: "user", text: "New foreground occurrence", time: { created: 50 } },
      ], cursor: {} }),
      "POST /api/session/ses_child/interrupt": () => ({ interrupted: true }),
    });
    const provider = server.provider();
    expect(await provider.reconcileBackgroundTasks("ses_parent")).toContainEqual(expect.objectContaining({ taskId: "v2:ses_parent:call_worker", status: "running", stateUncertain: true }));
    await expect(provider.stopTask("ses_parent", "v2:ses_parent:call_worker")).rejects.toThrow(/no longer confirmed/);
    expect(server.requests("POST", "/api/session/ses_child/interrupt")).toHaveLength(0);
  });
  for (const owner of ["ses_parent", "foreign_parent"]) test(`cold shell output keeps confinement without manufacturing retained Stop proof (${owner})`, async () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    let reads = 0;
    const server = fakeOpenCode({
      "GET /api/session/active": () => ({}),
      "GET /api/session/ses_parent": () => session("ses_parent"),
      "GET /api/session/ses_parent/message": () => ({ data: [fixture.shell], cursor: {} }),
      "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
      "GET /api/shell/sh_fixture": () => scoped(nativeShellInfo("sh_fixture", ++reads === 2 ? owner : "ses_parent")),
      "GET /api/shell/sh_fixture/output": () => scoped({ output: "tail", size: 4, cursor: 4, truncated: false }),
      "DELETE /api/shell/sh_fixture": () => undefined,
    });
    const provider = server.provider();
    try {
      const output = provider.taskOutput("ses_parent", "v2:ses_parent:call_shell", { tailBytes: 4 });
      if (owner === "ses_parent") expect(await output).toMatchObject({ text: "tail" });
      else await expect(output).rejects.toMatchObject({ name: "BackgroundTaskUnavailableError" });
      expect(server.requests("GET", "/api/shell/sh_fixture/output")).toHaveLength(owner === "ses_parent" ? 2 : 0);
      await expect(provider.stopTask("ses_parent", "v2:ses_parent:call_shell")).rejects.toMatchObject({ name: "BackgroundTaskUnavailableError" });
      expect(server.requests("DELETE", "/api/shell/sh_fixture")).toHaveLength(0);
    } finally { await provider.dispose(); }
  });
  test("shell output is an owned bounded tail; removal acknowledgement is not a terminal result", async () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    let removed = false;
    const server = fakeOpenCode({
      "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"type":"server.connected","data":{}}\n\n'));
        emitNativeShellBirths(controller);
      } }), { headers: { "content-type": "text/event-stream" } }),
      "GET /api/session/active": () => ({}),
      "GET /api/session/:id": () => session("ses_parent"),
      "GET /api/session/ses_parent/message": () => ({ data: [fixture.shell], cursor: {} }),
      "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
      "GET /api/shell/sh_fixture": () => removed ? Response.json({ _tag: "ShellNotFoundError" }, { status: 404 }) : scoped({ ...nativeShellInfo(), status: "exited" }),
      "GET /api/shell/sh_fixture/output": ({ query }) => scoped({ output: query.get("cursor") === String(Number.MAX_SAFE_INTEGER) ? "" : "tail", size: 1000, cursor: 1000, truncated: false }),
      "DELETE /api/shell/sh_fixture": () => { removed = true; return undefined; },
    });
    const provider = server.provider();
    const stream = observedNativeStream(provider);
    try {
    await stream.seen(event => event.eventType === "shell.created");
    expect(await provider.taskOutput("ses_parent", "v2:ses_parent:call_shell", { tailBytes: 4 })).toEqual({ text: "tail", truncated: true, settled: false });
    await expect(provider.taskOutput("ses_parent", "/private/secret", { tailBytes: 4 })).rejects.toThrow(/unavailable/);
    await provider.stopTask("ses_parent", "v2:ses_parent:call_shell");
    expect(await provider.reconcileBackgroundTasks("ses_parent")).toEqual([expect.objectContaining({ status: "running", stateUncertain: true })]);
    expect(await provider.taskOutput("ses_parent", "v2:ses_parent:call_shell", { tailBytes: 4 })).toBeNull();
    expect(server.requests("DELETE", "/api/shell/sh_fixture")).toHaveLength(1);
    expect(server.calls.filter(call => call.path.startsWith("/api/shell/")).every(call => call.query.get("location[directory]") === WORKSPACE)).toBe(true);
    } finally { stream.lifetime.abort(); await stream.pump; await provider.dispose(); }
  });
  test("foreign shell ownership refuses output and removal; already-missing removal 204 alone settles nothing", async () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    let owner = "other-parent";
    const server = fakeOpenCode({
      "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"type":"server.connected","data":{}}\n\n'));
        emitNativeShellBirths(controller);
      } }), { headers: { "content-type": "text/event-stream" } }),
      "GET /api/session/active": () => ({}),
      "GET /api/session/ses_parent": () => session("ses_parent"),
      "GET /api/session/ses_parent/message": () => ({ data: [fixture.shell], cursor: {} }),
      "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
      "GET /api/shell/sh_fixture": () => scoped(nativeShellInfo("sh_fixture", owner)),
      // A removal can race another client's removal after our ownership read.
      "DELETE /api/shell/sh_fixture": () => undefined,
    });
    const provider = server.provider();
    await expect(provider.stopTask("ses_parent", "v2:ses_parent:call_shell")).rejects.toThrow(/no longer confirmed/);
    await expect(provider.taskOutput("ses_parent", "v2:ses_parent:call_shell", { tailBytes: 10 })).rejects.toThrow(/unavailable/);
    expect(server.calls.some(call => call.method === "DELETE" || call.path.endsWith("/output"))).toBe(false);
    owner = "ses_parent";
    await expect(provider.stopTask("ses_parent", "v2:ses_parent:call_shell")).rejects.toThrow(/no longer confirmed/);
    expect(server.requests("DELETE", "/api/shell/sh_fixture")).toHaveLength(0);
    // A coherent independently owned lifetime can still remove an unsettled
    // job; its 204 acknowledges removal, not a terminal completion report.
    const independentlyOwned = server.provider();
    const stream = observedNativeStream(independentlyOwned);
    try {
    await stream.seen(event => event.eventType === "shell.created");
    await independentlyOwned.stopTask("ses_parent", "v2:ses_parent:call_shell");
    expect(server.requests("DELETE", "/api/shell/sh_fixture")).toHaveLength(1);
    expect(await independentlyOwned.reconcileBackgroundTasks("ses_parent")).toEqual([expect.objectContaining({ status: "running" })]);
    } finally { stream.lifetime.abort(); await stream.pump; await independentlyOwned.dispose(); await provider.dispose(); }
  });
  test("background reconciliation reads pending results even when the parent is idle; active absence is uncertainty", async () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    let pending = false;
    let active = true;
    const server = fakeOpenCode({
      "GET /api/session/active": () => active ? { ses_child: { status: "running" } } : {},
      "GET /api/session/:id": ({ path }) => session(path.split("/").at(-1)!, path.endsWith("ses_child") ? { parentID: "ses_parent" } : {}),
      "GET /api/session/ses_parent/message": () => ({ data: [fixture.launch], cursor: {} }),
      "GET /api/session/ses_parent/inbox": () => ({ data: pending ? [fixture.pending] : [] }),
      "GET /api/session/ses_child/message": () => ({ data: [], cursor: {} }),
    });
    const provider = server.provider();
    expect(await provider.reconcileBackgroundTasks("ses_parent")).toEqual([expect.objectContaining({ status: "running", stateUncertain: false })]);
    active = false;
    expect(await provider.reconcileBackgroundTasks("ses_parent")).toEqual([expect.objectContaining({ status: "running", stateUncertain: true })]);
    pending = true;
    expect(await provider.reconcileBackgroundTasks("ses_parent")).toEqual([expect.objectContaining({ status: "completed", summary: "Fixture checked.", stateUncertain: false })]);
    expect(server.calls.every(call => call.method === "GET")).toBe(true);
  });
  test("concurrent recovery requests for one parent share every read", async () => {
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    const server = fakeOpenCode({
      "GET /api/session/active": () => ({}),
      "GET /api/session/ses_parent": () => session("ses_parent"),
      "GET /api/session/ses_parent/message": async () => { await wait; return { data: [], cursor: {} }; },
      "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
    });
    const provider = server.provider();
    const first = provider.reconcileBackgroundTasks("ses_parent");
    const second = provider.reconcileBackgroundTasks("ses_parent");
    release();
    expect(await Promise.all([first, second])).toEqual([[], []]);
    expect(server.requests("GET", "/api/session/ses_parent/inbox")).toHaveLength(1);
    expect(server.requests("GET", "/api/session/active")).toHaveLength(1);
    expect(server.requests("GET", "/api/session/ses_parent/message")).toHaveLength(1);
  });
  test("successive background reconciliations reuse complete history but refresh current execution and pending inbox", async () => {
    const encoder = new TextEncoder();
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const server = fakeOpenCode({
      "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) {
        stream = controller;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "server.connected", data: {} })}\n\n`));
      } }), { headers: { "content-type": "text/event-stream" } }),
      "GET /api/session/active": () => ({}),
      "GET /api/session/ses_parent": () => session("ses_parent"),
      "GET /api/session/ses_parent/message": () => ({ data: [], cursor: {} }),
      "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
    });
    const provider = server.provider();
    const controller = new AbortController();
    const events = provider.events(controller.signal)[Symbol.asyncIterator]();
    await events.next();
    await provider.reconcileBackgroundTasks("ses_parent");
    await provider.reconcileBackgroundTasks("ses_parent");
    expect(server.requests("GET", "/api/session/ses_parent/message")).toHaveLength(1);
    expect(server.requests("GET", "/api/session/active")).toHaveLength(2);
    expect(server.requests("GET", "/api/session/ses_parent/inbox")).toHaveLength(2);
    expect(server.calls.some(call => call.method !== "GET")).toBe(false);
    const updated = events.next();
    stream.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "session.message.content.updated", data: { sessionID: "ses_parent", messageID: "msg_new", content: [] } })}\n\n`));
    await updated;
    await provider.reconcileBackgroundTasks("ses_parent");
    expect(server.requests("GET", "/api/session/ses_parent/message")).toHaveLength(2);
    stream.close();
    await events.next();
    // With no stream/replay guarantee, even unchanged history must be read.
    await provider.reconcileBackgroundTasks("ses_parent");
    expect(server.requests("GET", "/api/session/ses_parent/message")).toHaveLength(3);
    await provider.dispose();
  });
  test("disposing cancels and awaits owned background reads without touching provider execution", async () => {
    let started!: () => void;
    const reading = new Promise<void>(resolve => { started = resolve; });
    let signal: AbortSignal | undefined;
    let release!: () => void;
    const server = fakeOpenCode({
      "GET /api/session/active": () => ({}),
      "GET /api/session/ses_parent": () => session("ses_parent"),
      "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
      "GET /api/session/ses_parent/message": call => new Promise((_resolve, reject) => {
        signal = call.signal;
        release = () => reject(new DOMException("Stopped read", "AbortError"));
        signal.addEventListener("abort", release, { once: true });
        started();
      }),
    });
    const provider = server.provider();
    const pending = provider.reconcileBackgroundTasks("ses_parent").catch(() => undefined);
    await reading;
    try {
      await provider.dispose();
      expect(signal?.aborted).toBe(true);
    } finally { release(); await pending; }
    expect(server.calls.every(call => call.method === "GET")).toBe(true);
  });
  test("a notification for an existing verified child is readable without its creation event", async () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    const event = { id: "evt_notice", type: "session.inbox.enqueued", created: 41, location: { directory: WORKSPACE }, data: { sessionID: "ses_parent", inboxID: "msg_result", item: fixture.pending } };
    const server = fakeOpenCode({
      "GET /api/session/ses_child": () => session("ses_child", { parentID: "ses_parent" }),
      "GET /api/event": () => new Response(`data: ${JSON.stringify(event)}\n\n`, { headers: { "content-type": "text/event-stream" } }),
    });
    const updates = [];
    for await (const event of server.provider().events(new AbortController().signal)) updates.push(...event.updates);
    expect(updates).toContainEqual({ kind: "upsert", item: expect.objectContaining({ type: "background_task", resultId: "msg_result", status: "completed", summary: "Fixture checked." }) });
    expect(updates.some(update => update.kind === "upsert" && update.item.type === "notice")).toBe(false);
  });
  test("complete history correlates a worker result before paging, without duplicating its envelope", async () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    const server = fakeOpenCode({
      "GET /api/session/:id": ({ path }) => session(path.split("/").at(-1)!, path.endsWith("ses_child") ? { parentID: "ses_parent" } : {}),
      "GET /api/session/ses_parent/message": () => ({ data: [fixture.launch, fixture.stored], cursor: {} }),
    });
    const provider = server.provider();
    const latest = await provider.listMessages("ses_parent", { limit: 1 });
    expect(latest.items).toContainEqual(expect.objectContaining({ type: "background_task", status: "completed", summary: "Fixture checked.", childConversationId: "ses_child" }));
    expect(latest.items.some(item => item.type === "notice")).toBe(false);
    const older = await provider.listMessages("ses_parent", { limit: 1, cursor: latest.nextCursor });
    expect(older.items.filter(item => item.type === "background_task")).toEqual([]);
    expect(latest.completeItems?.filter(item => item.type === "background_task")).toHaveLength(1);
    expect(latest.completeItems).toContainEqual(expect.objectContaining({ type: "tool", id: "tool:call_worker", status: "completed" }));
  });

  test("notification-first stored history retires its provisional result when the older launch is restated", async () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    const server = fakeOpenCode({
      "GET /api/session/:id": ({ path }) => session(path.split("/").at(-1)!, path.endsWith("ses_child") ? { parentID: "ses_parent" } : {}),
      "GET /api/session/ses_parent/message": () => ({ data: [fixture.stored, { ...fixture.launch, time: { created: 50 } }], cursor: {} }),
    });
    const result = await server.provider().listMessages("ses_parent", { limit: 100 });
    expect(result.items.filter(item => item.type === "background_task")).toEqual([expect.objectContaining({ toolUseId: "call_worker", resultId: "msg_result", status: "completed" })]);
  });
  test("the first history page carries every live worker and its out-of-page launcher aliases", async () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    const server = fakeOpenCode({
      "GET /api/session/:id": ({ path }) => session(path.split("/").at(-1)!, path.endsWith("ses_child") ? { parentID: "ses_parent" } : {}),
      "GET /api/session/ses_parent/message": () => ({ data: [fixture.launch, { id: "latest", type: "user", time: { created: 100 }, text: "Later prompt" }], cursor: {} }),
    });
    const provider = server.provider();
    const result = await provider.listMessages("ses_parent", { limit: 1 });
    expect(result.items).toContainEqual(expect.objectContaining({ id: "tool:call_worker", status: "completed" }));
    expect(result.items.filter(item => item.type === "background_task")).toHaveLength(1);
    const older = await provider.listMessages("ses_parent", { cursor: result.nextCursor, limit: 1 });
    expect(new Set([...result.items, ...older.items].filter(item => item.type === "background_task").map(item => item.id)).size).toBe(1);
  });
  test("historical execution intervals correlate six launchers to five explicit results without reordering tools", async () => {
    const launch = historyWorkerLaunch, result = historyWorkerResult;
    const messages = [launch("call_a", 10), launch("call_b", 20), result("result_0", 40),
      ...[1, 2, 3, 4].flatMap(i => [launch(`call_${i}`, i * 100), result(`result_${i}`, i * 100 + 40)])];
    const server = fakeOpenCode({
      "GET /api/session/active": () => ({}),
      "GET /api/session/:id": ({ path }) => session(path.split("/").at(-1)!, path.endsWith("ses_child") ? { parentID: "ses_parent" } : {}),
      "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
      "GET /api/session/ses_parent/message": () => ({ data: messages, cursor: {} }),
      "GET /api/session/ses_child/message": () => ({ data: [30, 130, 230, 330, 430].map(at => ({ id: `idle_${at}`, type: "idle", time: { created: at } })), cursor: {} }),
    });
    const provider = server.provider();
    try {
      const page = await provider.listMessages("ses_parent", { limit: 100 });
      const tasks = page.items.filter(item => item.type === "background_task");
      expect(tasks).toHaveLength(5);
      expect(tasks).toContainEqual(expect.objectContaining({ toolUseId: "call_a", toolUseIds: ["call_a", "call_b"], status: "completed", resultId: "result_0" }));
      for (const i of [1, 2, 3, 4]) expect(tasks).toContainEqual(expect.objectContaining({ toolUseId: `call_${i}`, status: "completed", resultId: `result_${i}` }));
      expect(page.items.filter(item => item.type === "tool").map(item => item.id)).toEqual(["tool:call_a", "tool:call_b", "tool:call_1", "tool:call_2", "tool:call_3", "tool:call_4"]);
      const recovered = await provider.reconcileBackgroundTasks("ses_parent");
      expect(recovered).toHaveLength(5);
      expect(recovered.every(item => item.status === "completed" && item.stateUncertain === false)).toBe(true);
    } finally { await provider.dispose(); }
    expect(server.calls.every(call => call.method === "GET")).toBe(true);
  });

  for (const combined of [true, false]) test(`historical interleaved execution clocks correlate aliases ${combined ? "within one assistant" : "across assistants"} without reordering tools`, async () => {
    // Native content is appended on tool.input.started; time.ran is recorded
    // on tool.called. Input order therefore need not be execution-start order.
    const first = historyWorkerLaunch("call_a", 10), second = historyWorkerLaunch("call_b", 12);
    first.content[0]!.time = { created: 10, ran: 21, completed: 23 };
    second.content[0]!.time = { created: 12, ran: 13, completed: 15 };
    const launches = combined ? [{ ...first, content: [...first.content, ...second.content] }] : [first, second];
    const server = workerHistoryServer([...launches, historyWorkerResult("result", 40)],
      [3, 30].map(at => ({ id: `idle_${at}`, type: "idle", time: { created: at } })));
    const provider = server.provider();
    try {
      const page = await provider.listMessages("ses_parent", { limit: 100 });
      expect(page.completeItems?.filter(item => item.type === "tool").map(item => item.id)).toEqual(["tool:call_a", "tool:call_b"]);
      for (const tasks of [page.completeItems?.filter(item => item.type === "background_task"), await provider.reconcileBackgroundTasks("ses_parent")]) {
        expect(tasks).toEqual([expect.objectContaining({ toolUseId: "call_a", toolUseIds: ["call_a", "call_b"], status: "completed", stateUncertain: false, resultId: "result" })]);
      }
      expect(server.calls.every(call => call.method === "GET")).toBe(true);
    } finally { await provider.dispose(); }
  });

  for (const combined of [true, false]) for (const order of [
    ["new_a", "old", "new_b"], ["new_a", "new_b", "old"], ["old", "new_a", "new_b"],
    ["old", "new_b", "new_a"], ["new_b", "new_a", "old"], ["new_b", "old", "new_a"],
  ]) test(`historical supersession preserves separate intervals: ${order.join("/")} ${combined ? "combined" : "split"} assistants with pending results`, async () => {
    const starts: Record<string, number> = { old: 13, new_a: 21, new_b: 25 };
    const launches = order.map((call, index) => {
      const message = historyWorkerLaunch(call, index + 2);
      message.content[0]!.time = { created: index + 2, ran: starts[call]!, completed: starts[call]! + 1 };
      return message;
    });
    const messages: unknown[] = combined ? [{ ...launches[0]!, content: launches.flatMap(message => message.content) }] : launches;
    const reports = [historyWorkerResult("old_result", 18), historyWorkerResult("new_result", 40)];
    const pending: unknown[] = reports.map(({ id, time, text, metadata }) => ({ id, time, type: "synthetic", delivery: "steer", payload: { text, metadata } }));
    const server = workerHistoryServer(messages, [17, 30].map(at => ({ id: `idle_${at}`, type: "idle", time: { created: at } })), pending);
    const aliases = order.filter(call => call !== "old");
    const expected = [
      { toolUseId: "old", toolUseIds: undefined, status: "completed" as const, stateUncertain: false, resultId: "old_result" },
      { toolUseId: aliases[0], toolUseIds: aliases, status: "completed" as const, stateUncertain: false, resultId: "new_result" },
    ].sort((left, right) => left.toolUseId!.localeCompare(right.toolUseId!));
    const recovering = server.provider();
    try {
      const tasks = await recovering.reconcileBackgroundTasks("ses_parent", { fresh: true });
      expect(tasks).toHaveLength(2);
      expect(tasks.map(({ toolUseId, toolUseIds, status, stateUncertain, resultId }) => ({ toolUseId, toolUseIds, status, stateUncertain, resultId }))
        .sort((left, right) => (left.toolUseId ?? "").localeCompare(right.toolUseId ?? ""))).toEqual(expected);
    } finally { await recovering.dispose(); }
    // Delivery changes the envelope, not the occurrence/result identities.
    messages.push(...reports);
    pending.length = 0;
    const history = server.provider();
    try {
      const page = await history.listMessages("ses_parent", { limit: 100 });
      expect(page.completeItems?.filter(item => item.type === "tool").map(item => item.id)).toEqual(order.map(call => `tool:${call}`));
      expect(page.completeItems?.filter(item => item.type === "background_task")
        .map(({ toolUseId, toolUseIds, status, stateUncertain, resultId }) => ({ toolUseId, toolUseIds, status, stateUncertain, resultId }))
        .sort((left, right) => (left.toolUseId ?? "").localeCompare(right.toolUseId ?? ""))).toEqual(expected);
      expect(server.calls.every(call => call.method === "GET")).toBe(true);
    } finally { await history.dispose(); }
  });

  for (const completed of [false, true]) for (const reversed of [false, true]) for (const combined of [false, true]) {
    for (const clock of ["straddling", "missing-acceptance", "missing-start", "tied-boundary", "tied-window", "reversed-window"] as const) {
      test(`permission-delayed admission stays uncertain: ${clock}/${completed ? "completed" : "running"}/${reversed ? "reversed" : "forward"}/${combined ? "combined" : "split"}`, async () => {
        const old = historyWorkerLaunch("old", 3), delayed = historyWorkerLaunch("delayed", 4);
        old.content[0]!.time = { created: 3, ran: 13, completed: 16 };
        const time: { created?: number; ran?: number; completed?: number } = { created: 4, ran: 15, completed: 23 };
        if (clock === "missing-acceptance") delete time.completed;
        if (clock === "missing-start") { delete time.created; delete time.ran; }
        if (clock === "tied-boundary") time.completed = 17;
        if (clock === "tied-window") time.completed = 15;
        if (clock === "reversed-window") time.completed = 14;
        delayed.content[0]!.time = time as typeof delayed.content[0]["time"];
        const launches = reversed ? [delayed, old] : [old, delayed];
        const messages: unknown[] = combined ? [{ ...old, content: launches.flatMap(message => message.content) }] : launches;
        const reports = [historyWorkerResult("old_result", 18), ...(completed ? [historyWorkerResult("new_result", 40)] : [])];
        const pending = reports.map(({ id, time, text, metadata }) => ({ id, time, type: "synthetic", delivery: "steer", payload: { text, metadata } }));
        const server = workerHistoryServer(messages, (completed ? [17, 30] : [17]).map(at => ({ id: `idle_${at}`, type: "idle", time: { created: at } })), pending);
        const provider = server.provider();
        try {
          const tasks = await provider.reconcileBackgroundTasks("ses_parent", { fresh: true });
          const launches = tasks.filter(task => task.toolUseId);
          expect(launches).toHaveLength(2);
          expect(launches.every(task => task.status === "running" && task.stateUncertain && !task.toolUseIds && !task.resultId)).toBe(true);
          for (const report of reports) expect(tasks).toContainEqual(expect.objectContaining({ resultId: report.id, status: "completed" }));
          expect(tasks.filter(task => task.resultId).map(task => task.resultId).sort()).toEqual(reports.map(report => report.id).sort());
          expect(server.calls.every(call => call.method === "GET")).toBe(true);
        } finally { await provider.dispose(); }
      });
    }
  }

  for (const boundary of [true, false]) for (const reportAt of [18, 23]) test(`permission-delayed admission cannot consume a pre-acceptance/tied report as the only launch: ${boundary}/${reportAt}`, async () => {
    const delayed = historyWorkerLaunch("delayed", 4);
    delayed.content[0]!.time = { created: 4, ran: 15, completed: 23 };
    const server = workerHistoryServer([delayed, historyWorkerResult("old_result", reportAt)], boundary ? [{ id: "idle", type: "idle", time: { created: 17 } }] : []);
    const provider = server.provider();
    try {
      const tasks = await provider.reconcileBackgroundTasks("ses_parent", { fresh: true });
      expect(tasks).toHaveLength(2);
      expect(tasks.find(task => task.toolUseId === "delayed")).toMatchObject({ status: "running", stateUncertain: true });
      expect(tasks.find(task => task.toolUseId === "delayed")?.resultId).toBeUndefined();
      expect(tasks.find(task => task.resultId === "old_result")?.toolUseId).toBeUndefined();
    } finally { await provider.dispose(); }
  });

  for (const reversed of [false, true]) for (const clock of ["between", "at-earlier", "at-later", "tied", "missing-launch", "missing-boundary"] as const) {
    test(`historical interval coordinates reject ${clock} ambiguity in ${reversed ? "reverse" : "forward"} execution order`, async () => {
      const first = historyWorkerLaunch("call_a", 10), second = historyWorkerLaunch("call_b", 12);
      first.content[0]!.time = { created: 10, ran: reversed ? 21 : 13, completed: 23 };
      second.content[0]!.time = { created: 12, ran: reversed ? 13 : 21, completed: 23 };
      if (clock === "tied") second.content[0]!.time.ran = first.content[0]!.time.ran;
      if (clock === "missing-launch") second.content[0]!.time = {} as typeof second.content[0]["time"];
      const boundary = { id: "idle_boundary", type: "idle", time: { created: clock === "at-earlier" ? 13 : clock === "at-later" ? 21 : 17 } as { created?: number } };
      if (clock === "missing-boundary") delete boundary.time.created;
      const server = workerHistoryServer([{ ...first, content: [...first.content, ...second.content] }, historyWorkerResult("result", 40)], [boundary]);
      const provider = server.provider();
      try {
        const tasks = await provider.reconcileBackgroundTasks("ses_parent");
        const launches = tasks.filter(task => task.toolUseId);
        expect(launches).toHaveLength(2);
        expect(launches.every(task => !task.toolUseIds && task.status === "running" && task.stateUncertain && !task.resultId)).toBe(true);
      } finally { await provider.dispose(); }
    });
  }

  for (const reversed of [false, true]) test(`historical boundary-separated ${reversed ? "reverse" : "forward"} starts cannot apply an old result to the new execution`, async () => {
    const older = historyWorkerLaunch("call_old", 10), newer = historyWorkerLaunch("call_new", 12);
    older.content[0]!.time = { created: 10, ran: 13, completed: 15 };
    newer.content[0]!.time = { created: 12, ran: 21, completed: 23 };
    const content = reversed ? [...newer.content, ...older.content] : [...older.content, ...newer.content];
    const server = workerHistoryServer([{ ...older, content }, historyWorkerResult("result_old", 16)], [{ id: "idle_old", type: "idle", time: { created: 17 } }]);
    const provider = server.provider();
    try {
      const tasks = await provider.reconcileBackgroundTasks("ses_parent");
      expect(tasks).toHaveLength(2);
      expect(tasks.find(task => task.toolUseId === "call_old")).toMatchObject({ status: "completed", resultId: "result_old", stateUncertain: false });
      expect(tasks.find(task => task.toolUseId === "call_new")).toMatchObject({ status: "running" });
      expect(tasks.find(task => task.toolUseId === "call_new")?.resultId).toBeUndefined();
    } finally { await provider.dispose(); }
  });

  test("historical aliases without an explicit result remain uncertain and cannot stop a continued child", async () => {
    const server = workerHistoryServer([historyWorkerLaunch("call_a", 10), historyWorkerLaunch("call_b", 20)],
      [{ id: "idle", type: "idle", time: { created: 30 } }]);
    const provider = server.provider();
    try {
      expect(await provider.reconcileBackgroundTasks("ses_parent")).toEqual([expect.objectContaining({ toolUseIds: ["call_a", "call_b"], status: "running", stateUncertain: true })]);
      await expect(provider.stopTask("ses_parent", "v2:ses_parent:call_a")).rejects.toThrow(/no longer confirmed/);
      expect(server.calls.every(call => call.method === "GET")).toBe(true);
    } finally { await provider.dispose(); }
  });

  for (const clock of ["missing-launch", "tied-launch", "tied-boundary", "missing-boundary"] as const) test(`historical interval grouping preserves ambiguity with ${clock} clocks`, async () => {
    const first = historyWorkerLaunch("call_a", 10), second = historyWorkerLaunch("call_b", 20);
    const idle = { id: "idle", type: "idle", time: { created: 30 } as { created?: number } };
    if (clock === "missing-launch") second.content[0]!.time = {} as typeof second.content[0]["time"];
    if (clock === "tied-launch") second.content[0]!.time = { ...first.content[0]!.time };
    if (clock === "tied-boundary") second.content[0]!.time.ran = 30;
    if (clock === "missing-boundary") delete idle.time.created;
    const server = workerHistoryServer([first, second, historyWorkerResult("result", 40)], [idle]);
    const provider = server.provider();
    try {
      const tasks = await provider.reconcileBackgroundTasks("ses_parent");
      const launchers = tasks.filter(task => task.toolUseId);
      expect(launchers).toHaveLength(2);
      expect(launchers.every(task => task.status === "running" && task.stateUncertain && !task.resultId)).toBe(true);
    } finally { await provider.dispose(); }
  });

  for (const datedBeforeNewRun of [true, false]) test(`historical delayed result ${datedBeforeNewRun ? "settles only the old run and deduplicates" : "cannot choose a run from a late clock"}`, async () => {
    const report = historyWorkerResult("result", datedBeforeNewRun ? 40 : 140);
    const server = workerHistoryServer([historyWorkerLaunch("call_a", 10), historyWorkerLaunch("call_b", 20), historyWorkerLaunch("call_new", 100), report, report],
      [{ id: "idle", type: "idle", time: { created: 30 } }]);
    const provider = server.provider();
    try {
      const tasks = await provider.reconcileBackgroundTasks("ses_parent");
      expect(tasks.filter(task => task.resultId === "result")).toHaveLength(1);
      expect(tasks).toContainEqual(expect.objectContaining({ toolUseId: "call_new", status: "running" }));
      expect(tasks.find(task => task.toolUseId === "call_new")?.resultId).toBeUndefined();
      const old = tasks.find(task => task.toolUseId === "call_a");
      expect(old?.toolUseIds).toEqual(["call_a", "call_b"]);
      expect(old?.status).toBe(datedBeforeNewRun ? "completed" : "running");
      expect(old?.resultId).toBe(datedBeforeNewRun ? "result" : undefined);
    } finally { await provider.dispose(); }
  });

  test("child execution boundaries separate reused occurrences; an ambiguous delayed notice settles neither", async () => {
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../tests/fixtures/opencode-v2/background-2.0.29.json"), "utf8"));
    const notice = { ...fixture.stored, time: { created: 70 } };
    const server = fakeOpenCode({
      "GET /api/session/active": () => ({ ses_child: { status: "running" } }),
      "GET /api/session/:id": ({ path }) => session(path.split("/").at(-1)!, path.endsWith("ses_child") ? { parentID: "ses_parent" } : {}),
      "GET /api/session/ses_parent/inbox": () => ({ data: [] }),
      "GET /api/session/ses_parent/message": () => ({ data: [fixture.launch, fixture.converted, notice], cursor: {} }),
      "GET /api/session/ses_child/message": () => ({ data: [{ id: "msg_idle", type: "idle", outcome: "succeeded", time: { created: 40 } }, { id: "msg_continue", type: "user", text: "Check another fixture", time: { created: 50 } }], cursor: {} }),
    });
    const result = await server.provider().listMessages("ses_parent", { limit: 50 });
    expect(result.items.filter(item => item.type === "background_task" && item.status === "running")).toEqual([
      expect.objectContaining({ toolUseId: "call_worker", stateUncertain: true }),
      expect.objectContaining({ toolUseId: "call_converted", stateUncertain: true }),
    ]);
    expect(result.items.filter(item => item.type === "background_task" && item.status === "completed")).toEqual([expect.objectContaining({ summary: "Fixture checked." })]);
    const provider = server.provider();
    expect((await provider.reconcileBackgroundTasks("ses_parent")).filter(item => item.status === "running").every(item => item.stateUncertain)).toBe(true);
    await expect(provider.stopTask("ses_parent", "v2:ses_parent:call_converted")).rejects.toThrow(/no longer confirmed/);
    expect(server.calls.every(call => call.method === "GET")).toBe(true);
  });

  test("lists only the workspace's sessions, following the cursor", async () => {
    const server = fakeOpenCode({
      "GET /api/session": ({ query }) => query.get("cursor") === "page2"
        ? { data: [session("ses_3", { parentID: "ses_1", title: "child" })], cursor: { next: null } }
        : { data: [session("ses_1"), session("ses_other", { location: { directory: "/elsewhere" } })], cursor: { next: "page2" } },
    });
    expect(await server.provider().listSessions()).toEqual([
      { id: "ses_1", title: "Session ses_1", directory: WORKSPACE, createdAt: 100, updatedAt: 200 },
      { id: "ses_3", title: "child", directory: WORKSPACE, createdAt: 100, updatedAt: 200, parentId: "ses_1" },
    ]);
    const [first, second] = server.requests("GET", "/api/session");
    expect(first?.query.get("directory")).toBe(WORKSPACE);
    expect(first?.query.get("order")).toBe("desc");
    expect(second?.query.get("cursor")).toBe("page2");
    expect(second?.query.has("order")).toBe(false);
  });

  test("creates a session in the workspace with the chosen agent and model", async () => {
    const server = fakeOpenCode({
      "POST /api/session": ({ body }) => session("ses_new", { title: undefined, ...(body as Record<string, unknown>) }),
    });
    const created = await server.provider().createSession("ignored", { mode: "plan", model: { providerId: "berget", modelId: "think" }, variant: "high" });
    expect(created).toMatchObject({ id: "ses_new", directory: WORKSPACE, title: "" });
    expect(server.requests("POST", "/api/session")[0]?.body).toEqual({
      location: { directory: WORKSPACE },
      agent: "plan",
      model: { id: "think", providerID: "berget", variant: "high" },
    });
  });

  test("a foreign or missing session is null; a server failure propagates", async () => {
    const server = fakeOpenCode({
      "GET /api/session/:id": ({ path }) => path.endsWith("ses_foreign")
        ? session("ses_foreign", { location: { directory: "/elsewhere" } })
        : path.endsWith("ses_gone") ? notFound("ses_gone")
        : path.endsWith("ses_ok") ? session("ses_ok")
        : new Response("boom", { status: 500 }),
    });
    const provider = server.provider();
    expect(await provider.getSession("ses_foreign")).toBeNull();
    expect(await provider.getSession("ses_gone")).toBeNull();
    expect(await provider.getSession("ses_ok")).toMatchObject({ id: "ses_ok", directory: WORKSPACE });
    await expect(provider.getSession("ses_broken")).rejects.toThrow("session lookup failed");
  });

  test("rename patches the title and reads the session back", async () => {
    let title = "old";
    const server = fakeOpenCode({
      "PATCH /api/session/:id": ({ body }) => { title = (body as { title: string }).title; return undefined; },
      "GET /api/session/:id": () => session("ses_1", { title }),
    });
    expect(await server.provider().renameSession("ses_1", "new name")).toMatchObject({ id: "ses_1", title: "new name" });
    expect(server.requests("PATCH", "/api/session/ses_1")[0]?.body).toEqual({ title: "new name" });
  });

  test("configuration comes from the session record, with 'default' as no variant", async () => {
    const server = fakeOpenCode({
      "GET /api/session/:id": ({ path }) => session(path.slice(path.lastIndexOf("/") + 1), path.endsWith("ses_high")
        ? { agent: "plan", model: { id: "think", providerID: "berget", variant: "high" } }
        : { agent: "build", model: { id: "flash", providerID: "opencode", variant: "default" } }),
    });
    expect(await server.provider().getConversationConfiguration("ses_high")).toEqual({ model: { providerId: "berget", modelId: "think" }, mode: "plan", variant: "high" });
    expect(await server.provider().getConversationConfiguration("ses_plain")).toEqual({ model: { providerId: "opencode", modelId: "flash" }, mode: "build" });
  });

  test("switching the model rides the variant on the model reference", async () => {
    const server = fakeOpenCode({ "POST /api/session/:id/model": () => undefined });
    await server.provider().switchModel("ses_1", { providerId: "berget", modelId: "think" }, "high");
    await server.provider().switchModel("ses_1", { providerId: "berget", modelId: "think" });
    expect(server.requests("POST", "/api/session/ses_1/model").map(call => call.body)).toEqual([
      { model: { id: "think", providerID: "berget", variant: "high" } },
      { model: { id: "think", providerID: "berget" } },
    ]);
  });
});

describe("OpenCode 2.x provider: history", () => {
  function historyServer(overrides: Record<string, unknown> = {}) {
    return fakeOpenCode({
      "GET /api/session/:id": () => session("ses_h", overrides),
      "GET /api/session/:id/message": ({ query }) => query.get("cursor") === "more"
        ? { data: STORED.slice(3), cursor: { next: null } }
        : { data: STORED.slice(0, 3), cursor: { next: "more" } },
    });
  }

  test("reads the whole transcript across pages and maps every record kind", async () => {
    const server = historyServer();
    const page = await server.provider().listMessages("ses_h", { limit: 50 });
    const [first, second] = server.requests("GET", "/api/session/ses_h/message");
    expect(first?.query.get("order")).toBe("asc");
    expect(second?.query.get("cursor")).toBe("more");
    expect(second?.query.has("order")).toBe(false);

    const kinds = page.items.map(item => item.type);
    expect(kinds).toEqual(["user_message", "reasoning", "tool", "assistant_message", "reasoning", "assistant_message", "assistant_message", "user_message"]);
    const tool = page.items.find(item => item.type === "tool");
    expect(tool).toMatchObject({ name: "read", status: "completed" });
    expect(tool?.id).toMatch(/^tool:call_/);
    const carriers = page.items.filter(item => item.type === "assistant_message" && item.markdown === "");
    expect(carriers).toHaveLength(2);
    expect(carriers[0]).toMatchObject({ model: { providerId: "opencode", modelId: "mimo-v2.6-flash-free" }, agent: "build", usage: { input: expect.any(Number), costUsd: 0 } });
    expect(page.completeItems).toEqual(page.items);
    expect(page.nextCursor).toBeUndefined();
  });

  test("accounting pairs each assistant record with the prompt before it", async () => {
    const page = await historyServer().provider().listMessages("ses_h", { limit: 50 });
    const promptId = String(STORED[0]!.id);
    expect(page.accounting).toHaveLength(2);
    for (const entry of page.accounting) {
      expect(entry.promptId).toBe(promptId);
      expect(entry.model).toBe("mimo-v2.6-flash-free");
      expect(entry.usage?.input).toBeGreaterThan(0);
    }
  });

  test("session aggregate survives paging/revert independently of visible message costs; zero and missing stay distinct", async () => {
    const provider = historyServer({ cost: 1.75, revert: { messageID: String(STORED[0]!.id) } }).provider();
    const reverted = await provider.listMessages("ses_h", { limit: 1 });
    expect(reverted.items).toEqual([]);
    expect(reverted.accounting).toEqual([]);
    expect(reverted.sessionCostUsd).toBe(1.75); // includes native compaction/reverted spend, not the visible page's sum
    const zero = historyServer({ cost: 0 });
    expect((await zero.provider().listMessages("ses_h", { limit: 1 })).sessionCostUsd).toBe(0);
    expect(zero.requests("GET", "/api/session/ses_h")).toHaveLength(1); // reuse existing metadata read
    expect((await historyServer({ cost: undefined }).provider().listMessages("ses_h", { limit: 1 })).sessionCostUsd).toBeUndefined();
    expect((await historyServer({ cost: -1 }).provider().listMessages("ses_h", { limit: 1 })).sessionCostUsd).toBeUndefined();
  });

  test("pages locally from the newest record and continues from the cursor", async () => {
    const provider = historyServer().provider();
    const newest = await provider.listMessages("ses_h", { limit: 2 });
    expect(newest.items.map(item => item.type)).toEqual(["user_message"]);
    expect(newest.nextCursor).toBeDefined();
    const older = await provider.listMessages("ses_h", { cursor: newest.nextCursor, limit: 2 });
    expect(older.items.map(item => item.type)).toEqual(["reasoning", "tool", "assistant_message", "reasoning", "assistant_message", "assistant_message"]);
    expect(older.nextCursor).toBeDefined();
  });

  test("a staged revert hides the reverted suffix", async () => {
    const boundary = String(STORED[4]!.id);
    const page = await historyServer({ revert: { messageID: boundary } }).provider().listMessages("ses_h", { limit: 50 });
    expect(page.items.map(item => item.type)).not.toContain("idle");
    expect(page.items.filter(item => item.type === "user_message")).toHaveLength(1);
    expect(page.revertVisibility).toEqual({
      boundaryId: boundary,
      state: { staged: true, canUndo: true, canRedo: true, revertedMessages: [{ id: `message:${boundary}`, text: String(STORED[4]!.text) }] },
      excludedItemIds: [`message:${boundary}`],
    });
  });

  test("revert visibility authority is independent of the requested page; an unknown boundary grants no exclusions", async () => {
    const boundary = String(STORED[4]!.id);
    const provider = historyServer({ revert: { messageID: boundary } }).provider();
    const small = await provider.listMessages("ses_h", { limit: 1 });
    const large = await provider.listMessages("ses_h", { limit: 50 });
    expect(small.items).not.toEqual(large.items);
    expect(small.revertVisibility).toEqual(large.revertVisibility);
    expect((await historyServer({ revert: { messageID: "unknown-native-boundary" } }).provider().listMessages("ses_h", { limit: 1 })).revertVisibility).toEqual({
      boundaryId: "unknown-native-boundary",
      state: { staged: true, canUndo: false, canRedo: false, revertedMessages: [] },
      excludedItemIds: [],
    });
    expect((await historyServer().provider().listMessages("ses_h", { limit: 1 })).revertVisibility?.excludedItemIds).toEqual([]);
  });

  test("boundary revalidation distinguishes unknown native markers that have identical UI state and honors read cancellation", async () => {
    let marker = "unknown-native-A";
    const server = fakeOpenCode({
      "GET /api/session/:id": () => session("ses_h", { revert: { messageID: marker } }),
      "GET /api/session/:id/message": () => ({ data: STORED, cursor: { next: null } }),
    });
    const provider = server.provider();
    const page = await provider.listMessages("ses_h", { limit: 1 });
    marker = "unknown-native-B";
    const controller = new AbortController();
    expect(page.revertVisibility?.boundaryId).toBe("unknown-native-A");
    expect(await provider.getReversibleHistoryState("ses_h")).toEqual(page.revertVisibility!.state);
    expect(await provider.getHistoryRevertBoundary("ses_h", { signal: controller.signal })).toBe("unknown-native-B");
    controller.abort();
    await expect(provider.getHistoryRevertBoundary("ses_h", { signal: controller.signal })).rejects.toThrow();
  });

  test("complete visible history cannot prove delivery absence across a revert boundary", async () => {
    const boundary = String(STORED[0]!.id);
    const reverted = await historyServer({ revert: { messageID: boundary } }).provider().listMessages("ses_h", { limit: 50 });
    expect(reverted.completeItems).toEqual([]);
    expect(reverted.deliveryHistoryIncomplete).toBe(true);
    const unfiltered = await historyServer().provider().listMessages("ses_h", { limit: 50 });
    expect(unfiltered.deliveryHistoryIncomplete).toBeUndefined();
  });
});

describe("OpenCode 2.x provider: prompting and events", () => {
  test("a prompt switches model and agent first, then queues a client-minted message with file attachments", async () => {
    const server = fakeOpenCode({
      "POST /api/session/:id/model": () => undefined,
      "POST /api/session/:id/agent": () => undefined,
      "POST /api/session/:id/prompt": ({ body }) => ({ id: (body as { id: string }).id, sessionID: "ses_1", time: { created: 1 }, type: "user", payload: { text: (body as { text: string }).text }, delivery: "queue" }),
    });
    const result = await server.provider().prompt("ses_1", {
      id: "req-1",
      text: "hello",
      delivery: "queue",
      attachments: [{ id: "att_1", name: "shot.png", mimeType: "image/png", absolutePath: "/tmp/uatu/att_1.png" }],
      model: { providerId: "berget", modelId: "think" },
      mode: "plan",
      variant: "high",
    });
    expect(result.messageId).toMatch(/^msg_[0-9a-f]{26}$/);
    expect(server.calls.map(call => `${call.method} ${call.path}`)).toEqual([
      "POST /api/session/ses_1/model",
      "POST /api/session/ses_1/agent",
      "POST /api/session/ses_1/prompt",
    ]);
    expect(server.requests("POST", "/api/session/ses_1/agent")[0]?.body).toEqual({ agent: "plan" });
    expect(server.requests("POST", "/api/session/ses_1/prompt")[0]?.body).toEqual({
      id: result.messageId,
      text: "hello",
      files: [{ uri: "file:///tmp/uatu/att_1.png", name: "shot.png" }],
      delivery: "queue",
      resume: true,
    });
  });

  test("a steer is handed to the inbox with resume, and never retargets the session it steers", async () => {
    // opencode-v2-steering D6: a mid-turn switchModel/switchAgent would
    // retarget the turn being steered, so a steer carries no model or mode
    // to the session and runs under whatever it has at delivery.
    const server = fakeOpenCode({
      "POST /api/session/:id/model": () => undefined,
      "POST /api/session/:id/agent": () => undefined,
      "POST /api/session/:id/prompt": ({ body }) => ({ id: (body as { id: string }).id, sessionID: "ses_1", time: { created: 1 }, type: "user", payload: { text: (body as { text: string }).text }, delivery: "steer" }),
    });
    const result = await server.provider().prompt("ses_1", {
      id: "req-s",
      text: "stop, do the other thing",
      delivery: "steer",
      attachments: [{ id: "att_1", name: "shot.png", mimeType: "image/png", absolutePath: "/tmp/uatu/att_1.png" }],
      model: { providerId: "berget", modelId: "think" },
      mode: "plan",
      variant: "high",
    });
    expect(result.messageId).toMatch(/^msg_[0-9a-f]{26}$/);
    expect(server.calls.map(call => `${call.method} ${call.path}`)).toEqual(["POST /api/session/ses_1/prompt"]);
    expect(server.requests("POST", "/api/session/ses_1/prompt")[0]?.body).toEqual({
      id: result.messageId,
      text: "stop, do the other thing",
      files: [{ uri: "file:///tmp/uatu/att_1.png", name: "shot.png" }],
      delivery: "steer",
      resume: true,
    });
  });

  test("interrupt passes resume through, and sends none when the caller names none", async () => {
    const server = fakeOpenCode({ "POST /api/session/:id/interrupt": () => ({ interrupted: true }) });
    const provider = server.provider();
    await provider.interrupt("ses_1");
    await provider.interrupt("ses_1", { resume: false });
    await provider.interrupt("ses_1", { resume: true });
    // The pinned client carries `resume` as a query parameter.
    expect(server.requests("POST", "/api/session/ses_1/interrupt").map(call => call.query.get("resume"))).toEqual([null, "false", "true"]);
  });

  test("the pending inbox lists the user's steers only, as pending entries", async () => {
    const server = fakeOpenCode({
      "GET /api/session/:id/inbox": () => ({ data: [
        { id: "msg_steer", sessionID: "ses_1", time: { created: 5 }, type: "user", payload: { text: "steer me", files: [{ mime: "image/png", name: "shot.png", source: { type: "uri", uri: "file:///tmp/uatu/11111111-2222-4333-8444-555555555555.png" } }] }, delivery: "steer" },
        { id: "msg_queued", sessionID: "ses_1", time: { created: 6 }, type: "user", payload: { text: "native queue" }, delivery: "queue" },
        { id: "msg_syn", sessionID: "ses_1", time: { created: 7 }, type: "synthetic", payload: { text: "note" }, delivery: "steer" },
        { id: "msg_cmp", sessionID: "ses_1", time: { created: 8 }, type: "compaction", payload: {}, delivery: "steer" },
        { id: "msg_mv", sessionID: "ses_1", time: { created: 9 }, type: "move", payload: { location: { directory: "/x" } }, delivery: "steer" },
      ] }),
    });
    expect(await server.provider().listPendingInbox("ses_1")).toEqual([
      { id: "msg_steer", text: "steer me", delivery: "steer", at: 5, attachments: [{ id: "11111111-2222-4333-8444-555555555555", name: "shot.png", mimeType: "image/png" }] },
    ]);
  });

  test("cancelling an inbox entry hits its route", async () => {
    const server = fakeOpenCode({ "DELETE /api/session/:id/inbox/:inboxId": () => undefined });
    await server.provider().cancelInbox("ses_1", "msg_steer");
    expect(server.requests("DELETE", "/api/session/ses_1/inbox/msg_steer")).toHaveLength(1);
  });

  for (const outcome of ["delivered", "response-lost"] as const) test(`real V2 withdrawal with ${outcome} cannot convert a steer using cached empty history`, async () => {
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    let messages: unknown[] = [];
    const server = fakeOpenCode({
      "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) {
        stream = controller;
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "server.connected", data: {} })}\n\n`));
      } }), { headers: { "content-type": "text/event-stream" } }),
      "GET /api/session/ses": () => session("ses"),
      "GET /api/session/ses/message": () => ({ data: messages, cursor: {} }),
      "GET /api/session/ses/inbox": () => ({ data: [] }),
      "POST /api/session/ses/prompt": ({ body }) => {
        const input = body as { id: string; text: string; delivery: string };
        return { id: input.id, sessionID: "ses", type: "user", time: { created: 1 }, payload: { text: input.text }, delivery: input.delivery };
      },
      // Native delivery has already removed the entry. Cancel's missing-id
      // acknowledgement is a no-op, not proof that it was cancelled.
      "DELETE /api/session/ses/inbox/:id": () => outcome === "response-lost" ? Response.json({ _tag: "UnknownError", message: "response lost" }, { status: 500 }) : undefined,
    });
    const provider = server.provider();
    const controller = new AbortController();
    const events = provider.events(controller.signal)[Symbol.asyncIterator]();
    const adapter = new ChatAdapter({ provider, workspacePath: WORKSPACE, steerWithdrawTimeoutMs: 100 });
    try {
      await events.next();
      adapter.projectionForTests("ses").statusUpdate("running");
      const accepted = await adapter.prompt("ses", "original-request", "deliver once", undefined, undefined, undefined, undefined, "steer");
      expect((await provider.listMessages("ses", { limit: 50 })).completeItems).toEqual([]);
      const reads = server.requests("GET", "/api/session/ses/message").length;
      // Persist delivery without releasing its delayed stream event.
      if (outcome === "delivered") messages = [{ id: accepted.messageId, type: "user", text: "deliver once", time: { created: 2 } }];
      const conversion = await adapter.changeDelivery("ses", accepted.messageId, "convert", "queue").catch(error => error);
      const withdrawalReads = server.requests("GET", "/api/session/ses/message").length;
      const pending = [...adapter.pendingSteersForTests("ses")];
      const snapshot = await adapter.history("ses");
      const prompts = server.requests("POST", "/api/session/ses/prompt").length;
      // Complete the parent and cross the public admission lane with an
      // independent submission. An incorrectly re-held steer would dispatch
      // here with a new identity, duplicating the already-delivered text.
      adapter.projectionForTests("ses").statusUpdate("completed");
      await adapter.prompt("ses", "next-request", "independent next turn", undefined, undefined, undefined, undefined, "queue");
      expect(server.requests("POST", "/api/session/ses/prompt").filter(call => (call.body as { text: string }).text === "deliver once")).toHaveLength(1);
      expect(conversion).toBeInstanceOf(outcome === "delivered" ? SteerAlreadyDeliveredError : SteerWithdrawalUnconfirmedError);
      expect(withdrawalReads).toBe(reads + (outcome === "delivered" ? 1 : 0));
      if (outcome === "delivered") {
        expect(pending).toEqual([]);
        expect(snapshot.queued ?? []).toEqual([]);
      } else {
        // Empty history after an uncertain cancel response is not authority
        // to re-hold input; keep its original inspectable handle instead.
        expect(snapshot.queued).toEqual([expect.objectContaining({ id: accepted.messageId, requestId: "original-request", delivery: "steer", unconfirmed: true })]);
      }
      expect(prompts).toBe(1);
    } finally {
      stream.close();
      await events.next();
      await adapter.dispose();
    }
  });

  for (const overlap of ["before-pending", "during-resolved", "during-pending"] as const) for (const outcome of ["success", "error"] as const) test(`cancel ${outcome} fences ${overlap} history reads from later reuse`, async () => {
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    let releaseCancel!: () => void, cancelStarted!: () => void, releaseHistory!: () => void, historyStarted!: () => void;
    const cancellation = new Promise<void>(resolve => { releaseCancel = resolve; });
    const cancelling = new Promise<void>(resolve => { cancelStarted = resolve; });
    const history = new Promise<void>(resolve => { releaseHistory = resolve; });
    const reading = new Promise<void>(resolve => { historyStarted = resolve; });
    let messages: unknown[] = [], reads = 0;
    const server = fakeOpenCode({
      "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) {
        stream = controller;
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "server.connected", data: {} })}\n\n`));
      } }), { headers: { "content-type": "text/event-stream" } }),
      "GET /api/session/ses": () => session("ses"),
      "GET /api/session/ses/message": async () => {
        const snapshot = [...messages];
        if (++reads === 1) { historyStarted(); await history; }
        return { data: snapshot, cursor: {} };
      },
      "DELETE /api/session/ses/inbox/msg": async () => {
        cancelStarted(); await cancellation;
        return outcome === "error" ? Response.json({ _tag: "UnknownError", message: "response lost" }, { status: 500 }) : undefined;
      },
    });
    const provider = server.provider();
    const events = provider.events(new AbortController().signal)[Symbol.asyncIterator]();
    try {
      await events.next();
      const oldRead = overlap === "before-pending" ? provider.listMessages("ses", { limit: 50 }) : undefined;
      if (oldRead) await reading;
      const cancel = provider.cancelInbox("ses", "msg").then(() => undefined, error => error);
      await cancelling;
      const overlappingRead = oldRead ?? provider.listMessages("ses", { limit: 50 });
      await reading;
      if (overlap === "during-resolved") {
        releaseHistory();
        expect((await overlappingRead).completeItems).toEqual([]);
      }
      // Native delivery wins while both its event and the cancel response
      // are withheld. A pre-boundary read still owns an empty snapshot.
      messages = [{ id: "msg", type: "user", text: "delivered", time: { created: 2 } }];
      releaseCancel();
      const result = await cancel;
      if (outcome === "error") expect(result).toBeInstanceOf(Error);
      else expect(result).toBeUndefined();
      // The post-cancel read must finish independently of the older read.
      const fresh = await provider.listMessages("ses", { limit: 50 });
      expect(fresh.completeItems?.map(item => item.id)).toEqual(["message:msg"]);
      releaseHistory(); await overlappingRead;
      // Late completion cannot replace the new boundary's retained value.
      expect((await provider.listMessages("ses", { limit: 50 })).completeItems).toEqual(fresh.completeItems);
      expect(reads).toBe(2);
    } finally {
      releaseCancel(); releaseHistory();
      stream.close(); await events.next(); await provider.dispose();
    }
  });

  test("a retried prompt is the same message to OpenCode", async () => {
    const server = fakeOpenCode({ "POST /api/session/:id/prompt": ({ body }) => ({ id: (body as { id: string }).id, sessionID: "ses_1", time: { created: 1 }, type: "user", payload: { text: "x" }, delivery: "queue" }) });
    const first = await server.provider().prompt("ses_1", { id: "req-9", text: "x", delivery: "queue" });
    const second = await server.provider().prompt("ses_1", { id: "req-9", text: "x", delivery: "queue" });
    expect(second.messageId).toBe(first.messageId);
  });

  test("commands and compaction queue through their own routes; interrupt hits its route", async () => {
    const server = fakeOpenCode({
      "POST /api/session/:id/command": () => undefined,
      "POST /api/session/:id/compact": ({ body }) => ({ id: (body as { id: string }).id, sessionID: "ses_1", time: { created: 1 }, type: "compaction", payload: {}, delivery: "queue" }),
      "POST /api/session/:id/interrupt": () => ({ interrupted: true }),
    });
    const provider = server.provider();
    // With no stream to name the server's row, the local id stands.
    const command = await provider.command("ses_1", { id: "req-2", name: "review", arguments: "branch" });
    const compaction = await provider.command("ses_1", { id: "req-3", name: "compact", arguments: "" });
    await provider.interrupt("ses_1");
    expect(command.messageId).toMatch(/^msg_[0-9a-f]{26}$/);
    expect(server.requests("POST", "/api/session/ses_1/command")[0]?.body).toEqual({ name: "review", text: "branch", delivery: "queue" });
    // Compaction carries the stable id like a prompt, so the inbox item is
    // the one this process already holds.
    expect(server.requests("POST", "/api/session/ses_1/compact")[0]?.body).toEqual({ id: compaction.messageId, delivery: "queue" });
    expect(compaction.messageId).toMatch(/^msg_[0-9a-f]{26}$/);
    expect(compaction.messageId).not.toBe(command.messageId);
    expect(server.requests("POST", "/api/session/ses_1/interrupt")).toHaveLength(1);
  });

  test("a skill runs as a prompt carrying the skill, its text opening with the mention", async () => {
    const server = fakeOpenCode({
      "GET /api/skill": () => scoped([skillInfo("openspec-apply-change")]),
      "POST /api/session/:id/prompt": ({ body }) => ({ id: (body as { id: string }).id, sessionID: "ses_1", time: { created: 1 }, type: "user", payload: {}, delivery: "queue" }),
    });
    const provider = server.provider();
    const withArguments = await provider.command("ses_1", { id: "req-s1", name: "openspec-apply-change", arguments: "my-change" });
    const bare = await provider.command("ses_1", { id: "req-s2", name: "openspec-apply-change", arguments: "" });
    // The row reads as what was sent, so the adapter's acceptance agrees with the stream's.
    expect(withArguments.text).toBe("@openspec-apply-change my-change");
    expect(bare.text).toBe("@openspec-apply-change");
    const prompts = server.requests("POST", "/api/session/ses_1/prompt");
    const mention = { start: 0, end: 22, text: "@openspec-apply-change" };
    expect(prompts[0]?.body).toEqual({ id: withArguments.messageId, text: "@openspec-apply-change my-change", skills: [{ id: "openspec-apply-change", mention }], delivery: "queue", resume: true });
    expect(prompts[1]?.body).toEqual({ id: bare.messageId, text: "@openspec-apply-change", skills: [{ id: "openspec-apply-change", mention }], delivery: "queue", resume: true });
    expect(server.requests("POST", "/api/session/ses_1/command")).toHaveLength(0);
  });

  test("a config command of the same name runs as a command, not the skill", async () => {
    const server = fakeOpenCode({
      "GET /api/command": () => scoped([{ name: "review" }]),
      "GET /api/skill": () => scoped([skillInfo("review")]),
      "POST /api/session/:id/command": () => undefined,
    });
    await server.provider().command("ses_1", { id: "req-r", name: "review", arguments: "branch" });
    expect(server.requests("POST", "/api/session/ses_1/command")[0]?.body).toEqual({ name: "review", text: "branch", delivery: "queue" });
    expect(server.requests("POST", "/api/session/ses_1/prompt")).toHaveLength(0);
  });

  test("a skill gone from the catalog at dispatch is refused by the server, never sent as prose", async () => {
    const server = fakeOpenCode({
      "POST /api/session/:id/command": () => Response.json({ _tag: "CommandNotFoundError", message: "Command not found: gone-skill" }, { status: 404 }),
    });
    await expect(server.provider().command("ses_1", { id: "req-g", name: "gone-skill", arguments: "" })).rejects.toThrow("gone-skill");
    expect(server.requests("POST", "/api/session/ses_1/prompt")).toHaveLength(0);
  });

  // A reload as the pinned client sees it: the reply, then (as a real 2.x
  // server does) the rebuilt location announcing its catalogs.
  async function reloadHarness(reply: () => unknown, options: { reloadSettleMs?: number } = {}) {
    const events = pushableEvents();
    const server = fakeOpenCode({ "GET /api/event": events.route, "POST /api/location/reload": reply });
    const provider = server.provider(WORKSPACE, options);
    const controller = new AbortController();
    const seen: string[] = [];
    const pump = (async () => {
      for await (const event of provider.events(controller.signal)) for (const update of event.updates) {
        if (update.kind === "upsert" && update.item.type === "notice") seen.push(`notice ${update.item.level} ${update.item.message}`);
        if (update.kind === "remove") seen.push(`remove ${update.itemId}`);
        if (update.kind === "status") seen.push(`status ${update.status}`);
      }
    })();
    await Bun.sleep(10); // the stream is live once its first frame has arrived
    const announce = (type: string, directory = WORKSPACE) => events.frame({ id: `evt_${type}_${directory}`, created: 9, type, location: { directory }, data: {} });
    const settle = async (count: number) => {
      const deadline = Date.now() + 2_000;
      while (seen.length < count && Date.now() < deadline) await Bun.sleep(5);
    };
    const stop = async () => { controller.abort(); await pump; };
    return { server, provider, seen, announce, settle, stop };
  }

  test("/reload applies staged model and mode before reloading, since the adapter commits them", async () => {
    const server = fakeOpenCode({
      "POST /api/session/:id/model": () => undefined,
      "POST /api/session/:id/agent": () => undefined,
      "POST /api/location/reload": () => undefined,
    });
    const provider = server.provider(WORKSPACE, { reloadSettleMs: 20 });
    await provider.command("ses_1", { id: "req-reload-staged", name: "reload", arguments: "", model: { providerId: "berget", modelId: "think" }, mode: "plan", variant: "high" });
    const deadline = Date.now() + 2_000;
    while (server.requests("POST", "/api/location/reload").length === 0 && Date.now() < deadline) await Bun.sleep(5);
    expect(server.calls.map(call => `${call.method} ${call.path}`).filter(call => call.startsWith("POST"))).toEqual([
      "POST /api/session/ses_1/model",
      "POST /api/session/ses_1/agent",
      "POST /api/location/reload",
    ]);
    expect(server.requests("POST", "/api/session/ses_1/agent")[0]?.body).toEqual({ agent: "plan" });
  });

  test("/reload reports success once the rebuilt location announces its catalogs", async () => {
    const harness = await reloadHarness(() => undefined);
    const accepted = await harness.provider.command("ses_1", { id: "req-reload", name: "reload", arguments: "" });
    // The acceptance says what ran, so clients need not guess from their catalogs.
    expect(accepted.operation).toBe("reload");
    await harness.settle(1);
    expect(harness.seen).toEqual(["notice info Reloading OpenCode configuration…"]);
    // Another directory's rebuild, and this one's announcements before its
    // shutdown, say nothing about this workspace's reload.
    harness.announce("location.shutdown", "/elsewhere");
    harness.announce("command.updated", "/elsewhere");
    harness.announce("skill.updated", "/elsewhere");
    harness.announce("skill.updated");
    await Bun.sleep(40);
    expect(harness.seen).toHaveLength(1);
    harness.announce("location.shutdown");
    harness.announce("command.updated");
    harness.announce("skill.updated");
    await Bun.sleep(40);
    // Commands and skills alone are not the whole rebuild: models and modes too.
    expect(harness.seen).toHaveLength(1);
    harness.announce("model.updated");
    harness.announce("agent.updated");
    await harness.settle(4);
    expect(harness.seen.slice(1)).toEqual([`remove message:${accepted.messageId}`, "notice info Configuration reloaded", "status completed"]);
    expect(harness.server.requests("POST", "/api/location/reload")).toHaveLength(1);
    // The server's configuration, not the conversation: no session route.
    expect(harness.server.calls.filter(call => call.path.startsWith("/api/session/"))).toHaveLength(0);
    await harness.stop();
  });

  test("concurrent /reloads run one at a time, each settled by its own rebuild", async () => {
    const harness = await reloadHarness(() => undefined);
    await harness.provider.command("ses_1", { id: "req-first", name: "reload", arguments: "" });
    await harness.provider.command("ses_2", { id: "req-second", name: "reload", arguments: "" });
    await Bun.sleep(40);
    // The second waits for the first: its waiter must not see the first rebuild.
    expect(harness.server.requests("POST", "/api/location/reload")).toHaveLength(1);
    const done = () => harness.seen.filter(line => line === "notice info Configuration reloaded").length;
    const rebuild = () => ["location.shutdown", "command.updated", "skill.updated", "model.updated", "agent.updated"].forEach(type => harness.announce(type));
    rebuild();
    const deadline = Date.now() + 2_000;
    while (done() < 1 && Date.now() < deadline) await Bun.sleep(5);
    expect(done()).toBe(1);
    while (harness.server.requests("POST", "/api/location/reload").length < 2 && Date.now() < deadline) await Bun.sleep(5);
    expect(harness.server.requests("POST", "/api/location/reload")).toHaveLength(2);
    await Bun.sleep(40);
    // Its reply alone does not settle it.
    expect(done()).toBe(1);
    rebuild();
    while (done() < 2 && Date.now() < deadline + 2_000) await Bun.sleep(5);
    expect(done()).toBe(2);
    await harness.stop();
  });

  test("/reload that OpenCode never confirms is reported as unconfirmed, not reloaded", async () => {
    const harness = await reloadHarness(() => undefined, { reloadSettleMs: 60 });
    const started = Date.now();
    await harness.provider.command("ses_1", { id: "req-quiet", name: "reload", arguments: "" });
    await harness.settle(4);
    expect(Date.now() - started).toBeGreaterThanOrEqual(55);
    expect(harness.seen[2]).toStartWith("notice warning Reload sent, but OpenCode did not confirm its reloaded configuration");
    // Not the success path: the invoking client must not bank catalogs mid-rebuild.
    expect(harness.seen[3]).toBe("status failed");
    expect(harness.seen).not.toContain("notice info Configuration reloaded");
    await harness.stop();
  });

  test("/reload reports OpenCode's failure at once, with its message", async () => {
    const harness = await reloadHarness(() => Response.json({ _tag: "ServiceUnavailableError", service: "location", message: "bad config: opencode.json" }, { status: 503 }));
    const accepted = await harness.provider.command("ses_1", { id: "req-bad", name: "reload", arguments: "" });
    await harness.settle(4);
    expect(harness.seen).toEqual([
      "notice info Reloading OpenCode configuration…",
      `remove message:${accepted.messageId}`,
      "notice error Reloading the configuration failed: bad config: opencode.json",
      "status failed",
    ]);
    await harness.stop();
  });

  test("a skill or config command named compact runs as listed, not as compaction", async () => {
    const skillServer = fakeOpenCode({
      "GET /api/skill": () => scoped([skillInfo("compact")]),
      "POST /api/session/:id/prompt": ({ body }) => ({ id: (body as { id: string }).id, sessionID: "ses_1", time: { created: 1 }, type: "user", payload: {}, delivery: "queue" }),
    });
    const accepted = await skillServer.provider().command("ses_1", { id: "req-cs", name: "compact", arguments: "" });
    expect(accepted.text).toBe("@compact");
    expect(skillServer.requests("POST", "/api/session/ses_1/compact")).toHaveLength(0);

    const commandServer = fakeOpenCode({ "GET /api/command": () => scoped([{ name: "compact" }]), "POST /api/session/:id/command": () => undefined });
    await commandServer.provider().command("ses_1", { id: "req-cc", name: "compact", arguments: "" });
    expect(commandServer.requests("POST", "/api/session/ses_1/command")[0]?.body).toEqual({ name: "compact", text: "", delivery: "queue" });
    expect(commandServer.requests("POST", "/api/session/ses_1/compact")).toHaveLength(0);
  });

  test("dispatch runs the entry the text was classified against, whatever a later listing says", async () => {
    let skills = [skillInfo("compact")];
    let commands: Array<{ name: string }> = [{ name: "reload" }];
    const server = fakeOpenCode({
      "GET /api/skill": () => scoped(skills),
      "GET /api/command": () => scoped(commands),
      "POST /api/session/:id/prompt": () => Response.json({ _tag: "SkillNotFoundError", skill: "compact", message: "Skill not found: compact" }, { status: 404 }),
      "POST /api/session/:id/command": () => Response.json({ _tag: "CommandNotFoundError", message: "Command not found: reload" }, { status: 404 }),
    });
    const provider = server.provider();
    const classified = await provider.listCommands();
    const compactSkill = classified.find(entry => entry.name === "compact")!;
    const reloadCommand = classified.find(entry => entry.name === "reload")!;
    expect(compactSkill.kind).toBe("skill");
    // Both entries vanish, and another dispatch's listing now names the built-ins.
    skills = [];
    commands = [];
    const later = await provider.listCommands();
    expect(later.filter(entry => entry.name === "compact" || entry.name === "reload").map(entry => entry.kind)).toEqual(["command", "command"]);
    await expect(provider.command("ses_1", { id: "req-gone-skill", name: "compact", arguments: "", listed: compactSkill })).rejects.toThrow("Skill not found");
    await expect(provider.command("ses_1", { id: "req-gone-command", name: "reload", arguments: "", listed: reloadCommand })).rejects.toThrow("Command not found");
    // Sent as what the user chose, refused by OpenCode — never the built-ins.
    expect(server.requests("POST", "/api/session/ses_1/compact")).toHaveLength(0);
    expect(server.requests("POST", "/api/location/reload")).toHaveLength(0);
    // Dispatch reads no catalogs of its own when handed the entry.
    expect(server.requests("GET", "/api/skill")).toHaveLength(2);
  });

  test("a built-in entry handed back dispatches as the built-in", async () => {
    const server = fakeOpenCode({ "POST /api/location/reload": () => undefined });
    const provider = server.provider();
    const builtin = (await provider.listCommands()).find(entry => entry.name === "reload")!;
    await provider.command("ses_1", { id: "req-builtin", name: "reload", arguments: "", listed: builtin });
    await Bun.sleep(20);
    expect(server.requests("POST", "/api/location/reload")).toHaveLength(1);
  });

  test("a config command named reload shadows the built-in", async () => {
    const server = fakeOpenCode({ "GET /api/command": () => scoped([{ name: "reload" }]), "POST /api/session/:id/command": () => undefined });
    const accepted = await server.provider().command("ses_1", { id: "req-cr", name: "reload", arguments: "" });
    expect(accepted.operation).toBeUndefined();
    expect(server.requests("POST", "/api/session/ses_1/command")).toHaveLength(1);
    expect(server.requests("POST", "/api/location/reload")).toHaveLength(0);
  });

  // The stream as the pinned client reads it, with a handle to push frames
  // after the subscription is open.
  function pushableEvents() {
    const encoder = new TextEncoder();
    let push: ReadableStreamDefaultController<Uint8Array> | undefined;
    const frame = (event: Record<string, unknown>) => push?.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
    const route = () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { push = controller; frame({ id: "evt_0", type: "server.connected", data: {} }); },
    }), { status: 200, headers: { "content-type": "text/event-stream" } });
    return { route, frame };
  }
  // The inbox delivering an entry: only then does its row join the timeline
  // (opencode-v2-steering D4). `enqueued` helpers below push both frames.
  const delivered = (inboxID: string, created = 10) => ({ id: `evt_${inboxID}_d`, created, type: "session.inbox.delivered", location: { directory: WORKSPACE }, data: { sessionID: "ses_1", inboxID } });

  test("a slash command's row takes the inbox id the stream names, ahead of the 204", async () => {
    const events = pushableEvents();
    const server = fakeOpenCode({
      "GET /api/event": events.route,
      "POST /api/session/:id/command": () => {
        // The server enqueues the item and announces it before answering,
        // with its own id and the expanded template as the text.
        events.frame({ id: "evt_1", created: 5, type: "session.inbox.enqueued", location: { directory: WORKSPACE }, data: { sessionID: "ses_1", inboxID: "msg_srv1", item: { type: "user", payload: { text: "Create or update AGENTS.md" }, delivery: "queue" } } });
        events.frame(delivered("msg_srv1", 6));
        return undefined;
      },
    });
    const provider = server.provider();
    const controller = new AbortController();
    const rows: string[] = [];
    const pump = (async () => {
      for await (const event of provider.events(controller.signal)) for (const update of event.updates) if (update.kind === "upsert") rows.push(update.item.id);
    })();
    await Bun.sleep(10); // the stream is live once its first frame has arrived
    expect(await provider.command("ses_1", { id: "req-5", name: "init", arguments: "" })).toEqual({ messageId: "msg_srv1" });
    // The enqueue named the row's id before the admission returned; the row
    // itself lands with the delivery that followed it.
    const deadline = Date.now() + 2_000;
    while (rows.length < 1 && Date.now() < deadline) await Bun.sleep(5);
    expect(rows).toEqual(["message:msg_srv1"]);
    controller.abort();
    await pump;
  });

  test("a server id that arrives after the window retires the local row", async () => {
    const events = pushableEvents();
    const server = fakeOpenCode({ "GET /api/event": events.route, "POST /api/session/:id/command": () => undefined });
    const provider = server.provider(WORKSPACE, { commandAdmissionMs: 20 });
    const controller = new AbortController();
    const seen: string[] = [];
    const pump = (async () => {
      for await (const event of provider.events(controller.signal)) for (const update of event.updates) {
        if (update.kind === "upsert") seen.push(`upsert ${update.item.id}`);
        if (update.kind === "remove") seen.push(`remove ${update.itemId}`);
      }
    })();
    await Bun.sleep(10); // the stream is live once its first frame has arrived
    const accepted = await provider.command("ses_1", { id: "req-7", name: "init", arguments: "" });
    expect(accepted.messageId).toMatch(/^msg_[0-9a-f]{26}$/);
    // The stream names the row only now, after the caller's own upsert.
    events.frame({ id: "evt_9", created: 9, type: "session.inbox.enqueued", location: { directory: WORKSPACE }, data: { sessionID: "ses_1", inboxID: "msg_late", item: { type: "user", payload: { text: "Create or update AGENTS.md" }, delivery: "queue" } } });
    events.frame(delivered("msg_late", 10));
    const deadline = Date.now() + 2_000;
    while (seen.length < 2 && Date.now() < deadline) await Bun.sleep(5);
    expect(seen).toEqual([`remove message:${accepted.messageId}`, "upsert message:msg_late"]);
    controller.abort();
    await pump;
  });

  test("a late row goes to the oldest admission; a newer waiter takes the next one", async () => {
    const events = pushableEvents();
    const server = fakeOpenCode({ "GET /api/event": events.route, "POST /api/session/:id/command": () => undefined });
    // B's window has to outlast the wait for A's late row below, which is real
    // time a loaded machine can stretch; A's window simply passes first.
    const provider = server.provider(WORKSPACE, { commandAdmissionMs: 500 });
    const controller = new AbortController();
    const seen: string[] = [];
    const pump = (async () => {
      for await (const event of provider.events(controller.signal)) for (const update of event.updates) {
        if (update.kind === "upsert") seen.push(`upsert ${update.item.id}`);
        if (update.kind === "remove") seen.push(`remove ${update.itemId}`);
      }
    })();
    await Bun.sleep(10); // the stream is live once its first frame has arrived
    const enqueued = (inboxID: string) => { events.frame({ id: `evt_${inboxID}`, created: 9, type: "session.inbox.enqueued", location: { directory: WORKSPACE }, data: { sessionID: "ses_1", inboxID, item: { type: "user", payload: { text: "expanded" }, delivery: "queue" } } }); events.frame(delivered(inboxID)); };
    const a = await provider.command("ses_1", { id: "req-a", name: "init", arguments: "" });
    // B is admitted while A's row is still on its way.
    const b = provider.command("ses_1", { id: "req-b", name: "review", arguments: "" });
    await Bun.sleep(5);
    enqueued("msg_a");
    let deadline = Date.now() + 2_000;
    while (seen.length < 2 && Date.now() < deadline) await Bun.sleep(5);
    expect(seen).toEqual([`remove message:${a.messageId}`, "upsert message:msg_a"]);
    enqueued("msg_b");
    expect(await b).toEqual({ messageId: "msg_b" });
    deadline = Date.now() + 2_000;
    while (seen.length < 3 && Date.now() < deadline) await Bun.sleep(5);
    expect(seen).toEqual([`remove message:${a.messageId}`, "upsert message:msg_a", "upsert message:msg_b"]);
    controller.abort();
    await pump;
  });

  test("several admissions past their window take their rows in admission order", async () => {
    const events = pushableEvents();
    const server = fakeOpenCode({ "GET /api/event": events.route, "POST /api/session/:id/command": () => undefined });
    const provider = server.provider(WORKSPACE, { commandAdmissionMs: 20 });
    const controller = new AbortController();
    const seen: string[] = [];
    const pump = (async () => {
      for await (const event of provider.events(controller.signal)) for (const update of event.updates) {
        if (update.kind === "upsert") seen.push(`upsert ${update.item.id}`);
        if (update.kind === "remove") seen.push(`remove ${update.itemId}`);
      }
    })();
    await Bun.sleep(10); // the stream is live once its first frame has arrived
    const enqueued = (inboxID: string) => { events.frame({ id: `evt_${inboxID}`, created: 9, type: "session.inbox.enqueued", location: { directory: WORKSPACE }, data: { sessionID: "ses_1", inboxID, item: { type: "user", payload: { text: "expanded" }, delivery: "queue" } } }); events.frame(delivered(inboxID)); };
    const a = await provider.command("ses_1", { id: "req-a2", name: "init", arguments: "" });
    const b = await provider.command("ses_1", { id: "req-b2", name: "review", arguments: "" });
    enqueued("msg_a");
    enqueued("msg_b");
    const deadline = Date.now() + 2_000;
    while (seen.length < 4 && Date.now() < deadline) await Bun.sleep(5);
    expect(seen).toEqual([`remove message:${a.messageId}`, "upsert message:msg_a", `remove message:${b.messageId}`, "upsert message:msg_b"]);
    controller.abort();
    await pump;
  });

  test("a refusal that lands after the window reaches the stream: placeholder gone, refusal shown, turn failed, no claim on the next row", async () => {
    const events = pushableEvents();
    const server = fakeOpenCode({
      "GET /api/event": events.route,
      "POST /api/session/:id/command": async () => { await Bun.sleep(60); return Response.json({ _tag: "CommandNotFoundError", message: "Command not found: nope" }, { status: 404 }); },
    });
    const provider = server.provider(WORKSPACE, { commandAdmissionMs: 20 });
    const controller = new AbortController();
    const seen: string[] = [];
    const pump = (async () => {
      for await (const event of provider.events(controller.signal)) for (const update of event.updates) {
        if (update.kind === "upsert") seen.push(`upsert ${update.item.id}${update.item.type === "notice" ? ` ${update.item.level}` : ""}`);
        if (update.kind === "remove") seen.push(`remove ${update.itemId}`);
        if (update.kind === "status") seen.push(`status ${update.status}`);
      }
    })();
    await Bun.sleep(10); // the stream is live once its first frame has arrived
    const accepted = await provider.command("ses_1", { id: "req-n", name: "nope", arguments: "" });
    expect(accepted.messageId).toMatch(/^msg_/);
    let deadline = Date.now() + 2_000;
    while (seen.length < 3 && Date.now() < deadline) await Bun.sleep(5);
    expect(seen).toEqual([`remove message:${accepted.messageId}`, `upsert notice:${accepted.messageId}:refused error`, "status failed"]);
    events.frame({ id: "evt_x", created: 9, type: "session.inbox.enqueued", location: { directory: WORKSPACE }, data: { sessionID: "ses_1", inboxID: "msg_x", item: { type: "user", payload: { text: "someone else's prompt" }, delivery: "queue" } } });
    events.frame(delivered("msg_x", 10));
    deadline = Date.now() + 2_000;
    while (seen.length < 4 && Date.now() < deadline) await Bun.sleep(5);
    await Bun.sleep(30);
    expect(seen.slice(3)).toEqual(["upsert message:msg_x"]);
    controller.abort();
    await pump;
  });

  test("a lost response after the window is not a refusal: the admission stays and its row retires the placeholder", async () => {
    const events = pushableEvents();
    const server = fakeOpenCode({
      "GET /api/event": events.route,
      "POST /api/session/:id/command": async () => { await Bun.sleep(60); throw new TypeError("fetch failed"); },
    });
    const provider = server.provider(WORKSPACE, { commandAdmissionMs: 20 });
    const controller = new AbortController();
    const seen: string[] = [];
    const pump = (async () => {
      for await (const event of provider.events(controller.signal)) for (const update of event.updates) {
        if (update.kind === "upsert") seen.push(`upsert ${update.item.id}`);
        if (update.kind === "remove") seen.push(`remove ${update.itemId}`);
        if (update.kind === "status") seen.push(`status ${update.status}`);
      }
    })();
    await Bun.sleep(10); // the stream is live once its first frame has arrived
    const accepted = await provider.command("ses_1", { id: "req-t", name: "init", arguments: "" });
    await Bun.sleep(120);
    expect(seen).toEqual([]);
    events.frame({ id: "evt_t", created: 9, type: "session.inbox.enqueued", location: { directory: WORKSPACE }, data: { sessionID: "ses_1", inboxID: "msg_t", item: { type: "user", payload: { text: "expanded" }, delivery: "queue" } } });
    events.frame(delivered("msg_t", 10));
    const deadline = Date.now() + 2_000;
    while (seen.length < 2 && Date.now() < deadline) await Bun.sleep(5);
    expect(seen).toEqual([`remove message:${accepted.messageId}`, "upsert message:msg_t"]);
    controller.abort();
    await pump;
  });

  test("a prompt's own row never satisfies a waiting command admission", async () => {
    const events = pushableEvents();
    const server = fakeOpenCode({
      "GET /api/event": events.route,
      "POST /api/session/:id/command": () => undefined,
      "POST /api/session/:id/prompt": ({ body }) => ({ id: (body as { id: string }).id, sessionID: "ses_1", time: { created: 1 }, type: "user", payload: { text: "x" }, delivery: "queue" }),
    });
    const provider = server.provider(WORKSPACE, { commandAdmissionMs: 20 });
    const controller = new AbortController();
    const seen: string[] = [];
    const pump = (async () => {
      for await (const event of provider.events(controller.signal)) for (const update of event.updates) {
        if (update.kind === "upsert") seen.push(`upsert ${update.item.id}`);
        if (update.kind === "remove") seen.push(`remove ${update.itemId}`);
      }
    })();
    await Bun.sleep(10); // the stream is live once its first frame has arrived
    const enqueued = (inboxID: string) => { events.frame({ id: `evt_${inboxID}`, created: 9, type: "session.inbox.enqueued", location: { directory: WORKSPACE }, data: { sessionID: "ses_1", inboxID, item: { type: "user", payload: { text: "t" }, delivery: "queue" } } }); events.frame(delivered(inboxID)); };
    const command = await provider.command("ses_1", { id: "req-c", name: "init", arguments: "" });
    const prompt = await provider.prompt("ses_1", { id: "req-p", text: "x", delivery: "queue" });
    enqueued(prompt.messageId);
    enqueued("msg_cmd");
    const deadline = Date.now() + 2_000;
    while (seen.length < 3 && Date.now() < deadline) await Bun.sleep(5);
    expect(seen).toEqual([`upsert message:${prompt.messageId}`, `remove message:${command.messageId}`, "upsert message:msg_cmd"]);
    controller.abort();
    await pump;
  });

  test("a prompt's row announced before the prompt is answered is still a prompt's", async () => {
    const events = pushableEvents();
    const enqueued = (inboxID: string) => { events.frame({ id: `evt_${inboxID}`, created: 9, type: "session.inbox.enqueued", location: { directory: WORKSPACE }, data: { sessionID: "ses_1", inboxID, item: { type: "user", payload: { text: "t" }, delivery: "queue" } } }); events.frame(delivered(inboxID)); };
    const server = fakeOpenCode({
      "GET /api/event": events.route,
      "POST /api/session/:id/command": () => undefined,
      // The server announces the row, then takes its time answering.
      "POST /api/session/:id/prompt": async ({ body }) => { const id = (body as { id: string }).id; enqueued(id); await Bun.sleep(30); return { id, sessionID: "ses_1", time: { created: 1 }, type: "user", payload: { text: "x" }, delivery: "queue" }; },
    });
    const provider = server.provider(WORKSPACE, { commandAdmissionMs: 20 });
    const controller = new AbortController();
    const seen: string[] = [];
    const pump = (async () => {
      for await (const event of provider.events(controller.signal)) for (const update of event.updates) {
        if (update.kind === "upsert") seen.push(`upsert ${update.item.id}`);
        if (update.kind === "remove") seen.push(`remove ${update.itemId}`);
      }
    })();
    await Bun.sleep(10); // the stream is live once its first frame has arrived
    const command = await provider.command("ses_1", { id: "req-c3", name: "init", arguments: "" });
    const prompt = await provider.prompt("ses_1", { id: "req-p3", text: "x", delivery: "queue" });
    enqueued("msg_cmd3");
    const deadline = Date.now() + 2_000;
    while (seen.length < 3 && Date.now() < deadline) await Bun.sleep(5);
    expect(seen).toEqual([`upsert message:${prompt.messageId}`, `remove message:${command.messageId}`, "upsert message:msg_cmd3"]);
    controller.abort();
    await pump;
  });

  test("a refusal that lands while the stream is down goes out on the next stream", async () => {
    const events = pushableEvents();
    const server = fakeOpenCode({
      "GET /api/event": events.route,
      "POST /api/session/:id/command": async () => { await Bun.sleep(80); return Response.json({ _tag: "CommandNotFoundError", message: "Command not found: nope" }, { status: 404 }); },
    });
    const provider = server.provider(WORKSPACE, { commandAdmissionMs: 20 });
    const first = new AbortController();
    const firstPump = (async () => { for await (const _ of provider.events(first.signal)) { /* drain */ } })();
    const accepted = await provider.command("ses_1", { id: "req-d", name: "nope", arguments: "" });
    first.abort();
    await firstPump;
    await Bun.sleep(120);
    const second = new AbortController();
    const seen: string[] = [];
    const pump = (async () => {
      for await (const event of provider.events(second.signal)) for (const update of event.updates) {
        if (update.kind === "remove") seen.push(`remove ${update.itemId}`);
        if (update.kind === "status") seen.push(`status ${update.status}`);
      }
    })();
    await Bun.sleep(10); // the stream is live once its first frame has arrived
    const deadline = Date.now() + 2_000;
    while (seen.length < 2 && Date.now() < deadline) await Bun.sleep(5);
    expect(seen).toEqual([`remove message:${accepted.messageId}`, "status failed"]);
    second.abort();
    await pump;
  });

  test("a stream that ends during the window leaves no record for the next stream to misapply", async () => {
    const events = pushableEvents();
    const server = fakeOpenCode({ "GET /api/event": events.route, "POST /api/session/:id/command": () => undefined });
    const provider = server.provider(WORKSPACE, { commandAdmissionMs: 120 });
    const first = new AbortController();
    const firstPump = (async () => { for await (const _ of provider.events(first.signal)) { /* drain */ } })();
    await Bun.sleep(10);
    const admission = provider.command("ses_1", { id: "req-g", name: "init", arguments: "" });
    // The stream dies mid-window; the window then closes on its own.
    await Bun.sleep(30);
    first.abort();
    await firstPump;
    const accepted = await admission;
    expect(accepted.messageId).toMatch(/^msg_[0-9a-f]{26}$/);
    const second = new AbortController();
    const seen: string[] = [];
    const pump = (async () => {
      for await (const event of provider.events(second.signal)) for (const update of event.updates) {
        if (update.kind === "upsert") seen.push(`upsert ${update.item.id}`);
        if (update.kind === "remove") seen.push(`remove ${update.itemId}`);
      }
    })();
    await Bun.sleep(20);
    events.frame({ id: "evt_z", created: 9, type: "session.inbox.enqueued", location: { directory: WORKSPACE }, data: { sessionID: "ses_1", inboxID: "msg_z", item: { type: "user", payload: { text: "next command" }, delivery: "queue" } } });
    events.frame(delivered("msg_z", 10));
    const deadline = Date.now() + 2_000;
    while (seen.length < 1 && Date.now() < deadline) await Bun.sleep(5);
    await Bun.sleep(30);
    expect(seen).toEqual(["upsert message:msg_z"]);
    second.abort();
    await pump;
  });

  test("a refusal after a window the stream did not outlive still reaches the next stream", async () => {
    const events = pushableEvents();
    const server = fakeOpenCode({
      "GET /api/event": events.route,
      "POST /api/session/:id/command": async () => { await Bun.sleep(200); return Response.json({ _tag: "CommandNotFoundError", message: "Command not found: nope" }, { status: 404 }); },
    });
    const provider = server.provider(WORKSPACE, { commandAdmissionMs: 120 });
    const first = new AbortController();
    const firstPump = (async () => { for await (const _ of provider.events(first.signal)) { /* drain */ } })();
    await Bun.sleep(10);
    const admission = provider.command("ses_1", { id: "req-h", name: "nope", arguments: "" });
    await Bun.sleep(30);
    first.abort();
    await firstPump;
    const accepted = await admission;
    expect(accepted.messageId).toMatch(/^msg_[0-9a-f]{26}$/);
    await Bun.sleep(150);
    const second = new AbortController();
    const seen: string[] = [];
    const pump = (async () => {
      for await (const event of provider.events(second.signal)) for (const update of event.updates) {
        if (update.kind === "remove") seen.push(`remove ${update.itemId}`);
        if (update.kind === "status") seen.push(`status ${update.status}`);
      }
    })();
    await Bun.sleep(10); // the stream is live once its first frame has arrived
    const deadline = Date.now() + 2_000;
    while (seen.length < 2 && Date.now() < deadline) await Bun.sleep(5);
    expect(seen).toEqual([`remove message:${accepted.messageId}`, "status failed"]);
    second.abort();
    await pump;
  });

  test("a command dispatched with no stream that is refused after the window is reconciled once a stream starts", async () => {
    const events = pushableEvents();
    const server = fakeOpenCode({
      "GET /api/event": events.route,
      "POST /api/session/:id/command": async () => { await Bun.sleep(60); return Response.json({ _tag: "CommandNotFoundError", message: "Command not found: nope" }, { status: 404 }); },
    });
    const provider = server.provider(WORKSPACE, { commandAdmissionMs: 20 });
    // No stream yet: the pump is starting up or reconnecting.
    const accepted = await provider.command("ses_1", { id: "req-n2", name: "nope", arguments: "" });
    expect(accepted.messageId).toMatch(/^msg_[0-9a-f]{26}$/);
    await Bun.sleep(80);
    const controller = new AbortController();
    const seen: string[] = [];
    const pump = (async () => {
      for await (const event of provider.events(controller.signal)) for (const update of event.updates) {
        if (update.kind === "remove") seen.push(`remove ${update.itemId}`);
        if (update.kind === "status") seen.push(`status ${update.status}`);
      }
    })();
    await Bun.sleep(10); // the stream is live once its first frame has arrived
    const deadline = Date.now() + 2_000;
    while (seen.length < 2 && Date.now() < deadline) await Bun.sleep(5);
    expect(seen).toEqual([`remove message:${accepted.messageId}`, "status failed"]);
    controller.abort();
    await pump;
  });

  test("a command admitted before the stream's first frame waits on nothing and leaves no record", async () => {
    const encoder = new TextEncoder();
    let push: ReadableStreamDefaultController<Uint8Array> | undefined;
    const frame = (event: Record<string, unknown>) => push?.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
    const server = fakeOpenCode({
      // The subscription opens, but its first frame takes its time.
      "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) { push = controller; setTimeout(() => frame({ id: "evt_0", type: "server.connected", data: {} }), 80); } }), { status: 200, headers: { "content-type": "text/event-stream" } }),
      "POST /api/session/:id/command": () => undefined,
    });
    const provider = server.provider(WORKSPACE, { commandAdmissionMs: 20 });
    const controller = new AbortController();
    const seen: string[] = [];
    const pump = (async () => {
      for await (const event of provider.events(controller.signal)) for (const update of event.updates) {
        if (update.kind === "upsert") seen.push(`upsert ${update.item.id}`);
        if (update.kind === "remove") seen.push(`remove ${update.itemId}`);
      }
    })();
    await Bun.sleep(10);
    const accepted = await provider.command("ses_1", { id: "req-pre", name: "init", arguments: "" });
    expect(accepted.messageId).toMatch(/^msg_[0-9a-f]{26}$/);
    await Bun.sleep(100);
    frame({ id: "evt_q", created: 9, type: "session.inbox.enqueued", location: { directory: WORKSPACE }, data: { sessionID: "ses_1", inboxID: "msg_q", item: { type: "user", payload: { text: "next command" }, delivery: "queue" } } });
    frame(delivered("msg_q", 10));
    const deadline = Date.now() + 2_000;
    while (seen.length < 1 && Date.now() < deadline) await Bun.sleep(5);
    await Bun.sleep(30);
    expect(seen).toEqual(["upsert message:msg_q"]);
    controller.abort();
    await pump;
  });

  test("a command admitted before the handshake still takes a row the stream delivers after it", async () => {
    const encoder = new TextEncoder();
    let push: ReadableStreamDefaultController<Uint8Array> | undefined;
    const frame = (event: Record<string, unknown>) => push?.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
    const server = fakeOpenCode({
      "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({ start(controller) { push = controller; setTimeout(() => frame({ id: "evt_0", type: "server.connected", data: {} }), 80); } }), { status: 200, headers: { "content-type": "text/event-stream" } }),
      "POST /api/session/:id/command": () => undefined,
    });
    const provider = server.provider(WORKSPACE, { commandAdmissionMs: 500 });
    const controller = new AbortController();
    const pump = (async () => { for await (const _ of provider.events(controller.signal)) { /* drain */ } })();
    await Bun.sleep(10);
    const admission = provider.command("ses_1", { id: "req-hs", name: "init", arguments: "" });
    await Bun.sleep(120);
    frame({ id: "evt_h", created: 9, type: "session.inbox.enqueued", location: { directory: WORKSPACE }, data: { sessionID: "ses_1", inboxID: "msg_h", item: { type: "user", payload: { text: "expanded" }, delivery: "queue" } } });
    frame(delivered("msg_h", 10));
    expect(await admission).toEqual({ messageId: "msg_h" });
    controller.abort();
    await pump;
  });

  test("a connection refused after the window reaches the stream like a server refusal", async () => {
    const events = pushableEvents();
    const server = fakeOpenCode({
      "GET /api/event": events.route,
      "POST /api/session/:id/command": async () => { await Bun.sleep(60); throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }); },
    });
    const provider = server.provider(WORKSPACE, { commandAdmissionMs: 20 });
    const controller = new AbortController();
    const seen: string[] = [];
    const pump = (async () => {
      for await (const event of provider.events(controller.signal)) for (const update of event.updates) {
        if (update.kind === "remove") seen.push(`remove ${update.itemId}`);
        if (update.kind === "status") seen.push(`status ${update.status}`);
      }
    })();
    await Bun.sleep(10);
    const accepted = await provider.command("ses_1", { id: "req-cr", name: "init", arguments: "" });
    const deadline = Date.now() + 2_000;
    while (seen.length < 2 && Date.now() < deadline) await Bun.sleep(5);
    expect(seen).toEqual([`remove message:${accepted.messageId}`, "status failed"]);
    controller.abort();
    await pump;
  });

  test("a compaction's inbox item never satisfies a waiting command admission", async () => {
    const events = pushableEvents();
    const server = fakeOpenCode({
      "GET /api/event": events.route,
      "POST /api/session/:id/command": () => undefined,
      "POST /api/session/:id/compact": ({ body }) => ({ id: (body as { id: string }).id, sessionID: "ses_1", time: { created: 1 }, type: "compaction", payload: {}, delivery: "queue" }),
    });
    const provider = server.provider(WORKSPACE, { commandAdmissionMs: 20 });
    const controller = new AbortController();
    const seen: string[] = [];
    const pump = (async () => {
      for await (const event of provider.events(controller.signal)) for (const update of event.updates) {
        if (update.kind === "upsert") seen.push(`upsert ${update.item.id}`);
        if (update.kind === "remove") seen.push(`remove ${update.itemId}`);
      }
    })();
    await Bun.sleep(10);
    const command = await provider.command("ses_1", { id: "req-c9", name: "init", arguments: "" });
    const compaction = await provider.command("ses_1", { id: "req-k9", name: "compact", arguments: "" });
    // As 2.0.13 announces it: a compaction item, which is no row at all.
    events.frame({ id: "evt_k1", created: 9, type: "session.inbox.enqueued", location: { directory: WORKSPACE }, data: { sessionID: "ses_1", inboxID: compaction.messageId, item: { type: "compaction", payload: {}, delivery: "queue" } } });
    // And the shape the finding supposed: a user row under the compaction's id.
    events.frame({ id: "evt_k2", created: 9, type: "session.inbox.enqueued", location: { directory: WORKSPACE }, data: { sessionID: "ses_1", inboxID: compaction.messageId, item: { type: "user", payload: { text: "compact" }, delivery: "queue" } } });
    events.frame(delivered(compaction.messageId, 10));
    events.frame({ id: "evt_k3", created: 9, type: "session.inbox.enqueued", location: { directory: WORKSPACE }, data: { sessionID: "ses_1", inboxID: "msg_cmd9", item: { type: "user", payload: { text: "expanded" }, delivery: "queue" } } });
    events.frame(delivered("msg_cmd9", 10));
    const deadline = Date.now() + 2_000;
    while (seen.length < 3 && Date.now() < deadline) await Bun.sleep(5);
    expect(seen).toEqual([`upsert message:${compaction.messageId}`, `remove message:${command.messageId}`, "upsert message:msg_cmd9"]);
    controller.abort();
    await pump;
  });

  test("an admission still waiting when the stream ends claims nothing on the next stream", async () => {
    const events = pushableEvents();
    const server = fakeOpenCode({ "GET /api/event": events.route, "POST /api/session/:id/command": () => undefined });
    const provider = server.provider(WORKSPACE, { commandAdmissionMs: 20 });
    const first = new AbortController();
    const firstPump = (async () => { for await (const _ of provider.events(first.signal)) { /* drain */ } })();
    await provider.command("ses_1", { id: "req-s", name: "init", arguments: "" });
    first.abort();
    await firstPump;
    const second = new AbortController();
    const seen: string[] = [];
    const pump = (async () => {
      for await (const event of provider.events(second.signal)) for (const update of event.updates) {
        if (update.kind === "upsert") seen.push(`upsert ${update.item.id}`);
        if (update.kind === "remove") seen.push(`remove ${update.itemId}`);
      }
    })();
    await Bun.sleep(20);
    events.frame({ id: "evt_y", created: 9, type: "session.inbox.enqueued", location: { directory: WORKSPACE }, data: { sessionID: "ses_1", inboxID: "msg_y", item: { type: "user", payload: { text: "later" }, delivery: "queue" } } });
    events.frame(delivered("msg_y", 10));
    const deadline = Date.now() + 2_000;
    while (seen.length < 1 && Date.now() < deadline) await Bun.sleep(5);
    await Bun.sleep(30);
    expect(seen).toEqual(["upsert message:msg_y"]);
    second.abort();
    await pump;
  });

  test("a slash command the stream never names keeps its local id once the window closes", async () => {
    const events = pushableEvents();
    const server = fakeOpenCode({ "GET /api/event": events.route, "POST /api/session/:id/command": () => undefined });
    const provider = server.provider(WORKSPACE, { commandAdmissionMs: 20 });
    const controller = new AbortController();
    const pump = (async () => { for await (const _ of provider.events(controller.signal)) { /* drain */ } })();
    await Bun.sleep(10); // the stream is live once its first frame has arrived
    const started = Date.now();
    const accepted = await provider.command("ses_1", { id: "req-6", name: "init", arguments: "" });
    expect(accepted.messageId).toMatch(/^msg_[0-9a-f]{26}$/);
    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
    controller.abort();
    await pump;
  });

  test("a lost response inside the window is not a refusal: the row, or the window, decides", async () => {
    const events = pushableEvents();
    const server = fakeOpenCode({
      "GET /api/event": events.route,
      "POST /api/session/:id/command": async () => { await Bun.sleep(10); throw new TypeError("fetch failed"); },
    });
    const provider = server.provider(WORKSPACE, { commandAdmissionMs: 500 });
    const controller = new AbortController();
    const pump = (async () => { for await (const _ of provider.events(controller.signal)) { /* drain */ } })();
    await Bun.sleep(10);
    const admission = provider.command("ses_1", { id: "req-l", name: "init", arguments: "" });
    await Bun.sleep(40);
    events.frame({ id: "evt_l", created: 9, type: "session.inbox.enqueued", location: { directory: WORKSPACE }, data: { sessionID: "ses_1", inboxID: "msg_l", item: { type: "user", payload: { text: "expanded" }, delivery: "queue" } } });
    events.frame(delivered("msg_l", 10));
    expect(await admission).toEqual({ messageId: "msg_l" });
    controller.abort();
    await pump;
  });

  test("a refused connection inside the window is a refusal even with a stream listening", async () => {
    const events = pushableEvents();
    const server = fakeOpenCode({
      "GET /api/event": events.route,
      "POST /api/session/:id/command": async () => { throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }); },
    });
    const provider = server.provider(WORKSPACE, { commandAdmissionMs: 500 });
    const controller = new AbortController();
    const pump = (async () => { for await (const _ of provider.events(controller.signal)) { /* drain */ } })();
    await Bun.sleep(10);
    const started = Date.now();
    // The client wraps it as a transport error; the refusal sits in its cause.
    await expect(provider.command("ses_1", { id: "req-r", name: "init", arguments: "" })).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(400);
    controller.abort();
    await pump;
  });

  test("an invalid command rejects within the admission window", async () => {
    const server = fakeOpenCode({ "POST /api/session/:id/command": () => Response.json({ _tag: "CommandNotFoundError", message: "Command not found: nope" }, { status: 404 }) });
    await expect(server.provider().command("ses_1", { id: "req-4", name: "nope", arguments: "" })).rejects.toThrow();
  });

  test("events stream from /api/event, normalized and scoped, until the signal aborts", async () => {
    const frames = [
      { id: "evt_1", type: "server.connected", data: {} },
      { id: "evt_2", created: 5, type: "session.execution.started", data: { sessionID: "ses_1" } },
      { id: "evt_3", created: 6, type: "session.text.delta", location: { directory: "/elsewhere" }, data: { sessionID: "ses_x", assistantMessageID: "msg_x", ordinal: 0, delta: "not ours" } },
      { id: "evt_4", created: 7, type: "session.step.started", location: { directory: WORKSPACE }, data: { sessionID: "ses_1", assistantMessageID: "msg_a", agent: "build", model: { id: "flash", providerID: "opencode" }, started: 7 } },
    ];
    const server = fakeOpenCode({
      "GET /api/event": () => new Response(new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          for (const frame of frames) controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
          controller.enqueue(encoder.encode(": heartbeat\n\n"));
        },
      }), { status: 200, headers: { "content-type": "text/event-stream" } }),
    });
    const controller = new AbortController();
    const seen: Array<{ type: string; outcome: string; conversationId?: string; turns?: number }> = [];
    for await (const event of server.provider().events(controller.signal)) {
      seen.push({ type: event.eventType, outcome: event.outcome, conversationId: event.conversationId, turns: event.notificationTurns?.length });
      if (seen.length === frames.length) controller.abort();
    }
    expect(seen).toEqual([
      { type: "server.connected", outcome: "ignored", conversationId: undefined, turns: undefined },
      { type: "session.execution.started", outcome: "handled", conversationId: "ses_1", turns: undefined },
      { type: "session.text.delta", outcome: "ignored", conversationId: undefined, turns: undefined },
      { type: "session.step.started", outcome: "handled", conversationId: "ses_1", turns: 1 },
    ]);
    expect(server.requests("GET", "/api/event")).toHaveLength(1);
  });
});

describe("OpenCode 2.x provider: permissions and forms", () => {
  test("pending permissions come from the workspace list with their patterns and owner", async () => {
    const server = fakeOpenCode({
      "GET /api/permission/request": () => scoped([
        { id: "per_1", sessionID: "ses_1", action: "external_directory", resources: ["/etc/*"], save: ["/etc/*"], source: { type: "tool", messageID: "msg_a", id: "call_1" } },
        { id: "per_2", sessionID: "ses_2", action: "edit", resources: ["src/a.ts"], metadata: { diff: "--- a\n+++ b\n" } },
        { id: "per_3", sessionID: "ses_1", action: "tracker_create_issue", resources: ["*"], save: ["*"], metadata: {}, source: { type: "tool", messageID: "msg_b", id: "call_2" } },
      ]),
      // A server named `external` must not claim the built-in
      // external_directory ask above.
      "GET /api/mcp": () => scoped([{ name: "tracker", status: { status: "connected" } }, { name: "external", status: { status: "connected" } }]),
    });
    expect(await server.provider().listPermissions()).toEqual([
      // `source` names the tool row the request belongs to; a card rebuilt
      // from this list must be able to show the call it would allow.
      { requestId: "per_1", conversationId: "ses_1", action: "external_directory", resources: ["/etc/*"], alwaysPatterns: ["/etc/*"], sourceToolId: "tool:call_1" },
      { requestId: "per_2", conversationId: "ses_2", action: "edit", resources: ["src/a.ts"], alwaysPatterns: [], diff: "--- a\n+++ b\n" },
      // An MCP tool's action resolves against the reported servers, so the
      // recovered card names the server as a live one would.
      { requestId: "per_3", conversationId: "ses_1", action: "tracker_create_issue", resources: ["*"], alwaysPatterns: ["*"], sourceToolId: "tool:call_2", mcp: { server: "tracker", tool: "create_issue" } },
    ]);
    expect(server.calls[0]?.query.get("location[directory]")).toBe(WORKSPACE);
  });

  test("a live ask for an MCP tool carries its server and tool; a built-in ask carries none", async () => {
    const encoder = new TextEncoder();
    let push: ReadableStreamDefaultController<Uint8Array> | undefined;
    const events = {
      frame: (event: Record<string, unknown>) => push?.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)),
      route: () => new Response(new ReadableStream<Uint8Array>({ start(controller) { push = controller; controller.enqueue(encoder.encode(`data: ${JSON.stringify({ id: "evt_0", type: "server.connected", data: {} })}\n\n`)); } }), { status: 200, headers: { "content-type": "text/event-stream" } }),
    };
    const server = fakeOpenCode({
      "GET /api/event": events.route,
      "GET /api/mcp": () => scoped([{ name: "tracker", status: { status: "connected" } }]),
    });
    const provider = server.provider();
    const controller = new AbortController();
    const seen: Array<Record<string, unknown>> = [];
    const pump = (async () => {
      for await (const event of provider.events(controller.signal)) for (const update of event.updates) if (update.kind === "upsert" && update.item.type === "permission") seen.push(update.item as unknown as Record<string, unknown>);
    })();
    await Bun.sleep(10); // the stream is live once its first frame has arrived
    events.frame({ id: "evt_1", created: 1, type: "permission.asked", location: { directory: WORKSPACE }, data: { id: "per_1", sessionID: "ses_1", action: "tracker_create_issue", resources: ["*"], save: ["*"], metadata: {}, source: { type: "tool", messageID: "msg_a", id: "call_1" } } });
    events.frame({ id: "evt_2", created: 2, type: "permission.asked", location: { directory: WORKSPACE }, data: { id: "per_2", sessionID: "ses_1", action: "bash", resources: ["git status"], save: ["git status *"], metadata: {} } });
    events.frame({ id: "evt_3", created: 3, type: "permission.asked", location: { directory: WORKSPACE }, data: { id: "per_3", sessionID: "ses_1", action: "tracker_directory", resources: ["/etc/*"], save: ["/etc/*"], metadata: {} } });
    for (let i = 0; i < 400 && seen.length < 3; i++) await Bun.sleep(5);
    controller.abort();
    await pump;
    expect(seen.map(item => ({ action: item.action, mcp: item.mcp }))).toEqual([
      { action: "tracker_create_issue", mcp: { server: "tracker", tool: "create_issue" } },
      // A built-in action, and an action over a path rather than a
      // wildcard, are not MCP asks and cost no lookup.
      { action: "bash", mcp: undefined },
      { action: "tracker_directory", mcp: undefined },
    ]);
    expect(server.requests("GET", "/api/mcp")).toHaveLength(1);
  });

  test("a permission reply is one decision on the request's own route", async () => {
    const server = fakeOpenCode({ "POST /api/session/:id/permission/:request/reply": () => undefined });
    await server.provider().replyPermission("ses_1", "per_1", "always");
    expect(server.requests("POST", "/api/session/ses_1/permission/per_1/reply").map(call => call.body)).toEqual([{ decision: "always" }]);
  });

  test("pending forms are structured questions with their owner and intro", async () => {
    const server = fakeOpenCode({
      "GET /api/form": () => scoped([{ id: "frm_1", sessionID: "ses_1", title: "Pick one", fields: [
        { key: "choice", title: "Which?", type: "string", options: [{ value: "a", label: "A" }], custom: true },
        { key: "many", title: "Several", type: "multiselect", options: [{ value: "x", label: "X" }] },
      ] }]),
    });
    expect(await server.provider().listQuestions()).toEqual([{
      requestId: "frm_1",
      conversationId: "ses_1",
      intro: "Pick one",
      questions: [
        { prompt: "Which?", header: "", options: [{ label: "A", description: "" }], multiple: false, allowFreeForm: true, optional: true },
        { prompt: "Several", header: "", options: [{ label: "X", description: "" }], multiple: true, allowFreeForm: false, optional: true },
      ],
    }]);
  });

  test("ordered answers fold back into the form's keyed answer, validated before the reply", async () => {
    const fields = [
      { key: "choice", type: "string", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }], custom: true, required: true },
      { key: "many", type: "multiselect", options: [{ value: "x", label: "X" }, { value: "y", label: "Y" }], minItems: 2, maxItems: 2 },
      { key: "sure", type: "boolean", required: true },
      { key: "count", type: "integer", minimum: 1, maximum: 10 },
      { key: "note", type: "string" },
    ];
    const server = fakeOpenCode({
      "GET /api/session/:id/form/:form": () => ({ id: "frm_1", sessionID: "ses_1", title: "t", fields, state: { status: "pending" } }),
      "POST /api/session/:id/form/:form/reply": () => undefined,
      "DELETE /api/session/:id/form/:form": () => undefined,
    });
    const provider = server.provider();
    await provider.replyQuestion("ses_1", "frm_1", [["B"], ["X", "Y"], ["Yes"], ["3"], ["free text"]]);
    expect(server.requests("POST", "/api/session/ses_1/form/frm_1/reply").map(call => call.body)).toEqual([{ answer: { choice: "b", many: ["x", "y"], sure: true, count: 3, note: "free text" } }]);

    await provider.replyQuestion("ses_1", "frm_1", [["something else"], [], ["No"], [], []]);
    expect(server.requests("POST", "/api/session/ses_1/form/frm_1/reply").at(-1)?.body).toEqual({ answer: { choice: "something else", sure: false } });

    await expect(provider.replyQuestion("ses_1", "frm_1", [["A"], ["X"], ["Yes"], ["2.5"], []])).rejects.toBeInstanceOf(InvalidQuestionAnswerError);
    await expect(provider.replyQuestion("ses_1", "frm_1", [["A"], ["Z"], ["Yes"], ["2"], []])).rejects.toBeInstanceOf(InvalidQuestionAnswerError);
    await expect(provider.replyQuestion("ses_1", "frm_1", [["A"], [], ["maybe"], ["2"], []])).rejects.toBeInstanceOf(InvalidQuestionAnswerError);
    await expect(provider.replyQuestion("ses_1", "frm_1", [["A"], [], ["Yes"], ["11"], []])).rejects.toBeInstanceOf(InvalidQuestionAnswerError);
    // One choice where the form wants two: refused here, not by the server.
    await expect(provider.replyQuestion("ses_1", "frm_1", [["A"], ["X"], ["Yes"], ["2"], []])).rejects.toThrow(/at least 2 choices/);
    expect(server.requests("POST", "/api/session/ses_1/form/frm_1/reply")).toHaveLength(2);

    await provider.rejectQuestion("ses_1", "frm_1");
    expect(server.requests("DELETE", "/api/session/ses_1/form/frm_1")).toHaveLength(1);
  });

  test("recovered forms drop unsupported fields, and the reply folds against the same filtered list", async () => {
    const fields = [
      { key: "login", type: "external", url: "https://example.test/login" },
      { key: "region", type: "string", title: "Region", options: [{ value: "eu", label: "EU" }] },
      { key: "token", type: "string", hidden: true },
    ];
    const server = fakeOpenCode({
      "GET /api/form": () => scoped([{ id: "frm_2", sessionID: "ses_1", title: "Setup", fields }]),
      "GET /api/session/:id/form/:form": () => ({ id: "frm_2", sessionID: "ses_1", title: "Setup", fields, state: { status: "pending" } }),
      "POST /api/session/:id/form/:form/reply": () => undefined,
    });
    const provider = server.provider();
    expect((await provider.listQuestions())[0]?.questions).toEqual([expect.objectContaining({ prompt: "Region" })]);
    await provider.replyQuestion("ses_1", "frm_2", [["EU"]]);
    expect(server.requests("POST", "/api/session/ses_1/form/frm_2/reply")[0]?.body).toEqual({ answer: { region: "eu" } });
  });

  test("a recovered form with no supported field is a cancel-only card, and its reply cancels the form", async () => {
    const fields = [{ key: "login", type: "external", url: "https://example.test/login" }];
    const server = fakeOpenCode({
      "GET /api/form": () => scoped([{ id: "frm_3", sessionID: "ses_1", title: "Sign in", fields }]),
      "GET /api/session/:id/form/:form": () => ({ id: "frm_3", sessionID: "ses_1", title: "Sign in", fields, state: { status: "pending" } }),
      "POST /api/session/:id/form/:form/reply": () => undefined,
      "DELETE /api/session/:id/form/:form": () => undefined,
    });
    const provider = server.provider();
    expect((await provider.listQuestions())[0]).toMatchObject({ intro: "Sign in", link: "https://example.test/login", questions: [{ options: [{ label: "Cancel this form" }] }] });
    await provider.replyQuestion("ses_1", "frm_3", [["Cancel this form"]]);
    expect(server.requests("DELETE", "/api/session/ses_1/form/frm_3")).toHaveLength(1);
    expect(server.requests("POST", "/api/session/ses_1/form/frm_3/reply")).toHaveLength(0);
  });

  test("a multiselect over its maximum is refused; an optional one left empty is not", () => {
    const field = { key: "k", type: "multiselect", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }], maxItems: 1 };
    expect(() => formAnswerFromChoices([field], [["A", "B"]])).toThrow(/at most 1 choices/);
    expect(formAnswerFromChoices([field], [[]])).toEqual({});
  });

  test("a required choice with no answer is refused", () => {
    expect(() => formAnswerFromChoices([{ key: "k", type: "string", required: true }], [[]])).toThrow(InvalidQuestionAnswerError);
    expect(formAnswerFromChoices([{ key: "k", type: "string" }], [[]])).toEqual({});
  });
});

describe("OpenCode 2.x provider: reversible history", () => {
  const userIds = STORED.filter(message => message.type === "user").map(message => String(message.id));

  function revertServer(revert?: { messageID: string }) {
    return fakeOpenCode({
      "GET /api/session/:id": () => session("ses_r", revert ? { revert } : {}),
      "GET /api/session/:id/message": () => ({ data: STORED, cursor: { next: null } }),
      "POST /api/session/:id/revert/stage": ({ body }) => ({ messageID: (body as { messageID: string }).messageID }),
      "DELETE /api/session/:id/revert": () => undefined,
    });
  }

  test("undo stages the latest user turn and restores it as a draft", async () => {
    const server = revertServer();
    const provider = server.provider();
    expect(await provider.getReversibleHistoryState("ses_r")).toEqual({ staged: false, canUndo: true, canRedo: false, revertedMessages: [] });
    const result = await provider.undo("ses_r");
    expect(server.requests("POST", "/api/session/ses_r/revert/stage")[0]?.body).toEqual({ messageID: userIds[1] });
    expect(result).toEqual({
      outcome: "changed",
      state: { staged: true, canUndo: true, canRedo: true, revertedMessages: [{ id: `message:${userIds[1]}`, text: "Reply with exactly: second" }] },
      restoredDraft: { text: "Reply with exactly: second" },
    });
  });

  test("repeated undo walks back; redo at the newest boundary clears the revert", async () => {
    const staged = revertServer({ messageID: userIds[1]! });
    const provider = staged.provider();
    expect(await provider.getReversibleHistoryState("ses_r")).toMatchObject({ staged: true, canUndo: true, canRedo: true });
    const back = await provider.undo("ses_r");
    expect(staged.requests("POST", "/api/session/ses_r/revert/stage")[0]?.body).toEqual({ messageID: userIds[0] });
    expect(back.state).toMatchObject({ staged: true, canUndo: false, canRedo: true });
    expect(back.state.revertedMessages.map(message => message.id)).toEqual(userIds.map(id => `message:${id}`));

    const redo = await provider.redo("ses_r");
    expect(staged.requests("DELETE", "/api/session/ses_r/revert")).toHaveLength(1);
    expect(redo).toEqual({ outcome: "changed", state: { staged: false, canUndo: true, canRedo: false, revertedMessages: [] } });
  });

  test("revert and restore address a specific turn, and refuse one out of reach", async () => {
    const server = revertServer({ messageID: userIds[1]! });
    const provider = server.provider();
    await expect(provider.revert("ses_r", `message:${userIds[1]}`)).rejects.toBeInstanceOf(ReversibleHistoryTargetError);
    const reverted = await provider.revert("ses_r", `message:${userIds[0]}`);
    expect(reverted.restoredDraft).toEqual({ text: String(STORED[0]!.text) });
    await expect(provider.restore("ses_r", "message:nope")).rejects.toBeInstanceOf(ReversibleHistoryTargetError);
    const restored = await provider.restore("ses_r", `message:${userIds[1]}`);
    expect(restored.state.staged).toBe(false);
  });

  test("nothing to undo or redo is reported, not staged", async () => {
    const empty = fakeOpenCode({
      "GET /api/session/:id": () => session("ses_e"),
      "GET /api/session/:id/message": () => ({ data: [], cursor: { next: null } }),
    });
    expect(await empty.provider().undo("ses_e")).toEqual({ outcome: "nothing-to-undo", state: { staged: false, canUndo: false, canRedo: false, revertedMessages: [] } });
    expect(await empty.provider().redo("ses_e")).toMatchObject({ outcome: "nothing-to-redo" });
    expect(empty.requests("POST", "/api/session/ses_e/revert/stage")).toHaveLength(0);
  });
});

describe("OpenCodeV2Provider accounts", () => {
  const model = (providerID: string, id: string) => ({ id, modelID: id, providerID, name: id, capabilities: { tools: true, input: ["text"], output: ["text"] }, variants: [], limit: { context: 8000, output: 800 }, status: "active", enabled: true, cost: [], time: { released: 0 } });

  test("login state is unknown before the catalog is read, ok while any model is offered, missing when none is", async () => {
    let models = [model("opencode", "free")];
    const { provider } = fakeOpenCode({
      "GET /api/model": () => scoped(models),
      "GET /api/provider": () => scoped([{ id: "opencode", name: "OpenCode Zen", activation: "auto", package: "x" }]),
    });
    const instance = provider();
    expect(instance.loginState()).toBe("unknown");
    await instance.listModels();
    expect(instance.loginState()).toBe("ok");
    models = [];
    await instance.listModels();
    expect(instance.loginState()).toBe("missing");
  });

  test("a removal or switch is replayed on this server by credential id; an addition is only re-read", async () => {
    const { provider, calls } = fakeOpenCode({
      "GET /api/model": () => scoped([model("opencode", "free")]),
      "GET /api/provider": () => scoped([{ id: "opencode", name: "OpenCode Zen", activation: "auto", package: "x" }]),
    });
    const instance = provider();
    await instance.accountsChanged({ kind: "added" });
    expect(calls.filter(call => call.path.includes("credential"))).toEqual([]);
    // The credential routes are absent here (as on 2.0.13): the 404s are ignored.
    await expect(instance.accountsChanged({ kind: "removed", target: "groq", credential: "cred_a" })).resolves.toBeUndefined();
    await expect(instance.accountsChanged({ kind: "activated", credential: "cred_b" })).resolves.toBeUndefined();
    expect(calls.filter(call => call.path.includes("credential")).map(call => `${call.method} ${call.path}`)).toEqual([
      "DELETE /api/credential/cred_a",
      "POST /api/credential/cred_b/activate",
    ]);
  });
});
