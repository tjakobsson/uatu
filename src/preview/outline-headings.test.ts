import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";

import { cleanHeadingText, collectHeadings } from "./outline-headings";

// The full overlay (panel, scroll-spy, filter, side) installs against the live
// preview DOM and is exercised end-to-end in tests/e2e/outline.e2e.ts. Here we
// cover the pure heading-enumeration helpers that decide what the outline
// lists — the part with the format-uniformity guarantees.

function bodyOf(html: string): HTMLElement {
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  return document.body as unknown as HTMLElement;
}

describe("collectHeadings", () => {
  test("enumerates h1–h6 in document order with levels and ids", () => {
    // Mirrors uatu's rendered output: headings carry `user-content-`-prefixed
    // ids from the sanitizer for both Markdown and AsciiDoc.
    const root = bodyOf(
      `<h1 id="user-content-title">Title</h1>` +
        `<h2 id="user-content-headings">Headings</h2>` +
        `<h3 id="user-content-level-3">Level 3 heading</h3>` +
        `<h2 id="user-content-lists">Lists</h2>`,
    );
    const headings = collectHeadings(root);
    expect(headings.map(h => [h.level, h.text, h.id])).toEqual([
      [1, "Title", "user-content-title"],
      [2, "Headings", "user-content-headings"],
      [3, "Level 3 heading", "user-content-level-3"],
      [2, "Lists", "user-content-lists"],
    ]);
  });

  test("captures a live element reference for navigation", () => {
    const root = bodyOf(`<h2 id="user-content-tables">Tables</h2>`);
    const [heading] = collectHeadings(root);
    expect(heading?.element).toBe(root.querySelector("h2") as unknown as HTMLElement);
  });

  test("reports a null id when the heading has none (e.g. duplicate-stripped)", () => {
    const root = bodyOf(`<h2>No anchor here</h2>`);
    const [heading] = collectHeadings(root);
    expect(heading?.id).toBeNull();
  });

  test("derives clean labels from heading text content with inline markup", () => {
    const root = bodyOf(`<h2 id="user-content-fmt">Inline <code>code</code> heading</h2>`);
    const [heading] = collectHeadings(root);
    expect(heading?.text).toBe("Inline code heading");
  });

  test("skips headings that are empty after cleaning", () => {
    const root = bodyOf(`<h2></h2><h3 id="user-content-real">Real</h3>`);
    const headings = collectHeadings(root);
    expect(headings.map(h => h.text)).toEqual(["Real"]);
  });

  test("returns an empty list for a document with no headings", () => {
    const root = bodyOf(`<p>Just a paragraph.</p><pre><code>not a heading</code></pre>`);
    expect(collectHeadings(root)).toEqual([]);
  });

  test("enumerates only headings under the given root (split rendered pane)", () => {
    // In split layout the outline enumerates the rendered pane, not the source
    // pane, so scoping to the passed root must be respected.
    const root = bodyOf(
      `<div class="preview-pane-source"><h1 id="src">Source side</h1></div>` +
        `<div class="preview-pane-rendered"><h1 id="user-content-doc">Doc</h1></div>`,
    );
    const renderedPane = root.querySelector(".preview-pane-rendered") as unknown as HTMLElement;
    const headings = collectHeadings(renderedPane);
    expect(headings.map(h => h.text)).toEqual(["Doc"]);
  });
});

describe("cleanHeadingText", () => {
  test("collapses whitespace runs and trims", () => {
    const root = bodyOf(`<h2>  Source\n   Listings  </h2>`);
    expect(cleanHeadingText(root.querySelector("h2") as unknown as HTMLElement)).toBe(
      "Source Listings",
    );
  });

  test("strips a leading pilcrow or hash injected by anchor affordances", () => {
    const root = bodyOf(`<h2>¶ Footnotes</h2>`);
    expect(cleanHeadingText(root.querySelector("h2") as unknown as HTMLElement)).toBe("Footnotes");
  });
});
