import { describe, expect, test } from "bun:test";

import { type Advisory, classify, hasPatchedRelease, parseAuditOutput } from "./audit-dependencies";

function advisory(severity: string, vulnerable_versions: string): Advisory {
  return { id: 1, url: "https://github.com/advisories/GHSA-test", title: "test", severity, vulnerable_versions };
}

describe("audit-dependencies", () => {
  test("a range covering every release has no patched release", () => {
    expect(hasPatchedRelease("<=3.0.3", ["3.0.0", "3.0.1", "3.0.2", "3.0.3"])).toBe(false);
  });

  test("a release past the vulnerable range is a patched release", () => {
    expect(hasPatchedRelease("<=3.0.3", ["3.0.2", "3.0.3", "3.0.4"])).toBe(true);
  });

  test("releases from before the bug existed don't count as a fix", () => {
    expect(hasPatchedRelease(">=2.0.0", ["1.9.0", "2.0.0", "2.1.0"])).toBe(false);
  });

  test("a fix on either line of a split range counts", () => {
    expect(hasPatchedRelease("<1.2.3 || >=2.0.0 <2.0.5", ["1.2.2", "2.0.4", "2.0.5"])).toBe(true);
  });

  test("a prerelease alone isn't a patched release", () => {
    expect(hasPatchedRelease("<=4.2.0", ["4.1.0", "4.2.0", "4.2.1-beta.1"])).toBe(false);
  });

  test("a patched moderate-or-higher advisory blocks, an unpatched one warns", () => {
    expect(classify(advisory("high", "<=3.0.3"), ["3.0.3", "3.0.4"])).toBe("fixable");
    expect(classify(advisory("moderate", "<=3.0.3"), ["3.0.3"])).toBe("unpatched");
    expect(classify(advisory("critical", "<=3.0.3"), ["3.0.3"])).toBe("unpatched");
  });

  test("a low advisory never blocks, patched or not", () => {
    expect(classify(advisory("low", "<=3.0.3"), ["3.0.3", "3.0.4"])).toBe("low");
  });

  test("a clean audit is an empty report", () => {
    expect(parseAuditOutput("{}\n", 0)).toEqual({});
  });

  test("an audit with advisories returns them despite its nonzero exit", () => {
    const stdout = JSON.stringify({ braces: [advisory("high", "<=3.0.3")] });
    expect(parseAuditOutput(stdout, 1)).toEqual({ braces: [advisory("high", "<=3.0.3")] });
  });

  test("a failed advisory request is an error, not a clean report", () => {
    expect(typeof parseAuditOutput("", 1)).toBe("string");
    expect(typeof parseAuditOutput("", 0)).toBe("string");
    expect(typeof parseAuditOutput("{}", 1)).toBe("string");
  });

  test("output that isn't a report is an error", () => {
    expect(typeof parseAuditOutput("audit request failed", 1)).toBe("string");
    expect(typeof parseAuditOutput("[]", 0)).toBe("string");
    expect(typeof parseAuditOutput('{"braces": "nope"}', 1)).toBe("string");
  });
});
