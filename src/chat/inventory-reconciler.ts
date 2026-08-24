import type { ConversationSummary } from "./types";

export function dedupeConversationInventory(conversations: ConversationSummary[]): ConversationSummary[] {
  const seen = new Set<string>();
  return conversations.filter(conversation => {
    if (seen.has(conversation.id)) return false;
    seen.add(conversation.id);
    return true;
  });
}

export class ConversationInventoryTracker {
  private baselineEstablished = false;
  private known = new Set<string>();
  private unseen = new Set<string>();

  reconcile(conversations: ConversationSummary[]): { unseenCount: number; increased: boolean } {
    const next = new Set(conversations.map(conversation => conversation.id));
    const previousCount = this.unseen.size;
    if (this.baselineEstablished) {
      for (const id of next) if (!this.known.has(id)) this.unseen.add(id);
    } else {
      this.baselineEstablished = true;
    }
    this.known = next;
    for (const id of this.unseen) if (!next.has(id)) this.unseen.delete(id);
    return { unseenCount: this.unseen.size, increased: this.unseen.size > previousCount };
  }

  noteLocalCreation(id: string): boolean {
    this.known.add(id);
    return this.unseen.delete(id);
  }

  isUnseen(id: string): boolean {
    return this.unseen.has(id);
  }

  acknowledge(): boolean {
    if (this.unseen.size === 0) return false;
    this.unseen.clear();
    return true;
  }

  get unseenCount(): number {
    return this.unseen.size;
  }

  get knownIds(): ReadonlySet<string> {
    return this.known;
  }

  get unseenIds(): ReadonlySet<string> {
    return this.unseen;
  }
}

export class SerializedInventoryReconciler {
  private running: Promise<void> | null = null;
  private dirty = false;
  private revision = 0;

  constructor(
    private readonly fetchInventory: () => Promise<ConversationSummary[]>,
    private readonly applyInventory: (conversations: ConversationSummary[]) => void,
    private readonly reportFailure: (error: unknown) => void,
  ) {}

  request(): Promise<void> {
    if (this.running) {
      this.dirty = true;
      return this.running;
    }
    this.running = Promise.resolve()
      .then(() => this.drain())
      .finally(() => { this.running = null; });
    return this.running;
  }

  supersede(): Promise<void> {
    this.revision += 1;
    return this.request();
  }

  private async drain(): Promise<void> {
    do {
      this.dirty = false;
      const revision = this.revision;
      try {
        const inventory = dedupeConversationInventory(await this.fetchInventory());
        if (revision === this.revision) this.applyInventory(inventory);
      } catch (error) {
        if (revision === this.revision) this.reportFailure(error);
      }
    } while (this.dirty);
  }
}

export function retainedPresentationConversationIds(
  conversations: ConversationSummary[],
  projectionId: string | null,
  unavailableSelectedId: string | null,
): Set<string> {
  const retained = new Set(conversations.map(conversation => conversation.id));
  if (projectionId) retained.add(projectionId);
  if (unavailableSelectedId) retained.add(unavailableSelectedId);
  return retained;
}

export function patchConversationOptions(
  select: HTMLSelectElement,
  conversations: ConversationSummary[],
  label: (conversation: ConversationSummary) => string,
): void {
  const desired = new Set(conversations.map(conversation => conversation.id));
  const options = new Map<string, HTMLOptionElement>();
  for (const option of Array.from(select.options)) {
    if (!option.value || option.hasAttribute("data-chat-deleted-conversation")) continue;
    if (options.has(option.value)) option.remove();
    else options.set(option.value, option);
  }
  for (const [id, option] of options) if (!desired.has(id)) option.remove();
  const desiredOptions = conversations.map(conversation => {
    let option = options.get(conversation.id);
    if (!option) {
      option = select.ownerDocument.createElement("option");
      option.value = conversation.id;
      select.append(option);
    }
    const nextLabel = label(conversation);
    if (option.text !== nextLabel) option.text = nextLabel;
    return option;
  });
  const currentOrder = Array.from(select.options).filter(option => option.value && !option.hasAttribute("data-chat-deleted-conversation"));
  if (currentOrder.some((option, index) => option !== desiredOptions[index])) {
    for (const option of desiredOptions) select.append(option);
  }
}

export function isConversationChooserActivationKey(event: Pick<KeyboardEvent, "key" | "altKey" | "ctrlKey" | "metaKey">): boolean {
  if (event.ctrlKey || event.metaKey) return false;
  if (["Enter", " ", "ArrowDown", "ArrowUp", "Home", "End", "PageDown", "PageUp"].includes(event.key)) return true;
  return !event.altKey && event.key.length === 1;
}
