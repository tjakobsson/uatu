import { expect, test } from "bun:test";

import { claudeTextBlockId } from "./claude/normalization-types";
import { CHAT_TEXT_BLOCKS, CHAT_VISUAL_MESSAGE, nativeVisualMessageIdentity, visualAdmissionIdentity, visualCaptureIdentity } from "./visual-identity";

// The capture ledger stores hashes of these strings, so a shipped agent's
// identities must stay byte-identical across releases.
test("native message identities are the persisted strings, for shipped agents and any other", () => {
  expect(nativeVisualMessageIdentity("claude", "msg_01")[CHAT_VISUAL_MESSAGE]).toBe("claude:message:msg_01");
  expect(nativeVisualMessageIdentity("opencode", "msg_01")[CHAT_VISUAL_MESSAGE]).toBe("opencode:message:msg_01");
  expect(nativeVisualMessageIdentity("antigravity", "turn-7")[CHAT_VISUAL_MESSAGE]).toBe("antigravity:message:turn-7");
  expect(nativeVisualMessageIdentity("antigravity", undefined)).toEqual({});
  expect(claudeTextBlockId("msg_01", 2)).toBe("claude:text:msg_01:2");
});

test("admission is shared by a native message's parts, and falls back to the row", () => {
  const row = { id: "part:1", ...nativeVisualMessageIdentity("antigravity", "turn-7") };
  expect(visualAdmissionIdentity(row)).toBe("antigravity:message:turn-7");
  expect(visualAdmissionIdentity({ id: "part:2" })).toBe("part:2");
});

test("captures are identified relative to their native text block, or by the row without blocks", () => {
  const blocks = [{ id: claudeTextBlockId("api", 0), offset: 0 }, { id: claudeTextBlockId("api", 1), offset: 17 }];
  const joined = { id: "message:row", [CHAT_TEXT_BLOCKS]: blocks };
  expect(visualCaptureIdentity(joined, "offset:3")).toEqual({ messageId: "claude:text:api:0", key: "offset:3" });
  expect(visualCaptureIdentity(joined, "offset:20")).toEqual({ messageId: "claude:text:api:1", key: "offset:3" });
  expect(visualCaptureIdentity(joined, "html:1")).toEqual({ messageId: "message:row", key: "html:1" });
  const streamed = { id: "message:stream:api:0", [CHAT_TEXT_BLOCKS]: blocks.slice(0, 1) };
  expect(visualCaptureIdentity(streamed, "html:1")).toEqual({ messageId: "claude:text:api:0", key: "html:1" });
  expect(visualCaptureIdentity({ id: "part:1", ...nativeVisualMessageIdentity("antigravity", "turn-7") }, "offset:3")).toEqual({ messageId: "part:1", key: "offset:3" });
});
