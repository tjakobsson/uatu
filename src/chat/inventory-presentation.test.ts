import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";

import {
  announceConversationInventory,
  renderConversationInventoryAwareness,
  renderSelectedConversationDeleted,
} from "./inventory-presentation";

const html = await Bun.file(`${import.meta.dir}/../index.html`).text();

function shell(): Document {
  return parseHTML(html).document;
}

describe("conversation inventory presentation", () => {
  test("renders a numeric acknowledgement button with singular and plural labels", () => {
    const document = shell();
    const indicator = document.querySelector<HTMLElement>("#chat-conversation-unseen-count")!;
    const tab = document.querySelector<HTMLElement>("#touch-tab-chat")!;
    const strip = document.querySelector<HTMLElement>("#chat-expand")!;

    renderConversationInventoryAwareness(document, 1);
    expect(indicator.hidden).toBe(false);
    expect(indicator.getAttribute("aria-label")).toBe("Acknowledge 1 new conversation");
    expect(indicator.getAttribute("title")).toBe("Acknowledge 1 new conversation");
    expect(indicator.querySelector(".chat-conversation-unseen-number")?.textContent).toBe("1");
    expect(tab.getAttribute("aria-label")).toBe("Chat, 1 new conversation");
    expect(strip.getAttribute("aria-label")).toBe("Open chat panel, 1 new conversation");

    renderConversationInventoryAwareness(document, 3);
    expect(indicator.getAttribute("aria-label")).toBe("Acknowledge 3 new conversations");
    expect(indicator.querySelector(".chat-conversation-unseen-number")?.textContent).toBe("3");
    expect(tab.hasAttribute("data-chat-inventory-attention")).toBe(true);
    expect(strip.hasAttribute("data-chat-inventory-attention")).toBe(true);

    renderConversationInventoryAwareness(document, 0);
    expect(indicator.hidden).toBe(true);
    expect(indicator.hasAttribute("aria-label")).toBe(false);
    expect(indicator.querySelector(".chat-conversation-unseen-number")?.textContent).toBe("0");
    expect(tab.getAttribute("aria-label")).toBe("Chat");
    expect(strip.getAttribute("aria-label")).toBe("Open chat panel");
  });

  test("announces count changes in the dedicated polite region", () => {
    const document = shell();
    const live = document.querySelector<HTMLElement>("#chat-conversation-inventory-live")!;

    announceConversationInventory(document, 1);
    expect(live.textContent).toBe("1 new conversation available.");
    announceConversationInventory(document, 4);
    expect(live.textContent).toBe("4 new conversations available.");
    announceConversationInventory(document, 0);
    expect(live.textContent).toBe("");
  });

  test("presents selected deletion without discarding the draft or disabling escape paths", () => {
    const document = shell();
    const select = document.querySelector<HTMLSelectElement>("#chat-conversation-select")!;
    const newButton = document.querySelector<HTMLButtonElement>("#chat-new-conversation")!;
    const renameButton = document.querySelector<HTMLButtonElement>("#chat-rename-conversation")!;
    const composer = document.querySelector<HTMLFormElement>("#chat-composer")!;
    const input = document.querySelector<HTMLTextAreaElement>("#chat-input")!;
    const state = document.querySelector<HTMLElement>("#chat-state")!;
    for (const [label, value] of [["First", "first"], ["Second", "second"]]) {
      const option = document.createElement("option");
      option.textContent = label;
      option.value = value;
      select.append(option);
    }
    let selectedValue = "second";
    Object.defineProperty(select, "value", {
      configurable: true,
      get: () => selectedValue,
      set: value => { selectedValue = String(value); },
    });
    composer.hidden = false;
    input.value = "Retained draft";

    renderSelectedConversationDeleted(document, true);
    expect(document.querySelector<HTMLElement>("#chat-conversation-unavailable")!.hidden).toBe(false);
    expect(state.hidden).toBe(true);
    expect(select.value).toBe("");
    expect(select.disabled).toBe(false);
    expect(newButton.disabled).toBe(false);
    expect(renameButton.disabled).toBe(true);
    expect(composer.hasAttribute("inert")).toBe(true);
    expect(input.value).toBe("Retained draft");
    expect(select.querySelector("option[data-chat-deleted-conversation]")?.textContent).toBe("Conversation deleted elsewhere");

    renderSelectedConversationDeleted(document, false);
    expect(document.querySelector<HTMLElement>("#chat-conversation-unavailable")!.hidden).toBe(true);
    expect(state.hidden).toBe(false);
    expect(select.value).toBe("second");
    expect(renameButton.disabled).toBe(false);
    expect(composer.hasAttribute("inert")).toBe(false);
    expect(input.value).toBe("Retained draft");
  });
});
