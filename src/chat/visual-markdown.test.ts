import { describe, expect, spyOn, test } from "bun:test";
import { parseHTML } from "linkedom";
import { renderMarkdownToHtml } from "../render/markdown";
import { renderChatMarkdown } from "./markdown";
import { getChatVisuals, prepareChatVisualMarkdown } from "./visual-markdown";

describe("agent visual Markdown", () => {
  test("completed and streaming calls share one cached parse for identical source", () => {
    const source = '![Cached](same-cache.png)\n\n```svg\n<svg/>\n```\n';
    expect(prepareChatVisualMarkdown(source, false)).toBe(prepareChatVisualMarkdown(source, true));
    const reference = "![Cached][ref]\n\n[ref]: same-cache.png";
    const live = prepareChatVisualMarkdown(reference, true);
    const done = prepareChatVisualMarkdown(reference, false);
    expect(live.visuals[0]?.complete).toBe(false);
    expect(done.visuals[0]?.complete).toBe(true);
    expect(done.html).toBe(live.html);
    expect(prepareChatVisualMarkdown(reference, true)).toBe(live);
  });
  test.each(["```", "~~~"].flatMap(marker => ["", " \t"].map(whitespace => ({ marker, whitespace }))))("EOF $marker$whitespace closes only on text completion using one cached parse", ({ marker, whitespace }) => {
    const source = `${marker}svg\n<svg><text>cached EOF readiness</text></svg>\n${marker}${whitespace}`;
    const previous = globalThis.__uatuChatPerformance;
    const measurements = { counts: {}, durations: {} } as NonNullable<typeof previous>;
    globalThis.__uatuChatPerformance = measurements;
    try {
      const live = prepareChatVisualMarkdown(source, true);
      expect(live.visuals[0]).toMatchObject({ kind: "svg", complete: false, key: "offset:0" });
      const done = prepareChatVisualMarkdown(source, false);
      expect(done.visuals[0]).toEqual({ ...live.visuals[0]!, complete: true });
      expect(done.html).toBe(live.html);
      expect(prepareChatVisualMarkdown(source, true)).toBe(live);
      expect(measurements.counts.markdown).toBe(1);
    } finally { globalThis.__uatuChatPerformance = previous; }
    for (const ending of ["\n", "\r\n", "\r"]) expect(getChatVisuals(source + ending, true)[0]?.complete).toBe(true);
    expect(getChatVisuals(`${marker}svg\n<svg/>`, false)[0]?.complete).toBe(false);
  });
  test.each(["```", "~~~"])("an EOF %s inside SVG text stays provisional when the line grows a label", marker => {
    const prefix = `${marker}svg\n<svg xmlns="http://www.w3.org/2000/svg"><text>\n${marker}`;
    const continued = prefix + "label\n</text></svg>\n";
    const candidate = getChatVisuals(prefix, true)[0]!;
    expect(candidate).toMatchObject({ complete: false, key: "offset:0" });
    expect(getChatVisuals(continued, true)[0]).toMatchObject({ complete: false, key: candidate.key });
    const closed = getChatVisuals(continued + marker + "\n", true)[0]!;
    expect(closed).toMatchObject({ complete: true, key: candidate.key });
    expect(closed.source).toBe(`<svg xmlns="http://www.w3.org/2000/svg"><text>\n${marker}label\n</text></svg>\n`);
  });
  test.each(["![shot][ref]", "![ref][]", "![ref]"])("streamed reference destinations stay provisional until their line ends: %s", image => {
    const prefix = `${image}\n\n[ref]: a.p`;
    expect(getChatVisuals(prefix, true)[0]).toMatchObject({ source: "a.p", complete: false, key: "offset:0" });
    expect(getChatVisuals(prefix + "ng", true)[0]).toMatchObject({ source: "a.png", complete: false, key: "offset:0" });
    expect(getChatVisuals(prefix + "ng\n", true)[0]).toMatchObject({ source: "a.png", complete: true, key: "offset:0" });
    expect(getChatVisuals(prefix + "ng", false)[0]).toMatchObject({ source: "a.png", complete: true, key: "offset:0" });
  });
  test("unfinished definitions do not delay inline or raw HTML images", () => {
    const source = '![inline](inline.png)\n\n<img src="raw.png">\n\n![shot][ref]\n\n[ref]: a.p';
    expect(getChatVisuals(source, true).map(input => [input.source, input.complete])).toEqual([["inline.png", true], ["raw.png", true], ["a.p", false]]);
  });
  test("a trailing shortcut stays provisional through an incomplete resource, while incomplete explicit references produce no visual", () => {
    const prefix = "[shot]: old.png\n[next]: new.png\n\n";
    const image = prefix + "![shot]";
    const key = `offset:${prefix.length}`;
    for (const suffix of ["", "(", "(new.p"]) {
      expect(getChatVisuals(image + suffix, true)).toEqual([
        { index: 0, kind: "file", source: "old.png", alt: "shot", complete: false, key },
      ]);
    }
    // Micromark permits shortcut fallback after a failed resource attempt,
    // but an explicit reference attempt must resolve full/collapsed syntax.
    // Its incomplete forms are text, not permission to import old.png.
    for (const suffix of ["[", "[nex"]) {
      expect(getChatVisuals(image + suffix, true)).toEqual([]);
    }
    expect(getChatVisuals(image + "(new.png)", true)[0]).toMatchObject({ source: "new.png", complete: true, key });
    expect(getChatVisuals(image + "[next]", true)[0]).toMatchObject({ source: "new.png", complete: false, key });
    expect(getChatVisuals(image + "[next]", false)[0]).toMatchObject({ source: "new.png", complete: true, key });
    expect(getChatVisuals(image + "[next] ", true)[0]).toMatchObject({ source: "new.png", complete: true, key });
    for (const suffix of [" ", "\n", " followed by text", "\\("]) {
      expect(getChatVisuals(image + suffix, true)[0]).toMatchObject({ source: "old.png", complete: true, key });
    }
  });
  test.each(["![shot]", "![shot][]", "![caption][shot]"])("text completion disambiguates trailing %s using the shared cached parse", image => {
    const source = "[shot]: shortcut-cache.png\n\n" + image;
    const live = prepareChatVisualMarkdown(source, true);
    expect(live.visuals[0]).toMatchObject({ source: "shortcut-cache.png", complete: false });
    const done = prepareChatVisualMarkdown(source, false);
    expect(done.visuals[0]).toMatchObject({ source: "shortcut-cache.png", complete: true, key: live.visuals[0]!.key });
    expect(done.html).toBe(live.html);
    expect(prepareChatVisualMarkdown(source, true)).toBe(live);
    expect(getChatVisuals(source + " ", true)[0]?.complete).toBe(true);
  });
  test("capture-only extraction never invokes presentation highlighting", () => {
    const source = '```js\nconst answer = 42;\n```\n\n![Shot](result.png)\n\n```svg\n<svg/>\n```';
    const markdownUrl = new URL("../render/markdown.ts", import.meta.url).href;
    const visualUrl = new URL("./visual-markdown.ts", import.meta.url).href;
    const child = Bun.spawnSync([process.execPath, "--eval", `
      import { mock } from "bun:test";
      const original = await import(${JSON.stringify(markdownUrl)});
      mock.module(${JSON.stringify(markdownUrl)}, () => ({ ...original, highlightCodeBlocks() { throw new Error("presentation-only"); } }));
       const { getChatVisuals, prepareChatVisualMarkdown } = await import(${JSON.stringify(visualUrl)});
       const source = await Bun.stdin.text();
       globalThis.__uatuChatPerformance = { counts: {}, durations: {} };
       for (const streaming of [true, false]) {
         const visuals = getChatVisuals(source, streaming);
         if (visuals.length !== 2 || visuals[0].source !== "result.png" || visuals[1].source !== "<svg/>\\n") process.exit(1);
         if (visuals[1].complete !== !streaming) process.exit(1);
       }
       if (globalThis.__uatuChatPerformance.counts.markdown !== 1) process.exit(1);
      try { prepareChatVisualMarkdown(source, false); process.exit(1); }
      catch (error) { if (error.message !== "presentation-only") throw error; }
      console.log("capture-only");
    `], { stdin: Buffer.from(source), stdout: "pipe", stderr: "pipe", timeout: 3_000, killSignal: "SIGKILL" });
    expect({ exitCode: child.exitCode, stderr: child.stderr.toString(), stdout: child.stdout.toString() })
      .toEqual({ exitCode: 0, stderr: "", stdout: "capture-only\n" });
  });
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
      expect(getChatVisuals(source, true)[0]?.complete).toBe(false);
      expect(getChatVisuals(source, false)[0]?.complete).toBe(true);
      expect(getChatVisuals(source + "\n", true)[0]?.complete).toBe(true);
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

  test("one raw block annotates all 16,000 images with a linear source-copy budget", () => {
    const prefix = '<div data-annotation-work="linear-16000">\n';
    const sourceParts = [prefix];
    const expected = [];
    let offset = prefix.length;
    for (let index = 0; index < 16_000; index++) {
      const tag = `<${index % 2 ? "IMG" : "image"} src="p${index}.png" alt="a&amp;b" class="keep">\n`;
      sourceParts.push(tag);
      expected.push({ index, key: `offset:${offset}`, kind: "file", source: `p${index}.png`, alt: "a&b", complete: true });
      offset += tag.length;
    }
    sourceParts.push("</div>\n");
    const source = sourceParts.join("");
    const assemblies: Array<{ annotations: number; segments: number; copied: number; original: string }> = [];
    const join = Array.prototype.join;
    // Inspect the actual raw annotation assembly, not elapsed time or a
    // production counter that merely assumes the implementation is linear.
    const assembling = spyOn(Array.prototype, "join").mockImplementation(function (this: unknown[], separator?: string) {
      if (separator === "" && typeof this[0] === "string" && this[0].startsWith(prefix)) {
        const marker = /^ uatu-origin-[0-9]+="[0-9]+"$/;
        const annotations = this.filter(value => typeof value === "string" && marker.test(value));
        if (annotations.length) {
          const original = this.filter(value => typeof value !== "string" || !marker.test(value));
          assemblies.push({ annotations: annotations.length, segments: this.length,
            copied: original.reduce<number>((sum, value) => sum + String(value).length, 0), original: join.call(original, "") });
        }
      }
      return join.call(this, separator);
    });
    const previous = globalThis.__uatuChatPerformance;
    const measurements = { counts: {}, durations: {} } as NonNullable<typeof previous>;
    globalThis.__uatuChatPerformance = measurements;
    try {
      const live = prepareChatVisualMarkdown(source, true);
      expect(live.visuals).toEqual(expected);
      expect(prepareChatVisualMarkdown(source, false)).toBe(live);
      expect(prepareChatVisualMarkdown(source, true)).toBe(live);
      expect(measurements.counts.markdown).toBe(1);
      expect((live.html.match(/data-uatu-visual="[0-9]+"/g) ?? []).length).toBe(16_000);
      expect(live.html).not.toMatch(/<img\b/i);
      expect(live.html).not.toContain("uatu-origin-");
      expect(getChatVisuals(source, true)).toEqual(expected);
      expect(getChatVisuals(source, false)).toEqual(expected);
      expect(measurements.counts.markdown).toBe(2); // One parse per presentation/capture view, not per mode.
      expect(assemblies).toHaveLength(2);
      for (const assembly of assemblies) {
        expect(assembly.annotations).toBe(16_000); // Exactly one origin per actual tag; no eight-input truncation.
        expect(assembly.segments).toBe(2 * 16_000 + 1);
        expect(assembly.copied).toBeLessThanOrEqual(source.length);
        // Micromark can emit the block's final line ending outside its wrapper.
        // Otherwise every original attribute, entity and character is unchanged.
        expect(assembly.original.replace(/\n$/, "")).toBe(source.replace(/\n$/, ""));
      }
    } finally { assembling.mockRestore(); globalThis.__uatuChatPerformance = previous; }
  });

  test("raw block annotation preserves quoted markup, comments, inert text and surrounding attributes", () => {
    const source = '<div title="a &quot;quote&quot; &amp; literal &lt;img src=quoted.png&gt;">\n'
      + '<!-- <IMG src="comment.png"> -->\n'
      + '<script>const hidden = \'<img src="script.png">\';</script>\n'
      + '<textarea><img src="inert.png"></textarea>\n'
      + '<span title="literal <img src=attribute.png>">before &amp; after</span><br>\n'
      + '<ImG src="a&amp;b.png" alt="A &quot;quoted&quot; &amp; B" title="unchanged">\n'
      + '<iMaGe src="second.png" alt="second">\n</div>\n\n'
      + 'ordinary **markup**  \nnext line\n';
    const prepared = prepareChatVisualMarkdown(source, false);
    expect(prepared.visuals).toEqual([
      { index: 0, key: `offset:${source.indexOf('<ImG src="a&amp;b.png"')}`, kind: "file", source: "a&b.png", alt: 'A "quoted" & B', complete: true },
      { index: 1, key: `offset:${source.indexOf('<iMaGe src="second.png"')}`, kind: "file", source: "second.png", alt: "second", complete: true },
    ]);
    expect(getChatVisuals(source, true)).toEqual(prepared.visuals);
    const { document } = parseHTML(prepared.html);
    expect(document.querySelector("div")?.getAttribute("title")).toBe('a "quote" & literal <img src=quoted.png>');
    expect(document.querySelector("span[title]")?.getAttribute("title")).toBe("literal <img src=attribute.png>");
    expect(document.querySelectorAll("[data-uatu-visual]").length).toBe(2);
    expect(document.querySelectorAll("img").length).toBe(0);
    expect(document.querySelector("strong")?.textContent).toBe("markup");
    expect(document.querySelector("p br")).not.toBeNull();
    expect(prepared.html).not.toContain("uatu-origin-");
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
