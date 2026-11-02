import { expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { revealWorkerRequest } from "./worker-dismissal-client-request";
import type { ConversationItem } from "./types";

test.each(["permission", "question"] as const)("worker reveals and focuses the same canonical %s without answering", kind => {
  const { document } = parseHTML('<html><body><details id="card"><summary>Request</summary><button id="answer">Answer</button></details></body></html>');
  const card = document.getElementById("card")! as unknown as HTMLDetailsElement;
  let focused = 0; let revealed = "";
  const answer = card.querySelector<HTMLButtonElement>("button")!;
  answer.focus = () => { focused++; };
  const common = { id: "canonical-card", requestId: "native-request", status: "pending" as const, createdAt: 1 };
  const request: ConversationItem = kind === "question" ? { ...common, type: kind, questions: [] } : { ...common, type: kind, action: "read", resources: [] };
  const before = JSON.stringify(request);
  expect(revealWorkerRequest({ kind: "needs-answer", request: { kind, id: "native-request" } }, [request], id => { revealed = id; return card; })).toBe(true);
  expect(revealed).toBe("canonical-card"); expect(card.open).toBe(true); expect(focused).toBe(1);
  expect(card.querySelectorAll("button")).toHaveLength(1);
  expect(JSON.stringify(request)).toBe(before);
});

test("no child-session or request-kind heuristic can redirect a worker request", () => {
  const request: ConversationItem = { type: "permission", id: "same-child", requestId: "native", conversationId: "same-child", status: "pending", createdAt: 1, action: "read", resources: [] };
  const reveal = () => { throw new Error("unrelated request was revealed"); };
  expect(revealWorkerRequest({ kind: "session-active" }, [request], reveal)).toBe(false);
  expect(revealWorkerRequest({ kind: "needs-answer", request: { id: "native", kind: "question" } }, [request], reveal)).toBe(false);
  expect(revealWorkerRequest({ kind: "needs-answer", request: { id: "foreign", kind: "permission" } }, [request], reveal)).toBe(false);
  expect(revealWorkerRequest({ kind: "needs-answer", request: { id: "native", kind: "permission" } }, [request, { ...request, id: "another-card", conversationId: "other-child" }], reveal)).toBe(false);
});
