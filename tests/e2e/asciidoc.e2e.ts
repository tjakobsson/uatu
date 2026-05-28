import { expect, test } from "./fixtures";

import { clickTreeFile, treeRow } from "./tree-helpers";
import { standardBeforeEach } from "./fixtures";

test.beforeEach(async ({ page, request }) => {
  await standardBeforeEach(page, request);
});

test.afterEach(async ({ request }) => {
  await request.post("/__e2e/reset");
});

test("renders the AsciiDoc cheat sheet with full heading depth, TOC, admonitions, syntax highlighting, and Mermaid", async ({ page }) => {
  // Uses the permanent testdata/watch-docs/asciidoc-cheatsheet.adoc fixture,
  // which doubles as a visual reference for the AsciiDoc render path AND the
  // fixture under test for it.
  const adocButton = treeRow(page, "asciidoc-cheatsheet.adoc");
  await expect(adocButton).toBeVisible();
  await adocButton.click();

  await expect(page.locator("#preview-type")).toHaveText("asciidoc");
  await expect(page.locator("#preview-title")).toHaveText("AsciiDoc Cheat Sheet");

  // Heading depth: doctitle → <h1>, then ==/===/====/=====/====== → h2-h6.
  await expect(page.locator("#preview h1")).toHaveCount(1);
  await expect(page.locator("#preview h2")).not.toHaveCount(0);
  await expect(page.locator("#preview h3")).not.toHaveCount(0);
  await expect(page.locator("#preview h4")).not.toHaveCount(0);
  await expect(page.locator("#preview h5")).not.toHaveCount(0);
  await expect(page.locator("#preview h6")).not.toHaveCount(0);

  // TOC renders as a list of links to section anchors. Hrefs are prefixed
  // with `user-content-` to match the (also-prefixed) heading ids — this is
  // what makes in-page jumps actually navigate.
  await expect(page.locator("#preview a[href='#user-content-_headings']")).toBeVisible();
  await expect(page.locator("#preview a[href='#user-content-_admonitions']")).toBeVisible();

  // With the renderer's `:toclevels: 5` default, the TOC reaches into
  // deeper sections — including the `=== Unordered`/`=== Ordered` lists
  // nested under `== Lists`.
  await expect(page.locator("#preview .toc a[href='#user-content-_unordered']")).toBeVisible();
  await expect(page.locator("#preview .toc a[href='#user-content-_ordered']")).toBeVisible();

  // Two admonition kinds for spread.
  await expect(page.locator("#preview .admonitionblock.note")).toBeVisible();
  await expect(page.locator("#preview .admonitionblock.warning")).toBeVisible();

  // Highlighted code (the cheat sheet has multiple [source,javascript] blocks).
  await expect(page.locator("#preview pre code.hljs.language-javascript").first()).toBeVisible();

  // Both AsciiDoc mermaid forms — `[source,mermaid]` and the bare `[mermaid]`
  // block style — hydrate client-side into rendered SVGs.
  const diagrams = page.locator("#preview .mermaid svg");
  await expect(diagrams).toHaveCount(2);
  await expect(diagrams.first()).toBeVisible();
  await expect(diagrams.nth(1)).toBeVisible();

  // Block quote and sidebar.
  await expect(page.locator("#preview .quoteblock")).toBeVisible();
  await expect(page.locator("#preview .sidebarblock")).toBeVisible();
});

test("clicking a Table of Contents link in the AsciiDoc cheat sheet navigates to that section", async ({ page }) => {
  // Full round-trip: TOC entries are rendered with `href="#user-content-..."`
  // (sanitize prefixes heading ids; rewriteInPageAnchors mirrors that on the
  // hrefs), and an in-page anchor click handler in app.ts intercepts the click
  // and scrolls the matching heading into view directly.
  await treeRow(page, "asciidoc-cheatsheet.adoc").click();
  await expect(page.locator("#preview-title")).toHaveText("AsciiDoc Cheat Sheet");

  // Pick a section near the bottom of the document so the click triggers
  // visible scrolling (not a no-op).
  const targetId = "user-content-_admonitions";
  const targetHeading = page.locator(`#${targetId}`);
  const tocLink = page.locator(`#preview a[href="#${targetId}"]`);

  await expect(tocLink).toBeVisible();
  await expect(targetHeading).toHaveCount(1);

  // Before the click, the target heading is below the fold.
  await expect(targetHeading).not.toBeInViewport();

  await tocLink.click();

  // After the click, the browser has scrolled the heading into view.
  await expect(targetHeading).toBeInViewport();
});

test("TOC link click in a nested-directory AsciiDoc doc does NOT navigate to a 404", async ({ page, request }) => {
  // Regression: when an .adoc file lives in a subdirectory, the per-document
  // <base href> is set to that directory (so relative image paths resolve).
  // A naive `<a href="#x">` in the TOC would resolve against the base to
  // `/<dir>/#x`, triggering a full navigation that hits the static-fallback
  // 404. The in-page anchor click handler must intercept the click and
  // scrollIntoView directly so this stays same-document.
  const longParas = Array.from({ length: 80 }, (_, i) => `Paragraph ${i + 1} of section content with words.`).join("\n\n");
  await request.post("/__e2e/reset", {
    data: {
      extras: {
        "guides/nested.adoc": `= Nested Doc
:toc:

== Alpha

${longParas}

== Bravo

content bravo
`,
      },
    },
  });
  await page.goto("/");

  // Open the nested document via the tree helper, which handles expanding
  // ancestor directories. The library renders rows inside its shadow DOM.
  await clickTreeFile(page, "guides/nested.adoc");
  await expect(page.locator("#preview .toc")).toBeVisible();

  // Confirm the base href was set to the subdirectory (the precondition
  // that makes naive fragment navigation 404).
  const baseHref = await page.locator("#preview-base").getAttribute("href");
  expect(baseHref).toMatch(/\/guides\/$/);

  const bravo = page.locator("#preview h2[id$='_bravo']");
  await expect(bravo).not.toBeInViewport();

  const urlBefore = page.url();
  await page.locator("#preview .toc a[href*='_bravo']").click();

  // Browser must NOT have navigated away — page URL pathname unchanged, and
  // the uatu app shell is still rendered (the brand text is in the sidebar).
  expect(new URL(page.url()).pathname).toBe(new URL(urlBefore).pathname);
  await expect(page.locator(".brand")).toBeVisible();

  // And the target heading must now be in view.
  await expect(bravo).toBeInViewport();
});

test("AsciiDoc cross-document links render with the original .adoc extension (not .html)", async ({ page }) => {
  // Regression: Asciidoctor's default rewrites `xref:other.adoc[]` to
  // `href="other.html"`. The preview spec requires preserving the author's
  // `href` verbatim so the in-app click handler can resolve it to a known
  // document. Drives the permanent `testdata/watch-docs/links-demo.adoc`
  // fixture.
  await treeRow(page, "links-demo.adoc").click();
  await expect(page.locator("#preview-title")).toHaveText("AsciiDoc Cross-Document Links");

  // xref:, <<>>, and link: macros all targeting the existing cheat sheet —
  // each MUST resolve to the literal `.adoc` URL.
  await expect(
    page.locator('#preview a[href="asciidoc-cheatsheet.adoc"]').first(),
  ).toBeVisible();
  await expect(page.locator('#preview a[href="guides/notes.adoc"]')).toBeVisible();

  // No link in the preview should reference a `.html` file (the bug shape).
  await expect(page.locator('#preview a[href$=".html"]')).toHaveCount(0);
});

test("clicking an AsciiDoc cross-document link switches the preview in-app (no download, no full nav)", async ({ page }) => {
  // The renderer keeps the .adoc href, but a default click would navigate
  // the browser to /other.adoc, hitting the static-file fallback that serves
  // raw bytes (download or plain-text view). The in-app click handler must
  // intercept the click and switch the preview through the same code path
  // the sidebar uses.
  await treeRow(page, "links-demo.adoc").click();
  await expect(page.locator("#preview-title")).toHaveText("AsciiDoc Cross-Document Links");

  await page.locator('#preview a[href="asciidoc-cheatsheet.adoc"]').first().click();

  // The browser stays inside the SPA — preview swaps and the sidebar
  // selection follows. The URL pathname now mirrors the active document
  // (history-tracking behavior added in the direct-links change).
  await expect(page.locator("#preview-title")).toHaveText("AsciiDoc Cheat Sheet");
  await expect(page.locator("#preview-path")).toHaveText("asciidoc-cheatsheet.adoc");
  expect(new URL(page.url()).pathname).toBe("/asciidoc-cheatsheet.adoc");

  // Sidebar selection follows the navigation.
  await expect(
    treeRow(page, "asciidoc-cheatsheet.adoc"),
  ).toHaveAttribute("aria-selected", "true");
});

test("clicking an AsciiDoc cross-document link into a subdirectory switches the preview", async ({ page }) => {
  // Same handler, exercised through `xref:guides/notes.adoc[…]` so the
  // resolved URL has a directory segment in it.
  await treeRow(page, "links-demo.adoc").click();
  await expect(page.locator("#preview-title")).toHaveText("AsciiDoc Cross-Document Links");

  await page.locator('#preview a[href="guides/notes.adoc"]').click();

  await expect(page.locator("#preview-title")).toHaveText("Notes");
  await expect(page.locator("#preview-path")).toHaveText("guides/notes.adoc");
});

test("clicking a deep TOC entry positions the heading clear of the sticky preview header", async ({ page }) => {
  // Regression: Asciidoctor places the id on the section *wrapper* (e.g.
  // `<div class="sect2" id="_unordered">`) for `==`-and-deeper sections.
  // `scrollIntoView` aligned the wrapper to the viewport top — the inner
  // heading then sat *behind* the frosted-glass sticky header. Adding
  // `scroll-margin-top` to the `.sectN[id]` selectors clears the header.
  await treeRow(page, "asciidoc-cheatsheet.adoc").click();
  await expect(page.locator("#preview-title")).toHaveText("AsciiDoc Cheat Sheet");

  const tocLink = page.locator("#preview .toc a[href='#user-content-_unordered']");
  await expect(tocLink).toBeVisible();
  await tocLink.click();

  // Resolve both rects after the scroll has had a chance to settle. The
  // scroll uses `smooth`, so we poll until the heading lands its final
  // position rather than reading mid-animation.
  const wrapper = page.locator("#user-content-_unordered");
  const previewHeader = page.locator(".preview-header");
  await expect(wrapper).toBeInViewport();

  await expect.poll(async () => {
    const wrapperRect = await wrapper.boundingBox();
    const headerRect = await previewHeader.boundingBox();
    if (!wrapperRect || !headerRect) {
      return false;
    }
    // The wrapper's top must be at or below the sticky header's bottom
    // (with a 2px tolerance for sub-pixel rendering). If we land above the
    // header bottom the inner h3 is hidden behind the frosted band.
    return wrapperRect.y >= headerRect.y + headerRect.height - 2;
  }, { timeout: 3000 }).toBe(true);
});

test("clicking a TOC entry pushes history; browser back returns to the same document at the top", async ({ page }) => {
  // Regression: the in-page anchor handler used to scroll without pushing a
  // history entry, so the user's previous navigation (probably a different
  // document) stayed at the top of the back stack — pressing back jumped
  // them out of the doc instead of returning to the top.
  await treeRow(page, "asciidoc-cheatsheet.adoc").click();
  await expect(page.locator("#preview-title")).toHaveText("AsciiDoc Cheat Sheet");
  expect(new URL(page.url()).pathname).toBe("/asciidoc-cheatsheet.adoc");
  expect(new URL(page.url()).hash).toBe("");

  // Click a TOC entry. The URL must gain the corresponding `#fragment`
  // AND the heading must scroll into view (the existing behavior preserved).
  const tocLink = page.locator("#preview .toc a[href='#user-content-_admonitions']");
  await expect(tocLink).toBeVisible();
  await tocLink.click();

  await expect.poll(() => new URL(page.url()).hash).toBe("#user-content-_admonitions");
  await expect(page.locator("#user-content-_admonitions")).toBeInViewport();

  // Browser back: the URL drops the fragment, the active document is STILL
  // the cheat sheet (not the previously-selected document), and the preview
  // body has scrolled back near the top.
  await page.goBack();

  await expect.poll(() => new URL(page.url()).hash).toBe("");
  expect(new URL(page.url()).pathname).toBe("/asciidoc-cheatsheet.adoc");
  await expect(page.locator("#preview-title")).toHaveText("AsciiDoc Cheat Sheet");

  // The deep-admonitions section should no longer be in the viewport now
  // that we're back at the top of the document.
  await expect(page.locator("#user-content-_admonitions")).not.toBeInViewport();
});
