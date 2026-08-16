import { describe, expect, test } from "bun:test";
import { renderChatMarkdown } from "./markdown";

describe("chat Markdown security", () => {
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
