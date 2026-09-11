// The brokered live stream against a real hub and a real `uatu serve` child
// (from source). The assertion this file exists to make — "the child holds
// one subscription per watched topic however many tabs watch it" — is read
// from the child's own stream gauges (its /debug/metrics, proxied through
// the hub), not from hub bookkeeping.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { MetricsRegistry } from "../debug/metrics";
import { LIVE_STREAM_PATH, parseLiveEnvelope, parseLiveHello, type LiveEnvelope } from "../shared/live-protocol";
import { hashPassword, HubSessionStore } from "./auth";
import { LocalProcessBackend } from "./backend";
import type { HubConfig } from "./config";
import { EMPTY_CREDENTIAL_CONTEXT_RESOLVER } from "./credential-context";
import { LiveBroker, setLiveUpstreamDiagnostics } from "./live-broker";
import { createHubUpstreamSource } from "./live-source";
import { SseFrameParser } from "./live-sse";
import { PersonalWorkspaceStateStore } from "./personal-state";
import { WorkspaceRegistry } from "./registry";
import { startHubServer } from "./server";
import { SessionManager } from "./sessions";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");
const CLI_PATH = path.join(REPO_ROOT, "src", "cli.ts");
const LINGER_MS = 300;

let tempRoot = "";
let workspace = "";
let sessions: SessionManager;
let server: ReturnType<typeof startHubServer>;
let origin = "";
let cookie = "";
let hubMetrics: MetricsRegistry;

beforeAll(async () => {
  setLiveUpstreamDiagnostics(() => undefined);
  tempRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "uatu-hub-live-")));
  workspace = path.join(tempRoot, "workspaces", "proj");
  execFileSync("mkdir", ["-p", workspace]);
  execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
  await writeFile(path.join(workspace, "README.md"), "# Live\n\nfirst body\n");

  const config: HubConfig = {
    port: 0 as number,
    host: "127.0.0.1",
    tls: null,
    users: [{ name: "t", passwordHash: await hashPassword("x") }],
    stateDir: path.join(tempRoot, "state"),
  };
  const registry = new WorkspaceRegistry(path.join(tempRoot, "registry.json"));
  await registry.load();
  const personalState = new PersonalWorkspaceStateStore(path.join(tempRoot, "personal-state.json"));
  await personalState.load();
  const sessionStore = new HubSessionStore(path.join(tempRoot, "sessions.json"));
  await sessionStore.load();
  sessions = new SessionManager(registry, {
    // UATU_DEBUG exposes the child's /debug/metrics (the same as --debug);
    // its verbose history goes to a scratch cache dir.
    local: new LocalProcessBackend({
      uatuArgv: ["bun", "run", CLI_PATH],
      env: { ...process.env, UATU_DEBUG: "1", XDG_CACHE_HOME: path.join(tempRoot, "cache") },
    }),
  }, EMPTY_CREDENTIAL_CONTEXT_RESOLVER);
  await registry.register(workspace);
  await sessions.start("proj");

  hubMetrics = new MetricsRegistry();
  const liveBroker = new LiveBroker(createHubUpstreamSource({ sessions, registry }), {
    lingerMs: LINGER_MS,
    metrics: hubMetrics,
    // Long enough that a failing conversation upstream is attempted once
    // per assertion window, so the "one attempt for three tabs" count holds.
    retryMinMs: 10_000,
    retryMaxMs: 10_000,
  });
  server = startHubServer({ config, registry, sessions, sessionStore, personalState, liveBroker, metrics: hubMetrics });
  origin = `http://127.0.0.1:${server.port}`;
  cookie = `uatu_hub=${(await sessionStore.issue("t", "test")).id}`;
}, 60_000);

afterAll(async () => {
  server?.live.endAll();
  server?.liveBroker.dispose();
  server?.stop(true);
  await sessions?.stopAll().catch(() => undefined);
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  setLiveUpstreamDiagnostics(null);
});

async function childGauge(name: string): Promise<number> {
  const response = await fetch(`${origin}/s/proj/debug/metrics`, { headers: { cookie } });
  expect(response.status).toBe(200);
  const snapshot = (await response.json()) as { counters: Record<string, number> };
  return snapshot.counters[name] ?? 0;
}

async function waitFor(predicate: () => Promise<boolean> | boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for ${what}`);
}

type Tab = {
  hello: string | null;
  envelopes: LiveEnvelope[];
  ended: boolean;
  close(): Promise<void>;
  waitFor(predicate: (tab: Tab) => boolean, what: string, timeoutMs?: number): Promise<void>;
};

const SUBS = JSON.stringify([
  { topic: "document", key: "" },
  { topic: "inventory" },
  { topic: "conversation", key: "opencode:never-created" },
]);

async function openTab(): Promise<Tab> {
  const controller = new AbortController();
  const response = await fetch(`${origin}${LIVE_STREAM_PATH}?ws=proj&subs=${encodeURIComponent(SUBS)}`, {
    headers: { cookie, accept: "text/event-stream" },
    signal: controller.signal,
  });
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  const parser = new SseFrameParser();
  const tab: Tab = {
    hello: null,
    envelopes: [],
    ended: false,
    async close() {
      controller.abort();
      await reader.cancel().catch(() => undefined);
    },
    async waitFor(predicate, what, timeoutMs = 10_000) {
      await waitFor(() => predicate(tab), what, timeoutMs);
    },
  };
  void (async () => {
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        for (const frame of parser.push(next.value)) {
          if ("comment" in frame) continue;
          if (frame.event === "hello") tab.hello = parseLiveHello(frame.data)?.streamId ?? null;
          if (frame.event === "live") {
            const envelope = parseLiveEnvelope(frame.data);
            if (envelope) tab.envelopes.push(envelope);
          }
        }
      }
    } catch {
      // Closed by the test.
    }
    tab.ended = true;
  })();
  return tab;
}

const ofTopic = (tab: Tab, topic: string) => tab.envelopes.filter(envelope => envelope.topic === topic);

describe("brokered live stream over a real child", () => {
  test("three tabs on one workspace hold one child subscription per topic, kept until the last tab leaves", async () => {
    const tabs = [await openTab(), await openTab(), await openTab()];
    for (const tab of tabs) {
      await tab.waitFor(t => ofTopic(t, "document").some(e => e.event.kind === "ready"), "document ready");
      await tab.waitFor(t => ofTopic(t, "inventory").some(e => e.event.kind === "ready"), "inventory ready");
      // The conversation does not exist in this child: the hub reports the
      // topic unavailable, exactly once, and leaves the stream open.
      await tab.waitFor(t => ofTopic(t, "conversation").length === 1, "conversation verdict");
      expect(ofTopic(tab, "conversation")[0]!.event.kind).toBe("unavailable");
      expect(ofTopic(tab, "document")[0]!.event.kind).toBe("data");
      expect(tab.ended).toBe(false);
    }
    await waitFor(async () => (await childGauge("stream.document.active")) === 1, "one document subscriber at the child");
    expect(await childGauge("stream.chat-inventory.active")).toBe(1);
    // One conversation attempt for three tabs, and it is the hub that owns
    // the retry — the child saw one open that ended.
    expect(hubMetrics.get("upstream.conversation.opened_total")).toBe(1);
    expect(hubMetrics.get("stream.hub-live.active")).toBe(3);

    // A live change reaches every tab once, in the same envelope shape.
    await writeFile(path.join(workspace, "README.md"), "# Live\n\nsecond body\n");
    for (const tab of tabs) {
      await tab.waitFor(t => ofTopic(t, "document").filter(e => e.event.kind === "data").length >= 2, "live document event", 15_000);
    }
    expect(await childGauge("stream.document.active")).toBe(1);

    await tabs[0]!.close();
    await tabs[1]!.close();
    await waitFor(() => hubMetrics.get("stream.hub-live.active") === 1, "two streams ended");
    await Bun.sleep(LINGER_MS * 2);
    expect(await childGauge("stream.document.active")).toBe(1);
    expect(await childGauge("stream.chat-inventory.active")).toBe(1);
    expect(tabs[2]!.ended).toBe(false);

    await tabs[2]!.close();
    await waitFor(async () => (await childGauge("stream.document.active")) === 0, "the child to release the document subscriber after linger");
    await waitFor(async () => (await childGauge("stream.chat-inventory.active")) === 0, "the child to release the inventory subscriber");
    expect(await childGauge("stream.document.closed_total.cancelled")).toBeGreaterThanOrEqual(1);
    expect(server.liveBroker.upstreamCount()).toBe(0);
  }, 60_000);

  test("a child restart is a topic-scoped unavailability, and the stream recovers on the same connection", async () => {
    const tab = await openTab();
    await tab.waitFor(t => ofTopic(t, "document").some(e => e.event.kind === "ready"), "document ready");
    const before = ofTopic(tab, "document").length;

    await sessions.stop("proj");
    await tab.waitFor(t => ofTopic(t, "document").some(e => e.event.kind === "unavailable"), "document unavailable on stop");
    expect(tab.ended).toBe(false);

    await sessions.start("proj");
    await tab.waitFor(
      t => ofTopic(t, "document").slice(before).filter(e => e.event.kind === "data").length >= 1
        && ofTopic(t, "document").at(-1)!.event.kind === "ready",
      "fresh snapshot then ready after restart",
      30_000,
    );
    expect(tab.ended).toBe(false);
    await tab.close();
  }, 90_000);
});
