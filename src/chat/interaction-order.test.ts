import { expect, test } from "bun:test";
import { activeInteractionRequests, PermissionQueueOrder } from "./interaction-order";
import type { PermissionRequest } from "./types";

const permission = (id: string, createdAt = 1): PermissionRequest => ({
  id: `permission:${id}`, requestId: id, type: "permission", createdAt,
  action: "shell", resources: [id], status: "pending",
});

test("live permissions keep arrival order through timestamp skew and duplicate announcements", () => {
  const queue = new PermissionQueueOrder();
  const first = queue.observe(permission("z", 100));
  const second = queue.observe(permission("a", 1));
  const duplicate = queue.observe({ ...first, createdAt: 200 });
  expect(duplicate.queueOrder).toBe(first.queueOrder);
  expect(activeInteractionRequests([second, duplicate], "parent").map(item => item.id)).toEqual([first.id]);
});

test("recovery inserts missed permissions ahead of known requests and later live arrivals", () => {
  const queue = new PermissionQueueOrder();
  const known = queue.observe(permission("known"));
  const read = queue.beginRead();
  const later = queue.observe(permission("later"));
  queue.reconcile(["permission:missed", known.id], read);
  const missed = queue.observe(permission("missed"));
  const recovered = queue.observe(known);
  expect(missed.queueOrder!).toBeLessThan(recovered.queueOrder!);
  expect(recovered.queueOrder!).toBeLessThan(later.queueOrder!);
  // Refreshing an unchanged set must not churn queue metadata or move cards.
  queue.reconcile([missed.id, known.id, later.id], queue.beginRead());
  expect(queue.observe(missed).queueOrder).toBe(missed.queueOrder);
  expect(queue.observe(known).queueOrder).toBe(recovered.queueOrder);
});

test("late list responses cannot replace a newer recovered order", () => {
  const queue = new PermissionQueueOrder();
  const old = queue.beginRead();
  const fresh = queue.beginRead();
  queue.reconcile(["permission:z", "permission:a"], fresh);
  queue.reconcile(["permission:a", "permission:z"], old);
  const z = queue.observe(permission("z"));
  const a = queue.observe(permission("a"));
  expect(activeInteractionRequests([a, z], "parent")[0]?.id).toBe(z.id);
});

test("permissions take precedence over questions within each independent owner", () => {
  const own = permission("own");
  const child = { ...permission("child"), conversationId: "child" };
  const question = { id: "question:new", type: "question" as const, requestId: "new", createdAt: 100, status: "pending" as const, questions: [] };
  expect(activeInteractionRequests([question, own, child], "parent").map(item => item.id)).toEqual([own.id, child.id]);
});
