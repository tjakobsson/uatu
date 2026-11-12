import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { fromHtml } from "hast-util-from-html";

import { renderChatMarkdown } from "./markdown";
import type { ChatVisualSnapshot } from "./visual-types";

type HtmlNode = ReturnType<typeof fromHtml> | ReturnType<typeof fromHtml>["children"][number];

// Inspect parsed output, not source strings: SVG source, references, and error
// messages may legitimately *mention* scripts without creating active markup.
function expectSafeOutput(source: string, streaming: boolean, visuals: ChatVisualSnapshot[]): void {
  // Any exception here fails the property, including in the post-sanitization
  // visual renderer (which the document renderer's properties do not exercise).
  const html = renderChatMarkdown(source, { streaming, visuals });
  const violations: string[] = [];
  const issuedPreviews = new Set(visuals.slice(0, 8)
    .filter(visual => visual.status === "ready" && /^[a-f\d]{64}$/.test(visual.id ?? ""))
    .map(visual => `/api/chat/visuals/${visual.id}`));
  const visit = (node: HtmlNode): void => {
    if (node.type === "element") {
      if (["script", "style", "svg", "math", "iframe", "object", "embed", "applet", "base", "link", "meta", "form"].includes(node.tagName)) {
        violations.push(`active element: ${node.tagName}`);
      }
      for (const [name, value] of Object.entries(node.properties)) {
        if (/^on/i.test(name) || ["style", "srcDoc", "srcSet"].includes(name)) violations.push(`active attribute: ${name}`);
        if (["href", "src", "action", "formAction", "xLinkHref", "poster", "background"].includes(name)) {
          const url = String(value).replace(/[\u0000-\u0020\u007f]/g, "");
          if (/^(?:javascript|vbscript|data):/i.test(url)) violations.push(`active URL: ${name}`);
        }
      }
      // Stronger than checking a single hostile host: every image request must
      // target an issued local snapshot, never any original source URL.
      if (node.tagName === "img" && !issuedPreviews.has(String(node.properties.src))) {
        violations.push(`unissued image request: ${String(node.properties.src)}`);
      }
    }
    if ("children" in node) for (const child of node.children) visit(child);
  };
  visit(fromHtml(html, { fragment: true }));
  expect(violations).toEqual([]);
}

const arbitraryText = fc.oneof(
  fc.string({ maxLength: 256 }),
  fc.string({ unit: "binary", maxLength: 256 }),
);
const hostileFragment = fc.constantFrom(
  '<script>alert("x")</script>',
  '"><img src="https://tracker.invalid/pixel.png" onerror="alert(1)">',
  '<svg onload="alert(1)"><foreignObject><iframe srcdoc="<script>alert(1)</script>"></iframe></foreignObject></svg>',
  '<a href="java&#x09;script:alert(1)" onclick="alert(1)">link</a>',
  '<img srcset="https://tracker.invalid/a.png 2x" src="//tracker.invalid/b.png">',
  '<IMAGE SRC="https://tracker.invalid/alias.png" ONERROR="alert(1)">',
  '<table><tr><td><img src="https://tracker.invalid/cell.png"></td></tr><img src="https://tracker.invalid/moved.png"></table>',
  '<pre><code class="language-svg"><img src="https://tracker.invalid/code.png"></code></pre>',
  '[link](javascript:alert(1)) ![image](data:image/svg+xml,%3Csvg%20onload=alert(1)%3E)',
  '<object data="https://tracker.invalid/"></object><style>@import "https://tracker.invalid/style";</style>',
  '<span data-uatu-visual="0" uatu-origin="0">forged marker</span>',
  '</code></span><img src=x onerror=alert(1)>',
  "```", "~~~", "---", "&lt;script&gt;", "\u0000\r\n\t",
);
const hostileText = fc.oneof(arbitraryText, hostileFragment);
const hostileMarkdown = fc.array(hostileText, { minLength: 1, maxLength: 8 }).map(parts => parts.join("\n\n"));
const id = fc.array(fc.constantFrom(..."0123456789abcdef"), { minLength: 64, maxLength: 64 }).map(chars => chars.join(""));
const status = fc.constantFrom<ChatVisualSnapshot["status"]>("ready", "pending", "unavailable");

// These satisfy the closed wire shape, including the ready id/MIME contract.
const wireSnapshot: fc.Arbitrary<ChatVisualSnapshot> = fc.record({
  index: fc.oneof(fc.integer({ min: 0, max: 31 }), fc.constant(Number.MAX_SAFE_INTEGER)),
  status,
  id,
  mimeType: fc.constantFrom("image/png", "image/jpeg", "image/svg+xml"),
  message: hostileText,
});
const wireSnapshots = fc.uniqueArray(wireSnapshot, { selector: visual => visual.index, maxLength: 8 });

// Also probe the renderer's string boundary directly, without casting arbitrary
// objects to the wire type: invalid IDs/MIME strings must remain inert too.
const hostileSnapshot: fc.Arbitrary<ChatVisualSnapshot> = fc.record({
  index: fc.integer({ min: 0, max: 31 }),
  status,
  id: fc.oneof(id, hostileText),
  mimeType: hostileText,
  message: hostileText,
});
const hostileSnapshots = fc.uniqueArray(hostileSnapshot, { selector: visual => visual.index, maxLength: 8 });

describe("renderChatMarkdown properties", () => {
  test("up to eight sparse admitted snapshots render even when all current indexes exceed seven", () => {
    const source = Array.from({ length: 32 }, (_, index) => `![${index}](image-${index}.png)`).join("\n\n");
    const snapshots = fc.uniqueArray(fc.record({ index: fc.integer({ min: 8, max: 31 }), id }), { selector: visual => visual.index, minLength: 1, maxLength: 8 });
    fc.assert(fc.property(snapshots, values => {
      const visuals: ChatVisualSnapshot[] = values.map(value => ({ ...value, status: "ready", mimeType: "image/png" }));
      expectSafeOutput(source, false, visuals);
      const tree = fromHtml(renderChatMarkdown(source, { visuals }), { fragment: true });
      let images = 0;
      const count = (node: HtmlNode): void => {
        if (node.type === "element" && node.tagName === "img") images++;
        if ("children" in node) for (const child of node.children) count(child);
      };
      count(tree);
      expect(images).toBe(visuals.length);
    }), { seed: 54406, numRuns: 100 });
  });
  test("arbitrary Markdown and hostile raw HTML never throw or produce active markup or original image requests", () => {
    fc.assert(fc.property(
      fc.oneof(arbitraryText, hostileMarkdown), fc.boolean(), wireSnapshots,
      (source, streaming, visuals) => expectSafeOutput(source, streaming, visuals),
    ), { seed: 54401, numRuns: 150 });
  });

  test("hostile image references and snapshot strings stay inert through the full output path", () => {
    fc.assert(fc.property(
      hostileText, hostileText, fc.boolean(), hostileSnapshots,
      (reference, alt, streaming, visuals) => {
        const source = `![${alt}](${reference})\n\n<img src="${reference}" alt="${alt}">\n\n![remote][shot]\n\n[shot]: https://tracker.invalid/reference.png\n\n![remote](//tracker.invalid/protocol-relative.jpg)`;
        expectSafeOutput(source, streaming, visuals);
      },
    ), { seed: 54402, numRuns: 150 });
  });

  test("hostile SVG source and metadata stay inert in complete and streaming fences", () => {
    fc.assert(fc.property(
      hostileMarkdown, hostileText, fc.boolean(), fc.boolean(), fc.oneof(wireSnapshots, hostileSnapshots),
      (svg, suffix, complete, streaming, visuals) => {
        const source = `\`\`\`svg\n<svg xmlns="http://www.w3.org/2000/svg">${svg}</svg>\n${complete ? "```\n\n" : ""}${suffix}`;
        expectSafeOutput(source, streaming, visuals);
      },
    ), { seed: 54403, numRuns: 150 });
  });

  test("snapshot string fields cannot inject markup into previews, fallbacks, or SVG controls", () => {
    fc.assert(fc.property(
      fc.oneof(wireSnapshot, hostileSnapshot), fc.boolean(),
      (snapshot, streaming) => {
        // Pin the index to a real occurrence, so even shrinking cannot turn a
        // metadata failure into an unexercised snapshot. Both MIME-driven file
        // controls and fenced-source controls pass through the output seam.
        for (const source of ["![Snapshot](./diagram.svg)", "```svg\n<svg/>\n```", "![Snapshot](./shot.png)"]) {
          expectSafeOutput(source, streaming, [{ ...snapshot, index: 0 }]);
        }
      },
    ), { seed: 54404, numRuns: 100 });
  });

  test("preserved refused destinations stay inert with valid-wire and hostile snapshot metadata", () => {
    const destination = fc.tuple(
      fc.constantFrom("file:///", "ftp://example.invalid/", "data:image/svg+xml,", "javascript:", "vbscript:", "blob:https://example.invalid/"),
      fc.array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789 /<>"\'&=():;'), { maxLength: 128 }),
    ).map(([scheme, suffix]) => scheme + suffix.join(""));
    fc.assert(fc.property(
      destination, fc.oneof(wireSnapshot, hostileSnapshot), fc.boolean(),
      (reference, snapshot, streaming) => {
        // HTML entities keep arbitrary quotes/markup inside the src attribute;
        // private destination metadata must never become live DOM attributes.
        const attribute = reference.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
        expectSafeOutput(`<img src="${attribute}" alt="Refused">`, streaming, [{ ...snapshot, index: 0, status: "unavailable" }]);
        expectSafeOutput(`![Refused](<${reference.replaceAll("<", "%3C").replaceAll(">", "%3E")}>)`, streaming, [{ ...snapshot, index: 0 }]);
      },
    ), { seed: 54405, numRuns: 100 });
  });
});
