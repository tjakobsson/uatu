import { afterEach, describe, expect, test } from "bun:test";

import type { RootGroup } from "../shared/types";
import {
  createEmbeddedImagesLearner,
  embeddedImageMembership,
  knowsEmbeddedImages,
  recordEmbeddedImages,
  resetEmbeddedImagesForTests,
} from "./embedded-images";

function rootsWith(...relativePaths: string[]): RootGroup[] {
  return [{
    id: "/tmp/docs",
    label: "docs",
    path: "/tmp/docs",
    hiddenCount: 0,
    docs: relativePaths.map(relativePath => ({
      id: `/tmp/docs/${relativePath}`,
      name: relativePath.split("/").at(-1)!,
      relativePath,
      mtimeMs: 1,
      rootId: "/tmp/docs",
      kind: relativePath.endsWith(".md") ? "markdown" as const : "binary" as const,
    })),
  }];
}

const BASE = "http://127.0.0.1:4711/";

// The ids `id` (a Markdown document at `revision`) embeds, or "unknown".
function embedded(id: string, roots: RootGroup[], basePath = "/", revision = "e1:1"): string[] | "unknown" {
  const membership = embeddedImageMembership({ id, kind: "markdown" }, revision, roots, basePath);
  return membership.known ? [...membership.ids].sort() : "unknown";
}

afterEach(() => resetEmbeddedImagesForTests());

describe("embeddedImageMembership", () => {
  test("names the watched images the recorded rendered payload embeds", () => {
    const roots = rootsWith("guides/setup.md", "guides/hero.svg", "logo.png", "other.png");
    recordEmbeddedImages("/tmp/docs/guides/setup.md", "e1:1", `${BASE}guides/`, [
      "./hero.svg",
      "../logo.png",
      "https://example.com/remote.png",
      "data:image/png;base64,AAAA",
      "./missing.png",
    ]);
    expect(embedded("/tmp/docs/guides/setup.md", roots)).toEqual(["/tmp/docs/guides/hero.svg", "/tmp/docs/logo.png"]);
  });

  test("does not depend on the view on screen or on the preview DOM", () => {
    // The record is fed from the rendered payload alone, so the answer is the
    // same whether the document is shown Rendered, as Source, or as a Diff.
    const roots = rootsWith("README.md", "hero.svg");
    recordEmbeddedImages("/tmp/docs/README.md", "e1:1", BASE, ["./hero.svg"]);
    expect(embedded("/tmp/docs/README.md", roots)).toEqual(["/tmp/docs/hero.svg"]);
  });

  test("a document that embeds nothing is known and empty, not unknown", () => {
    const roots = rootsWith("README.md", "hero.svg");
    recordEmbeddedImages("/tmp/docs/README.md", "e1:1", BASE, []);
    expect(embedded("/tmp/docs/README.md", roots)).toEqual([]);
  });

  test("is unknown for a document nothing was recorded for, or recorded at another revision", () => {
    const roots = rootsWith("README.md", "other.md", "hero.svg");
    expect(embedded("/tmp/docs/README.md", roots)).toBe("unknown");
    recordEmbeddedImages("/tmp/docs/README.md", "e1:1", BASE, ["./hero.svg"]);
    expect(embedded("/tmp/docs/other.md", roots)).toBe("unknown");
    // An edit can add or remove images: the older record does not answer.
    expect(embedded("/tmp/docs/README.md", roots, "/", "e1:2")).toBe("unknown");
  });

  test("no document, or one that cannot embed images, is known to embed nothing", () => {
    const roots = rootsWith("README.md", "hero.svg");
    const none = embeddedImageMembership(null, "e1:1", roots, "/");
    expect(none.known && none.ids.size).toBe(0);
    const text = embeddedImageMembership({ id: "/tmp/docs/notes.txt", kind: "text" }, "e1:1", roots, "/");
    expect(text.known && text.ids.size).toBe(0);
    const image = embeddedImageMembership({ id: "/tmp/docs/hero.svg", kind: "binary" }, "e1:1", roots, "/");
    expect(image.known && image.ids.size).toBe(0);
    const asciidoc = embeddedImageMembership({ id: "/tmp/docs/guide.adoc", kind: "asciidoc" }, "e1:1", roots, "/");
    expect(asciidoc.known).toBe(false);
  });

  test("recognises an image created after the document was rendered", () => {
    recordEmbeddedImages("/tmp/docs/README.md", "e1:1", BASE, ["./hero.svg"]);
    expect(embedded("/tmp/docs/README.md", rootsWith("README.md"))).toEqual([]);
    expect(embedded("/tmp/docs/README.md", rootsWith("README.md", "hero.svg"))).toEqual(["/tmp/docs/hero.svg"]);
  });

  test("resolves under a Hub base path", () => {
    const roots = rootsWith("README.md", "hero.svg");
    recordEmbeddedImages("/tmp/docs/README.md", "e1:1", "http://hub.local/s/docs/", ["./hero.svg"]);
    expect(embedded("/tmp/docs/README.md", roots, "/s/docs/")).toEqual(["/tmp/docs/hero.svg"]);
  });
});

describe("knowsEmbeddedImages", () => {
  test("is per document revision, so an edited document is learned again", () => {
    recordEmbeddedImages("/tmp/docs/README.md", "e1:1", BASE, []);
    expect(knowsEmbeddedImages("/tmp/docs/README.md", "e1:1")).toBe(true);
    expect(knowsEmbeddedImages("/tmp/docs/README.md", "e1:2")).toBe(false);
    expect(knowsEmbeddedImages("/tmp/docs/other.md", "e1:1")).toBe(false);
  });
});

describe("createEmbeddedImagesLearner", () => {
  const DOC = "/tmp/docs/README.md";
  const roots = rootsWith("README.md", "hero.svg");

  type Answer = { baseUrl: string; sources: readonly string[] } | null;

  function harness() {
    const state = { selectedId: DOC as string | null, revision: "e1:1", fetches: 0 };
    let answer!: (value: Answer) => void;
    let fail!: (error: Error) => void;
    const learn = createEmbeddedImagesLearner({
      revisionOf: () => state.revision,
      isSelected: id => state.selectedId === id,
      fetchSources: () => {
        state.fetches++;
        return new Promise<Answer>((resolve, reject) => { answer = resolve; fail = reject; });
      },
    });
    return {
      state,
      learn,
      answer: (sources: readonly string[]) => answer({ baseUrl: BASE, sources }),
      noAnswer: () => answer(null),
      fail: () => fail(new Error("request unanswered")),
    };
  }

  test("records the answer for the selected document at the requested revision", async () => {
    const h = harness();
    const learning = h.learn(DOC);
    h.answer(["./hero.svg"]);
    expect(await learning).toBe("known");
    expect(knowsEmbeddedImages(DOC, "e1:1")).toBe(true);
    expect(embedded(DOC, roots)).toEqual(["/tmp/docs/hero.svg"]);
  });

  test("drops a late answer once the document is no longer selected", async () => {
    const h = harness();
    const learning = h.learn(DOC);
    h.state.selectedId = "/tmp/docs/other.md";
    h.answer(["./hero.svg"]);
    expect(await learning).toBe("stale");
    expect(knowsEmbeddedImages(DOC, "e1:1")).toBe(false);
    expect(embedded(DOC, roots)).toBe("unknown");
  });

  test("drops a late answer for a revision that has since changed, and does not overwrite the newer record", async () => {
    const h = harness();
    const stale = h.learn(DOC);
    h.state.revision = "e1:2";
    recordEmbeddedImages(DOC, "e1:2", BASE, []);
    h.answer(["./hero.svg"]);
    expect(await stale).toBe("stale");
    expect(knowsEmbeddedImages(DOC, "e1:1")).toBe(false);
    expect(knowsEmbeddedImages(DOC, "e1:2")).toBe(true);
    expect(embedded(DOC, roots, "/", "e1:2")).toEqual([]);
  });

  test("a lookup with no usable answer, or one that rejects, is failed and leaves membership unknown", async () => {
    const h = harness();
    const none = h.learn(DOC);
    h.noAnswer();
    expect(await none).toBe("failed");
    expect(embedded(DOC, roots)).toBe("unknown");
    const rejected = h.learn(DOC);
    h.fail();
    expect(await rejected).toBe("failed");
    expect(embedded(DOC, roots)).toBe("unknown");
    // A failed lookup is asked again on the next request.
    expect(h.state.fetches).toBe(2);
  });

  test("asks once per revision, shares the request in flight, and asks again after the document changes", async () => {
    const h = harness();
    const first = h.learn(DOC);
    const joined = h.learn(DOC);
    h.answer([]);
    expect(await first).toBe("known");
    expect(await joined).toBe("known");
    expect(await h.learn(DOC)).toBe("known");
    expect(h.state.fetches).toBe(1);
    h.state.revision = "e1:2";
    const second = h.learn(DOC);
    h.answer([]);
    await second;
    expect(h.state.fetches).toBe(2);
  });
});
