import { expect, test } from "bun:test";

import type { NormalizedProviderUpdate } from "../../src/chat/provider";
import { CHAT_STATUS_REPEAT, CHAT_TEXT_SEAL, CHAT_TURN, CHAT_TURN_CONTINUES, executionEvidence, provisionalTurn, type ChatTurnToken } from "../../src/chat/turn-liveness";
import type { AssistantMessageItem } from "../../src/chat/types";
import { livenessChecker, livenessConformance } from "./liveness-conformance";

const status = (value: NormalizedProviderUpdate & { kind: "status" }, flags: object) => ({ ...value, ...flags }) as NormalizedProviderUpdate;
const reply = (token: object) => ({ id: "reply", type: "assistant_message", createdAt: 1, markdown: "", ...token }) as AssistantMessageItem;

test("the conformance check accepts the contract's shapes", () => {
  expect(livenessConformance([
    status({ kind: "status", status: "completed" }, { [CHAT_STATUS_REPEAT]: true }),
    status({ kind: "status", status: "failed" }, { [CHAT_TURN_CONTINUES]: true }),
    status({ kind: "status", status: "running" }, {}),
    reply({ [CHAT_TURN]: provisionalTurn() }),
  ])).toMatchObject({ mixed: [], both: 0, repeatOffCompleted: 0, continuesOffFailed: 0, repeats: 1, continuations: 1 });
});

test("the conformance check catches each violation", () => {
  for (const value of ["running", "failed", "interrupted"] as const) {
    expect(livenessConformance([status({ kind: "status", status: value }, { [CHAT_STATUS_REPEAT]: true })]).repeatOffCompleted).toBe(1);
  }
  for (const value of ["retrying", "completed", "interrupted"] as const) {
    expect(livenessConformance([status({ kind: "status", status: value }, { [CHAT_TURN_CONTINUES]: true })]).continuesOffFailed).toBe(1);
  }
  for (const value of ["completed", "failed"] as const) {
    expect(livenessConformance([status({ kind: "status", status: value }, { [CHAT_STATUS_REPEAT]: true, [CHAT_TURN_CONTINUES]: true })]).both).toBe(1);
  }
  expect(livenessConformance([reply({ [CHAT_TURN]: provisionalTurn() }), reply(executionEvidence(true))]).mixed).toEqual(["reply"]);
});

test("the conformance check catches reply facts that change on a later text update", () => {
  const text = (facts: object, mode: "cumulative" | "incremental" = "incremental"): NormalizedProviderUpdate => ({ kind: "text", itemId: "reply", identity: "reply", mode, text: "![shot]", item: reply(facts) });
  const token = { [CHAT_TURN]: provisionalTurn() };
  // Repeating the facts the row was created with, or omitting them, is fine.
  expect(livenessConformance([text(token), text(token), text({})]).textFactChanges).toEqual([]);
  expect(livenessConformance([{ kind: "upsert", item: reply({ [CHAT_TEXT_SEAL]: "ended" }) }, text({ [CHAT_TEXT_SEAL]: "ended" })]).textFactChanges).toEqual([]);
  // A seal that first appears on a later delta, or a changed completion time or token, is caught.
  expect(livenessConformance([text({}), text({ [CHAT_TEXT_SEAL]: "ended" })]).textFactChanges).toEqual(["reply"]);
  expect(livenessConformance([text({}), text({ [CHAT_TEXT_SEAL]: "completion", completedAt: 5 }, "cumulative")]).textFactChanges).toEqual(["reply"]);
  expect(livenessConformance([text(token), text({ [CHAT_TURN]: { completed: true, authority: "provisional" } })]).textFactChanges).toEqual(["reply"]);
  // So is a token object swapped for another in the same state: the token changes only on a whole item.
  expect(livenessConformance([text(token), text({ [CHAT_TURN]: provisionalTurn() })]).textFactChanges).toEqual(["reply"]);
  // A token first appearing on a later delta is a change too.
  expect(livenessConformance([text({}), text(token)]).textFactChanges).toEqual(["reply"]);
  // A removed row is recreated with fresh facts, so a seal on a later delta is caught again.
  expect(livenessConformance([{ kind: "upsert", item: reply({ [CHAT_TEXT_SEAL]: "ended" }) }, { kind: "remove", itemId: "reply" }, text({}), text({ [CHAT_TEXT_SEAL]: "ended" })]).textFactChanges).toEqual(["reply"]);
  // Removal keeps the token-kind history: a recreated reply cannot switch kinds.
  expect(livenessConformance([text(token), { kind: "remove", itemId: "reply" }, { kind: "upsert", item: reply(executionEvidence(false)) }]).mixed).toEqual(["reply"]);
  // An upsert may change them.
  expect(livenessConformance([text({}), { kind: "upsert", item: reply({ [CHAT_TEXT_SEAL]: "ended" }) }]).textFactChanges).toEqual([]);
});

test("the conformance check allows a provisional token to close only at a genuine turn boundary", () => {
  const text = (id: string, turn: object): NormalizedProviderUpdate => ({ kind: "text", itemId: id, identity: id, mode: "incremental", text: "x", item: { ...reply(turn), id } });
  // Closes the shared token while normalizing `frame`, as a normalizer would.
  const closing = (frame: NormalizedProviderUpdate[], options?: { turnEnd?: boolean }, token: { completed: boolean } & object = provisionalTurn(), close = true) => {
    const checker = livenessChecker();
    checker.observe([text("reply", { [CHAT_TURN]: token })]);
    if (close) token.completed = !token.completed;
    checker.observe(frame, options);
    return checker.result();
  };
  const completed = status({ kind: "status", status: "completed" }, {});
  // Genuine boundaries: a completed, failed or interrupted status that neither
  // continues nor repeats (under D1's precedence), or a declared native turn end.
  for (const boundary of [completed, status({ kind: "status", status: "failed" }, {}), status({ kind: "status", status: "interrupted" }, { [CHAT_TURN_CONTINUES]: true }),
    status({ kind: "status", status: "completed" }, { [CHAT_TURN_CONTINUES]: true }), status({ kind: "status", status: "failed" }, { [CHAT_STATUS_REPEAT]: true })]) {
    expect(closing([boundary]).tokenChanges).toEqual([]);
  }
  expect(closing([], { turnEnd: true }).tokenChanges).toEqual([]);
  // Not boundaries: a retryable failure, a completed repeat, a frame without either.
  expect(closing([status({ kind: "status", status: "failed" }, { [CHAT_TURN_CONTINUES]: true })]).tokenChanges).toEqual(["reply"]);
  expect(closing([status({ kind: "status", status: "completed" }, { [CHAT_STATUS_REPEAT]: true })]).tokenChanges).toEqual(["reply"]);
  expect(closing([text("other", {})]).tokenChanges).toEqual(["reply"]); // The frame does not carry the row.
  expect(closing([]).tokenChanges).toEqual(["reply"]);
  // Reopening in place is never legal, nor any in-place change of an authoritative token.
  expect(closing([completed], undefined, { completed: true, authority: "provisional" } as ChatTurnToken).tokenChanges).toEqual(["reply"]);
  expect(closing([completed], undefined, { completed: false, authority: "authoritative" } as ChatTurnToken).tokenChanges).toEqual(["reply"]);
  // An untouched token is fine on any frame.
  expect(closing([], undefined, provisionalTurn(), false).tokenChanges).toEqual([]);
});

test("the conformance check catches a token flipped in place on a later delta", () => {
  const text = (turn: object): NormalizedProviderUpdate => ({ kind: "text", itemId: "reply", identity: "reply", mode: "incremental", text: "x", item: reply(turn) });
  const flipped = livenessChecker(), shared = provisionalTurn();
  flipped.observe([text({ [CHAT_TURN]: shared })]);
  shared.completed = true;
  flipped.observe([text({ [CHAT_TURN]: shared })]);
  expect(flipped.result().tokenChanges).toEqual(["reply"]);
});
