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
      { name: "blue-oak", version: "1.0.0", license: "BlueOak-1.0.0" },
    ]);

    expect(forbidden).toHaveLength(0);
  });

  test("allows only Astro's unused optional libvips binaries", () => {
    expect(validateLicenseRecords([
      { name: "@img/sharp-libvips-darwin-arm64", version: "1.2.4", license: "LGPL-3.0-or-later" },
    ])).toEqual([]);
    expect(validateLicenseRecords([
      { name: "other-libvips", version: "1.2.4", license: "LGPL-3.0-or-later" },
    ])).toHaveLength(1);
  });

  test("allows only the build-time site CSS transformer under MPL", () => {
    expect(validateLicenseRecords([
      { name: "lightningcss", version: "1.33.0", license: "MPL-2.0" },
      { name: "lightningcss-darwin-arm64", version: "1.33.0", license: "MPL-2.0" },
    ])).toEqual([]);
    expect(validateLicenseRecords([
      { name: "runtime-mpl", version: "1.0.0", license: "MPL-2.0" },
    ])).toHaveLength(1);
  });

  test("carve-outs are void for packages in the production dependency graph", () => {
    const records = [
      { name: "lightningcss", version: "1.33.0", license: "MPL-2.0" },
      { name: "@img/sharp-libvips-darwin-arm64", version: "1.2.4", license: "LGPL-3.0-or-later" },
    ];
    expect(validateLicenseRecords(records, new Set(["lightningcss"])).map(record => record.name)).toEqual(["lightningcss"]);
    expect(validateLicenseRecords(records, new Set(["@img/sharp-libvips-darwin-arm64"])).map(record => record.name))
      .toEqual(["@img/sharp-libvips-darwin-arm64"]);
  });

  test("accepts permissive alternatives in OR expressions", () => {
    expect(isAllowedLicenseExpression("(MPL-2.0 OR Apache-2.0)")).toBe(true);
  });

  test("accepts SIL OFL 1.1 in all its common spellings", () => {
    expect(isAllowedLicenseExpression("OFL-1.1")).toBe(true);
    expect(isAllowedLicenseExpression("SIL OFL 1.1")).toBe(true);
    expect(isAllowedLicenseExpression("(MIT AND OFL-1.1)")).toBe(true);
  });

  test("still rejects GPL even alongside OFL", () => {
    expect(isAllowedLicenseExpression("(GPL-3.0 AND OFL-1.1)")).toBe(false);
  });
});
