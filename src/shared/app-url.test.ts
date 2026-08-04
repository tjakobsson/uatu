import { afterEach, describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";

import { appBasePath, appDocumentRelativePath, appPathname, appUrl, resetAppBasePathForTests } from "./app-url";

// app-url reads the injected meta tag through the global `document`, which
// bun test does not provide — install a linkedom document per scenario and
// tear it down so the module's "no DOM" default path stays testable too.
function installDocument(basePathMeta?: string) {
  const meta = basePathMeta ? `<meta name="uatu-base-path" content="${basePathMeta}" />` : "";
  const { document } = parseHTML(`<!doctype html><html><head>${meta}</head><body></body></html>`);
  (globalThis as { document?: unknown }).document = document;
  resetAppBasePathForTests();
}

afterEach(() => {
  delete (globalThis as { document?: unknown }).document;
  resetAppBasePathForTests();
});

describe("appBasePath", () => {
  test("defaults to / without a DOM at all", () => {
    expect(appBasePath()).toBe("/");
  });

  test("defaults to / when no meta tag is injected", () => {
    installDocument();
    expect(appBasePath()).toBe("/");
  });

  test("reads the injected meta tag", () => {
    installDocument("/s/alpha/");
    expect(appBasePath()).toBe("/s/alpha/");
  });
});

describe("appUrl", () => {
  test("is the identity at the default base path", () => {
    installDocument();
    expect(appUrl("/api/state")).toBe("/api/state");
  });

  test("prefixes under an injected base path, query strings included", () => {
    installDocument("/s/alpha/");
    expect(appUrl("/api/state")).toBe("/s/alpha/api/state");
    expect(appUrl("/api/search?q=x")).toBe("/s/alpha/api/search?q=x");
    expect(appUrl("/")).toBe("/s/alpha/");
  });
});

describe("appPathname / appDocumentRelativePath", () => {
  test("resolve location pathnames under the prefix", () => {
    installDocument("/s/alpha/");
    expect(appPathname("/s/alpha/guides/setup.md")).toBe("/guides/setup.md");
    expect(appDocumentRelativePath("/s/alpha/guides/setup.md")).toBe("guides/setup.md");
    expect(appDocumentRelativePath("/s/alpha/hello%20world.md")).toBe("hello world.md");
  });

  test("outside-prefix and malformed pathnames resolve to no document", () => {
    installDocument("/s/alpha/");
    expect(appPathname("/guides/setup.md")).toBeNull();
    expect(appDocumentRelativePath("/guides/setup.md")).toBe("");
    expect(appDocumentRelativePath("/s/alpha/%GG")).toBe("");
  });

  test("keep today's behavior at the default base path", () => {
    installDocument();
    expect(appDocumentRelativePath("/guides/setup.md")).toBe("guides/setup.md");
    expect(appDocumentRelativePath("/")).toBe("");
  });
});
