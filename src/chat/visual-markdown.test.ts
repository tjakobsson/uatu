import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { renderMarkdownToHtml } from "../render/markdown";
import { renderChatMarkdown } from "./markdown";
import { getChatVisuals, prepareChatVisualMarkdown } from "./visual-markdown";

describe("agent visual Markdown", () => {
  test("origin-name collisions cannot stall visual preparation", () => {
    const source = "```svg\n<svg><text>uatu-origin" + "-".repeat(1_048_576) + "</text></svg>\n```\n\n![Shot](result.png)";
    const moduleUrl = new URL("./visual-markdown.ts", import.meta.url).href;
    const child = Bun.spawnSync([process.execPath, "--eval", `
      import { getChatVisuals } from ${JSON.stringify(moduleUrl)};
      const source = await Bun.stdin.text();
      const visuals = getChatVisuals(source, false);
      if (visuals.length !== 2 || visuals[0].key !== "offset:0" || visuals[1].source !== "result.png" || visuals[1].key !== "offset:" + source.indexOf("![Shot]")) process.exit(1);
      console.log("annotated");
    `], { stdin: Buffer.from(source), stdout: "pipe", stderr: "pipe", timeout: 3_000, killSignal: "SIGKILL" });
    expect({ exitCode: child.exitCode, stderr: child.stderr.toString(), stdout: child.stdout.toString() })
      .toEqual({ exitCode: 0, stderr: "", stdout: "annotated\n" });
  });
  test("enumerates visual occurrences in rendered document order without original image URLs", () => {
    const source = '![Shot](./shot.png)\n\n```svg\n<svg><text>A &amp; B</text></svg>\n```\n\n![Remote](https://example.com/track.jpg)';
    const prepared = prepareChatVisualMarkdown(source, true);
    expect(prepared.visuals).toEqual([
      { index: 0, key: "offset:0", kind: "file", source: "./shot.png", alt: "Shot", complete: true },
      { index: 1, key: `offset:${source.indexOf("```svg")}`, kind: "svg", source: "<svg><text>A &amp; B</text></svg>\n", alt: "SVG graphic", complete: true },
      { index: 2, key: `offset:${source.indexOf("![Remote]")}`, kind: "file", source: "https://example.com/track.jpg", alt: "Remote", complete: true },
    ]);
    expect(prepared.html).not.toContain("<img");
    expect(prepared.html).not.toContain("https://example.com");
    expect(prepared.html).toContain('data-uatu-visual="1"');
  });

  test("only closes SVG previews on actual closing fences, including nested Markdown", () => {
    for (const source of ["```svg\n<svg/>\n", "~~~svg\n<svg/>\n~~", "> ```svg\n> <svg/>\n", "- ```svg\n  <svg/>\n"]) {
      expect(getChatVisuals(source, true)[0]?.complete).toBe(false);
    }
    for (const source of ["```svg\n<svg/>\n```", "~~~svg\n<svg/>\n~~~", "> ```svg\n> <svg/>\n> ```", "- ```svg\n  <svg/>\n  ```"]) {
      expect(getChatVisuals(source, true)[0]?.complete).toBe(true);
    }
  });

  test("ordinary code, bare URLs, and incomplete image syntax do not become visuals", () => {
    const source = 'https://example.com/a.svg\n\n```xml\n<svg/>\n```\n\n````text\n```svg\n<svg/>\n```\n````\n\n![unfinished](./a.png';
    expect(getChatVisuals(source, true)).toEqual([]);
    expect(prepareChatVisualMarkdown(source, true).html).toContain("language-xml");
  });

  test("reference-style and raw HTML images use the same safe capture path", () => {
    const source = '![Example][shot]\n\n[shot]: images/a%20b.jpg\n\n<img src="//example.com/x" alt="raw" onerror="bad()">';
    expect(getChatVisuals(source, false).map(input => input.source)).toEqual(["images/a%20b.jpg", "//example.com/x"]);
    expect(prepareChatVisualMarkdown(source, false).html).not.toContain("onerror");
  });

  test("refused image schemes retain their destinations without entering presentation attributes", () => {
    for (const destination of [
      "file:///Users/example/shot.svg",
      "ftp://example.invalid/shot.png",
      "data:image/svg+xml,%3Csvg%20onload=alert%281%29%3E",
      "javascript:alert%281%29",
    ]) {
      for (const source of [
        `![Refused](${destination})`,
        `![Refused][shot]\n\n[shot]: ${destination}`,
        `<IMAGE src="${destination}" alt="Refused">`,
      ]) {
        const prepared = prepareChatVisualMarkdown(source, false);
        expect(prepared.visuals).toEqual([
          { kind: "file", source: destination, alt: "Refused", complete: true, key: "offset:0", index: 0 },
        ]);
        expect(prepared.html).toContain('<span data-uatu-visual="0"></span>');
        expect(prepared.html).not.toContain(destination);
        expect(prepared.html).not.toContain("chatVisualSource");
        expect(prepared.html).not.toMatch(/<img\b/i);
      }
    }
  });

  test("raw image aliases and tag case preserve text, origins, and snapshot mapping", () => {
    for (const tag of ["image", "IMAGE", "ImAgE", "IMG", "iMg"]) {
      const source = `before <${tag} src="a.png" alt="Alias"> after`;
      const prepared = prepareChatVisualMarkdown(source, false);
      expect(prepared.visuals).toEqual([
        { index: 0, key: "offset:7", kind: "file", source: "a.png", alt: "Alias", complete: true },
      ]);
      const { document } = parseHTML(renderChatMarkdown(source, {
        visuals: [{ index: 0, status: "ready", id: "a".repeat(64) }],
      }));
      expect(parseHTML(prepared.html).document.querySelector("p")?.textContent).toBe("before  after");
      expect(document.querySelector("img")?.getAttribute("src")).toBe(`/api/chat/visuals/${"a".repeat(64)}`);
      expect(prepared.html).not.toContain("uatu-origin");
    }
  });

  test("SVG source preserves literal entities, quotes, and original line endings", () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg">\r\n<text>&amp; &#38; &lt; &quot;</text>\r\n</svg>\r\n';
    expect(getChatVisuals(`\`\`\`svg\r\n${svg}\`\`\``, true)[0]?.source).toBe(svg);
  });

  test("late reference definitions do not change existing occurrence identities", () => {
    const initial = "![first][ref]\n\n![second](b.png)\n\n```svg\n<svg/>\n```";
    const before = getChatVisuals(initial, true);
    const after = getChatVisuals(`${initial}\n\n[ref]: a.png`, true);
    expect(before[0]?.source).toBe("b.png");
    expect(after[0]?.source).toBe("a.png");
    expect(before[0]?.key).toBe(after[1]?.key);
    expect(before[1]?.key).toBe(after[2]?.key);
    expect(after.map(input => input.index)).toEqual([0, 1, 2]);
    expect(new Set(after.map(input => input.key)).size).toBe(3);
  });

  test("HTML repair preserves source identities when appended images move before existing images", () => {
    for (const [initial, appended] of [
      ['<table><tr><td><img src="a.png"></td></tr>', '<img src="b.png"></table>'],
      ['<TABLE><TR><TD><IMAGE src="a.png"></TD></TR>', '<iMaGe src="b.png"></TABLE>'],
      ['<table><tr><td>\n\n![A](a.png)\n\n</td></tr>\n\n', '![B](b.png)\n\n</table>'],
    ] as const) {
      const before = prepareChatVisualMarkdown(initial, true);
      const source = initial + appended;
      const after = prepareChatVisualMarkdown(source, true);
      const existing = after.visuals.find(input => input.source === "a.png");
      const added = after.visuals.find(input => input.source === "b.png");
      expect(existing?.key).toBe(before.visuals[0]?.key);
      expect(added?.key).not.toBe(existing?.key);
      expect(added?.key).toBe(`offset:${initial.length}`);
      expect(after.visuals.map(input => input.source)).toEqual(["b.png", "a.png"]);
      expect(after.visuals.map(input => input.index)).toEqual([0, 1]);
      const indexes = [...after.html.matchAll(/data-uatu-visual="(\d+)"/g)].map(match => Number(match[1]));
      expect(indexes).toEqual([0, 1]);
      expect(after.html).not.toContain("<img");
      const { document } = parseHTML(after.html);
      expect(document.querySelector("table [data-uatu-visual]")?.getAttribute("data-uatu-visual")).toBe(String(existing?.index));
      const snapshots = after.visuals.map(input => ({ index: input.index, status: "ready" as const, id: (input.source === "a.png" ? "a" : "b").repeat(64) }));
      const rendered = parseHTML(renderChatMarkdown(source, { streaming: true, visuals: snapshots })).document;
      expect(rendered.querySelector("table img")?.getAttribute("src")).toBe(`/api/chat/visuals/${"a".repeat(64)}`);
      expect([...rendered.querySelectorAll("img")].map(image => image.getAttribute("src"))).toEqual([`/api/chat/visuals/${"b".repeat(64)}`, `/api/chat/visuals/${"a".repeat(64)}`]);
    }
  });

  test("parser-discarded Markdown images cannot consume another image's source identity", () => {
    const source = '<select>\n\n![ignored](ignored.png)\n\n</select>\n\n![actual](actual.png)';
    expect(getChatVisuals(source, true).map(input => [input.source, input.key])).toEqual([
      ["actual.png", `offset:${source.indexOf("![actual]")}`],
    ]);
  });

  test("identical image URLs remain distinct occurrences after HTML repair", () => {
    const initial = '<table><tr><td><img src="same.png" alt="A"></td></tr>';
    const source = `${initial}<img src="same.png" alt="B"></table>`;
    const before = getChatVisuals(initial, true);
    const after = getChatVisuals(source, true);
    expect(after.map(input => [input.alt, input.key])).toEqual([
      ["B", `offset:${initial.length}`],
      ["A", before[0]?.key],
    ]);
  });

  test("duplicate reference images in Markdown tables keep distinct origins and previews", () => {
    const source = '| First | Second |\n| - | - |\n| ![A][shot] | ![B][shot] |\n\n[shot]: same.png';
    const prepared = prepareChatVisualMarkdown(source, false);
    expect(prepared.visuals.map(input => [input.source, input.key, input.index])).toEqual([
      ["same.png", `offset:${source.indexOf("![A]")}`, 0],
      ["same.png", `offset:${source.indexOf("![B]")}`, 1],
    ]);
    const { document } = parseHTML(renderChatMarkdown(source, {
      visuals: [
        { index: 0, status: "ready", id: "a".repeat(64) },
        { index: 1, status: "ready", id: "b".repeat(64) },
      ],
    }));
    expect([...document.querySelectorAll("td img")].map(image => [image.getAttribute("alt"), image.getAttribute("src")])).toEqual([
      ["A", `/api/chat/visuals/${"a".repeat(64)}`],
      ["B", `/api/chat/visuals/${"b".repeat(64)}`],
    ]);
  });

  test("nested SVG fences preserve original source and identities across completion", () => {
    const initial = '> - ~~~SVG\n>   <svg><text>A &amp; B</text></svg>\n>   ~~~\n>\n> - ```svg\n>   <svg/>\n';
    const before = getChatVisuals(initial, true);
    const after = getChatVisuals(`${initial}>   \`\`\``, false);
    expect(before.map(input => [input.source, input.key, input.complete])).toEqual([
      ["<svg><text>A &amp; B</text></svg>\n", `offset:${initial.indexOf("~~~SVG")}`, true],
      ["<svg/>", `offset:${initial.indexOf("```svg")}`, false],
    ]);
    expect(after.map(input => input.key)).toEqual(before.map(input => input.key));
    expect(after.map(input => input.source)).toEqual(["<svg><text>A &amp; B</text></svg>\n", "<svg/>\n"]);
    expect(after.map(input => input.complete)).toEqual([true, true]);
  });

  test("raw HTML token origins preserve offsets through list and quote prefixes", () => {
    for (const source of [
      '> <table><tr><td><img src="a.png"></td></tr>\n> <img src="b.png"></table>',
      '- <table><tr><td><img src="a.png"></td></tr>\n  <img src="b.png"></table>',
    ]) {
      expect(getChatVisuals(source, true).map(input => [input.source, input.key])).toEqual([
        ["b.png", `offset:${source.indexOf('<img src="b.png"')}`],
        ["a.png", `offset:${source.indexOf('<img src="a.png"')}`],
      ]);
    }
  });

  test("foster-parented SVG fences retain their own source and completion state", () => {
    const initial = '<table><tr><td>\n\n```svg\n<svg><text>A</text></svg>\n```\n\n</td></tr>\n\n';
    const source = `${initial}\`\`\`svg\n<svg><text>B</text></svg>\n`;
    const before = getChatVisuals(initial, true);
    const after = getChatVisuals(source, true);
    expect(after.map(input => [input.source, input.complete])).toEqual([
      ["<svg><text>B</text></svg>\n", false],
      ["<svg><text>A</text></svg>\n", true],
    ]);
    expect(after[1]?.key).toBe(before[0]?.key);
    expect(after[0]?.key).toBe(`offset:${initial.length}`);
  });

  test("nonvisual rendering keeps the document sanitizer and formatting contract", () => {
    const fixtures = [
      '# Title\n\ntext **bold** [link](https://example.com)\n\n> quote\n\n- first\n- second',
      '---\ntitle: Example\n---\n\n| A | B |\n| - | - |\n| x | y |\n\n- [x] Done',
      '<div align="center" onclick="bad()"><h2 align="right">Title</h2><a href="https://example.com" rel="nofollow">Link</a></div>',
      '<div align="center"><p align="right">Text</p><h1 align="left">Heading</h1><h6 align="center">Small</h6><table align="center"><tr align="right"><th align="left">Key</th><td align="center">Value</td></tr></table></div>',
      '<a href="file:///refused" onclick="bad()">File</a><a href="data:text/html,unsafe" style="color:red">Data</a>',
      'text\n\n```js\nconst answer = 42;\n```\n\n    indented\n\n> ```text\n> quote\n> ```',
      '<table><tr><td>Cell</td></tr>text outside</table><script>bad()</script>',
    ];
    for (const source of fixtures) expect(prepareChatVisualMarkdown(source, false).html).toBe(renderMarkdownToHtml(source).html);
  });

  test("author attributes cannot forge an occurrence identity or survive as internal markers", () => {
    const source = '<img uatu-origin="0" src="a.png"><img uatu-origin-="1" src="b.png">';
    const prepared = prepareChatVisualMarkdown(source, false);
    expect(prepared.visuals.map(input => input.key)).toEqual(["offset:0", `offset:${source.indexOf("<img", 1)}`]);
    expect(prepared.html).not.toContain("uatu-origin");
  });
  test("numeric and case-folded origin collisions cannot forge SVG origins", () => {
    const attributes = Array.from({ length: 50 }, (_, i) => `UATU-ORIGIN-${String(i).padStart(4, "0")}="1"`).join(" ");
    const source = `<img ${attributes} uatu-origin-0050000="1" src="a.png">\n\n${"context ".repeat(512)}\n\n\`\`\`svg\n<svg/>\n\`\`\`\n\n<pre ${attributes}><code class="language-svg">&lt;svg/&gt;</code></pre>`;
    const prepared = prepareChatVisualMarkdown(source, false);
    expect(prepared.visuals.map(input => input.source)).toEqual(["a.png", "<svg/>\n"]);
    expect(prepared.visuals.map(input => input.key)).toEqual(["offset:0", `offset:${source.indexOf("```svg")}`]);
    expect(prepared.html).not.toContain("uatu-origin");
  });

  test("source identities cover nested images, raw HTML, and frontmatter consistently", () => {
    const source = '---\ntitle: "![ignored](ignored.png)"\n---\n![![inner](inner.png)](outer.png)\n\n<img src="raw.png">\n\n![last](last.png)';
    const inputs = getChatVisuals(source, true);
    expect(inputs.map(input => input.source)).toEqual(["outer.png", "raw.png", "last.png"]);
    expect(inputs.map(input => input.key)).toEqual([`offset:${source.indexOf("![![inner]")}`, `offset:${source.indexOf("<img")}`, `offset:${source.indexOf("![last]")}`]);
  });

  test("raw HTML in an image alt does not steal a later occurrence's identity", () => {
    const source = '![<img src="inner.png">][ref]\n\n![last](last.png)';
    const before = getChatVisuals(source, true);
    const after = getChatVisuals(`${source}\n\n[ref]: a.png`, true);
    expect(before.map(input => input.source)).toEqual(["inner.png", "last.png"]);
    expect(after.map(input => input.source)).toEqual(["a.png", "last.png"]);
    expect(before[1]?.key).toBe(after[1]?.key);
    expect(after[1]?.key).toBe(`offset:${source.indexOf("![last]")}`);
  });

  test("raw HTML pre/code remains code; only actual SVG fences become previews", () => {
    const raw = 'text <pre><code class="language-svg">&lt;svg/&gt;</code></pre>';
    expect(getChatVisuals(raw, true)).toEqual([]);
    expect(prepareChatVisualMarkdown(raw, true).html).toContain("language-svg");
    const combined = `${raw}\n\n\`\`\`svg\n<svg/>\n\`\`\``;
    expect(getChatVisuals(combined, true).map(input => input.key)).toEqual([`offset:${combined.indexOf("```svg")}`]);
    for (const prefix of ['<pre><img src="example.png"></pre>', 'text <pre><img src="example.png"></pre>']) {
      const source = `${prefix}\n\n![actual](actual.png)`;
      const inputs = getChatVisuals(source, true);
      expect(inputs.map(input => input.source)).toEqual(["actual.png"]);
      expect(inputs[0]?.key).toBe(`offset:${source.indexOf("![actual]")}`);
    }
    for (const source of ['<pre><img src="https://example.com/track.png"></pre>', '<pre id="example"><img src="https://example.com/track.png"></pre>', '<pre><code class="language-svg"><img src="https://example.com/track.png"></code></pre>']) {
      expect(getChatVisuals(source, true)).toEqual([]);
      expect(prepareChatVisualMarkdown(source, true).html).not.toMatch(/<img\b/i);
    }
  });
});
