import { describe, expect, test } from "bun:test";

import { replaceMermaidCodeBlocks } from "./preview";

describe("replaceMermaidCodeBlocks", () => {
  test("converts mermaid code fences into mermaid nodes", () => {
    const html = '<pre><code class="language-mermaid">graph TD\nA--&gt;B</code></pre>';
    const transformed = replaceMermaidCodeBlocks(html);

    expect(transformed).toBe('<div class="mermaid">graph TD\nA--&gt;B</div>');
  });
});
