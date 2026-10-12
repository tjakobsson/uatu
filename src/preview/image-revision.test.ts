import { describe, expect, test } from "bun:test";

import type { RootGroup } from "../shared/types";
import { imageDocumentId, revisionedImageUrl, withImageRevision } from "./image-revision";

const roots: RootGroup[] = [
  {
    id: "/tmp/docs",
    label: "docs",
    path: "/tmp/docs",
    hiddenCount: 0,
    docs: [
      { id: "/tmp/docs/README.md", name: "README.md", relativePath: "README.md", mtimeMs: 1, rootId: "/tmp/docs", kind: "markdown" },
      { id: "/tmp/docs/hero.svg", name: "hero.svg", relativePath: "hero.svg", mtimeMs: 1, rootId: "/tmp/docs", kind: "binary" },
      { id: "/tmp/docs/guides/shot #2.png", name: "shot #2.png", relativePath: "guides/shot #2.png", mtimeMs: 1, rootId: "/tmp/docs", kind: "binary" },
    ],
  },
];

const revisions: Record<string, string> = {
  "/tmp/docs/hero.svg": "e1:7",
  "/tmp/docs/guides/shot #2.png": "e1:42",
};
const revisionOf = (id: string) => revisions[id] ?? "e1:missing";

describe("revisionedImageUrl", () => {
  test("applies the change revision of the watched file a relative image resolves to", () => {
    expect(revisionedImageUrl("./hero.svg", "http://127.0.0.1:4711/", "/", roots, revisionOf))
      .toBe("http://127.0.0.1:4711/hero.svg?revision=e1%3A7");
    expect(revisionedImageUrl("../hero.svg", "http://127.0.0.1:4711/guides/", "/", roots, revisionOf))
      .toBe("http://127.0.0.1:4711/hero.svg?revision=e1%3A7");
  });

  test("decodes the path the way the static-file fallback does", () => {
    expect(revisionedImageUrl("./shot%20%232.png", "http://127.0.0.1:4711/guides/", "/", roots, revisionOf))
      .toBe("http://127.0.0.1:4711/guides/shot%20%232.png?revision=e1%3A42");
  });

  test("replaces an earlier revision rather than appending another", () => {
    expect(revisionedImageUrl("http://127.0.0.1:4711/hero.svg?revision=e1%3A1", "http://127.0.0.1:4711/", "/", roots, revisionOf))
      .toBe("http://127.0.0.1:4711/hero.svg?revision=e1%3A7");
  });

  test("is stable while the revision is: the same file keeps the same URL", () => {
    const first = revisionedImageUrl("./hero.svg", "http://127.0.0.1:4711/", "/", roots, revisionOf)!;
    expect(revisionedImageUrl(first, "http://127.0.0.1:4711/", "/", roots, revisionOf)).toBe(first);
  });

  test("resolves under a base path, as a Hub session serves it", () => {
    expect(revisionedImageUrl("./hero.svg", "http://hub.local/s/docs/", "/s/docs/", roots, revisionOf))
      .toBe("http://hub.local/s/docs/hero.svg?revision=e1%3A7");
    expect(revisionedImageUrl("/hero.svg", "http://hub.local/s/docs/", "/s/docs/", roots, revisionOf)).toBeNull();
  });

  test("leaves images outside the watched files untouched", () => {
    const base = "http://127.0.0.1:4711/";
    expect(revisionedImageUrl("https://example.com/hero.svg", base, "/", roots, revisionOf)).toBeNull();
    expect(revisionedImageUrl("data:image/png;base64,AAAA", base, "/", roots, revisionOf)).toBeNull();
    expect(revisionedImageUrl("./missing.png", base, "/", roots, revisionOf)).toBeNull();
    expect(revisionedImageUrl("./bad%E0%A4%A.png", base, "/", roots, revisionOf)).toBeNull();
  });
});

describe("imageDocumentId", () => {
  test("names the watched file an image shows, however its src is written", () => {
    expect(imageDocumentId("./hero.svg", "http://127.0.0.1:4711/", "/", roots)).toBe("/tmp/docs/hero.svg");
    expect(imageDocumentId("http://127.0.0.1:4711/hero.svg?revision=e1%3A1", "http://127.0.0.1:4711/guides/", "/", roots))
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

describe("withImageRevision", () => {
  test("adds the revision to a relative src", () => {
    expect(withImageRevision("./shot%20%232.png", "e1:42")).toBe("./shot%20%232.png?revision=e1%3A42");
  });

  test("replaces an earlier revision and keeps other query parameters and the fragment", () => {
    expect(withImageRevision("./hero.svg?revision=e1%3A1&w=2#top", "e1:7")).toBe("./hero.svg?revision=e1%3A7&w=2#top");
  });
});
