import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";

const html = await Bun.file(`${import.meta.dir}/../index.html`).text();
const { document } = parseHTML(html);

describe("chat shell accessibility", () => {
  test("mounts one persistent Chat surface beside Preview in the work row", () => {
    expect(document.querySelectorAll("#chat-surface")).toHaveLength(1);
    // Preview | divider | Chat inside the work row, which is the main-stack's
    // content child — the terminal resizer/panel stay direct stack children
    // so the dock rules keep their [content, resizer, panel] shape.
    expect(document.querySelector(".main-stack > .work-row > #chat-surface")).not.toBeNull();
    expect(document.querySelector(".main-stack > .work-row > .preview-shell")).not.toBeNull();
    expect(document.querySelector(".work-row > #chat-resizer + #chat-surface")).not.toBeNull();
    expect(document.querySelector(".main-stack > #terminal-panel")).not.toBeNull();
  });

  test("the panel owns collapse and reopen affordances with accessible names", () => {
    // The strip is the collapsed panel's entire presentation, INSIDE the
    // surface so activating it is an interaction active-surface tracking can
    // claim like any other click.
    expect(document.querySelector("#chat-surface > #chat-expand")?.getAttribute("aria-label")).toBe("Open chat panel");
    expect(document.querySelector(".chat-header #chat-collapse")?.getAttribute("aria-label")).toBe("Collapse chat panel");
    const resizer = document.querySelector("#chat-resizer");
    expect(resizer?.getAttribute("role")).toBe("separator");
    expect(resizer?.getAttribute("aria-orientation")).toBe("vertical");
    // Keyboard-operable divider.
    expect(resizer?.getAttribute("tabindex")).toBe("0");
    // The segmented Preview/Chat switch is retired — nothing should recreate it.
    expect(document.querySelector(".main-surface-switch")).toBeNull();
    expect(document.querySelector("[data-main-surface]")).toBeNull();
  });

  test("exposes exactly four ordered touch tabs with selection semantics", () => {
    const bar = document.querySelector("#touch-tab-bar");
    expect(bar?.getAttribute("role")).toBe("tablist");
    const tabs = Array.from(bar?.querySelectorAll('[role="tab"]') ?? []);
    expect(tabs.map(tab => tab.getAttribute("data-tab"))).toEqual(["files", "preview", "chat", "terminal"]);
    expect(tabs.every(tab => tab.hasAttribute("aria-selected"))).toBe(true);
  });

  test("labels the timeline, composer, chooser, status, and request controls", () => {
    expect(document.querySelector("#chat-timeline")?.getAttribute("role")).toBe("log");
    expect(document.querySelector('label[for="chat-input"]')).not.toBeNull();
    expect(document.querySelector("#chat-composer-status")?.getAttribute("role")).toBe("img");
    expect(document.querySelector("#chat-composer-status")?.getAttribute("aria-label")).toBe("Ready");
    expect(document.querySelector("#chat-composer-status-live")?.getAttribute("aria-live")).toBe("polite");
    expect(document.querySelector("#chat-composer-error")).not.toBeNull();
    expect(document.querySelector("#chat-configuration-trigger")?.getAttribute("aria-haspopup")).toBe("dialog");
    expect(document.querySelector("#chat-configuration-trigger")?.getAttribute("aria-controls")).toBe("chat-configuration-dialog");
    expect(document.querySelectorAll("#chat-model-select, #chat-mode-select, #chat-variant-select")).toHaveLength(0);
    expect(document.querySelector("#chat-configuration-dialog")?.getAttribute("aria-labelledby")).toBe("chat-configuration-title");
    expect(document.querySelector("#chat-conversation-select")?.getAttribute("aria-label")).toBe("Conversation");
    expect(document.querySelector("#chat-rename-conversation")?.getAttribute("aria-label")).toBe("Rename conversation");
    expect(document.querySelector("#chat-new-conversation")?.textContent).toBe("New conversation");
    expect(html).not.toContain("New agent");
    expect(document.querySelector("#chat-command-menu")?.getAttribute("role")).toBe("listbox");
    expect(document.querySelector("#chat-input")?.getAttribute("aria-controls")).toBe("chat-command-menu");
    expect(document.querySelector("#chat-conversation-unseen-count")?.tagName).toBe("BUTTON");
    expect(document.querySelector("#chat-conversation-unseen-count .chat-conversation-unseen-number")).not.toBeNull();
    expect(document.querySelector("#chat-conversation-inventory-live")?.getAttribute("aria-live")).toBe("polite");
    expect(document.querySelector("#chat-conversation-inventory-live")?.getAttribute("aria-atomic")).toBe("true");
    expect(document.querySelector("#chat-conversation-unavailable")?.getAttribute("role")).toBe("status");
  });
});
