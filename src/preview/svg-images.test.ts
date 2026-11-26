import { afterEach, beforeEach, expect, test } from "bun:test";
import { parseHTML } from "linkedom";

import { preparePreviewHtml, previewImageSource } from "./svg-images";

const saved = { document: globalThis.document, IntersectionObserver: globalThis.IntersectionObserver };

beforeEach(() => {
  const { document } = parseHTML(`<html><head><base href="http://127.0.0.1:4711/guides/"></head><body></body></html>`);
  (globalThis as any).document = document;
  (globalThis as any).IntersectionObserver = class {};
});

afterEach(() => {
  (globalThis as any).document = saved.document;
  (globalThis as any).IntersectionObserver = saved.IntersectionObserver;
});

// The visibility loader defers only what it always has: a source whose path,
// as written, ends in `.svg`. Zoom reads `figure%2Esvg` as an SVG; loading
// does not change for it.
test("only a source written as an SVG starts on the placeholder", () => {
  const content = preparePreviewHtml('<img src="./plain.svg?revision=1"><img src="./figure%2Esvg">');
  const [plain, encoded] = Array.from(content.querySelectorAll("img"));
  expect(plain!.getAttribute("src")).toStartWith("data:image/svg+xml,");
  expect(previewImageSource(plain!)).toBe("./plain.svg?revision=1");
  expect(encoded!.getAttribute("src")).toBe("./figure%2Esvg");
});
