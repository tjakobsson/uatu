import { describe, expect, test } from "bun:test";

import { CASK_ASSETS, generateCask, parseSums } from "./generate-cask";

const ARM_SHA = "a".repeat(64);
const X64_SHA = "b".repeat(64);

const SUMS = [
  `${ARM_SHA}  UatuCode-Desktop-arm64.zip`,
  `${X64_SHA}  UatuCode-Desktop-x64.zip`,
  `${"c".repeat(64)}  uatu-darwin-arm64.zip`,
].join("\n");

describe("generate-cask", () => {
  test("parses sha256sum output including asterisk-prefixed (binary mode) names", () => {
    const sums = parseSums(`${ARM_SHA} *UatuCode-Desktop-arm64.zip\n`);
    expect(sums.get("UatuCode-Desktop-arm64.zip")).toBe(ARM_SHA);
  });

  test("emits per-architecture urls and checksums for the tagged version", () => {
    const cask = generateCask("0.2.0", parseSums(SUMS));
    expect(cask).toContain('cask "uatu-desktop" do');
    expect(cask).toContain('version "0.2.0"');
    expect(cask).toContain(
      "https://github.com/tjakobsson/uatu/releases/download/v0.2.0/UatuCode-Desktop-arm64.zip",
    );
    expect(cask).toContain(
      "https://github.com/tjakobsson/uatu/releases/download/v0.2.0/UatuCode-Desktop-x64.zip",
    );
    expect(cask).toContain(`sha256 "${ARM_SHA}"`);
    expect(cask).toContain(`sha256 "${X64_SHA}"`);
    expect(cask).toContain('app "UatuCode Desktop.app"');
    // Symbol form is required: the string comparison form (">= :tahoe") is
    // deprecated and breaks loading of third-party taps entirely
    // (https://github.com/Homebrew/brew/issues/22600). The bare symbol
    // already means "this version or newer".
    expect(cask).toContain("depends_on macos: :tahoe");
    expect(cask).not.toContain('">=');
  });

  test("stable cask declares a conflict with the edge cask", () => {
    const cask = generateCask("0.2.0", parseSums(SUMS));
    expect(cask).toContain('conflicts_with cask: "uatu-desktop@edge"');
  });

  test("edge options emit the @edge token, edge-tag urls, and the inverse conflict", () => {
    const cask = generateCask("0.2.0-edge.20260718.abc1234", parseSums(SUMS), {
      name: "uatu-desktop@edge",
      tag: "edge",
    });
    expect(cask).toContain('cask "uatu-desktop@edge" do');
    expect(cask).toContain('version "0.2.0-edge.20260718.abc1234"');
    expect(cask).toContain(
      "https://github.com/tjakobsson/uatu/releases/download/edge/UatuCode-Desktop-arm64.zip",
    );
    expect(cask).toContain(
      "https://github.com/tjakobsson/uatu/releases/download/edge/UatuCode-Desktop-x64.zip",
    );
    expect(cask).toContain('conflicts_with cask: "uatu-desktop"');
    expect(cask).not.toContain('conflicts_with cask: "uatu-desktop@edge"');
  });

  test("refuses to generate from an unsigned release's sums", () => {
    for (const missing of CASK_ASSETS) {
      const partial = parseSums(SUMS);
      partial.delete(missing);
      expect(() => generateCask("0.2.0", partial)).toThrow(missing);
    }
  });
});
