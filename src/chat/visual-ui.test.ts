import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { renderChatMarkdown } from "./markdown";
import { decorateChatVisuals } from "./visual-ui";
const VISUAL_ID = "a".repeat(64);

describe("chat visual controls", () => {
  test("copy waits for source loading, not for network work inside the copy click", async () => {
    const oldFetch = globalThis.fetch;
    let finish!: (response: Response) => void;
    globalThis.fetch = (() => new Promise<Response>(resolve => { finish = resolve; })) as typeof fetch;
    try {
      const { document, window } = parseHTML(`<div id="root">${renderChatMarkdown("![Diagram](./slow.svg)", {
        visuals: [{ index: 0, status: "ready", id: VISUAL_ID, mimeType: "image/svg+xml" }],
      })}</div>`);
      const root = document.querySelector("#root") as unknown as HTMLElement;
      const copy = root.querySelector<HTMLButtonElement>("[data-visual-copy]")!;
      expect(copy.hasAttribute("disabled")).toBe(true);
      decorateChatVisuals(root);
      root.querySelector('[data-visual-tab="source"]')!.dispatchEvent(new window.Event("click", { bubbles: true }));
      expect(copy.hasAttribute("disabled")).toBe(true);
      finish(new Response("<svg/>", { headers: { "Content-Type": "text/plain" } }));
      for (let i = 0; i < 8; i++) await Promise.resolve();
      expect(copy.disabled).toBe(false);
      expect(root.querySelector(".chat-visual-source code")?.textContent).toBe("<svg/>");
      expect(root.querySelector<HTMLElement>(".chat-visual")?.dataset.visualSourceLoaded).toBe("true");
    } finally { globalThis.fetch = oldFetch; }
  });
  test("a completed decode failure shows the original reference even before binding", () => {
    const { document } = parseHTML(`<div id="root">${renderChatMarkdown('![Broken <shot>](./broken.png)', {
      visuals: [{ index: 0, status: "ready", id: VISUAL_ID, mimeType: "image/png" }],
    })}<p id="remaining">Keep reading this reply.</p></div>`);
    const root = document.querySelector("#root") as unknown as HTMLElement;
    const image = root.querySelector("img")!;
    // DOM-only tests cannot decode. Match a real browser's completed failure;
    // the browser suite separately exercises invalid PNG/JPEG bytes.
    Object.defineProperties(image, { complete: { value: true }, naturalWidth: { value: 0 } });
    decorateChatVisuals(root);
    decorateChatVisuals(root);
    const fallback = root.querySelector<HTMLElement>(".chat-visual-fallback")!;
    expect(fallback.hidden).toBe(false);
    expect(fallback.textContent).toBe("Could not display Broken <shot>. ./broken.png");
    expect(root.querySelector(".chat-visual-reference")?.textContent).toBe("./broken.png");
    expect(root.querySelector(".chat-visual-enlarge")).toBeNull();
    expect(root.querySelector("#remaining")?.textContent).toBe("Keep reading this reply.");
  });

  test("an image error reveals the inert fallback without removing SVG source controls", () => {
    const svg = '<svg><text>Exact &amp; source</text></svg>\n';
    const { document, window } = parseHTML(`<div id="root">${renderChatMarkdown(`\`\`\`svg\n${svg}\`\`\``, {
      visuals: [{ index: 0, status: "ready", id: VISUAL_ID, mimeType: "image/svg+xml" }],
    })}</div>`);
    const root = document.querySelector("#root") as unknown as HTMLElement;
    const image = root.querySelector("img")!;
    Object.defineProperties(image, { complete: { value: false }, naturalWidth: { value: 0 } });
    decorateChatVisuals(root);
    expect(root.querySelector<HTMLElement>(".chat-visual-fallback")!.hidden).toBe(true);
    expect(root.querySelector(".chat-visual-enlarge")).not.toBeNull();
    image.dispatchEvent(new window.Event("error"));
    expect(root.querySelector<HTMLElement>(".chat-visual-fallback")!.hidden).toBe(false);
    expect(root.querySelector(".chat-visual-enlarge")).toBeNull();
    expect(root.querySelector('[data-visual-tab="source"]')).not.toBeNull();
    expect(root.querySelector("[data-visual-copy]")).not.toBeNull();
    expect(root.querySelector(".chat-visual-source code")).not.toBeNull();
  });

  test("native source controls reveal the exact inert SVG and bind once", () => {
    const svg = '<svg><text>&amp; &quot; &#38;</text></svg>\n';
    const { document, window } = parseHTML(`<div id="root">${renderChatMarkdown(`\`\`\`svg\n${svg}\`\`\``)}</div>`);
    const root = document.querySelector("#root") as unknown as HTMLElement;
    decorateChatVisuals(root);
    decorateChatVisuals(root);
    const source = root.querySelector<HTMLElement>('[data-visual-tab="source"]')!;
    source.dispatchEvent(new window.Event("click", { bubbles: true }));
    expect(root.querySelector<HTMLElement>(".chat-visual-preview")!.hidden).toBe(true);
    expect(root.querySelector<HTMLElement>(".chat-visual-source")!.hidden).toBe(false);
    expect(root.querySelector(".chat-visual-source code")?.textContent).toBe(svg);
    expect(source.getAttribute("aria-pressed")).toBe("true");
    root.querySelector('[data-visual-tab="preview"]')!.dispatchEvent(new window.Event("click", { bubbles: true }));
    expect(root.querySelector<HTMLElement>(".chat-visual-source")!.hidden).toBe(true);
  });

  test("file SVG source loads once from the issued source route, not its original path", async () => {
    const oldFetch = globalThis.fetch;
    const requests: string[] = [];
    globalThis.fetch = (async input => {
      requests.push(String(input));
      return new Response('<svg><text>Original &amp; source</text></svg>');
    }) as typeof fetch;
    try {
      const { document, window } = parseHTML(`<div id="root">${renderChatMarkdown("![Diagram](./diagram.svg)", {
        visuals: [{ index: 0, status: "ready", id: VISUAL_ID, mimeType: "image/svg+xml" }],
      })}</div>`);
      const root = document.querySelector("#root") as unknown as HTMLElement;
      decorateChatVisuals(root);
      root.querySelector('[data-visual-tab="source"]')!.dispatchEvent(new window.Event("click", { bubbles: true }));
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
      expect(requests).toEqual([`/api/chat/visuals/${VISUAL_ID}/source`]);
      expect(root.querySelector(".chat-visual-source code")?.textContent).toContain("Original &amp; source");
      root.querySelector('[data-visual-tab="source"]')!.dispatchEvent(new window.Event("click", { bubbles: true }));
      expect(requests).toHaveLength(1);
    } finally { globalThis.fetch = oldFetch; }
  });
});
