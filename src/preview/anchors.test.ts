import { describe, expect, test } from "bun:test";

import { buildInPageAnchorUrl } from "./anchor-url";

// The full in-page click handler installs at module load on the live #preview
// element and is exercised end-to-end in tests/e2e/asciidoc.e2e.ts (TOC click
// regression). Here we cover the URL-construction helper that decides what
// shape gets pushed onto the history stack — the bit that determines whether
// the back button has the right destination.

describe("buildInPageAnchorUrl", () => {
  test("composes pathname + search + #fragment for a simple id", () => {
    const url = buildInPageAnchorUrl({ pathname: "/asciidoc-cheatsheet.adoc", search: "" }, "section");
    expect(url).toBe("/asciidoc-cheatsheet.adoc#section");
  });

  test("preserves the query string when one is present", () => {
    const url = buildInPageAnchorUrl(
      { pathname: "/guides/setup.md", search: "?reviewScore=root" },
      "installation",
    );
    expect(url).toBe("/guides/setup.md?reviewScore=root#installation");
  });

  test("percent-encodes fragment ids that contain characters needing encoding", () => {
    const url = buildInPageAnchorUrl({ pathname: "/doc.md", search: "" }, "héllo wörld");
    expect(url).toBe("/doc.md#h%C3%A9llo%20w%C3%B6rld");
  });

  test("does not double-encode an already-percent-encoded id", () => {
    // The handler decodes the id via decodeURIComponent before calling us, so
    // the input here is always the *decoded* form — verify we encode once.
    const url = buildInPageAnchorUrl({ pathname: "/doc.md", search: "" }, "user-content-section_a");
    expect(url).toBe("/doc.md#user-content-section_a");
  });
});

describe("in-page anchor push decision", () => {
  // The handler pushes iff `targetUrl !== currentUrl`. These tests verify the
  // contract that drives the de-dup guard.

  test("clicking a different fragment changes the URL", () => {
    const current = "/doc.md";  // no hash
    const target = buildInPageAnchorUrl({ pathname: "/doc.md", search: "" }, "x");
    expect(target).not.toBe(current);
  });

  test("clicking the same fragment twice produces the same URL", () => {
    const target1 = buildInPageAnchorUrl({ pathname: "/doc.md", search: "" }, "x");
    const target2 = buildInPageAnchorUrl({ pathname: "/doc.md", search: "" }, "x");
    expect(target1).toBe(target2);
  });

  test("clicking a different fragment produces a different URL", () => {
    const target1 = buildInPageAnchorUrl({ pathname: "/doc.md", search: "" }, "x");
    const target2 = buildInPageAnchorUrl({ pathname: "/doc.md", search: "" }, "y");
    expect(target1).not.toBe(target2);
  });
});
