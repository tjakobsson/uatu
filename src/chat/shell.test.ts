import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";

const html = await Bun.file(`${import.meta.dir}/../index.html`).text();
const { document } = parseHTML(html);

describe("chat shell accessibility", () => {
  test("mounts one persistent Chat surface beside Preview", () => {
    expect(document.querySelectorAll("#chat-surface")).toHaveLength(1);
    expect(document.querySelector(".main-stack > #chat-surface")).not.toBeNull();
    // One switch per surface header — only the visible surface's copy is on
    // screen, so the control sits top-right without floating over the
    // terminal dock. The wiring syncs every instance.
    const groups = Array.from(document.querySelectorAll(".main-surface-switch"));
    expect(groups).toHaveLength(2);
    expect(document.querySelector(".preview-header .main-surface-switch")).not.toBeNull();
    expect(document.querySelector(".chat-header .main-surface-switch")).not.toBeNull();
    for (const group of groups) {
      expect(Array.from(group.querySelectorAll("button[data-main-surface]"))
        .map(button => button.getAttribute("data-main-surface"))).toEqual(["preview", "chat"]);
    }
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
    expect(document.querySelector("#chat-composer-status")?.getAttribute("aria-live")).toBe("polite");
    expect(document.querySelector("#chat-model-select")?.getAttribute("aria-label")).toBe("Chat model");
    expect(document.querySelector("#chat-conversation-select")?.getAttribute("aria-label")).toBe("Conversation");
    expect(document.querySelector("#chat-command-menu")?.getAttribute("role")).toBe("listbox");
    expect(document.querySelector("#chat-input")?.getAttribute("aria-controls")).toBe("chat-command-menu");
  });
});
