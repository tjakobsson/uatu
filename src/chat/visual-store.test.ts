import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createWatchedVisualReader, isSafeSvg, VISUAL_CAPTURE_CONCURRENCY, VISUAL_MAX_BYTES, VisualReadError, VisualStore } from "./visual-store";
import type { ChatVisualInput } from "./visual-types";
import { parseChatEvent, parseConversationItem } from "./validation";
import { MultiAgentChatService } from "./agents";
import { ConversationReplay, ReplaySubscription } from "./replay";
import { applyChatEvent, projectionFromSnapshot } from "./projection";
import type { WorkspaceChatService } from "./service";
import type { AssistantMessageItem, ChatEvent, ConversationSnapshot } from "./types";
import { renderChatMarkdown } from "./markdown";
import { parseHTML } from "linkedom";
import { getChatVisuals } from "./visual-markdown";
import { resolveWatchRoots } from "../server/roots";
import { resolveStaticFileRequest } from "../server/static-files";
import { selectCanonicalChatRoot } from "./workspace";

let directory: string;
beforeEach(async () => {
  const scratch = path.join(os.homedir(), ".cache/opencode/scratch");
  await fs.mkdir(scratch, { recursive: true });
  directory = await fs.mkdtemp(path.join(scratch, "uatu-544-test-"));
});
afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });
const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10" fill="red"/></svg>';
const file = (source = "image.png", index = 0): ChatVisualInput => ({ index, source, kind: "file", alt: "image", complete: true });
const inline = (source = svg): ChatVisualInput => ({ ...file(), source, kind: "svg" });

test.each([
  { name: "table repair", prefix: '<table><tr><td>' + Array.from({ length: 8 }, (_, i) => `<img src="old-${i}.png">`).join("") + '</td></tr>', suffix: '<img src="new.png"></table>' },
  { name: "late reference definitions", prefix: '![late][new]\n\n' + Array.from({ length: 8 }, (_, i) => `![${i}](old-${i}.png)`).join("\n\n"), suffix: '\n\n[new]: new.png' },
])("eight persistent admissions survive streamed $name and fresh history reload", async ({ prefix, suffix }) => {
  let markdown = prefix;
  const snapshot = (): ConversationSnapshot => ({ conversation: { id: "c", title: "c", createdAt: 1, updatedAt: 1, status: "running" }, configuration: {}, generation: "g", cursor: "c", items: [{ id: "m", type: "assistant_message", createdAt: 1, markdown }] });
  const events = new ReplaySubscription(() => undefined);
  const provider = { history: async () => snapshot(), subscribe: async () => ({ snapshot: snapshot(), events }), dispose: async () => {} } as unknown as WorkspaceChatService;
  const reads: string[] = [];
  const makeService = () => {
    const store = new VisualStore("/workspace", directory);
    store.setReader(async source => { reads.push(source); return png; });
    return new MultiAgentChatService({ workspacePath: "/workspace", visualStore: store, agents: [{ descriptor: { id: "a", name: "Agent" }, service: provider }] });
  };
  const service = makeService();
  const subscription = await service.subscribe("a:c");
  const first = (subscription.snapshot.items[0] as AssistantMessageItem).visuals!;
  try {
    expect(first).toHaveLength(8);
    markdown += suffix;
    events.push({ type: "item.text_delta", itemId: "m", delta: suffix, generation: "g", sequence: 1, conversationId: "c" });
    const event = (await subscription.events[Symbol.asyncIterator]().next()).value as ChatEvent;
    if (event.type !== "item.upsert" || event.item.type !== "assistant_message") throw new Error("expected repaired visual update");
    expect([...reads].sort()).toEqual(Array.from({ length: 8 }, (_, i) => `old-${i}.png`));
    expect(event.item.visuals).toEqual(first.map(visual => ({ ...visual, index: visual.index + 1 })));
    expect(parseConversationItem(event.item)).toEqual(event.item);
    const { document } = parseHTML(renderChatMarkdown(markdown, { visuals: event.item.visuals }));
    expect(document.querySelectorAll("img")).toHaveLength(8);
    expect(document.querySelector('[data-visual-index="8"] img')).not.toBeNull();
    expect(document.querySelector('[data-visual-index="0"] img')).toBeNull();
    const restarted = makeService();
    try {
      expect((await restarted.history("a:c")).items[0]).toEqual(event.item);
      markdown = markdown.replace("old-0.png", "alt-0.png");
      const changed = (await restarted.history("a:c")).items[0] as AssistantMessageItem;
      expect(changed.visuals?.find(visual => visual.index === 1)).toMatchObject({ status: "unavailable", message: "Image source changed" });
      expect(changed.visuals?.filter(visual => visual.status === "ready")).toHaveLength(7);
      markdown = '<img src="only-new.png">';
      const removed = (await restarted.history("a:c")).items[0] as AssistantMessageItem;
      expect(removed.visuals).toEqual([]);
      expect(renderChatMarkdown(markdown, { visuals: removed.visuals })).toContain("At most 8 images");
      markdown = prefix + suffix;
      expect((await restarted.history("a:c")).items[0]).toEqual(event.item);
      expect(reads).toHaveLength(8);
    } finally { await restarted.dispose(); }
  } finally { subscription.events.cancel(); await service.dispose(); }
});

test("history remains readable if permanent admission cannot be persisted, and recovers without granting extra slots", async () => {
  const root = path.join(directory, "blocked");
  await fs.writeFile(root, "not a directory");
  const store = new VisualStore("/workspace", root);
  let reads = 0;
  store.setReader(async () => { reads++; return png; });
  const markdown = "Before\n\n" + Array.from({ length: 9 }, (_, i) => `![${i}](image-${i}.png)`).join("\n\n") + "\n\nAfter";
  const snapshot: ConversationSnapshot = { conversation: { id: "c", title: "c", createdAt: 1, updatedAt: 1, status: "completed" }, configuration: {}, generation: "g", cursor: "c", items: [{ id: "m", type: "assistant_message", createdAt: 1, markdown }] };
  const provider = { history: async () => snapshot, dispose: async () => {} } as unknown as WorkspaceChatService;
  const service = new MultiAgentChatService({ workspacePath: "/workspace", visualStore: store, agents: [{ descriptor: { id: "a", name: "Agent" }, service: provider }] });
  try {
    const failed = (await service.history("a:c")).items[0] as AssistantMessageItem;
    expect(failed.markdown).toBe(markdown);
    expect(failed.visuals).toHaveLength(8);
    expect(failed.visuals?.every(visual => visual.status === "unavailable" && visual.message === "Image snapshot could not be stored")).toBe(true);
    expect(reads).toBe(0);
    await fs.unlink(root);
    const recovered = (await service.history("a:c")).items[0] as AssistantMessageItem;
    expect(recovered.visuals?.every(visual => visual.status === "ready")).toBe(true);
    expect(recovered.visuals).toHaveLength(8);
    expect(reads).toBe(8);
  } finally { await service.dispose(); }
});

describe("immutable visual snapshots", () => {
  test("first processing establishes admissions without prioritizing or mutating pre-ledger capture records", async () => {
    const names = ["old-0.png", "safe.svg", "unsafe.svg", ...Array.from({ length: 5 }, (_, i) => `old-${i + 3}.png`)];
    const prefix = '<table><tr><td>' + names.map(name => `<img src="${name}">`).join("") + '</td></tr>';
    const original = new VisualStore("/workspace", directory);
    let reads = 0;
    const unsafe = '<svg onload="alert(1)"/>';
    original.setReader(async source => { reads++; return source === "safe.svg" ? new TextEncoder().encode(svg) : source === "unsafe.svg" ? new TextEncoder().encode(unsafe) : png; });
    const before = await original.captureMany("a:c", "m", getChatVisuals(prefix, true).map(input => ({ messageId: "m", input })), true);
    const bytes = await Promise.all(before.map(snapshot => original.resolve(snapshot.id!)));
    const records = await Promise.all(before.map(snapshot => fs.readFile(path.join(original.directory, `${snapshot.id}.json`), "utf8")));
    // Pre-ledger state used these same complete occurrence records, without
    // any recoverable message grouping. Keep the records themselves untouched.
    for (const filename of await fs.readdir(original.directory)) {
      if (/\.slot-\d+\.json$/.test(filename)) await fs.unlink(path.join(original.directory, filename));
    }
    const markdown = prefix + '<img src="new.png"></table>';
    const restarted = new VisualStore("/workspace", directory);
    restarted.setReader(async () => { reads++; return Uint8Array.from([0xff, 0xd8, 0xff]); });
    const provider = { history: async () => ({ conversation: { id: "c", title: "c", createdAt: 1, updatedAt: 1, status: "completed" }, configuration: {}, generation: "g", cursor: "c", items: [{ id: "m", type: "assistant_message", createdAt: 1, markdown }] }), dispose: async () => {} } as unknown as WorkspaceChatService;
    const service = new MultiAgentChatService({ workspacePath: "/workspace", visualStore: restarted, agents: [{ descriptor: { id: "a", name: "Agent" }, service: provider }] });
    try {
      const processed = (await service.history("a:c")).items[0] as AssistantMessageItem;
      // Unreleased test-build compatibility is not an admission policy: the
      // new leading occurrence takes a slot on first processing by this ledger.
      expect(processed.visuals).toHaveLength(8);
      expect(processed.visuals?.[0]).toMatchObject({ index: 0, status: "ready", mimeType: "image/jpeg" });
      expect(processed.visuals?.slice(1)).toEqual(before.slice(0, 7).map(snapshot => ({ ...snapshot, index: snapshot.index + 1 })));
      expect(processed.visuals?.some(snapshot => snapshot.id === before[7]!.id)).toBe(false);
      expect(reads).toBe(9);
      expect(await Promise.all(before.map(snapshot => restarted.resolve(snapshot.id!)))).toEqual(bytes);
      expect(await Promise.all(before.map(snapshot => fs.readFile(path.join(original.directory, `${snapshot.id}.json`), "utf8")))).toEqual(records);
      expect(new TextDecoder().decode(bytes[1]?.sourceBytes)).toBe(svg);
      expect(new TextDecoder().decode(bytes[2]?.sourceBytes)).toBe(unsafe);
      expect(bytes[2]?.bytes).toBeUndefined();
      expect((await fs.readdir(original.directory)).filter(filename => /\.slot-\d+\.json$/.test(filename))).toHaveLength(8);
    } finally { await service.dispose(); }
  });
  test("a completed reply's unfinished SVG refusal is terminal after restart, while streaming source may grow", async () => {
    const store = new VisualStore("/workspace", directory);
    const unfinished = { ...inline("<svg>"), key: "offset:0", complete: false };
    expect((await store.capture("a:c", "unfinished", unfinished, true)).status).toBe("pending");
    expect((await store.capture("a:c", "unfinished", { ...unfinished, source: "<svg><rect/>" }, true)).status).toBe("pending");
    const refused = await store.capture("a:c", "unfinished", unfinished, false);
    expect(refused.status).toBe("unavailable");
    const restarted = new VisualStore("/workspace", directory);
    expect((await restarted.capture("a:c", "unfinished", { ...inline(), key: unfinished.key }, false))).toMatchObject({ status: "unavailable", message: "Image source changed" });
    expect(await restarted.capture("a:c", "unfinished", unfinished, false)).toEqual(refused);
  });
  test("refused and removed occurrences retain slots across source changes, restarts and concurrent admissions", async () => {
    const store = new VisualStore("/workspace", directory);
    const reads: string[] = [];
    store.setReader(async source => { reads.push(source); throw new VisualReadError(); });
    for (let i = 0; i < 8; i++) expect((await store.capture("a:c", "m", { ...file(`refused-${i}.png`, i), key: `key-${i}` }, false)).status).toBe("unavailable");
    const restarted = new VisualStore("/workspace", directory);
    restarted.setReader(async source => { reads.push(source); return png; });
    const changed = await restarted.capture("a:c", "m", { ...file("changed.png", 100), key: "key-0" }, false);
    expect(changed).toMatchObject({ index: 100, status: "unavailable", message: "Image source changed" });
    const excess = await Promise.all(Array.from({ length: 20 }, (_, i) => restarted.capture("a:c", "m", { ...file(`new-${i}.png`, 0), key: `new-${i}` }, false)));
    expect(excess.every(visual => visual.message === "Image limit exceeded")).toBe(true);
    expect(reads).toHaveLength(8);
  });
  test("independent stores concurrently reserve at most eight distinct occurrences, including after restart", async () => {
    const stores = Array.from({ length: 4 }, () => new VisualStore("/workspace", directory));
    const reads: string[] = [];
    for (const store of stores) store.setReader(async source => { reads.push(source); return png; });
    const captures = await Promise.all(Array.from({ length: 32 }, (_, i) => stores[i % stores.length]!.capture("a:c", "race-budget", { ...file(`image-${i}.png`, i), key: `key-${i}` }, false)));
    expect(captures.filter(visual => visual.status === "ready")).toHaveLength(8);
    expect(reads).toHaveLength(8);
    const restarted = new VisualStore("/workspace", directory);
    restarted.setReader(async () => { throw new Error("must not read a ninth occurrence"); });
    expect(await restarted.capture("a:c", "race-budget", { ...file("later.png"), key: "later" }, false)).toMatchObject({ status: "unavailable", message: "Image limit exceeded" });
    for (let i = 0; i < captures.length; i++) {
      const input = { ...file(`image-${i}.png`, 200 + i), key: `key-${i}` };
      expect(await restarted.capture("a:c", "race-budget", input, false)).toEqual({ ...captures[i]!, index: 200 + i });
    }
  });
  test("separate Bun processes share the same permanent eight-slot admission ledger", async () => {
    const children = Array.from({ length: 4 }, (_, worker) => {
      const program = `
        import { VisualStore } from ${JSON.stringify(new URL("./visual-store.ts", import.meta.url).href)};
        const store = new VisualStore("/workspace", ${JSON.stringify(directory)});
        let reads = 0;
        store.setReader(async () => { reads++; return Uint8Array.from([137,80,78,71,13,10,26,10,1]); });
        const captures = await Promise.all(Array.from({ length: 12 }, (_, i) => store.capture("a:c", "process-race", {
          index: i, key: ${JSON.stringify(`worker-${worker}-`)} + i, kind: "file", source: "image.png", alt: "Image", complete: true,
        }, false)));
        console.log(JSON.stringify({ reads, ready: captures.filter(capture => capture.status === "ready").length }));
      `;
      return Bun.spawn([process.execPath, "--eval", program], { stdout: "pipe", stderr: "pipe" });
    });
    try {
      const results = await Promise.all(children.map(async child => {
        const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
        expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
        return JSON.parse(stdout) as { reads: number; ready: number };
      }));
      expect(results.reduce((count, result) => count + result.ready, 0)).toBe(8);
      expect(results.reduce((count, result) => count + result.reads, 0)).toBe(8);
      const restarted = new VisualStore("/workspace", directory);
      expect(await restarted.capture("a:c", "process-race", { ...file(), key: "ninth-after-process-exit" }, false)).toMatchObject({ status: "unavailable", message: "Image limit exceeded" });
    } finally { for (const child of children) { if (child.exitCode === null) child.kill(); } }
  });
  test("large replies capture only eight occurrences with four readers, without making the cap a conversation lifetime quota", async () => {
    const store = new VisualStore("/workspace", directory);
    let active = 0, maximum = 0, reads = 0;
    let release!: () => void;
    let fourStarted!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { fourStarted = resolve; });
    store.setReader(async () => {
      reads++; active++; maximum = Math.max(maximum, active);
      if (active === VISUAL_CAPTURE_CONCURRENCY) fourStarted();
      try { await gate; return png; } finally { active--; }
    });
    const markdown = Array.from({ length: 256 }, (_, i) => `![${i}](image-${i}.png)`).join("\n\n");
    let messageId = "first";
    const provider = { history: async () => ({ conversation: { id: "c", title: "c", createdAt: 1, updatedAt: 1, status: "completed" }, configuration: {}, generation: "g", cursor: "c", items: [{ id: messageId, type: "assistant_message", createdAt: 1, markdown }] }), dispose: async () => {} } as unknown as WorkspaceChatService;
    const service = new MultiAgentChatService({ workspacePath: "/workspace", visualStore: store, agents: [{ descriptor: { id: "a", name: "Agent" }, service: provider }] });
    const pending = service.history("a:c");
    try {
      await started;
      expect(reads).toBe(VISUAL_CAPTURE_CONCURRENCY);
      release();
      const first = (await pending).items[0] as AssistantMessageItem;
      expect(first.visuals).toHaveLength(8);
      expect(reads).toBe(8);
      expect(maximum).toBe(VISUAL_CAPTURE_CONCURRENCY);
      expect(parseHTML(renderChatMarkdown(markdown, { visuals: first.visuals })).document.querySelectorAll("img")).toHaveLength(8);
      messageId = "second";
      const second = (await service.history("a:c")).items[0] as AssistantMessageItem;
      expect(second.visuals).toHaveLength(8);
      expect(reads).toBe(16);
      expect(second.visuals?.[0]?.id).not.toBe(first.visuals?.[0]?.id);
      expect(active).toBe(0);
    } finally { release(); await pending; await service.dispose(); }
  });
  test("source keys survive rendered index shifts, including pending/refused metadata and mismatches", async () => {
    const store = new VisualStore("/workspace", directory);
    let bytes = png;
    store.setReader(async () => bytes);
    const input = { ...file("later.png"), key: "offset:15" };
    const first = await store.capture("a:c", "shift", input, true);
    bytes = Uint8Array.from([0xff, 0xd8, 0xff, 4]);
    const shifted = await store.capture("a:c", "shift", { ...input, index: 1 }, false);
    expect(shifted).toEqual({ ...first, index: 1 });
    expect((await store.resolve(shifted.id!))?.bytes).toEqual(png);
    const introduced = await store.capture("a:c", "shift", { ...file("earlier.jpg"), key: "offset:0" }, false);
    expect(introduced.id).not.toBe(first.id);
    expect(introduced.index).toBe(0);
    expect((await store.capture("a:c", "shift", { ...input, index: 2, source: "changed.png" }, false))).toMatchObject({ index: 2, status: "unavailable" });
    expect((await store.capture("a:c", "shift", input, false)).index).toBe(0);
    const restarted = new VisualStore("/workspace", directory);
    expect(await restarted.capture("a:c", "shift", { ...input, index: 3 }, false)).toEqual({ ...first, index: 3 });
    const pendingInput = { ...file("missing.png"), key: "offset:30" };
    store.setReader(async () => { throw new VisualReadError(true); });
    await store.capture("a:c", "shift", pendingInput, true);
    expect(await store.capture("a:c", "shift", { ...pendingInput, index: 4 }, true)).toMatchObject({ index: 4, status: "pending" });
    const refusedInput = { ...inline('<svg onload="alert(1)"/>'), key: "offset:60" };
    const refused = await store.capture("a:c", "shift", refusedInput, false);
    expect(await store.capture("a:c", "shift", { ...refusedInput, index: 5 }, false)).toEqual({ ...refused, index: 5 });
    expect(await restarted.capture("a:c", "shift", { ...pendingInput, index: 6, source: "different.svg" }, false)).toMatchObject({ index: 6, status: "unavailable" });
  });
  test("admission permits and duplicate-key waits recover after persistence failures", async () => {
    const root = path.join(directory, "blocked");
    await fs.writeFile(root, "not a directory");
    const store = new VisualStore("/workspace", root);
    store.setReader(async () => png);
    const attempts = await Promise.allSettled(Array.from({ length: 16 }, (_, index) => store.capture("a:c", `m-${index % 8}`, file(), false)));
    expect(attempts.every(result => result.status === "rejected")).toBe(true);
    await fs.unlink(root);
    expect((await store.capture("a:c", "m-0", file(), false)).status).toBe("ready");
  });
  test("first successful bytes survive mutation, duplicates, restart and workspace/conversation isolation", async () => {
    const store = new VisualStore("/workspace", directory);
    let bytes = png;
    store.setReader(async () => bytes);
    const first = await store.capture("a:c", "m", file(), true);
    expect(first.status).toBe("ready");
    bytes = new Uint8Array([0xff, 0xd8, 0xff, 7]);
    expect(await store.capture("a:c", "m", file(), false)).toEqual(first);
    const restarted = new VisualStore("/workspace", directory);
    expect((await restarted.resolve(first.id!))?.bytes).toEqual(png);
    expect(await restarted.capture("a:c", "m", file(), false)).toEqual(first);
    expect((await store.capture("b:c", "m", file(), false)).id).not.toBe(first.id);
    expect(await new VisualStore("/other", directory).resolve(first.id!)).toBeNull();
    expect((await store.capture("a:c", "m", file("different.png"), false)).status).toBe("unavailable");
    expect(await store.resolve("../secret")).toBeNull();
  });
  test("independent stores racing publish a single complete winner", async () => {
    const a = new VisualStore("/workspace", directory), b = new VisualStore("/workspace", directory);
    a.setReader(async () => png);
    b.setReader(async () => Uint8Array.from([0xff, 0xd8, 0xff]));
    const results = await Promise.all([a.capture("a:c", "m", file(), true), b.capture("a:c", "m", file(), true)]);
    expect(results[0]).toEqual(results[1]);
    expect((await a.resolve(results[0]!.id!))?.mimeType).toBe(results[0]!.mimeType!);
  });
  test("missing is tried once during streaming, once at completion, and not again after restart", async () => {
    let reads = 0;
    const store = new VisualStore("/workspace", directory);
    store.setReader(async () => { reads++; throw new VisualReadError(true); });
    expect((await store.capture("a:c", "m", file(), true)).status).toBe("pending");
    expect((await store.capture("a:c", "m", file(), true)).status).toBe("pending");
    expect(reads).toBe(1);
    expect((await store.capture("a:c", "m", file(), false)).status).toBe("unavailable");
    expect(reads).toBe(2);
    const restarted = new VisualStore("/workspace", directory);
    restarted.setReader(async () => { throw new Error("must not retry"); });
    expect((await restarted.capture("a:c", "m", file(), false)).status).toBe("unavailable");
  });
  test("missing becomes ready on completion; invalid and incomplete content fail gracefully", async () => {
    const store = new VisualStore("/workspace", directory);
    store.setReader(async () => { throw new VisualReadError(true); });
    await store.capture("a:c", "m", file(), true);
    store.setReader(async () => png);
    expect((await store.capture("a:c", "m", file(), false)).status).toBe("ready");
    expect((await store.capture("a:c", "large", inline("x".repeat(VISUAL_MAX_BYTES + 1)), false)).status).toBe("unavailable");
    expect((await store.capture("a:c", "incomplete", { ...inline(), complete: false }, true)).status).toBe("pending");
    expect((await store.capture("a:c", "incomplete", { ...inline(), complete: false }, false)).status).toBe("unavailable");
    for (let index = 0; index < 8; index++) await store.capture("a:c", "limit", file("image.png", index), false);
    expect((await store.capture("a:c", "limit", file("image.png", 8), false)).message).toBe("Image limit exceeded");
  });
  test("SVG retains exact original bytes; invalid SVG is terminal", async () => {
    const store = new VisualStore("/workspace", directory);
    const ready = await store.capture("a:c", "svg", inline(), false);
    expect(ready.mimeType).toBe("image/svg+xml");
    expect(new TextDecoder().decode((await store.resolve(ready.id!))!.bytes)).toBe(svg);
    expect((await store.capture("a:c", "bad", inline('<svg onload="alert(1)"/>'), true)).status).toBe("unavailable");
    expect((await store.capture("a:c", "bad", inline(), false)).status).toBe("unavailable");
    const fragment = '<?xml version="1.0" encoding="UTF-8"?><!-- <svg> --><svg><style>.x { fill:red }</style><rect class="x"/></svg>';
    const normalized = await store.capture("a:c", "fragment", inline(fragment), false);
    const stored = (await store.resolve(normalized.id!))!;
    expect(new TextDecoder().decode(stored.sourceBytes)).toBe(fragment);
    expect(new TextDecoder().decode(stored.bytes)).toStartWith('<svg xmlns="http://www.w3.org/2000/svg">');
  });
  test("refused local SVG preserves first original across mutation, deletion and restart, without preview bytes", async () => {
    const root = path.join(directory, "workspace");
    await fs.mkdir(root);
    const original = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
    const pathname = path.join(root, "unsafe.svg");
    await fs.writeFile(pathname, original);
    const store = new VisualStore(root, path.join(directory, "state"));
    store.setReader(createWatchedVisualReader([{ kind: "dir", absolutePath: root } as never]));
    const refused = await store.capture("a:c", "unsafe", file("unsafe.svg"), true);
    expect(refused).toMatchObject({ status: "unavailable", mimeType: "image/svg+xml" });
    expect(refused.id).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(refused)).not.toContain(original);
    await fs.writeFile(pathname, svg);
    expect(await store.capture("a:c", "unsafe", file("unsafe.svg"), false)).toEqual(refused);
    await fs.unlink(pathname);
    const restarted = new VisualStore(root, path.join(directory, "state"));
    expect(await restarted.capture("a:c", "unsafe", file("unsafe.svg"), false)).toEqual(refused);
    const stored = (await restarted.resolve(refused.id!))!;
    expect(stored.bytes).toBeUndefined();
    expect(new TextDecoder().decode(stored.sourceBytes)).toBe(original);
    const fence = await store.capture("a:c", "fence", inline(original), false);
    expect(new TextDecoder().decode((await store.resolve(fence.id!))?.sourceBytes)).toBe(original);
    expect((await store.resolve(fence.id!))?.bytes).toBeUndefined();
  });
  test("source retention requires explicit SVG candidate, bounded valid UTF-8; arbitrary text never becomes source", async () => {
    const store = new VisualStore("/workspace", directory);
    let bytes = new TextEncoder().encode(svg);
    store.setReader(async () => bytes);
    for (const source of ["notes.txt", "README.md", "no-extension", "not-svg.png"]) {
      const refused = await store.capture("a:c", source, file(source), false);
      expect(refused.status).toBe("unavailable");
      expect(refused.id).toBeUndefined();
    }
    bytes = Uint8Array.from([0xff, 0xfe, 0, 0x3c]);
    expect((await store.capture("a:c", "invalid-utf8", file("invalid.svg"), false)).id).toBeUndefined();
    bytes = new Uint8Array(VISUAL_MAX_BYTES + 1);
    expect((await store.capture("a:c", "too-large", file("large.svg"), false)).id).toBeUndefined();
    const emptyFence = await store.capture("a:c", "empty", inline(""), false);
    expect(emptyFence.status).toBe("unavailable");
    expect((await store.resolve(emptyFence.id!))?.sourceBytes?.length).toBe(0);
  });
  test("racing SVG captures publish source and preview availability as one immutable record", async () => {
    const a = new VisualStore("/workspace", directory), b = new VisualStore("/workspace", directory);
    const unsafe = '<svg onload="alert(1)"/>';
    a.setReader(async () => new TextEncoder().encode(unsafe));
    b.setReader(async () => new TextEncoder().encode(svg));
    const [first, second] = await Promise.all([a.capture("a:c", "race-svg", file("image.svg"), true), b.capture("a:c", "race-svg", file("image.svg"), true)]);
    expect(first).toEqual(second!);
    const restored = (await new VisualStore("/workspace", directory).resolve(first!.id!))!;
    expect(new TextDecoder().decode(restored.sourceBytes)).toBe(first!.status === "ready" ? svg : unsafe);
    expect(restored.bytes !== undefined).toBe(first!.status === "ready");
  });
});

describe("watched-root bounded reader", () => {
  test.each(["root", "parent"])("canonical workspace reads through a symlinked watch %s without bypassing policy", async kind => {
    const parent = path.join(directory, "real");
    const root = path.join(parent, "workspace");
    const alias = path.join(directory, "alias");
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, "image.png"), png);
    await fs.writeFile(path.join(root, ".gitignore"), "ignored.png\n");
    await fs.writeFile(path.join(root, ".uatu.json"), JSON.stringify({ ignore: { exclude: ["excluded.png", "excluded/"] } }));
    await fs.writeFile(path.join(root, "ignored.png"), png);
    await fs.writeFile(path.join(root, "excluded.png"), png);
    for (const name of ["excluded", ".git"]) {
      await fs.mkdir(path.join(root, name));
      await fs.writeFile(path.join(root, name, "image.png"), png);
      await fs.symlink(path.join(root, name), path.join(root, `${name}-alias`));
    }
    await fs.writeFile(path.join(root, ".env"), png);
    await fs.writeFile(path.join(directory, "outside.png"), png);
    await fs.symlink(path.join(directory, "outside.png"), path.join(root, "escape.png"));
    await fs.symlink(directory, path.join(root, "escape-parent"));
    await fs.symlink(kind === "root" ? root : parent, alias);
    const lexicalRoot = kind === "root" ? alias : path.join(alias, "workspace");
    const entries = await resolveWatchRoots([lexicalRoot], directory);
    const workspace = await selectCanonicalChatRoot(entries);
    expect(workspace).toBe(await fs.realpath(root));
    expect(await resolveStaticFileRequest("image.png", entries)).toEqual({ status: "found", filePath: path.join(workspace, "image.png") });
    const reader = createWatchedVisualReader(entries);
    expect(await reader("image.png", workspace)).toEqual(png);
    expect(await reader(path.join(workspace, "image.png"), workspace)).toEqual(png);
    expect(await reader("image.png", lexicalRoot)).toEqual(png);
    for (const denied of [".env", "excluded.png", "excluded-alias/image.png", ".git-alias/image.png", "escape.png", "escape-parent/outside.png"]) {
      await expect(reader(denied, workspace)).rejects.toMatchObject({ missing: false });
    }
    await expect(reader("missing.png", workspace)).rejects.toMatchObject({ missing: true });
    expect(await createWatchedVisualReader(entries, false)("ignored.png", workspace)).toEqual(png);
    await expect(createWatchedVisualReader(entries, false)("excluded.png", workspace)).rejects.toMatchObject({ missing: false });
  });
  test("tiny-file buffers track observed size plus one, and growth during reading is refused", async () => {
    const root = path.join(directory, "root");
    await fs.mkdir(root);
    const pathname = path.join(root, "tiny.png");
    await fs.writeFile(pathname, png);
    const buffers: number[] = [];
    let grow = false;
    const originalOpen = fs.open.bind(fs);
    const open = spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      return new Proxy(handle, { get(target, property) {
        if (property === "read") return async (buffer: Uint8Array, offset: number, length: number, position: number) => {
          buffers.push(buffer.byteLength);
          if (grow) { grow = false; await fs.appendFile(pathname, new Uint8Array(100)); }
          return target.read(buffer, offset, length, position);
        };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      } });
    });
    try {
      const reader = createWatchedVisualReader([{ kind: "dir", absolutePath: root } as never]);
      expect(await reader("tiny.png", root)).toEqual(png);
      expect(buffers.length).toBeGreaterThan(0);
      expect(buffers.every(size => size === png.length + 1)).toBe(true);
      grow = true;
      await expect(reader("tiny.png", root)).rejects.toBeInstanceOf(VisualReadError);
      expect(buffers.every(size => size === png.length + 1)).toBe(true);
    } finally { open.mockRestore(); }
  });
  test("workspace anchored PNG/JPEG/SVG reads, policy, symlink and traversal refusals", async () => {
    const root = path.join(directory, "root");
    await fs.mkdir(root);
    await fs.writeFile(path.join(root, "image.png"), png);
    await fs.writeFile(path.join(root, "image.jpg"), Uint8Array.from([0xff, 0xd8, 0xff]));
    await fs.writeFile(path.join(root, "image.svg"), svg);
    await fs.writeFile(path.join(root, ".gitignore"), "ignored.png\n");
    await fs.writeFile(path.join(root, "ignored.png"), png);
    await fs.writeFile(path.join(root, ".uatu.json"), JSON.stringify({ ignore: { exclude: ["excluded.png"] } }));
    await fs.writeFile(path.join(root, "excluded.png"), png);
    await fs.writeFile(path.join(root, ".env"), png);
    await fs.writeFile(path.join(directory, "outside.png"), png);
    await fs.symlink(path.join(directory, "outside.png"), path.join(root, "escape.png"));
    await fs.symlink(directory, path.join(root, "escape-parent"));
    const reader = createWatchedVisualReader([{ kind: "dir", absolutePath: root } as never]);
    expect(await reader("image.png", root)).toEqual(png);
    expect(await reader(path.join(root, "image.jpg"), root)).toEqual(Uint8Array.from([0xff, 0xd8, 0xff]));
    expect(new TextDecoder().decode(await reader("image.svg", root))).toBe(svg);
    for (const denied of ["../outside.png", "%2e%2e/outside.png", "https://example.com/a.png", "//example.com/a.png", "file:///etc/passwd", ".env", "excluded.png", "escape.png", "escape-parent/outside.png", "image.png?x", "bad%00.png", "%ZZ"]) {
      await expect(reader(denied, root)).rejects.toBeInstanceOf(VisualReadError);
    }
    await expect(reader("missing.png", root)).rejects.toMatchObject({ missing: true });
    await fs.writeFile(path.join(root, "huge.png"), new Uint8Array(VISUAL_MAX_BYTES + 1));
    await expect(reader("huge.png", root)).rejects.toMatchObject({ missing: false });
    const noIgnore = createWatchedVisualReader([{ kind: "dir", absolutePath: root } as never], false);
    expect(await noIgnore("ignored.png", root)).toEqual(png);
    await expect(noIgnore("excluded.png", root)).rejects.toMatchObject({ missing: false });
  });
  test("additional watched roots never expand the agent workspace's capture boundary", async () => {
    const workspace = path.join(directory, "workspace");
    const secondary = path.join(directory, "secondary");
    const nested = path.join(workspace, "images");
    await fs.mkdir(nested, { recursive: true });
    await fs.mkdir(secondary);
    await fs.writeFile(path.join(nested, "inside.png"), png);
    await fs.writeFile(path.join(secondary, "outside.png"), png);
    const reader = createWatchedVisualReader([
      { kind: "dir", absolutePath: nested } as never,
      { kind: "dir", absolutePath: secondary } as never,
    ]);
    expect(await reader("images/inside.png", workspace)).toEqual(png);
    expect(await reader(path.join(nested, "inside.png"), workspace)).toEqual(png);
    for (const outside of [path.join(secondary, "outside.png"), path.join(secondary, "missing.png")]) {
      await expect(reader(outside, workspace)).rejects.toMatchObject({ missing: false });
    }
    // A watched-root symlink must not turn an in-workspace lexical path into
    // permission to read a sibling workspace's bytes.
    await fs.symlink(secondary, path.join(workspace, "linked"));
    const linkedReader = createWatchedVisualReader([{ kind: "dir", absolutePath: path.join(workspace, "linked") } as never]);
    await expect(linkedReader("linked/outside.png", workspace)).rejects.toMatchObject({ missing: false });
  });
});

describe("conservative SVG validation", () => {
  test("basic shapes, gradients and local references", () => {
    expect(isSafeSvg(svg)).toBe(true);
    expect(isSafeSvg('<svg><defs><linearGradient id="g"><stop offset="1"/></linearGradient></defs><rect fill="url(#g)"/><use href="#g"/></svg>')).toBe(true);
    expect(isSafeSvg(`<svg><!-- ordinary comment --><defs><linearGradient id="paint"><stop offset="0" stop-color="red"/></linearGradient><clipPath id="clip"><rect width="1"/></clipPath></defs><style>.x { fill: url( '#paint' ); clip-path: URL( "#clip" ) }</style><rect class="x" fill="url( #paint )"/></svg>`)).toBe(true);
  });
  test("malicious and malformed XML never reaches preview", () => {
    for (const value of [
      '<svg><script>alert(1)</script></svg>', '<svg onLoad="x"/>', '<svg><foreignObject/></svg>',
      '<svg><image href="https://evil.test/x"/></svg>', '<svg><use href="data:image/svg+xml,x"/></svg>',
      '<svg><use href="&#x68;ttps://evil.test"/></svg>', '<svg><style>@import "https://evil.test";</style></svg>',
      '<svg style="fill:url(https://evil.test)"/>', '<svg style="fill:u\\72l(https://evil.test)"/>',
      '<svg><style>svg { background:image-set("//evil.test/x") }</style></svg>',
      '<svg><style>svg { fill:u/**/rl(https://evil.test/x) }</style></svg>',
      '<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg>&x;</svg>', '<?xml-stylesheet href="https://evil.test"?><svg/>',
      '<svg xmlns:x="http://evil.test"><x:script/></svg>', '<svg><g></svg>', '<svg></SVG>', '<svg/><svg/>', '<svg onclick=x/>',
      '<svg id="x" id="y"/>', '<svg><animate attributeName="href"/></svg>', '<svg><set attributeName="onload"/></svg>',
      '<svg>&unknown;</svg>', '<svg><rect', 'not SVG', '<html><svg/></html>',
      '<svg><![CDATA[<script>alert(1)</script>]]></svg>', '<svg>\u0000</svg>', '<svg xmlns="http://evil.test"/>',
      '<svg><style>.x { fill: url( "https://evil.test/x" ) }</style></svg>', '<svg fill="url( //evil.test/x )"/>',
    ]) expect(isSafeSvg(value)).toBe(false);
  });
});

test("assistant snapshot wire validation", () => {
  const item: AssistantMessageItem = { id: "m", type: "assistant_message", createdAt: 1, markdown: "", visuals: [{ index: 0, status: "ready", id: "a".repeat(64), mimeType: "image/png" }] };
  expect(parseConversationItem(item)).toEqual(item);
  expect(parseConversationItem({ ...item, visuals: [{ index: 0, status: "unavailable", id: "a".repeat(64), mimeType: "image/svg+xml" }] })).toHaveProperty("visuals.0.status", "unavailable");
  expect(parseConversationItem({ ...item, visuals: [{ ...item.visuals![0], index: 80 }] })).toHaveProperty("visuals.0.index", 80);
  for (const visuals of [[{ index: 0, status: "ready" }], [{ index: Number.MAX_SAFE_INTEGER + 1, status: "pending" }], [{ index: 0, status: "pending" }, { index: 0, status: "pending" }], [{ index: 0, status: "ready", id: "../secret", mimeType: "image/png" }], Array.from({ length: 9 }, (_, index) => ({ index, status: "pending" }))]) {
    expect(() => parseConversationItem({ ...item, visuals })).toThrow();
  }
});

test("genuine history and streamed deltas capture immediately, terminal status retries pending without invented sequence IDs", async () => {
  const store = new VisualStore("/workspace", directory);
  let exists = true;
  store.setReader(async () => { if (!exists) throw new VisualReadError(true); return png; });
  const message: AssistantMessageItem = { id: "m", type: "assistant_message", createdAt: 1, markdown: "![first](first.png)" };
  const snapshot: ConversationSnapshot = { conversation: { id: "c", title: "c", createdAt: 1, updatedAt: 1, status: "running" }, configuration: {}, generation: "g", cursor: "c", items: [message] };
  const events = new ReplaySubscription(() => undefined);
  const provider = {
    history: async () => snapshot,
    subscribe: async () => ({ snapshot, events }),
    dispose: async () => {},
  } as unknown as WorkspaceChatService;
  const service = new MultiAgentChatService({ workspacePath: "/workspace", visualStore: store, agents: [{ descriptor: { id: "a", name: "Agent" }, service: provider }] });
  const history = await service.history("a:c");
  expect((history.items[0] as AssistantMessageItem).visuals?.[0]?.status).toBe("ready");
  const subscription = await service.subscribe("a:c");
  const iterator = subscription.events[Symbol.asyncIterator]();
  exists = false;
  events.push({ generation: "g", sequence: 1, conversationId: "c", type: "item.text_delta", itemId: "m", delta: "\n![second](second.png)" });
  const update = (await iterator.next()).value as ChatEvent;
  expect(update.type).toBe("item.upsert");
  if (update.type !== "item.upsert" || update.item.type !== "assistant_message") throw new Error("expected assistant upsert");
  expect(update.item.visuals?.map(visual => visual.status)).toEqual(["ready", "pending"]);
  expect(update.sequence).toBe(1);
  expect(parseChatEvent(update)).toEqual(update);
  exists = true;
  events.push({ generation: "g", sequence: 2, conversationId: "c", type: "conversation.status", status: "completed" });
  const complete = (await iterator.next()).value!;
  expect(complete.type).toBe("resync");
  expect(complete.sequence).toBe(2);
  expect(parseChatEvent(complete)).toEqual(complete);
  snapshot.items = [{ ...message, markdown: message.markdown + "\n![second](second.png)" }];
  snapshot.conversation.status = "completed";
  const terminal = await service.history("a:c");
  expect((terminal.items[0] as AssistantMessageItem).visuals?.map(visual => visual.status)).toEqual(["ready", "ready"]);
  snapshot.conversation.status = "running";
  exists = false;
  snapshot.items = [
    { ...message, id: "old", markdown: "![old](old.png)" },
    { id: "u", type: "user_message", createdAt: 2, text: "next turn" },
    { ...message, id: "new", createdAt: 3, markdown: "![new](new.png)" },
  ];
  const inferred = await service.history("a:c");
  expect((inferred.items[0] as AssistantMessageItem).visuals?.[0]?.status).toBe("unavailable");
  expect((inferred.items[2] as AssistantMessageItem).visuals?.[0]?.status).toBe("pending");
  exists = true;
  snapshot.items = [{ ...message, id: "many", markdown: Array.from({ length: 9 }, (_, index) => `![${index}](image-${index}.png)`).join("\n") }];
  expect((await service.history("a:c")).items[0]).toHaveProperty("visuals.length", 8);
  subscription.events.cancel();
  await service.dispose();
});

test("reconnect backlog deltas are forwarded unchanged and never appended to the current snapshot twice", async () => {
  const replay = new ConversationReplay("generation", "c", 100_000);
  const message: AssistantMessageItem = { id: "m", type: "assistant_message", createdAt: 1, markdown: "Hello" };
  const conversation = { id: "c", title: "c", createdAt: 1, updatedAt: 1, status: "running" as const };
  replay.publish({ type: "item.upsert", item: message });
  const cursor = replay.latestCursor();
  const initial: ConversationSnapshot = { conversation, configuration: {}, generation: "generation", cursor, items: [message] };
  let client = projectionFromSnapshot({ ...initial, conversation: { ...conversation, id: "a:c" } });
  const backlog = replay.publish({ type: "item.text_delta", itemId: "m", delta: " world" });
  const current = { ...initial, items: [{ ...message, markdown: "Hello world" }] };
  const provider = {
    subscribe: async (_id: string, options?: { cursor?: string; signal?: AbortSignal }) => {
      const handoff = replay.handoff(cursor => ({ ...current, cursor }), options?.cursor, options?.signal);
      return { snapshot: handoff.snapshot, events: handoff.subscription };
    },
    dispose: async () => {},
  } as unknown as WorkspaceChatService;
  const store = new VisualStore("/workspace", directory);
  store.setReader(async () => png);
  const service = new MultiAgentChatService({ workspacePath: "/workspace", visualStore: store, agents: [{ descriptor: { id: "a", name: "Agent" }, service: provider }] });
  const subscription = await service.subscribe("a:c", { cursor });
  expect((subscription.snapshot.items[0] as AssistantMessageItem).markdown).toBe("Hello world");
  const iterator = subscription.events[Symbol.asyncIterator]();
  const replayed = (await iterator.next()).value as ChatEvent;
  expect(replayed).toEqual({ ...backlog, conversationId: "a:c" });
  client = applyChatEvent(client, replayed).projection;
  expect((client.items[0] as AssistantMessageItem).markdown).toBe("Hello world");
  const live = replay.publish({ type: "item.text_delta", itemId: "m", delta: "!" });
  const next = (await iterator.next()).value as ChatEvent;
  expect(next.type).toBe("item.text_delta");
  expect(next.sequence).toBe(live.sequence);
  client = applyChatEvent(client, next).projection;
  expect((client.items[0] as AssistantMessageItem).markdown).toBe("Hello world!");
  replay.publish({ type: "item.text_delta", itemId: "m", delta: "\n![image](image.png)" });
  const visual = (await iterator.next()).value as ChatEvent;
  client = applyChatEvent(client, visual).projection;
  expect((client.items[0] as AssistantMessageItem).markdown).toBe("Hello world!\n![image](image.png)");
  expect((client.items[0] as AssistantMessageItem).visuals?.[0]?.status).toBe("ready");
  subscription.events.cancel();
  expect(replay.subscriberCount()).toBe(0);
  await service.dispose();
});

test("terminal cursor replay resyncs once when snapshot enrichment alone turns a cached pending visual ready", async () => {
  const store = new VisualStore("/workspace", directory);
  let exists = false;
  store.setReader(async () => { if (!exists) throw new VisualReadError(true); return png; });
  const replay = new ConversationReplay("g", "c", 100_000);
  const message: AssistantMessageItem = { id: "m", type: "assistant_message", createdAt: 1, markdown: "![image](image.png)" };
  replay.publish({ type: "item.upsert", item: message });
  let current: ConversationSnapshot = { conversation: { id: "c", title: "c", createdAt: 1, updatedAt: 1, status: "running" }, configuration: {}, generation: "g", cursor: replay.latestCursor(), items: [message] };
  const provider = {
    history: async () => ({ ...current, cursor: replay.latestCursor() }),
    subscribe: async (_id: string, options?: { cursor?: string }) => {
      const handoff = replay.handoff(cursor => ({ ...current, cursor }), options?.cursor);
      return { snapshot: handoff.snapshot, events: handoff.subscription };
    }, dispose: async () => {},
  } as unknown as WorkspaceChatService;
  const service = new MultiAgentChatService({ workspacePath: "/workspace", visualStore: store, agents: [{ descriptor: { id: "a", name: "Agent" }, service: provider }] });
  const cached = await service.history("a:c");
  expect((cached.items[0] as AssistantMessageItem).visuals?.[0]?.status).toBe("pending");
  replay.publish({ type: "item.text_delta", itemId: "m", delta: " done" });
  const terminal = replay.publish({ type: "conversation.status", status: "completed" });
  current = { ...current, conversation: { ...current.conversation, status: "completed" }, items: [{ ...message, markdown: message.markdown + " done" }] };
  exists = true;
  const subscription = await service.subscribe("a:c", { cursor: cached.cursor });
  expect((subscription.snapshot.items[0] as AssistantMessageItem).visuals?.[0]?.status).toBe("ready");
  const iterator = subscription.events[Symbol.asyncIterator]();
  const delta = (await iterator.next()).value as ChatEvent;
  expect(delta.type).toBe("item.text_delta");
  expect(delta).not.toHaveProperty("item");
  const resync = (await iterator.next()).value as ChatEvent;
  expect(parseChatEvent(resync)).toEqual({ type: "resync", reason: "conversation-rewritten", generation: "g", conversationId: "a:c", sequence: terminal.sequence });
  subscription.events.cancel();
  const fresh = await service.history("a:c");
  expect((fresh.items[0] as AssistantMessageItem).visuals?.[0]?.status).toBe("ready");
  const resumed = await service.subscribe("a:c", { cursor: fresh.cursor });
  replay.publish({ type: "conversation.status", status: "completed" });
  expect(((await resumed.events[Symbol.asyncIterator]().next()).value as ChatEvent).type).toBe("conversation.status");
  resumed.events.cancel();
  await service.dispose();
});

test("plain-text streaming preserves 100 native 1-KiB deltas without growing full-item replay payloads", async () => {
  const store = new VisualStore("/workspace", directory);
  let reads = 0;
  store.setReader(async () => { reads++; return png; });
  const snapshot: ConversationSnapshot = { conversation: { id: "c", title: "c", createdAt: 1, updatedAt: 1, status: "running" }, configuration: {}, generation: "g", cursor: "c", items: [{ id: "m", type: "assistant_message", createdAt: 1, markdown: "" }] };
  const events = new ReplaySubscription(() => undefined);
  const provider = { subscribe: async () => ({ snapshot, events }), dispose: async () => {} } as unknown as WorkspaceChatService;
  const service = new MultiAgentChatService({ workspacePath: "/workspace", visualStore: store, agents: [{ descriptor: { id: "a", name: "Agent" }, service: provider }] });
  const subscription = await service.subscribe("a:c");
  const iterator = subscription.events[Symbol.asyncIterator]();
  let deliveredTextBytes = 0;
  for (let sequence = 1; sequence <= 100; sequence++) {
    const event: ChatEvent = { type: "item.text_delta", itemId: "m", delta: "x".repeat(1024), generation: "g", conversationId: "c", sequence };
    events.push(event);
    const delivered = (await iterator.next()).value as ChatEvent;
    expect(delivered).toEqual({ ...event, conversationId: "a:c" });
    if (delivered.type !== "item.text_delta") throw new Error("unexpected growing upsert");
    deliveredTextBytes += Buffer.byteLength(delivered.delta);
  }
  expect(deliveredTextBytes).toBe(102_400);
  expect(reads).toBe(0);
  subscription.events.cancel();
  await service.dispose();
});

test("split image syntax and whitespace-separated SVG fences deliver metadata on their first complete occurrence", async () => {
  const store = new VisualStore("/workspace", directory);
  store.setReader(async () => png);
  const snapshot: ConversationSnapshot = { conversation: { id: "c", title: "c", createdAt: 1, updatedAt: 1, status: "running" }, configuration: {}, generation: "g", cursor: "c", items: [{ id: "m", type: "assistant_message", createdAt: 1, markdown: "" }] };
  const events = new ReplaySubscription(() => undefined);
  const provider = { subscribe: async () => ({ snapshot, events }), dispose: async () => {} } as unknown as WorkspaceChatService;
  const service = new MultiAgentChatService({ workspacePath: "/workspace", visualStore: store, agents: [{ descriptor: { id: "a", name: "Agent" }, service: provider }] });
  const subscription = await service.subscribe("a:c");
  const iterator = subscription.events[Symbol.asyncIterator]();
  let sequence = 0;
  const delta = async (text: string): Promise<ChatEvent> => {
    events.push({ type: "item.text_delta", itemId: "m", delta: text, generation: "g", conversationId: "c", sequence: ++sequence });
    return (await iterator.next()).value as ChatEvent;
  };
  await delta("~~~");
  await delta(" svg\n");
  await delta("<svg><rect width=\"1\"/></svg>\n");
  const fence = await delta("~~~");
  expect(fence.type).toBe("item.upsert");
  if (fence.type !== "item.upsert" || fence.item.type !== "assistant_message") throw new Error("expected completed SVG");
  expect(fence.item.visuals?.[0]?.status).toBe("ready");
  expect((await delta("\ntrailing prose")).type).toBe("item.text_delta");
  await delta("\n![image](");
  const image = await delta("image.png)");
  expect(image.type).toBe("item.upsert");
  if (image.type !== "item.upsert" || image.item.type !== "assistant_message") throw new Error("expected completed image");
  expect(image.item.visuals?.map(visual => visual.status)).toEqual(["ready", "ready"]);
  expect((await delta(" more prose")).type).toBe("item.text_delta");
  subscription.events.cancel();
  await service.dispose();
});

test("concurrent history and subscribe enrichment share one store's four-reader admission limit", async () => {
  const store = new VisualStore("/workspace", directory);
  let active = 0, maximum = 0, reads = 0;
  let release!: () => void;
  let fourStarted!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { fourStarted = resolve; });
  store.setReader(async () => {
    active++; reads++; maximum = Math.max(maximum, active);
    if (active === VISUAL_CAPTURE_CONCURRENCY) fourStarted();
    try { await gate; return png; }
    finally { active--; }
  });
  const items: AssistantMessageItem[] = Array.from({ length: 8 }, (_, index) => ({
    id: `m-${index}`, type: "assistant_message", createdAt: index,
    markdown: Array.from({ length: 8 }, (_, visual) => `![${visual}](image-${visual}.png)`).join("\n"),
  }));
  const snapshot: ConversationSnapshot = { conversation: { id: "c", title: "c", createdAt: 1, updatedAt: 1, status: "completed" }, configuration: {}, generation: "g", cursor: "c", items };
  const events = new ReplaySubscription(() => undefined);
  const provider = { history: async () => snapshot, subscribe: async () => ({ snapshot, events }), dispose: async () => {} } as unknown as WorkspaceChatService;
  const service = new MultiAgentChatService({ workspacePath: "/workspace", visualStore: store, agents: [{ descriptor: { id: "a", name: "Agent" }, service: provider }] });
  const pending = Promise.all([service.history("a:c"), service.history("a:c"), service.subscribe("a:c")]);
  try {
    await started;
    expect(active).toBe(VISUAL_CAPTURE_CONCURRENCY);
    expect(reads).toBe(VISUAL_CAPTURE_CONCURRENCY);
    release();
    const [first, second, subscription] = await pending;
    expect(maximum).toBe(VISUAL_CAPTURE_CONCURRENCY);
    expect(reads).toBe(64);
    expect(active).toBe(0);
    expect(first.items).toEqual(second.items);
    expect(subscription.snapshot.items).toEqual(first.items);
  } finally {
    release();
    events.cancel();
    try { await pending; } finally { await service.dispose(); }
  }
});

test("subscribe cancels the provider handoff if snapshot enrichment fails or its signal aborts during capture", async () => {
  let cleanups = 0;
  let events = new ReplaySubscription(() => { cleanups++; });
  const snapshot: ConversationSnapshot = { conversation: { id: "c", title: "c", createdAt: 1, updatedAt: 1, status: "running" }, configuration: {}, generation: "g", cursor: "c", items: [{ id: "m", type: "assistant_message", createdAt: 1, get markdown(): string { throw new Error("broken snapshot"); } }] };
  const store = new VisualStore("/workspace", directory);
  const provider = { subscribe: async () => ({ snapshot, events }), dispose: async () => {} } as unknown as WorkspaceChatService;
  const service = new MultiAgentChatService({ workspacePath: "/workspace", visualStore: store, agents: [{ descriptor: { id: "a", name: "Agent" }, service: provider }] });
  await expect(service.subscribe("a:c")).rejects.toThrow("broken snapshot");
  expect(cleanups).toBe(1);
  events = new ReplaySubscription(() => { cleanups++; });
  const stop = new AbortController();
  store.setReader(async () => { stop.abort(); return png; });
  snapshot.items = [{ id: "m", type: "assistant_message", createdAt: 1, markdown: "![image](image.png)" }];
  const subscription = await service.subscribe("a:c", { signal: stop.signal });
  expect(cleanups).toBe(2);
  expect((await subscription.events[Symbol.asyncIterator]().next()).done).toBe(true);
  await service.dispose();
});
