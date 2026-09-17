// Same replay/snapshot pattern as chat-service.ts, deliberately without its
// filesystem attachment store or any real provider/adapter imports.
import { ConversationReplay, type ReplaySubscription } from "../../src/chat/replay";
import type { AgentChatStatus, ConversationItem, ConversationSnapshot, ConversationSummary } from "../../src/chat/types";

export class DemoChatService {
  private readonly conversations = new Map<string, ConversationSnapshot>();
  private readonly replay = new Map<string, ConversationReplay>();
  private readonly subscriptions = new Set<ReplaySubscription>();
  private readonly receipts = new Map<string, string>();
  private sequence = 0;
  readonly agent;
  constructor(readonly workspace: string, readonly name: string, readonly generation: string,
    private readonly restoreFile: (path: string, contents: string | null) => Promise<void>,
    readonly saveAttachment: (bytes: Uint8Array) => Promise<{ id: string; mimeType: string; sizeBytes: number }>) {
    this.agent = { id: `demo-${workspace}`, name: "Simulated agent" };
    for (const title of ["Planning", "Review"]) this.seed(`${name} · ${title}`, [{ id: `${workspace}-${title}`, type: "assistant_message", createdAt: 1,
      markdown: `${title} transcript belongs to ${workspace} only. This response is simulated; no provider was invoked.` }]);
  }
  seed(title: string, items: ConversationItem[]) {
    const id = `${this.agent.id}:conversation-${++this.sequence}`;
    const replay = new ConversationReplay(this.generation, id, 64 * 1024);
    this.replay.set(id, replay);
    const snapshot: ConversationSnapshot = { conversation: { id, title, createdAt: this.sequence, updatedAt: this.sequence, status: "idle", agent: this.agent },
      configuration: {}, generation: this.generation, cursor: replay.latestCursor(), items };
    this.conversations.set(id, snapshot); return structuredClone(snapshot);
  }
  async status(): Promise<AgentChatStatus[]> {
    return [{ agent: this.agent, availability: { state: "ready", version: "simulated", agent: { ...this.agent, capabilities: ["attachments"] } } }];
  }
  async models(_agent: string) { return []; }
  async modes(_agent: string) { return []; }
  async commands(_agent: string) { return []; }
  async listConversations(): Promise<ConversationSummary[]> { return [...this.conversations.values()].map(snapshot => structuredClone(snapshot.conversation)); }
  async createConversation(_agent: string) { return this.seed(`${this.name} · New conversation`, []); }
  async history(id: string) {
    const snapshot = this.conversations.get(id);
    if (!snapshot) throw new Error("Conversation is not in this workspace");
    return structuredClone({ ...snapshot, cursor: this.replay.get(id)!.latestCursor() });
  }
  async subscribe(id: string, options: { signal?: AbortSignal; cursor?: string } = {}) {
    const snapshot = await this.history(id);
    const handoff = this.replay.get(id)!.handoff(() => snapshot, options.cursor, options.signal);
    this.subscriptions.add(handoff.subscription);
    return { snapshot: handoff.snapshot, events: handoff.subscription };
  }
  async prompt(id: string, requestId: string, text: string) {
    await this.history(id);
    const previous = this.receipts.get(requestId);
    if (previous) return { messageId: previous, held: false, configuration: {} };
    const messageId = crypto.randomUUID();
    const items: ConversationItem[] = [{ id: messageId, type: "user_message", createdAt: Date.now(), text },
      { id: `${messageId}-reply`, type: "assistant_message", createdAt: Date.now(), markdown: `Simulated reply in ${this.workspace}: ${text}` }];
    for (const item of items) { this.conversations.get(id)!.items.push(item); this.replay.get(id)!.publish({ type: "item.upsert", item }); }
    this.receipts.set(requestId, messageId);
    return { messageId, held: false, configuration: {} };
  }
  // Explicitly test-only file restoration seam, always the workspace's Map.
  async restoreFixture(path: string, contents: string | null) { await this.restoreFile(path, contents); }
  reset() { for (const subscription of this.subscriptions) subscription.cancel(); this.subscriptions.clear(); this.conversations.clear(); this.receipts.clear(); }
}
