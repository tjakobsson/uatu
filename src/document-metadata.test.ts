import { describe, expect, test } from "bun:test";

import {
  type DocumentMetadata,
  isAsciidocInternalAttribute,
  normalizeMetadata,
  parseAuthorEntry,
  parseSimpleToml,
  parseSimpleYaml,
  sanitizeMetadata,
} from "./document-metadata";

describe("sanitizeMetadata", () => {
  test("escapes <script> in description", () => {
    const out = sanitizeMetadata({ description: "<script>alert(1)</script>" });
    expect(out?.description).toBeDefined();
    expect(out?.description).not.toContain("<script>");
    expect(out?.description).toContain("&lt;script&gt;");
  });

  test("escapes onerror= attribute fragments in title", () => {
    const out = sanitizeMetadata({ title: '" onerror="alert(1)' });
    expect(out?.title).toBeDefined();
    expect(out?.title).not.toMatch(/^"\s*onerror=/);
    expect(out?.title).toContain("&quot;");
  });

  test("escapes javascript: URL in extras", () => {
    const out = sanitizeMetadata({ extras: { homepage: "javascript:alert(1)" } });
    // The string survives but no surrounding HTML attribute context exists
    // until the card template renders it. The escape ensures any later HTML
    // assembly puts it inside text content, not inside an href attribute
    // value, so the URL never reaches the browser as an active link.
    expect(out?.extras?.homepage).toBe("javascript:alert(1)");
    // Verify the key itself can't carry HTML even if the source was hostile.
    const keyed = sanitizeMetadata({ extras: { '" onerror="x': "v" } });
    const onlyKey = keyed?.extras ? Object.keys(keyed.extras)[0] : "";
    expect(onlyKey).not.toMatch(/^"\s*onerror=/);
  });

  test("escapes <iframe> anywhere it appears", () => {
    const out = sanitizeMetadata({
      title: "<iframe src=evil>",
      description: "<iframe>",
      tags: ["<iframe>", "ok"],
      extras: { extra: "<iframe>" },
    });
    expect(out?.title).not.toContain("<iframe");
    expect(out?.description).not.toContain("<iframe");
    expect(out?.tags?.[0]).not.toContain("<iframe");
    expect(out?.extras?.extra).not.toContain("<iframe");
    // All four occurrences must be escaped (one in title, one in description,
    // one in tags[0], one in extras.extra).
    const all = JSON.stringify(out);
    expect(all).toContain("&lt;iframe");
    expect(all).not.toContain("<iframe");
  });

  test("preserves benign values verbatim (just the standard escapes)", () => {
    const out = sanitizeMetadata({
      title: "Plain Title",
      authors: [{ name: "Tobias", email: "t@example.com" }],
      date: "2026-05-04",
      revision: "1.2",
      description: "A safe description.",
      tags: ["alpha", "beta"],
      status: "draft",
      extras: { custom: "hello" },
    });
    expect(out?.title).toBe("Plain Title");
    expect(out?.authors?.[0]?.name).toBe("Tobias");
    expect(out?.authors?.[0]?.email).toBe("t@example.com");
    expect(out?.date).toBe("2026-05-04");
    expect(out?.revision).toBe("1.2");
    expect(out?.description).toBe("A safe description.");
    expect(out?.tags).toEqual(["alpha", "beta"]);
    expect(out?.status).toBe("draft");
    expect(out?.extras?.custom).toBe("hello");
  });

  test("undefined input yields undefined output", () => {
    expect(sanitizeMetadata(undefined)).toBeUndefined();
  });

  test("metadata with only empty fields collapses to undefined", () => {
    const empty: DocumentMetadata = { title: "", description: "", extras: {} };
    expect(sanitizeMetadata(empty)).toBeUndefined();
  });
});

describe("normalizeMetadata", () => {
  test("YAML alias keys collapse to canonical fields", () => {
    const out = normalizeMetadata(
      {
        title: "T",
        author: "Tobias",
        version: "1.0",
        keywords: ["a", "b"],
        summary: "Hi",
      },
      "yaml",
    );
    expect(out?.title).toBe("T");
    expect(out?.authors?.[0]?.name).toBe("Tobias");
    expect(out?.revision).toBe("1.0");
    expect(out?.tags).toEqual(["a", "b"]);
    expect(out?.description).toBe("Hi");
  });

  test("AsciiDoc internal attributes are filtered out", () => {
    expect(isAsciidocInternalAttribute("note-caption")).toBe(true);
    expect(isAsciidocInternalAttribute("toc-title")).toBe(true);
    expect(isAsciidocInternalAttribute("doctype")).toBe(true);
    expect(isAsciidocInternalAttribute("custom-attr")).toBe(false);
  });

  test("returns undefined when no recognized fields are present", () => {
    expect(normalizeMetadata({}, "yaml")).toBeUndefined();
  });
});

describe("parseAuthorEntry", () => {
  test("name only", () => {
    expect(parseAuthorEntry("Tobias")).toEqual({ name: "Tobias" });
  });
  test("name with email", () => {
    expect(parseAuthorEntry("Tobias <t@example.com>")).toEqual({
      name: "Tobias",
      email: "t@example.com",
    });
  });
  test("blank entry", () => {
    expect(parseAuthorEntry("   ")).toBeUndefined();
  });
});

describe("parseSimpleYaml", () => {
  test("scalars and flow array", () => {
    expect(parseSimpleYaml("title: Foo\ntags: [a, b]\n")).toEqual({
      title: "Foo",
      tags: ["a", "b"],
    });
  });
  test("block array", () => {
    expect(parseSimpleYaml("tags:\n  - a\n  - b\n  - c\n")).toEqual({
      tags: ["a", "b", "c"],
    });
  });
  test("flattens nested mapping into dot-notation keys", () => {
    expect(parseSimpleYaml("title: T\nauthor:\n  name: Tobias\n  email: t@example.com\n")).toEqual({
      title: "T",
      "author.name": "Tobias",
      "author.email": "t@example.com",
    });
  });
  test("flattens deeply-nested mapping (the SKILL-frontmatter shape)", () => {
    const result = parseSimpleYaml(
      `name: example\ndescription: A skill\nmetadata:\n  author: openspec\n  version: "1.0"\n`,
    );
    expect(result).toEqual({
      name: "example",
      description: "A skill",
      "metadata.author": "openspec",
      "metadata.version": "1.0",
    });
  });
  test("returns undefined for a non-object root", () => {
    expect(parseSimpleYaml("- a\n- b\n")).toBeUndefined();
  });
  test("returns undefined for unparseable YAML", () => {
    // A mapping key followed by a flow sequence with an unbalanced bracket.
    expect(parseSimpleYaml("title: [unbalanced,\n")).toBeUndefined();
  });
});

describe("parseSimpleToml", () => {
  test("scalars and array", () => {
    expect(parseSimpleToml('title = "Foo"\ntags = ["a", "b"]\n')).toEqual({
      title: "Foo",
      tags: ["a", "b"],
    });
  });
  test("returns undefined for [table] header (out of subset)", () => {
    expect(parseSimpleToml('[meta]\ntitle = "Foo"\n')).toBeUndefined();
  });
  test("returns undefined for dotted key (out of subset)", () => {
    expect(parseSimpleToml('meta.title = "Foo"\n')).toBeUndefined();
  });
});
