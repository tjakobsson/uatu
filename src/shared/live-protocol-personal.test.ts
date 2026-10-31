import { expect, test } from "bun:test";
import { parseLiveEnvelope, parseLiveStreamQuery, parseLiveSubscriptionChange } from "./live-protocol";

test("personal subscription is selector-free and always drops replay cursors", () => {
  expect(parseLiveSubscriptionChange({ add: [{ topic: "personal", cursor: "old" }] })).toEqual({ add: [{ topic: "personal" }] });
  expect(parseLiveStreamQuery(new URLSearchParams({ ws: "ws", subs: '[{"topic":"personal","cursor":"old"}]' }))).toMatchObject({ subs: [{ topic: "personal" }] });
  for (const selector of [{ key: "other" }, { user: "bob" }, { workspaceId: "other" }]) expect(parseLiveSubscriptionChange({ add: [{ topic: "personal", ...selector }] })).toHaveProperty("error");
});

test("personal envelopes admit only the fixed category without cursor, selectors or marks", () => {
  const envelope = { ws: "ws", topic: "personal", cursor: "", event: { kind: "data", data: { category: "worker-dismissals" } } } as const;
  expect(parseLiveEnvelope(JSON.stringify(envelope))).toEqual(envelope);
  for (const kind of ["ready", "unavailable"]) expect(parseLiveEnvelope(JSON.stringify({ ...envelope, event: { kind } }))).toMatchObject({ event: { kind } });
  for (const change of [
    { cursor: "old" }, { key: "parent" }, { event: { kind: "resync" } }, { event: { kind: "unavailable", data: "private error" } },
    { event: { kind: "data", data: { category: "other" } } },
    { event: { kind: "data", data: { category: "worker-dismissals", marks: [] } } },
  ]) expect(parseLiveEnvelope(JSON.stringify({ ...envelope, ...change }))).toBeNull();
});
