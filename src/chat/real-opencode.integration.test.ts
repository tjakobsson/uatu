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
});
