import { afterEach, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import { installFakeAgy } from "../../../tests/fixtures/antigravity/fake-agy-path";
import { AgentLoginRequiredError, type NormalizedProviderEvent, type SteerConfirmation } from "../provider";
import { CHAT_TURN } from "../turn-liveness";
import type { ConversationItem } from "../types";
import { ConversationNotFoundError } from "../workspace";
import { pathAgentRuntime } from "../path-agent-runtime";
import { LazyChatService } from "../service";
import type { AntigravityPriceTable } from "./pricing";
import { ChatAdapter } from "../adapter";
import { SIGTERM_GRACE_MS } from "../../session-contract/spawn";
import { STDIN_CLOSE_GRACE_MS, TERM_GRACE_MS } from "./connection";
import { AntigravityProvider, type AntigravityProviderOptions } from "./provider";
import { AntigravityRuntime } from "./runtime";

// Every test drives the real provider against the fake `agy` (fake-agy.ts),
// a Bun ACP agent answering from redacted trial fixtures. No real agy, no
// network, no login.

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function setup(options: { idleReleaseMs?: number; idleTimer?: AntigravityProviderOptions["idleTimer"]; prices?: AntigravityPriceTable; setupDeadlineMs?: number } = {}) {
  const fake = await installFakeAgy();
  const provider = new AntigravityProvider({ workspacePath: fake.workspace, executable: fake.executable, env: fake.env, idleReleaseMs: options.idleReleaseMs, idleTimer: options.idleTimer, stdinCloseGraceMs: 500, termGraceMs: 500, prices: options.prices, setupDeadlineMs: options.setupDeadlineMs, homeDirectory: path.join(fake.stateDirectory, "home") });
  const events: NormalizedProviderEvent[] = [];
  const controller = new AbortController();
  void (async () => { for await (const event of provider.events(controller.signal)) events.push(event); })();
  cleanups.push(async () => { controller.abort(); await provider.dispose(); await fake.remove(); });
  const waitFor = async (predicate: () => boolean, what = "condition", timeoutMs = 8_000) => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await Bun.sleep(5);
    }
  };
  const statuses = (sessionId: string) => events.filter(event => event.conversationId === sessionId).flatMap(event => event.updates.flatMap(update => update.kind === "status" ? [update.status] : []));
  const upserts = (sessionId: string) => events.filter(event => event.conversationId === sessionId).flatMap(event => event.updates.flatMap(update => update.kind === "upsert" ? [update.item] : []));
  const latest = (sessionId: string, id: string) => upserts(sessionId).findLast(item => item.id === id);
  const ended = (sessionId: string, count = 1) => waitFor(() => statuses(sessionId).length >= count, `${count} turn end(s)`);
  const run = async (sessionId: string, text: string, extra: Partial<Parameters<AntigravityProvider["prompt"]>[1]> = {}) => {
    const before = statuses(sessionId).length;
    const accepted = await provider.prompt(sessionId, { id: crypto.randomUUID(), text, delivery: "queue", ...extra });
    await ended(sessionId, before + 1);
    return accepted;
  };
  const pendingPermission = async (sessionId: string) => {
    await waitFor(() => upserts(sessionId).some(item => item.type === "permission" && item.status === "pending"), "a permission card");
    return upserts(sessionId).findLast(item => item.type === "permission")! as Extract<ConversationItem, { type: "permission" }>;
  };
  const prompts = async () => (await fake.log()).filter(entry => entry.method === "session/prompt");
  return { fake, provider, events, waitFor, statuses, upserts, latest, ended, run, pendingPermission, prompts };
}

describe.skipIf(process.platform === "win32")("AntigravityProvider", () => {
  describe("processes (D2)", () => {
    test("a conversation's process starts on first need, serves its prompt, and is released after the idle bound", async () => {
      const { fake, provider, run, waitFor } = await setup({ idleReleaseMs: 150 });
      const session = await provider.createSession("ignored");
      expect((await fake.log()).map(entry => entry.method)).toEqual(["initialize", "session/new"]);
      await run(session.id, "Say hello");
      expect((await fake.log()).filter(entry => entry.method === "initialize")).toHaveLength(1);
      await waitFor(() => (provider as unknown as { conversations: Map<string, { process?: unknown }> }).conversations.get(session.id)!.process === undefined, "idle release");
      // The next prompt resumes it in a new process that loads the session.
      await run(session.id, "Again");
      const methods = (await fake.log()).map(entry => entry.method);
      // One process for the new conversation, then a listing that vouches
      // for the id, then the conversation's new process.
      expect(methods.filter(method => method === "initialize")).toHaveLength(3);
      expect(methods.indexOf("session/list")).toBeGreaterThan(methods.indexOf("session/new"));
      expect(methods.indexOf("session/load")).toBeGreaterThan(methods.indexOf("session/list"));
    });

    test("idle release waits for a prompt that is still being prepared", async () => {
      // Idle release fires when the test says, not on a clock.
      const armed = new Set<() => void>();
      const idleTimer = (release: () => void) => { armed.add(release); return () => { armed.delete(release); }; };
      const { fake, provider, ended, statuses } = await setup({ idleTimer });
      const session = await provider.createSession("a");
      await fake.setFlag("hold-config", true);
      const changes = async () => (await fake.log()).filter(entry => entry.method === "session/set_config_option").length;
      const before = await changes();
      const prompted = provider.prompt(session.id, { id: "p", text: "Say hello", delivery: "queue", model: { providerId: "antigravity", modelId: "gemini-4-argon" } });
      // The prompt is being prepared: agy holds the model change unanswered.
      let configuring = false;
      for (const deadline = Date.now() + 8_000; !configuring && Date.now() < deadline; await Bun.sleep(5)) {
        configuring = await changes() > before;
      }
      expect(configuring).toBe(true);
      expect(armed.size).toBeGreaterThan(0);
      for (const release of [...armed]) release();
      await fake.setFlag("hold-config", false);
      await prompted;
      await ended(session.id);
      expect(statuses(session.id)).toEqual(["completed"]);
      expect((await fake.log()).filter(entry => entry.method === "initialize")).toHaveLength(1);
    });

    test("a conversation created here is read again, with its transcript's details, after its process is released", async () => {
      const { fake, provider, run, waitFor } = await setup({ idleReleaseMs: 100 });
      const session = await provider.createSession("a");
      const first = await run(session.id, "read: README.md");
      const readTool = async () => (await provider.listMessages(session.id, { limit: 100 })).items.find(item => item.type === "tool" && item.name === "read_file") as Extract<ConversationItem, { type: "tool" }> | undefined;
      expect((await readTool())?.output).toBeUndefined();
      await Bun.write(path.join(fake.stateDirectory, "home", ".gemini", "antigravity-cli", "brain", session.id, ".system_generated", "logs", "transcript.jsonl"), [
        { step_index: 0, type: "USER_INPUT", content: "<USER_REQUEST>\nread: README.md\n</USER_REQUEST>" },
        { step_index: 1, type: "PLANNER_RESPONSE", model: "gemini-4-neon-low", input_tokens: 10, output_tokens: 1, tool_calls: [{ name: "read_file", args: {} }] },
        { step_index: 2, type: "GENERIC", status: "DONE", content: "1: # Fixture workspace" },
      ].map(step => JSON.stringify(step)).join("\n"));
      await waitFor(() => (provider as unknown as { conversations: Map<string, { process?: unknown }> }).conversations.get(session.id)!.process === undefined, "idle release");
      expect((await readTool())?.output).toBe("1: # Fixture workspace");
      const users = (await provider.listMessages(session.id, { limit: 100 })).items.filter(item => item.type === "user_message");
      expect(users.map(item => item.id)).toEqual([`message:${first.messageId}`]);
    });

    test("dispose ends every process it started", async () => {
      const { fake, provider } = await setup();
      await provider.createSession("a");
      await provider.createSession("b");
      expect(await fake.running()).toBeGreaterThanOrEqual(2);
      await provider.dispose();
      expect(await fake.running()).toBe(0);
    });

    for (const stuck of ["hang-initialize", "hang-list"] as const) test(`dispose ends a process stuck in ${stuck === "hang-initialize" ? "initialize" : "session/list"}`, async () => {
      const { fake, provider, waitFor } = await setup();
      await fake.setFlag(stuck, true);
      const listing = provider.listSessions();
      void listing.catch(() => undefined);
      for (let i = 0; i < 400 && !(await fake.log()).some(entry => entry.method === (stuck === "hang-initialize" ? "initialize" : "session/list")); i++) await Bun.sleep(5);
      expect(await fake.running()).toBe(1);
      await provider.dispose();
      expect(await fake.running()).toBe(0);
      await expect(listing).rejects.toThrow();
    });

    for (const stuck of ["hang-initialize", "hang-list"] as const) test(`a listing stuck in ${stuck === "hang-initialize" ? "initialize" : "session/list"} is ended at its deadline, however often it is refreshed`, async () => {
      const { fake, provider } = await setup({ setupDeadlineMs: 600 });
      await fake.setFlag(stuck, true);
      for (let attempt = 0; attempt < 3; attempt++) {
        await expect(provider.listSessions()).rejects.toThrow(`Antigravity did not answer ${stuck === "hang-initialize" ? "initialize" : "session/list"} within`);
        expect(await fake.running()).toBe(0);
      }
    });

    test("a stalled session/new or session/load is ended at its deadline, leaves nothing running, and a retry starts afresh", async () => {
      const { fake, provider, run } = await setup({ setupDeadlineMs: 600 });
      const existing = await provider.createSession("a");
      await run(existing.id, "Say hello");
      await fake.setFlag("hang-new", true);
      await expect(provider.createSession("b")).rejects.toThrow("did not answer session/new");
      await fake.setFlag("hang-new", false);
      const reader = new AntigravityProvider({ workspacePath: fake.workspace, executable: fake.executable, env: fake.env, setupDeadlineMs: 600 });
      cleanups.push(() => reader.dispose());
      await fake.setFlag("hang-load", true);
      await expect(reader.listMessages(existing.id, { limit: 50 })).rejects.toThrow("did not answer session/load");
      await expect(reader.listMessages(existing.id, { limit: 50 })).rejects.toThrow("did not answer session/load");
      expect((await fake.log()).filter(entry => entry.method === "session/load")).toHaveLength(2);
      await provider.dispose();
      expect(await fake.running()).toBe(0);
    });

    test("a crashed leader's process group is reaped", async () => {
      const { fake, provider, ended } = await setup();
      await fake.setFlag("orphan-child", true);
      const session = await provider.createSession("a");
      expect(await fake.orphans()).toBe(1);
      await fake.setFlag("crash-on-prompt", true);
      await provider.prompt(session.id, { id: "x", text: "Go", delivery: "queue" });
      await ended(session.id);
      for (let i = 0; i < 600 && await fake.orphans() > 0; i++) await Bun.sleep(5);
      expect(await fake.orphans()).toBe(0);
    });

    test("shutdown fits inside the Hub's kill deadline", () => {
      // Closing stdin, then the group's SIGTERM, grace and SIGKILL waits.
      expect(STDIN_CLOSE_GRACE_MS + 3 * TERM_GRACE_MS).toBeLessThan(SIGTERM_GRACE_MS);
    });

    test("a crashed process fails its own turn only", async () => {
      const { fake, provider, statuses, ended, run, events } = await setup();
      const healthy = await provider.createSession("healthy");
      const crashing = await provider.createSession("crashing");
      await fake.setFlag("crash-on-prompt", true);
      await provider.prompt(crashing.id, { id: "x", text: "Go", delivery: "queue" });
      await ended(crashing.id);
      expect(statuses(crashing.id)).toEqual(["failed"]);
      const failure = events.flatMap(event => event.updates).findLast(update => update.kind === "status");
      expect(failure).toEqual(expect.objectContaining({ status: "failed", message: expect.stringContaining("Antigravity stopped unexpectedly") }));
      await fake.setFlag("crash-on-prompt", false);
      await run(healthy.id, "Still here");
      expect(statuses(healthy.id)).toEqual(["completed"]);
    });
  });

  describe("listing and history (D10)", () => {
    test("the chooser lists agy's sessions for the workspace with their titles, using a process that exits", async () => {
      const { fake, provider, run } = await setup();
      const session = await provider.createSession("a");
      await run(session.id, "Say hello");
      const listed = await provider.listSessions();
      expect(listed).toEqual([expect.objectContaining({ id: session.id, title: "Single Sentence Reply Request", directory: fake.workspace })]);
      expect(provider.loginState()).toBe("ok");
    });

    test("an unknown id is refused as not found, and no prompt is sent", async () => {
      const { fake, provider, prompts } = await setup();
      await expect(provider.listMessages("00000000-0000-0000-0000-000000000000", { limit: 50 })).rejects.toBeInstanceOf(ConversationNotFoundError);
      await expect(provider.prompt("00000000-0000-0000-0000-000000000000", { id: "x", text: "hi", delivery: "queue" })).rejects.toBeInstanceOf(ConversationNotFoundError);
      expect(await prompts()).toEqual([]);
      // The listing that decided it leaves nothing running.
      expect(await fake.running()).toBe(0);
    });

    test("an id agy no longer lists is refused, not loaded from a stale cache, and leaves the listing", async () => {
      const { fake, provider, run } = await setup();
      const session = await provider.createSession("a");
      await run(session.id, "Say hello");
      const reader = new AntigravityProvider({ workspacePath: fake.workspace, executable: fake.executable, env: fake.env });
      cleanups.push(() => reader.dispose());
      expect((await reader.listSessions()).map(listed => listed.id)).toEqual([session.id]);
      // agy drops the session (deleted elsewhere).
      await writeFile(path.join(fake.stateDirectory, "sessions.json"), "[]");
      await expect(reader.listMessages(session.id, { limit: 50 })).rejects.toBeInstanceOf(ConversationNotFoundError);
      expect((await fake.log()).filter(entry => entry.method === "session/load")).toEqual([]);
      expect(await reader.listSessions()).toEqual([]);
      expect(await reader.getSession(session.id)).toBeNull();
    });

    test("the listing follows agy's pages to the end: a conversation on page 25 is listed and opens, an unlisted id does not", async () => {
      const { fake, provider } = await setup();
      const session = await provider.createSession("a");
      // 24 more sessions, written as agy keeps them, listed one per page.
      const stored = await fake.sessions();
      const filler = Array.from({ length: 24 }, (_, index) => ({ ...stored[0]!, sessionId: `00000000-0000-0000-0000-${String(index).padStart(12, "0")}`, title: `Filler ${index}`, replay: [] }));
      await writeFile(path.join(fake.stateDirectory, "sessions.json"), JSON.stringify([...filler, ...stored]));
      await fake.setFlag("paged-list", true);
      const reader = new AntigravityProvider({ workspacePath: fake.workspace, executable: fake.executable, env: fake.env });
      cleanups.push(() => reader.dispose());
      const listed = (await reader.listSessions()).map(listedSession => listedSession.id);
      expect(listed).toHaveLength(25);
      expect(listed.at(-1)).toBe(session.id);
      expect(await reader.getSession(session.id)).toEqual(expect.objectContaining({ id: session.id }));
      await expect(reader.listMessages("11111111-1111-1111-1111-111111111111", { limit: 50 })).rejects.toBeInstanceOf(ConversationNotFoundError);
    });

    test("a listing that cannot finish fails as unavailable and loads nothing", async () => {
      const { fake, provider } = await setup({ setupDeadlineMs: 600 });
      const session = await provider.createSession("a");
      const reader = new AntigravityProvider({ workspacePath: fake.workspace, executable: fake.executable, env: fake.env, setupDeadlineMs: 600 });
      cleanups.push(() => reader.dispose());
      await fake.setFlag("hang-list", true);
      await expect(reader.listMessages(session.id, { limit: 50 })).rejects.toThrow("did not answer session/list");
      expect((await fake.log()).filter(entry => entry.method === "session/load")).toEqual([]);
    });

    test("a load that fails after part of its replay leaves no partial history behind", async () => {
      const { fake, provider, run } = await setup();
      const session = await provider.createSession("a");
      const first = await run(session.id, "Say hello");
      const second = await run(session.id, "Say hello again");
      const reader = new AntigravityProvider({ workspacePath: fake.workspace, executable: fake.executable, env: fake.env });
      cleanups.push(() => reader.dispose());
      await fake.setFlag("fail-load", true);
      await expect(reader.listMessages(session.id, { limit: 100 })).rejects.toThrow("Failed to load the conversation");
      await fake.setFlag("fail-load", false);
      const users = (await reader.listMessages(session.id, { limit: 100 })).items.filter(item => item.type === "user_message");
      expect(users.map(item => item.id)).toEqual([`message:${first.messageId}`, `message:${second.messageId}`]);
    });

    test("reopened history comes from replay, without starting a turn, with the same user message ids", async () => {
      const first = await setup();
      const session = await first.provider.createSession("a");
      const accepted = await first.provider.prompt(session.id, { id: "p", text: "command: run it", delivery: "queue" });
      const permission = await first.pendingPermission(session.id);
      await first.provider.replyPermission(session.id, permission.requestId, "once", "allow");
      await first.ended(session.id);
      const live = await first.provider.listMessages(session.id, { limit: 100 });
      // A second provider, as after a workspace restart, shares agy's state.
      const second = new AntigravityProvider({ workspacePath: first.fake.workspace, executable: first.fake.executable, env: first.fake.env });
      cleanups.push(() => second.dispose());
      const before = (await first.prompts()).length;
      const page = await second.listMessages(session.id, { limit: 100 });
      expect((await first.prompts()).length).toBe(before);
      const users = page.items.filter(item => item.type === "user_message");
      expect(users.map(item => item.id)).toEqual([`message:${accepted.messageId}`]);
      expect(live.items.some(item => item.id === `message:${accepted.messageId}`)).toBe(true);
      expect(page.items.some(item => item.type === "assistant_message" && item.markdown.includes("echo hi"))).toBe(true);
      expect(page.items.find(item => item.type === "command")).toEqual(expect.objectContaining({ command: "echo hi", status: "completed", exitCode: 0 }));
    }, 20_000);
  });
  describe("timeline and turns (D5)", () => {
    test("a turn streams its reply under one token, closed at the end, with its token usage and context", async () => {
      const { provider, run, upserts, statuses } = await setup();
      const session = await provider.createSession("a");
      await run(session.id, "Say hello");
      const reply = upserts(session.id).findLast(item => item.type === "assistant_message" && item.markdown !== "")!;
      expect(reply).toEqual(expect.objectContaining({ markdown: "Hello, how can I help you today?" }));
      expect((reply as Record<symbol, unknown>)[CHAT_TURN]).toEqual({ completed: true, authority: "provisional" });
      expect(upserts(session.id).find(item => item.id.startsWith("usage:"))).toEqual(expect.objectContaining({
        type: "assistant_message", markdown: "", usage: { input: 8886, output: 32, reasoning: 22, cacheRead: 0, cacheWrite: 0, costUsd: expect.any(Number) },
        model: { providerId: "antigravity", modelId: "gemini-4-neon" },
      }));
      expect(upserts(session.id).findLast(item => item.type === "context_report")).toEqual(expect.objectContaining({ total: 8918, max: 1048576 }));
      expect(statuses(session.id)).toEqual(["completed"]);
    });

    for (const [script, status, message] of [["refuse", "failed", "Antigravity refused to continue."], ["maxtokens", "failed", "Antigravity stopped: the reply reached its token limit."]] as const) {
      test(`a ${script} stop reason fails the turn with a message naming it`, async () => {
        const { provider, run, events } = await setup();
        const session = await provider.createSession("a");
        await run(session.id, `${script}: go`);
        expect(events.flatMap(event => event.updates).findLast(update => update.kind === "status")).toEqual({ kind: "status", status, message });
      });
    }
  });

  describe("permissions (D6)", () => {
    test("allow once runs the tool, with only agy's choices on the card", async () => {
      const { fake, provider, pendingPermission, ended, latest, statuses } = await setup();
      const session = await provider.createSession("a");
      await provider.prompt(session.id, { id: "p", text: "command: run", delivery: "queue" });
      const card = await pendingPermission(session.id);
      expect(card).toEqual(expect.objectContaining({ action: "echo hi", choices: [{ id: "allow", label: "Allow once" }], sourceToolId: "tool:call_command_1" }));
      expect(latest(session.id, "tool:call_command_1")).toEqual(expect.objectContaining({ status: "pending" }));
      expect(await provider.listPermissions()).toEqual([expect.objectContaining({ requestId: card.requestId, conversationId: session.id })]);
      await provider.replyPermission(session.id, card.requestId, "once", "allow");
      await ended(session.id);
      expect((await fake.log()).find(entry => entry.method === "permission-outcome")?.outcome).toEqual({ outcome: "selected", optionId: "allow" });
      expect(latest(session.id, "tool:call_command_1")).toEqual(expect.objectContaining({ status: "completed", output: expect.stringContaining("hi"), exitCode: 0 }));
      expect(statuses(session.id)).toEqual(["completed"]);
    });

    test("a permission without file locations reaches the timeline and can be answered", async () => {
      // The adapter is the only consumer of the provider's events here.
      const fake = await installFakeAgy();
      const provider = new AntigravityProvider({ workspacePath: fake.workspace, executable: fake.executable, env: fake.env });
      const adapter = new ChatAdapter({ provider, workspacePath: fake.workspace });
      cleanups.push(async () => { await adapter.dispose(); await provider.dispose(); await fake.remove(); });
      void adapter.startEventPump().catch(() => undefined);
      const { conversation } = await adapter.createConversation();
      await adapter.prompt(conversation.id, "r1", "command: run");
      const pending = () => adapter.projectionForTests(conversation.id).items().find(item => item.type === "permission" && item.status === "pending") as Extract<ConversationItem, { type: "permission" }> | undefined;
      for (let i = 0; i < 1_000 && !pending(); i++) await Bun.sleep(5);
      const card = pending()!;
      expect(card).toEqual(expect.objectContaining({ action: "echo hi", resources: ["echo hi"] }));
      expect(await adapter.respondPermission(conversation.id, card.requestId, "answer-1", "approved-once", "allow")).toEqual({ outcome: "approved-once" });
    }, 15_000);

    test("deny fails the tool and completes the turn without a reply", async () => {
      const { fake, provider, pendingPermission, ended, latest, statuses } = await setup();
      const session = await provider.createSession("a");
      await provider.prompt(session.id, { id: "p", text: "write: a file", delivery: "queue" });
      const card = await pendingPermission(session.id);
      await provider.replyPermission(session.id, card.requestId, "reject");
      await ended(session.id);
      expect((await fake.log()).find(entry => entry.method === "permission-outcome")?.outcome).toEqual({ outcome: "selected", optionId: "deny" });
      expect(latest(session.id, "tool:call_write_1")).toEqual(expect.objectContaining({ status: "failed" }));
      expect(statuses(session.id)).toEqual(["completed"]);
    });

    test("cancelling while a permission is pending abandons it and interrupts the turn", async () => {
      const { fake, provider, pendingPermission, ended, statuses, upserts, run } = await setup();
      const session = await provider.createSession("a");
      await provider.prompt(session.id, { id: "p", text: "command: run", delivery: "queue" });
      const card = await pendingPermission(session.id);
      await provider.interrupt(session.id);
      await ended(session.id);
      expect(statuses(session.id)).toEqual(["interrupted"]);
      expect(upserts(session.id).findLast(item => item.id === card.id)).toEqual(expect.objectContaining({ status: "resolved", outcome: "rejected" }));
      expect((await fake.log()).find(entry => entry.method === "permission-outcome")?.outcome).toEqual({ outcome: "cancelled" });
      expect(await provider.listPermissions()).toEqual([]);
      await run(session.id, "Accepts a new prompt");
      expect(statuses(session.id)).toEqual(["interrupted", "completed"]);
    });

    test("an unexpected exit drops the conversation's history, so the next read loads it again", async () => {
      const { fake, provider, run } = await setup();
      const session = await provider.createSession("a");
      await run(session.id, "Say hello");
      await provider.listMessages(session.id, { limit: 100 });
      const pids = (await Bun.file(path.join(fake.stateDirectory, "pids")).text()).split("\n").filter(Boolean).map(Number);
      for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
      for (let i = 0; i < 400 && await fake.running() > 0; i++) await Bun.sleep(5);
      for (let i = 0; i < 400 && (provider as unknown as { conversations: Map<string, { seeded: boolean }> }).conversations.get(session.id)!.seeded; i++) await Bun.sleep(5);
      const loadsBefore = (await fake.log()).filter(entry => entry.method === "session/load").length;
      const users = (await provider.listMessages(session.id, { limit: 100 })).items.filter(item => item.type === "user_message");
      expect((await fake.log()).filter(entry => entry.method === "session/load").length).toBe(loadsBefore + 1);
      expect(users).toHaveLength(1);
    });

    test("a permission left open when the process ends is abandoned, and the turn fails in that conversation", async () => {
      const { fake, provider, pendingPermission, ended, statuses, upserts } = await setup();
      const session = await provider.createSession("a");
      await provider.prompt(session.id, { id: "p", text: "command: run", delivery: "queue" });
      const card = await pendingPermission(session.id);
      const pids = (await Bun.file(path.join(fake.stateDirectory, "pids")).text()).split("\n").filter(Boolean).map(Number);
      for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
      await ended(session.id);
      expect(statuses(session.id)).toEqual(["failed"]);
      expect(upserts(session.id).findLast(item => item.id === card.id)).toEqual(expect.objectContaining({ status: "resolved", outcome: "rejected" }));
      expect(await provider.listPermissions()).toEqual([]);
    });

    test("cancel stops a running command and ends the turn as interrupted", async () => {
      const { provider, waitFor, upserts, ended, statuses, latest } = await setup();
      const session = await provider.createSession("a");
      await provider.prompt(session.id, { id: "p", text: "cancel: run long", delivery: "queue" });
      await waitFor(() => upserts(session.id).some(item => item.id === "tool:call_sleep_1"), "the running command");
      await provider.interrupt(session.id);
      await ended(session.id);
      expect(statuses(session.id)).toEqual(["interrupted"]);
      expect(latest(session.id, "tool:call_sleep_1")).toEqual(expect.objectContaining({ status: "failed" }));
    });
  });

  describe("models, modes and commands (D7, D8)", () => {
    test("models carry thinking levels as variants, and modes and commands follow agy", async () => {
      const { provider } = await setup();
      await provider.createSession("a");
      expect(await provider.listModels()).toEqual([
        expect.objectContaining({ selection: { providerId: "antigravity", modelId: "gemini-4-neon" }, name: "Gemini 4 Neon", variants: ["low", "medium", "high", "xhigh"], default: true, imageInput: true }),
        expect.objectContaining({ selection: { providerId: "antigravity", modelId: "gemini-4-argon" }, variants: ["low", "medium", "high"] }),
        expect.not.objectContaining({ variants: expect.anything() }),
        expect.not.objectContaining({ variants: expect.anything() }),
      ]);
      expect((await provider.listModes()).map(mode => mode.name)).toEqual(["default", "accept-edits", "plan"]);
      // agy sends its commands in an update after `session/new` answers.
      const names = async () => (await provider.listCommands()).map(command => command.name);
      for (let i = 0; i < 1_600 && (await names()).length === 0; i++) await Bun.sleep(5);
      expect(await names()).toEqual(["compact", "goal", "plan"]);
    });

    test("a resumed conversation's prompt runs on its chosen model, thinking level and mode", async () => {
      const { fake, provider, run, waitFor } = await setup({ idleReleaseMs: 100 });
      const session = await provider.createSession("a");
      await provider.switchModel(session.id, { providerId: "antigravity", modelId: "gemini-4-argon" }, "low");
      await run(session.id, "First", { mode: "plan" });
      await waitFor(() => (provider as unknown as { conversations: Map<string, { process?: unknown }> }).conversations.get(session.id)!.process === undefined, "idle release");
      await run(session.id, "After the release");
      const log = await fake.log();
      const afterLoad = log.slice(log.findIndex(entry => entry.method === "session/load"));
      expect(afterLoad.filter(entry => entry.method === "session/set_config_option").map(entry => [entry.params!.configId, entry.params!.value])).toEqual([["model", "gemini-4-argon"], ["thought_level", "low"]]);
      expect(afterLoad.find(entry => entry.method === "session/set_mode")?.params).toEqual(expect.objectContaining({ modeId: "plan" }));
      expect((await fake.sessions())[0]).toEqual(expect.objectContaining({ model: "gemini-4-argon", thoughtLevel: "low", mode: "plan" }));
      expect(await provider.getConversationConfiguration(session.id)).toEqual({ model: { providerId: "antigravity", modelId: "gemini-4-argon" }, variant: "low", mode: "plan" });
    });

    test("with only legacy model ids, a chosen model and level are applied by selecting the legacy id", async () => {
      const { fake, provider, run } = await setup();
      await fake.setFlag("legacy-only", true);
      const session = await provider.createSession("a");
      expect((await provider.listModels()).find(model => model.selection.modelId === "gemini-4-argon")?.variants).toEqual(["low", "medium", "high"]);
      // A level-looking id with no sibling, priced as itself, stays itself.
      expect((await provider.listModels()).map(model => model.selection.modelId)).toContain("gpt-oss-120b-medium");
      await provider.switchModel(session.id, { providerId: "antigravity", modelId: "gemini-4-argon" }, "low");
      await run(session.id, "Say hello");
      const log = await fake.log();
      expect(log.filter(entry => entry.method === "session/set_model").map(entry => entry.params!.modelId)).toEqual(["gemini-4-argon-low"]);
      expect(log.filter(entry => entry.method === "session/set_config_option")).toEqual([]);
      expect((await fake.sessions())[0]).toEqual(expect.objectContaining({ model: "gemini-4-argon", thoughtLevel: "low" }));
    });

    test("without legacy ids, the thinking levels config options advertise are offered for the current model", async () => {
      const { fake, provider } = await setup();
      await fake.setFlag("no-legacy-models", true);
      await provider.createSession("a");
      expect((await provider.listModels()).find(model => model.selection.modelId === "gemini-4-neon")?.variants).toEqual(["low", "medium", "high", "xhigh"]);
    });

    test("after switching models through config options, the new model's levels appear and the chosen level is applied", async () => {
      const { fake, provider, run } = await setup();
      await fake.setFlag("no-legacy-models", true);
      const session = await provider.createSession("a");
      expect((await provider.listModels()).find(model => model.selection.modelId === "gemini-4-argon")?.variants).toBeUndefined();
      await provider.switchModel(session.id, { providerId: "antigravity", modelId: "gemini-4-argon" }, "low");
      await run(session.id, "Say hello");
      expect((await provider.listModels()).find(model => model.selection.modelId === "gemini-4-argon")?.variants).toEqual(["low", "medium", "high"]);
      expect((await fake.log()).filter(entry => entry.method === "session/set_config_option").map(entry => [entry.params!.configId, entry.params!.value])).toEqual([["model", "gemini-4-argon"], ["thought_level", "low"]]);
      expect((await fake.sessions())[0]).toEqual(expect.objectContaining({ model: "gemini-4-argon", thoughtLevel: "low" }));
    });

    test("a model change that lands before a later setting fails is kept, so switching back sends the model again", async () => {
      const { fake, provider, run } = await setup();
      const session = await provider.createSession("a");
      await fake.setFlag("fail-thought-level", true);
      await expect(provider.prompt(session.id, { id: "p1", text: "Say hello", delivery: "queue", model: { providerId: "antigravity", modelId: "gemini-4-argon" }, variant: "low" })).rejects.toThrow("Failed to set the thinking level");
      expect((await fake.sessions()).find(entry => entry.sessionId === session.id)?.model).toBe("gemini-4-argon");
      await fake.setFlag("fail-thought-level", false);
      const modelChanges = async () => (await fake.log()).filter(entry => entry.method === "session/set_config_option" && entry.params?.configId === "model").map(entry => entry.params!.value);
      await run(session.id, "Say hello", { model: { providerId: "antigravity", modelId: "gemini-4-neon" } });
      expect(await modelChanges()).toEqual(["gemini-4-argon", "gemini-4-neon"]);
      expect((await fake.sessions()).find(entry => entry.sessionId === session.id)?.model).toBe("gemini-4-neon");
    });

    test("thinking levels learned for one model survive a load that advertises another", async () => {
      const { fake, provider, run } = await setup();
      await fake.setFlag("no-legacy-models", true);
      const session = await provider.createSession("a");
      await provider.switchModel(session.id, { providerId: "antigravity", modelId: "gemini-4-argon" }, "low");
      await run(session.id, "Say hello");
      // Another session starts on agy's default model, advertising only its levels.
      await provider.createSession("b");
      const variants = async (modelId: string) => (await provider.listModels()).find(model => model.selection.modelId === modelId)?.variants;
      expect(await variants("gemini-4-neon")).toEqual(["low", "medium", "high", "xhigh"]);
      expect(await variants("gemini-4-argon")).toEqual(["low", "medium", "high"]);
    });

    test("a variant the model does not offer is refused", async () => {
      const { provider } = await setup();
      const session = await provider.createSession("a");
      await expect(provider.switchModel(session.id, { providerId: "antigravity", modelId: "gemini-pro-orchestrator-neon" }, "high")).rejects.toThrow("does not offer");
    });

    test("a command is sent to agy as the prompt text", async () => {
      const { provider, ended, prompts } = await setup();
      const session = await provider.createSession("a");
      await provider.command(session.id, { id: "c", name: "compact", arguments: "keep the plan" });
      await ended(session.id);
      expect((await prompts())[0]!.params!.prompt).toEqual([{ type: "text", text: "/compact keep the plan" }]);
    });
  });

  describe("immediate steering (D9)", () => {
    test("a steer joins the running turn: one turn end, the earlier prompt's end is silent, and reload shows each message once", async () => {
      const { fake, provider, waitFor, upserts, statuses, ended, events, prompts } = await setup();
      const session = await provider.createSession("a");
      const first = await provider.prompt(session.id, { id: "p", text: "steer: run it", delivery: "queue" });
      await waitFor(() => upserts(session.id).some(item => item.id === "tool:call_steer_1"), "the running command");
      const sent = await provider.prompt(session.id, { id: "s", text: "Also write BANANA", delivery: "steer" }) as { confirmation: Promise<SteerConfirmation> };
      const steer = await sent.confirmation as Extract<SteerConfirmation, { outcome: "accepted" }>;
      await ended(session.id);
      // The earlier prompt ended before the steer was accepted, so every
      // status this turn will publish is in by now.
      expect(statuses(session.id)).toEqual(["completed"]);
      expect(events.flatMap(event => event.notificationTurns ?? []).map(turn => turn.phase)).toEqual(["started", "completed"]);
      expect(upserts(session.id).filter(item => item.id === `message:${steer.messageId}`)).toHaveLength(1);
      // Both prompts' tokens are the one turn's.
      expect(upserts(session.id).find(item => item.id.startsWith("usage:"))).toEqual(expect.objectContaining({ usage: expect.objectContaining({ input: 8897 + 2350, output: 130 + 84 }) }));
      expect((await prompts()).map(entry => (entry.params!.prompt as Array<{ text: string }>)[0]!.text)).toEqual(["steer: run it", "Also write BANANA"]);
      const reread = new AntigravityProvider({ workspacePath: fake.workspace, executable: fake.executable, env: fake.env });
      cleanups.push(() => reread.dispose());
      const users = (await reread.listMessages(session.id, { limit: 100 })).items.filter(item => item.type === "user_message");
      expect(users.map(item => item.id)).toEqual([`message:${first.messageId}`, `message:${steer.messageId}`]);
      // The steer sits at the same position among messages and tools as it did live.
      const order = (items: ConversationItem[]) => items.filter(item => item.type === "user_message" || item.type === "command" || item.type === "assistant_message" && item.markdown !== "").map(item => item.id);
      const live = order((await provider.listMessages(session.id, { limit: 100 })).items);
      expect(live).toEqual([`message:${first.messageId}`, "tool:call_steer_1", `message:${steer.messageId}`, expect.stringMatching(/\.a2\.1$/)]);
      expect(order((await reread.listMessages(session.id, { limit: 100 })).items)).toEqual(live);
    });

    test("a steer is answered at once as sent, and confirmed with its row only once agy answers it", async () => {
      const { provider, waitFor, upserts, ended } = await setup();
      const session = await provider.createSession("a");
      await provider.prompt(session.id, { id: "p", text: "steer: run it", delivery: "queue" });
      await waitFor(() => upserts(session.id).some(item => item.id === "tool:call_steer_1"), "the running command");
      const users = async () => (await provider.listMessages(session.id, { limit: 100 })).items.filter(item => item.type === "user_message").map(item => item.id);
      const before = await users();
      const sent = await provider.prompt(session.id, { id: "s", text: "Steer", delivery: "steer" }) as Awaited<ReturnType<AntigravityProvider["prompt"]>> & { confirmation: Promise<SteerConfirmation> };
      // Sent, not confirmed: no row yet.
      expect(await users()).toEqual(before);
      const confirmation = await sent.confirmation;
      expect(confirmation).toEqual({ outcome: "accepted", messageId: expect.stringMatching(/\.u2$/), createdAt: sent.createdAt });
      expect(await users()).toEqual([...before, `message:${(confirmation as { messageId: string }).messageId}`]);
      await ended(session.id);
    });

    test("a second steer can be sent while the first awaits confirmation, and both are confirmed in order", async () => {
      const { provider, waitFor, upserts, ended, statuses, prompts } = await setup();
      const session = await provider.createSession("a");
      const first = await provider.prompt(session.id, { id: "p", text: "steer: run it", delivery: "queue" });
      await waitFor(() => upserts(session.id).some(item => item.id === "tool:call_steer_1"), "the running command");
      const one = await provider.prompt(session.id, { id: "s1", text: "One", delivery: "steer" }) as { messageId: string; confirmation: Promise<SteerConfirmation> };
      const two = await provider.prompt(session.id, { id: "s2", text: "Two", delivery: "steer" }) as { messageId: string; confirmation: Promise<SteerConfirmation> };
      const accepted = [await one.confirmation, await two.confirmation] as Array<Extract<SteerConfirmation, { outcome: "accepted" }>>;
      expect(accepted.map(confirmation => confirmation.outcome)).toEqual(["accepted", "accepted"]);
      await ended(session.id);
      expect(statuses(session.id)).toEqual(["completed"]);
      expect((await prompts()).map(entry => (entry.params!.prompt as Array<{ text: string }>)[0]!.text)).toEqual(["steer: run it", "One", "Two"]);
      const users = (await provider.listMessages(session.id, { limit: 100 })).items.filter(item => item.type === "user_message").map(item => item.id);
      expect(users).toEqual([`message:${first.messageId}`, ...accepted.map(confirmation => `message:${confirmation.messageId}`)]);
    });

    test("a steer agy refuses settles as refused with its reason, publishes no row, and leaves the turn running to its end", async () => {
      const { fake, provider, waitFor, upserts, statuses, ended } = await setup();
      const session = await provider.createSession("a");
      await provider.prompt(session.id, { id: "p", text: "cancel: run long", delivery: "queue" });
      await waitFor(() => upserts(session.id).some(item => item.id === "tool:call_sleep_1"), "the running command");
      await fake.setFlag("refuse-steer", true);
      const sent = await provider.prompt(session.id, { id: "s", text: "Steer", delivery: "steer" }) as { confirmation: Promise<SteerConfirmation> };
      expect(await sent.confirmation).toEqual({ outcome: "refused", reason: "Antigravity is busy and did not take the message" });
      expect(upserts(session.id).filter(item => item.type === "user_message" && item.text === "Steer")).toEqual([]);
      expect(statuses(session.id)).toEqual([]);
      await provider.interrupt(session.id);
      await ended(session.id);
      expect(statuses(session.id)).toEqual(["interrupted"]);
    });

    test("a steer refused after a second was sent leaves the second's ids as replay numbers them", async () => {
      const { fake, provider, waitFor, upserts, ended } = await setup();
      const session = await provider.createSession("a");
      await provider.prompt(session.id, { id: "p", text: "steer: run it", delivery: "queue" });
      await waitFor(() => upserts(session.id).some(item => item.id === "tool:call_steer_1"), "the running command");
      await fake.setFlag("refuse-next-steer", true);
      const one = await provider.prompt(session.id, { id: "s1", text: "One", delivery: "steer" }) as { confirmation: Promise<SteerConfirmation> };
      const two = await provider.prompt(session.id, { id: "s2", text: "Two", delivery: "steer" }) as { confirmation: Promise<SteerConfirmation> };
      expect((await one.confirmation).outcome).toBe("refused");
      expect((await two.confirmation).outcome).toBe("accepted");
      await ended(session.id);
      const order = (items: ConversationItem[]) => items.filter(item => item.type === "user_message" || item.type === "command" || item.type === "assistant_message" && item.markdown !== "").map(item => item.id);
      const live = order((await provider.listMessages(session.id, { limit: 100 })).items);
      const reread = new AntigravityProvider({ workspacePath: fake.workspace, executable: fake.executable, env: fake.env });
      cleanups.push(() => reread.dispose());
      expect(order((await reread.listMessages(session.id, { limit: 100 })).items)).toEqual(live);
      expect(live.filter(id => id.startsWith("message:") && /\.u\d+$/.test(id)).map(id => id.match(/\.u(\d+)$/)![1])).toEqual(["1", "2"]);
    });

    test("a steer agy refuses leaves the running reply where it was, so what follows extends it", async () => {
      const { fake, provider, waitFor, upserts, ended } = await setup();
      const session = await provider.createSession("a");
      await provider.prompt(session.id, { id: "p", text: "pause: greet", delivery: "queue" });
      await waitFor(() => upserts(session.id).some(item => item.type === "assistant_message" && item.markdown === "Hello, "), "the reply's start");
      await fake.setFlag("refuse-steer", true);
      const sent = await provider.prompt(session.id, { id: "s", text: "Steer", delivery: "steer" }) as { confirmation: Promise<SteerConfirmation> };
      expect((await sent.confirmation).outcome).toBe("refused");
      await ended(session.id);
      const replies = (await provider.listMessages(session.id, { limit: 100 })).items.flatMap(item => item.type === "assistant_message" && item.markdown ? [[item.id, item.markdown]] : []);
      expect(replies).toEqual([[expect.stringMatching(/\.a1\.1$/), "Hello, world"]]);
    });

    test("an earlier prompt that ends just before agy refuses the steer is not taken as acceptance, and its own end is reported", async () => {
      const { fake, provider, waitFor, upserts, statuses, ended, events } = await setup();
      const session = await provider.createSession("a");
      await provider.prompt(session.id, { id: "p", text: "cancel: run long", delivery: "queue" });
      await waitFor(() => upserts(session.id).some(item => item.id === "tool:call_sleep_1"), "the running command");
      await fake.setFlag("end-then-refuse-steer", true);
      const sent = await provider.prompt(session.id, { id: "s", text: "Steer", delivery: "steer" }) as { confirmation: Promise<SteerConfirmation> };
      expect((await sent.confirmation).outcome).toBe("refused");
      await ended(session.id);
      expect(statuses(session.id)).toEqual(["failed"]);
      expect(events.flatMap(event => event.updates).findLast(update => update.kind === "status")).toEqual(expect.objectContaining({ message: "Antigravity stopped: the reply reached its token limit." }));
      expect(upserts(session.id).filter(item => item.type === "user_message" && item.text === "Steer")).toEqual([]);
    });

    test("Stop after a steer ends the whole turn as interrupted, never as the superseded prompt's completion", async () => {
      const { provider, waitFor, upserts, statuses, ended } = await setup();
      const session = await provider.createSession("a");
      await provider.prompt(session.id, { id: "p", text: "cancel: run long", delivery: "queue" });
      await waitFor(() => upserts(session.id).some(item => item.id === "tool:call_sleep_1"), "the running command");
      // agy ends the earlier prompt with `end_turn` as the steer arrives.
      const sent = await provider.prompt(session.id, { id: "s", text: "Steer", delivery: "steer" });
      await provider.interrupt(session.id);
      await ended(session.id);
      expect(statuses(session.id)).toEqual(["interrupted"]);
      expect(await sent.confirmation).toEqual({ outcome: "unknown" });
    });

    test("a steer whose process ends before agy answers has an unknown outcome", async () => {
      const { fake, provider, waitFor, upserts } = await setup();
      const session = await provider.createSession("a");
      await provider.prompt(session.id, { id: "p", text: "cancel: run long", delivery: "queue" });
      await waitFor(() => upserts(session.id).some(item => item.id === "tool:call_sleep_1"), "the running command");
      await fake.setFlag("crash-on-steer", true);
      const sent = await provider.prompt(session.id, { id: "s", text: "Steer", delivery: "steer" }) as { confirmation: Promise<SteerConfirmation> };
      expect(await sent.confirmation).toEqual({ outcome: "unknown" });
      expect(upserts(session.id).filter(item => item.type === "user_message" && item.text === "Steer")).toEqual([]);
    });

    test("a steer with no running turn is refused", async () => {
      const { provider } = await setup();
      const session = await provider.createSession("a");
      await expect(provider.prompt(session.id, { id: "s", text: "steer", delivery: "steer" })).rejects.toThrow("nothing to steer");
    });
  });

  describe("attachments (D8)", () => {
    test("images are declared and sent as image blocks when agy advertises them", async () => {
      const { fake, provider, ended, prompts } = await setup();
      const session = await provider.createSession("a");
      expect(provider.describe().capabilities).toContain("attachments");
      const image = path.join(fake.workspace, "pixel.png");
      await writeFile(image, new Uint8Array([137, 80, 78, 71]));
      await provider.prompt(session.id, { id: "p", text: "Look", delivery: "queue", attachments: [{ id: "att-1", name: "pixel.png", mimeType: "image/png", absolutePath: image }] });
      await ended(session.id);
      expect((await prompts())[0]!.params!.prompt).toEqual([{ type: "text", text: "Look" }, { type: "image", mimeType: "image/png", data: Buffer.from([137, 80, 78, 71]).toString("base64") }]);
    });

    test("an image-only message keeps its id after reload, and so do the messages after it", async () => {
      const { fake, provider, run } = await setup();
      const session = await provider.createSession("a");
      const image = path.join(fake.workspace, "pixel.png");
      await writeFile(image, new Uint8Array([137, 80, 78, 71]));
      const pictured = await run(session.id, "", { attachments: [{ id: "att-1", name: "pixel.png", mimeType: "image/png", absolutePath: image }] });
      const after = await run(session.id, "And this");
      const reread = new AntigravityProvider({ workspacePath: fake.workspace, executable: fake.executable, env: fake.env });
      cleanups.push(() => reread.dispose());
      const users = (await reread.listMessages(session.id, { limit: 100 })).items.filter(item => item.type === "user_message");
      expect(users.map(item => item.id)).toEqual([`message:${pictured.messageId}`, `message:${after.messageId}`]);
      expect(users[0]).toEqual(expect.objectContaining({ attachments: [{ name: "image", mimeType: "image/png" }] }));
    });

    test("attachments are not declared when agy does not advertise image prompts", async () => {
      const { fake, provider } = await setup();
      await fake.setFlag("no-image", true);
      await provider.createSession("a");
      expect(provider.describe().capabilities).not.toContain("attachments");
      expect((await provider.listModels())[0]).not.toHaveProperty("imageInput");
    });
  });

  describe("login (D3)", () => {
    test("an authentication error is the login-missing state; a later listing clears it", async () => {
      const { fake, provider } = await setup();
      expect(provider.loginState()).toBe("unknown");
      await fake.setFlag("auth-missing", true);
      expect(await provider.listSessions()).toEqual([]);
      expect(provider.loginState()).toBe("missing");
      // Creation is refused with a typed login error that says how to log in.
      const creation = provider.createSession("a");
      await expect(creation).rejects.toBeInstanceOf(AgentLoginRequiredError);
      await expect(creation).rejects.toThrow("Antigravity is not logged in. Run agy where UatuCode runs and sign in.");
      await fake.setFlag("auth-missing", false);
      await provider.listSessions();
      expect(provider.loginState()).toBe("ok");
    });

    test("once agy's login is back, a conversation read while logged out loads afresh, not from the process it had", async () => {
      const { fake, provider, run } = await setup();
      const session = await provider.createSession("a");
      const first = await run(session.id, "Say hello");
      const loads = async () => (await fake.log()).filter(entry => entry.method === "session/load").length;
      await fake.setFlag("auth-missing", true);
      await provider.listSessions();
      // No transcript: the logged-out read has nothing to show.
      await expect(provider.listMessages(session.id, { limit: 100 })).rejects.toBeInstanceOf(AgentLoginRequiredError);
      await fake.setFlag("auth-missing", false);
      await provider.listSessions();
      const before = await loads();
      const users = (await provider.listMessages(session.id, { limit: 100 })).items.filter(item => item.type === "user_message");
      expect(users.map(item => item.id)).toEqual([`message:${first.messageId}`]);
      expect(await loads()).toBe(before + 1);
    });

    test("logged out during a turn, a read shows the transcript alone and leaves the turn's own rows streaming", async () => {
      const { fake, provider, waitFor, upserts, ended } = await setup();
      const session = await provider.createSession("a");
      await Bun.write(path.join(fake.stateDirectory, "home", ".gemini", "antigravity-cli", "brain", session.id, ".system_generated", "logs", "transcript.jsonl"), [
        { step_index: 0, type: "USER_INPUT", content: "<USER_REQUEST>\nEarlier words\n</USER_REQUEST>" },
        { step_index: 1, type: "PLANNER_RESPONSE", model: "gemini-4-neon-low", content: "An earlier answer", input_tokens: 10, output_tokens: 1 },
      ].map(step => JSON.stringify(step)).join("\n"));
      await provider.prompt(session.id, { id: "p", text: "pause: greet", delivery: "queue" });
      await waitFor(() => upserts(session.id).some(item => item.type === "assistant_message" && item.markdown === "Hello, "), "the reply's start");
      await fake.setFlag("auth-missing", true);
      await provider.listSessions();
      const texts = (items: ConversationItem[]) => items.flatMap(item => item.type === "user_message" ? [item.text] : item.type === "assistant_message" && item.markdown ? [item.markdown] : []);
      expect(texts((await provider.listMessages(session.id, { limit: 100 })).items)).toEqual(["Earlier words", "An earlier answer"]);
      // The running turn's rows were kept: with the login back, they are what a read shows.
      await fake.setFlag("auth-missing", false);
      await provider.listSessions();
      expect(texts((await provider.listMessages(session.id, { limit: 100 })).items)).toEqual(["pause: greet", "Hello, "]);
      await provider.interrupt(session.id);
      await ended(session.id);
    });

    test("a resumed prompt whose load agy refuses for its login shows the login notice", async () => {
      const { fake, provider, run, upserts, waitFor } = await setup({ idleReleaseMs: 50 });
      const session = await provider.createSession("a");
      await run(session.id, "Say hello");
      await waitFor(() => (provider as unknown as { conversations: Map<string, { process?: unknown }> }).conversations.get(session.id)!.process === undefined, "idle release");
      await fake.setFlag("auth-missing", true);
      await expect(provider.prompt(session.id, { id: "p2", text: "Again", delivery: "queue" })).rejects.toThrow("Authentication required");
      await waitFor(() => upserts(session.id).some(item => item.type === "notice"), "the login notice");
      expect(upserts(session.id).find(item => item.type === "notice")).toEqual(expect.objectContaining({ level: "error", code: "login-failed", message: "Authentication required" }));
      expect(provider.loginState()).toBe("missing");
    });

    test("a turn rejected for its login fails as a login failure, and the next prompt rechecks the login", async () => {
      const { fake, provider, ended, upserts, events, run } = await setup();
      const session = await provider.createSession("a");
      await fake.setFlag("auth-missing", true);
      await provider.prompt(session.id, { id: "p", text: "Hello", delivery: "queue" });
      await ended(session.id);
      expect(upserts(session.id).find(item => item.type === "notice")).toEqual(expect.objectContaining({ level: "error", code: "login-failed", message: "Authentication required" }));
      expect(events.flatMap(event => event.updates).findLast(update => update.kind === "status")).toEqual(expect.objectContaining({ status: "failed" }));
      expect(provider.loginState()).toBe("missing");
      await fake.setFlag("auth-missing", false);
      await run(session.id, "Signed in now");
      expect(provider.loginState()).toBe("ok");
    });
  });
  describe("the chat service", () => {
    test("reports agy's login state and picks up a login made outside UatuCode", async () => {
      const fake = await installFakeAgy();
      const service = new LazyChatService({
        workspacePath: fake.workspace, agentName: "Antigravity",
        attachmentStore: { directory: fake.stateDirectory, save: async () => { throw new Error("unused"); }, resolve: async () => null } as never,
        runtime: pathAgentRuntime(new AntigravityRuntime({ workspacePath: fake.workspace, env: fake.env }), executable => new AntigravityProvider({ workspacePath: fake.workspace, executable, env: fake.env })),
      });
      cleanups.push(async () => { await service.dispose(); await fake.remove(); });
      expect(await service.retry()).toEqual(expect.objectContaining({ state: "ready", version: "1.5.13" }));
      await fake.setFlag("auth-missing", true);
      expect(await service.listConversations()).toEqual([]);
      expect(await service.status()).toEqual(expect.objectContaining({ state: "ready", login: "missing" }));
      await fake.setFlag("auth-missing", false);
      await service.listConversations();
      expect(await service.status()).toEqual(expect.objectContaining({ state: "ready", login: "ok" }));
    });
  });
  describe("cost (D11)", () => {
    const prices: AntigravityPriceTable = { source: "test", snapshot: "2026-11-24", models: { "gemini-4-neon": { input: 1, output: 10, cacheRead: 0.1, from: "test" } }, families: {} };
    const carriers = (upserts: (id: string) => ConversationItem[], sessionId: string) => upserts(sessionId).filter(item => item.id.startsWith("usage:")) as Array<Extract<ConversationItem, { type: "assistant_message" }>>;

    test("each turn is priced into its usage, at the same rate whatever the thinking level", async () => {
      const { provider, run, upserts } = await setup({ prices });
      const session = await provider.createSession("a");
      await provider.switchModel(session.id, { providerId: "antigravity", modelId: "gemini-4-neon" }, "low");
      await run(session.id, "Say hello");
      await provider.switchModel(session.id, { providerId: "antigravity", modelId: "gemini-4-neon" }, "xhigh");
      await run(session.id, "Say hello again");
      const [low, high] = carriers(upserts, session.id);
      // 8886 input and 32 output tokens (thinking inside output), no cached reads.
      expect(low!.usage!.costUsd).toBeCloseTo((8886 * 1 + 32 * 10) / 1_000_000, 12);
      expect(high!.usage!.costUsd).toBe(low!.usage!.costUsd!);
    });

    test("when agy reports no usage, the turn's tokens come from its transcript, once", async () => {
      const { fake, provider, run, upserts, waitFor } = await setup({ prices });
      const session = await provider.createSession("a");
      await fake.setFlag("no-usage", true);
      const file = path.join(fake.stateDirectory, "home", ".gemini", "antigravity-cli", "brain", session.id, ".system_generated", "logs", "transcript.jsonl");
      await Bun.write(file, [
        { step_index: 0, type: "USER_INPUT", content: "<USER_REQUEST>\nSay hello\n</USER_REQUEST>" },
        { step_index: 1, type: "PLANNER_RESPONSE", model: "gemini-4-neon-low", input_tokens: 1000, output_tokens: 100, cache_read_tokens: 0, content: "Hello" },
      ].map(step => JSON.stringify(step)).join("\n"));
      await run(session.id, "Say hello");
      await waitFor(() => carriers(upserts, session.id).length > 0, "the transcript's usage");
      expect(carriers(upserts, session.id)).toEqual([expect.objectContaining({ usage: { input: 1000, output: 100, cacheRead: 0, costUsd: (1000 + 1000) / 1_000_000 }, model: { providerId: "antigravity", modelId: "gemini-4-neon" } })]);
      // With ACP's usage present, the transcript is not consulted as well.
      await fake.setFlag("no-usage", false);
      await run(session.id, "Again");
      expect(carriers(upserts, session.id).map(item => item.usage?.input)).toEqual([1000, 8886]);
    });

    test("without ACP usage, a steered turn's tokens cover every input it carried", async () => {
      const { fake, provider, upserts, waitFor, ended } = await setup({ prices });
      const session = await provider.createSession("a");
      await fake.setFlag("no-usage", true);
      await Bun.write(path.join(fake.stateDirectory, "home", ".gemini", "antigravity-cli", "brain", session.id, ".system_generated", "logs", "transcript.jsonl"), [
        { step_index: 0, type: "USER_INPUT", content: "<USER_REQUEST>\nsteer: run it\n</USER_REQUEST>" },
        { step_index: 1, type: "PLANNER_RESPONSE", model: "gemini-4-neon-low", input_tokens: 1000, output_tokens: 100, cache_read_tokens: 0 },
        { step_index: 2, type: "USER_INPUT", content: "<USER_REQUEST>\nAlso this\n</USER_REQUEST>" },
        { step_index: 3, type: "PLANNER_RESPONSE", model: "gemini-4-neon-low", input_tokens: 500, output_tokens: 50, cache_read_tokens: 200 },
      ].map(step => JSON.stringify(step)).join("\n"));
      await provider.prompt(session.id, { id: "p", text: "steer: run it", delivery: "queue" });
      await waitFor(() => upserts(session.id).some(item => item.id === "tool:call_steer_1"), "the running command");
      const sent = await provider.prompt(session.id, { id: "s", text: "Also this", delivery: "steer" });
      expect((await sent.confirmation)?.outcome).toBe("accepted");
      await ended(session.id);
      await waitFor(() => carriers(upserts, session.id).length > 0, "the transcript's usage");
      expect(carriers(upserts, session.id)[0]!.usage).toEqual(expect.objectContaining({ input: 1500, output: 150, cacheRead: 200 }));
    });

    test("a turn on an unpriced model has no cost", async () => {
      const { provider, run, upserts } = await setup({ prices });
      const session = await provider.createSession("a");
      await provider.switchModel(session.id, { providerId: "antigravity", modelId: "gemini-4-argon" });
      await run(session.id, "Say hello");
      expect(carriers(upserts, session.id)[0]!.usage).not.toHaveProperty("costUsd");
    });
  });
});
