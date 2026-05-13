import { describe, expect, test } from "bun:test";

import { allConfiguredLanguages, languageForName } from "./file-languages";

describe("languageForName", () => {
  test("maps common source extensions to Shiki BundledLanguage identifiers", () => {
    expect(languageForName("a.ts")).toBe("typescript");
    expect(languageForName("a.tsx")).toBe("tsx");
    expect(languageForName("a.js")).toBe("javascript");
    expect(languageForName("a.py")).toBe("python");
    expect(languageForName("a.rs")).toBe("rust");
    expect(languageForName("a.go")).toBe("go");
  });

  test("maps config/markup extensions", () => {
    expect(languageForName("a.yml")).toBe("yaml");
    expect(languageForName("a.yaml")).toBe("yaml");
    expect(languageForName("a.json")).toBe("json");
    expect(languageForName("a.jsonc")).toBe("jsonc");
    expect(languageForName("a.toml")).toBe("toml");
    expect(languageForName("a.md")).toBe("markdown");
    expect(languageForName("a.mdx")).toBe("mdx");
    expect(languageForName("a.adoc")).toBe("asciidoc");
  });

  test("maps known filenames case-insensitively", () => {
    expect(languageForName("Dockerfile")).toBe("dockerfile");
    expect(languageForName("Makefile")).toBe("makefile");
    expect(languageForName("Rakefile")).toBe("ruby");
    expect(languageForName("Gemfile")).toBe("ruby");
  });

  test("returns undefined for unmapped extensions", () => {
    expect(languageForName("a.unknown")).toBeUndefined();
    expect(languageForName("a.zzz")).toBeUndefined();
  });

  test("returns undefined for names with no dot and no filename match", () => {
    expect(languageForName("README")).toBeUndefined();
    expect(languageForName("LICENSE")).toBeUndefined();
  });

  test("treats leading-dot names like LICENSE without extension", () => {
    expect(languageForName(".gitignore")).toBeUndefined();
  });
});

describe("allConfiguredLanguages", () => {
  test("includes every language referenced by extension or filename maps", () => {
    const langs = new Set(allConfiguredLanguages());
    expect(langs.has("typescript")).toBe(true);
    expect(langs.has("javascript")).toBe(true);
    expect(langs.has("python")).toBe(true);
    expect(langs.has("yaml")).toBe(true);
    expect(langs.has("json")).toBe(true);
    expect(langs.has("markdown")).toBe(true);
    expect(langs.has("asciidoc")).toBe(true);
    expect(langs.has("dockerfile")).toBe(true);
    expect(langs.has("makefile")).toBe(true);
  });

  test("includes mermaid so listing-block leaks degrade to readable code", () => {
    const langs = new Set(allConfiguredLanguages());
    expect(langs.has("mermaid")).toBe(true);
  });

  test("returns each language only once", () => {
    const langs = allConfiguredLanguages();
    expect(new Set(langs).size).toBe(langs.length);
  });
});
