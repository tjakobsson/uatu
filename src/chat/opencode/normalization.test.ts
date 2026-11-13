import { expect, test } from "bun:test";
import { normalizeEventWith, providerEventEnvelope, sessionLifecycleIdentity, type GenerationMapper } from "./normalization";

test("canonical envelope readers preserve nullish payload and session identity precedence", () => {
  const properties = { sessionId: "alias", info: { id: "nested" } };
  for (const data of [undefined, null]) expect(providerEventEnvelope({ type: "session.updated", data, properties }).context.conversationId).toBe("alias");
  expect(providerEventEnvelope({ data: {}, properties }).data).toEqual({});
  expect(providerEventEnvelope({ data: { sessionID: "primary", sessionId: "alias" } }).context.conversationId).toBe("primary");
  expect(sessionLifecycleIdentity({ sessionID: "primary", info: { id: "nested" } })).toBe("nested");
  expect(sessionLifecycleIdentity({ sessionID: "primary", info: { id: "" } })).toBeUndefined();
});

test("envelope extraction preserves malformed-payload outcomes and fallback lifecycle identity", () => {
  const mapper: GenerationMapper = { own: () => undefined, toCanonical: () => undefined, ignored: new Set() };
  const malformed = { type: "session.updated", get data() { throw new Error("Invalid payload"); } };
  expect(normalizeEventWith(malformed, mapper)).toMatchObject({ eventType: "session.updated", outcome: "unparseable", updates: [] });
  expect(normalizeEventWith({ type: "unknown", properties: { info: { id: "nested" } } }, mapper)).toMatchObject({ conversationId: "nested", outcome: "unrecognized", updates: [] });
});
