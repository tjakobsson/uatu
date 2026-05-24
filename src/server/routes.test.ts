import { describe, expect, test } from "bun:test";
import path from "node:path";

import { buildRoutes } from "./routes";

// Minimal stub: the asset routes never touch the session, so a thrown
// getter is fine — it makes accidental coupling fail loudly.
const stubSession = () => {
  throw new Error("session should not be touched by asset routes");
};

function buildFontTestRoutes() {
  const repoRoot = path.resolve(import.meta.dir, "..", "..");
  return buildRoutes({
    mode: "prod",
    assets: {
      mermaid: path.join(repoRoot, "node_modules/mermaid/dist/mermaid.min.js"),
      logo: path.join(repoRoot, "src/assets/uatu-logo.svg"),
      icon192: path.join(repoRoot, "src/assets/icon-192.png"),
      icon512: path.join(repoRoot, "src/assets/icon-512.png"),
      manifest: path.join(repoRoot, "src/assets/manifest.webmanifest"),
      sw: path.join(repoRoot, "src/assets/sw.js"),
      fonts: {
        hackMono: path.join(repoRoot, "src/assets/fonts/HackNerdFontMono-Regular.woff2"),
        hackLicense: path.join(repoRoot, "src/assets/fonts/LICENSE-hack.md"),
        nerdFontsLicense: path.join(repoRoot, "src/assets/fonts/LICENSE-nerdfonts.txt"),
        notices: path.join(repoRoot, "src/assets/fonts/NOTICES.md"),
      },
    },
    getSession: stubSession as never,
    debug: false,
    getMetricsSnapshot: () => ({}),
  });
}

describe("buildRoutes — bundled font asset routes", () => {
  test("serves the Hack WOFF2 with the right content-type and an immutable cache", async () => {
    const routes = buildFontTestRoutes();
    const response = routes["/assets/fonts/HackNerdFontMono-Regular.woff2"] as Response;

    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("font/woff2");
    const cacheControl = response.headers.get("cache-control") ?? "";
    expect(cacheControl).toContain("immutable");
    expect(cacheControl).toContain("max-age=31536000");

    const body = new Uint8Array(await response.arrayBuffer());
    expect(body.byteLength).toBeGreaterThan(0);
    // WOFF2 files start with the "wOF2" signature (0x77 0x4F 0x46 0x32).
    expect(body[0]).toBe(0x77);
    expect(body[1]).toBe(0x4f);
    expect(body[2]).toBe(0x46);
    expect(body[3]).toBe(0x32);
  });

  test("serves the bundled license texts as plain readable responses", async () => {
    const routes = buildFontTestRoutes();
    const hack = routes["/assets/fonts/LICENSE-hack.md"] as Response;
    const nerdfonts = routes["/assets/fonts/LICENSE-nerdfonts.txt"] as Response;
    const notices = routes["/assets/fonts/NOTICES.md"] as Response;

    expect(hack.headers.get("content-type")).toContain("text/markdown");
    expect(nerdfonts.headers.get("content-type")).toContain("text/plain");
    expect(notices.headers.get("content-type")).toContain("text/markdown");

    const hackBody = await hack.text();
    expect(hackBody).toContain("MIT License");

    const nerdBody = await nerdfonts.text();
    expect(nerdBody).toContain("MIT License");

    const noticesBody = await notices.text();
    expect(noticesBody).toContain("Hack Nerd Font Mono");
  });
});

describe("bundled font asset on disk", () => {
  test("HackNerdFontMono-Regular.woff2 is present and within the 1.5 MB budget", async () => {
    const repoRoot = path.resolve(import.meta.dir, "..", "..");
    const file = Bun.file(path.join(repoRoot, "src/assets/fonts/HackNerdFontMono-Regular.woff2"));

    expect(await file.exists()).toBe(true);
    expect(file.size).toBeGreaterThan(0);
    expect(file.size).toBeLessThanOrEqual(1.5 * 1024 * 1024);
  });
});
