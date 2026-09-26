import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { OpenCodeService, type OpenCodeGeneration } from "./opencode-service";
import { LazyChatService } from "../service";
import { describeToolDetail } from "../tool-detail";

/**
 * Runs the same assertions against a real OpenCode of each generation.
 *
 *   UATU_REAL_OPENCODE=1                       the gate
 *   UATU_REAL_OPENCODE_V1=/path/to/opencode    a 1.x binary
 *   UATU_REAL_OPENCODE_V2=/path/to/opencode    a 2.x binary
 *
 * Each binary named is linked as `opencode` into a temporary `bin/` that is
 * put first on the child's PATH — discovery stays PATH-based, and neither
 * binary has to be installed on the machine's PATH. With neither named, the
 * `opencode` on PATH runs, as before. Every run gets its own HOME and XDG
 * roots: 2.x with default paths would open — and migrate — the developer's
 * 1.x database.
 */
const enabled = process.env.UATU_REAL_OPENCODE === "1";
const temporaryRoots: string[] = [];

type Generation = { label: string; binary?: string; expected?: OpenCodeGeneration };

function generations(): Generation[] {
  const named: Generation[] = [];
  if (process.env.UATU_REAL_OPENCODE_V1) named.push({ label: "1.x", binary: process.env.UATU_REAL_OPENCODE_V1, expected: 1 });
  if (process.env.UATU_REAL_OPENCODE_V2) named.push({ label: "2.x", binary: process.env.UATU_REAL_OPENCODE_V2, expected: 2 });
  return named.length > 0 ? named : [{ label: "PATH" }];
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function isolated(prefix: string, generation: Generation, readme: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(root);
  const workspace = path.join(root, "workspace");
  const configDirectory = path.join(root, "config");
  const dataDirectory = path.join(root, "data");
  const stateDirectory = path.join(root, "state");
  const cacheDirectory = path.join(root, "cache");
  const binDirectory = path.join(root, "bin");
  await Promise.all([workspace, configDirectory, dataDirectory, stateDirectory, cacheDirectory, binDirectory].map(directory => mkdir(directory)));
  await writeFile(path.join(workspace, "README.md"), readme, "utf8");
  const configPath = path.join(configDirectory, "opencode.json");
  await writeFile(configPath, process.env.UATU_REAL_OPENCODE_CONFIG_CONTENT ?? JSON.stringify({ autoupdate: false, share: "disabled" }), "utf8");
  if (generation.binary) await symlink(generation.binary, path.join(binDirectory, "opencode"));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...(generation.binary ? { PATH: `${binDirectory}${path.delimiter}${process.env.PATH ?? ""}` } : {}),
    HOME: root,
    XDG_CONFIG_HOME: configDirectory,
    XDG_DATA_HOME: dataDirectory,
    XDG_STATE_HOME: stateDirectory,
    XDG_CACHE_HOME: cacheDirectory,
    OPENCODE_CONFIG: configPath,
    OPENCODE_CONFIG_DIR: configDirectory,
  };
  const runtime = new OpenCodeService({ workspacePath: workspace, env });
  return { workspace, runtime };
}

async function expectReady(service: LazyChatService, runtime: OpenCodeService, generation: Generation): Promise<void> {
  const status = await service.status();
  expect(status.state).toBe("ready");
  const connection = runtime.currentConnection();
  expect(connection).not.toBeNull();
  if (generation.expected !== undefined) {
    expect(connection?.generation).toBe(generation.expected);
    expect(status.state === "ready" && status.version.split(".")[0]).toBe(String(generation.expected));
  }
}

for (const generation of generations()) {
  describe.skipIf(!enabled)(`real OpenCode ${generation.label} integration`, () => {
    test("starts an isolated service, decides its generation, and normalizes a cancellable session", async () => {
      const { workspace, runtime } = await isolated("uatu-real-opencode-", generation, "# Isolated OpenCode smoke\n");
      const service = new LazyChatService({ workspacePath: workspace, runtime });
      let endpoint = "";
      try {
        // Conversation-scoped need starts the runtime; status alone does not.
        await service.listConversations();
        await expectReady(service, runtime, generation);
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
      const { workspace, runtime } = await isolated("uatu-real-opencode-configuration-", generation, "# Isolated OpenCode configuration smoke\n");
      const writer = new LazyChatService({ workspacePath: workspace, runtime });
      let reader: LazyChatService | undefined;
      try {
        await writer.listConversations();
        await expectReady(writer, runtime, generation);
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
        reader = new LazyChatService({ workspacePath: workspace, runtime });
        await reader.listConversations();
        await expectReady(reader, runtime, generation);
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
     * The one thing a fake cannot answer: whether the live usage report (1.x:
     * `message.updated`, which carries the message's tokens but no part; 2.x:
     * `session.step.ended`) reliably arrives after a first text part. If it
     * does, usage decorates the streamed bubble; if it does not, the
     * early-arrival buffer is what saves it. Either way the assertions below
     * must hold — and crucially, no usage-only bubble may appear on the
     * timeline: usage lives on a text part or on the hidden `usage:<id>`
     * carrier, never on a wordless item of any other identity.
     *
     * Runs a real turn against a real provider, so it costs a model call.
     */
    test("a completed turn reports token usage on an assistant part, and mints no bubble for it", async () => {
      const { workspace, runtime } = await isolated("uatu-real-opencode-usage-", generation, "# Isolated OpenCode usage smoke\n");
      const service = new LazyChatService({ workspacePath: workspace, runtime });
      try {
        await service.listConversations();
        await expectReady(service, runtime, generation);
        const created = await service.createConversation();
        await service.prompt(created.conversation.id, crypto.randomUUID(), "Reply with the single word: smoke.");

        // Poll the history rather than the stream: the assertion is about what a
        // client sees when it opens the conversation, which is the authoritative
        // path the design leans on. 1.x restates a message's usage from zero
        // as the turn runs, so the wait is for a real figure, not for the
        // first carrier.
        const occupancy = (usage: Record<string, number>) => (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
        const reported = (items: Awaited<ReturnType<typeof service.history>>["items"]) =>
          items.filter(item => item.type === "assistant_message" && item.usage && occupancy(item.usage as Record<string, number>) > 0);
        const deadline = Date.now() + 90_000;
        let items = (await service.history(created.conversation.id)).items;
        while (Date.now() < deadline && reported(items).length === 0) {
          await Bun.sleep(500);
          items = (await service.history(created.conversation.id)).items;
        }

        // Occupancy has to be a real figure, or the indicator would read 0%.
        expect(reported(items).length).toBeGreaterThan(0);
        const withUsage = items.filter(item => item.type === "assistant_message" && item.usage);
        // Usage rides either the part that says something or the message's
        // own `usage:<id>` carrier — an empty-markdown item the renderer never
        // draws (see the Chat surface table in ARCHITECTURE.md). Anything else
        // with usage and no words would be a bubble of its own.
        for (const item of withUsage) {
          if (item.type !== "assistant_message") continue;
          expect(item.markdown.length > 0 || item.id.startsWith("usage:")).toBe(true);
        }
      } finally {
        await service.dispose();
      }
    }, 120_000);

    /**
     * Each generation launches subagents with its own tool — 1.x `task`, 2.x
     * `subagent` — with its own input and report envelope. The row has to
     * read as an agent launch that names its child, and the child has to open
     * as a transcript of its own, or the subagents view has nothing to show.
     *
     * Runs a real turn that spawns a subagent, so it costs model calls, and a
     * model that declines to delegate fails it.
     */
    test("a subagent launch reads as an agent row whose child opens as a transcript", async () => {
      const { workspace, runtime } = await isolated("uatu-real-opencode-subagent-", generation, "# Isolated OpenCode subagent smoke\n");
      const service = new LazyChatService({ workspacePath: workspace, runtime });
      try {
        await service.listConversations();
        await expectReady(service, runtime, generation);
        const created = await service.createConversation();
        await service.prompt(
          created.conversation.id,
          crypto.randomUUID(),
          "Delegate this to the `general` subagent with your subagent/task tool, with the prompt: 'List the files in the current directory and report their names.' Then reply with one sentence.",
        );

        const launched = (items: Awaited<ReturnType<typeof service.history>>["items"]) =>
          items.find(item => item.type === "tool" && item.status === "completed" && item.childConversationId !== undefined);
        const deadline = Date.now() + 150_000;
        let row = launched((await service.history(created.conversation.id)).items);
        while (Date.now() < deadline && row === undefined) {
          await Bun.sleep(1_000);
          row = launched((await service.history(created.conversation.id)).items);
        }

        expect(row).toBeDefined();
        if (row?.type !== "tool") throw new Error("no completed subagent launch");
        const detail = describeToolDetail(row);
        expect(detail).toMatchObject({ kind: "agent", subagent: "general", conversationId: row.childConversationId });
        if (detail.kind === "agent") expect(detail.result ?? "").toContain("README.md");
        const child = await service.history(row.childConversationId!);
        expect(child.items.some(item => item.type === "user_message")).toBe(true);
        // A subagent's transcript is reachable from its row, never listed as
        // a conversation of its own.
        expect((await service.listConversations()).map(item => item.id)).not.toContain(row.childConversationId);
      } finally {
        await service.dispose();
      }
    }, 180_000);
  });
}
