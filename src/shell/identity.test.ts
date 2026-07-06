import { describe, expect, it } from "bun:test";

import type { RootGroup } from "../shared/types";
import { faviconSvg, identityColor, identityHue, pageTitle, projectLabel } from "./identity";

function root(label: string, path: string): RootGroup {
  return { id: path, label, path, docs: [], hiddenCount: 0 };
}

describe("projectLabel", () => {
  it("uses the single root's label", () => {
    expect(projectLabel([root("my-project", "/home/me/my-project")])).toBe("my-project");
  });

  it("uses the first label plus a count for multi-root sessions", () => {
    const roots = [root("docs", "/a/docs"), root("api", "/a/api"), root("web", "/a/web")];
    expect(projectLabel(roots)).toBe("docs +2");
  });

  it("returns null for no roots", () => {
    expect(projectLabel([])).toBeNull();
  });
});

describe("identityHue", () => {
  it("is stable for the same paths", () => {
    const roots = [root("docs", "/a/docs"), root("api", "/a/api")];
    expect(identityHue(roots)).toBe(identityHue(roots));
  });

  it("is independent of root order", () => {
    const forward = [root("docs", "/a/docs"), root("api", "/a/api")];
    const reversed = [root("api", "/a/api"), root("docs", "/a/docs")];
    expect(identityHue(forward)).toBe(identityHue(reversed));
  });

  it("derives from paths, not labels", () => {
    // Two projects both named "docs" in different locations must differ.
    const a = identityHue([root("docs", "/a/docs")]);
    const b = identityHue([root("docs", "/b/docs")]);
    expect(a).not.toBe(b);
  });

  it("stays within the hue circle", () => {
    const hue = identityHue([root("x", "/some/very/long/path/x")]);
    expect(hue).toBeGreaterThanOrEqual(0);
    expect(hue).toBeLessThan(360);
  });
});

describe("pageTitle", () => {
  it("prefixes the label", () => {
    expect(pageTitle("my-project")).toBe("my-project — uatu");
  });

  it("falls back to plain uatu without a label", () => {
    expect(pageTitle(null)).toBe("uatu");
  });
});

describe("faviconSvg", () => {
  it("contains the identity hue and the label's first character", () => {
    const svg = faviconSvg("my-project", 137);
    expect(svg).toContain(identityColor(137));
    expect(svg).toContain(">m</text>");
  });

  it("escapes XML-significant initials", () => {
    const svg = faviconSvg("<weird>", 0);
    expect(svg).toContain("&lt;");
    expect(svg).not.toContain("><</text>");
  });
});
