import { expect, test } from "bun:test";
import { HubOperationReceipts } from "./operation-receipts";

const input = { principal: "alice", method: "POST", pathname: "/s/project/api/chat/conversations/opencode:parent/prompts", requestId: "client-id" };

test("opaque operation identity binds account/action/id and rotates independently on recreation", async () => {
  const receipts = new HubOperationReceipts();
  const first = await receipts.identify(input, true);
  expect(first.token).toMatch(/^opr_[A-Za-z0-9_-]{43}$/);
  expect(await receipts.identify(input, false)).toEqual(first);
  expect((await receipts.identify({ ...input, pathname: input.pathname.replace("opencode:parent", "opencode%3Aparent") }, false)).token).toBe(first.token);
  for (const changed of [{ principal: "bob" }, { method: "PATCH" }, { pathname: input.pathname + "/different" }, { requestId: "other-id" }]) {
    expect((await receipts.identify({ ...input, ...changed }, true)).token).not.toBe(first.token);
  }
  expect((await new HubOperationReceipts().identify(input, true)).token).not.toBe(first.token);
  expect(JSON.stringify(first)).not.toMatch(/alice|principal|receiptScope|secret/);
});

test("first degraded feedback snapshot expires at its bounded Hub TTL, not a durable replay promise", async () => {
  let now = 0;
  const receipts = new HubOperationReceipts({ now: () => now });
  const first = await receipts.identify(input, true);
  now = 899_999;
  expect(await receipts.identify(input, false)).toEqual(first);
  now = 900_000;
  expect(await receipts.identify(input, false)).toEqual({ token: first.token, unavailable: false });
});

for (const options of [{ maxEntries: 1 }, { maxBytes: 180 }]) test(`degraded feedback snapshot protection ends at ${JSON.stringify(options)} eviction`, async () => {
  const receipts = new HubOperationReceipts(options);
  const first = await receipts.identify(input, true);
  await receipts.identify({ ...input, requestId: "evict-first" }, true);
  expect(await receipts.identify(input, false)).toEqual({ token: first.token, unavailable: false });
});
