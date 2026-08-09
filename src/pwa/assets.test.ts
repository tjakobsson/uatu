// Verifies the PWA assets cli.ts serves: manifest and icons. Reads them
// off disk (the same files cli.ts mounts via Bun.file imports) rather than
// spinning up a server — the routing wrapper just emits raw Bun.file bodies
// with fixed headers, so the bytes that reach the browser ARE the file
// contents. There is deliberately no service worker: installability no
// longer requires one, and uatu has nothing useful to do offline.

import { describe, expect, it } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";

const ASSETS_DIR = path.join(__dirname, "..", "assets");

describe("manifest.webmanifest", () => {
  it("exists and parses as JSON with the required PWA fields", async () => {
    const source = await fs.readFile(path.join(ASSETS_DIR, "manifest.webmanifest"), "utf8");
    const parsed = JSON.parse(source) as Record<string, unknown>;
    expect(typeof parsed.name).toBe("string");
    expect(typeof parsed.short_name).toBe("string");
    expect(parsed.start_url).toBe("/");
    expect(parsed.display).toBe("standalone");
    expect(typeof parsed.theme_color).toBe("string");
    expect(typeof parsed.background_color).toBe("string");
  });

  it("declares both 192x192 and 512x512 PNG icons", async () => {
    const source = await fs.readFile(path.join(ASSETS_DIR, "manifest.webmanifest"), "utf8");
    const parsed = JSON.parse(source) as { icons: Array<{ sizes?: string; type?: string }> };
    expect(Array.isArray(parsed.icons)).toBe(true);
    const sizes = parsed.icons.map(icon => icon.sizes);
    expect(sizes).toContain("192x192");
    expect(sizes).toContain("512x512");
    for (const icon of parsed.icons) {
      expect(icon.type).toBe("image/png");
    }
  });
});

describe("service worker absence", () => {
  it("ships no sw.js asset", async () => {
    // The pass-through worker existed only for an outdated Chromium install
    // heuristic; its absence is now the specified behavior (pwa-install:
    // "installability does not depend on a service worker").
    await expect(fs.access(path.join(ASSETS_DIR, "sw.js"))).rejects.toThrow();
  });
});

describe("icons", () => {
  // PNG signature: 0x89 P N G \r \n 0x1a \n. Then an IHDR chunk whose data
  // begins with width (u32 BE) and height (u32 BE). Reading those four bytes
  // each is enough to verify the file is a real PNG of the expected size.
  async function readPngSize(file: string): Promise<{ width: number; height: number }> {
    const buf = await fs.readFile(file);
    expect(buf.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    // After the 8-byte signature: 4 bytes chunk length, 4 bytes chunk type
    // ("IHDR"), then 4 bytes width and 4 bytes height.
    expect(buf.subarray(12, 16).toString("ascii")).toBe("IHDR");
    return {
      width: buf.readUInt32BE(16),
      height: buf.readUInt32BE(20),
    };
  }

  it("icon-192.png is 192x192", async () => {
    const size = await readPngSize(path.join(ASSETS_DIR, "icon-192.png"));
    expect(size).toEqual({ width: 192, height: 192 });
  });

  it("icon-512.png is 512x512", async () => {
    const size = await readPngSize(path.join(ASSETS_DIR, "icon-512.png"));
    expect(size).toEqual({ width: 512, height: 512 });
  });
});
