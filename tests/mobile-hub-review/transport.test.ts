import { expect, test } from "bun:test";
import { createReviewPersonalState, createReviewTransport, deserializeReviewValue, serializeReviewValue, validateReviewFacts } from "./transport";
import { startReviewServer } from "./server";
import type { CloneStreamEvent } from "../../src/hub/mobile/backend";

for (const typed of [false, true]) test(`old authentication failure cannot revoke a new sign-in (typed=${typed})`, async () => {
  const originalFetch = globalThis.fetch, descriptor = Object.getOwnPropertyDescriptor(globalThis, "EventSource");
  let source: any, release!: (response: Response) => void;
  class Source { onopen?: () => void; onmessage?: (event: { data: string }) => void; close() {} constructor() { source = this; queueMicrotask(() => this.onopen?.()); } }
  Object.defineProperty(globalThis, "EventSource", { configurable: true, value: Source });
  globalThis.fetch = (async (url: string) => url.endsWith("readDevices") ? new Promise<Response>(resolve => { release = resolve; }) : Response.json(url.endsWith("signIn") ? { status: "completed", value: { user: "reviewer", host: "mock.invalid", version: "review" } } : { status: "available", value: [] })) as typeof fetch;
  const backend = createReviewTransport(), events: unknown[] = [];
  const unsubscribe = backend.subscribeInvalidation(event => events.push(event));
  try {
    const pending = backend.readDevices();
    while (!release) await Promise.resolve();
    const event = { scope: "authentication", reason: "unauthorized", generation: 10 };
    source.onmessage({ data: JSON.stringify(event) });
    await backend.signIn({ user: "reviewer", password: "review-only" });
    // Replayed authentication and catalog events are not fresh notifications.
    source.onmessage({ data: JSON.stringify(event) });
    source.onmessage({ data: JSON.stringify({ scope: "catalog", resource: "devices", generation: 9 }) });
    release(typed ? Response.json({ status: "unavailable", problem: { kind: "unauthorized", message: "old context" } }) : new Response(null, { status: 401 }));
    expect(await pending).toMatchObject({ status: "unavailable", problem: { kind: "unavailable" } });
    expect(events).toHaveLength(1);
    expect(await backend.readWorkspaces()).toEqual({ status: "available", value: [] });
  } finally { unsubscribe(); globalThis.fetch = originalFetch; if (descriptor) Object.defineProperty(globalThis, "EventSource", descriptor); else Reflect.deleteProperty(globalThis, "EventSource"); }
});

test("management File wire contains size only; private bytes/name never read or transmitted", async () => {
  const source = new File([new Uint8Array([0, 255, 1])], "review.key", { type: "application/octet-stream", lastModified: 123 });
  source.arrayBuffer = () => { throw new Error("Must not read private bytes"); };
  const wire = await serializeReviewValue({ source: { kind: "file", file: source }, omitted: undefined });
  const restored = deserializeReviewValue(wire) as { source: { kind: string; file: File }; omitted?: string };
  expect(wire).toEqual({ source: { kind: "file", file: { $reviewFile: true, size: 3 } } });
  expect(restored.source.file.size).toBe(3);
  expect(new Uint8Array(await restored.source.file.arrayBuffer())).toEqual(new Uint8Array([0, 0, 0]));
  expect(Object.hasOwn(restored, "omitted")).toBe(false);
  const oversized = new File([new Uint8Array(1024 * 1024 + 1)], "large.key");
  oversized.arrayBuffer = () => { throw new Error("Must not read"); };
  await expect(serializeReviewValue(oversized)).rejects.toThrow("exceeds 1 MiB");
});

test("HTTP clone stream replays the accepted job, masks input and reports reset unavailability", async () => {
  const server = await startReviewServer({ port: 0, assets: new Map() });
  const abort = new AbortController();
  const call = async (method: string, args: unknown[]) => (await fetch(`${server.url}/review/backend/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(args) })).json();
  try {
    const result = await call("submitClone", [{ attemptId: "http-attempt-1", url: "https://github.com/review/example.git", dest: "/synthetic", folderName: "stream-review", displayName: "Stream review", credentialId: null, retainedAuthentication: [], signing: null, start: false }]);
    expect(result).toMatchObject({ status: "completed", value: { status: "accepted" } });
    const id = result.value.jobId;
    server.synthetic.cloneOutput(id, "prompt");
    await call("sendCloneInput", [{ jobId: id, input: "PRIVATE-PROMPT-NOT-REPLAYED" }]);
    const response = await fetch(`${server.url}/review/clone-events?jobId=${id}&afterEventId=1`, { signal: abort.signal });
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const reader = response.body!.getReader();
    const decoder = new TextDecoder(); let buffer = "";
    async function event(): Promise<CloneStreamEvent> {
      while (!buffer.includes("\n\n")) { const part = await reader.read(); if (part.done) throw new Error("Unexpected stream end"); buffer += decoder.decode(part.value, { stream: true }); }
      const end = buffer.indexOf("\n\n"), frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
      return JSON.parse(frame.slice("data: ".length));
    }
    const prompt = await event(), masked = await event();
    expect(prompt).toMatchObject({ type: "job-event", event: { id: 2, type: "output" } });
    expect(JSON.stringify(masked)).toContain("[masked input accepted]");
    expect(JSON.stringify(masked)).not.toContain("PRIVATE-PROMPT-NOT-REPLAYED");
    server.synthetic.reset();
    expect(await event()).toMatchObject({ type: "unavailable" });
    await reader.cancel();
    expect((await fetch(`${server.url}/review/clone-events?jobId=${id}&afterEventId=-1`)).status).toBe(400);
  } finally { abort.abort(); server.stop(); }
});
test("review personal state has explicit patch semantics and no arbitrary path authority", () => {
  const state = createReviewPersonalState(["README.md"], "terminal");
  expect(state.patch({ documentPath: "README.md", follow: false, lastPtyId: "terminal" })).toBe(true);
  expect(state.patch({ documentPath: "/private/work", follow: true })).toBe(false);
  expect(state.read()).toEqual({ version: 1, documentPath: "README.md", follow: false, lastPtyId: "terminal" });
  expect(state.patch({ lastPtyId: null })).toBe(true);
  expect(state.patch({ unrecognized: true })).toBe(false);
  state.reset(); expect(state.read()).toEqual({ version: 1 });
});
test("HTTP operation allowlist acts on the same backend and rejects unknown methods/arity", async () => {
  const server = await startReviewServer({ port: 0, assets: new Map() });
  const call = (method: string, args: unknown[]) => fetch(`${server.url}/review/backend/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(args) });
  try {
    expect((await call("constructor", [])).status).toBe(501);
    expect((await call("signOut", ["unexpected"])).status).toBe(400);
    expect(server.synthetic.snapshot().authenticated).toBe(true);
    expect((await call("readAuthentication", [])).status).toBe(200);
    expect((await call("signOut", [])).status).toBe(200);
    expect(server.synthetic.snapshot().authenticated).toBe(false);
    expect((await fetch(`${server.url}/s/atlas/api/state`)).status).toBe(401);
  } finally { server.stop(); }
});

test("explicit fact and attempt wire validators reject ambiguous state rather than parsing diagnostics", () => {
  const facts = { id: "key", type: "ssh", protection: { status: "known", value: "unprotected" }, lock: { status: "known", value: "locked" }, userId: { status: "not-applicable" } };
  expect(() => validateReviewFacts("readCredentialFacts", facts)).not.toThrow();
  expect(() => validateReviewFacts("readCredentialFacts", { ...facts, protection: { status: "unknown", value: "protected" } })).toThrow();
  expect(() => validateReviewFacts("readCredentialFacts", { ...facts, type: "token" })).toThrow();
  expect(() => validateReviewFacts("readCredentialFacts", { ...facts, lock: { message: "unlocked" } })).toThrow();
  expect(() => validateReviewFacts("readToolConfiguration", { tool: "git", savedOverride: { status: "known", value: null } })).not.toThrow();
  expect(() => validateReviewFacts("readToolConfiguration", { tool: "git", savedOverride: { status: "unknown", value: "/bin/git" } })).toThrow();
  expect(() => validateReviewFacts("reconcileCloneAttempt", { status: "accepted", jobId: "job" })).not.toThrow();
  for (const status of ["pending", "expired", "not-accepted"]) {
    expect(() => validateReviewFacts("reconcileCloneAttempt", { status })).not.toThrow();
    expect(() => validateReviewFacts("reconcileCloneAttempt", { status, jobId: "job" })).toThrow();
  }
  expect(() => deserializeReviewValue({ $reviewFile: true, size: 3, bytes: "private" })).toThrow();
});

test("browser management transport carries explicit facts and reconciles lost clone responses", async () => {
  const server = await startReviewServer({ port: 0, assets: new Map() });
  const nativeFetch = globalThis.fetch;
  let drop: "before" | "after" | null = null;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input); const isSubmit = path.endsWith("/submitClone");
    if (isSubmit && drop === "before") { drop = null; throw new Error("Synthetic network loss"); }
    const response = await nativeFetch(new URL(path, server.url), init);
    if (isSubmit && drop === "after") { drop = null; throw new Error("Synthetic response lost after acceptance"); }
    return response;
  }) as typeof fetch;
  try {
    const backend = createReviewTransport();
    expect(await backend.readCredentialFacts({ id: "ssh-open", type: "ssh" })).toMatchObject({ status: "available", value: { protection: { status: "known", value: "unprotected" } } });
    expect(await backend.readToolConfiguration("git")).toEqual({ status: "available", value: { tool: "git", savedOverride: { status: "known", value: null } } });
    const intent = { attemptId: "wire-attempt-before", url: "https://github.com/review/example.git", dest: "/synthetic", folderName: "wire-checkout", displayName: "Wire checkout", credentialId: null, retainedAuthentication: [], signing: null, start: false };
    drop = "before"; expect((await backend.submitClone(intent)).status).toBe("indeterminate");
    expect(await backend.reconcileCloneAttempt({ attemptId: intent.attemptId })).toEqual({ status: "available", value: { status: "not-accepted" } });
    expect((await backend.submitClone(intent)).status).toBe("rejected"); expect(server.synthetic.inspect().jobs).toHaveLength(0);
    const authorized = { ...intent, attemptId: "wire-attempt-after" };
    drop = "after"; expect((await backend.submitClone(authorized)).status).toBe("indeterminate");
    const state = await backend.reconcileCloneAttempt({ attemptId: authorized.attemptId }); expect(state).toMatchObject({ status: "available", value: { status: "accepted" } });
    expect(server.synthetic.inspect().jobs).toHaveLength(1);
    expect(await backend.submitClone(authorized)).toMatchObject({ status: "completed", value: { status: "accepted" } });
    expect(server.synthetic.inspect().jobs).toHaveLength(1);
    await backend.signOut(); expect(await backend.reconcileCloneAttempt({ attemptId: authorized.attemptId })).toMatchObject({ status: "unavailable", problem: { kind: "unauthorized" } });
  } finally { globalThis.fetch = nativeFetch; server.stop(); }
});
