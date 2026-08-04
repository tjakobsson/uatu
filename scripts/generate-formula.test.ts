import { describe, expect, test } from "bun:test";

import { parseSums } from "./generate-cask";
import { FORMULA_ASSETS, formulaClassName, generateFormula } from "./generate-formula";

const DARWIN_ARM_SHA = "a".repeat(64);
const DARWIN_X64_SHA = "b".repeat(64);
const LINUX_ARM_SHA = "c".repeat(64);
const LINUX_X64_SHA = "d".repeat(64);

const SUMS = [
  `${DARWIN_ARM_SHA}  uatu-darwin-arm64.zip`,
  `${DARWIN_X64_SHA}  uatu-darwin-x64.zip`,
  `${LINUX_ARM_SHA}  uatu-linux-arm64.tar.gz`,
  `${LINUX_X64_SHA}  uatu-linux-x64.tar.gz`,
  `${"e".repeat(64)}  UatuCode-Desktop-arm64.zip`,
].join("\n");

describe("generate-formula", () => {
  test("derives class names exactly like Homebrew's Formulary.class_s", () => {
    expect(formulaClassName("uatu")).toBe("Uatu");
    expect(formulaClassName("uatu-edge")).toBe("UatuEdge");
    // The @→AT rewrite only fires before a digit (versioned formulas);
    // that's why the edge channel is `uatu-edge`, not `uatu@edge` — brew
    // would compute the invalid constant "Uatu@edge" and fail to load it.
    expect(formulaClassName("uatu@1.1")).toBe("UatuAT11");
    expect(formulaClassName("uatu@edge")).toBe("Uatu@edge");
  });

  test("emits per-platform urls and checksums for the tagged version", () => {
    const formula = generateFormula("0.2.0", parseSums(SUMS));
    expect(formula).toContain("class Uatu < Formula");
    expect(formula).toContain('version "0.2.0"');
    for (const asset of FORMULA_ASSETS) {
      expect(formula).toContain(
        `https://github.com/tjakobsson/uatu/releases/download/v0.2.0/${asset}`,
      );
    }
    expect(formula).toContain(`sha256 "${DARWIN_ARM_SHA}"`);
    expect(formula).toContain(`sha256 "${DARWIN_X64_SHA}"`);
    expect(formula).toContain(`sha256 "${LINUX_ARM_SHA}"`);
    expect(formula).toContain(`sha256 "${LINUX_X64_SHA}"`);
    expect(formula).toContain('bin.install "uatu"');
  });

  test("stable formula declares a conflict with the edge formula", () => {
    const formula = generateFormula("0.2.0", parseSums(SUMS));
    expect(formula).toContain('conflicts_with "uatu-edge"');
  });

  test("edge options emit the uatu-edge class, edge-tag urls, and the inverse conflict", () => {
    const formula = generateFormula("0.2.0-edge.20260804031700.abc1234", parseSums(SUMS), {
      name: "uatu-edge",
      tag: "edge",
    });
    expect(formula).toContain("class UatuEdge < Formula");
    expect(formula).toContain('version "0.2.0-edge.20260804031700.abc1234"');
    for (const asset of FORMULA_ASSETS) {
      expect(formula).toContain(
        `https://github.com/tjakobsson/uatu/releases/download/edge/${asset}`,
      );
    }
    expect(formula).toContain('conflicts_with "uatu"');
    expect(formula).not.toContain('conflicts_with "uatu-edge"');
  });

  test("refuses to generate when any CLI archive is missing from the sums", () => {
    for (const missing of FORMULA_ASSETS) {
      const partial = parseSums(SUMS);
      partial.delete(missing);
      expect(() => generateFormula("0.2.0", partial)).toThrow(missing);
    }
  });
});
