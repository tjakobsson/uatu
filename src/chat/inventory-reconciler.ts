import { clockTime, dayLabel, knownTime, localDayKey } from "./dates";
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

  // Dispatches the fetch before returning: `fetchInventory` has been called
  // by the time the caller regains control. Lifecycle recovery relies on
  // this — it closes the streams it is replacing, requests the inventory,
  // and only then reopens streams, so the request is at the head of the
  // browser's per-host connection queue rather than behind the replacements.
  request(): Promise<void> {
    if (this.running) {
      this.dirty = true;
      return this.running;
    }
    this.running = this.drain().finally(() => { this.running = null; });
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

// The chooser's day heading for a conversation: the reader-local day of its
// last activity (`updatedAt`), the rule OpenCode's own session list uses,
// worded like the timeline's day separators. A time ahead of the reader's
// clock is read as now; a conversation with no usable time is undated.
export type ConversationDayGroup = { key: string; label: string };
export const UNDATED_GROUP: ConversationDayGroup = { key: "undated", label: "Undated" };

export function conversationDayGroup(conversation: ConversationSummary, now = Date.now()): ConversationDayGroup {
  if (!knownTime(conversation.updatedAt)) return UNDATED_GROUP;
  const at = Math.min(conversation.updatedAt, now);
  return { key: localDayKey(at), label: dayLabel(at, now) };
}

/** " · 14:32": the last activity's clock time for a chooser label, or nothing when undated. */
export function conversationActivitySuffix(conversation: ConversationSummary, now = Date.now()): string {
  return knownTime(conversation.updatedAt) ? ` · ${clockTime(Math.min(conversation.updatedAt, now))}` : "";
}

const DAY_GROUP_ATTRIBUTE = "data-chat-day";

// Patches the chooser's conversation options in place (keyed by id, so the
// selected option element survives) and, given `group`, files them under one
// <optgroup> per day, in first-appearance order of the (newest-first) list.
// Undated conversations follow the dated days; they get their own heading
// only when some conversation is dated — a list of nothing but undated
// conversations stays flat, as it was before days were shown.
export function patchConversationOptions(
  select: HTMLSelectElement,
  conversations: ConversationSummary[],
  label: (conversation: ConversationSummary) => string,
  group?: (conversation: ConversationSummary) => ConversationDayGroup,
): void {
  const selectedValue = select.value;
  const desired = new Set(conversations.map(conversation => conversation.id));
  const options = new Map<string, HTMLOptionElement>();
  for (const option of Array.from(select.options)) {
    if (!option.value || option.hasAttribute("data-chat-deleted-conversation")) continue;
    if (options.has(option.value)) option.remove();
    else options.set(option.value, option);
  }
  for (const [id, option] of options) if (!desired.has(id)) option.remove();
  const days = new Map<string, { group: ConversationDayGroup; options: HTMLOptionElement[] }>();
  const undated: HTMLOptionElement[] = [];
  for (const conversation of conversations) {
    let option = options.get(conversation.id);
    if (!option) {
      option = select.ownerDocument.createElement("option");
      option.value = conversation.id;
    }
    const nextLabel = label(conversation);
    if (option.text !== nextLabel) option.text = nextLabel;
    const day = group?.(conversation);
    if (!day || day.key === UNDATED_GROUP.key) {
      undated.push(option);
      continue;
    }
    const entry = days.get(day.key) ?? { group: day, options: [] };
    entry.options.push(option);
    days.set(day.key, entry);
  }
  if (undated.length && days.size) days.set(UNDATED_GROUP.key, { group: UNDATED_GROUP, options: undated.splice(0) });

  const existingGroups = new Map<string, HTMLOptGroupElement>();
  for (const element of Array.from(select.querySelectorAll<HTMLOptGroupElement>(`optgroup[${DAY_GROUP_ATTRIBUTE}]`))) {
    const key = element.getAttribute(DAY_GROUP_ATTRIBUTE)!;
    if (days.has(key) && !existingGroups.has(key)) existingGroups.set(key, element);
  }
  // The desired layout: each day's heading holding its options, then any
  // ungrouped options.
  const layout: Array<{ node: HTMLOptGroupElement | HTMLOptionElement; children?: HTMLOptionElement[] }> = [];
  for (const [key, { group: day, options: members }] of days) {
    let heading = existingGroups.get(key);
    if (!heading) {
      heading = select.ownerDocument.createElement("optgroup");
      heading.setAttribute(DAY_GROUP_ATTRIBUTE, key);
    }
    if (heading.label !== day.label) heading.label = day.label;
    layout.push({ node: heading, children: members });
  }
  for (const option of undated) layout.push({ node: option });

  const wanted = new Set<Element>(layout.map(entry => entry.node));
  const current = Array.from(select.children).filter(child =>
    child.matches(`optgroup[${DAY_GROUP_ATTRIBUTE}]`) || (child.tagName === "OPTION" && desired.has((child as HTMLOptionElement).value)));
  const inPlace = current.length === layout.length
    && current.every((child, index) => child === layout[index]!.node)
    && layout.every(entry => !entry.children
      || (entry.node.children.length === entry.children.length && entry.children.every((option, index) => entry.node.children[index] === option)));
  if (!inPlace) {
    for (const entry of layout) {
      select.append(entry.node);
      for (const option of entry.children ?? []) entry.node.append(option);
    }
  }
  for (const element of Array.from(select.querySelectorAll(`optgroup[${DAY_GROUP_ATTRIBUTE}]`))) {
    if (!wanted.has(element)) element.remove();
  }
  // Moving the selected option between headings can hand the selection to
  // another option; the chooser's selection is not the patch's to change.
  if (!inPlace && selectedValue && select.value !== selectedValue
    && Array.from(select.options).some(option => option.value === selectedValue)) {
    select.value = selectedValue;
  }
}

export function isConversationChooserActivationKey(event: Pick<KeyboardEvent, "key" | "altKey" | "ctrlKey" | "metaKey">): boolean {
  if (event.ctrlKey || event.metaKey) return false;
  if (["Enter", " ", "ArrowDown", "ArrowUp", "Home", "End", "PageDown", "PageUp"].includes(event.key)) return true;
  return !event.altKey && event.key.length === 1;
}
