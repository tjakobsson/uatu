import { expect, test } from "bun:test";

import {
  CHAT_OPERATION_RECEIPT_HEADER,
  HUB_HEADER_PREFIX,
  isHubHeader,
  PAGE_ORIGIN_HEADER,
  SESSION_REPLAY_RESYNC_HEADER,
  validChatOperationReceipt,
} from "./headers";
import { CHILD_POLICY_HEADER } from "./policy";

test("the header names on the wire are unchanged", () => {
  expect(HUB_HEADER_PREFIX).toBe("x-uatu-hub-");
  expect(CHILD_POLICY_HEADER).toBe("x-uatu-hub-chat-policy");
  expect(CHAT_OPERATION_RECEIPT_HEADER).toBe("x-uatu-hub-operation-receipt");
  expect(SESSION_REPLAY_RESYNC_HEADER).toBe("x-uatu-chat-replay-resync-cursor");
  expect(PAGE_ORIGIN_HEADER).toBe("X-Uatu-Page-Origin");
});

test("Hub-only headers are recognised in any case and nothing else is", () => {
  expect(isHubHeader(CHILD_POLICY_HEADER)).toBe(true);
  expect(isHubHeader(CHAT_OPERATION_RECEIPT_HEADER)).toBe(true);
  expect(isHubHeader("X-Uatu-Hub-Principal")).toBe(true);
  expect(isHubHeader(SESSION_REPLAY_RESYNC_HEADER)).toBe(false);
  expect(isHubHeader(PAGE_ORIGIN_HEADER)).toBe(false);
  expect(isHubHeader("x-hub-user")).toBe(false);
});

test("an operation receipt is the opr_ prefix and 43 base64url characters", () => {
  expect(validChatOperationReceipt(`opr_${"a".repeat(43)}`)).toBe(true);
  expect(validChatOperationReceipt(`opr_${"a".repeat(42)}`)).toBe(false);
  expect(validChatOperationReceipt("opr_forged")).toBe(false);
});

// The browser bundle cannot import the contract, so the terminal client
// repeats the page-origin header name as a literal.
test("the terminal client sends the contract's page-origin header", async () => {
  const client = await Bun.file(new URL("../terminal/client.ts", import.meta.url)).text();
  const literals = [...client.matchAll(/headers:\s*\{\s*"([^"]+)":\s*window\.location\.origin\s*\}/g)].map(match => match[1]!);
  expect(literals).toEqual([PAGE_ORIGIN_HEADER]);
});
