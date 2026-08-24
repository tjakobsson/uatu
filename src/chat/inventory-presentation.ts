const DELETED_OPTION_ATTRIBUTE = "data-chat-deleted-conversation";
const PREVIOUS_SELECTION_ATTRIBUTE = "data-chat-selection-before-deletion";
const PREVIOUS_DISABLED_ATTRIBUTE = "data-chat-inventory-previously-disabled";
const PREVIOUS_HIDDEN_ATTRIBUTE = "data-chat-inventory-previously-hidden";

function conversationCountLabel(count: number): string {
  return `${count} new ${count === 1 ? "conversation" : "conversations"}`;
}

function normalizedCount(count: number): number {
  return Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
}

function forceEnabled(control: HTMLButtonElement | HTMLSelectElement | null, enabled: boolean): void {
  if (!control) return;
  if (enabled) {
    if (!control.hasAttribute(PREVIOUS_DISABLED_ATTRIBUTE)) {
      control.setAttribute(PREVIOUS_DISABLED_ATTRIBUTE, control.disabled ? "true" : "false");
    }
    control.disabled = false;
    return;
  }
  const previous = control.getAttribute(PREVIOUS_DISABLED_ATTRIBUTE);
  if (previous === null) return;
  control.disabled = previous === "true";
  control.removeAttribute(PREVIOUS_DISABLED_ATTRIBUTE);
}

function markRenameUnavailable(button: HTMLButtonElement | null, unavailable: boolean): void {
  if (!button) return;
  if (unavailable) {
    if (!button.hasAttribute(PREVIOUS_DISABLED_ATTRIBUTE)) {
      button.setAttribute(PREVIOUS_DISABLED_ATTRIBUTE, button.disabled ? "true" : "false");
    }
    button.disabled = true;
    return;
  }
  const previous = button.getAttribute(PREVIOUS_DISABLED_ATTRIBUTE);
  if (previous === null) return;
  button.disabled = previous === "true";
  button.removeAttribute(PREVIOUS_DISABLED_ATTRIBUTE);
}

export function renderConversationInventoryAwareness(root: Document, count: number): void {
  const unseenCount = normalizedCount(count);
  const hasUnseen = unseenCount > 0;
  const countLabel = hasUnseen ? conversationCountLabel(unseenCount) : "";
  const visibleCount = root.querySelector<HTMLButtonElement>("#chat-conversation-unseen-count");
  const visibleNumber = visibleCount?.querySelector<HTMLElement>(".chat-conversation-unseen-number");
  const touchTab = root.querySelector<HTMLElement>("#touch-tab-chat");
  const expandStrip = root.querySelector<HTMLElement>("#chat-expand");

  if (visibleCount) {
    visibleCount.hidden = !hasUnseen;
    if (visibleNumber) visibleNumber.textContent = String(unseenCount);
    if (hasUnseen) {
      const acknowledgeLabel = `Acknowledge ${countLabel}`;
      visibleCount.setAttribute("aria-label", acknowledgeLabel);
      visibleCount.setAttribute("title", acknowledgeLabel);
    } else {
      visibleCount.removeAttribute("aria-label");
      visibleCount.removeAttribute("title");
    }
  }
  touchTab?.toggleAttribute("data-chat-inventory-attention", hasUnseen);
  touchTab?.setAttribute("aria-label", hasUnseen ? `Chat, ${countLabel}` : "Chat");
  expandStrip?.toggleAttribute("data-chat-inventory-attention", hasUnseen);
  const expandLabel = hasUnseen ? `Open chat panel, ${countLabel}` : "Open chat panel";
  expandStrip?.setAttribute("aria-label", expandLabel);
  expandStrip?.setAttribute("title", expandLabel);
}

export function announceConversationInventory(root: Document, count: number): void {
  const unseenCount = normalizedCount(count);
  const live = root.querySelector<HTMLElement>("#chat-conversation-inventory-live");
  if (live) live.textContent = unseenCount > 0 ? `${conversationCountLabel(unseenCount)} available.` : "";
}

export function renderSelectedConversationDeleted(root: Document, deleted: boolean): void {
  const surface = root.querySelector<HTMLElement>("#chat-surface");
  const notice = root.querySelector<HTMLElement>("#chat-conversation-unavailable");
  const state = root.querySelector<HTMLElement>("#chat-state");
  const select = root.querySelector<HTMLSelectElement>("#chat-conversation-select");
  const newButton = root.querySelector<HTMLButtonElement>("#chat-new-conversation");
  const renameButton = root.querySelector<HTMLButtonElement>("#chat-rename-conversation");
  const renameForm = root.querySelector<HTMLFormElement>("#chat-rename-form");
  const composer = root.querySelector<HTMLFormElement>("#chat-composer");

  surface?.toggleAttribute("data-selected-conversation-deleted", deleted);
  if (notice) notice.hidden = !deleted;
  if (state) {
    if (deleted) {
      if (!state.hasAttribute(PREVIOUS_HIDDEN_ATTRIBUTE)) {
        state.setAttribute(PREVIOUS_HIDDEN_ATTRIBUTE, state.hidden ? "true" : "false");
      }
      state.hidden = true;
    } else {
      const previous = state.getAttribute(PREVIOUS_HIDDEN_ATTRIBUTE);
      if (previous !== null) {
        state.hidden = previous === "true";
        state.removeAttribute(PREVIOUS_HIDDEN_ATTRIBUTE);
      }
    }
  }
  if (composer) {
    composer.toggleAttribute("inert", deleted);
    if (deleted) composer.setAttribute("aria-disabled", "true");
    else composer.removeAttribute("aria-disabled");
  }
  if (deleted && renameForm) renameForm.hidden = true;
  markRenameUnavailable(renameButton, deleted);
  forceEnabled(select, deleted);
  forceEnabled(newButton, deleted);

  if (!select) return;
  const placeholder = select.querySelector<HTMLOptionElement>(`option[${DELETED_OPTION_ATTRIBUTE}]`);
  if (deleted) {
    if (!placeholder) {
      select.setAttribute(PREVIOUS_SELECTION_ATTRIBUTE, select.value);
      const option = root.createElement("option");
      option.setAttribute(DELETED_OPTION_ATTRIBUTE, "");
      option.value = "";
      option.textContent = "Conversation deleted elsewhere";
      option.disabled = true;
      select.prepend(option);
    }
    select.value = "";
    return;
  }

  if (!placeholder) return;
  const previousSelection = select.getAttribute(PREVIOUS_SELECTION_ATTRIBUTE) ?? "";
  const placeholderWasSelected = select.value === "";
  placeholder.remove();
  select.removeAttribute(PREVIOUS_SELECTION_ATTRIBUTE);
  if (placeholderWasSelected && Array.from(select.options).some(option => option.value === previousSelection)) {
    select.value = previousSelection;
  }
}
