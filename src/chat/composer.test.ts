import { expect, test } from "bun:test";
import { Composer, type ComposerConversation, type ComposerPresentation, type ComposerTransport } from "./composer";
import { ChatTransportError } from "./client";
import type { ChatProjection } from "./projection";
import type { ConversationSnapshot, QueuedMessage, ReversibleHistoryResult } from "./types";

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const image = (name = "image.png") => new File(["image"], name, { type: "image/png" });
const acceptance = (extra: Partial<Awaited<ReturnType<ComposerTransport["prompt"]>>> = {}) => ({ messageId: "message-1", pending: false, delivery: "queue" as const, configuration: {}, ...extra });
const entry = (extra: Partial<QueuedMessage> = {}): QueuedMessage => ({ id: "native-original", text: "Pending", queuedAt: 1, delivery: "steer", ...extra });
const terminalEvent = () => ({ type: "conversation.queue" as const, conversationId: "one", generation: "g", sequence: 1, queued: [], change: { kind: "delivered" as const, messageId: "native-original" } });

function fixture(overrides: Partial<ComposerTransport> = {}) {
  let selected = "one", epoch = 0, cancelling = false, count = 0;
  let projection: ChatProjection = { conversationId: "one", generation: "g", sequence: 0, cursor: "", status: "running", items: [], queued: [], acceptedDrafts: [], queueRevision: 0, configurationRevision: 0 };
  const texts = new Map<string, string>();
  const released: string[] = [], created: string[] = [], prompts: Parameters<ComposerTransport["prompt"]>[] = [];
  const errors: Array<[string | null, string | undefined]> = [], notes: Array<string | null> = [];
  let refresh: ComposerConversation["refresh"] = async () => true;
  const transport: ComposerTransport = {
    prompt: async (...args) => { prompts.push(args); return acceptance(); },
    uploadAttachment: async () => ({ id: `upload-${++count}`, mimeType: "image/png", sizeBytes: 5 }),
    attachmentUrl: id => `/attachment/${id}`,
    generate: async () => ({ text: "Answer" }), removeQueued: async () => ({ removed: true }),
    changeDelivery: async (_id, messageId, _request, delivery) => ({ messageId, delivery }),
    sendNow: async (_id, messageId) => ({ messageId, delivery: "steer" }),
    discardUnconfirmedSteer: async () => ({ discarded: true, outcomeUnconfirmed: true }),
    undo: async () => ({ outcome: "nothing-to-undo", state: { canUndo: false, canRedo: false, staged: false, revertedMessages: [] } }),
    redo: async () => ({ outcome: "nothing-to-redo", state: { canUndo: false, canRedo: false, staged: false, revertedMessages: [] } }),
    revert: async () => { throw new Error("unused"); }, restore: async () => { throw new Error("unused"); },
    ...overrides,
  };
  const context: ComposerConversation = {
    selected: () => selected, read: () => projection, write: value => { projection = value; }, epoch: () => epoch,
    cancelling: () => cancelling, declares: () => true, commands: () => [], commandsAvailable: () => true,
    reloadCommands: async () => true, agentId: () => "agent", refreshCommands: () => {},
    configuration: () => ({ value: {}, stage: undefined }), consumeConfiguration: () => {},
    imageSupport: () => ({ supported: true }), refresh: (id, pending) => refresh(id, pending),
  };
  const presentation: ComposerPresentation = {
    changed: () => {}, error: (text, id) => { errors.push([text, id]); }, note: text => { notes.push(text); },
    announce: () => {}, accepted: () => {}, heldByHold: () => {},
  };
  const composer = new Composer(context, transport, { read: id => texts.get(id) ?? "", write: (id, text) => { texts.set(id, text); } }, presentation, {
    create: () => { const url = `blob:preview-${created.length}`; created.push(url); return url; },
    release: url => { released.push(url); }, id: () => `request-${++count}`,
  });
  return { composer, context, transport, texts, prompts, errors, notes, released, created,
    projection: () => projection,
    setProjection: (value: Partial<ChatProjection>) => { projection = { ...projection, ...value }; },
    select: (id: string) => { selected = id; projection = { ...projection, conversationId: id }; },
    reload: () => { epoch++; }, cancel: (value: boolean) => { cancelling = value; },
    refresh: (value: ComposerConversation["refresh"]) => { refresh = value; },
  };
}

test("ordinary send captures once, accepts without consuming newer text and releases previews", async () => {
  const response = deferred<ReturnType<typeof acceptance>>();
  const f = fixture(); f.transport.prompt = async (...args) => { f.prompts.push(args); return response.promise; };
  f.composer.edit("Original"); await f.composer.attach([image()]);
  const sent = f.composer.submit();
  expect(f.texts.get("one")).toBe(""); expect(f.composer.submitting).toBe(true);
  f.composer.edit("Newer"); response.resolve(acceptance()); await sent;
  expect(f.texts.get("one")).toBe("Newer"); expect(f.prompts[0]![2]).toBe("Original");
  expect(f.prompts[0]![6]).toEqual([{ id: "upload-1", name: "image.png", mimeType: "image/png" }]);
  expect(f.released).toEqual(f.created); expect(f.projection().items).toHaveLength(1);
});

test("refusal restores capture before newer edits and reuses original request and uploaded refs", async () => {
  const response = deferred<ReturnType<typeof acceptance>>(); const f = fixture();
  f.transport.prompt = async (...args) => { f.prompts.push(args); return response.promise; };
  f.composer.edit("Original"); await f.composer.attach([image()]); const sent = f.composer.submit();
  f.composer.edit("Newer"); response.reject(new ChatTransportError("Refused", 400)); await sent;
  expect(f.texts.get("one")).toBe("Original\nNewer"); expect(f.released).toEqual([]);
  expect(f.composer.pendingAttachments()).toHaveLength(1);
  f.composer.edit("Original"); f.transport.prompt = async (...args) => { f.prompts.push(args); return acceptance(); };
  await f.composer.submit(); expect(f.prompts[1]![1]).toBe(f.prompts[0]![1]); expect(f.released).toEqual(f.created);
});

test("unknown primary retains uncertain input, never restores it as a sendable draft or replays", async () => {
  const f = fixture({ prompt: async () => { throw new ChatTransportError("Unknown", 502); } });
  f.composer.edit("Original"); await f.composer.submit();
  expect(f.texts.get("one")).toBe(""); expect(f.projection().acceptedDrafts[0]?.unconfirmed).toBe(true);
  expect(f.composer.feedback("one").toLowerCase()).toContain("do not repeat");
  expect(f.composer.acceptedDrafts("one")[0]?.text).toBe("Original");
});

test("upload drain includes appended intake but leaves newly typed words for the next draft", async () => {
  const first = deferred<{ id: string; mimeType: string; sizeBytes: number }>(); let uploads = 0;
  const f = fixture({ uploadAttachment: async () => ++uploads === 1 ? first.promise : { id: "second", mimeType: "image/png", sizeBytes: 5 } });
  f.composer.edit("Original"); const intake = f.composer.attach([image("first.png")]); const sent = f.composer.submit();
  f.composer.edit("Newer"); const appended = f.composer.attach([image("second.png")]);
  first.resolve({ id: "first", mimeType: "image/png", sizeBytes: 5 }); await Promise.all([intake, sent, appended]);
  expect(f.prompts[0]![6]?.map(a => a.id)).toEqual(["first", "second"]); expect(f.texts.get("one")).toBe("Newer");
});

test("refusal during drain prevents partial send and preserves successfully uploaded references", async () => {
  const upload = deferred<{ id: string; mimeType: string; sizeBytes: number }>();
  const f = fixture({ uploadAttachment: () => upload.promise }); f.composer.edit("Original");
  const attached = f.composer.attach([image()]); const sent = f.composer.submit(); f.composer.edit("Newer");
  f.composer.noteAttachmentRefusal("one"); upload.resolve({ id: "first", mimeType: "image/png", sizeBytes: 5 }); await Promise.all([attached, sent]);
  expect(f.prompts).toHaveLength(0); expect(f.texts.get("one")).toBe("Original\nNewer"); expect(f.composer.pendingAttachments()).toHaveLength(1);
});

test("switch during upload restores only the originating draft without sending", async () => {
  const upload = deferred<{ id: string; mimeType: string; sizeBytes: number }>(); const f = fixture({ uploadAttachment: () => upload.promise });
  f.composer.edit("Original"); const attached = f.composer.attach([image()]); const sent = f.composer.submit();
  f.texts.set("one", "Newer"); f.select("two"); f.composer.edit("Other"); upload.resolve({ id: "first", mimeType: "image/png", sizeBytes: 5 }); await Promise.all([attached, sent]);
  expect(f.prompts).toHaveLength(0); expect(f.texts.get("one")).toBe("Original\nNewer"); expect(f.texts.get("two")).toBe("Other");
  expect(f.composer.pendingAttachments("one")).toHaveLength(1);
});

test("inflight attachment reserve prevents restored draft overflowing the eight-image limit", async () => {
  const response = deferred<ReturnType<typeof acceptance>>(); const f = fixture({ prompt: () => response.promise });
  await f.composer.attach(Array.from({ length: 8 }, () => image())); f.composer.edit("Original"); const sent = f.composer.submit();
  await f.composer.attach([image("ninth.png")]); response.reject(new ChatTransportError("Refused", 400)); await sent;
  expect(f.composer.pendingAttachments()).toHaveLength(8); expect(f.errors.some(([message]) => message?.includes("at most 8"))).toBe(true);
});

test("fresh receipt cannot resurrect a queue entry after the stream or projection reload", async () => {
  for (const reload of [false, true]) {
    const response = deferred<ReturnType<typeof acceptance>>(); const f = fixture({ prompt: () => response.promise }); f.composer.edit("Original"); const sent = f.composer.submit();
    if (reload) f.reload(); else f.setProjection({ queueRevision: 1 });
    response.resolve(acceptance({ pending: true })); await sent;
    expect(f.projection().queued).toEqual([]); expect(f.projection().acceptedDrafts).toEqual([]);
  }
});

test("pending Edit waits for withdrawal then merges latest originating text and attachments", async () => {
  const removed = deferred<{ removed: boolean }>(); const f = fixture({ removeQueued: () => removed.promise });
  f.setProjection({ queued: [entry({ attachments: [{ id: "stored", name: "old.png", mimeType: "image/png" }] })] });
  f.composer.edit("Draft"); const edited = f.composer.pending("native-original", "edit");
  expect(f.texts.get("one")).toBe("Draft"); f.composer.edit("Newer"); removed.resolve({ removed: true }); await edited;
  expect(f.texts.get("one")).toBe("Pending\nNewer"); expect(f.composer.pendingAttachments()[0]?.previewUrl).toBe("/attachment/stored");
  f.composer.removeAttachment(f.composer.pendingAttachments()[0]!); expect(f.released).toEqual([]);
});

test("explicit terminal evidence before unknown withdrawal prevents recreating uncertain ownership", async () => {
  const removed = deferred<{ removed: boolean }>(); const f = fixture({ removeQueued: () => removed.promise });
  f.setProjection({ queued: [entry()] }); const result = f.composer.pending("native-original", "remove");
  f.composer.observe(terminalEvent(), true); f.setProjection({ queued: [] }); removed.reject(new ChatTransportError("Unknown", 502)); await result;
  expect(f.composer.withdrawalRetries("one")).toBeUndefined(); expect(f.composer.feedback("one")).toBe("");
});

test("withdrawal uncertainty permits cancellation-only retry against the original native ID", async () => {
  const ids: string[] = []; let attempts = 0; const f = fixture({ removeQueued: async (_id, messageId) => { ids.push(messageId); if (++attempts === 1) throw new ChatTransportError("Unknown", 502); return { removed: true }; } });
  f.setProjection({ queued: [entry()] }); f.composer.edit("Private"); await f.composer.pending("native-original", "edit");
  expect(f.composer.pending("native-original", "edit")).toBeUndefined(); expect(f.texts.get("one")).toBe("Private");
  await f.composer.pending("native-original", "remove"); expect(ids).toEqual(["native-original", "native-original"]); expect(f.projection().queued).toEqual([]);
});

test("discard confirmation is single-use, rechecks token and never invokes native removal", async () => {
  let discarded = 0, removed = 0; const f = fixture({ discardUnconfirmedSteer: async () => { discarded++; return { discarded: true, outcomeUnconfirmed: true }; }, removeQueued: async () => { removed++; return { removed: true }; } });
  f.setProjection({ queued: [entry({ unconfirmed: true, admissionUncertaintyId: "token" })] }); f.composer.edit("Private");
  const stale = f.composer.pending("native-original", "discard"); expect(stale && "confirm" in stale).toBe(true);
  f.setProjection({ queued: [entry({ unconfirmed: true, admissionUncertaintyId: "new-token" })] });
  if (stale && "confirm" in stale) await stale.confirm(); expect(discarded).toBe(0);
  const question = f.composer.pending("native-original", "discard");
  if (question && "confirm" in question) { await question.confirm(); await question.confirm(); }
  expect(discarded).toBe(1); expect(removed).toBe(0); expect(f.texts.get("one")).toBe("Private"); expect(f.composer.feedback("one")).toContain("did not cancel or resend");
});

test("confirmation after selection changes cannot mutate the old pending entry", async () => {
  let discarded = 0; const f = fixture({ discardUnconfirmedSteer: async () => { discarded++; return { discarded: true, outcomeUnconfirmed: true }; } });
  f.setProjection({ queued: [entry({ unconfirmed: true, admissionUncertaintyId: "token" })] });
  const question = f.composer.pending("native-original", "discard"); f.select("two");
  if (question && "confirm" in question) await question.confirm(); expect(discarded).toBe(0);
});

test("conversion preserves draft and leaves queue state to committed evidence", async () => {
  let converted = ""; const f = fixture({ changeDelivery: async (_id, messageId, _request, delivery) => { converted = `${messageId}:${delivery}`; return { messageId: "new-handle", delivery }; } });
  f.setProjection({ queued: [entry({ delivery: "queue" })] }); f.composer.edit("Private"); await f.composer.pending("native-original", "steer");
  expect(converted).toBe("native-original:steer"); expect(f.texts.get("one")).toBe("Private"); expect(f.projection().queued[0]?.id).toBe("native-original");
});

test("side question failure preserves newer text and never enters ordinary admission", async () => {
  const answer = deferred<{ text: string }>(); const f = fixture({ generate: () => answer.promise });
  f.composer.edit("/btw Why?"); const asking = f.composer.submit(); f.composer.edit("Newer"); answer.reject(new Error("Unavailable")); await asking;
  expect(f.texts.get("one")).toBe("Newer"); expect(f.composer.sideAnswer("one")?.failed).toBe(true); expect(f.prompts).toHaveLength(0);
});

test("history result survives failed refresh; retry refreshes without another mutation and replaces newer draft", async () => {
  let mutations = 0; const result: ReversibleHistoryResult = { outcome: "changed", state: { canUndo: false, canRedo: true, staged: true, revertedMessages: [] }, restoredDraft: { text: "Restored", attachments: [{ id: "stored", name: "restored.png", mimeType: "image/png" }] } };
  const f = fixture({ undo: async () => { mutations++; return result; } }); await f.composer.attach([image()]); f.composer.edit("/undo");
  f.refresh(async () => false); await f.composer.submit(); expect(f.texts.get("one")).toBe("/undo"); expect(f.released).toEqual([]);
  f.composer.edit("Newer"); f.refresh(async () => true); await f.composer.history("undo", "one");
  expect(mutations).toBe(1); expect(f.texts.get("one")).toBe("Restored"); expect(f.released).toEqual(f.created); expect(f.composer.pendingAttachments()[0]?.id).toBe("stored");
});

test("history invalidates late uploads and preserves another conversation's draft", async () => {
  const upload = deferred<{ id: string; mimeType: string; sizeBytes: number }>(), history = deferred<ReversibleHistoryResult>();
  const f = fixture({ uploadAttachment: () => upload.promise, undo: () => history.promise }); const attaching = f.composer.attach([image()]);
  f.composer.edit("/undo"); const undoing = f.composer.submit(); f.select("two"); f.composer.edit("Other");
  history.resolve({ outcome: "changed", state: { canUndo: false, canRedo: true, staged: true, revertedMessages: [] }, restoredDraft: { text: "Restored" } }); await undoing;
  upload.resolve({ id: "late", mimeType: "image/png", sizeBytes: 5 }); await attaching;
  expect(f.texts.get("one")).toBe("Restored"); expect(f.texts.get("two")).toBe("Other"); expect(f.created).toEqual([]);
});

test("dispose releases inflight previews exactly once without cancelling or replaying input", async () => {
  const response = deferred<ReturnType<typeof acceptance>>(); const f = fixture({ prompt: () => response.promise }); await f.composer.attach([image()]);
  f.composer.edit("Original"); const sent = f.composer.submit(); f.composer.dispose(); response.resolve(acceptance()); await sent;
  expect(f.released).toEqual(f.created); expect(f.released).toHaveLength(1);
});

test("accepted primary remains accepted when automatic backgrounding failed", async () => {
  const f = fixture({ prompt: async () => acceptance({ automaticBackground: "failed", delivery: "steer", pending: true }) }); f.composer.edit("Original"); await f.composer.submit();
  expect(f.texts.get("one")).toBe(""); expect(f.projection().queued).toHaveLength(1); expect(f.composer.feedback("one")).toContain("steer was not repeated");
});

test("cancel lock refuses submission without leaking explicit queue intent", async () => {
  const f = fixture(); f.composer.edit("Original"); f.cancel(true); await f.composer.submit({ delivery: "queue" });
  expect(f.texts.get("one")).toBe("Original"); f.cancel(false); await f.composer.submit(); expect(f.prompts[0]![7]).toBe("steer");
});

test("configuration is captured after drain, newer streamed configuration wins, and original stage is consumed by identity", async () => {
  const response = deferred<ReturnType<typeof acceptance>>(); const f = fixture({ prompt: async (...args) => { f.prompts.push(args); return response.promise; } });
  const firstStage = { mode: "first" }, newerStage = { mode: "newer" };
  let stage = firstStage;
  f.context.configuration = () => ({ value: stage, stage });
  const consumed: string[] = [];
  f.context.consumeConfiguration = (id, captured) => { if (captured === stage) consumed.push(id); };
  f.composer.edit("Original"); const sent = f.composer.submit({ delivery: "queue" });
  stage = newerStage; f.setProjection({ configurationRevision: 1, configuration: { mode: "streamed" } });
  response.resolve(acceptance({ configuration: firstStage })); await sent;
  expect(f.prompts[0]![4]).toBe("first"); expect(f.projection().configuration?.mode).toBe("streamed"); expect(consumed).toEqual([]);
});

test("uncertain attachment-bearing replacement retains original refs but releases only its preview", async () => {
  const response = deferred<ReturnType<typeof acceptance>>(); const f = fixture({ prompt: () => response.promise });
  f.setProjection({ reversibleHistory: { canUndo: false, canRedo: true, staged: true, revertedMessages: [] } });
  await f.composer.attach([image()]); f.composer.edit("Original"); const sent = f.composer.submit(); f.composer.edit("Newer");
  await f.composer.attach([image("newer.png")]); response.reject(new ChatTransportError("Unknown", undefined, "operation_outcome_unknown")); await sent;
  expect(f.texts.get("one")).toBe("Newer"); expect(f.released).toEqual([f.created[0]!]);
  expect(f.composer.acceptedDrafts("one")[0]?.attachments?.[0]?.id).toBe("upload-1");
  expect(f.composer.pendingAttachments()[0]?.name).toBe("newer.png");
});

test("terminal fence rejects stale recovery rows but an incomplete snapshot is not settlement evidence", async () => {
  const removed = deferred<{ removed: boolean }>(); const read = deferred<boolean>(); const f = fixture({ removeQueued: () => removed.promise });
  f.setProjection({ queued: [entry({ delivery: "queue" })] });
  let pending: Parameters<ComposerConversation["refresh"]>[1];
  f.refresh(async (_id, action) => { pending = action; return read.promise; });
  const result = f.composer.pending("native-original", "remove"); removed.reject(new ChatTransportError("Conflict", 409));
  await Promise.resolve(); await Promise.resolve();
  expect(pending).toBeDefined(); f.composer.observe(terminalEvent(), true);
  const snapshot = { conversation: { id: "one" }, queued: [entry()] } as ConversationSnapshot;
  expect(f.composer.checkedSnapshot("one", snapshot, pending).queued).toEqual([]);
  expect(() => f.composer.checkedSnapshot("one", { conversation: { id: "one" } } as ConversationSnapshot, pending)).toThrow("did not include");
  read.resolve(true); await result;
});

test("side answer completion remains page-local to its originating conversation", async () => {
  const answer = deferred<{ text: string }>(); const f = fixture({ generate: () => answer.promise });
  f.composer.edit("/btw Why?"); const asking = f.composer.submit(); f.select("two"); f.composer.edit("Other draft");
  answer.resolve({ text: "Because" }); await asking;
  expect(f.composer.sideAnswer("one")?.text).toBe("Because"); expect(f.composer.sideAnswer("two")).toBeUndefined(); expect(f.texts.get("two")).toBe("Other draft");
});

test("history no-op keeps command and attachments, redo replacement owns new resources", async () => {
  const f = fixture(); await f.composer.attach([image()]); f.composer.edit("/undo"); await f.composer.submit();
  expect(f.texts.get("one")).toBe("/undo"); expect(f.composer.pendingAttachments()).toHaveLength(1); expect(f.released).toEqual([]);
  f.transport.redo = async () => ({ outcome: "changed", state: { canUndo: true, canRedo: false, staged: false, revertedMessages: [] }, restoredDraft: { text: "Restored", attachments: [{ name: "unavailable.png", mimeType: "image/png" }] } });
  f.composer.edit("/redo"); await f.composer.submit();
  expect(f.texts.get("one")).toBe("Restored"); expect(f.composer.unavailableAttachments()).toHaveLength(1); expect(f.released).toEqual(f.created);
});

test("dispose invalidates uploading intake without manufacturing previews or sending", async () => {
  const upload = deferred<{ id: string; mimeType: string; sizeBytes: number }>(); const f = fixture({ uploadAttachment: () => upload.promise });
  const attaching = f.composer.attach([image()]); f.composer.edit("Original"); const sent = f.composer.submit();
  f.composer.dispose(); upload.resolve({ id: "late", mimeType: "image/png", sizeBytes: 5 }); await Promise.all([attaching, sent]);
  expect(f.created).toEqual([]); expect(f.prompts).toEqual([]);
});
