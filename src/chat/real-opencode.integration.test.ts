import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { OpenCodeService } from "./opencode-service";
import { LazyOpenCodeChatService } from "./service";

const enabled = process.env.UATU_REAL_OPENCODE === "1";
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe.skipIf(!enabled)("real OpenCode integration", () => {
  test("starts an isolated SDK service and normalizes a cancellable session", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "uatu-real-opencode-"));
    temporaryRoots.push(root);
    const workspace = path.join(root, "workspace");
    const configDirectory = path.join(root, "config");
    const dataDirectory = path.join(root, "data");
    await Promise.all([mkdir(workspace), mkdir(configDirectory), mkdir(dataDirectory)]);
    await writeFile(path.join(workspace, "README.md"), "# Isolated OpenCode smoke\n", "utf8");
    const configPath = path.join(configDirectory, "opencode.json");
    await writeFile(configPath, process.env.UATU_REAL_OPENCODE_CONFIG_CONTENT ?? JSON.stringify({ autoupdate: false, share: "disabled" }), "utf8");

    const runtime = new OpenCodeService({
      workspacePath: workspace,
      env: {
        ...process.env,
        HOME: root,
        XDG_CONFIG_HOME: configDirectory,
        XDG_DATA_HOME: dataDirectory,
        OPENCODE_CONFIG: configPath,
        OPENCODE_CONFIG_DIR: configDirectory,
      },
    });
    const service = new LazyOpenCodeChatService({ workspacePath: workspace, runtime });
    let endpoint = "";
    try {
      const status = await service.status();
      expect(status.state).toBe("ready");
      endpoint = runtime.currentConnection()!.endpoint;

      const created = await service.createConversation();
      expect(created.items).toEqual([]);
      expect((await service.listConversations()).map(item => item.id)).toContain(created.conversation.id);
      const stream = await service.subscribe(created.conversation.id, { cursor: created.cursor });
      const event = stream.events[Symbol.asyncIterator]();
      const accepted = await service.prompt(created.conversation.id, crypto.randomUUID(), "Reply slowly with the word smoke.");
      expect(accepted.messageId).toBeTruthy();
      expect((await event.next()).value).toMatchObject({ conversationId: created.conversation.id });
      expect((await service.history(created.conversation.id)).conversation.id).toBe(created.conversation.id);
      expect(await service.cancel(created.conversation.id, crypto.randomUUID())).toEqual({ cancelled: true });
      stream.events.cancel();
    } finally {
      await service.dispose();
    }

    expect(runtime.currentConnection()).toBeNull();
    if (endpoint) await expect(fetch(`${endpoint}/global/health`)).rejects.toThrow();
  }, 60_000);

  test("recovers persisted configuration through a fresh provider and adapter", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "uatu-real-opencode-configuration-"));
    temporaryRoots.push(root);
    const workspace = path.join(root, "workspace");
    const configDirectory = path.join(root, "config");
    const dataDirectory = path.join(root, "data");
    await Promise.all([mkdir(workspace), mkdir(configDirectory), mkdir(dataDirectory)]);
    await writeFile(path.join(workspace, "README.md"), "# Isolated OpenCode configuration smoke\n", "utf8");
    const configPath = path.join(configDirectory, "opencode.json");
    await writeFile(configPath, process.env.UATU_REAL_OPENCODE_CONFIG_CONTENT ?? JSON.stringify({ autoupdate: false, share: "disabled" }), "utf8");

    const runtime = new OpenCodeService({
      workspacePath: workspace,
      env: {
        ...process.env,
        HOME: root,
        XDG_CONFIG_HOME: configDirectory,
        XDG_DATA_HOME: dataDirectory,
        OPENCODE_CONFIG: configPath,
        OPENCODE_CONFIG_DIR: configDirectory,
      },
    });
    const writer = new LazyOpenCodeChatService({ workspacePath: workspace, runtime });
    let reader: LazyOpenCodeChatService | undefined;
    try {
      expect((await writer.status()).state).toBe("ready");
      const [models, modes] = await Promise.all([writer.models(), writer.modes()]);
      const model = models.find(candidate => candidate.variants?.length) ?? models[0];
      const mode = modes[0];
      expect(model).toBeDefined();
      expect(mode).toBeDefined();
      const variant = model!.variants?.[0];
      const expected = {
        model: model!.selection,
        mode: mode!.name,
        ...(variant ? { variant } : {}),
      };

      const created = await writer.createConversation();
      const accepted = await writer.prompt(
        created.conversation.id,
        crypto.randomUUID(),
        "Reply slowly with the word configuration.",
        model!.selection,
        mode!.name,
        variant,
      );
      expect(accepted.configuration).toEqual(expected);

      // This service constructs another provider and adapter against the same
      // running server. The first adapter's accepted-configuration cache is
      // unreachable, so the snapshot must recover from OpenCode's records.
      reader = new LazyOpenCodeChatService({ workspacePath: workspace, runtime });
      expect((await reader.status()).state).toBe("ready");
      const deadline = Date.now() + 15_000;
      let recovered = (await reader.history(created.conversation.id)).configuration;
      while (Date.now() < deadline && JSON.stringify(recovered) !== JSON.stringify(expected)) {
        await Bun.sleep(250);
        recovered = (await reader.history(created.conversation.id)).configuration;
      }
      expect(recovered).toEqual(expected);
      await reader.cancel(created.conversation.id, crypto.randomUUID());
    } finally {
      await Promise.all([writer.dispose(), reader?.dispose()]);
    }
  }, 60_000);

  /**
   * The one thing a fake cannot answer: whether OpenCode's live
   * `message.updated` (which carries the message's tokens but no part) reliably
   * arrives after a first text part. If it does, usage decorates the streamed
   * bubble; if it does not, the early-arrival buffer is what saves it. Either
   * way the assertions below must hold — and crucially, no usage-only bubble
   * may appear on the timeline, which is what a wrong answer would produce.
   *
   * Runs a real turn against a real provider, so it costs a model call.
   */
  test("a completed turn reports token usage on an assistant part, and mints no bubble for it", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "uatu-real-opencode-usage-"));
    temporaryRoots.push(root);
    const workspace = path.join(root, "workspace");
    const configDirectory = path.join(root, "config");
    const dataDirectory = path.join(root, "data");
    await Promise.all([mkdir(workspace), mkdir(configDirectory), mkdir(dataDirectory)]);
    await writeFile(path.join(workspace, "README.md"), "# Isolated OpenCode usage smoke\n", "utf8");
    const configPath = path.join(configDirectory, "opencode.json");
    await writeFile(configPath, process.env.UATU_REAL_OPENCODE_CONFIG_CONTENT ?? JSON.stringify({ autoupdate: false, share: "disabled" }), "utf8");

    const runtime = new OpenCodeService({
      workspacePath: workspace,
      env: {
        ...process.env,
        HOME: root,
        XDG_CONFIG_HOME: configDirectory,
        XDG_DATA_HOME: dataDirectory,
        OPENCODE_CONFIG: configPath,
        OPENCODE_CONFIG_DIR: configDirectory,
      },
    });
    const service = new LazyOpenCodeChatService({ workspacePath: workspace, runtime });
    try {
      expect((await service.status()).state).toBe("ready");
      const created = await service.createConversation();
      await service.prompt(created.conversation.id, crypto.randomUUID(), "Reply with the single word: smoke.");

      // Poll the history rather than the stream: the assertion is about what a
      // client sees when it opens the conversation, which is the authoritative
      // path the design leans on.
      const deadline = Date.now() + 90_000;
      let items = (await service.history(created.conversation.id)).items;
      while (Date.now() < deadline && !items.some(item => item.type === "assistant_message" && item.usage)) {
        await Bun.sleep(500);
        items = (await service.history(created.conversation.id)).items;
      }

      const withUsage = items.filter(item => item.type === "assistant_message" && item.usage);
      expect(withUsage.length).toBeGreaterThan(0);
      const usage = withUsage.at(-1)!.type === "assistant_message" ? (withUsage.at(-1) as { usage?: Record<string, number> }).usage! : {};
      // Occupancy has to be a real figure, or the indicator would read 0%.
      expect((usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0)).toBeGreaterThan(0);
      // Usage decorates a part that says something; it never becomes a bubble
      // of its own.
      for (const item of withUsage) expect(item.type === "assistant_message" && item.markdown.length).toBeGreaterThan(0);
    } finally {
      await service.dispose();
    }
  }, 120_000);
});
