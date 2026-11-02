import { expect, test } from "bun:test";
import type { ShellCreated, ShellDeleted, ShellExited, ShellInfo } from "@opencode/client";

import { createOpenCodeV2Provider } from "../../src/chat/opencode/v2/provider";
import { createOpenCodeV2Normalizer } from "../../src/chat/opencode/v2/normalization";
import { startOpenCodeV2Fake } from "./opencode-v2-fake";

// The installed @opencode/client 2.1.2 ShellInfo/ShellExited/ShellDeleted
// contracts retain the native shapes captured in real-2.0.13.json. Exercise
// the actual HTTP/SSE fixture, not a second hand-built provider response.
test("fake shell inventory retains its accepted launch command and native start across reads", async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory });
  const headers = { authorization: `Basic ${Buffer.from(`opencode:${fake.password}`).toString("base64")}` };
  try {
    const parent = (await provider.createSession("Native shell inventory contract")).id;
    const foreign = (await provider.createSession("Another owner")).id;
    const { shellId, taskId } = fake.launchShell(parent, true);
    const read = async () => (await (await fetch(`${fake.url}/api/shell/${shellId}`, { headers })).json()).data as ShellInfo;
    const first = await read();
    expect(first).toMatchObject({ id: shellId, command: "printf 'safe shell output'", status: "running", cwd: directory,
      shell: "/bin/sh", file: `/fixture/${shellId}.out`, metadata: { sessionID: parent, background: true }, time: { started: expect.any(Number) } });
    expect(await read()).toEqual(first);
    expect(await provider.reconcileBackgroundTasks(parent, { fresh: true })).toContainEqual(expect.objectContaining({ taskId, activity: expect.objectContaining({ kind: "working" }) }));
    expect(await provider.reconcileBackgroundTasks(foreign, { fresh: true })).toEqual([]);
    expect(fake.state().calls.filter(call => call.startsWith("DELETE "))).toEqual([]);
    expect(fake.state().unhandled).toEqual([]);
  } finally { await provider.dispose(); await fake.stop(); }
});

test("fake shell exit and deletion use native ephemeral identities while capture stays pending", async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory });
  const controller = new AbortController();
  const headers = { authorization: `Basic ${Buffer.from(`opencode:${fake.password}`).toString("base64")}` };
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const parent = (await provider.createSession("Native shell exit contract")).id;
    reader = (await fetch(`${fake.url}/api/event`, { headers, signal: controller.signal })).body!.getReader();
    let pending = "";
    const decoder = new TextDecoder();
    const next = async (type: string): Promise<unknown> => {
      for (;;) {
        const boundary = pending.indexOf("\n\n");
        if (boundary >= 0) {
          const frame = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
          if (!frame.startsWith("data: ")) continue;
          const event = JSON.parse(frame.slice(6));
          if (event.type === type) return event;
        } else {
          const chunk = await reader!.read();
          if (chunk.done) throw new Error(`Fixture stream closed before ${type}`);
          pending += decoder.decode(chunk.value, { stream: true });
        }
      }
    };
    const { shellId, taskId } = fake.launchShell(parent, true);
    const birth = await next("shell.created") as ShellCreated;
    fake.shellPhase(shellId, "exit");
    const exit = await next("shell.exited") as ShellExited;
    expect(exit.data).toEqual({ id: shellId, status: "exited", exit: 0 });
    expect(exit).not.toHaveProperty("durable");
    expect(createOpenCodeV2Normalizer(directory).prepare(exit).evidence.shellExit).toMatchObject({ id: shellId, proof: { id: exit.id, created: exit.created } });
    const inventory = (await (await fetch(`${fake.url}/api/shell/${shellId}`, { headers })).json()).data as ShellInfo;
    const completed = inventory.time.completed;
    expect(completed).toBeNumber();
    expect(completed!).toBeLessThanOrEqual(exit.created);
    expect(inventory).toMatchObject({ ...birth.data.info, status: "exited", exit: 0, time: { started: birth.data.info.time.started, completed } });
    expect(await provider.reconcileBackgroundTasks(parent, { fresh: true })).toContainEqual(expect.objectContaining({ taskId, status: "running", activity: expect.objectContaining({ kind: "ended", endedAt: completed }) }));
    expect(fake.state().shells[shellId]).toMatchObject({ captured: false, removed: false, waiter: "exited" });
    await fetch(`${fake.url}/api/shell/${shellId}`, { method: "DELETE", headers });
    const deleted = await next("shell.deleted") as ShellDeleted;
    expect(deleted.data).toEqual({ id: shellId });
    expect(deleted).not.toHaveProperty("durable");
    expect(fake.state().calls.filter(call => call.startsWith("DELETE "))).toEqual([`DELETE /api/shell/${shellId}`]);
    expect(fake.state().unhandled).toEqual([]);
  } finally { controller.abort(); await reader?.cancel().catch(() => {}); await provider.dispose(); await fake.stop(); }
});
