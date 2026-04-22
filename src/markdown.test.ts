import { describe, expect, test } from "bun:test";

import { renderMarkdownToHtml } from "./markdown";

describe("renderMarkdownToHtml", () => {
  test("renders common GFM features", () => {
    const html = renderMarkdownToHtml(`| A | B |
| - | - |
| 1 | 2 |

- [x] done
- [ ] todo

Visit https://example.com and ~~remove~~ text.`);

    expect(html).toContain("<table>");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("<del>remove</del>");
    expect(html).toContain('<a href="https://example.com">https://example.com</a>');
  });

  test("preserves mermaid fenced blocks for client-side hydration", () => {
    const html = renderMarkdownToHtml("```mermaid\ngraph TD\n  A-->B\n```");

    expect(html).toContain('<pre><code class="language-mermaid">');
    expect(html).toContain("graph TD");
  });
});
