import { expect, test } from "bun:test";
import { ChatApiClient } from "../../src/chat/client";
import { startReviewServer } from "./server";
import { conversationId, terminalId } from "./protocols";

test("real Chat mutations, queue, configuration and bounded replay remain synthetic", async () => {
  const review = await startReviewServer({ port: 0, assets: new Map() });
  const client = new ChatApiClient((path, init) => fetch(new URL(String(path), review.url), init));
  try {
    const model = (await client.models("review"))[0]!;
    expect(model.name).toContain("Synthetic");
    expect((await client.commands("review"))[0]?.name).toBe("status");
    const accepted = await client.prompt(conversationId, "r1", "private input never retained", model.selection);
    expect(accepted.held).toBe(false);
    expect((await client.prompt(conversationId, "r2", "another private input")).held).toBe(true);
    let snapshot = await client.snapshot(conversationId);
    expect(snapshot.conversation.status).toBe("running");
    expect(snapshot.queued).toHaveLength(1);
    expect(JSON.stringify(snapshot)).not.toContain("private input");
    review.protocols.emitChat();
    snapshot = await client.snapshot(conversationId);
    expect(snapshot.queued).toHaveLength(0);
    expect(snapshot.conversation.status).toBe("running");
    expect((await client.cancel(conversationId, "r3")).cancelled).toBe(true);
    expect((await client.snapshot(conversationId)).conversation.status).toBe("interrupted");
    const fresh = await client.createConversation("review");
    expect(fresh.conversation.id).not.toBe(conversationId);
    expect((await client.snapshot(fresh.conversation.id)).items).toEqual([]);
    expect((await client.renameConversation(fresh.conversation.id, "r4", "private title")).conversation.title).toBe("Renamed synthetic conversation");
    await expect(client.prompt(fresh.conversation.id, "r5", "/unknown")).rejects.toThrow("Unknown synthetic command");
    const abort = new AbortController();
    const response = await fetch(`${review.url}/api/chat/conversations/${encodeURIComponent(conversationId)}/events?cursor=review-1:0`, { signal: abort.signal });
    const chunk = await response.body!.getReader().read();
    expect(new TextDecoder().decode(chunk.value)).toContain("conversation.queue"); abort.abort();
    expect((await fetch(`${review.url}/api/chat/conversations/${encodeURIComponent(conversationId)}?limit=0`)).status).toBe(400);
  } finally { review.stop(); }
});

test("terminal inventory creates independent disposable sessions", async () => {
  const review = await startReviewServer({ port: 0, assets: new Map() });
  try {
    const created = await (await fetch(`${review.url}/api/terminal/sessions`, { method: "POST" })).json();
    expect(created.id).not.toBe(terminalId);
    expect(created.label).toContain("Synthetic");
    expect((await (await fetch(`${review.url}/api/terminal/sessions`)).json()).sessions).toHaveLength(2);
    expect((await fetch(`${review.url}/api/terminal/sessions/${created.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await fetch(`${review.url}/api/terminal/sessions/${created.id}`, { method: "DELETE" })).status).toBe(404);
  } finally { review.stop(); }
});

test("real Chat transport parses fixture reads and pending uploads settle or reset", async () => {
  const review = await startReviewServer({ port: 0, assets: new Map() });
  const client = new ChatApiClient((path, init) => fetch(new URL(String(path), review.url), init));
  try {
    expect((await client.status())[0]?.availability.state).toBe("ready");
    expect((await client.conversations())[0]?.id).toBe(conversationId);
    expect((await client.snapshot(conversationId)).items).toEqual([]);
    review.protocols.holdUploads();
    const upload = client.uploadAttachment(conversationId, new Blob(["discarded test bytes"]));
    for (let i = 0; review.protocols.snapshot().pendingUploads === 0 && i < 100; i++) await Bun.sleep(5);
    expect(review.protocols.snapshot().pendingUploads).toBe(1);
    review.protocols.settleUploads();
    expect(await upload).toMatchObject({ id: "synthetic-attachment" });
    review.protocols.holdUploads();
    const resetUpload = client.uploadAttachment(conversationId, new Blob(["discarded"]));
    const rejection = resetUpload.catch(error => error);
    for (let i = 0; review.protocols.snapshot().pendingUploads === 0 && i < 100; i++) await Bun.sleep(5);
    review.protocols.reset();
    expect((await rejection).message).toBe("Synthetic review reset");
    expect((await fetch(`${review.url}/api/chat/attachments/synthetic-attachment`)).status).toBe(501);
  } finally { review.stop(); }
});

test("terminal double requires attach-ready and only sends synthetic binary output", async () => {
  const review = await startReviewServer({ port: 0, assets: new Map() });
  try {
    const ws = new WebSocket(`${review.url.replace("http:", "ws:")}/api/terminal?sessionId=${terminalId}`);
    ws.binaryType = "arraybuffer";
    const output = new Promise<string>((resolve, reject) => {
      ws.onopen = () => ws.send(JSON.stringify({ type: "attach-ready", cols: 80, rows: 24 }));
      ws.onmessage = event => resolve(new TextDecoder().decode(event.data));
      ws.onerror = reject;
    });
    expect(await output).toContain("no shell is running");
    ws.close();
  } finally { review.stop(); }
});
