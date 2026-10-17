import { expect, test } from "bun:test";

import { FakeE2EChatService } from "./chat-service";

test("Claude-shaped Send now applies the chosen message's frozen configuration and leaves the dormant backlog in order", async () => {
  const service = new FakeE2EChatService({ extraCapabilities: ["send-now"] });
  const { conversation: { id } } = await service.createConversation();
  await service.prompt(id, "start", "Start");
  await service.prompt(id, "first", "Held first");
  const chosen = await service.prompt(id, "chosen", "Chosen", { providerId: "anthropic", modelId: "claude-sonnet" }, "plan", "high");
  await service.prompt(id, "last", "Held last", { providerId: "openai", modelId: "gpt-5" }, "build");
  await service.cancel(id, "cancel");
  const result = await service.sendNow(id, chosen.messageId, "send-now");
  expect((await service.history(id)).configuration).toEqual({ model: { providerId: "anthropic", modelId: "claude-sonnet" }, mode: "plan", variant: "high" });
  expect((await service.history(id)).queued).toMatchObject([{ text: "Held first", paused: true }, { text: "Held last", paused: true }]);
  expect(await service.sendNow(id, chosen.messageId, "send-now")).toEqual(result);
  service.publishStatus(id, "completed");
  const snapshot = await service.history(id);
  expect(snapshot.queued).toHaveLength(2);
  expect(snapshot.items.filter(item => item.type === "user_message" && item.text === "Chosen")).toHaveLength(1);
});
