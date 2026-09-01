import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { NormalizedProviderEvent } from "../provider";
import { ClaudeProvider } from "./provider";
import { ClaudeRuntime } from "./runtime";

// Opt-in only: this spends real tokens against the developer's own
// authenticated `claude` install. Run with UATU_REAL_CLAUDE=1.
const enabled = process.env.UATU_REAL_CLAUDE === "1";
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe.skipIf(!enabled)("real Claude Code integration", () => {
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

    const provider = new ClaudeProvider({ workspacePath: workspace, executable: executable! });
    const events: NormalizedProviderEvent[] = [];
    const abort = new AbortController();
    void (async () => {
      for await (const event of provider.events(abort.signal)) events.push(event);
    })();

    try {
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

      // Native storage now serves the same history without a live turn.
      await provider.dispose();
      const reread = new ClaudeProvider({ workspacePath: workspace, executable: executable! });
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
