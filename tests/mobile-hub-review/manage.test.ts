import { expect, test } from "bun:test";
import { hostingArgs, hostingUrl, restartOwned, verifyOwned, readHealth, managedHostingOptions, manage, type Ownership } from "./manage";
import { frontendFingerprint } from "./hosting-identity";
import { startReviewServer } from "./server";
const syntheticOrigin = "https://review-fixture.example-tailnet.ts.net:8445";

test("manager limits commands and validates restart settings before lifecycle effects", async () => {
  expect(managedHostingOptions([], {})).toEqual({ port: 4703, publicOrigin: undefined });
  expect(hostingArgs(managedHostingOptions([], {}))).toEqual(["--port", "4703"]);
  expect(hostingUrl(managedHostingOptions([], {}))).toBe("http://127.0.0.1:4703");
  expect(managedHostingOptions([], { UATU_MOBILE_REVIEW_PUBLIC_ORIGIN: syntheticOrigin }).publicOrigin).toBe(syntheticOrigin);
  expect(hostingArgs(managedHostingOptions(["--public-origin", syntheticOrigin], {}))).toEqual(["--port", "4703", "--public-origin", syntheticOrigin]);
  expect(hostingUrl(managedHostingOptions(["--public-origin", syntheticOrigin], {}))).toBe(syntheticOrigin);
  expect(managedHostingOptions(["--public-origin", syntheticOrigin, "--port", "4799"], { UATU_MOBILE_REVIEW_PUBLIC_ORIGIN: "invalid", UATU_MOBILE_REVIEW_PORT: "4700" })).toEqual({ port: 4799, publicOrigin: syntheticOrigin });
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
  const command = `${process.execPath} ${new URL("./server.ts", import.meta.url).pathname} --port 4799 --public-origin ${syntheticOrigin}`;
  const record: Ownership = { schema: 1, pid: 12345, port: 4799, publicOrigin: syntheticOrigin, instanceId: crypto.randomUUID(), fingerprint: `sha256:${"a".repeat(64)}`, processIdentity: `Thu Sep 10 12:00:00 2026 ${command}` };
  const health = { status: "ready", backend: "synthetic", assembly: "same-document-mobile", pid: record.pid, instanceId: record.instanceId, version: { fingerprint: record.fingerprint } };
  await verifyOwned(record, async () => record.processIdentity, async () => health);
  const local = { ...record, publicOrigin: undefined, processIdentity: record.processIdentity.replace(` --public-origin ${syntheticOrigin}`, "") };
  await verifyOwned(local, async () => local.processIdentity, async () => health);
  await expect(verifyOwned({ ...local, processIdentity: record.processIdentity }, async () => record.processIdentity, async () => health)).rejects.toThrow();
  await expect(verifyOwned(record, async () => `different ${command}`, async () => health)).rejects.toThrow();
  for (const changed of [{ pid: 999 }, { instanceId: crypto.randomUUID() }, { backend: "live" }, { version: { fingerprint: `sha256:${"b".repeat(64)}` } }]) await expect(verifyOwned(record, async () => record.processIdentity, async () => ({ ...health, ...changed }))).rejects.toThrow();
  await expect(verifyOwned({ ...record, processIdentity: `${record.processIdentity} --unexpected` }, async () => record.processIdentity, async () => health)).rejects.toThrow();
  let count = 0;
  await expect(verifyOwned(record, async () => ++count === 1 ? record.processIdentity : "reused PID", async () => health)).rejects.toThrow();
});

test("restart inherits verified legacy hosting and validates overrides before any stop", async () => {
  const record = { port: 4799, publicOrigin: syntheticOrigin } as Ownership;
  const calls: string[] = [];
  const lifecycle = {
    load: async () => record,
    verify: async () => { calls.push("verify"); },
    stop: async (owned: Ownership) => { expect(owned).toBe(record); calls.push("stop"); },
    start: async (args: string[]) => { calls.push("start"); return args; },
  };
  expect(await restartOwned([], {}, lifecycle)).toEqual(["--port", "4799", "--public-origin", syntheticOrigin]);
  expect(calls).toEqual(["verify", "stop", "start"]);
  calls.length = 0;
  await expect(restartOwned(["--port", "4700"], {}, lifecycle)).rejects.toThrow();
  expect(calls).not.toContain("stop");
  await expect(restartOwned([], { UATU_MOBILE_REVIEW_PUBLIC_ORIGIN: "invalid" }, lifecycle)).rejects.toThrow();
  expect(calls).not.toContain("stop");
  expect(await restartOwned(["--port", "4798"], {}, lifecycle)).toEqual(["--port", "4798", "--public-origin", syntheticOrigin]);
  expect(await restartOwned([], { UATU_MOBILE_REVIEW_PORT: "4797" }, lifecycle)).toEqual(["--port", "4797", "--public-origin", syntheticOrigin]);
  const remoteOverride = syntheticOrigin.replace("8445", "8446");
  expect(await restartOwned([], { UATU_MOBILE_REVIEW_PUBLIC_ORIGIN: remoteOverride }, lifecycle)).toEqual(["--port", "4799", "--public-origin", remoteOverride]);
  expect(await restartOwned(["--public-origin", syntheticOrigin], { UATU_MOBILE_REVIEW_PUBLIC_ORIGIN: remoteOverride }, lifecycle)).toEqual(["--port", "4799", "--public-origin", syntheticOrigin]);
  const local = { ...record, publicOrigin: undefined };
  expect(await restartOwned([], {}, { ...lifecycle, load: async () => local, stop: async owned => { expect(owned).toBe(local); } })).toEqual(["--port", "4799"]);
  await expect(restartOwned([], {}, { ...lifecycle, verify: async () => { throw new Error("unverified"); }, stop: async () => { throw new Error("must not stop"); } })).rejects.toThrow("unverified");
});
