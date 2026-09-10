import { expect, test } from "bun:test";
import { defaultPublicOrigin, verifyOwned, readHealth, managedHostingOptions, manage, type Ownership } from "./manage";
import { frontendFingerprint } from "./hosting-identity";
import { startReviewServer } from "./server";

test("manager limits commands and validates restart settings before lifecycle effects", async () => {
  expect(managedHostingOptions([])).toEqual({ port: 4703, publicOrigin: defaultPublicOrigin });
  for (const port of ["0", "4700", "4701", "4702"]) expect(() => managedHostingOptions(["--port", port])).toThrow();
  await expect(manage(["killall"])).rejects.toThrow();
  await expect(manage(["stop", "--port", "4700"])).rejects.toThrow();
  await expect(readHealth(4700)).rejects.toThrow();
});

test("served health identifies instance and actual frontend bytes on ephemeral loopback", async () => {
  const assets = new Map([["/index.html", { body: "fixture", type: "text/html" }]]);
  const review = await startReviewServer({ port: 0, assets });
  try {
    const health = await readHealth(Number(new URL(review.url).port));
    expect(health.instanceId).toMatch(/^[a-f0-9-]{36}$/);
    expect(health.version).toEqual({ kind: "frontend-content-sha256", fingerprint: await frontendFingerprint(assets) });
    expect(await frontendFingerprint(new Map([["/index.html", { body: "changed", type: "text/html" }]]))).not.toBe(health.version.fingerprint);
  } finally { review.stop(); }
});

test("ownership verification requires PID, startup identity, synthetic health and exact build", async () => {
  const command = `${process.execPath} ${new URL("./server.ts", import.meta.url).pathname} --port 4799 --public-origin ${defaultPublicOrigin}`;
  const record: Ownership = { schema: 1, pid: 12345, port: 4799, publicOrigin: defaultPublicOrigin, instanceId: crypto.randomUUID(), fingerprint: `sha256:${"a".repeat(64)}`, processIdentity: `Thu Sep 10 12:00:00 2026 ${command}` };
  const health = { status: "ready", backend: "synthetic", assembly: "same-document-mobile", pid: record.pid, instanceId: record.instanceId, version: { fingerprint: record.fingerprint } };
  await verifyOwned(record, async () => record.processIdentity, async () => health);
  await expect(verifyOwned(record, async () => `different ${command}`, async () => health)).rejects.toThrow();
  for (const changed of [{ pid: 999 }, { instanceId: crypto.randomUUID() }, { backend: "live" }, { version: { fingerprint: `sha256:${"b".repeat(64)}` } }]) await expect(verifyOwned(record, async () => record.processIdentity, async () => ({ ...health, ...changed }))).rejects.toThrow();
  await expect(verifyOwned({ ...record, processIdentity: `${record.processIdentity} --unexpected` }, async () => record.processIdentity, async () => health)).rejects.toThrow();
  let count = 0;
  await expect(verifyOwned(record, async () => ++count === 1 ? record.processIdentity : "reused PID", async () => health)).rejects.toThrow();
});
