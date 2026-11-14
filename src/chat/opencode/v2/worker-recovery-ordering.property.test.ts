import { expect, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { gzipSync, gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { ChatAdapter } from "../../adapter";
import { ProviderUpdateCoalescer } from "../../coalescer";
import { clearChatTimeout, type ChatTaskScheduler } from "../../task-scheduler";
import type { BackgroundTaskItem } from "../../types";
import { workerDismissalEvidence } from "../../worker-dismissal-evidence";
import { workerCanStop, workerState } from "../../worker-state";
import { createOpenCodeV2Provider } from "./provider";

/**
 * Bounded transport-only property; original frozen-product RED artifacts remain
 * separate from current-production validation.
 *   UATU_ORDERING_ARTIFACT_DIR=~/.cache/opencode/scratch/pr625-convergence UATU_ORDERING_SEEDS=1000 bun test src/chat/opencode/v2/worker-recovery-ordering.property.test.ts
 *   UATU_ORDERING_SEED=17 bun test src/chat/opencode/v2/worker-recovery-ordering.property.test.ts
 *   UATU_ORDERING_REPLAY=/absolute/path/to/representative.json bun test <same-file>
 * Add UATU_ORDERING_REPLAY_MODE=causal-actions to retain the complete recorded
 * action order and native snapshots while checking corrected publications.
 * No server, dependency runner, private method, replacement provider, or guard fake.
 *
 * Initial exploratory evidence is retained separately. Replay is exact: an
 * unavailable next action waits for its causal notification, and a different
 * observation is a replay divergence, never a passing production result.
 * The optional task scheduler acknowledges detached work and coalescer tails.
 * Exact saved-action replay has been checked in fresh processes for selected
 * representatives, not every seed or every historical harness revision. Seed
 * identity alone is not proof of cross-process equality. Strict mode preserves
 * trace observations and semantic output; causal-actions mode permits changed
 * publications, but never migrates an obsolete oracle contract.
 * It never skips a missing action and requires all saved actions to be consumed.
 * It is deliberately stricter than external-only replay: internal job/transport
 * changes still diverge, rather than guessing which removed work is legitimate.
 * Native payloads are copied at scheduled backend arrival, within the fetch
 * lifetime, not at immediate JavaScript fetch invocation or response release.
 *
 * Admission boundary: permissions/forms are actual native HTTP barriers. Neither
 * is released until the final mutation AND all launched external observations
 * have settled. Every captured publication through owned-history completion is
 * checked, not merely the final projection. The initial subscription must be
 * worker-empty; an earlier
 * worker snapshot invalidates this admission model rather than being silently
 * compared against future state. A separate cold provider reads final native
 * state for results and current activity. A bounded independent native-fact
 * record checks sticky Stop revocation from completed per-consumer parent reads
 * and observed execution ends. No second-provider priming or cache replay.
 * Additional uncertainty/withheld warnings may deny authority, never grant it.
 * Later child text frames change text only, never the launch, report, idle,
 * ownership or inventory.
 *
 * B bounds owned logical parent attempts by four, observed at the injected
 * ChatAdapter history-attempt checkpoint. Physical single-page parent HTTP
 * reads are reported separately: one logical attempt can make multiple reads
 * or reuse a cached page. Cache-only retry storms are not zero attempts.
 * The fifth logical start aborts the owned read; elapsed
 * time is NOT the progress assertion. A finite
 * scheduler/frame budget and a wall-clock watchdog classify harness failures.
 */
const DIRECTORY = "/ws", PARENT = "ses_parent", CHILD = "ses_child";
const ATTEMPTS = 4, FRAME_BUDGET = 128;
// Each frame may create two HTTP lookups (entry/release), two jobs
// (start/settle), coalescer work, and its acknowledgement. Leave one further
// factor of two plus 256 setup actions; this is a harness guard, never B.
const ACTION_BUDGET = FRAME_BUDGET * 32 + 256;
const fixture = JSON.parse(readFileSync(new URL("../../../../tests/fixtures/opencode-v2/background-2.0.29.json", import.meta.url), "utf8"));
const gate = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
};
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const wireValue = (value: unknown) => JSON.parse(JSON.stringify(value));
function readArtifact(path: string): any {
  const bytes = readFileSync(path);
  const value = JSON.parse((path.endsWith(".gz") ? gunzipSync(bytes) : bytes).toString("utf8"));
  return value.replayArtifact ? readArtifact(value.replayArtifact) : value;
}
function json(body: unknown): Response {
  const text = JSON.stringify(body), response = new Response(text, { headers: { "content-type": "application/json" } });
  // Fully mocked HTTP includes body availability. Bun's native Response.text
  // can finish on a later host task, outside the seeded release scheduler.
  // The client still performs its real content-type check and JSON parsing.
  response.text = async () => text;
  return response;
}
function bytePipe() {
  const chunks: Uint8Array[] = [];
  const pending: Array<(result: ReadableStreamReadResult<Uint8Array>) => void> = [];
  let closed = false;
  const close = () => { closed = true; for (const resolve of pending.splice(0)) resolve({ done: true, value: undefined }); };
  const reader = {
    read: () => chunks.length ? Promise.resolve({ done: false as const, value: chunks.shift()! })
      : closed ? Promise.resolve({ done: true as const, value: undefined })
        : new Promise<ReadableStreamReadResult<Uint8Array>>(resolve => pending.push(resolve)),
    cancel: async () => { close(); }, releaseLock() {},
  };
  return { body: { getReader: () => reader }, close, enqueue(value: Uint8Array) {
    if (closed) throw new Error("SSE enqueue after close");
    const resolve = pending.shift(); if (resolve) resolve({ done: false, value }); else chunks.push(value);
  } };
}
function random(seed: number) {
  let state = seed >>> 0;
  // Mulberry32 mixes adjacent seeds before their first choice; raw xorshift
  // first outputs cluster and would miss clear/restore for seeds 0..999.
  return () => {
    let value = state += 0x6d2b79f5;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}
function priority(seed: number, id: string): number {
  let key = seed >>> 0;
  for (const char of id) key = Math.imul(key ^ char.charCodeAt(0), 16777619);
  return random(key)();
}
type RecordValue = Record<string, any>;
type Native = { boundary?: string; parent: RecordValue[]; child: RecordValue[]; inbox: RecordValue[]; active: boolean; version: number };
type Action = { id: string; ownerJob?: string; enabled: () => boolean; run: () => void | Promise<void> };
type Publication = { at: number; order: number; source: string; admitted: boolean; row: BackgroundTaskItem };
// One fixed, known parent/child launch. These facts do not model provider caches.
// Raw consumed arrays remain in payloads by hash; HTTP bodies cannot set facts.
type NativeReadWitness = { kind: "parent-history"; launch: boolean; ended: boolean; consumer?: string;
  consumed: Array<{ sessionId: string; bodyHash: string }> };
type NativeEventWitness = { kind: "native-event"; frame: RecordValue; order: number; at: number };
type OracleWitness = NativeReadWitness | NativeEventWitness;
type PublicReadContext = { id: number; method: "listMessages" | "reconcileBackgroundTasks"; sessionId: string;
  consumer: string; job?: string; status: "pending" | "completed" | "failed"; error?: string;
  started: number; finished?: number; witness: NativeReadWitness;
  inputs: Array<{ order: number; at: number; path: string; bodyHash: string; kind: "consumed-history" | "native-response" }> };
const ORACLE_MODEL = "evidence-safety-v3";
const ORACLE_COVERAGE = "cold final native results/activity; completed per-consumer fixed-launch idle and observed native execution/revert facts";
function beginReadWitness(): NativeReadWitness {
  return { kind: "parent-history", launch: false, ended: false, consumed: [] };
}
function recordConsumedHistory(read: NativeReadWitness | undefined, sessionId: string, messages: readonly unknown[]) {
  if (read) {
    const body = { data: messages, cursor: {} };
    if (sessionId === PARENT) read.launch ||= (messages as RecordValue[]).some(message => message.id === "msg_launch"
      && message.content?.some((part: RecordValue) => part.id === "call_worker" && part.state?.metadata?.sessionID === CHILD));
    if (sessionId === CHILD && read.launch) read.ended ||= (messages as RecordValue[]).some(message => message.type === "idle" && message.time?.created >= 11);
    read.consumed.push({ sessionId, bodyHash: digest(body) });
  }
}
function witnessedExecutionEnd(witness: NativeReadWitness) {
  return witness.launch && witness.ended;
}
function recordPendingConsumption(read: Pick<PublicReadContext, "status" | "witness"> | undefined, sessionId: string, messages: readonly unknown[]) {
  if (read?.status === "pending") recordConsumedHistory(read.witness, sessionId, messages);
}
function admitCompletedRead(read: Pick<PublicReadContext, "method" | "sessionId" | "status" | "witness">) {
  return read.status === "completed" && read.sessionId === PARENT && witnessedExecutionEnd(read.witness);
}
function stopRevoked(reads: PublicReadContext[], events: OracleWitness[], at: number) {
  return reads.some(read => read.finished !== undefined && read.finished <= at && admitCompletedRead(read))
    || events.some(event => event.kind === "native-event" && event.order <= at && event.frame.data?.sessionID === CHILD
      && /^session\.execution\.(succeeded|failed|cancelled|stopped)$/.test(event.frame.type));
}
type Result = { seed: number; control: boolean; trace: string[]; schedule: string[]; physicalHistoryReads: number; logicalAttempts: number; frames: number; bReason?: string;
  metadataInterleavings?: Array<{ action: string; waiting: string[] }>; metadataHold?: string;
  a: boolean; b: boolean; harness?: string; replayDivergence?: string; requests: unknown[]; payloads: Record<string, unknown>; remainingJobs?: number;
  actual: Publication[]; fresh: BackgroundTaskItem[]; final?: Native; oracleModel?: string; oracleWitnesses?: OracleWitness[];
  publicReads?: PublicReadContext[];
  mismatches: Array<{ at: number; source: string; actual: unknown; fresh: unknown; dismissal: boolean }> };
const session = (id: string, boundary?: string) => ({ id, projectID: "global", title: id,
  location: { directory: DIRECTORY }, time: { created: 1, updated: 2 },
  ...(id === CHILD ? { parentID: PARENT, ...(boundary ? { revert: { messageID: boundary } } : {}) } : {}) });
function initial(seed: number): Native {
  const launch = structuredClone(fixture.launch);
  launch.time.created = 10; launch.content[0].time = { created: 10, ran: 11, completed: 12 };
  // The idle is a native typed outcome, not prose interpreted by the test.
  return { boundary: "far-suffix", parent: [{ id: "parent-prompt", type: "user", text: "Inspect", time: { created: 1 } }, launch,
    ...(seed % 3 === 1 ? [structuredClone(fixture.stored)] : [])],
    child: [{ id: "child-prompt", type: "user", text: "Inspect", time: { created: 15 } },
      { id: "idle", type: "idle", outcome: "succeeded", time: { created: 20 } },
      { id: "suffix", type: "user", text: "Continue", time: { created: 30 } },
      { id: "stream", type: "assistant", time: { created: 40 }, content: [{ type: "text", text: "" }] },
      { id: "far-suffix", type: "user", text: "Later boundary", time: { created: 50 } }],
    inbox: seed % 3 === 2 ? [structuredClone(fixture.pending)] : [], active: true, version: 0 };
}
function payload(state: Native, path: string): unknown {
  if (path === "/api/session") return { data: [], cursor: {} }; // No unsolicited inventory discovery.
  if (path === "/api/session/active") return { data: state.active ? { [CHILD]: { status: "running" } } : {} };
  if (path === "/api/permission/request" || path === "/api/form") return { location: { directory: DIRECTORY }, data: [] };
  if (path === `/api/session/${PARENT}/inbox`) return { data: state.inbox };
  if (path === `/api/session/${CHILD}/inbox`) return { data: [] };
  if (path === `/api/session/${PARENT}/message`) return { data: state.parent, cursor: {} };
  if (path === `/api/session/${CHILD}/message`) return { data: state.child, cursor: {} };
  if (path === `/api/session/${PARENT}`) return { data: session(PARENT) };
  if (path === `/api/session/${CHILD}`) return { data: session(CHILD, state.boundary) };
  throw new Error(`Unmodelled native route ${path}`);
}
// Explicitly normalize ONLY observation/provenance and presentation controls.
// Stop's conservative revocation is independent of outcome convergence: false
// need not become true merely because an independently fresh provider can stop.
function semantic(row: BackgroundTaskItem) {
  const value = structuredClone(row) as RecordValue;
  delete value.control;
  if (value.activity) { delete value.activity.observedAt; delete value.activity.generation; }
  return value;
}
function mismatch(row: BackgroundTaskItem, fresh: BackgroundTaskItem[], revoked = false) {
  const peer = fresh.find(candidate => candidate.id === row.id);
  const dismissal = workerDismissalEvidence(row)?.dismissible === true && (workerDismissalEvidence(peer)?.dismissible !== true
    || row.outcomeWithheld === true || row.activity?.kind === "working" || row.activity?.kind === "needs-answer");
  // A malformed/unknown status is not an abstention. A legitimate Unresolved
  // row withholds a result rather than publishing contradictory terminal data.
  const unresolved = row.status === "running" && row.resultId === undefined && row.terminalReportedAt === undefined
    && workerState(row.status, row.stateUncertain, row.activity) === "unknown";
  const unsafeStop = workerCanStop(row) && (revoked || !peer || !workerCanStop(peer));
  // Compare public wire values: an optional undefined property is absent, but
  // false remains present and distinct. No native value is otherwise erased.
  const actual = wireValue(semantic(row)), expected = peer && wireValue(semantic(peer));
  // Only these two warning flags have an approved one-way relaxation. False
  // versus absent remains distinct. Extra withheld is only a denial marker;
  // it is never native expected evidence and may not change result/activity.
  for (const field of ["stateUncertain", "outcomeWithheld"] as const)
    if (expected && actual[field] === true && expected[field] !== true) delete actual[field];
  for (const field of ["stateUncertain", "outcomeWithheld"] as const)
    if (expected && row[field] === true && expected[field] !== true) delete expected[field];
  if (unresolved && expected) {
    // Abstention may withhold terminal output, not replace it or change the
    // launch. All unlisted fields (including future fields) remain exact.
    delete actual.status; delete expected.status;
    for (const field of ["resultId", "summary", "terminalReportedAt"])
      if (actual[field] === undefined) { delete actual[field]; delete expected[field]; }
    if (actual.activity && expected.activity && ["checking", "session-active", "unavailable"].includes(actual.activity.kind)) {
      delete actual.activity.kind; delete expected.activity.kind;
      // Withdrawing current activity can clear an old end/request envelope.
      // Only absence on unavailable is allowed; supplied clocks/requests and
      // execution identities still have to match the independent cold row.
      if (row.activity?.kind === "unavailable") for (const field of ["endedAt", "request"])
        if (actual.activity[field] === undefined) { delete actual.activity[field]; delete expected.activity[field]; }
    }
  }
  return { bad: !peer || dismissal || unsafeStop || !isDeepStrictEqual(actual, expected), peer, dismissal };
}
async function oracle(state: Native): Promise<BackgroundTaskItem[]> {
  const snapshot = structuredClone(state);
  const provider = createOpenCodeV2Provider({ endpoint: "http://oracle.test", directory: DIRECTORY, password: "pw",
    fetch: (async (input: Request | string | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.method !== "GET") throw new Error("Oracle attempted a mutation");
      const path = new URL(request.url).pathname;
      return json(structuredClone(payload(snapshot, path)));
    }) as typeof globalThis.fetch });
  try {
    return await provider.reconcileBackgroundTasks!(PARENT, { fresh: true });
  }
  finally { await provider.dispose!(); }
}

function replaySnapshot(result: Result) {
  // Compare the persisted wire representation: JSON omits optional undefined
  // properties. Do not mistake that serialization difference for new facts.
  return JSON.parse(JSON.stringify({ requests: result.requests, final: result.final, physicalHistoryReads: result.physicalHistoryReads, logicalAttempts: result.logicalAttempts, bReason: result.bReason,
    actual: result.actual.map(value => ({ source: value.source, order: value.order, row: semantic(value.row), control: value.row.control })), fresh: result.fresh.map(semantic),
    oracleModel: result.oracleModel, oracleWitnesses: result.oracleWitnesses, publicReads: result.publicReads }));
}

type ReplayMode = "strict" | "causal-actions";
function replayBasis(result: Result, mode: ReplayMode) {
  if (mode === "strict") return replaySnapshot(result);
   // Keep every native observation, its order and final backend.
  // For the same model, run() additionally compares fresh oracle rows. Safety
  // still comes from mismatch(), never from accepting the old published rows.
  return JSON.parse(JSON.stringify({ requests: result.requests, final: result.final }));
}

async function run(seed: number, control = false, omitted: string[] = [], replay?: string[], exactTrace?: string[], expected?: Result, mode: ReplayMode = "strict"): Promise<Result> {
    const result = await runScoped(seed, control, omitted, replay, mode === "strict" ? exactTrace : undefined);
    const sameOracle = expected?.oracleModel === result.oracleModel;
    if (expected && !sameOracle) {
      result.replayDivergence = `Obsolete oracle contract: ${expected.oracleModel} -> ${result.oracleModel}; generate a new current representative`;
      result.harness = `Replay divergence: ${result.replayDivergence}`;
    }
    if (expected && !result.harness && (!isDeepStrictEqual(replayBasis(result, mode), replayBasis(expected, mode))
      || mode === "causal-actions" && sameOracle && !isDeepStrictEqual(wireValue(result.fresh.map(semantic)), wireValue(expected.fresh.map(semantic))))) {
      result.replayDivergence = mode === "strict" ? "Exact trace finished, but request snapshots/final native state/semantic publications differed"
        : "Causal actions finished, but native request snapshots/final native state/fresh oracle differed";
      result.harness = `Replay divergence: ${result.replayDivergence}`;
    }
    return result;
}

async function runScoped(seed: number, control = false, omitted: string[] = [], replay?: string[], exactTrace?: string[], metadataControl = false): Promise<Result> {
  const rng = random(seed), native = initial(seed), context = new AsyncLocalStorage<string>();
  const jobContext = new AsyncLocalStorage<string>(), activeEvents = new Set<string>();
  const result: Result = { seed, control, trace: [], schedule: [], physicalHistoryReads: 0, logicalAttempts: 0, frames: 0, a: false, b: false, requests: [], payloads: {}, actual: [], fresh: [], mismatches: [], oracleModel: ORACLE_MODEL, oracleWitnesses: [], metadataInterleavings: [] };
  const nativeFrames = new Map<string, RecordValue[]>();
  const publicRead = new AsyncLocalStorage<PublicReadContext>();
  let inputOrder = 0;
  result.publicReads = [];
  const recordInput = (kind: "consumed-history" | "native-response", path: string, body: unknown) => {
    const read = publicRead.getStore();
    if (!read || read.status !== "pending" || disposed) return;
    const bodyHash = digest(body); result.payloads[bodyHash] ??= structuredClone(body);
    read.inputs.push({ kind, path, bodyHash, at: result.trace.length, order: ++inputOrder });
  };
  // Only allMessages' post-await consumer notification can supply transcripts.
  // HTTP ownership is not consumption ownership: shared and cached consumers
  // need their own copies, even when another operation produced the response.
  const consumeHistory = (sessionId: string, messages: readonly unknown[]) => {
    recordPendingConsumption(publicRead.getStore(), sessionId, messages);
    recordInput("consumed-history", `/api/session/${sessionId}/message`, { data: structuredClone(messages), cursor: {} });
  };
  const observeBody = (path: string, body: unknown) => {
    if (!path.endsWith("/message")) recordInput("native-response", path, body);
  };
  const debug = (...values: unknown[]) => { if (process.env.UATU_ORDERING_DEBUG) console.log(seed, control, ...values); };
  const actions: Action[] = [], tasks: Promise<unknown>[] = [], barriers = new Map<string, () => void>();
  const skipped = new Set(omitted), owner = new AbortController();
  const requestCounts = new Map<string, number>();
  const waitingTransports = new Map<string, { caller: string; job?: string }>();
  const replayActions = replay?.filter(id => !skipped.has(id) && !omitted.some(name => id.startsWith(`release ${name}:`) || id.startsWith(`enter ${name}:`) || id === `complete ${name}`));
  let replayAt = 0;
  let wake = gate(), phase = 0, external = 0, started = false, frozen = false, admitted = false, done = false, disposed = false, ownedRequestEntered = false;
  let wire!: ReturnType<typeof bytePipe>, sequence = 0, steps = 0, mutationFrames = 0, streamId = "stream", normalizing = false;
  let independentReadCompleted = false;
  const beginMeasuredEvents = gate();
  const notify = () => { wake.resolve(); wake = gate(); };
  const note = (line: string) => {
    const expected = exactTrace?.[result.trace.length];
    if (exactTrace && line !== expected && !disposed) {
      result.replayDivergence ??= `trace[${result.trace.length}]: expected ${JSON.stringify(expected)}, observed ${JSON.stringify(line)}`;
      result.harness ??= `Replay divergence: ${result.replayDivergence}`;
    }
    result.trace.push(line); notify();
  };
  const add = (action: Action) => { actions.push({ ownerJob: jobContext.getStore(), ...action }); notify(); };
  // Time is an external boundary too: include the adapter's 100ms dirty-retry
  // timer, not just its zero-window coalescer. One selected semantic action is
  // one virtual millisecond. The independent watchdog uses the original clock.
  const nativeTimeout = globalThis.setTimeout, nativeClearTimeout = globalThis.clearTimeout;
  let virtualTime = 0;
  const clockHandles = new Set<object>(), clockNames = new WeakMap<object, string>();
  const timerCounts = new Map<string, number>();
  const scheduleTimer = (name: string, callback: (...args: any[]) => void, delay?: number, ...args: any[]) => {
    if (!started || disposed) return nativeTimeout(callback, delay, ...args);
    const handle = { cancelled: false, ref() { return this; }, unref() { return this; } };
    const caller = context.getStore(); clockHandles.add(handle);
    const due = virtualTime + Math.max(0, delay ?? 0);
    const count = (timerCounts.get(name) ?? 0) + 1; timerCounts.set(name, count);
    // Zero-delay means eligible immediately, not a deadline at a particular
    // CPU-continuation timestamp. Its stable identity is name + occurrence;
    // the exact replay still executes that same callback at the same position.
    const deadline = (delay ?? 0) === 0 ? "" : `@${due}`;
    const id = `clock:${name}:${delay ?? 0}#${count}${deadline}`;
    clockNames.set(handle, id);
    add({ id, enabled: () => virtualTime >= due, run: () => {
      clockHandles.delete(handle);
      if (!handle.cancelled) context.run(caller ?? "pump", () => callback(...args));
    } });
    return handle;
  };
  const cancelTimer = (handle: any) => {
    if (clockHandles.has(handle)) {
      if (!disposed) note(`cancel ${clockNames.get(handle)}`);
      handle.cancelled = true; clockHandles.delete(handle);
    }
    else nativeClearTimeout(handle);
  };
  const jobCounts = new Map<string, number>(), startupJobs = new Set<Promise<unknown>>(), pendingJobs = new Set<string>();
  const taskScheduler: ChatTaskScheduler = {
    now: () => 1_700_000_000_000 + virtualTime,
    run<T>(name: string, work: () => T | Promise<T>): Promise<T> {
      if (!started || disposed) {
        const result = Promise.resolve().then(work);
        startupJobs.add(result);
        void result.finally(() => startupJobs.delete(result)).catch(() => undefined);
        return result;
      }
      const count = (jobCounts.get(name) ?? 0) + 1; jobCounts.set(name, count);
      const id = `${name}#${count}`, caller = context.getStore();
      pendingJobs.add(id);
      return new Promise<T>((resolve, reject) => {
        add({ id: `job.start ${id}`, enabled: () => true, run: () => {
          if (name === `history.attempt:${PARENT}` && caller === "owned" && ++result.logicalAttempts > ATTEMPTS) {
            result.b = true; result.bReason = "logical-attempt-budget"; note("B:logical-attempt-budget"); owner.abort();
          }
          if (name.startsWith("stream.event:")) activeEvents.add(id);
          let workResult: T | Promise<T>;
          try { workResult = jobContext.run(id, () => context.run(caller ?? "pump", work)); }
          catch (error) { add({ id: `job.reject ${id}`, enabled: () => true, run: () => { activeEvents.delete(id); pendingJobs.delete(id); reject(error); } }); return; }
          const settle = (ok: boolean, value: T, error?: unknown) => {
            const finish = () => { activeEvents.delete(id); pendingJobs.delete(id); if (!ok) reject(error); else resolve(value); };
            if (disposed) { finish(); return; }
            add({ id: `job.${ok ? "settle" : "reject"} ${id}`, enabled: () => true, run: finish });
          };
          const pending = Promise.resolve(workResult).then(value => settle(true, value), error => settle(false, undefined as T, error));
          tasks.push(pending);
        } });
      });
    },
    setTimeout: (name, work, delay) => scheduleTimer(name, work, delay) as ReturnType<typeof setTimeout>,
    clearTimeout: timer => cancelTimer(timer),
  };
  const track = (name: string, operation: () => Promise<unknown>, outside = false) => {
    if (outside) external++;
    const promise = context.run(name, operation).then(() => {
      if (disposed) return;
      add({ id: `complete ${name}`, enabled: () => true, run: () => {
        if (outside) external--;
        if (name === "observe:child-record") independentReadCompleted = true;
        if (name === "owned") done = true;
      } });
      notify();
    }, error => {
      if (outside) external--;
      if (!disposed && !result.b) result.harness ??= `${name}: ${String(error)}`;
      notify();
    });
    tasks.push(promise);
  };
  const fetch = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), path = new URL(request.url).pathname;
    debug("fetch", path);
    if (request.method !== "GET") throw new Error(`Unexpected native mutation ${request.method} ${path}`);
    if (path === "/api/event") {
      // A promise-backed byte pipe mocks network availability; the pinned
      // client's actual SSE decoder/parser and subscription broker still run.
      wire = bytePipe(); wire.enqueue(new TextEncoder().encode('data: {"type":"server.connected","data":{}}\n\n'));
      request.signal.addEventListener("abort", wire.close, { once: true });
      const response = new Response(null, { headers: { "content-type": "text/event-stream" } });
      Object.defineProperty(response, "body", { value: wire.body });
      return response;
    }
    if (!started || disposed) {
      const body = structuredClone(payload(native, path));
      if (!disposed) observeBody(path, body);
      return json(body);
    }
    const caller = context.getStore() ?? "pump", job = jobContext.getStore(), key = `${caller}${job ? `[${job}]` : ""}:GET ${path}`;
    const count = (requestCounts.get(key) ?? 0) + 1; requestCounts.set(key, count);
    const id = `${key}#${count}`;
    waitingTransports.set(id, { caller, job });
    if (metadataControl && !result.metadataHold && (caller === "sse.normalize" || caller === "pump" && !job && activeEvents.size > 0)
      && path === `/api/session/${CHILD}`) result.metadataHold = id;
    const entered = gate(), held = gate();
    let body: unknown;
    const interaction = path === "/api/permission/request" || path === "/api/form";
    // Fetch invocation is network send, not backend arrival. Gate arrival as
    // an explicit action so callback readiness cannot reorder native snapshots.
    add({ id: `enter ${id}`, enabled: () => true, run: () => {
      body = structuredClone(payload(native, path));
      // Disposal settles abandoned transports; it is outside the sampled
      // ordering and must not append native observations or spend its budget.
      if (disposed) { entered.resolve(); held.resolve(); return; }
      const bodyHash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
      result.payloads[bodyHash] ??= body;
      result.requests.push({ id, path, caller, job, backendVersion: native.version, bodyHash });
      if (caller === "owned") ownedRequestEntered = true;
      if (caller === "owned" && path === `/api/session/${PARENT}/message`) result.physicalHistoryReads++;
      add({ id: `release ${id}`, enabled: () => (!interaction || frozen)
        && (id !== result.metadataHold || phase >= 3 && independentReadCompleted), run: () => {
        // Frames and acknowledgements are separate actors: an SSE consumer
        // may need an HTTP answer before it can acknowledge the frame.
        if (!control && caller === "owned" && !done && !result.b) {
          const frame = stream().catch(error => { result.harness ??= String(error); }); tasks.push(frame);
        }
        if (interaction) admitted = true;
        waitingTransports.delete(id);
        held.resolve();
      } });
      entered.resolve();
    } });
    const abort = () => { waitingTransports.delete(id); entered.resolve(); held.resolve(); };
    request.signal.addEventListener("abort", abort, { once: true });
    try { await entered.promise; await held.promise; request.signal.throwIfAborted(); observeBody(path, body); return json(body); }
    finally { request.signal.removeEventListener("abort", abort); }
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: "http://ordering.test", directory: DIRECTORY, password: "pw", fetch,
    observeHistoryConsumption: consumeHistory });
  const listMessages = provider.listMessages.bind(provider);
  const observePublicRead = <T>(method: PublicReadContext["method"], id: string, operation: () => Promise<T>): Promise<T> => {
    if (disposed) return operation();
    const witness = beginReadWitness();
    witness.consumer = context.getStore() ?? "pump";
    const read: PublicReadContext = { id: result.publicReads!.length + 1, method, sessionId: id, consumer: witness.consumer,
      job: jobContext.getStore(), status: "pending", started: ++inputOrder, witness, inputs: [] };
    result.publicReads!.push(read);
    return publicRead.run(read, async () => {
      try {
      const page = await operation();
      read.status = "completed"; read.finished = ++inputOrder;
      // Only a completed public parent-history read consuming a scoped child
      // execution end can revoke Stop. Bare child reads/active inventory,
      // unseen backend idle, actual row flags and future final state cannot.
      if (admitCompletedRead(read)) {
        result.oracleWitnesses!.push(witness);
      }
      return page;
      } catch (error) { read.status = "failed"; read.error = String(error); read.finished = ++inputOrder; throw error; }
    });
  };
  provider.listMessages = (id, options) => observePublicRead("listMessages", id, () => listMessages(id, options));
  const reconcileBackgroundTasks = provider.reconcileBackgroundTasks!.bind(provider);
  provider.reconcileBackgroundTasks = (id, options) => observePublicRead("reconcileBackgroundTasks", id, () => reconcileBackgroundTasks(id, options));
  const events = provider.events.bind(provider);
  // Observe the public normalized-event iterator only to acknowledge a frame;
  // no event or guard is forged after the native SSE transport boundary.
  provider.events = async function* (signal) {
    const iterator = events(signal)[Symbol.asyncIterator]();
    let receive = 0;
    try { while (!signal.aborted) {
      if (started && !disposed) {
        const entered = gate();
        add({ id: `sse.receive#${++receive}`, enabled: () => barriers.size > 0, run: () => { normalizing = true; entered.resolve(); } });
        await entered.promise;
      }
      const next = await context.run("sse.normalize", () => iterator.next());
      if (next.done || signal.aborted) break;
      const event = next.value;
      if (started && !disposed) {
        const observed = gate();
        add({ id: `sse.observed:${event.eventType}#${receive}`, enabled: () => true, run: () => {
          const frame = nativeFrames.get(event.eventType)?.shift();
          if (frame && /^session\.(revert|execution)\./.test(event.eventType)) {
            result.oracleWitnesses!.push({ kind: "native-event", frame: structuredClone(frame), order: ++inputOrder, at: result.trace.length });
          }
          normalizing = false; observed.resolve();
        } });
        await observed.promise;
      }
      debug("event", event.eventType);
      yield event;
      if (!started || disposed) barriers.get(event.eventType)?.();
      else {
        const handled = gate();
        add({ id: `handled ${event.eventType}`, enabled: () => true, run: () => { barriers.get(event.eventType)?.(); handled.resolve(); } });
        await handled.promise;
      }
      // Do not prefetch the first measured native frame during async setup.
      if (event.eventType === "diagnostic.ordering.1") await beginMeasuredEvents.promise;
    } } finally { normalizing = false; await iterator.return?.(); }
  };
  const adapter = new ChatAdapter({ provider, workspacePath: DIRECTORY, coalesceWindowMs: 0, taskScheduler, now: taskScheduler.now });
  async function emit(type: string, data: unknown) {
    const mutation = type.startsWith("session.revert.") || type.startsWith("session.inbox.");
    if (mutation) mutationFrames++;
    const marker = `diagnostic.ordering.${++sequence}`, acknowledged = gate();
    barriers.set(marker, acknowledged.resolve);
    for (const frame of [{ type, data }, { type: marker, data: {} }]) {
      const native = { ...frame, created: 60 + result.frames, location: { directory: DIRECTORY } };
      const pending = nativeFrames.get(frame.type) ?? [];
      pending.push(native); nativeFrames.set(frame.type, pending);
      wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(native)}\n\n`));
    }
    await acknowledged.promise; barriers.delete(marker); if (mutation) mutationFrames--; notify();
  }
  async function stream() {
    if (++result.frames > FRAME_BUDGET) throw new Error("Harness child-frame budget exceeded (not B)");
    const message = native.child.find(item => item.id === streamId);
    // After a commit, append a genuinely new current assistant record rather
    // than resurrecting a removed suffix. It carries no terminal authority.
    if (!message) { streamId = "stream-after-commit"; native.child.push({ id: streamId, type: "assistant", time: { created: 60 }, content: [] }); }
    native.child.find(item => item.id === streamId)!.content = [{ type: "text", text: `Streaming ${result.frames}` }];
    native.version++;
    note(`sse:text:${result.frames}`);
    await emit("session.message.content.updated", { sessionID: CHILD, messageID: streamId, content: [{ type: "text", text: `Streaming ${result.frames}` }] });
  }
  let subscriptionPump: Promise<void> | undefined;
  const watchdog = gate(), timer = nativeTimeout(watchdog.resolve, 5_000);
  try {
    tasks.push(adapter.startEventPump().catch(error => {
      if (!disposed && !result.b) result.harness ??= `Event pump: ${String(error)}`;
      notify();
    }));
    debug("started pump");
    await provider.waitForEventStream!(owner.signal);
    debug("stream ready");
    // A marker acknowledges adapter processing of the connected generation.
    await emit("diagnostic.ordering.ready", {});
    const subscription = await adapter.subscribe(PARENT, { signal: owner.signal });
    if (subscription.snapshot.items.some(item => item.type === "background_task")) throw new Error("Admission harness expected a worker-empty initial subscription");
    debug("subscribed");
    while (startupJobs.size) await Promise.all([...startupJobs]);
    subscriptionPump = (async () => {
      for await (const event of subscription.events) if (event.type === "item.upsert" && event.item.type === "background_task") {
        note(`publish:${event.item.status}:${event.item.activity?.kind}`);
        result.actual.push({ at: result.trace.length, order: ++inputOrder, source: "subscription", admitted, row: structuredClone(event.item) });
      }
    })();
    started = true;
    beginMeasuredEvents.resolve();
    // Subscribe's reversible-history read legitimately warms native history.
    // A native exact content replay invalidates that cache through the public
    // SSE path, so the measured history must actually cross native HTTP.
    let parentInvalidated = false;
    track("initial-replay", async () => {
      await emit("session.message.content.updated", { sessionID: PARENT, messageID: "parent-prompt", content: [{ type: "text", text: "Inspect" }] });
      parentInvalidated = true; notify();
    });
    const tick = () => add({ id: `sse:tick:${result.frames + 1}`, enabled: () => !done && !result.b,
      run: async () => { await stream(); if (!done && !result.b && !disposed) tick(); } });
    if (!control) tick();
    add({ id: "read.start:parent", enabled: () => parentInvalidated, run: () => {
      track("owned", async () => {
        try {
          const page = await adapter.history(PARENT, { limit: 100 });
          for (const item of page.items) if (item.type === "background_task") result.actual.push({ at: result.trace.length, order: ++inputOrder, source: "history", admitted, row: structuredClone(item) });
        } finally { notify(); }
      });
    } });
    const observe = (id: string, operation: () => Promise<unknown>) => {
      if (!skipped.has(id)) add({ id, enabled: () => phase >= 1, run: () => { track(id, operation, true); } });
    };
    observe("observe:child-record", () => provider.getSession(CHILD));
    observe("observe:parent-record", () => provider.getSession(PARENT));
    observe("observe:child-history", () => provider.listMessages(CHILD, { limit: 100, signal: owner.signal }));
    observe("observe:parent-history", () => provider.listMessages(PARENT, { limit: 100, signal: owner.signal }));
    observe("observe:pending", () => provider.listPendingInbox!(PARENT, { signal: owner.signal }));
    observe("observe:inventory-recovery", () => provider.reconcileBackgroundTasks!(PARENT, { fresh: true, signal: owner.signal }).catch(() => undefined));
    // Keep the owned public history genuinely in flight when the native
    // mutations begin, rather than accidentally testing only cold final-state
    // reads after all backend changes have already happened.
    add({ id: "native:stage", enabled: () => phase === 0 && ownedRequestEntered, run: async () => {
      phase = 1;
      if (!control) { native.version++; native.boundary = "suffix"; await emit("session.revert.staged", { sessionID: CHILD, revert: { messageID: "suffix" } }); }
    } });
    add({ id: "native:switch-stage", enabled: () => phase === 1, run: async () => {
      phase = 2;
      if (!control) { native.version++; native.boundary = "idle"; await emit("session.revert.staged", { sessionID: CHILD, revert: { messageID: "idle" } }); }
    } });
    const commit = rng() < 0.5;
    add({ id: `native:${commit ? "commit" : "clear"}`, enabled: () => phase === 2, run: async () => {
      phase = 3;
      if (!control) {
        native.version++;
        if (commit) native.child = native.child.slice(0, native.child.findIndex(item => item.id === native.boundary));
        delete native.boundary;
        await emit(`session.revert.${commit ? "committed" : "cleared"}`, { sessionID: CHILD, ...(commit ? { to: "idle" } : {}) });
      }
    } });
    add({ id: "native:deliver-pending", enabled: () => phase === 3, run: async () => {
      phase = 4;
      if (!control && native.inbox.length) {
        native.version++;
        const delivered = structuredClone(fixture.stored);
        delivered.time.created = 60 + result.frames;
        native.inbox = []; native.parent.push(delivered);
        await emit("session.inbox.delivered", { sessionID: PARENT, inboxID: fixture.stored.id });
      }
    } });
    add({ id: "admission:freeze", enabled: () => phase === 4 && external === 0 && mutationFrames === 0 && !actions.some(action => action.id.startsWith("observe:")), run: () => {
      frozen = true; result.final = structuredClone(native);
    } });
    // Scheduler chooses from enabled actions, never from a handwritten matrix.
    // Request starts are causally produced by the real SDK/provider/adapter;
    // only response releases and independent public operations are scheduled.
    while (!done && !result.b && !result.harness) {
      if (done || result.b || result.harness) break;
      if (++steps > ACTION_BUDGET) throw new Error("Harness enabled-action budget exceeded (not B)");
      // Preserve the synchronous prefix/continuations until a real transport
      // await. During metadata I/O native mutations, external observations and
      // unrelated jobs remain independent actors; SSE iterator delivery alone
      // stays serialized by receive/observed/handled acknowledgements.
      const normalizeWaiting = [...waitingTransports.values()].some(read => read.caller === "sse.normalize");
      // The adapter's iterator consumer resumes in pump context; the scheduler
      // owns its start/finish acknowledgement, not that consumer's ALS context.
      const eventWaiting = [...waitingTransports.values()].some(read => activeEvents.has(read.job ?? "")
        || read.caller === "pump" && !read.job);
      const enabled = actions.filter(action => action.enabled() && (!normalizing || normalizeWaiting
         || action.id.startsWith("enter sse.normalize") || action.id.startsWith("release sse.normalize") || action.id.startsWith("sse.observed:")) && (!activeEvents.size
        || eventWaiting
        || action.id.startsWith("enter ") || action.id.startsWith("release ")
        || activeEvents.has(action.ownerJob ?? "")
        || [...activeEvents].some(id => action.id === `job.settle ${id}` || action.id === `job.reject ${id}`)));
      const expected = exactTrace ? exactTrace[result.trace.length] : replayActions?.[replayAt];
      // Each causal node has a seed-derived priority fixed before it is ready.
      // Host callback arrival never consumes another PRNG decision.
      const selected = replayActions ? enabled.find(action => action.id === expected)
        : [...enabled].sort((a, b) => priority(seed, a.id) - priority(seed, b.id) || a.id.localeCompare(b.id))[0];
      if (selected) {
        const action = selected;
        if (normalizeWaiting || activeEvents.size && eventWaiting) result.metadataInterleavings!.push({ action: action.id,
          waiting: [...waitingTransports].filter(([, read]) => read.caller === "sse.normalize" || activeEvents.has(read.job ?? "") || read.caller === "pump" && !read.job).map(([id]) => id) });
        actions.splice(actions.indexOf(action), 1);
        note(action.id);
        result.schedule.push(action.id);
        virtualTime++;
        replayAt++;
        debug("action", action.id);
        // The selected node's synchronous prefix is atomic. Run enabled nodes
        // until a real actor/transport/ack dependency blocks the frontier; only
        // then await its notification below. There is no host-turn or guessed
        // promise-flush barrier choosing which continuation becomes ready.
        try {
          const work = action.run();
          if (work) tasks.push(work.catch(error => { result.harness ??= `${action.id}: ${String(error)}`; }).finally(notify));
        } catch (error) { result.harness ??= `${action.id}: ${String(error)}`; }
      } else {
        const changed = wake.promise;
        const outcome = await Promise.race([changed.then(() => "change"), watchdog.promise.then(() => "watchdog")]);
        if (outcome === "watchdog") {
          if (replayActions) result.replayDivergence = `Next recorded action/observation never enabled: ${expected}; enabled: ${enabled.map(action => action.id).join(", ")}`;
          throw new Error(result.replayDivergence ? `Replay divergence: ${result.replayDivergence}` : "Harness deadlock/watchdog (not B)");
        }
      }
    }
    if (exactTrace && result.trace.length !== exactTrace.length && !result.harness) {
      result.replayDivergence = `Read finished at trace ${result.trace.length}, expected ${exactTrace.length} entries`;
      result.harness = `Replay divergence: ${result.replayDivergence}`;
    }
    if (replayActions && replayAt !== replayActions.length && !result.harness) {
      result.replayDivergence = `Read finished after ${replayAt} actions, expected ${replayActions.length}; next: ${replayActions[replayAt]}`;
      result.harness = `Replay divergence: ${result.replayDivergence}`;
    }
    if (!result.harness) {
      if (!result.b && (!frozen || !admitted)) throw new Error("History escaped the final-state admission barrier");
      // Before admission, B can terminate with no publications. This is the
      // actual final native state at that abort, not an imagined later state.
      result.final ??= structuredClone(native);
      result.fresh = await oracle(result.final!);
      for (const publication of result.actual) {
        if (!publication.admitted) throw new Error("Worker publication preceded final-state admission; future oracle comparison invalid");
        const check = mismatch(publication.row, result.fresh, stopRevoked(result.publicReads!, result.oracleWitnesses!, publication.order));
        if (check.bad) result.mismatches.push({ at: publication.at, source: publication.source,
          actual: semantic(publication.row), fresh: check.peer && semantic(check.peer), dismissal: check.dismissal });
      }
      result.a = result.mismatches.length > 0;
    }
  } catch (error) { result.harness ??= String(error); }
  finally {
    try {
      debug("cleanup", result.harness, result.b);
      clearTimeout(timer); disposed = true; owner.abort();
      beginMeasuredEvents.resolve();
      for (const resolve of barriers.values()) resolve();
      for (const action of actions) if (action.id.startsWith("release ") || action.id.startsWith("enter ") || action.id.startsWith("handled ") || action.id.startsWith("clock:") || action.id.startsWith("job.") || action.id.startsWith("sse.")) {
        // Disposal must settle transports without generating more child frames.
        done = true; await Promise.resolve().then(action.run).catch(() => undefined);
      }
      await adapter.dispose();
      await Promise.allSettled(tasks); await subscriptionPump;
      await Promise.allSettled([...startupJobs]);
      result.remainingJobs = pendingJobs.size;
      if (pendingJobs.size) result.harness ??= `Scheduler leaked ${pendingJobs.size} jobs`;
    } catch (error) {
      result.harness ??= `Cleanup failed: ${String(error)}`;
    } finally { for (const timer of clockHandles) cancelTimer(timer); }
  }
  return result;
}

function brief(result: Result) {
  const waitingActions = result.metadataInterleavings ?? [];
  return { seed: result.seed, control: result.control, a: result.a, b: result.b, harness: result.harness,
    metadataAwaitChannels: {
      native: waitingActions.filter(entry => entry.action.startsWith("native:")).length,
      observations: waitingActions.filter(entry => entry.action.startsWith("observe:")).length,
      jobs: waitingActions.filter(entry => entry.action.startsWith("job.start ") && !entry.action.startsWith("job.start stream.event:")).length,
    },
    consumedWithoutConsumerHttp: result.oracleWitnesses?.filter((witness): witness is NativeReadWitness => witness.kind === "parent-history")
      .flatMap(witness => witness.consumed?.filter(consumption => !result.requests.some((request: any) => request.caller === witness.consumer
        && request.path === `/api/session/${consumption.sessionId}/message` && request.bodyHash === consumption.bodyHash)) ?? []).length ?? 0,
    replayDivergence: result.replayDivergence, physicalHistoryReads: result.physicalHistoryReads, logicalAttempts: result.logicalAttempts, bReason: result.bReason, frames: result.frames, remainingJobs: result.remainingJobs,
    traceLength: result.trace.length, traceDigest: digest(result.trace), semanticDigest: digest(replaySnapshot(result)),
    rows: result.actual.map(value => ({ status: value.row.status, kind: value.row.activity?.kind, uncertain: value.row.stateUncertain,
      resultId: value.row.resultId, semanticDigest: digest(semantic(value.row)) })) };
}

test("evidence-safety-v3 accepts extra uncertainty without changing native result or activity", async () => {
  const state = initial(0); delete state.boundary; state.child = state.child.slice(0, 1);
  const cold = await oracle(state), cautious = structuredClone(cold[0]!);
  cautious.stateUncertain = true;
  expect(mismatch(cautious, cold).bad).toBe(false);
});

test("evidence-safety-v3 preserves every native result/activity field and false marker shape", async () => {
  const state = initial(1); delete state.boundary;
  const completed = await oracle(state), row = completed[0]!;
  expect(row.status).toBe("completed");
  // Enumerating the real public row also protects future semantic fields; only
  // the two approved warnings, control and observation provenance are excluded.
  const core = semantic(row);
  for (const field of Object.keys(core).filter(field => !["activity", "stateUncertain", "outcomeWithheld"].includes(field))) {
    const changed = structuredClone(row) as RecordValue;
    changed[field] = typeof changed[field] === "string" ? `${changed[field]}:wrong` : null;
    expect(mismatch(changed as BackgroundTaskItem, completed).bad).toBe(true);
  }
  for (const field of Object.keys(core.activity)) {
    const changed = structuredClone(row) as RecordValue;
    changed.activity[field] = typeof changed.activity[field] === "string" ? `${changed.activity[field]}:wrong` : -1;
    expect(mismatch(changed as BackgroundTaskItem, completed).bad).toBe(true);
  }
  const workingState = initial(0); delete workingState.boundary; workingState.child = workingState.child.slice(0, 1);
  const working = await oracle(workingState), markerFalse = { ...working[0]!, outcomeWithheld: false };
  expect(working[0]!.outcomeWithheld).toBeUndefined();
  expect(mismatch(markerFalse, working).bad).toBe(true);
  const absent = structuredClone(working[0]!); delete absent.stateUncertain;
  expect(working[0]!.stateUncertain).toBe(false);
  expect(mismatch(absent, working).bad).toBe(true);
});

test("evidence-safety-v3 never loses a required warning or grants unsupported dismissal", async () => {
  const visible = initial(0); delete visible.boundary;
  const completed = await oracle(visible);
  const workingState = structuredClone(visible); workingState.child = workingState.child.slice(0, 1);
  const working = await oracle(workingState);
  expect(mismatch(completed[0]!, working).dismissal).toBe(true);
  const required = { ...working[0]!, stateUncertain: true };
  const suppressed = { ...working[0]!, control: { available: false } };
  expect(mismatch(suppressed, [required]).bad).toBe(true);
  const retainedMarker = { ...completed[0]!, outcomeWithheld: true };
  expect(workerDismissalEvidence(retainedMarker)?.dismissible).toBe(false);
  expect(mismatch(retainedMarker, completed).bad).toBe(false);
  const incorrect = { ...working[0]!, outcomeWithheld: true, summary: "fabricated result" };
  expect(mismatch(incorrect, working).bad).toBe(true);
});

function abstain(row: BackgroundTaskItem): BackgroundTaskItem {
  const value = structuredClone(row);
  value.status = "running"; value.stateUncertain = true; value.outcomeWithheld = true;
  delete value.resultId; delete value.summary; delete value.terminalReportedAt;
  value.activity!.kind = "unavailable";
  return value;
}

for (const field of ["summary", "description", "toolUseId", "taskId", "childConversationId", "createdAt",
  "activity.executionId", "activity.launchRef", "activity.endedAt"])
  test(`Unresolved cannot fabricate ${field} even with a withheld marker`, async () => {
    const state = initial(1); delete state.boundary;
    const cold = await oracle(state), row = abstain(cold[0]!);
    const target = field.startsWith("activity.") ? row.activity! as RecordValue : row as RecordValue;
    const key = field.replace("activity.", "");
    target[key] = typeof target[key] === "number" ? target[key] + 1 : "fabricated";
    expect(mismatch(row, cold).bad).toBe(true);
  });

for (const kind of ["checking", "session-active", "unavailable"] as const) {
  test(`Unresolved ${kind} preserves false-versus-absent marker shape`, async () => {
    const state = initial(0); delete state.boundary; state.child = state.child.slice(0, 1);
    const cold = await oracle(state), row = abstain(cold[0]!);
    expect(cold[0]!.outcomeWithheld).toBeUndefined();
    row.activity!.kind = kind; row.outcomeWithheld = false;
    expect(mismatch(row, cold).bad).toBe(true);
    row.outcomeWithheld = true; delete row.stateUncertain;
    expect(cold[0]!.stateUncertain).toBe(false);
    expect(mismatch(row, cold).bad).toBe(true);
  });
  test(`Unresolved ${kind} cannot drop a cold required warning`, async () => {
    const state = initial(0); delete state.boundary; state.child = []; state.active = false;
    const cold = await oracle(state), row = abstain(cold[0]!);
    expect(cold[0]!.stateUncertain).toBe(true);
    row.activity!.kind = kind; delete row.stateUncertain;
    expect(mismatch(row, cold).bad).toBe(true);
    row.stateUncertain = false;
    expect(mismatch(row, cold).bad).toBe(true);
  });
}

test("legitimate Unresolved omits terminal output without changing the occurrence or granting authority", async () => {
  const state = initial(1); delete state.boundary;
  const cold = await oracle(state), row = abstain(cold[0]!);
  expect(cold[0]!.status).toBe("completed");
  expect(workerCanStop(row)).toBe(false);
  expect(workerDismissalEvidence(row)?.dismissible).not.toBe(true);
  expect(mismatch(row, cold).bad).toBe(false);
  expect(mismatch(wireValue(row), cold).bad).toBe(false); // Optional undefined fields are absent on the wire.
  for (const kind of ["checking", "session-active", "unavailable"] as const) {
    row.activity!.kind = kind;
    expect(mismatch(row, cold).bad).toBe(false);
  }
  delete row.activity!.endedAt; delete row.activity!.request;
  expect(mismatch(row, cold).bad).toBe(false);
  (row as RecordValue).futureNativeField = "not exempt";
  expect(mismatch(row, cold).bad).toBe(true);
});

test("Unresolved session-active compares optional native fields by their wire shape, not undefined property ownership", async () => {
  const state = initial(0); delete state.boundary;
  const cold = await oracle(state), row = wireValue(abstain(cold[0]!));
  row.activity.kind = "session-active";
  expect(mismatch(row, cold).bad).toBe(false);
});

test("native execution-end observations revoke only the scoped execution, including overlapping reads", () => {
  const frame = { type: "session.execution.succeeded", data: { sessionID: CHILD } };
  const event: NativeEventWitness = { kind: "native-event", frame, order: 5, at: 5 };
  expect(stopRevoked([], [event], 4)).toBe(false);
  expect(stopRevoked([], [event], 5)).toBe(true);
  expect(stopRevoked([], [{ ...event, frame: { ...frame, data: { sessionID: "unrelated" } } }], 6)).toBe(false);
  expect(stopRevoked([], [{ ...event, frame: { ...frame, type: "session.message.content.updated" } }], 6)).toBe(false);
  const read: PublicReadContext = { id: 1, consumer: "owned", method: "listMessages", sessionId: PARENT,
    status: "pending", started: 1, witness: beginReadWitness(), inputs: [] };
  expect(stopRevoked([read], [event], 6)).toBe(true);
  read.status = "failed"; read.finished = 7;
  expect(stopRevoked([read], [event], 8)).toBe(true);
});

test("evidence-safety-v3 rejects resurrected Stop after consumed idle but permits no-witness Working", async () => {
  const before = initial(0); delete before.boundary;
  const final = structuredClone(before); final.child = final.child.slice(0, 1);
  const witness = beginReadWitness();
  recordConsumedHistory(witness, PARENT, before.parent); recordConsumedHistory(witness, CHILD, before.child);
  const read: PublicReadContext = { id: 1, method: "listMessages", sessionId: PARENT, consumer: "owned", status: "completed",
    started: 1, finished: 10, witness, inputs: [] };
  const commit: NativeEventWitness = { kind: "native-event", order: 3, at: 11, frame: { type: "session.revert.committed", created: 60,
    location: { directory: DIRECTORY }, data: { sessionID: CHILD, to: "idle" } } };
  const cold = await oracle(final);
  expect(workerCanStop(cold[0]!)).toBe(true);
  expect(mismatch(cold[0]!, cold, stopRevoked([], [commit], 12)).bad).toBe(false);
  expect(mismatch(cold[0]!, cold, stopRevoked([read], [commit], 12)).bad).toBe(true);
  expect(stopRevoked([read], [commit], 9)).toBe(false); // No future-read authority.
  expect(stopRevoked([{ ...read, status: "failed" }], [commit], 12)).toBe(false);
  expect(stopRevoked([{ ...read, status: "pending", finished: undefined }], [commit], 12)).toBe(false);
  const cautious = { ...cold[0]!, stateUncertain: true };
  expect(mismatch(cautious, cold, true).bad).toBe(false);
  const ended = await oracle(before);
  expect(ended[0]!.status).toBe("completed");
  expect(workerDismissalEvidence(ended[0])?.dismissible).toBe(true);
  expect(mismatch(ended[0]!, ended, true).bad).toBe(false); // End revokes Stop, not terminal dismissal.
});

test("metadata-await control permits a native commit and completed independent read before the event consumer resumes", async () => {
  const result = await runScoped(0, false, [], undefined, undefined, true);
  expect(result.harness).toBeUndefined();
  expect(result.metadataHold).toBeDefined();
  const release = result.schedule.indexOf(`release ${result.metadataHold}`);
  const commit = result.schedule.indexOf("native:commit");
  const independent = result.schedule.indexOf("complete observe:child-record");
  expect(commit).toBeGreaterThanOrEqual(0);
  expect(independent).toBeGreaterThanOrEqual(0);
  expect(release).toBeGreaterThan(commit);
  expect(release).toBeGreaterThan(independent);
  for (const action of ["native:commit", "observe:child-record", "complete observe:child-record"])
    expect(result.metadataInterleavings?.some(entry => entry.action === action && entry.waiting.includes(result.metadataHold!))).toBe(true);
});

test("completed recovery-only consumption supplies native facts; failed reads and no-idle contexts do not", async () => {
  const before = initial(0); before.boundary = "idle";
  const witness = beginReadWitness();
  const provider = createOpenCodeV2Provider({ endpoint: "http://recovery-consumer.test", directory: DIRECTORY, password: "pw",
    observeHistoryConsumption: (id, messages) => recordConsumedHistory(witness, id, messages),
    fetch: (async (input: Request | string | URL, init?: RequestInit) => {
      const path = new URL(new Request(input, init).url).pathname, body = structuredClone(payload(before, path));
      return json(body);
    }) as typeof globalThis.fetch });
  try { await provider.reconcileBackgroundTasks!(PARENT, { fresh: true }); }
  finally { await provider.dispose!(); }
  const completed = { method: "reconcileBackgroundTasks" as const, sessionId: PARENT, status: "completed" as const, witness };
  expect(witness.consumed?.map(input => input.sessionId)).toEqual([PARENT, CHILD]);
  expect(admitCompletedRead(completed)).toBe(true);
  expect(admitCompletedRead({ ...completed, status: "failed" })).toBe(false);
  const noIdle = beginReadWitness();
  recordConsumedHistory(noIdle, PARENT, before.parent);
  recordConsumedHistory(noIdle, CHILD, before.child.filter(message => message.type !== "idle"));
  expect(admitCompletedRead({ ...completed, witness: noIdle })).toBe(false);
});

test("native facts require ordered fixed-launch consumption, not a bare child or unrelated parent", () => {
  for (const parent of [[], [{ id: "unrelated" }]]) {
    const witness = beginReadWitness();
    recordConsumedHistory(witness, PARENT, parent); recordConsumedHistory(witness, CHILD, initial(0).child);
    expect(witnessedExecutionEnd(witness)).toBe(false);
  }
  const witness = beginReadWitness();
  recordConsumedHistory(witness, CHILD, initial(0).child); recordConsumedHistory(witness, PARENT, initial(0).parent);
  expect(witnessedExecutionEnd(witness)).toBe(false);
});

test("post-return consumption cannot amend a completed/failed read or borrow an overlapping consumer's idle", () => {
  const state = initial(0);
  for (const status of ["completed", "failed"] as const) {
    const read = { status, witness: beginReadWitness() };
    recordPendingConsumption(read, PARENT, state.parent); recordPendingConsumption(read, CHILD, state.child);
    expect(read.witness.consumed).toEqual([]);
    expect(witnessedExecutionEnd(read.witness)).toBe(false);
  }
  const parent = { status: "pending" as const, witness: beginReadWitness() };
  const child = { status: "pending" as const, witness: beginReadWitness() };
  recordPendingConsumption(parent, PARENT, state.parent); recordPendingConsumption(child, CHILD, state.child);
  expect(witnessedExecutionEnd(parent.witness)).toBe(false);
  expect(witnessedExecutionEnd(child.witness)).toBe(false);
});

test("causal representative equality uses JSON omission only, preserving meaningful false fields", () => {
  expect(isDeepStrictEqual(wireValue([{ activity: { endedAt: undefined } }]), [{ activity: {} }])).toBe(true);
  for (const field of ["outcomeWithheld", "stateUncertain", "dismissible", "canStop"]) {
    expect(isDeepStrictEqual(wireValue([{ [field]: false }]), [{}])).toBe(false);
  }
});

test("consumption witnesses belong to each shared/cache consumer, not the last HTTP producer", async () => {
  const state = initial(0);
  const local = new AsyncLocalStorage<NativeReadWitness>();
  const reads = new Map<string, NativeReadWitness>(), admitted: string[] = [];
  const parentEntered = gate(), releaseParent = gate(), lifetime = new AbortController();
  const pipe = bytePipe();
  let parentFetches = 0, childFetches = 0, failParentRecord = false;
  const provider = createOpenCodeV2Provider({ endpoint: "http://consumption.test", directory: DIRECTORY, password: "pw",
    observeHistoryConsumption: (id, messages) => recordConsumedHistory(local.getStore(), id, messages),
    fetch: (async (input: Request | string | URL, init?: RequestInit) => {
      const request = new Request(input, init), path = new URL(request.url).pathname;
      if (path === "/api/event") {
        pipe.enqueue(new TextEncoder().encode('data: {"type":"server.connected","data":{}}\n\n'));
        request.signal.addEventListener("abort", pipe.close, { once: true });
        const response = new Response(null, { headers: { "content-type": "text/event-stream" } });
        Object.defineProperty(response, "body", { value: pipe.body }); return response;
      }
      if (failParentRecord && path === `/api/session/${PARENT}`) throw new Error("controlled parent record failure");
      const body = structuredClone(payload(state, path));
      if (path === `/api/session/${PARENT}/message` && ++parentFetches === 1) { parentEntered.resolve(); await releaseParent.promise; }
      if (path === `/api/session/${CHILD}/message`) childFetches++;
      return json(body);
    }) as typeof globalThis.fetch });
  const iterator = provider.events(lifetime.signal)[Symbol.asyncIterator]();
  const read = (name: string, signal?: AbortSignal) => {
    const witness = beginReadWitness(); reads.set(name, witness);
    return local.run(witness, async () => {
      const page = await provider.listMessages(PARENT, { limit: 100, signal });
      if (witnessedExecutionEnd(witness)) admitted.push(name);
      return page;
    });
  };
  try {
    expect((await iterator.next()).value?.eventType).toBe("server.connected");
    const producer = read("producer");
    await parentEntered.promise;
    const consumer = read("consumer"), aborted = new AbortController();
    const cancelled = read("aborted", aborted.signal).catch(() => undefined);
    aborted.abort(); await cancelled;
    expect(admitted).toEqual([]); // No witness admission before public completion.
    expect(reads.get("aborted")!.consumed).toEqual([]);
    releaseParent.resolve(); await Promise.all([producer, consumer]);
    expect(parentFetches).toBe(1); // Public transport count, not cache introspection.
    expect(childFetches).toBe(1);
    expect(admitted.sort()).toEqual(["consumer", "producer"]);
    const consumedChild = structuredClone(state.child);
    for (const name of ["producer", "consumer"]) {
      expect(reads.get(name)!.consumed).toEqual([
        { sessionId: PARENT, bodyHash: digest({ data: state.parent, cursor: {} }) },
        { sessionId: CHILD, bodyHash: digest({ data: consumedChild, cursor: {} }) },
      ]);
    }
    // A different latest-body baseline and backend must not replace a cached
    // consumer's exact input. The fixture deliberately changes both directions.
    state.child = state.child.filter(message => message.type !== "idle");
    await read("cache-old");
    expect(parentFetches).toBe(1); expect(childFetches).toBe(1);
    expect(reads.get("cache-old")!.consumed.at(-1)?.bodyHash).toBe(digest({ data: consumedChild, cursor: {} }));
    expect(admitted).toContain("cache-old");
    pipe.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "session.message.content.updated", location: { directory: DIRECTORY },
      data: { sessionID: CHILD, messageID: "stream", content: [] } })}\n\n`));
    expect((await iterator.next()).value?.eventType).toBe("session.message.content.updated");
    await read("no-idle");
    const afterReload = childFetches;
    await read("cache-no-idle");
    expect(childFetches).toBe(afterReload);
    expect(afterReload).toBeGreaterThan(1);
    expect(reads.get("cache-no-idle")!.consumed.at(-1)?.bodyHash).toBe(digest({ data: state.child, cursor: {} }));
    expect(admitted).not.toContain("cache-no-idle");
    expect(admitted).not.toContain("no-idle");
    expect(admitted).not.toContain("aborted");
    failParentRecord = true;
    await expect(read("failed-after-consumption")).rejects.toThrow("controlled parent record failure");
    expect(reads.get("failed-after-consumption")!.consumed.some(input => input.sessionId === PARENT)).toBe(true);
    expect(admitted).not.toContain("failed-after-consumption");
    // Every observer snapshot is owned: no input or another consumer is mutated.
    reads.get("producer")!.consumed.length = 0;
    expect(reads.get("consumer")!.consumed.at(-1)?.bodyHash).toBe(digest({ data: consumedChild, cursor: {} }));
    expect(state.child.length).toBeGreaterThan(0);
  } finally { releaseParent.resolve(); lifetime.abort(); pipe.close(); await iterator.return?.(); await provider.dispose!(); }
});

test("task scheduling seam: absent native timers are no-ops and injected cancellation retains its argument", () => {
  expect(() => clearChatTimeout(undefined, null)).not.toThrow();
  expect(() => clearChatTimeout(undefined, undefined)).not.toThrow();
  const cancelled: unknown[] = [];
  const scheduler: ChatTaskScheduler = {
    run: async (_name, work) => work(),
    setTimeout: (_name, work, delay) => setTimeout(work, delay),
    clearTimeout: timer => { cancelled.push(timer); },
  };
  clearChatTimeout(scheduler, null);
  clearChatTimeout(scheduler, undefined);
  expect(cancelled).toEqual([null, undefined]);
});

test("task scheduling seam: omitted scheduler preserves flush ordering, swallowed errors and disposal", async () => {
  const seen: string[] = [];
  const coalescer = new ProviderUpdateCoalescer({ onFlush: (_id, updates) => {
    const status = updates.find(update => update.kind === "status");
    if (status?.kind === "status") seen.push(status.status);
    if (seen.length === 1) throw 0;
  } });
  coalescer.push("parent", [{ kind: "status", status: "running" }]);
  expect(seen).toEqual([]);
  await coalescer.settled();
  coalescer.push("parent", [{ kind: "status", status: "completed" }]);
  await coalescer.settled();
  expect(seen).toEqual(["running", "completed"]);
  coalescer.dispose();
  coalescer.push("parent", [{ kind: "status", status: "failed" }]);
  await coalescer.settled();
  expect(seen).toEqual(["running", "completed"]);
});

test("task scheduling seam: injected coalescer preserves cancellation, epochs, rejection and dispose flush", async () => {
  let entered = gate();
  const jobs: Array<() => void> = [], cancelled: unknown[] = [], seen: string[] = [];
  const scheduler: ChatTaskScheduler = {
    run<T>(_name: string, work: () => T | Promise<T>): Promise<T> {
      return new Promise((resolve, reject) => {
        jobs.push(() => { void Promise.resolve().then(work).then(resolve, reject); });
        entered.resolve();
      });
    },
    setTimeout: () => ({ ref() { return this; }, unref() { return this; } }) as ReturnType<typeof setTimeout>,
    clearTimeout: timer => { cancelled.push(timer); },
  };
  const coalescer = new ProviderUpdateCoalescer({ taskScheduler: scheduler, onFlush: (_id, updates) => {
    seen.push(updates[0]!.kind);
    if (updates[0]!.kind === "text") throw 0;
  } });
  coalescer.push("parent", [{ kind: "text", itemId: "part:text", identity: "text", mode: "cumulative", text: "old" }]);
  coalescer.flushAll();
  await entered.promise;
  coalescer.discard("parent");
  jobs.shift()!();
  await coalescer.settled();
  expect(seen).toEqual([]);
  expect(cancelled).toHaveLength(1);
  entered = gate();
  coalescer.push("parent", [{ kind: "status", status: "running" }]);
  await entered.promise; jobs.shift()!(); await coalescer.settled();
  expect(seen).toEqual(["status"]);
  entered = gate();
  coalescer.push("parent", [{ kind: "text", itemId: "part:text", identity: "text", mode: "cumulative", text: "new" }]);
  coalescer.dispose();
  await entered.promise; jobs.shift()!(); await coalescer.settled();
  expect(seen).toEqual(["status", "text"]);
  expect(cancelled).toHaveLength(2);
  coalescer.push("parent", [{ kind: "status", status: "completed" }]);
  await coalescer.settled();
  expect(seen).toEqual(["status", "text"]);
});

test("task scheduling seam: disposing a paused event drains its resolver and closes native SSE", async () => {
  const entered = gate(), jobs: Array<() => void> = [];
  let closed = false, starts = 0;
  const scheduler: ChatTaskScheduler = {
    run<T>(_name: string, work: () => T | Promise<T>): Promise<T> {
      return new Promise((resolve, reject) => {
        jobs.push(() => { starts++; void Promise.resolve().then(work).then(resolve, reject); });
        entered.resolve();
      });
    },
    setTimeout: (_name, work, delay) => setTimeout(work, delay),
    clearTimeout: timer => clearChatTimeout(undefined, timer),
  };
  const provider = createOpenCodeV2Provider({ endpoint: "http://paused-event.test", directory: DIRECTORY, password: "pw",
    fetch: (async (input: Request | string | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname !== "/api/event") throw new Error("Aborted event must not start metadata reads");
      const pipe = bytePipe();
      pipe.enqueue(new TextEncoder().encode('data: {"type":"server.connected","data":{}}\n\n'));
      request.signal.addEventListener("abort", () => { closed = true; pipe.close(); }, { once: true });
      const response = new Response(null, { headers: { "content-type": "text/event-stream" } });
      Object.defineProperty(response, "body", { value: pipe.body });
      return response;
    }) as typeof globalThis.fetch });
  const adapter = new ChatAdapter({ provider, workspacePath: DIRECTORY, taskScheduler: scheduler });
  const pump = adapter.startEventPump();
  try {
    await entered.promise;
    const disposing = adapter.dispose();
    jobs.shift()!();
    await disposing; await pump;
    expect(starts).toBe(1);
    expect(jobs).toHaveLength(0);
    expect(closed).toBe(true);
  } finally { while (jobs.length) jobs.shift()!(); await adapter.dispose(); await pump.catch(() => undefined); }
});

test.skipIf(!process.env.UATU_ORDERING_ARTIFACT_DIR)("seeded native recovery orderings converge or stay Unresolved, and parent reads make bounded progress", async () => {
  const directory = process.env.UATU_ORDERING_ARTIFACT_DIR;
  if (!directory) throw new Error("Opt in to technical artifacts with UATU_ORDERING_ARTIFACT_DIR (use ~/.cache/opencode/scratch/pr625-convergence for this task)");
  mkdirSync(directory, { recursive: true });
  const began = performance.now();
  const replay = process.env.UATU_ORDERING_REPLAY ? readArtifact(process.env.UATU_ORDERING_REPLAY) : undefined;
  const replayMode = process.env.UATU_ORDERING_REPLAY_MODE ?? "strict";
  if (replayMode !== "strict" && replayMode !== "causal-actions") throw new Error(`Unknown replay mode: ${replayMode}`);
  if (replay && (!Array.isArray(replay.schedule) || !replay.result)) throw new Error("Replay requires a saved action schedule and reference result");
  const seeds = process.env.UATU_ORDERING_SEED !== undefined ? [Number(process.env.UATU_ORDERING_SEED)]
    : replay ? [replay.seed] : Array.from({ length: Number(process.env.UATU_ORDERING_SEEDS ?? 1000) }, (_, seed) => seed);
  const controls = [];
  for (const seed of [0, 1, 2]) controls.push(await run(seed, true));
  const results: ReturnType<typeof brief>[] = [];
  const shortestByInvariant: Partial<Record<"a" | "b", Result>> = {};
  let replayResult: Result | undefined;
  for (const seed of seeds) {
    const result = await run(seed, false, replay?.omitted, replay?.schedule, replay?.exactTrace, replay?.result, replayMode);
    for (const invariant of ["a", "b"] as const) if (result[invariant] && !result.harness
      && (!shortestByInvariant[invariant] || result.trace.length < shortestByInvariant[invariant]!.trace.length)) shortestByInvariant[invariant] = result;
    if (seeds.length === 1) replayResult = result;
    results.push(brief(result));
    if (seeds.length === 1 || seed < 3) {
      // These are new strict replay inputs, not rewrites of the old RED proof.
      writeFileSync(join(directory, `sample-seed-${seed}.json.gz`), gzipSync(JSON.stringify({ seed, omitted: replay?.omitted ?? [],
        schedule: result.schedule, exactTrace: result.trace, result })));
    }
  }
  const count = (field: "a" | "b" | "harness") => results.filter(result => result[field]).length;
  const summary = { seeds: results.length, first: seeds[0], last: seeds.at(-1), A: count("a"), B: count("b"),
    oracleReadCoverage: ORACLE_COVERAGE,
    metadataAwaitChannels: Object.fromEntries(["native", "observations", "jobs"].map(channel => [channel,
      results.reduce((sum, result) => sum + result.metadataAwaitChannels[channel as keyof typeof result.metadataAwaitChannels], 0)])),
    consumedWithoutConsumerHttp: results.reduce((sum, result) => sum + result.consumedWithoutConsumerHttp, 0),
    union: results.filter(result => result.a || result.b).length, harnessErrors: count("harness"),
    controls: controls.map(result => ({ seed: result.seed, a: result.a, b: result.b, harness: result.harness, physicalHistoryReads: result.physicalHistoryReads, logicalAttempts: result.logicalAttempts })),
    baselineElapsedMs: Math.round(performance.now() - began), elapsedMs: 0, attemptBound: ATTEMPTS,
    replayDivergences: results.filter(result => result.replayDivergence).length, replayMode, oracleModel: ORACLE_MODEL,
    maxLogicalAttempts: Math.max(...results.map(result => result.logicalAttempts)),
    maxPhysicalHistoryReads: Math.max(...results.map(result => result.physicalHistoryReads)),
    classification: "observed sample; representative strict replay validation reported separately" };
  // Representatives are shortest observed traces per invariant. Greedy replay
  // deletes optional external reads while preserving mutation causality; this
  // is NOT a proof of a globally shortest schedule or an exhaustive search.
  const representatives: unknown[] = [];
  for (const invariant of ["a", "b"] as const) {
    if (replay) break; // Replaying evidence never overwrites its source artifact.
    const shortest = shortestByInvariant[invariant];
    if (!shortest) continue;
    let minimized = shortest;
    const omitted: string[] = [];
    const deletions: unknown[] = [];
    const verification = await run(shortest.seed, false, [], shortest.schedule, shortest.trace, shortest);
    const verified = !verification.harness && verification[invariant];
    // A non-reproducing trace cannot support causal minimization. Preserve it
    // as exploratory evidence instead of shrinking a different execution.
    let changed = true;
    while (changed && verified && process.env.UATU_ORDERING_SHRINK !== "0") {
      changed = false;
      for (const action of shortest.schedule.filter(action => action.startsWith("observe:") && !omitted.includes(action))) {
        const candidate = await run(shortest.seed, false, [...omitted, action], shortest.schedule);
        deletions.push({ action, harness: candidate.harness, preservedFailure: candidate[invariant], traceLength: candidate.trace.length });
        if (!candidate.harness && candidate[invariant] && candidate.trace.length <= minimized.trace.length
          && isDeepStrictEqual(candidate.fresh.map(semantic), shortest.fresh.map(semantic))) { omitted.push(action); minimized = candidate; changed = true; }
      }
    }
    const minimizedVerification = await run(minimized.seed, false, omitted, minimized.schedule, minimized.trace, minimized);
    const minimizedVerified = !minimizedVerification.harness && minimizedVerification[invariant];
    const representative = { invariant, seed: shortest.seed, omitted, schedule: minimized.schedule, exactTrace: minimized.trace, deletions,
      sameProcessReplayMatched: minimizedVerified, originalSameProcessReplayMatched: verified,
      crossProcessValidation: "not established by this process", originalVerification: verification, verification: minimizedVerification,
      method: process.env.UATU_ORDERING_SHRINK === "0" ? "shortest observed trace; shrinking explicitly disabled"
        : "shortest observed trace; repeated optional-observation deletion with exact surviving-action replay and fixed fresh semantic oracle; divergent deletion trials are retained, not proof of semantic one-minimality or globally shortest", result: minimized };
    representatives.push(representative);
    const representativePath = join(directory, `representative-${invariant.toUpperCase()}.json`);
    writeFileSync(`${representativePath}.gz`, gzipSync(JSON.stringify(representative)));
    writeFileSync(representativePath, JSON.stringify({ seed: shortest.seed, invariant, replayArtifact: `${representativePath}.gz`, method: representative.method }, null, 2));
    const compact = (action: string) => action.replaceAll("/api/session/ses_parent", "P").replaceAll("/api/session/ses_child", "C")
      .replaceAll("/api/session/active", "active").replaceAll("owned:GET ", "O:").replaceAll("pump:GET ", "S:").replaceAll("release ", "< ");
    console.log(`${minimizedVerified ? "SAME-PROCESS MATCH ONLY" : "UNVERIFIED"} shortest sampled ${invariant.toUpperCase()}: ${JSON.stringify({ seed: shortest.seed, omitted, sameProcessReplayMatched: minimizedVerified, originalSameProcessReplayMatched: verified, replayDivergence: minimizedVerification.replayDivergence,
      logicalAttempts: minimized.logicalAttempts, physicalHistoryReads: minimized.physicalHistoryReads, ordering: minimized.schedule.map(compact), actual: minimized.actual.map(value => semantic(value.row)), fresh: minimized.fresh.map(semantic),
      artifact: join(directory, `representative-${invariant.toUpperCase()}.json`), method: representative.method })}`);
  }
  // Sensitivity is checked with independent real fresh outcomes, not a fake
  // guard: accepting an old completed row after native idle removal must fail.
  const visible = initial(0), removed = initial(0); delete visible.boundary; delete removed.boundary;
  removed.child = removed.child.slice(0, 1);
  const visibleRows = await oracle(visible), removedRows = await oracle(removed);
  const sensitivity = visibleRows.some(row => mismatch(row, removedRows).bad);
  // A conservative implementation cannot satisfy the property by withholding
  // every outcome: quiet cold reads and all three no-mutation controls converge.
  const quietCompleted = visibleRows.some(row => row.status === "completed" && !row.stateUncertain && !row.outcomeWithheld);
  const controlsCompleted = controls.every(result => result.actual.length > 0 && result.actual.every(({ row }) =>
    row.status === "completed" && !row.stateUncertain && !row.outcomeWithheld));
  summary.elapsedMs = Math.round(performance.now() - began);
  const artifact = join(directory, seeds.length === 1 ? `seed-${seeds[0]}.json` : "baseline.json");
  console.log(`Ordering baseline ${JSON.stringify({ ...summary, sensitivity, quietCompleted, controlsCompleted, artifact })}`);
  // Native snapshots repeat heavily. Keep full technical evidence losslessly
  // compressed rather than filling the workstation disk with duplicate bodies.
  const fullArtifact = artifact.replace(/\.json$/, ".full.json.gz");
  writeFileSync(fullArtifact, gzipSync(JSON.stringify({ summary, sensitivity, quietCompleted, controlsCompleted, sensitivityEvidence: { visibleRows, removedRows }, controls: controls.map(brief), controlDetails: controls, results,
    replayResult, representatives: representatives.map((value: any) => ({ seed: value.seed, invariant: value.invariant, method: value.method })) })));
  writeFileSync(artifact, JSON.stringify({ summary, sensitivity, quietCompleted, controlsCompleted, fullArtifact, controls: summary.controls,
    representatives: representatives.map((value: any) => ({ invariant: value.invariant, seed: value.seed,
      sameProcessReplayMatched: value.sameProcessReplayMatched, replayDivergence: value.verification.replayDivergence })) }, null, 2));
  expect(controls.every(result => !result.a && !result.b && !result.harness)).toBe(true);
  expect(sensitivity).toBe(true);
  expect(quietCompleted).toBe(true);
  expect(controlsCompleted).toBe(true);
  expect(summary.harnessErrors).toBe(0);
  expect(summary.union).toBe(0);
}, 360_000);
