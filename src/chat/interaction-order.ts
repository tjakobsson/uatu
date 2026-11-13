import type { ConversationItem, PermissionRequest, QuestionRequest } from "./types";

type Request = PermissionRequest | QuestionRequest;

/** One answerable request per owner. Permissions are FIFO; questions retain
 * their existing newest-first rule when no permission is pending. */
export function activeInteractionRequests(items: readonly ConversationItem[], conversationId: string): Request[] {
  const owners = new Map<string, Request>();
  for (const item of items) {
    if ((item.type !== "permission" && item.type !== "question") || item.status !== "pending") continue;
    const owner = item.conversationId ?? conversationId;
    const current = owners.get(owner);
    if (!current || precedes(item, current)) owners.set(owner, item);
  }
  return [...owners.values()];
}

function precedes(item: Request, current: Request): boolean {
  if (item.type !== current.type) return item.type === "permission";
  if (item.type === "permission" && current.type === "permission") {
    // Missing metadata is supported for older snapshots and isolated renderers.
    // Equal keys retain input order, never an arbitrary lexical request id.
    return (item.queueOrder ?? item.createdAt) < (current.queueOrder ?? current.createdAt);
  }
  return item.createdAt > current.createdAt || item.createdAt === current.createdAt && item.id > current.id;
}

/** Adapter-lifetime order shared by owning and mirrored projections. A list
 * read reserves a slot before awaiting the provider: live arrivals during the
 * read belong after the recovered queue, including when timestamps tie. */
export class PermissionQueueOrder {
  private clock = 0;
  private reconciledAt = 0;
  private readonly orders = new Map<string, number>();

  beginRead(): number { return ++this.clock; }

  observe(item: PermissionRequest): PermissionRequest {
    if (item.status !== "pending") return item;
    let order = this.orders.get(item.id);
    if (order === undefined) {
      order = ++this.clock;
      this.orders.set(item.id, order);
    }
    return { ...item, queueOrder: order };
  }

  reconcile(ids: readonly string[], startedAt: number): void {
    // An older response cannot replace a more recently started snapshot.
    if (startedAt < this.reconciledAt) return;
    this.reconciledAt = startedAt;
    const live = new Set(ids);
    for (const [id, order] of this.orders) {
      if (!live.has(id) && order < startedAt) this.orders.delete(id);
    }
    // Ordinary refreshes must not republish an unchanged queue. Rebase only
    // when the snapshot fills a gap or corrects observed event order.
    let previous = -Infinity;
    const unchanged = ids.every(id => {
      const order = this.orders.get(id);
      if (order === undefined || order <= previous) return false;
      previous = order;
      return true;
    });
    if (unchanged) return;
    ids.forEach((id, index) => this.orders.set(id, startedAt + (index + 1) / (ids.length + 1)));
  }

  forget(itemId: string): void { this.orders.delete(itemId); }
}
