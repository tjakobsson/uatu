import { describe, expect, test } from "bun:test";
import { renderChatMarkdown } from "./markdown";

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
});
