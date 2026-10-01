import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { query } from "@anthropic-ai/claude-agent-sdk";

import type { NormalizedProviderEvent } from "../provider";
import { stripWindowMarker } from "./models";
import { ClaudeProvider } from "./provider";
import { ClaudeRuntime } from "./runtime";
import { claudeConfigDir, claudeProjectDir } from "./transcript";

// Opt-in only: this spends real tokens against the developer's own
// authenticated `claude` install. Run with UATU_REAL_CLAUDE=1.
const enabled = process.env.UATU_REAL_CLAUDE === "1";
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe.skipIf(!enabled)("real Claude Code integration", () => {
  test("a usage read in a workspace without a conversation lists no session afterwards", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "uatu-real-claude-usage-"));
    temporaryRoots.push(root);
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);
    const runtime = new ClaudeRuntime({ workspacePath: workspace });
    const availability = await runtime.ensure();
    if (availability.state !== "ready") return;
    const provider = new ClaudeProvider({ workspacePath: workspace, executable: runtime.executablePath()!, stateFile: path.join(root, "uatu-state.json") });
    try {
      expect(await provider.listSessions()).toEqual([]);
      const result = await provider.readUsage("start");
      expect(result.report).not.toBeNull();
      expect(result.report?.conversationId).toBeUndefined();
      expect(await provider.listSessions()).toEqual([]);
      expect(await provider.usageReport()).toEqual(result.report!);
    } finally {
      await provider.dispose();
    }
  }, 60_000);

  test("every offered model carries the window Claude Code states, read without touching settings or writing a transcript", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "uatu-real-claude-windows-"));
    temporaryRoots.push(root);
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);
    const runtime = new ClaudeRuntime({ workspacePath: workspace });
    const availability = await runtime.ensure();
    if (availability.state !== "ready") return;
    const executable = runtime.executablePath()!;
    const settingsPath = path.join(claudeConfigDir(), "settings.json");
    const settingsBefore = existsSync(settingsPath) ? readFileSync(settingsPath) : null;
    const projectDir = claudeProjectDir(workspace);
    const transcripts = () => (existsSync(projectDir) ? readdirSync(projectDir).filter(name => name.endsWith(".jsonl")) : []);

    const provider = new ClaudeProvider({ workspacePath: workspace, executable, stateFile: path.join(root, "uatu-state.json") });
    let served;
    try {
      const started = performance.now();
      const first = await provider.listModels();
      const firstMs = Math.round(performance.now() - started);
      // The first read carries what the default runs; the windows land behind it.
      expect(first.find(model => model.default)?.resolvesTo).toBeTruthy();
      await provider.windowsSettled();
      served = await provider.listModels();
      console.log(`[evidence] first model list: ${firstMs} ms; window walk settled after ${Math.round(performance.now() - started)} ms for ${served.length} models`);
    } finally {
      await provider.dispose();
    }

    // Nothing persisted: the user's settings are byte-identical and the
    // promptless probe left no transcript to enumerate.
    const settingsAfter = existsSync(settingsPath) ? readFileSync(settingsPath) : null;
    expect(settingsAfter === null ? null : Buffer.compare(settingsAfter, settingsBefore!)).toBe(settingsBefore === null ? null : 0);
    expect(transcripts()).toEqual([]);

    // What Claude Code states directly, asked the same way on a session of
    // our own: the served figures must be exactly these.
    let release!: () => void;
    const hold = new Promise<void>(resolve => (release = resolve));
    async function* idle() { await hold; }
    const direct = query({ prompt: idle() as never, options: { cwd: workspace, pathToClaudeCodeExecutable: executable } });
    try {
      const unpinned = await direct.getContextUsage({ detail: "summary" });
      const entry = served.find(model => model.default)!;
      expect(entry.contextLimit).toBe(unpinned.maxTokens);
      const runs = served.find(model => model.selection.modelId === entry.resolvesTo?.modelId);
      const runsId = runs ? (runs.resolvesTo?.modelId ?? runs.selection.modelId) : entry.resolvesTo?.modelId;
      expect(stripWindowMarker(runsId!)).toBe(stripWindowMarker(unpinned.model));
      for (const model of served) {
        if (model.default) continue;
        await direct.setModel(model.selection.modelId);
        const answer = await direct.getContextUsage({ detail: "summary" });
        if (stripWindowMarker(answer.model) !== stripWindowMarker(model.resolvesTo?.modelId ?? model.selection.modelId)) continue;
        expect(model.contextLimit).toBeGreaterThan(0);
        expect({ id: model.selection.modelId, window: model.contextLimit }).toEqual({ id: model.selection.modelId, window: answer.maxTokens });
      }
    } finally {
      release();
      await direct.return?.(undefined).catch(() => undefined);
      runtime.dispose();
    }
  }, 120_000);

  test("probes the install, runs a session round trip, and reads it back from native storage", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "uatu-real-claude-"));
    temporaryRoots.push(root);
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);

    // The runtime probe is the availability authority: discovery + version.
    const runtime = new ClaudeRuntime({ workspacePath: workspace });
    const availability = await runtime.ensure();
    expect(availability.state).toBe("ready");
    if (availability.state !== "ready") return;
    expect(availability.version).toMatch(/^\d+\.\d+\.\d+/);
    const executable = runtime.executablePath();
    expect(executable).toBeTruthy();

    const provider = new ClaudeProvider({ workspacePath: workspace, executable: executable!, stateFile: path.join(root, "uatu-state.json") });
    const events: NormalizedProviderEvent[] = [];
    const abort = new AbortController();
    void (async () => {
      for await (const event of provider.events(abort.signal)) events.push(event);
    })();

    try {
      // The default the picker presents, read before any turn.
      const presentedDefault = (await provider.listModels()).find(model => model.default)?.resolvesTo?.modelId;
      const session = await provider.createSession("suggestion");
      await provider.prompt(session.id, {
        id: "real-1",
        text: 'Reply with exactly the word "pong" and nothing else. Do not use any tools.',
        delivery: "queue",
      });
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        if (events.some(event => event.updates.some(update => update.kind === "status" && update.status === "completed"))) break;
        await Bun.sleep(250);
      }
      const upserts = events.flatMap(event => event.updates)
        .filter(update => update.kind === "upsert")
        .map(update => (update as { item: { type: string; markdown?: string } }).item);
      expect(upserts.some(item => item.type === "assistant_message" && item.markdown?.includes("pong"))).toBe(true);
      // The turn's accounting arrived attributed to a model.
      expect(events.some(event => event.assistantUsage !== undefined)).toBe(true);
      // No model was chosen: the session ran the default, and init named the
      // very model the picker presented it as before the turn.
      const ran = events.find(event => event.configuration?.model)?.configuration?.model?.modelId;
      expect(ran).toBeTruthy();
      expect(presentedDefault).toBe(ran);

      // Native storage now serves the same history without a live turn.
      await provider.dispose();
      const reread = new ClaudeProvider({ workspacePath: workspace, executable: executable!, stateFile: path.join(root, "uatu-state.json") });
      const sessions = await reread.listSessions();
      expect(sessions.map(entry => entry.id)).toContain(session.id);
      const page = await reread.listMessages(session.id, { limit: 50 });
      expect(page.items.some(item => item.type === "assistant_message" && (item as { markdown?: string }).markdown?.includes("pong"))).toBe(true);
      await reread.dispose();
    } finally {
      abort.abort();
      await provider.dispose().catch(() => undefined);
      runtime.dispose();
    }
  }, 180_000);
});
