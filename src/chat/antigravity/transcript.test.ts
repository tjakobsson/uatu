import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { installFakeAgy, type FakeAgy } from "../../../tests/fixtures/antigravity/fake-agy-path";
import { conversationTotals } from "../conversation-totals";
import { AgentLoginRequiredError, type NormalizedProviderEvent } from "../provider";
import type { ConversationItem } from "../types";
import type { AntigravityPriceTable } from "./pricing";
import { AntigravityProvider } from "./provider";
import { enrichReplay, readSessionTranscript, readTranscript, transcriptModelFamily, transcriptPath, transcriptTurns } from "./transcript";

// One conversation recorded through the fake agy (text, a read, a denied
// write), reopened by fresh providers with different transcripts on disk.
// The transcript fixture describes that conversation as agy writes it.

const FIXTURE = path.join(import.meta.dir, "../../../tests/fixtures/antigravity/transcript.jsonl");
const prices: AntigravityPriceTable = { source: "test", snapshot: "2026-11-24", models: { "gemini-4-neon": { input: 1, output: 10, cacheRead: 0.1, from: "test" } }, families: {} };

let fake: FakeAgy;
let sessionId: string;
let home: string;

beforeAll(async () => {
  fake = await installFakeAgy();
  home = path.join(fake.stateDirectory, "home");
  const provider = new AntigravityProvider({ workspacePath: fake.workspace, executable: fake.executable, env: fake.env, homeDirectory: home });
  const events: NormalizedProviderEvent[] = [];
  const controller = new AbortController();
  void (async () => { for await (const event of provider.events(controller.signal)) events.push(event); })();
  const ends = () => events.flatMap(event => event.updates).filter(update => update.kind === "status").length;
  const waitFor = async (predicate: () => boolean) => { for (let i = 0; i < 1_600 && !predicate(); i++) await Bun.sleep(5); if (!predicate()) throw new Error("timed out"); };
  try {
    sessionId = (await provider.createSession("a")).id;
    for (const [index, text] of ["Say hello", "read: README.md", "write: a file"].entries()) {
      await provider.prompt(sessionId, { id: `p${index}`, text, delivery: "queue" });
      if (text.startsWith("write:")) {
        await waitFor(() => events.some(event => event.updates.some(update => update.kind === "upsert" && update.item.type === "permission")));
        const card = events.flatMap(event => event.updates).find(update => update.kind === "upsert" && update.item.type === "permission")!;
        await provider.replyPermission(sessionId, (card as { item: { requestId: string } }).item.requestId, "reject");
      }
      await waitFor(() => ends() === index + 1);
    }
  } finally { controller.abort(); await provider.dispose(); }
});

afterAll(async () => { await fake.remove(); });

async function placeTranscript(contents?: string): Promise<string> {
  const file = transcriptPath(home, sessionId);
  await mkdir(path.dirname(file), { recursive: true });
  if (contents === undefined) await copyFile(FIXTURE, file);
  else await writeFile(file, contents);
  return file;
}

async function reopen(): Promise<ConversationItem[]> {
  const provider = new AntigravityProvider({ workspacePath: fake.workspace, executable: fake.executable, env: fake.env, homeDirectory: home, prices });
  try { return (await provider.listMessages(sessionId, { limit: 500 })).items; }
  finally { await provider.dispose(); }
}

const tool = (items: ConversationItem[], name: string) => items.find(item => item.type === "tool" && item.name === name) as Extract<ConversationItem, { type: "tool" }> | undefined;
const carriers = (items: ConversationItem[]) => items.filter(item => item.id.startsWith("usage:")) as Array<Extract<ConversationItem, { type: "assistant_message" }>>;

describe.skipIf(process.platform === "win32")("transcript enrichment (D10)", () => {
  test("a recognized transcript adds file-read output, the permission outcome and each turn's tokens, model and cost", async () => {
    await placeTranscript();
    const items = await reopen();
    expect(tool(items, "read_file")?.output).toBe("Showing lines 1-1 of 1\n1: # Fixture workspace");
    expect(tool(items, "write_file")).toEqual(expect.objectContaining({ status: "failed", error: 'permission check failed for write_file "hello.txt"' }));
    expect(carriers(items).map(item => [item.id, item.usage?.input, item.usage?.output, item.usage?.cacheRead, item.model?.modelId])).toEqual([
      [`usage:${sessionId}.t1`, 8886, 32, 0, "gemini-4-neon"],
      [`usage:${sessionId}.t2`, 2169 + 2313, 141 + 95, 6829 + 6949, "gemini-4-neon"],
      [`usage:${sessionId}.t3`, 2154, 120, 8001, "gemini-4-neon"],
    ]);
    // Each carrier follows its own turn.
    const ids = items.map(item => item.id);
    expect(ids.indexOf(`usage:${sessionId}.t1`)).toBeLessThan(ids.findIndex(id => id === `message:${sessionId}.u2`));
    // Earlier turns' cost is there before any new turn.
    expect(carriers(items)[0]!.usage!.costUsd).toBeCloseTo((8886 + 320) / 1_000_000, 12);
    expect(conversationTotals(items)?.costUsd).toBeGreaterThan(0);
  });

  for (const [name, contents] of [
    ["missing", null],
    ["truncated", async () => { const full = await readFile(FIXTURE, "utf8"); return full.slice(0, full.length - 40); }],
    ["foreign", async () => (await readFile(FIXTURE, "utf8")).split("\n").slice(0, 2).join("\n")],
    // Another conversation with the same shape: as many turns and tools, other words.
    ["foreign with the same counts", async () => (await readFile(FIXTURE, "utf8")).replace("Say hello", "Say goodbye").replace("read: README.md", "read: NOTES.md").replace("write: a file", "write: another file")],
    ["unrecognized", async () => '{"role":"user","text":"hi"}\n'],
  ] as const) {
    test(`a ${name} transcript leaves the replayed history as it is, without an error`, async () => {
      const file = transcriptPath(home, sessionId);
      await Bun.$`rm -f ${file}`.quiet();
      if (contents) await placeTranscript(await contents());
      const items = await reopen();
      expect(carriers(items)).toEqual([]);
      expect(tool(items, "read_file")?.output).toBeUndefined();
      expect(tool(items, "write_file")).toEqual(expect.objectContaining({ status: "failed" }));
      expect(tool(items, "write_file")?.error).toBeUndefined();
      expect(items.filter(item => item.type === "user_message")).toHaveLength(3);
    });
  }

  test("a listed conversation stays readable from its transcript after agy's login expires", async () => {
    await placeTranscript();
    const provider = new AntigravityProvider({ workspacePath: fake.workspace, executable: fake.executable, env: fake.env, homeDirectory: home, prices });
    try {
      expect((await provider.listSessions()).map(session => session.id)).toContain(sessionId);
      await fake.setFlag("auth-missing", true);
      const items = (await provider.listMessages(sessionId, { limit: 500 })).items;
      expect(items.filter(item => item.type === "user_message").map(item => [item.id, item.type === "user_message" && item.text])).toEqual([
        [`message:${sessionId}.u1`, "Say hello"], [`message:${sessionId}.u2`, "read: README.md"], [`message:${sessionId}.u3`, "write: a file"],
      ]);
      expect(items.some(item => item.type === "assistant_message" && item.markdown === "The README describes a small fixture workspace.")).toBe(true);
      expect(tool(items, "read_file")?.output).toBe("Showing lines 1-1 of 1\n1: # Fixture workspace");
      expect(tool(items, "write_file")).toEqual(expect.objectContaining({ status: "failed", error: 'permission check failed for write_file "hello.txt"' }));
      expect(carriers(items)).toHaveLength(3);
      expect(provider.loginState()).toBe("missing");
    } finally { await fake.setFlag("auth-missing", false); await provider.dispose(); }
  });

  test("a read that first finds agy's login expired, with no transcript to read, says how to sign in", async () => {
    await rm(transcriptPath(home, sessionId), { force: true });
    const provider = new AntigravityProvider({ workspacePath: fake.workspace, executable: fake.executable, env: fake.env, homeDirectory: home, prices });
    try {
      expect((await provider.listSessions()).map(session => session.id)).toContain(sessionId);
      await fake.setFlag("auth-missing", true);
      const read = provider.listMessages(sessionId, { limit: 500 });
      await expect(read).rejects.toBeInstanceOf(AgentLoginRequiredError);
      await expect(read).rejects.toThrow("Run agy where UatuCode runs and sign in.");
      expect(provider.loginState()).toBe("missing");
    } finally { await fake.setFlag("auth-missing", false); await provider.dispose(); }
  });

  test("a turn whose words differ from the recording keeps its replayed rows; the others are enriched", async () => {
    await placeTranscript((await readFile(FIXTURE, "utf8")).replace("read: README.md", "read: NOTES.md"));
    const items = await reopen();
    expect(tool(items, "read_file")?.output).toBeUndefined();
    expect(tool(items, "write_file")?.error).toBe('permission check failed for write_file "hello.txt"');
    expect(carriers(items).map(item => item.id)).toEqual([`usage:${sessionId}.t1`, `usage:${sessionId}.t3`]);
  });

  test.skipIf(process.platform === "win32")("a transcript path that is not a regular file is skipped without waiting on it", async () => {
    // A pipe with no writer would block an ordinary open forever.
    const fifo = path.join(home, "no-writer.jsonl");
    await Bun.$`mkfifo ${fifo}`;
    const started = Date.now();
    expect(await readTranscript(fifo)).toEqual({ skipped: "unreadable" });
    expect(Date.now() - started).toBeLessThan(1_000);
  }, 5_000);

  test("while logged out every read comes from the transcript alone, never from replay read earlier, and not at all once it is gone", async () => {
    const file = await placeTranscript();
    const provider = new AntigravityProvider({ workspacePath: fake.workspace, executable: fake.executable, env: fake.env, homeDirectory: home, prices });
    try {
      const signedIn = (await provider.listMessages(sessionId, { limit: 500 })).items;
      expect(signedIn.some(item => item.id === "tool:call_read_1")).toBe(true);
      await fake.setFlag("auth-missing", true);
      await provider.listSessions();
      expect(provider.loginState()).toBe("missing");
      const loggedOut = (await provider.listMessages(sessionId, { limit: 500 })).items;
      expect(loggedOut.some(item => item.id === "tool:call_read_1")).toBe(false);
      expect(loggedOut.some(item => item.id.includes(".transcript."))).toBe(true);
      await Bun.$`rm -f ${file}`.quiet();
      await expect(provider.listMessages(sessionId, { limit: 500 })).rejects.toThrow("Antigravity is not logged in");
    } finally { await fake.setFlag("auth-missing", false); await provider.dispose(); }
  });

  test("reading the transcript leaves it byte-identical", async () => {
    const file = await placeTranscript();
    const digest = async () => createHash("sha256").update(await readFile(file)).digest("hex");
    const before = { digest: await digest(), mtime: (await stat(file)).mtimeMs };
    await reopen();
    expect({ digest: await digest(), mtime: (await stat(file)).mtimeMs }).toEqual(before);
  });

  test("a recorded model id is read as its family unless it is a model of its own", () => {
    expect(transcriptModelFamily("gemini-4-neon-low", () => false)).toBe("gemini-4-neon");
    expect(transcriptModelFamily("gpt-oss-120b-medium", id => id === "gpt-oss-120b-medium")).toBe("gpt-oss-120b-medium");
  });

  test("an id that could leave agy's brain directory reads no transcript", async () => {
    for (const id of ["../outside", "a/b", "..", ".hidden"]) expect(await readSessionTranscript(home, id)).toEqual({ skipped: "missing" });
    expect("steps" in await readSessionTranscript(home, sessionId)).toBe(true);
  });

  test("an oversized or unreadable transcript is skipped", async () => {
    expect(await readTranscript(path.join(home, "nowhere.jsonl"))).toEqual({ skipped: "missing" });
    expect(await readTranscript(home)).toEqual({ skipped: "unreadable" });
    expect(await readTranscript(FIXTURE, 100)).toEqual({ skipped: "too-large" });
    const read = await readTranscript(FIXTURE);
    expect("steps" in read && transcriptTurns(read.steps).map(turn => turn.tools.length)).toEqual([0, 1, 1]);
  });

  // Last: it prompts the shared conversation, which changes its history.
  test("after a transcript-only read, the next successful load replaces that history with agy's replay", async () => {
    await placeTranscript();
    const provider = new AntigravityProvider({ workspacePath: fake.workspace, executable: fake.executable, env: fake.env, homeDirectory: home, prices });
    try {
      await provider.listSessions();
      await fake.setFlag("auth-missing", true);
      const loggedOut = (await provider.listMessages(sessionId, { limit: 500 })).items;
      expect(loggedOut.some(item => item.id.includes(".transcript."))).toBe(true);
      await fake.setFlag("auth-missing", false);
      const accepted = await provider.prompt(sessionId, { id: "again", text: "Say hello again", delivery: "queue" });
      const items = (await provider.listMessages(sessionId, { limit: 500 })).items;
      expect(items.some(item => item.id.includes(".transcript."))).toBe(false);
      expect(items.some(item => item.id === "tool:call_read_1")).toBe(true);
      expect(items.filter(item => item.type === "user_message").map(item => item.id).at(-1)).toBe(`message:${accepted.messageId}`);
    } finally { await fake.setFlag("auth-missing", false); await provider.dispose(); }
  });
});

test("an image-only turn keeps its recorded tokens and cost on reopen, matched to the wordless request at its position", async () => {
  const steps = [
    { step_index: 0, type: "USER_INPUT", content: "<USER_REQUEST>\nSay hello\n</USER_REQUEST>" },
    { step_index: 1, type: "PLANNER_RESPONSE", model: "gemini-4-neon-low", content: "Hello", input_tokens: 10, output_tokens: 1 },
    { step_index: 2, type: "USER_INPUT", content: "<USER_REQUEST>\n\n</USER_REQUEST>" },
    { step_index: 3, type: "PLANNER_RESPONSE", model: "gemini-4-neon-low", content: "A chart", input_tokens: 500, output_tokens: 20 },
  ];
  const replayed: ConversationItem[] = [
    { id: "message:s.u1", type: "user_message", createdAt: 1, text: "Say hello" },
    { id: "message:s.a1.1", type: "assistant_message", createdAt: 2, markdown: "Hello" },
    { id: "message:s.u2", type: "user_message", createdAt: 3, text: "", attachments: [{ id: "image", name: "chart.png", mimeType: "image/png" }] },
    { id: "message:s.a2.1", type: "assistant_message", createdAt: 4, markdown: "A chart" },
  ];
  const file = path.join(home, "image-only.jsonl");
  await writeFile(file, steps.map(step => JSON.stringify(step)).join("\n"));
  const read = await readTranscript(file);
  if (!("steps" in read)) throw new Error("the transcript was not read");
  const enriched = enrichReplay(replayed, "s", transcriptTurns(read.steps), { family: model => transcriptModelFamily(model, () => false), price: usage => (usage.input ?? 0) / 1000 });
  const carrier = enriched?.items.find(item => item.id === "usage:s.t2") as Extract<ConversationItem, { type: "assistant_message" }> | undefined;
  expect(carrier?.usage).toEqual(expect.objectContaining({ input: 500, output: 20, costUsd: 0.5 }));
  expect(enriched?.accounting.map(entry => entry.messageId)).toEqual(["s.t1", "s.t2"]);
});
