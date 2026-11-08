import { describe, expect, test } from "bun:test";
import { renderChatMarkdown } from "./markdown";
import { parseHTML } from "linkedom";
const VISUAL_ID = "a".repeat(64);

describe("chat Markdown security", () => {
  test("unchanged sanitized markdown is reused and the count limit evicts old entries", () => {
    const previous = globalThis.__uatuChatPerformance;
    globalThis.__uatuChatPerformance = { counts: {}, durations: {} };
    try {
      const source = "cache fixture <script>bad()</script>";
      const first = renderChatMarkdown(source);
      expect(renderChatMarkdown(source)).toBe(first);
      expect(globalThis.__uatuChatPerformance.counts.markdown).toBe(1);
      for (let i = 0; i < 128; i++) renderChatMarkdown(`eviction fixture ${i}`);
      renderChatMarkdown(source);
      expect(globalThis.__uatuChatPerformance.counts.markdown).toBe(130);
      expect(first).not.toContain("<script>");
    } finally { globalThis.__uatuChatPerformance = previous; }
  });
  test("removes scripts, event attributes, and JavaScript URLs", () => {
    const html = renderChatMarkdown('<script>alert(1)</script><img src="x" onerror="alert(2)"> [bad](javascript:alert(3))');
    expect(html).not.toMatch(/<script|onerror|href=["']?javascript:/i);
    expect(html).toContain("bad");
  });

  test("highlights fenced code while preserving escaped source", () => {
    const html = renderChatMarkdown("```js\nconst value = '<tag>'\n```");
    expect(html).toContain('class="hljs language-js"');
    expect(html).not.toContain("<tag>");
  });

  test("only issued snapshots become images; remote embeds remain explicit links", () => {
    const html = renderChatMarkdown('![Local](./shot.png)\n\n![Remote](https://example.com/track.svg)', {
      streaming: true,
      visuals: [{ index: 0, status: "ready", id: VISUAL_ID, mimeType: "image/png" }, { index: 1, status: "unavailable", message: "External images are not loaded." }],
    });
    const { document } = parseHTML(html);
    expect(document.querySelectorAll("img")).toHaveLength(1);
    expect(document.querySelector("img")?.getAttribute("src")).toBe(`/api/chat/visuals/${VISUAL_ID}`);
    expect(document.querySelector('a[href="https://example.com/track.svg"]')).not.toBeNull();
    expect(document.querySelector('[src*="example.com"]')).toBeNull();
  });

  test("refused schemes preserve original destinations as escaped non-clickable references", () => {
    const destinations = [
      "file:///Users/example/shot.svg",
      "ftp://example.invalid/shot.png",
      "data:image/svg+xml,%3Csvg%20onload=alert%281%29%3E",
      "javascript:alert%281%29",
    ];
    const fixtures = destinations.map(destination => ({ destination, source: `![Refused](${destination})` }));
    fixtures.push({
      destination: 'data:image/svg+xml,<svg onload="alert(1)"><script>alert(1)</script></svg>',
      source: '<img src="data:image/svg+xml,&lt;svg onload=&quot;alert(1)&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;&lt;/svg&gt;" alt="Refused" chatVisualSource="https://example.invalid/forged.png">',
    });
    for (const { destination, source } of fixtures) {
      for (const visuals of [undefined, [{ index: 0, status: "unavailable" as const, message: '<img src=x onerror="alert(1)"> Refused.' }]]) {
        const { document } = parseHTML(renderChatMarkdown(source, { visuals }));
        expect(document.querySelector(".chat-visual-reference")?.textContent).toBe(destination);
        expect(document.querySelector("a, img, svg, script, iframe")).toBeNull();
        expect([...document.querySelectorAll("*")].flatMap(node => [...node.attributes]).some(attribute => /^on/i.test(attribute.name))).toBe(false);
      }
    }
  });

  test("retaining refused image destinations does not retain unsafe link protocols", () => {
    const source = '![Refused](file:///Users/example/shot.svg) [bad](javascript:alert%281%29) <a href="data:text/html,unsafe" onclick="bad()">raw</a>';
    const { document } = parseHTML(renderChatMarkdown(source));
    expect(document.querySelectorAll("a")).toHaveLength(2);
    expect(document.querySelector("a[href], [onclick], img")).toBeNull();
    expect(document.querySelector(".chat-visual-reference")?.textContent).toBe("file:///Users/example/shot.svg");
  });

  test("ready previews retain an escaped, initially hidden fallback with the original reference", () => {
    const { document } = parseHTML(renderChatMarkdown('![Screenshot <failed>](./shot.png)', {
      visuals: [{ index: 0, status: "ready", id: VISUAL_ID, mimeType: "image/png" }],
    }));
    const fallback = document.querySelector(".chat-visual-fallback")!;
    expect(fallback.hasAttribute("hidden")).toBe(true);
    expect(fallback.getAttribute("role")).toBe("status");
    expect(fallback.textContent).toBe("Could not display Screenshot <failed>. ./shot.png");
    expect(fallback.querySelector(".chat-visual-reference")?.textContent).toBe("./shot.png");
    expect(document.querySelector("failed")).toBeNull();
    expect(document.querySelectorAll("img")).toHaveLength(1);
  });

  test("incomplete SVG has a generating placeholder and copyable inert source", () => {
    const html = renderChatMarkdown('```svg\n<svg onload="bad()"><text>&amp;</text>', { streaming: true });
    const { document } = parseHTML(html);
    expect(document.querySelector("svg")).toBeNull();
    expect(document.querySelector("img")).toBeNull();
    expect(document.querySelector(".chat-visual-preview")?.textContent).toContain("Generating image…");
    expect(document.querySelector(".chat-visual-source code")?.textContent).toBe('<svg onload="bad()"><text>&amp;</text>');
  });

  test("linked images do not navigate away and source panels stay inside their visual", () => {
    const html = renderChatMarkdown('[![Diagram](./diagram.svg)](https://example.com) after', {
      visuals: [{ index: 0, status: "ready", id: VISUAL_ID, mimeType: "image/svg+xml" }],
    });
    const { document } = parseHTML(html);
    expect(document.querySelector("a")).toBeNull();
    expect(document.querySelector(".chat-visual .chat-visual-source code")).not.toBeNull();
    expect(document.querySelector(".chat-visual .chat-visual-preview img")).not.toBeNull();
    const nested = renderChatMarkdown('[**![Diagram](./diagram.svg)**](https://example.com)', {
      visuals: [{ index: 0, status: "ready", id: VISUAL_ID, mimeType: "image/svg+xml" }],
    });
    expect(parseHTML(nested).document.querySelector("a")).toBeNull();
    expect(parseHTML(nested).document.querySelector("strong .chat-visual img")).not.toBeNull();
  });

  test("enforces the display count and refuses untrusted snapshot IDs", () => {
    const markdown = Array.from({ length: 9 }, (_, i) => `![Shot ${i}](./${i}.png)`).join("\n\n");
    const html = renderChatMarkdown(markdown, { visuals: Array.from({ length: 9 }, (_, index) => ({ index, status: "ready", id: VISUAL_ID, mimeType: "image/png" })) });
    expect(parseHTML(html).document.querySelectorAll("img")).toHaveLength(8);
    expect(html).toContain("At most 8 images");
    expect(renderChatMarkdown("![x](./x.png)", { visuals: [{ index: 0, status: "ready", id: '//external/" onload="bad()', mimeType: "image/png" }] })).not.toContain("<img");
  });
});
