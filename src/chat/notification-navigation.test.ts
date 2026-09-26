import { expect, test } from "bun:test";
import { carryNotificationTarget, notificationAwaiting, notificationConversation } from "./notification-navigation";

test("conversation destinations require a bounded agent-qualified identity", () => {
  expect(notificationConversation("?conversation=claude%3Aone")).toBe("claude:one");
  for (const value of ["", "?conversation=one", "?conversation=%3Aone", "?conversation=claude%3A%00", `?conversation=claude:${"x".repeat(1024)}`]) expect(notificationConversation(value)).toBeNull();
});

test("document and commit navigation keep the conversation without carrying unrelated queries", () => {
  expect(carryNotificationTarget("/s/project/readme.md#heading", "?conversation=opencode%3Aone&t=secret")).toBe("/s/project/readme.md?conversation=opencode%3Aone#heading");
  expect(carryNotificationTarget("/s/project/?commit=abc", "?conversation=claude%3Aone")).toBe("/s/project/?commit=abc&conversation=claude%3Aone");
  expect(carryNotificationTarget("/s/project/readme.md", "?anything=else")).toBe("/s/project/readme.md");
});

test("an awaiting destination is carried like a conversation, and a conversation wins over it", () => {
  expect(notificationAwaiting("?awaiting=1")).toBe(true);
  for (const value of ["", "?awaiting=0", "?awaiting=true", "?awaiting"]) expect(notificationAwaiting(value)).toBe(false);
  expect(carryNotificationTarget("/s/project/readme.md#top", "?awaiting=1&t=secret")).toBe("/s/project/readme.md?awaiting=1#top");
  expect(carryNotificationTarget("/s/project/", "?awaiting=1&conversation=claude%3Aone")).toBe("/s/project/?conversation=claude%3Aone");
  expect(carryNotificationTarget("/s/project/", "?awaiting=0")).toBe("/s/project/");
});
