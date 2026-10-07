import { describe, expect, test } from "bun:test";

import type { RootGroup } from "../shared/types";
import { imageDocumentId, versionedImageUrl, withImageVersion } from "./image-version";

const roots: RootGroup[] = [
  {
    id: "/tmp/docs",
    label: "docs",
    path: "/tmp/docs",
    hiddenCount: 0,
    docs: [
      { id: "/tmp/docs/README.md", name: "README.md", relativePath: "README.md", mtimeMs: 1, rootId: "/tmp/docs", kind: "markdown" },
      { id: "/tmp/docs/hero.svg", name: "hero.svg", relativePath: "hero.svg", mtimeMs: 1700000000123.5, rootId: "/tmp/docs", kind: "binary" },
      { id: "/tmp/docs/guides/shot #2.png", name: "shot #2.png", relativePath: "guides/shot #2.png", mtimeMs: 42, rootId: "/tmp/docs", kind: "binary" },
    ],
  },
];

describe("versionedImageUrl", () => {
  test("stamps a relative image that resolves to a watched file with its mtime", () => {
    expect(versionedImageUrl("./hero.svg", "http://127.0.0.1:4711/", "/", roots))
      .toBe("http://127.0.0.1:4711/hero.svg?v=1700000000123.5");
    expect(versionedImageUrl("../hero.svg", "http://127.0.0.1:4711/guides/", "/", roots))
      .toBe("http://127.0.0.1:4711/hero.svg?v=1700000000123.5");
  });

  test("decodes the path the way the static-file fallback does", () => {
    expect(versionedImageUrl("./shot%20%232.png", "http://127.0.0.1:4711/guides/", "/", roots))
      .toBe("http://127.0.0.1:4711/guides/shot%20%232.png?v=42");
  });

  test("replaces an earlier stamp rather than appending another", () => {
    expect(versionedImageUrl("http://127.0.0.1:4711/hero.svg?v=1", "http://127.0.0.1:4711/", "/", roots))
      .toBe("http://127.0.0.1:4711/hero.svg?v=1700000000123.5");
  });

  test("resolves under a base path, as a Hub session serves it", () => {
    expect(versionedImageUrl("./hero.svg", "http://hub.local/s/docs/", "/s/docs/", roots))
      .toBe("http://hub.local/s/docs/hero.svg?v=1700000000123.5");
    expect(versionedImageUrl("/hero.svg", "http://hub.local/s/docs/", "/s/docs/", roots)).toBeNull();
  });

  test("leaves images outside the watched files untouched", () => {
    const base = "http://127.0.0.1:4711/";
    expect(versionedImageUrl("https://example.com/hero.svg", base, "/", roots)).toBeNull();
    expect(versionedImageUrl("data:image/png;base64,AAAA", base, "/", roots)).toBeNull();
    expect(versionedImageUrl("./missing.png", base, "/", roots)).toBeNull();
    expect(versionedImageUrl("./bad%E0%A4%A.png", base, "/", roots)).toBeNull();
  });
});

describe("imageDocumentId", () => {
  test("names the watched file an image shows, however its src is written", () => {
    expect(imageDocumentId("./hero.svg", "http://127.0.0.1:4711/", "/", roots)).toBe("/tmp/docs/hero.svg");
    expect(imageDocumentId("http://127.0.0.1:4711/hero.svg?v=1", "http://127.0.0.1:4711/guides/", "/", roots))
      .toBe("/tmp/docs/hero.svg");
    expect(imageDocumentId("./shot%20%232.png", "http://127.0.0.1:4711/guides/", "/", roots))
      .toBe("/tmp/docs/guides/shot #2.png");
    expect(imageDocumentId("./hero.svg", "http://hub.local/s/docs/", "/s/docs/", roots)).toBe("/tmp/docs/hero.svg");
  });

  test("is null for images that are not watched files", () => {
    const base = "http://127.0.0.1:4711/";
    expect(imageDocumentId("https://example.com/hero.svg", base, "/", roots)).toBeNull();
    expect(imageDocumentId("data:image/png;base64,AAAA", base, "/", roots)).toBeNull();
    expect(imageDocumentId("./missing.png", base, "/", roots)).toBeNull();
  });
});

describe("withImageVersion", () => {
  test("adds the version to a relative src", () => {
    expect(withImageVersion("./shot%20%232.png", 42)).toBe("./shot%20%232.png?v=42");
    expect(withImageVersion("./hero.svg", 1700000000123.5)).toBe("./hero.svg?v=1700000000123.5");
  });

  test("replaces an earlier stamp and keeps other query parameters and the fragment", () => {
    expect(withImageVersion("./hero.svg?v=1&w=2#top", 7)).toBe("./hero.svg?v=7&w=2#top");
  });
});
