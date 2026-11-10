import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { renderChatMarkdown } from "./markdown";
import { decorateChatVisuals, reconcileChatVisuals } from "./visual-ui";
const VISUAL_ID = "a".repeat(64);

describe("chat visual controls", () => {
  test("pending Source and focused Copy survive capture while handlers load only the newly issued immutable source", async () => {
    const oldFetch = globalThis.fetch;
    const requests: string[] = [];
    let finish!: (response: Response) => void;
    globalThis.fetch = (async input => {
      requests.push(String(input));
      return new Promise<Response>(resolve => { finish = resolve; });
    }) as typeof fetch;
    try {
      const { document, window } = parseHTML('<div id="root"></div>');
      const root = document.querySelector("#root") as unknown as HTMLElement;
      root.innerHTML = renderChatMarkdown("```svg\r\n<svg>prefix", { streaming: true, visuals: [{ index: 0, status: "pending" }] });
      decorateChatVisuals(root);
      root.querySelector('[data-visual-tab="source"]')!.dispatchEvent(new window.Event("click", { bubbles: true }));
      const oldCopy = root.querySelector("[data-visual-copy]");
      // linkedom has no native focus implementation. Test the logical-control
      // mapping here; Chromium/WebKit tests exercise actual keyboard focus.
      Object.defineProperty(document, "activeElement", { configurable: true, value: oldCopy });
      const stage = document.createElement("div") as unknown as HTMLElement;
      const completed = "```svg\r\n<svg>prefix completed</svg>\r\n```\r\n";
      stage.innerHTML = renderChatMarkdown(completed, { visuals: [{ index: 0, status: "ready", id: VISUAL_ID, mimeType: "image/svg+xml" }] });
      const focus = reconcileChatVisuals(root, stage);
      const nextCopy = stage.querySelector<HTMLButtonElement>("[data-visual-copy]")!;
      expect(focus).toBe(nextCopy);
      expect(nextCopy.disabled).toBe(false);
      expect(nextCopy.getAttribute("aria-disabled")).toBe("true");
      root.replaceChildren(...Array.from(stage.childNodes));
      decorateChatVisuals(root);
      expect(root.querySelector<HTMLElement>(".chat-visual-source")!.hidden).toBe(false);
      expect(root.querySelector('[data-visual-tab="source"]')!.getAttribute("aria-pressed")).toBe("true");
      expect(requests).toEqual([`/api/chat/visuals/${VISUAL_ID}/source`]);
      // No pending-prefix cache is passed off as captured bytes.
      expect(root.querySelector("code")!.textContent).not.toBe("<svg>prefix");
      const captured = '<svg>Immutable &amp; bytes</svg>\r\n';
      finish(new Response(captured));
      for (let i = 0; i < 8; i++) await Promise.resolve();
      expect(root.querySelector("code")!.textContent).toBe(captured);
      expect(nextCopy.hasAttribute("aria-disabled")).toBe(false);
      expect(nextCopy.disabled).toBe(false);
      const retained = root.querySelector(".chat-visual");
      const image = root.querySelector("img");
      stage.innerHTML = renderChatMarkdown(completed + "\nMore prose.", { visuals: [{ index: 0, status: "ready", id: VISUAL_ID, mimeType: "image/svg+xml" }] });
      reconcileChatVisuals(root, stage);
      root.replaceChildren(...Array.from(stage.childNodes));
      decorateChatVisuals(root);
      expect(root.querySelector(".chat-visual")).toBe(retained);
      expect(root.querySelector("img")).toBe(image);
      expect(root.querySelector("code")!.textContent).toBe(captured);
      expect(requests).toHaveLength(1);
    } finally { globalThis.fetch = oldFetch; }
  });

  test("a stale source response cannot populate the replacement snapshot at the same occurrence", async () => {
    const oldFetch = globalThis.fetch;
    const replies: Array<(response: Response) => void> = [];
    globalThis.fetch = new Proxy(oldFetch, {
      apply() { return new Promise<Response>(resolve => { replies.push(resolve); }); },
    });
    try {
      const { document, window } = parseHTML('<div id="root"></div>');
      const root = document.querySelector("#root") as unknown as HTMLElement;
      const markdown = "```svg\n<svg/>\n```\n";
      const render = (id: string) => renderChatMarkdown(markdown, { visuals: [{ index: 0, status: "ready", id, mimeType: "image/svg+xml" }] });
      root.innerHTML = render(VISUAL_ID);
      decorateChatVisuals(root);
      root.querySelector('[data-visual-tab="source"]')!.dispatchEvent(new window.Event("click", { bubbles: true }));
      const stage = document.createElement("div") as unknown as HTMLElement;
      stage.innerHTML = render("b".repeat(64));
      reconcileChatVisuals(root, stage);
      root.replaceChildren(...Array.from(stage.childNodes));
      decorateChatVisuals(root);
      expect(replies).toHaveLength(2);
      replies[0]!(new Response("old snapshot"));
      for (let i = 0; i < 8; i++) await Promise.resolve();
      expect(root.querySelector("code")!.textContent).toBe("");
      expect(root.querySelector("[data-visual-copy]")!.hasAttribute("disabled")).toBe(true);
      replies[1]!(new Response("replacement snapshot"));
      for (let i = 0; i < 8; i++) await Promise.resolve();
      expect(root.querySelector("code")!.textContent).toBe("replacement snapshot");
      expect(root.querySelector<HTMLElement>(".chat-visual-source")!.hidden).toBe(false);
    } finally { globalThis.fetch = oldFetch; }
  });

  test("copy waits for source loading, not for network work inside the copy click", async () => {
    const oldFetch = globalThis.fetch;
    let finish!: (response: Response) => void;
    globalThis.fetch = new Proxy(oldFetch, {
      apply() { return new Promise<Response>(resolve => { finish = resolve; }); },
    });
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

  for (const attributes of ['id="chat-aside-answer"', 'class="chat-request-plan"', 'class="chat-subagent-result"']) {
    test(`uncaptured ${attributes} keeps visible source and idempotent ordinary code-copy controls`, () => {
      const previousDocument = Reflect.get(globalThis, "document");
      const svg = '<svg><text>&amp; &quot; &#38;</text></svg>\n';
      const markdown = `\`\`\`svg\n${svg}\`\`\`\n\n\`\`\`js\nconst value = 1;\n\`\`\`\n\n![Local](./diagram.svg)\n\n![Remote](https://example.invalid/track.png)`;
      const { document } = parseHTML(`<div id="root"><div ${attributes}>${renderChatMarkdown(markdown)}</div></div>`);
      Reflect.set(globalThis, "document", document);
      try {
        const root = document.querySelector("#root") as unknown as HTMLElement;
        const content = root.firstElementChild as HTMLElement;
        decorateChatVisuals(root);
        const copy = content.querySelector("pre > .code-copy");
        decorateChatVisuals(content);
        expect(content.querySelector("pre > code.hljs.language-svg")?.textContent).toBe(svg);
        expect(content.querySelector("pre > code")?.closest("[hidden]")).toBeNull();
        expect(content.querySelectorAll("pre > .code-copy")).toHaveLength(2);
        expect(content.querySelector("pre > .code-copy")).toBe(copy);
        expect(copy?.getAttribute("aria-label")).toBe("Copy code to clipboard");
        expect(content.querySelector(".chat-visual, [data-visual-tab], img, svg")).toBeNull();
        expect(content.querySelector(".chat-visual-reference")?.textContent).toBe("./diagram.svg");
        expect(content.querySelector('a[href="https://example.invalid/track.png"]')).not.toBeNull();
      } finally {
        if (previousDocument === undefined) Reflect.deleteProperty(globalThis, "document");
        else Reflect.set(globalThis, "document", previousDocument);
      }
    });
  }

  test("ordinary assistant code copying remains owned by the timeline renderer", () => {
    const { document } = parseHTML(`<div class="chat-assistant-content">${renderChatMarkdown("```svg\n<svg/>\n```")}</div>`);
    const root = document.querySelector("div") as unknown as HTMLElement;
    decorateChatVisuals(root);
    expect(root.querySelector("pre > code")?.textContent).toBe("<svg/>\n");
    expect(root.querySelector("button")).toBeNull();
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
