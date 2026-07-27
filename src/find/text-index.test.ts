import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";

import { buildTextIndex, locateSpan, type TextIndex } from "./text-index";

function rootOf(html: string): HTMLElement {
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  return document.body as unknown as HTMLElement;
}

// Resolve a span the way the find bar does, then read the characters back out
// of the DOM nodes. If the mapping is right this reproduces the matched text
// exactly, which is the property that actually matters.
function textOfSpan(index: TextIndex, start: number, end: number): string | null {
  const located = locateSpan(index, { start, end });
  if (!located) {
    return null;
  }
  if (located.startNode === located.endNode) {
    return located.startNode.data.slice(located.startOffset, located.endOffset);
  }
  let out = located.startNode.data.slice(located.startOffset);
  let collecting = false;
  for (const entry of index.entries) {
    if (entry.node === located.startNode) {
      collecting = true;
      continue;
    }
    if (entry.node === located.endNode) {
      out += located.endNode.data.slice(0, located.endOffset);
      break;
    }
    if (collecting) {
      out += entry.node.data;
    }
  }
  return out;
}

describe("buildTextIndex", () => {
  test("flattens to the text a reader sees, in document order", () => {
    const index = buildTextIndex(rootOf(`<p>Hello <em>brave</em> world</p>`));
    expect(index.text).toBe("Hello brave world");
  });

  test("entries tile the string without gaps or overlap", () => {
    const index = buildTextIndex(rootOf(`<p>ab<b>cd</b>ef</p>`));
    expect(index.entries.map(e => [e.start, e.end])).toEqual([
      [0, 2],
      [2, 4],
      [4, 6],
    ]);
    expect(index.text).toBe("abcdef");
  });

  test("script, style, and template text is not reader-visible content", () => {
    const index = buildTextIndex(
      rootOf(`<p>before</p><script>secret</script><style>.x{}</style><p>after</p>`),
    );
    expect(index.text).toBe("beforeafter");
  });

  test("hidden subtrees are excluded", () => {
    const index = buildTextIndex(rootOf(`<p>shown</p><div hidden><p>concealed</p></div>`));
    expect(index.text).toBe("shown");
  });

  test("SVG text is excluded — highlights cannot paint it", () => {
    // A rendered mermaid diagram. Counting matches we could never reveal
    // would be worse than not finding them.
    const index = buildTextIndex(
      rootOf(`<p>caption</p><svg><g><text>nodeLabel</text></g></svg>`),
    );
    expect(index.text).toBe("caption");
  });

  test("attribute values are never part of the text", () => {
    const index = buildTextIndex(
      rootOf(`<a href="https://example.com/secret" class="link">docs</a>`),
    );
    expect(index.text).toBe("docs");
    expect(index.text).not.toContain("example.com");
    expect(index.text).not.toContain("link");
  });
});

describe("locateSpan", () => {
  test("resolves a match inside a single text node", () => {
    const index = buildTextIndex(rootOf(`<p>Hello world</p>`));
    const start = index.text.indexOf("world");
    expect(textOfSpan(index, start, start + 5)).toBe("world");
  });

  test("resolves a match spanning element boundaries", () => {
    // Exactly the syntax-highlighted case: `const foo` split across spans.
    const index = buildTextIndex(
      rootOf(`<pre><code><span class="hljs-keyword">const</span><span> foo</span></code></pre>`),
    );
    const start = index.text.indexOf("const foo");
    const located = locateSpan(index, { start, end: start + "const foo".length });
    expect(located).not.toBeNull();
    expect(located!.startNode).not.toBe(located!.endNode);
    expect(textOfSpan(index, start, start + "const foo".length)).toBe("const foo");
  });

  test("a match spanning three nodes reassembles correctly", () => {
    const index = buildTextIndex(rootOf(`<p>ab<b>cd</b>ef</p>`));
    expect(textOfSpan(index, 1, 5)).toBe("bcde");
  });

  test("a match ending on a node boundary closes in that node", () => {
    const index = buildTextIndex(rootOf(`<p>ab<b>cd</b></p>`));
    const located = locateSpan(index, { start: 0, end: 2 });
    expect(located).not.toBeNull();
    // Not offset 0 of the following node, which would render zero-width.
    expect(located!.endNode.data).toBe("ab");
    expect(located!.endOffset).toBe(2);
  });

  test("a match starting on a node boundary opens in that node", () => {
    const index = buildTextIndex(rootOf(`<p>ab<b>cd</b></p>`));
    const located = locateSpan(index, { start: 2, end: 4 });
    expect(located!.startNode.data).toBe("cd");
    expect(located!.startOffset).toBe(0);
  });

  test("every offset round-trips through the mapping", () => {
    const index = buildTextIndex(rootOf(`<p>ab<b>cd</b>ef<i>gh</i></p>`));
    for (let start = 0; start < index.text.length; start += 1) {
      for (let end = start + 1; end <= index.text.length; end += 1) {
        expect(textOfSpan(index, start, end)).toBe(index.text.slice(start, end));
      }
    }
  });

  test("empty and out-of-bounds spans resolve to nothing", () => {
    const index = buildTextIndex(rootOf(`<p>abc</p>`));
    expect(locateSpan(index, { start: 1, end: 1 })).toBeNull();
    expect(locateSpan(index, { start: 2, end: 1 })).toBeNull();
    expect(locateSpan(index, { start: 3, end: 9 })).toBeNull();
  });

  test("an empty index resolves nothing", () => {
    const index = buildTextIndex(rootOf(``));
    expect(index.text).toBe("");
    expect(locateSpan(index, { start: 0, end: 1 })).toBeNull();
  });
});

describe("shadow trees", () => {
  // The Diff view renders into a `<diffs-container>` shadow root. Refusing to
  // descend left `#preview` with nothing but toolbar text, which made the
  // entire view unsearchable.
  function withShadow(): { root: HTMLElement; shadow: ShadowRoot } {
    const { document } = parseHTML(
      `<!doctype html><html><body><div id="preview"><div class="toolbar">UnifiedSplit</div><diffs-container></diffs-container></div></body></html>`,
    );
    const host = document.querySelector("diffs-container") as unknown as HTMLElement;
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `<div class="line">Added review-time edit.</div>`;
    return {
      root: document.querySelector("#preview") as unknown as HTMLElement,
      shadow: shadow as unknown as ShadowRoot,
    };
  }

  test("text inside a shadow root is indexed", () => {
    const { root } = withShadow();
    const index = buildTextIndex(root);
    expect(index.text).toContain("Added review-time edit.");
  });

  test("the shadow root is reported so its highlight styles can be installed", () => {
    const { root, shadow } = withShadow();
    const index = buildTextIndex(root);
    expect(index.shadowRoots).toContain(shadow);
  });

  test("a match inside the shadow tree resolves to its text node", () => {
    const { root } = withShadow();
    const index = buildTextIndex(root);
    const start = index.text.indexOf("review-time");
    expect(textOfSpan(index, start, start + "review-time".length)).toBe("review-time");
  });

  test("a document with no shadow trees reports none", () => {
    const index = buildTextIndex(rootOf(`<p>plain</p>`));
    expect(index.shadowRoots).toEqual([]);
  });
});
