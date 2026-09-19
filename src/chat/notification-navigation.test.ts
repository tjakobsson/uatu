import { expect, test } from "bun:test";
import { carryNotificationConversation, notificationConversation } from "./notification-navigation";

test("conversation destinations require a bounded agent-qualified identity", () => {
  expect(notificationConversation("?conversation=claude%3Aone")).toBe("claude:one");
  for (const value of ["", "?conversation=one", "?conversation=%3Aone", "?conversation=claude%3A%00", `?conversation=claude:${"x".repeat(1024)}`]) expect(notificationConversation(value)).toBeNull();
});

test("document and commit navigation keep the conversation without carrying unrelated queries", () => {
  expect(carryNotificationConversation("/s/project/readme.md#heading", "?conversation=opencode%3Aone&t=secret")).toBe("/s/project/readme.md?conversation=opencode%3Aone#heading");
  expect(carryNotificationConversation("/s/project/?commit=abc", "?conversation=claude%3Aone")).toBe("/s/project/?commit=abc&conversation=claude%3Aone");
  expect(carryNotificationConversation("/s/project/readme.md", "?anything=else")).toBe("/s/project/readme.md");
});
