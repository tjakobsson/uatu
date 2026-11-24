import { expect, test } from "bun:test";

import { CHAT_REPEAT_CONTINUES, CHAT_STATUS_REPEAT, CHAT_TURN_CONTINUES, isVisualTurnLive } from "./turn-liveness";
import type { ConversationStatus } from "./types";

const STATUSES: ConversationStatus[] = ["idle", "sending", "running", "completed", "interrupted", "failed", "background", "retrying", "compacting", "scheduled"];
const LIVE: ConversationStatus[] = ["sending", "running", "retrying", "compacting"];

test("a turn is capture-live while its status is live, or while a terminal status says the turn continues", () => {
  const live = (annotations: object) => STATUSES.filter(status => isVisualTurnLive({ status, ...annotations }));
  expect(live({})).toEqual(LIVE);
  // A continuing turn keeps a failed status live; a repeat that continues one, a completed status.
  expect(live({ [CHAT_TURN_CONTINUES]: true })).toEqual(STATUSES.filter(status => status === "failed" || LIVE.includes(status)));
  expect(live({ [CHAT_REPEAT_CONTINUES]: true })).toEqual(STATUSES.filter(status => status === "completed" || LIVE.includes(status)));
  // A repeat is not itself a continuation: the projection decides that in order.
  expect(live({ [CHAT_STATUS_REPEAT]: true })).toEqual(LIVE);
});
