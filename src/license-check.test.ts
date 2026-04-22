import { describe, expect, test } from "bun:test";

import { isAllowedLicenseExpression, validateLicenseRecords } from "./license-check";

describe("validateLicenseRecords", () => {
  test("rejects copyleft licenses", () => {
    const forbidden = validateLicenseRecords([
      { name: "good", version: "1.0.0", license: "MIT" },
      { name: "bad", version: "1.0.0", license: "GPL-3.0-only" },
    ]);

    expect(forbidden.map(record => record.name)).toEqual(["bad"]);
  });

  test("allows permissive licenses", () => {
    const forbidden = validateLicenseRecords([
      { name: "mit", version: "1.0.0", license: "MIT" },
      { name: "bsd", version: "1.0.0", license: "BSD-2-Clause" },
      { name: "apache", version: "1.0.0", license: "Apache-2.0" },
    ]);

    expect(forbidden).toHaveLength(0);
  });

  test("accepts permissive alternatives in OR expressions", () => {
    expect(isAllowedLicenseExpression("(MPL-2.0 OR Apache-2.0)")).toBe(true);
  });
});
