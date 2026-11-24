import { describe, expect, test } from "bun:test";
import type { NormalizedProviderEvent, PendingQuestion } from "./provider";
import { INTERRUPTED_REASON, SUPERSEDED_REASON, PendingInteractions, type CancellationTrigger } from "./pending-interactions";
import type { PermissionRequest, QuestionRequest } from "./types";

type Emitted = { conversationId: string } & Omit<NormalizedProviderEvent, "conversationId">;

function holder<Detail = { note: string }>() {
  const emitted: Emitted[] = [];
  const log: string[] = [];
  const reported: unknown[] = [];
  const interactions = new PendingInteractions<Detail>((conversationId, event) => {
    emitted.push({ conversationId, ...event });
    log.push(`emit ${event.eventType}`);
  }, { report: error => reported.push(error) });
  return { interactions, emitted, log, reported };
}

function permission(requestId: string, extra: Partial<PermissionRequest> = {}): PermissionRequest {
  return { id: `permission:${requestId}`, type: "permission", createdAt: 1, requestId, action: "Write a.txt", resources: ["/a.txt"], status: "pending", ...extra };
}

function question(requestId: string, extra: Partial<QuestionRequest> = {}): QuestionRequest {
  return { id: `question:${requestId}`, type: "question", createdAt: 1, requestId, questions: [{ prompt: "Pick", header: "P", options: [], multiple: false, allowFreeForm: true }], status: "pending", ...extra };
}

const never: CancellationTrigger = () => () => undefined;

describe("PendingInteractions", () => {
  test("registration announces the card and makes the request answerable; an answer resolves it and emits nothing", async () => {
    const { interactions, emitted } = holder();
    const item = permission("t1");
    const result = interactions.await({ conversationId: "c1", item, detail: { note: "kept" }, cancellation: never, abandoned: reason => `abandoned: ${reason}` });
    expect(emitted).toEqual([{ conversationId: "c1", updates: [{ kind: "upsert", item }], outcome: "handled", eventType: "interaction.requested" }]);
    const pending = interactions.require("c1", "t1", "permission");
    expect(pending).toEqual(expect.objectContaining({ requestId: "t1", conversationId: "c1", kind: "permission", item, detail: { note: "kept" } }));
    pending.settle("allowed");
    expect(await result).toBe("allowed");
    expect(emitted.map(event => event.eventType)).toEqual(["interaction.requested"]);
    expect(interactions.list("permission")).toEqual([]);
  });

  test("a request settles once: later answers, abandonment and a late trigger are ignored", async () => {
    const { interactions, emitted } = holder();
    const abort = new AbortController();
    const result = interactions.await({ conversationId: "c1", item: question("q1"), detail: { note: "" }, cancellation: abort.signal, abandoned: () => "abandoned" });
    const pending = interactions.require("c1", "q1", "question");
    pending.settle("first");
    pending.settle("second");
    pending.abandon("too late");
    interactions.abandon("c1", "too late");
    abort.abort();
    expect(await result).toBe("first");
    expect(emitted.map(event => event.eventType)).toEqual(["interaction.requested"]);
    expect(() => interactions.require("c1", "q1", "question")).toThrow("no pending question q1 for this conversation");
  });

  test("concurrent replies: both may look the request up, the first to settle wins", async () => {
    const { interactions } = holder();
    const result = interactions.await({ conversationId: "c1", item: permission("t1"), detail: { note: "" }, cancellation: never, abandoned: () => "abandoned" });
    const first = interactions.require("c1", "t1", "permission");
    const second = interactions.require("c1", "t1", "permission");
    second.settle("second");
    first.settle("first");
    expect(await result).toBe("second");
    // A reply arriving after the settle no longer finds the request.
    expect(() => interactions.require("c1", "t1", "permission")).toThrow("no pending permission t1 for this conversation");
  });

  test("a lookup naming an unknown request, another conversation or another kind throws today's message", () => {
    const { interactions } = holder();
    void interactions.await({ conversationId: "c1", item: permission("t1"), detail: { note: "" }, cancellation: never, abandoned: () => "abandoned" });
    expect(() => interactions.require("c1", "t9", "permission")).toThrow(new Error("no pending permission t9 for this conversation"));
    expect(() => interactions.require("c2", "t1", "permission")).toThrow(new Error("no pending permission t1 for this conversation"));
    expect(() => interactions.require("c1", "t1", "question")).toThrow(new Error("no pending question t1 for this conversation"));
    // A refused lookup leaves the request pending.
    expect(interactions.require("c1", "t1", "permission").requestId).toBe("t1");
  });

  test("an abort signal firing later abandons with the interrupted reason: the card resolves rejected, then the result is delivered", async () => {
    const { interactions, emitted, log } = holder();
    const abort = new AbortController();
    const item = permission("t1");
    const result = interactions.await({ conversationId: "c1", item, detail: { note: "" }, cancellation: abort.signal, abandoned: reason => { log.push(`abandoned ${reason}`); return reason; } })
      .then(value => { log.push("resolved"); return value; });
    abort.abort();
    expect(await result).toBe(INTERRUPTED_REASON);
    expect(log).toEqual(["emit interaction.requested", `abandoned ${INTERRUPTED_REASON}`, "emit interaction.abandoned", "resolved"]);
    expect(emitted[1]).toEqual({ conversationId: "c1", updates: [{ kind: "upsert", item: { ...item, status: "resolved", outcome: "rejected" } }], outcome: "handled", eventType: "interaction.abandoned" });
    expect(interactions.list("permission")).toEqual([]);
  });

  test("an already-aborted signal settles at once and the request is never announced", async () => {
    const { interactions, emitted } = holder();
    const abort = new AbortController();
    abort.abort();
    const item = question("q1");
    const result = interactions.await({ conversationId: "c1", item, detail: { note: "" }, cancellation: abort.signal, abandoned: reason => reason });
    expect(emitted).toEqual([{ conversationId: "c1", updates: [{ kind: "upsert", item: { ...item, status: "resolved", outcome: { kind: "rejected" } } }], outcome: "handled", eventType: "interaction.abandoned" }]);
    expect(await result).toBe(INTERRUPTED_REASON);
    expect(interactions.list("question")).toEqual([]);
  });

  test("an explicit trigger: cancel abandons, and every settle unsubscribes exactly once", async () => {
    const { interactions, emitted } = holder();
    const cancels = new Map<string, () => void>();
    const unsubscribed: string[] = [];
    const trigger = (id: string): CancellationTrigger => cancel => {
      cancels.set(id, cancel);
      return () => unsubscribed.push(id);
    };
    const mapped: string[] = [];
    const mapper = (id: string) => (reason: string) => { mapped.push(id); return reason; };
    const cancelled = interactions.await({ conversationId: "c1", item: permission("t1"), detail: { note: "" }, cancellation: trigger("t1"), abandoned: mapper("t1") });
    const answered = interactions.await({ conversationId: "c1", item: permission("t2"), detail: { note: "" }, cancellation: trigger("t2"), abandoned: mapper("t2") });
    cancels.get("t1")!();
    expect(await cancelled).toBe(INTERRUPTED_REASON);
    interactions.require("c1", "t2", "permission").settle("allowed");
    expect(await answered).toBe("allowed");
    // A trigger that fires after its request settled changes nothing and
    // never reaches the agent's mapper.
    cancels.get("t1")!();
    cancels.get("t2")!();
    expect(mapped).toEqual(["t1"]);
    expect(unsubscribed).toEqual(["t1", "t2"]);
    expect(emitted.map(event => [event.eventType, (event.updates[0] as { item: { requestId: string } }).item.requestId])).toEqual([
      ["interaction.requested", "t1"],
      ["interaction.requested", "t2"],
      ["interaction.abandoned", "t1"],
    ]);
  });

  test("a cancel an explicit trigger delivers during its subscription runs after the registration: announced, then abandoned, released once", async () => {
    const { interactions, emitted } = holder();
    let unsubscribed = 0;
    let registered: string[] = [];
    const result = interactions.await({
      conversationId: "c1",
      item: permission("t1"),
      detail: { note: "" },
      cancellation: cancel => {
        // Registered before the trigger is observed.
        registered = interactions.list("permission").map(pending => pending.requestId);
        cancel();
        return () => { unsubscribed += 1; };
      },
      abandoned: reason => reason,
    });
    expect(await result).toBe(INTERRUPTED_REASON);
    expect(registered).toEqual(["t1"]);
    expect(unsubscribed).toBe(1);
    expect(emitted.map(event => event.eventType)).toEqual(["interaction.requested", "interaction.abandoned"]);
    expect(interactions.list("permission")).toEqual([]);
  });

  test("abandoning a conversation ends only its requests, in registration order, with the given reason", async () => {
    const { interactions, emitted } = holder();
    const register = (conversationId: string, item: PermissionRequest | QuestionRequest) =>
      interactions.await({ conversationId, item, detail: { note: "" }, cancellation: never, abandoned: reason => `${item.requestId}: ${reason}` });
    const first = register("c1", permission("t1"));
    const other = register("c2", permission("t2"));
    const second = register("c1", question("q1"));
    interactions.abandon("c1", "The session ended before the user answered.");
    expect(await first).toBe("t1: The session ended before the user answered.");
    expect(await second).toBe("q1: The session ended before the user answered.");
    expect(emitted.filter(event => event.eventType === "interaction.abandoned").map(event => [event.conversationId, (event.updates[0] as { item: { requestId: string } }).item.requestId]))
      .toEqual([["c1", "t1"], ["c1", "q1"]]);
    expect(interactions.list("permission").map(pending => pending.requestId)).toEqual(["t2"]);
    interactions.require("c2", "t2", "permission").settle("allowed");
    expect(await other).toBe("allowed");
  });

  test("the lists cover every conversation, split by kind, and carry exactly the fields the card has", () => {
    const { interactions } = holder();
    const register = (conversationId: string, item: PermissionRequest | QuestionRequest) =>
      void interactions.await({ conversationId, item, detail: { note: "" }, cancellation: never, abandoned: () => undefined });
    register("c1", permission("t1"));
    register("c2", permission("t2", {
      alwaysPatterns: ["Allow: Write(/a.txt)"],
      diff: "--- a\n+++ b",
      plan: "steps",
      choices: [{ id: "implement", label: "Approve and implement" }],
      sourceToolId: "tool:t2",
      mcp: { server: "github", tool: "search" },
      queueOrder: 3,
      conversationId: "c2",
    }));
    register("c1", question("q1"));
    register("c2", question("q2", { source: "elicitation", intro: "github asks: Sign in", link: "https://example.com", schema: { type: "object" } }));
    expect(interactions.list("permission")).toEqual([
      { requestId: "t1", conversationId: "c1", action: "Write a.txt", resources: ["/a.txt"] },
      {
        requestId: "t2",
        conversationId: "c2",
        action: "Write a.txt",
        resources: ["/a.txt"],
        alwaysPatterns: ["Allow: Write(/a.txt)"],
        diff: "--- a\n+++ b",
        plan: "steps",
        choices: [{ id: "implement", label: "Approve and implement" }],
        sourceToolId: "tool:t2",
        mcp: { server: "github", tool: "search" },
      },
    ]);
    expect(interactions.list("question")).toEqual([
      { requestId: "q1", conversationId: "c1", questions: [expect.objectContaining({ prompt: "Pick" })] },
      { requestId: "q2", conversationId: "c2", questions: [expect.objectContaining({ prompt: "Pick" })], source: "elicitation", intro: "github asks: Sign in", link: "https://example.com", schema: { type: "object" } },
    ]);
  });

  test("the same request id in two conversations names two requests, each answerable, listed and abandoned on its own", async () => {
    const { interactions } = holder();
    const first = interactions.await({ conversationId: "c1", item: permission("1"), detail: { note: "" }, cancellation: never, abandoned: reason => reason });
    const second = interactions.await({ conversationId: "c2", item: permission("1"), detail: { note: "" }, cancellation: never, abandoned: reason => reason });
    expect(interactions.list("permission").map(pending => [pending.conversationId, pending.requestId])).toEqual([["c1", "1"], ["c2", "1"]]);
    interactions.abandon("c1", "ended");
    expect(await first).toBe("ended");
    expect(interactions.list("permission").map(pending => pending.conversationId)).toEqual(["c2"]);
    interactions.require("c2", "1", "permission").settle("allowed");
    expect(await second).toBe("allowed");
  });

  test("a permission and a question sharing a request id stay apart", async () => {
    const { interactions } = holder();
    const asked = interactions.await({ conversationId: "c1", item: permission("1"), detail: { note: "" }, cancellation: never, abandoned: reason => reason });
    const questioned = interactions.await({ conversationId: "c1", item: question("1"), detail: { note: "" }, cancellation: never, abandoned: reason => reason });
    expect(interactions.list("permission").map(pending => pending.requestId)).toEqual(["1"]);
    expect(interactions.list("question").map(pending => pending.requestId)).toEqual(["1"]);
    interactions.require("c1", "1", "question").settle("answered");
    expect(await questioned).toBe("answered");
    interactions.require("c1", "1", "permission").settle("allowed");
    expect(await asked).toBe("allowed");
  });

  describe("an unsubscribe that throws", () => {
    const throwing: CancellationTrigger = () => () => { throw new Error("unsubscribe failed"); };

    test("does not stop an answer from settling", async () => {
      const { interactions } = holder();
      const result = interactions.await({ conversationId: "c1", item: permission("t1"), detail: { note: "" }, cancellation: throwing, abandoned: reason => reason });
      expect(() => interactions.require("c1", "t1", "permission").settle("allowed")).not.toThrow();
      expect(await result).toBe("allowed");
      expect(interactions.list("permission")).toEqual([]);
    });

    test("does not stop an abandonment from being announced and settled", async () => {
      const { interactions, emitted } = holder();
      const result = interactions.await({ conversationId: "c1", item: permission("t1"), detail: { note: "" }, cancellation: throwing, abandoned: reason => reason });
      expect(() => interactions.require("c1", "t1", "permission").abandon("ended")).not.toThrow();
      expect(await result).toBe("ended");
      expect(emitted.map(event => event.eventType)).toEqual(["interaction.requested", "interaction.abandoned"]);
    });

    test("does not stop a conversation's abandonment from reaching its later requests", async () => {
      const { interactions, emitted } = holder();
      const results = [
        interactions.await({ conversationId: "c1", item: permission("t1"), detail: { note: "" }, cancellation: throwing, abandoned: reason => `t1 ${reason}` }),
        interactions.await({ conversationId: "c1", item: question("q1"), detail: { note: "" }, cancellation: throwing, abandoned: reason => `q1 ${reason}` }),
        interactions.await({ conversationId: "c1", item: permission("t2"), detail: { note: "" }, cancellation: never, abandoned: reason => `t2 ${reason}` }),
      ];
      expect(() => interactions.abandon("c1", "ended")).not.toThrow();
      expect(await Promise.all(results)).toEqual(["t1 ended", "q1 ended", "t2 ended"]);
      expect(emitted.filter(event => event.eventType === "interaction.abandoned")).toHaveLength(3);
      expect([...interactions.list("permission"), ...interactions.list("question")]).toEqual([]);
    });

    test("does not stop a cancel delivered during subscription from settling the request", async () => {
      const { interactions, emitted } = holder();
      const result = interactions.await({
        conversationId: "c1",
        item: permission("t1"),
        detail: { note: "" },
        cancellation: cancel => { cancel(); return () => { throw new Error("unsubscribe failed"); }; },
        abandoned: reason => reason,
      });
      expect(await result).toBe(INTERRUPTED_REASON);
      expect(emitted.map(event => event.eventType)).toEqual(["interaction.requested", "interaction.abandoned"]);
    });
  });

  describe("a redelivered request while its original waits", () => {
    function redelivered() {
      const fixture = holder();
      const abort = new AbortController();
      const unsubscribed: string[] = [];
      const mapped: string[] = [];
      let cancelOriginal: (() => void) | undefined;
      const item = permission("t1");
      const replacement = permission("t1", { action: "Redelivered" });
      const original = fixture.interactions.await({
        conversationId: "c1",
        item,
        detail: { note: "original" },
        cancellation: cancel => { cancelOriginal = cancel; return () => unsubscribed.push("original"); },
        abandoned: reason => { mapped.push("original"); return `original ${reason}`; },
      });
      fixture.interactions.await({ conversationId: "c1", item: permission("t0"), detail: { note: "" }, cancellation: never, abandoned: reason => reason });
      const latest = fixture.interactions.await({
        conversationId: "c1",
        item: replacement,
        detail: { note: "latest" },
        cancellation: abort.signal,
        abandoned: reason => { mapped.push("latest"); return `latest ${reason}`; },
      });
      return { ...fixture, abort, item, replacement, original, latest, unsubscribed, mapped, cancelOriginal: () => cancelOriginal!() };
    }

    test("announces the new request in the original's place and settles the original quietly through its own mapper", async () => {
      const { interactions, emitted, item, replacement, original, unsubscribed, mapped } = redelivered();
      expect(await original).toBe(`original ${SUPERSEDED_REASON}`);
      expect(mapped).toEqual(["original"]);
      expect(unsubscribed).toEqual(["original"]);
      expect(emitted.map(event => [event.eventType, (event.updates[0] as { item: PermissionRequest }).item])).toEqual([
        ["interaction.requested", item],
        ["interaction.requested", permission("t0")],
        ["interaction.requested", replacement],
      ]);
      expect(interactions.require("c1", "t1", "permission").detail).toEqual({ note: "latest" });
      // The request id keeps its place in the list.
      expect(interactions.list("permission").map(pending => [pending.requestId, pending.action])).toEqual([["t1", "Redelivered"], ["t0", "Write a.txt"]]);
    });

    test("leaves the original's trigger inert", async () => {
      const { interactions, emitted, cancelOriginal, mapped, original } = redelivered();
      await original;
      cancelOriginal();
      expect(mapped).toEqual(["original"]);
      expect(emitted.filter(event => event.eventType === "interaction.abandoned")).toEqual([]);
      expect(interactions.require("c1", "t1", "permission").detail).toEqual({ note: "latest" });
    });

    test("cancels only the new request through the new trigger", async () => {
      const { emitted, abort, replacement, latest } = redelivered();
      abort.abort();
      expect(await latest).toBe(`latest ${INTERRUPTED_REASON}`);
      expect(emitted.at(-1)).toEqual({ conversationId: "c1", updates: [{ kind: "upsert", item: { ...replacement, status: "resolved", outcome: "rejected" } }], outcome: "handled", eventType: "interaction.abandoned" });
    });

    test("routes an answer to the new request", async () => {
      const { interactions, latest } = redelivered();
      interactions.require("c1", "t1", "permission").settle("allowed");
      expect(await latest).toBe("allowed");
      expect(interactions.list("permission").map(pending => pending.requestId)).toEqual(["t0"]);
    });

    test("routes an abandonment to the new request alone", async () => {
      const { interactions, emitted, latest, mapped } = redelivered();
      interactions.abandon("c1", "ended");
      expect(await latest).toBe("latest ended");
      expect(mapped).toEqual(["original", "latest"]);
      expect(emitted.filter(event => event.eventType === "interaction.abandoned").map(event => (event.updates[0] as { item: PermissionRequest }).item.action))
        .toEqual(["Redelivered", "Write a.txt"]);
    });

    test("a replacement whose subscription throws is rejected unannounced, and the original stays answerable, listed and cancellable", async () => {
      const { interactions, emitted } = holder();
      const mapped: string[] = [];
      let cancelOriginal: (() => void) | undefined;
      const item = permission("t1");
      const original = interactions.await({
        conversationId: "c1",
        item,
        detail: { note: "original" },
        cancellation: cancel => { cancelOriginal = cancel; return () => undefined; },
        abandoned: reason => { mapped.push("original"); return reason; },
      });
      interactions.await({ conversationId: "c1", item: permission("t0"), detail: { note: "" }, cancellation: never, abandoned: reason => reason });
      const failed = interactions.await({
        conversationId: "c1",
        item: permission("t1", { action: "Redelivered" }),
        detail: { note: "latest" },
        cancellation: () => { throw new Error("subscribe failed"); },
        abandoned: reason => { mapped.push("latest"); return reason; },
      });
      await expect(failed).rejects.toThrow("subscribe failed");
      expect(mapped).toEqual([]);
      expect(emitted.map(event => event.eventType)).toEqual(["interaction.requested", "interaction.requested"]);
      expect(interactions.require("c1", "t1", "permission").detail).toEqual({ note: "original" });
      expect(interactions.list("permission").map(pending => [pending.requestId, pending.action])).toEqual([["t1", "Write a.txt"], ["t0", "Write a.txt"]]);
      // Its own trigger still cancels it, visibly.
      cancelOriginal!();
      expect(await original).toBe(INTERRUPTED_REASON);
      expect(emitted.at(-1)).toEqual({ conversationId: "c1", updates: [{ kind: "upsert", item: { ...item, status: "resolved", outcome: "rejected" } }], outcome: "handled", eventType: "interaction.abandoned" });
      expect(interactions.list("permission").map(pending => pending.requestId)).toEqual(["t0"]);
    });

    test("a replacement cancelled during its own subscription is announced, supersedes the original quietly, then is abandoned visibly", async () => {
      const { interactions, emitted } = holder();
      const mapped: string[] = [];
      let cancelOriginal: (() => void) | undefined;
      let registered: string[] = [];
      const original = interactions.await({
        conversationId: "c1",
        item: permission("t1"),
        detail: { note: "original" },
        cancellation: cancel => { cancelOriginal = cancel; return () => undefined; },
        abandoned: reason => { mapped.push("original"); return `original ${reason}`; },
      });
      const replacement = permission("t1", { action: "Redelivered" });
      const latest = interactions.await({
        conversationId: "c1",
        item: replacement,
        detail: { note: "latest" },
        cancellation: cancel => {
          registered = [interactions.require("c1", "t1", "permission").detail.note];
          cancel();
          return () => undefined;
        },
        abandoned: reason => { mapped.push("latest"); return `latest ${reason}`; },
      });
      expect(registered).toEqual(["latest"]);
      expect(await latest).toBe(`latest ${INTERRUPTED_REASON}`);
      expect(await original).toBe(`original ${SUPERSEDED_REASON}`);
      expect(mapped).toEqual(["original", "latest"]);
      expect(emitted.map(event => [event.eventType, (event.updates[0] as { item: PermissionRequest }).item.action])).toEqual([
        ["interaction.requested", "Write a.txt"],
        ["interaction.requested", "Redelivered"],
        ["interaction.abandoned", "Redelivered"],
      ]);
      expect(interactions.list("permission")).toEqual([]);
      cancelOriginal!();
      expect(mapped).toEqual(["original", "latest"]);
      expect(emitted).toHaveLength(3);
    });

    describe("with the original's trigger firing while the replacement subscribes", () => {
      function racing(replacementCancellation: (cancelOriginal: () => void) => CancellationTrigger) {
        const fixture = holder();
        const mapped: string[] = [];
        let cancelOriginal: (() => void) | undefined;
        const item = permission("t1");
        const original = fixture.interactions.await({
          conversationId: "c1",
          item,
          detail: { note: "original" },
          cancellation: cancel => { cancelOriginal = cancel; return () => undefined; },
          abandoned: reason => { mapped.push(`original ${reason}`); return `original ${reason}`; },
        });
        const replacement = permission("t1", { action: "Redelivered" });
        const latest = fixture.interactions.await({
          conversationId: "c1",
          item: replacement,
          detail: { note: "latest" },
          cancellation: replacementCancellation(() => cancelOriginal!()),
          abandoned: reason => { mapped.push(`latest ${reason}`); return `latest ${reason}`; },
        });
        const events = () => fixture.emitted.map(event => [event.eventType, (event.updates[0] as { item: PermissionRequest }).item.action]);
        return { ...fixture, mapped, item, original, latest, events };
      }

      test("a successful subscription discards the held cancel and supersedes the original quietly", async () => {
        const { interactions, mapped, original, events } = racing(cancelOriginal => () => { cancelOriginal(); return () => undefined; });
        expect(await original).toBe(`original ${SUPERSEDED_REASON}`);
        expect(mapped).toEqual([`original ${SUPERSEDED_REASON}`]);
        expect(events()).toEqual([["interaction.requested", "Write a.txt"], ["interaction.requested", "Redelivered"]]);
        expect(interactions.require("c1", "t1", "permission").detail).toEqual({ note: "latest" });
      });

      test("a failed subscription restores the original, and the held cancel then abandons it visibly", async () => {
        const { interactions, emitted, mapped, item, original, latest, events } = racing(cancelOriginal => () => { cancelOriginal(); throw new Error("subscribe failed"); });
        await expect(latest).rejects.toThrow("subscribe failed");
        expect(await original).toBe(`original ${INTERRUPTED_REASON}`);
        expect(mapped).toEqual([`original ${INTERRUPTED_REASON}`]);
        expect(events()).toEqual([["interaction.requested", "Write a.txt"], ["interaction.abandoned", "Write a.txt"]]);
        expect(emitted.at(-1)!.updates).toEqual([{ kind: "upsert", item: { ...item, status: "resolved", outcome: "rejected" } }]);
        expect(interactions.list("permission")).toEqual([]);
      });

      test("a subscription that cancels both and then throws rolls back: the replacement is rejected and the original's cancel applies", async () => {
        const { interactions, mapped, original, latest, events } = racing(cancelOriginal => cancel => { cancelOriginal(); cancel(); throw new Error("subscribe failed"); });
        await expect(latest).rejects.toThrow("subscribe failed");
        expect(await original).toBe(`original ${INTERRUPTED_REASON}`);
        expect(mapped).toEqual([`original ${INTERRUPTED_REASON}`]);
        expect(events()).toEqual([["interaction.requested", "Write a.txt"], ["interaction.abandoned", "Write a.txt"]]);
        expect(interactions.list("permission")).toEqual([]);
      });
    });
  });

  test("a cancellation subscription that throws rejects the request, leaves it unannounced and out of the holder", async () => {
    const { interactions, emitted } = holder();
    const other = interactions.await({ conversationId: "c1", item: permission("t0"), detail: { note: "" }, cancellation: never, abandoned: reason => reason });
    let cancel: (() => void) | undefined;
    const failed = interactions.await({
      conversationId: "c1",
      item: permission("t1"),
      detail: { note: "" },
      cancellation: onCancel => { cancel = onCancel; throw new Error("subscribe failed"); },
      abandoned: reason => reason,
    });
    await expect(failed).rejects.toThrow("subscribe failed");
    expect(() => interactions.require("c1", "t1", "permission")).toThrow("no pending permission t1 for this conversation");
    // A late cancel through the failed subscription changes nothing.
    cancel!();
    expect(emitted.map(event => [event.eventType, (event.updates[0] as { item: { requestId: string } }).item.requestId])).toEqual([["interaction.requested", "t0"]]);
    expect(interactions.list("permission").map(pending => pending.requestId)).toEqual(["t0"]);
    interactions.require("c1", "t0", "permission").settle("allowed");
    expect(await other).toBe("allowed");
  });

  describe("an abandoned mapper that throws", () => {
    const failing = () => { throw new Error("mapper failed"); };

    test("first in a sweep: its request ends visibly and rejects, and the sweep reaches the next", async () => {
      const { interactions, emitted } = holder();
      let released = 0;
      const first = interactions.await({ conversationId: "c1", item: permission("t1"), detail: { note: "" }, cancellation: () => () => { released += 1; }, abandoned: failing });
      const second = interactions.await({ conversationId: "c1", item: question("q1"), detail: { note: "" }, cancellation: never, abandoned: reason => reason });
      expect(() => interactions.abandon("c1", "ended")).not.toThrow();
      await expect(first).rejects.toThrow("mapper failed");
      expect(await second).toBe("ended");
      expect(released).toBe(1);
      expect(emitted.filter(event => event.eventType === "interaction.abandoned").map(event => (event.updates[0] as { item: { requestId: string } }).item.requestId)).toEqual(["t1", "q1"]);
      expect([...interactions.list("permission"), ...interactions.list("question")]).toEqual([]);
    });

    test("on an explicit trigger: the request ends visibly, rejects and is released once", async () => {
      const { interactions, emitted } = holder();
      let cancel: (() => void) | undefined;
      let released = 0;
      const item = permission("t1");
      const result = interactions.await({ conversationId: "c1", item, detail: { note: "" }, cancellation: onCancel => { cancel = onCancel; return () => { released += 1; }; }, abandoned: failing });
      expect(() => cancel!()).not.toThrow();
      await expect(result).rejects.toThrow("mapper failed");
      cancel!();
      expect(released).toBe(1);
      expect(emitted.at(-1)).toEqual({ conversationId: "c1", updates: [{ kind: "upsert", item: { ...item, status: "resolved", outcome: "rejected" } }], outcome: "handled", eventType: "interaction.abandoned" });
      expect(() => interactions.require("c1", "t1", "permission")).toThrow("no pending permission t1 for this conversation");
    });

    test("on a held cancel after a failed redelivery: the restored original ends visibly and rejects", async () => {
      const { interactions, emitted } = holder();
      let cancelOriginal: (() => void) | undefined;
      const item = permission("t1");
      const original = interactions.await({ conversationId: "c1", item, detail: { note: "" }, cancellation: cancel => { cancelOriginal = cancel; return () => undefined; }, abandoned: failing });
      const failed = interactions.await({
        conversationId: "c1",
        item: permission("t1", { action: "Redelivered" }),
        detail: { note: "" },
        cancellation: () => { cancelOriginal!(); throw new Error("subscribe failed"); },
        abandoned: reason => reason,
      });
      await expect(failed).rejects.toThrow("subscribe failed");
      await expect(original).rejects.toThrow("mapper failed");
      expect(emitted.map(event => [event.eventType, (event.updates[0] as { item: PermissionRequest }).item.action])).toEqual([
        ["interaction.requested", "Write a.txt"],
        ["interaction.abandoned", "Write a.txt"],
      ]);
      expect(interactions.list("permission")).toEqual([]);
    });

    test("on quiet supersession: the original rejects, unannounced, and the replacement is unaffected", async () => {
      const { interactions, emitted } = holder();
      let released = 0;
      const original = interactions.await({ conversationId: "c1", item: permission("t1"), detail: { note: "" }, cancellation: () => () => { released += 1; }, abandoned: failing });
      const latest = interactions.await({ conversationId: "c1", item: permission("t1", { action: "Redelivered" }), detail: { note: "" }, cancellation: never, abandoned: reason => reason });
      await expect(original).rejects.toThrow("mapper failed");
      expect(released).toBe(1);
      expect(emitted.map(event => event.eventType)).toEqual(["interaction.requested", "interaction.requested"]);
      interactions.require("c1", "t1", "permission").settle("allowed");
      expect(await latest).toBe("allowed");
    });
  });

  test("a replacement cancelled while its original is superseded is cancelled after its registration, releasing its subscription exactly once", async () => {
    const { interactions, emitted } = holder();
    let cancelLatest: (() => void) | undefined;
    let latestReleased = 0;
    let originalReleased = 0;
    // Superseding the original runs its mapper, which here makes the agent
    // cancel the replacement synchronously: a call made during the
    // registration, so it runs once the replacement has been announced.
    const original = interactions.await({
      conversationId: "c1",
      item: permission("t1"),
      detail: { note: "" },
      cancellation: () => () => { originalReleased += 1; },
      abandoned: reason => { cancelLatest!(); return reason; },
    });
    const latest = interactions.await({
      conversationId: "c1",
      item: permission("t1", { action: "Redelivered" }),
      detail: { note: "" },
      cancellation: cancel => { cancelLatest = cancel; return () => { latestReleased += 1; }; },
      abandoned: reason => reason,
    });
    expect(await original).toBe(SUPERSEDED_REASON);
    expect(await latest).toBe(INTERRUPTED_REASON);
    expect(latestReleased).toBe(1);
    expect(originalReleased).toBe(1);
    expect(emitted.map(event => [event.eventType, (event.updates[0] as { item: PermissionRequest }).item.action])).toEqual([
      ["interaction.requested", "Write a.txt"],
      ["interaction.requested", "Redelivered"],
      ["interaction.abandoned", "Redelivered"],
    ]);
  });

  describe("calls back into the holder while it works are serialized", () => {
    test("(a) a mapper that aborts its own request's signal runs once, and the first end wins", async () => {
      const { interactions, emitted } = holder();
      const abort = new AbortController();
      let calls = 0;
      const result = interactions.await({
        conversationId: "c1",
        item: permission("t1"),
        detail: { note: "" },
        cancellation: abort.signal,
        abandoned: reason => { calls += 1; abort.abort(); return reason; },
      });
      interactions.abandon("c1", "ended");
      expect(await result).toBe("ended");
      expect(calls).toBe(1);
      expect(emitted.map(event => event.eventType)).toEqual(["interaction.requested", "interaction.abandoned"]);
    });

    test("(b) a redelivery an unsubscribe delivers registers after the original's end, so its card stays answerable", async () => {
      const { interactions, emitted } = holder();
      let latest: Promise<string> | undefined;
      const original = interactions.await({
        conversationId: "c1",
        item: permission("t1"),
        detail: { note: "original" },
        cancellation: () => () => {
          latest = interactions.await({ conversationId: "c1", item: permission("t1", { action: "Redelivered" }), detail: { note: "latest" }, cancellation: never, abandoned: reason => reason });
        },
        abandoned: reason => reason,
      });
      interactions.abandon("c1", "ended");
      expect(await original).toBe("ended");
      expect(emitted.map(event => [event.eventType, (event.updates[0] as { item: PermissionRequest }).item.action])).toEqual([
        ["interaction.requested", "Write a.txt"],
        ["interaction.abandoned", "Write a.txt"],
        ["interaction.requested", "Redelivered"],
      ]);
      expect(interactions.require("c1", "t1", "permission").detail).toEqual({ note: "latest" });
      interactions.require("c1", "t1", "permission").settle("allowed");
      expect(await latest!).toBe("allowed");
    });

    test("(c) a sweep ends the requests it found; a replacement delivered during it registers afterwards as a new request", async () => {
      const { interactions, emitted } = holder();
      const mapped: string[] = [];
      let replacement: Promise<string> | undefined;
      const first = interactions.await({
        conversationId: "c1",
        item: permission("a"),
        detail: { note: "" },
        cancellation: () => () => {
          replacement = interactions.await({ conversationId: "c1", item: permission("b", { action: "Redelivered" }), detail: { note: "replacement" }, cancellation: never, abandoned: reason => { mapped.push(`replacement ${reason}`); return reason; } });
        },
        abandoned: reason => { mapped.push(`a ${reason}`); return reason; },
      });
      const second = interactions.await({ conversationId: "c1", item: permission("b"), detail: { note: "" }, cancellation: never, abandoned: reason => { mapped.push(`b ${reason}`); return reason; } });
      interactions.abandon("c1", "ended");
      expect(await first).toBe("ended");
      expect(await second).toBe("ended");
      expect(mapped).toEqual(["a ended", "b ended"]);
      expect(emitted.map(event => [event.eventType, (event.updates[0] as { item: PermissionRequest }).item.requestId, (event.updates[0] as { item: PermissionRequest }).item.action])).toEqual([
        ["interaction.requested", "a", "Write a.txt"],
        ["interaction.requested", "b", "Write a.txt"],
        ["interaction.abandoned", "a", "Write a.txt"],
        ["interaction.abandoned", "b", "Write a.txt"],
        ["interaction.requested", "b", "Redelivered"],
      ]);
      // The holder does not know the session ended: the late request is
      // pending like any new one, until its own trigger or the next sweep.
      expect(interactions.list("permission").map(pending => [pending.requestId, pending.action])).toEqual([["b", "Redelivered"]]);
      interactions.abandon("c1", "ended again");
      expect(await replacement!).toBe("ended again");
    });

    test("deferred calls run in order, including calls they defer in turn, before the outermost call returns", async () => {
      const { interactions, emitted } = holder();
      const order: string[] = [];
      const register = (id: string, onEnd?: () => void) => interactions.await({
        conversationId: "c1",
        item: permission(id),
        detail: { note: "" },
        cancellation: never,
        abandoned: reason => { order.push(id); onEnd?.(); return reason; },
      });
      const answered = register("t3");
      void register("t2", () => interactions.abandon("c1", "third"));
      const outer = register("t1", () => {
        interactions.require("c1", "t2", "permission").abandon("second");
        interactions.require("c1", "t3", "permission").settle("answered");
      });
      interactions.require("c1", "t1", "permission").abandon("first");
      // Synchronous: everything deferred has run by now.
      expect(order).toEqual(["t1", "t2"]);
      expect(interactions.list("permission")).toEqual([]);
      expect(emitted.filter(event => event.eventType === "interaction.abandoned").map(event => (event.updates[0] as { item: PermissionRequest }).item.requestId)).toEqual(["t1", "t2"]);
      expect(await outer).toBe("first");
      // The answer queued before the sweep t2's mapper deferred, so it won.
      expect(await answered).toBe("answered");
    });
  });

  test("a cancel delivered during subscription waits behind a reply queued before it: the reply wins", async () => {
    const { interactions, emitted } = holder();
    let mapped = 0;
    const result = interactions.await({
      conversationId: "c1",
      item: permission("t1"),
      detail: { note: "" },
      cancellation: cancel => {
        interactions.answer("c1", "t1", "permission", () => "allowed");
        cancel();
        return () => undefined;
      },
      abandoned: reason => { mapped += 1; return reason; },
    });
    expect(await result).toBe("allowed");
    expect(mapped).toBe(0);
    expect(emitted.map(event => event.eventType)).toEqual(["interaction.requested"]);
  });

  describe("answer", () => {
    test("maps the answer inside the operation: a cancel the mapper causes finds the request settled", async () => {
      const { interactions, emitted } = holder();
      const abort = new AbortController();
      let mapperCalls = 0;
      let abandonedCalls = 0;
      const result = interactions.await({ conversationId: "c1", item: permission("t1"), detail: { note: "" }, cancellation: abort.signal, abandoned: reason => { abandonedCalls += 1; return reason; } });
      const answered = interactions.answer("c1", "t1", "permission", pending => {
        mapperCalls += 1;
        abort.abort();
        return `allowed ${(pending.detail as { note: string }).note || "plain"}`;
      });
      await answered;
      expect(await result).toBe("allowed plain");
      expect([mapperCalls, abandonedCalls]).toEqual([1, 0]);
      expect(emitted.map(event => event.eventType)).toEqual(["interaction.requested"]);
      expect(interactions.list("permission")).toEqual([]);
    });

    test("an answer the mapper refuses rejects with its error and leaves the request pending, with nothing emitted", async () => {
      const { interactions, emitted } = holder();
      const result = interactions.await({ conversationId: "c1", item: question("q1"), detail: { note: "" }, cancellation: never, abandoned: reason => reason });
      await expect(interactions.answer("c1", "q1", "question", () => { throw new Error("enter a number"); })).rejects.toThrow("enter a number");
      expect(interactions.list("question").map(pending => pending.requestId)).toEqual(["q1"]);
      expect(emitted.map(event => event.eventType)).toEqual(["interaction.requested"]);
      await interactions.answer("c1", "q1", "question", () => "answered");
      expect(await result).toBe("answered");
    });

    test("an answer for no pending request rejects with today's message", async () => {
      const { interactions } = holder();
      await expect(interactions.answer("c1", "t1", "permission", () => "allowed")).rejects.toThrow(new Error("no pending permission t1 for this conversation"));
    });
  });

  describe("a publication that throws", () => {
    function failing(failOn: string) {
      const emitted: string[] = [];
      const reported: unknown[] = [];
      const interactions = new PendingInteractions<{ note: string }>((_conversationId, event) => {
        const requestId = (event.updates[0] as { item: { requestId: string } }).item.requestId;
        emitted.push(`${event.eventType} ${requestId}`);
        if (`${event.eventType} ${requestId}` === failOn) throw new Error(`could not publish ${failOn}`);
      }, { report: error => reported.push(error) });
      return { interactions, emitted, reported };
    }

    test("during a sweep: every request still settles, the sweep goes on, and the first error is rethrown after it", async () => {
      const { interactions, emitted } = failing("interaction.abandoned t1");
      const first = interactions.await({ conversationId: "c1", item: permission("t1"), detail: { note: "" }, cancellation: never, abandoned: reason => `t1 ${reason}` });
      const second = interactions.await({ conversationId: "c1", item: permission("t2"), detail: { note: "" }, cancellation: never, abandoned: reason => `t2 ${reason}` });
      expect(() => interactions.abandon("c1", "ended")).toThrow("could not publish interaction.abandoned t1");
      expect(await first).toBe("t1 ended");
      expect(await second).toBe("t2 ended");
      expect(emitted).toEqual(["interaction.requested t1", "interaction.requested t2", "interaction.abandoned t1", "interaction.abandoned t2"]);
      expect(interactions.list("permission")).toEqual([]);
    });

    test("during a cancel: the request settles and the cancel call rethrows", async () => {
      const { interactions } = failing("interaction.abandoned t1");
      let cancel: (() => void) | undefined;
      const result = interactions.await({ conversationId: "c1", item: permission("t1"), detail: { note: "" }, cancellation: onCancel => { cancel = onCancel; return () => undefined; }, abandoned: reason => reason });
      expect(() => cancel!()).toThrow("could not publish interaction.abandoned t1");
      expect(await result).toBe(INTERRUPTED_REASON);
      expect(interactions.list("permission")).toEqual([]);
    });

    test("during registration: the request stays pending and recoverable, and the error goes to report", async () => {
      const { interactions, reported } = failing("interaction.requested t1");
      const result = interactions.await({ conversationId: "c1", item: permission("t1"), detail: { note: "" }, cancellation: never, abandoned: reason => reason });
      expect(reported).toEqual([new Error("could not publish interaction.requested t1")]);
      expect(interactions.list("permission").map(pending => pending.requestId)).toEqual(["t1"]);
      interactions.answer("c1", "t1", "permission", () => "allowed");
      expect(await result).toBe("allowed");
    });
  });

  describe("a trigger that had already fired", () => {
    test("settles the request at once, unannounced", async () => {
      const { interactions, emitted } = holder();
      let registered: string[] = [];
      const item = permission("t1");
      const result = interactions.await({
        conversationId: "c1",
        item,
        detail: { note: "" },
        cancellation: () => {
          registered = interactions.list("permission").map(pending => pending.requestId);
          return "cancelled";
        },
        abandoned: reason => reason,
      });
      expect(await result).toBe(INTERRUPTED_REASON);
      expect(registered).toEqual(["t1"]);
      expect(emitted).toEqual([{ conversationId: "c1", updates: [{ kind: "upsert", item: { ...item, status: "resolved", outcome: "rejected" } }], outcome: "handled", eventType: "interaction.abandoned" }]);
      expect(interactions.list("permission")).toEqual([]);
    });

    test("wins over a reply queued during the subscription, which finds no request", async () => {
      const { interactions, emitted } = holder();
      let reply: Promise<void> | undefined;
      const result = interactions.await({
        conversationId: "c1",
        item: permission("t1"),
        detail: { note: "" },
        cancellation: () => {
          reply = interactions.answer("c1", "t1", "permission", () => "allowed");
          return "cancelled";
        },
        abandoned: reason => reason,
      });
      expect(await result).toBe(INTERRUPTED_REASON);
      await expect(reply!).rejects.toThrow("no pending permission t1 for this conversation");
      expect(emitted.map(event => event.eventType)).toEqual(["interaction.abandoned"]);
    });
  });

  describe("each call gets its own outcome", () => {
    function twoQuestions() {
      const fixture = holder();
      const first = fixture.interactions.await({ conversationId: "c1", item: question("q1"), detail: { note: "" }, cancellation: never, abandoned: reason => reason });
      const second = fixture.interactions.await({ conversationId: "c1", item: question("q2"), detail: { note: "" }, cancellation: never, abandoned: reason => reason });
      return { ...fixture, first, second };
    }

    test("a valid answer whose mapper queues an invalid one resolves; the nested one rejects with its own error", async () => {
      const { interactions, first } = twoQuestions();
      let nested: Promise<void> | undefined;
      const outer = interactions.answer("c1", "q1", "question", () => {
        nested = interactions.answer("c1", "q2", "question", () => { throw new Error("q2 refused"); });
        return "q1 answered";
      });
      await expect(outer).resolves.toBeUndefined();
      await expect(nested!).rejects.toThrow("q2 refused");
      expect(await first).toBe("q1 answered");
      expect(interactions.list("question").map(pending => pending.requestId)).toEqual(["q2"]);
    });

    test("an invalid answer whose mapper queues a valid one rejects with its own error; the nested one resolves", async () => {
      const { interactions, second } = twoQuestions();
      let nested: Promise<void> | undefined;
      const outer = interactions.answer("c1", "q1", "question", () => {
        nested = interactions.answer("c1", "q2", "question", () => "q2 answered");
        throw new Error("q1 refused");
      });
      await expect(outer).rejects.toThrow("q1 refused");
      await expect(nested!).resolves.toBeUndefined();
      expect(await second).toBe("q2 answered");
      expect(interactions.list("question").map(pending => pending.requestId)).toEqual(["q1"]);
    });

    test("a deferred call's failure goes to report, not to the call that was running", async () => {
      const reported: unknown[] = [];
      const interactions = new PendingInteractions<{ note: string }>((_conversationId, event) => {
        if (event.eventType === "interaction.abandoned") throw new Error("could not publish");
      }, { report: error => reported.push(error) });
      const first = interactions.await({ conversationId: "c1", item: permission("t1"), detail: { note: "" }, cancellation: never, abandoned: reason => reason });
      const second = interactions.await({ conversationId: "c2", item: permission("t2"), detail: { note: "" }, cancellation: never, abandoned: reason => reason });
      const outer = interactions.answer("c1", "t1", "permission", () => {
        interactions.abandon("c2", "ended");
        return "allowed";
      });
      await expect(outer).resolves.toBeUndefined();
      expect(await first).toBe("allowed");
      expect(await second).toBe("ended");
      expect(reported).toEqual([new Error("could not publish")]);
    });
  });

  describe("a reporter that throws", () => {
    function throwingReporter(failOn: string) {
      const reports: unknown[] = [];
      const logged: unknown[][] = [];
      const consoleError = console.error;
      console.error = (...args: unknown[]) => { logged.push(args); };
      const interactions = new PendingInteractions<{ note: string }>((_conversationId, event) => {
        if (event.eventType === failOn) throw new Error(`could not publish ${failOn}`);
      }, { report: error => { reports.push(error); throw new Error("reporter failed"); } });
      return { interactions, reports, logged, restore: () => { console.error = consoleError; } };
    }

    test("during a requested-publication failure: the request stays pending, and later answers and abandons still run", async () => {
      const { interactions, reports, logged, restore } = throwingReporter("interaction.requested");
      try {
        let settled = false;
        const first = interactions.await({ conversationId: "c1", item: permission("t1"), detail: { note: "" }, cancellation: never, abandoned: reason => reason });
        void first.then(() => { settled = true; }, () => { settled = true; });
        await Promise.resolve();
        expect(settled).toBe(false);
        expect(reports).toEqual([new Error("could not publish interaction.requested")]);
        expect(logged).toEqual([[new Error("could not publish interaction.requested"), new Error("reporter failed")]]);
        await interactions.answer("c1", "t1", "permission", () => "allowed");
        expect(await first).toBe("allowed");
        const second = interactions.await({ conversationId: "c1", item: permission("t2"), detail: { note: "" }, cancellation: never, abandoned: reason => reason });
        interactions.abandon("c1", "ended");
        expect(await second).toBe("ended");
        expect(interactions.list("permission")).toEqual([]);
      } finally {
        restore();
      }
    });

    test("during a deferred call's failure: the queue drains, the running call keeps its own outcome, and the holder stays usable", async () => {
      const { interactions, reports, restore } = throwingReporter("interaction.abandoned");
      try {
        const first = interactions.await({ conversationId: "c1", item: permission("t1"), detail: { note: "" }, cancellation: never, abandoned: reason => reason });
        const second = interactions.await({ conversationId: "c2", item: permission("t2"), detail: { note: "" }, cancellation: never, abandoned: reason => reason });
        const third = interactions.await({ conversationId: "c3", item: permission("t3"), detail: { note: "" }, cancellation: never, abandoned: reason => reason });
        const outer = interactions.answer("c1", "t1", "permission", () => {
          interactions.abandon("c2", "ended");
          interactions.require("c3", "t3", "permission").settle("answered");
          return "allowed";
        });
        await expect(outer).resolves.toBeUndefined();
        expect(await first).toBe("allowed");
        expect(await second).toBe("ended");
        expect(await third).toBe("answered");
        expect(reports).toEqual([new Error("could not publish interaction.abandoned")]);
        const later = interactions.await({ conversationId: "c1", item: permission("t4"), detail: { note: "" }, cancellation: never, abandoned: reason => reason });
        await interactions.answer("c1", "t4", "permission", () => "later");
        expect(await later).toBe("later");
      } finally {
        restore();
      }
    });
  });

  describe("the card is copied at registration", () => {
    test("a plain card, as Claude Code sends, is announced and abandoned as equal data", () => {
      const { interactions, emitted } = holder();
      const item = permission("p1", {
        action: "Review the plan",
        resources: [],
        plan: "## Plan\n1. Do the thing",
        choices: [{ id: "implement", label: "Approve and implement" }, { id: "implement-and-restore", label: "Approve, then return to acceptEdits", description: "Implement the plan." }],
        alwaysPatterns: ["Allow: Write(/workspace/*)"],
      });
      const before = JSON.stringify(item);
      void interactions.await({ conversationId: "c1", item, detail: { note: "" }, cancellation: never, abandoned: reason => reason });
      interactions.abandon("c1", "ended");
      const [requested, abandoned] = emitted.map(event => (event.updates[0] as { item: PermissionRequest }).item);
      expect(JSON.stringify(requested)).toBe(before);
      expect(requested).toEqual(item);
      expect(JSON.stringify(abandoned)).toBe(JSON.stringify({ ...item, status: "resolved", outcome: "rejected" }));
    });
  });

  test("an unsubscribe that throws is reported, apart from the caller's outcome", async () => {
    const { interactions, reported } = holder();
    const result = interactions.await({ conversationId: "c1", item: permission("t1"), detail: { note: "" }, cancellation: () => () => { throw new Error("unsubscribe failed"); }, abandoned: reason => reason });
    await expect(interactions.answer("c1", "t1", "permission", () => "allowed")).resolves.toBeUndefined();
    expect(await result).toBe("allowed");
    expect(reported).toEqual([new Error("unsubscribe failed")]);
  });

  describe("registration reads its identity and keeps its card private", () => {
    test("an unsupported kind, a request id that is not a string, or a conversation id that cannot be read rejects with nothing registered or emitted", async () => {
      const { interactions, emitted } = holder();
      const register = (registration: Partial<{ conversationId: string; item: PermissionRequest }>) =>
        interactions.await({ conversationId: "c1", item: permission("t1"), detail: { note: "" }, cancellation: never, abandoned: (reason: string) => reason, ...registration });
      await expect(register({ item: { ...permission("t1"), type: "notice" } as unknown as PermissionRequest })).rejects.toThrow("a permission or a question");
      await expect(register({ item: { ...permission("t1"), requestId: 5 } as unknown as PermissionRequest })).rejects.toThrow("needs a request id");
      const unreadable = { detail: { note: "" }, item: permission("t1"), cancellation: never, abandoned: (reason: string) => reason } as Parameters<typeof interactions.await<string>>[0];
      Object.defineProperty(unreadable, "conversationId", { get: () => { throw new Error("conversation gone"); } });
      await expect(interactions.await(unreadable)).rejects.toThrow("conversation gone");
      expect(emitted).toEqual([]);
      expect(interactions.list("permission")).toEqual([]);
    });

    test("a mapper that mutates its card and then throws leaves the pending card unchanged", async () => {
      const { interactions } = holder();
      void interactions.await({ conversationId: "c1", item: permission("t1"), detail: { note: "" }, cancellation: never, abandoned: reason => reason });
      await expect(interactions.answer("c1", "t1", "permission", pending => {
        (pending.item as { action: string }).action = "Mutated";
        (pending.item as PermissionRequest).resources.push("/b.txt");
        throw new Error("refused");
      })).rejects.toThrow("refused");
      const entry = interactions.require("c1", "t1", "permission");
      expect([(entry.item as PermissionRequest).action, (entry.item as PermissionRequest).resources]).toEqual(["Write a.txt", ["/a.txt"]]);
    });

    test("a reader that mutates a listed card or an announced one changes nothing the holder publishes", async () => {
      const { interactions, emitted } = holder();
      const result = interactions.await({ conversationId: "c1", item: permission("t1", { choices: [{ id: "implement", label: "Approve" }] }), detail: { note: "" }, cancellation: never, abandoned: reason => reason });
      const listed = interactions.list("permission")[0]!;
      listed.resources.push("/b.txt");
      listed.choices![0]!.label = "Mutated";
      const announced = (emitted[0]!.updates[0] as { item: PermissionRequest }).item;
      Object.defineProperty(announced, "diff", { enumerable: true, get: () => { throw new Error("installed by a reader"); } });
      expect(interactions.list("permission")).toEqual([{ requestId: "t1", conversationId: "c1", action: "Write a.txt", resources: ["/a.txt"], choices: [{ id: "implement", label: "Approve" }] }]);
      interactions.abandon("c1", "ended");
      expect(await result).toBe("ended");
      expect((emitted.at(-1)!.updates[0] as { item: PermissionRequest }).item).toEqual({ ...permission("t1", { choices: [{ id: "implement", label: "Approve" }] }), status: "resolved", outcome: "rejected" });
    });
  });

  describe("the card's owner", () => {
    test("a card naming another conversation as its owner is refused, with nothing registered or emitted", async () => {
      const { interactions, emitted } = holder();
      await expect(interactions.await({ conversationId: "c1", item: permission("t1", { conversationId: "c2" }), detail: { note: "" }, cancellation: never, abandoned: reason => reason }))
        .rejects.toThrow("registered for c1 names c2 as its owner");
      expect(emitted).toEqual([]);
      expect(interactions.list("permission")).toEqual([]);
    });

    test("a card naming its own conversation keeps it, and a card naming none stays without one", () => {
      const { interactions, emitted } = holder();
      void interactions.await({ conversationId: "c1", item: question("q1", { conversationId: "c1" }), detail: { note: "" }, cancellation: never, abandoned: reason => reason });
      void interactions.await({ conversationId: "c1", item: permission("t1"), detail: { note: "" }, cancellation: never, abandoned: reason => reason });
      const [owned, unowned] = emitted.map(event => (event.updates[0] as { item: PermissionRequest | QuestionRequest }).item);
      expect(owned!.conversationId).toBe("c1");
      expect("conversationId" in unowned!).toBe(false);
    });
  });

  describe("cards must be plain data", () => {
    async function refused(item: unknown, message: string) {
      const { interactions, emitted } = holder();
      await expect(interactions.await({ conversationId: "c1", item: item as PermissionRequest, detail: { note: "" }, cancellation: never, abandoned: reason => reason })).rejects.toThrow(message);
      expect(emitted).toEqual([]);
      expect(interactions.list("permission")).toEqual([]);
      expect(interactions.list("question")).toEqual([]);
    }

    test("a class instance is refused", async () => {
      class Card {
        id = "question:q1";
        type = "question" as const;
        requestId = "q1";
        get questions() { return [{ prompt: "Pick", header: "P", options: [], multiple: false, allowFreeForm: true }]; }
      }
      await refused(new Card(), "card is not a plain object");
    });

    test("an accessor is refused without its getter ever running", async () => {
      let reads = 0;
      const item = permission("t1");
      Object.defineProperty(item, "diff", { enumerable: true, get: () => { reads += 1; return "--- a"; } });
      await refused(item, "card.diff is an accessor, not data");
      expect(reads).toBe(0);
    });

    test("a nested accessor is refused", async () => {
      const item = permission("t1", { choices: [{ id: "implement", label: "Approve" }] });
      Object.defineProperty(item.choices![0]!, "label", { enumerable: true, get: () => "Approve" });
      await refused(item, "card.choices[0].label is an accessor, not data");
    });

    test("values that are not plain data are refused: a Map, a function, a BigInt, a hole, a cycle", async () => {
      await refused(permission("t1", { mcp: new Map() as never }), "card.mcp is not a plain object");
      await refused({ ...permission("t1"), plan: () => "steps" }, "card.plan is not plain data (function)");
      await refused({ ...permission("t1"), createdAt: 1n }, "card.createdAt is not plain data (bigint)");
      // eslint-disable-next-line no-sparse-arrays
      await refused(permission("t1", { resources: ["/a", , "/c"] as string[] }), "card.resources has holes");
      const cyclic = permission("t1", { choices: [] }) as PermissionRequest & { self?: unknown };
      cyclic.self = cyclic;
      await refused(cyclic, "card.self refers back to itself");
    });

    test("an absent optional field may be undefined, and later changes to the agent's object do not reach the holder", () => {
      const { interactions } = holder();
      const item = permission("t1", { diff: undefined });
      void interactions.await({ conversationId: "c1", item, detail: { note: "" }, cancellation: never, abandoned: reason => reason });
      item.action = "Changed";
      item.resources.push("/b.txt");
      expect(interactions.list("permission")).toEqual([{ requestId: "t1", conversationId: "c1", action: "Write a.txt", resources: ["/a.txt"] }]);
    });
  });

  test("a caller cannot change a handle, and a later abort still settles the request", async () => {
    const { interactions, emitted } = holder();
    const abort = new AbortController();
    const result = interactions.await({ conversationId: "c1", item: permission("t1"), detail: { note: "" }, cancellation: abort.signal, abandoned: reason => reason });
    const handle = interactions.require("c1", "t1", "permission");
    expect(Object.isFrozen(handle)).toBe(true);
    expect(() => { (handle as { abandon: unknown }).abandon = () => undefined; }).toThrow();
    expect(() => Object.defineProperty(handle, "settle", { value: () => undefined })).toThrow();
    abort.abort();
    expect(await result).toBe(INTERRUPTED_REASON);
    expect(emitted.map(event => event.eventType)).toEqual(["interaction.requested", "interaction.abandoned"]);
  });

  test("an own __proto__ key, as an MCP schema can carry, survives every copy the holder makes", async () => {
    const { interactions, emitted } = holder();
    const schema = JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string"},"name":{"type":"string"}},"__proto__":{"note":"kept"}}') as Record<string, unknown>;
    const item = question("el-1", { source: "elicitation", intro: "svc asks: Fill in", schema });
    const expected = JSON.stringify(schema);
    const result = interactions.await({ conversationId: "c1", item, detail: { note: "" }, cancellation: never, abandoned: reason => reason });
    const requested = (emitted[0]!.updates[0] as { item: QuestionRequest }).item;
    expect(JSON.stringify(requested.schema)).toBe(expected);
    expect(Object.getPrototypeOf(requested.schema)).toBe(Object.prototype);
    expect(JSON.stringify(interactions.list("question")[0]!.schema)).toBe(expected);
    expect(JSON.stringify((interactions.require("c1", "el-1", "question").item as QuestionRequest).schema)).toBe(expected);
    interactions.abandon("c1", "ended");
    expect(await result).toBe("ended");
    const abandoned = (emitted.at(-1)!.updates[0] as { item: QuestionRequest }).item;
    expect(JSON.stringify(abandoned.schema)).toBe(expected);
    expect(JSON.stringify(requested)).toBe(JSON.stringify(item));
  });

  test("an array with a named property that looks like an index is refused", async () => {
    const { interactions, emitted } = holder();
    const resources = ["/a"] as string[] & Record<string, unknown>;
    resources["4294967295"] = "/b";
    await expect(interactions.await({ conversationId: "c1", item: permission("t1", { resources }), detail: { note: "" }, cancellation: never, abandoned: reason => reason }))
      .rejects.toThrow("card.resources[4294967295] is not an array element");
    expect(emitted).toEqual([]);
    expect(interactions.list("permission")).toEqual([]);
  });

  test("an answer whose mapping returns a promise is refused: the request stays pending and the promise's outcome is ignored", async () => {
    const { interactions, emitted } = holder();
    const result = interactions.await({ conversationId: "c1", item: permission("t1"), detail: { note: "" }, cancellation: never, abandoned: reason => reason });
    let rejectLater: ((error: unknown) => void) | undefined;
    const late = new Promise<string>((_resolve, reject) => { rejectLater = reject; });
    // @ts-expect-error a mapping must return its result, not a promise
    const refused = interactions.answer("c1", "t1", "permission", () => late);
    await expect(refused).rejects.toThrow(new TypeError("an answer's mapping must return its result, not a promise"));
    rejectLater!(new Error("too late"));
    await Promise.resolve();
    expect(interactions.list("permission").map(pending => pending.requestId)).toEqual(["t1"]);
    expect(emitted.map(event => event.eventType)).toEqual(["interaction.requested"]);
    await interactions.answer("c1", "t1", "permission", () => "allowed");
    expect(await result).toBe("allowed");
  });

  test("every number is plain data and is copied faithfully: Infinity, -Infinity, NaN and -0", () => {
    const { interactions, emitted } = holder();
    const schema = { max: Number.POSITIVE_INFINITY, min: Number.NEGATIVE_INFINITY, step: Number.NaN, zero: -0 };
    void interactions.await({ conversationId: "c1", item: question("q1", { schema }), detail: { note: "" }, cancellation: never, abandoned: reason => reason });
    for (const copy of [(emitted[0]!.updates[0] as { item: QuestionRequest }).item.schema, interactions.list("question")[0]!.schema]) {
      expect(copy).toEqual(schema);
      expect(Object.is((copy as typeof schema).zero, -0)).toBe(true);
      expect(Number.isNaN((copy as typeof schema).step)).toBe(true);
    }
  });

  test("an answer whose result cannot be inspected safely is refused, and the request stays pending", async () => {
    const { interactions, emitted } = holder();
    const result = interactions.await({ conversationId: "c1", item: permission("t1"), detail: { note: "" }, cancellation: never, abandoned: reason => reason });
    let reads = 0;
    const tricky = {};
    Object.defineProperty(tricky, "then", { get: () => { reads += 1; throw new Error("then read"); } });
    await expect(interactions.answer("c1", "t1", "permission", () => tricky)).rejects.toThrow("must not have a `then` accessor");
    expect(reads).toBe(0);
    expect(interactions.list("permission").map(pending => pending.requestId)).toEqual(["t1"]);
    expect(emitted.map(event => event.eventType)).toEqual(["interaction.requested"]);
    // Any own `then` is refused, even inert data; the request stays pending.
    await expect(interactions.answer("c1", "t1", "permission", () => ({ behavior: "allow", then: "data" }))).rejects.toThrow("must not have a `then`");
    await interactions.answer("c1", "t1", "permission", () => ({ behavior: "allow" }));
    expect(await result as unknown).toEqual({ behavior: "allow" });
  });

  test("a publication that throws while a signal abandons a request goes to report, not to the signal's dispatch", async () => {
    const reported: unknown[] = [];
    const interactions = new PendingInteractions<{ note: string }>((_conversationId, event) => {
      if (event.eventType === "interaction.abandoned") throw new Error("could not publish");
    }, { report: error => reported.push(error) });
    const abort = new AbortController();
    const result = interactions.await({ conversationId: "c1", item: permission("t1"), detail: { note: "" }, cancellation: abort.signal, abandoned: reason => reason });
    expect(() => abort.abort()).not.toThrow();
    expect(await result).toBe(INTERRUPTED_REASON);
    expect(reported).toEqual([new Error("could not publish")]);
  });

  test("whenRefused answers a refused card, while a valid card whose subscription throws still rejects; neither registers or emits", async () => {
    const { interactions, emitted } = holder();
    const result = interactions.await({ conversationId: "c1", item: { ...permission("t1"), createdAt: 1n } as never, detail: { note: "" }, cancellation: never, abandoned: reason => reason, whenRefused: error => `refused: ${(error as Error).message}` });
    expect(await result).toBe("refused: card.createdAt is not plain data (bigint)");
    let refusals = 0;
    const failed = interactions.await({ conversationId: "c1", item: permission("t2"), detail: { note: "" }, cancellation: () => { throw new Error("subscribe failed"); }, abandoned: reason => reason, whenRefused: () => { refusals += 1; return "refused"; } });
    await expect(failed).rejects.toThrow("subscribe failed");
    expect(refusals).toBe(0);
    expect(emitted).toEqual([]);
    expect(interactions.list("permission")).toEqual([]);
  });

  test("approved: require and list read current state at once, so a registration a mapper queued is not yet visible to it, and runs before the outer call returns", async () => {
    const { interactions, emitted } = holder();
    void interactions.await({ conversationId: "c1", item: permission("t1"), detail: { note: "" }, cancellation: never, abandoned: reason => reason });
    let seenDuring: string[] | undefined;
    let lookupDuring: unknown;
    const outer = interactions.answer("c1", "t1", "permission", () => {
      void interactions.await({ conversationId: "c1", item: permission("t2"), detail: { note: "" }, cancellation: never, abandoned: reason => reason });
      try {
        interactions.require("c1", "t2", "permission");
      } catch (error) {
        lookupDuring = error;
      }
      seenDuring = interactions.list("permission").map(pending => pending.requestId);
      return "allowed";
    });
    expect(lookupDuring).toEqual(new Error("no pending permission t2 for this conversation"));
    expect(seenDuring).toEqual(["t1"]);
    // Synchronously after the outer call: the queued registration has run.
    expect(interactions.list("permission").map(pending => pending.requestId)).toEqual(["t2"]);
    expect(emitted.map(event => (event.updates[0] as { item: PermissionRequest }).item.requestId)).toEqual(["t1", "t2"]);
    await outer;
  });

  test("a custom thenable is refused without its then ever running, and the request stays answerable", async () => {
    const { interactions, emitted } = holder();
    const result = interactions.await({ conversationId: "c1", item: permission("t1"), detail: { note: "" }, cancellation: never, abandoned: reason => reason });
    let calls = 0;
    const thenable = { then: () => { calls += 1; interactions.abandon("c1", "cancelled by then"); } };
    await expect(interactions.answer("c1", "t1", "permission", () => thenable)).rejects.toThrow("must return its result, not a promise");
    expect(calls).toBe(0);
    expect(emitted.map(event => event.eventType)).toEqual(["interaction.requested"]);
    await interactions.answer("c1", "t1", "permission", () => "allowed");
    expect(await result).toBe("allowed");
  });

  test("cleanup that mutates a checked answer cannot change the agent's result", async () => {
    const { interactions } = holder();
    const answerObject: Record<string, unknown> = { behavior: "allow", updatedInput: { command: "ls" } };
    const result = interactions.await({
      conversationId: "c1",
      item: permission("t1"),
      detail: { note: "" },
      cancellation: () => () => {
        Object.defineProperty(answerObject, "then", { get: () => { throw new Error("installed by cleanup"); } });
      },
      abandoned: reason => reason as unknown,
    });
    await expect(interactions.answer("c1", "t1", "permission", () => answerObject)).resolves.toBeUndefined();
    expect(await result).toBe(answerObject);
  });

  test("a handle's settle refuses a thenable as answer does: it throws and the request stays pending", async () => {
    const { interactions, emitted } = holder();
    const result = interactions.await({ conversationId: "c1", item: permission("t1"), detail: { note: "" }, cancellation: never, abandoned: reason => reason });
    let calls = 0;
    const handle = interactions.require("c1", "t1", "permission");
    // @ts-expect-error a result must not be a promise
    expect(() => handle.settle(Promise.resolve("later"))).toThrow(new TypeError("an answer's mapping must return its result, not a promise"));
    expect(() => handle.settle({ then: () => { calls += 1; } })).toThrow(TypeError);
    expect(calls).toBe(0);
    expect(interactions.list("permission").map(pending => pending.requestId)).toEqual(["t1"]);
    expect(emitted.map(event => event.eventType)).toEqual(["interaction.requested"]);
    handle.settle("allowed");
    expect(await result).toBe("allowed");
  });

  describe("a registration field that cannot be read rejects, and never reaches whenRefused", () => {
    function registrationWith(field: string) {
      const registration: Record<string, unknown> = { conversationId: "c1", item: permission("t1"), detail: { note: "" }, cancellation: never, abandoned: (reason: string) => reason };
      let refusals = 0;
      if (field !== "whenRefused") registration.whenRefused = () => { refusals += 1; return "refused"; };
      Object.defineProperty(registration, field, { enumerable: true, get: () => { throw new Error(`${field} unreadable`); } });
      return { registration: registration as unknown as Parameters<PendingInteractions<{ note: string }>["await"]>[0], refusals: () => refusals };
    }

    for (const field of ["whenRefused", "detail", "cancellation", "abandoned", "item"]) {
      test(field, async () => {
        const { interactions, emitted } = holder();
        const { registration, refusals } = registrationWith(field);
        await expect(interactions.await(registration)).rejects.toThrow(`${field} unreadable`);
        expect(refusals()).toBe(0);
        expect(emitted).toEqual([]);
        expect(interactions.list("permission")).toEqual([]);
      });
    }
  });

  describe("an abandoned mapping that returns a thenable", () => {
    test("on a sweep: the request still ends visibly, and the promise rejects instead of waiting on it", async () => {
      const { interactions, emitted } = holder();
      let released = 0;
      const never = new Promise<string>(() => undefined);
      const result = interactions.await<string>({
        conversationId: "c1",
        item: permission("t1"),
        detail: { note: "" },
        cancellation: () => () => { released += 1; },
        // @ts-expect-error an abandoned result must not be a promise
        abandoned: () => never,
      });
      interactions.abandon("c1", "ended");
      await expect(result).rejects.toThrow(new TypeError("an `abandoned` mapping must return its result, not a promise"));
      expect(released).toBe(1);
      expect(emitted.map(event => event.eventType)).toEqual(["interaction.requested", "interaction.abandoned"]);
      expect(interactions.list("permission")).toEqual([]);
    });

    test("on a trigger, with a custom then that is never called", async () => {
      const { interactions, emitted } = holder();
      const abort = new AbortController();
      let calls = 0;
      const result = interactions.await<unknown>({ conversationId: "c1", item: permission("t1"), detail: { note: "" }, cancellation: abort.signal, abandoned: () => ({ then: () => { calls += 1; } }) });
      abort.abort();
      await expect(result).rejects.toThrow(TypeError);
      expect(calls).toBe(0);
      expect(emitted.map(event => event.eventType)).toEqual(["interaction.requested", "interaction.abandoned"]);
    });

    test("on quiet supersession: the original rejects unannounced, and the replacement is unaffected", async () => {
      const { interactions, emitted } = holder();
      const original = interactions.await<unknown>({ conversationId: "c1", item: permission("t1"), detail: { note: "" }, cancellation: never, abandoned: () => Promise.resolve("later") });
      const latest = interactions.await({ conversationId: "c1", item: permission("t1", { action: "Redelivered" }), detail: { note: "" }, cancellation: never, abandoned: reason => reason });
      await expect(original).rejects.toThrow(TypeError);
      expect(emitted.map(event => event.eventType)).toEqual(["interaction.requested", "interaction.requested"]);
      await interactions.answer("c1", "t1", "permission", () => "allowed");
      expect(await latest).toBe("allowed");
    });
  });

  test("a refused Promise subclass's rejection is the mapper's to handle; the request stays pending", async () => {
    const { interactions } = holder();
    const result = interactions.await({ conversationId: "c1", item: permission("t1"), detail: { note: "" }, cancellation: never, abandoned: reason => reason });
    class Deferred<T> extends Promise<T> {}
    let rejectLater: ((error: unknown) => void) | undefined;
    const subclassed = new Deferred<string>((_resolve, reject) => { rejectLater = reject; });
    // The holder never runs a subclass's then or species code, so it cannot
    // contain this rejection: the caller handles it.
    const handled = subclassed.catch(error => (error as Error).message);
    // @ts-expect-error a mapping must return its result, not a promise
    await expect(interactions.answer("c1", "t1", "permission", () => subclassed)).rejects.toThrow(new TypeError("an answer's mapping must return its result, not a promise"));
    rejectLater!(new Error("rejected later"));
    expect(await handled).toBe("rejected later");
    expect(interactions.list("permission").map(pending => pending.requestId)).toEqual(["t1"]);
    await interactions.answer("c1", "t1", "permission", () => "allowed");
    expect(await result).toBe("allowed");
  });

  test("an unsubscribe that adds a callable then to the abandoned result after mapping makes the promise reject, never hang", async () => {
    const { interactions, emitted } = holder();
    const denial: Record<string, unknown> = { behavior: "deny" };
    const result = interactions.await<unknown>({
      conversationId: "c1",
      item: permission("t1"),
      detail: { note: "" },
      cancellation: () => () => { denial.then = () => undefined; },
      abandoned: () => denial,
    });
    interactions.abandon("c1", "ended");
    await expect(result).rejects.toThrow(new TypeError("an `abandoned` mapping must return its result, not a promise"));
    expect(emitted.map(event => event.eventType)).toEqual(["interaction.requested", "interaction.abandoned"]);
  });

  test("a whenRefused result that is a thenable rejects the promise with a TypeError", async () => {
    const { interactions, emitted } = holder();
    let calls = 0;
    const result = interactions.await<string>({
      conversationId: "c1",
      item: { ...permission("t1"), createdAt: 1n } as never,
      detail: { note: "" },
      cancellation: never,
      abandoned: reason => reason,
      // @ts-expect-error a whenRefused result must not be a promise
      whenRefused: () => ({ then: () => { calls += 1; } }) as PromiseLike<unknown>,
    });
    await expect(result).rejects.toThrow(new TypeError("a `whenRefused` mapping must return its result, not a promise"));
    expect(calls).toBe(0);
    expect(emitted).toEqual([]);
  });

  describe("an acceptable result is a primitive or a plain object or array without its own then", () => {
    test("plain objects, arrays, null-prototype objects and primitives settle", async () => {
      const { interactions } = holder();
      const bare = Object.assign(Object.create(null) as Record<string, unknown>, { behavior: "allow" });
      for (const [requestId, value] of [["t1", { behavior: "allow", updatedInput: { command: "ls" } }], ["t2", ["a", "b"]], ["t3", bare], ["t4", "allowed"], ["t5", null]] as const) {
        const result = interactions.await<unknown>({ conversationId: "c1", item: permission(requestId), detail: { note: "" }, cancellation: never, abandoned: reason => reason });
        await interactions.answer("c1", requestId, "permission", () => value);
        expect(await result).toBe(value);
      }
    });

    test("a result inheriting from a Proxy is refused without the Proxy running, and the request stays pending", async () => {
      const { interactions } = holder();
      const result = interactions.await<unknown>({ conversationId: "c1", item: permission("t1"), detail: { note: "" }, cancellation: never, abandoned: reason => reason });
      let traps = 0;
      const prototype = new Proxy({}, {
        get: (_target, key) => { traps += 1; return key === "then" ? (resolve: (value: unknown) => void) => resolve("hijacked") : undefined; },
        getOwnPropertyDescriptor: () => { traps += 1; return undefined; },
        getPrototypeOf: () => { traps += 1; return null; },
      });
      const sneaky = Object.create(prototype) as object;
      await expect(interactions.answer("c1", "t1", "permission", () => sneaky)).rejects.toThrow("not an object of another kind");
      expect(traps).toBe(0);
      expect(interactions.list("permission").map(pending => pending.requestId)).toEqual(["t1"]);
      await interactions.answer("c1", "t1", "permission", () => "allowed");
      expect(await result).toBe("allowed");
    });

    test("a class instance is refused", async () => {
      const { interactions } = holder();
      void interactions.await<unknown>({ conversationId: "c1", item: permission("t1"), detail: { note: "" }, cancellation: never, abandoned: reason => reason });
      class Decision { behavior = "allow"; }
      await expect(interactions.answer("c1", "t1", "permission", () => new Decision())).rejects.toThrow("not an object of another kind");
      expect(interactions.list("permission").map(pending => pending.requestId)).toEqual(["t1"]);
    });
  });

  test("with the species getter wrapped, a refused promise still gives a TypeError, the holder runs no species code, and its rejection is the caller's", async () => {
    const original = Object.getOwnPropertyDescriptor(Promise, Symbol.species)!;
    let speciesReads = 0;
    Object.defineProperty(Promise, Symbol.species, { ...original, get() { speciesReads += 1; return original.get!.call(this); } });
    try {
      const { interactions } = holder();
      void interactions.await<unknown>({ conversationId: "c1", item: permission("t1"), detail: { note: "" }, cancellation: never, abandoned: reason => reason });
      let rejectLater: ((error: unknown) => void) | undefined;
      const refusedPromise = new Promise<string>((_resolve, reject) => { rejectLater = reject; });
      // @ts-expect-error a mapping must return its result, not a promise
      const refused = interactions.answer("c1", "t1", "permission", () => refusedPromise);
      expect(speciesReads).toBe(0);
      await expect(refused).rejects.toThrow(new TypeError("an answer's mapping must return its result, not a promise"));
      const handled = refusedPromise.catch(error => (error as Error).message);
      rejectLater!(new Error("rejected later"));
      expect(await handled).toBe("rejected later");
      expect(interactions.list("permission").map(pending => pending.requestId)).toEqual(["t1"]);
    } finally {
      Object.defineProperty(Promise, Symbol.species, original);
    }
  });

  describe("a Proxy", () => {
    function trapping<T extends object>(target: T) {
      const counter = { traps: 0 };
      const handler: ProxyHandler<T> = {};
      for (const trap of ["get", "has", "getPrototypeOf", "getOwnPropertyDescriptor", "ownKeys", "defineProperty", "set", "isExtensible"] as const) {
        (handler as Record<string, unknown>)[trap] = (...args: unknown[]) => {
          counter.traps += 1;
          if (trap === "get" && args[1] === "then") return () => undefined;
          return (Reflect[trap] as (...values: unknown[]) => unknown)(...args);
        };
      }
      return { proxy: new Proxy(target, handler), counter };
    }

    test("as a result, whose get trap would supply a never-settling then, is refused without a trap running, and the request stays pending", async () => {
      const { interactions } = holder();
      const result = interactions.await<unknown>({ conversationId: "c1", item: permission("t1"), detail: { note: "" }, cancellation: never, abandoned: reason => reason });
      const { proxy, counter } = trapping({ behavior: "allow" });
      await expect(interactions.answer("c1", "t1", "permission", () => proxy)).rejects.toThrow(new TypeError("an answer's mapping must not return a Proxy"));
      expect(counter.traps).toBe(0);
      expect(interactions.list("permission").map(pending => pending.requestId)).toEqual(["t1"]);
      await interactions.answer("c1", "t1", "permission", () => "allowed");
      expect(await result).toBe("allowed");
    });

    test("as an abandoned result, the request ends and its promise rejects", async () => {
      const { interactions } = holder();
      const { proxy, counter } = trapping({ behavior: "deny" });
      const result = interactions.await<unknown>({ conversationId: "c1", item: permission("t1"), detail: { note: "" }, cancellation: never, abandoned: () => proxy });
      interactions.abandon("c1", "ended");
      await expect(result).rejects.toThrow(new TypeError("an `abandoned` mapping must not return a Proxy"));
      expect(counter.traps).toBe(0);
    });

    test("as a card, or nested in one, is refused at registration without a trap running", async () => {
      for (const [item, message] of [
        [trapping(permission("t1")), "card is a Proxy"],
        [trapping({ id: "x" }), "card.mcp is a Proxy"],
      ] as const) {
        const { interactions, emitted } = holder();
        const card = message === "card is a Proxy" ? item.proxy : { ...permission("t1"), mcp: item.proxy };
        await expect(interactions.await({ conversationId: "c1", item: card as PermissionRequest, detail: { note: "" }, cancellation: never, abandoned: reason => reason })).rejects.toThrow(message);
        expect(item.counter.traps).toBe(0);
        expect(emitted).toEqual([]);
        expect(interactions.list("permission")).toEqual([]);
      }
    });
  });

  test("an empty request id is a request id: announced, listed, and answerable", async () => {
    const { interactions, emitted } = holder();
    const result = interactions.await({ conversationId: "c1", item: permission(""), detail: { note: "" }, cancellation: never, abandoned: reason => reason });
    expect((emitted[0]!.updates[0] as { item: PermissionRequest }).item.requestId).toBe("");
    expect(interactions.list("permission").map(pending => pending.requestId)).toEqual([""]);
    expect(interactions.require("c1", "", "permission").requestId).toBe("");
    await interactions.answer("c1", "", "permission", () => "allowed");
    expect(await result).toBe("allowed");
  });

  describe("a then installed on a shared prototype", () => {
    const cases: Array<[string, object, () => unknown]> = [
      ["Object.prototype", Object.prototype, () => ({ behavior: "allow" })],
      ["Array.prototype", Array.prototype, () => ["allow"]],
    ];
    for (const [name, prototype, value] of cases) {
      for (const kind of ["callable", "accessor"] as const) {
        test(`on ${name}, ${kind}: the result is refused and the request stays pending`, async () => {
          const { interactions } = holder();
          const result = interactions.await<unknown>({ conversationId: "c1", item: permission("t1"), detail: { note: "" }, cancellation: never, abandoned: reason => reason });
          let runs = 0;
          const descriptor: PropertyDescriptor = kind === "callable"
            ? { value: () => { runs += 1; }, configurable: true, writable: true }
            : { get: () => { runs += 1; return undefined; }, configurable: true };
          Object.defineProperty(prototype, "then", descriptor);
          let refused: Promise<void>;
          try {
            refused = interactions.answer("c1", "t1", "permission", value);
          } finally {
            delete (prototype as { then?: unknown }).then;
          }
          await expect(refused).rejects.toThrow("must not inherit a `then`");
          expect(runs).toBe(0);
          expect(interactions.list("permission").map(pending => pending.requestId)).toEqual(["t1"]);
          await interactions.answer("c1", "t1", "permission", () => "allowed");
          expect(await result).toBe("allowed");
        });
      }
    }

    test("a null-prototype result needs only its own check", async () => {
      const { interactions } = holder();
      const result = interactions.await<unknown>({ conversationId: "c1", item: permission("t1"), detail: { note: "" }, cancellation: never, abandoned: reason => reason });
      const bare = Object.assign(Object.create(null) as Record<string, unknown>, { behavior: "allow" });
      Object.defineProperty(Object.prototype, "then", { value: () => undefined, configurable: true, writable: true });
      try {
        await interactions.answer("c1", "t1", "permission", () => bare);
      } finally {
        delete (Object.prototype as { then?: unknown }).then;
      }
      expect(await result).toBe(bare);
    });
  });

  test("tryAnswer reports the outcome synchronously: settled, refused by the mapper or by the holder, or no request", async () => {
    const { interactions } = holder();
    const result = interactions.await<unknown>({ conversationId: "c1", item: permission("t1"), detail: { note: "" }, cancellation: never, abandoned: reason => reason });
    expect(interactions.tryAnswer("c1", "t9", "permission", () => "x")).toEqual({ status: "refused", error: new Error("no pending permission t9 for this conversation") });
    expect(interactions.tryAnswer("c1", "t1", "permission", () => { throw new Error("refused by map"); })).toEqual({ status: "refused", error: new Error("refused by map") });
    expect(interactions.tryAnswer("c1", "t1", "permission", () => ({ then: "data" }))).toEqual({ status: "refused", error: expect.any(TypeError) });
    expect(interactions.tryAnswer("c1", "t1", "permission", () => "allowed")).toEqual({ status: "settled" });
    expect(await result).toBe("allowed");
  });

  test("identity is read from own data: an inherited conversationId getter is never run, and an absent owner means none", () => {
    const { interactions, emitted } = holder();
    let reads = 0;
    Object.defineProperty(Object.prototype, "conversationId", { get: () => { reads += 1; return "c2"; }, configurable: true });
    try {
      void interactions.await({ conversationId: "c1", item: permission("t1"), detail: { note: "" }, cancellation: never, abandoned: reason => reason });
    } finally {
      delete (Object.prototype as { conversationId?: unknown }).conversationId;
    }
    expect(reads).toBe(0);
    expect(emitted.map(event => event.eventType)).toEqual(["interaction.requested"]);
    expect(interactions.list("permission").map(pending => [pending.requestId, pending.conversationId])).toEqual([["t1", "c1"]]);
  });

  test("a result whose actual chain is not Array.prototype then Object.prototype is refused", async () => {
    const { interactions } = holder();
    const result = interactions.await<unknown>({ conversationId: "c1", item: permission("t1"), detail: { note: "" }, cancellation: never, abandoned: reason => reason });
    const intermediate = Object.create(Object.prototype) as object;
    Object.setPrototypeOf(Array.prototype, intermediate);
    let refused: Promise<void>;
    try {
      refused = interactions.answer("c1", "t1", "permission", () => ["allow"]);
    } finally {
      Object.setPrototypeOf(Array.prototype, Object.prototype);
    }
    await expect(refused).rejects.toThrow("must inherit only from Array.prototype and Object.prototype");
    expect(interactions.list("permission").map(pending => pending.requestId)).toEqual(["t1"]);
    await interactions.answer("c1", "t1", "permission", () => ["allow"]);
    expect(await result).toEqual(["allow"]);
  });

  test("a native promise with a null prototype is still refused as a promise", async () => {
    const { interactions } = holder();
    const result = interactions.await<unknown>({ conversationId: "c1", item: permission("t1"), detail: { note: "" }, cancellation: never, abandoned: reason => reason });
    const bare = Promise.resolve("later");
    Object.setPrototypeOf(bare, null);
    // @ts-expect-error a mapping must return its result, not a promise
    await expect(interactions.answer("c1", "t1", "permission", () => bare)).rejects.toThrow(new TypeError("an answer's mapping must return its result, not a promise"));
    expect(interactions.list("permission").map(pending => pending.requestId)).toEqual(["t1"]);
    await interactions.answer("c1", "t1", "permission", () => "allowed");
    expect(await result).toBe("allowed");
  });

  test("request keys do not go through serialization hooks: an inherited toJSON cannot make identities collide", async () => {
    const { interactions } = holder();
    Object.defineProperty(Array.prototype, "toJSON", { value: () => "same", configurable: true, writable: true });
    Object.defineProperty(Object.prototype, "toJSON", { value: () => "same", configurable: true, writable: true });
    let first: Promise<string>;
    let second: Promise<string>;
    try {
      first = interactions.await({ conversationId: "c1", item: permission("t1"), detail: { note: "" }, cancellation: never, abandoned: reason => reason });
      second = interactions.await({ conversationId: "c2", item: question("q2"), detail: { note: "" }, cancellation: never, abandoned: reason => reason });
    } finally {
      delete (Array.prototype as { toJSON?: unknown }).toJSON;
      delete (Object.prototype as { toJSON?: unknown }).toJSON;
    }
    expect(interactions.list("permission").map(pending => pending.requestId)).toEqual(["t1"]);
    expect(interactions.list("question").map(pending => pending.requestId)).toEqual(["q2"]);
    await interactions.answer("c1", "t1", "permission", () => "first");
    await interactions.answer("c2", "q2", "question", () => "second");
    expect([await first, await second]).toEqual(["first", "second"]);
  });

  test("ids that would run together stay apart", async () => {
    const { interactions } = holder();
    const a = interactions.await({ conversationId: "c:permission", item: permission("x"), detail: { note: "" }, cancellation: never, abandoned: reason => reason });
    const b = interactions.await({ conversationId: "c", item: permission("permission:x"), detail: { note: "" }, cancellation: never, abandoned: reason => reason });
    expect(interactions.list("permission")).toHaveLength(2);
    await interactions.answer("c", "permission:x", "permission", () => "b");
    await interactions.answer("c:permission", "x", "permission", () => "a");
    expect([await a, await b]).toEqual(["a", "b"]);
  });

  describe("a card that shares nodes", () => {
    test("a deeply shared DAG registers with each source object read once, and its copies keep the sharing", () => {
      const { interactions, emitted } = holder();
      let node: Record<string, unknown> = { leaf: true };
      const nodes: object[] = [node];
      for (let level = 0; level < 40; level += 1) {
        node = { left: node, right: node };
        nodes.push(node);
      }
      const reads = new Map<object, number>();
      const describe = Object.getOwnPropertyDescriptors;
      Object.getOwnPropertyDescriptors = (<T>(target: T) => {
        reads.set(target as object, (reads.get(target as object) ?? 0) + 1);
        return describe(target);
      }) as typeof Object.getOwnPropertyDescriptors;
      try {
        void interactions.await({ conversationId: "c1", item: question("q1", { schema: node }), detail: { note: "" }, cancellation: never, abandoned: reason => reason });
      } finally {
        Object.getOwnPropertyDescriptors = describe;
      }
      expect(nodes.map(each => reads.get(each))).toEqual(nodes.map(() => 1));
      const announced = (emitted[0]!.updates[0] as { item: QuestionRequest }).item.schema as Record<string, Record<string, unknown>>;
      expect(announced.left).toBe(announced.right);
      const listed = interactions.list("question")[0]!.schema as Record<string, Record<string, unknown>>;
      expect(listed.left).toBe(listed.right);
      expect(listed).not.toBe(announced);
    });

    test("a real cycle is still refused", async () => {
      const { interactions, emitted } = holder();
      const parent: Record<string, unknown> = { name: "parent" };
      parent.child = { back: parent };
      await expect(interactions.await({ conversationId: "c1", item: question("q1", { schema: parent }), detail: { note: "" }, cancellation: never, abandoned: reason => reason }))
        .rejects.toThrow("card.schema.child.back refers back to itself");
      expect(emitted).toEqual([]);
    });
  });

  test("a quiet supersession checks its result after cleanup: an unsubscribe that adds then makes the original reject", async () => {
    const { interactions, emitted } = holder();
    const denial: Record<string, unknown> = { behavior: "deny" };
    const original = interactions.await<unknown>({
      conversationId: "c1",
      item: permission("t1"),
      detail: { note: "" },
      cancellation: () => () => { denial.then = () => undefined; },
      abandoned: () => denial,
    });
    const latest = interactions.await({ conversationId: "c1", item: permission("t1", { action: "Redelivered" }), detail: { note: "" }, cancellation: never, abandoned: reason => reason });
    await expect(original).rejects.toThrow(new TypeError("an `abandoned` mapping must return its result, not a promise"));
    expect(emitted.map(event => event.eventType)).toEqual(["interaction.requested", "interaction.requested"]);
    await interactions.answer("c1", "t1", "permission", () => "allowed");
    expect(await latest).toBe("allowed");
  });

  test("recovery fields are defined, not assigned: an inherited setter or getter-only field neither swallows nor refuses them", () => {
    const { interactions } = holder();
    void interactions.await({ conversationId: "c1", item: question("q1", { schema: { type: "object" }, intro: "asks" }), detail: { note: "" }, cancellation: never, abandoned: reason => reason });
    let swallowed = 0;
    Object.defineProperty(Object.prototype, "schema", { set: () => { swallowed += 1; }, configurable: true });
    Object.defineProperty(Object.prototype, "intro", { get: () => "inherited", configurable: true });
    let listed: PendingQuestion[] | undefined;
    try {
      listed = interactions.list("question");
    } finally {
      delete (Object.prototype as { schema?: unknown }).schema;
      delete (Object.prototype as { intro?: unknown }).intro;
    }
    expect(swallowed).toBe(0);
    expect(Object.getOwnPropertyDescriptor(listed![0]!, "schema")?.value).toEqual({ type: "object" });
    expect(Object.getOwnPropertyDescriptor(listed![0]!, "intro")?.value).toBe("asks");
  });

  test("a delivered abort is a queued cancel: a reply queued before it wins, and a re-entrant read sees the request until the cancel runs", async () => {
    const { interactions, emitted } = holder();
    const abort = new AbortController();
    const target = interactions.await({ conversationId: "c1", item: permission("t1"), detail: { note: "" }, cancellation: abort.signal, abandoned: reason => reason });
    const outer = interactions.await({ conversationId: "c1", item: permission("t0"), detail: { note: "" }, cancellation: never, abandoned: reason => reason });
    let seenDuring: string[] | undefined;
    let reply: Promise<void> | undefined;
    await interactions.answer("c1", "t0", "permission", () => {
      reply = interactions.answer("c1", "t1", "permission", () => "allowed");
      abort.abort();
      seenDuring = interactions.list("permission").map(pending => pending.requestId);
      return "outer";
    });
    // Current state, read at once: t0 is mid-answer, and t1's cancel waits.
    expect(seenDuring).toEqual(["t1", "t0"]);
    await reply;
    expect(await target).toBe("allowed");
    expect(await outer).toBe("outer");
    expect(emitted.map(event => event.eventType)).toEqual(["interaction.requested", "interaction.requested"]);
  });

  test("abandonRegistrations ends exactly its registrations, in the holder's order, and leaves superseded or settled ones alone", async () => {
    const { interactions, emitted } = holder();
    const [a, b, aAgain, other] = [{}, {}, {}, {}];
    const first = interactions.await({ conversationId: "c1", item: permission("A"), detail: { note: "" }, cancellation: never, abandoned: reason => reason, token: a });
    const second = interactions.await({ conversationId: "c1", item: permission("B"), detail: { note: "" }, cancellation: never, abandoned: reason => reason, token: b });
    const redelivered = interactions.await({ conversationId: "c1", item: permission("A", { action: "Redelivered" }), detail: { note: "" }, cancellation: never, abandoned: reason => reason, token: aAgain });
    const untouched = interactions.await({ conversationId: "c1", item: permission("C"), detail: { note: "" }, cancellation: never, abandoned: reason => reason, token: other });
    expect(await first).toBe(SUPERSEDED_REASON);
    // The session's own order would be B, then the redelivered A; the holder's is A, B.
    interactions.abandonRegistrations([b, aAgain, a], "ended");
    expect([await second, await redelivered]).toEqual(["ended", "ended"]);
    expect(emitted.filter(event => event.eventType === "interaction.abandoned").map(event => (event.updates[0] as { item: PermissionRequest }).item.requestId)).toEqual(["A", "B"]);
    expect(interactions.list("permission").map(pending => pending.requestId)).toEqual(["C"]);
    interactions.abandonRegistrations([b, aAgain], "again");
    expect(emitted.filter(event => event.eventType === "interaction.abandoned")).toHaveLength(2);
    interactions.abandonRegistrations([other], "ended");
    expect(await untouched).toBe("ended");
  });

  describe("an abort another listener suppresses on the source signal", () => {
    test("is still delivered, settling the request with no later holder call", async () => {
      const { interactions, emitted } = holder();
      const abort = new AbortController();
      abort.signal.addEventListener("abort", event => event.stopImmediatePropagation());
      const result = interactions.await({ conversationId: "c1", item: permission("t1"), detail: { note: "" }, cancellation: abort.signal, abandoned: reason => reason });
      abort.abort();
      expect(await result).toBe(INTERRUPTED_REASON);
      expect(emitted.map(event => event.eventType)).toEqual(["interaction.requested", "interaction.abandoned"]);
      expect(interactions.list("permission")).toEqual([]);
      await expect(interactions.answer("c1", "t1", "permission", () => "allowed")).rejects.toThrow("no pending permission t1 for this conversation");
    });

    test("goes through the same order as any call: a reply queued before it wins, and a re-entrant read sees the request until it runs", async () => {
      const { interactions } = holder();
      const abort = new AbortController();
      abort.signal.addEventListener("abort", event => event.stopImmediatePropagation());
      const target = interactions.await({ conversationId: "c1", item: permission("t1"), detail: { note: "" }, cancellation: abort.signal, abandoned: reason => reason });
      void interactions.await({ conversationId: "c1", item: permission("t0"), detail: { note: "" }, cancellation: never, abandoned: reason => reason });
      let seenDuring: string[] | undefined;
      let reply: Promise<void> | undefined;
      await interactions.answer("c1", "t0", "permission", () => {
        reply = interactions.answer("c1", "t1", "permission", () => "allowed");
        abort.abort();
        seenDuring = interactions.list("permission").map(pending => pending.requestId);
        return "outer";
      });
      expect(seenDuring).toEqual(["t1", "t0"]);
      await reply;
      expect(await target).toBe("allowed");
    });

    test("its listeners, on the source and on the dependent signal, are each released once on settle", async () => {
      const { interactions } = holder();
      const abort = new AbortController();
      const any = AbortSignal.any;
      let removals = 0;
      let sourceRemovals = 0;
      const removeFromSource = abort.signal.removeEventListener.bind(abort.signal);
      abort.signal.removeEventListener = ((...args: Parameters<AbortSignal["removeEventListener"]>) => { sourceRemovals += 1; removeFromSource(...args); }) as AbortSignal["removeEventListener"];
      AbortSignal.any = (signals: AbortSignal[]) => {
        const dependent = any.call(AbortSignal, signals);
        const remove = dependent.removeEventListener.bind(dependent);
        dependent.removeEventListener = ((...args: Parameters<AbortSignal["removeEventListener"]>) => { removals += 1; remove(...args); }) as AbortSignal["removeEventListener"];
        return dependent;
      };
      let result: Promise<string>;
      try {
        result = interactions.await({ conversationId: "c1", item: permission("t1"), detail: { note: "" }, cancellation: abort.signal, abandoned: reason => reason });
      } finally {
        AbortSignal.any = any;
      }
      await interactions.answer("c1", "t1", "permission", () => "allowed");
      interactions.abandon("c1", "again");
      expect([sourceRemovals, removals]).toEqual([1, 1]);
      // A later abort finds nothing to cancel: the request settled with its answer.
      abort.abort();
      expect(await result).toBe("allowed");
    });
  });

  test("a sweep reads its tokens inside its own turn: a reply the iterable sets off waits behind it", async () => {
    const { interactions } = holder();
    const token = {};
    const result = interactions.await({ conversationId: "c1", item: permission("t1"), detail: { note: "" }, cancellation: never, abandoned: reason => reason, token });
    let reply: Promise<void> | undefined;
    function* tokens() {
      reply = interactions.answer("c1", "t1", "permission", () => "allowed");
      yield token;
    }
    interactions.abandonRegistrations(tokens(), "ended");
    expect(await result).toBe("ended");
    await expect(reply!).rejects.toThrow("no pending permission t1 for this conversation");
  });

  test("on the source signal the holder hears an abort in its listeners' order: a listener added later finds the request ended", async () => {
    const { interactions, emitted } = holder();
    const abort = new AbortController();
    const result = interactions.await({ conversationId: "c1", item: permission("t1"), detail: { note: "" }, cancellation: abort.signal, abandoned: reason => reason });
    let reply: Promise<void> | undefined;
    abort.signal.addEventListener("abort", () => {
      reply = interactions.answer("c1", "t1", "permission", () => "allowed");
    });
    abort.abort();
    expect(await result).toBe(INTERRUPTED_REASON);
    await expect(reply!).rejects.toThrow("no pending permission t1 for this conversation");
    expect(emitted.map(event => event.eventType)).toEqual(["interaction.requested", "interaction.abandoned"]);
  });

  test("an abort while the holder attaches its listeners is still delivered, after the request is announced", async () => {
    const { interactions, emitted } = holder();
    const abort = new AbortController();
    const attach = abort.signal.addEventListener.bind(abort.signal);
    abort.signal.addEventListener = ((...args: Parameters<AbortSignal["addEventListener"]>) => {
      if (!abort.signal.aborted) abort.abort();
      attach(...args);
    }) as AbortSignal["addEventListener"];
    const result = interactions.await({ conversationId: "c1", item: permission("t1"), detail: { note: "" }, cancellation: abort.signal, abandoned: reason => reason });
    expect(await result).toBe(INTERRUPTED_REASON);
    expect(emitted.map(event => event.eventType)).toEqual(["interaction.requested", "interaction.abandoned"]);
    expect(interactions.list("permission")).toEqual([]);
  });
});
