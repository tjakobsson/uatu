// Regenerate the checked-in PWA rasters using the existing Playwright browser.
// The complete mark stays inside the maskable safe circle; the OS owns corners.
import { chromium } from "@playwright/test";
import path from "node:path";

const assets = path.resolve(import.meta.dir, "../src/assets");
const sizes = [192, 512];
const check = process.argv.includes("--check");
const source = await Bun.file(path.join(assets, "uatu-logo.svg")).text();
const existing = check ? await Promise.all(sizes.map(async size => ({ size,
  uri: `data:image/png;base64,${Buffer.from(await Bun.file(path.join(assets, `icon-${size}.png`)).arrayBuffer()).toString("base64")}`,
}))) : [];
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const icons = await page.evaluate(async ({ source, sizes, existing, check }) => {
    const image = (uri: string) => new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image(); img.onload = () => resolve(img); img.onerror = () => reject(new Error("icon source did not decode")); img.src = uri;
    });
    const logo = await image(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`);
    const original = document.createElement("canvas");
    original.width = logo.naturalWidth; original.height = logo.naturalHeight;
    const originalContext = original.getContext("2d", { willReadFrequently: true })!;
    originalContext.drawImage(logo, 0, 0);
    const pixels = originalContext.getImageData(0, 0, original.width, original.height).data;
    let radius = 0;
    for (let y = 0; y < original.height; y++) for (let x = 0; x < original.width; x++) {
      if (pixels[(y * original.width + x) * 4 + 3] === 0) continue;
      radius = Math.max(radius, Math.hypot(x + 0.5 - original.width / 2, y + 0.5 - original.height / 2));
    }
    const results: Array<{ size: number; uri: string; nonOpaque: number; outsideSafeArea: number }> = [];
    for (const size of sizes) {
      const canvas = document.createElement("canvas"); canvas.width = size; canvas.height = size;
      const context = canvas.getContext("2d", { willReadFrequently: true })!;
      if (check) context.drawImage(await image(existing.find(icon => icon.size === size)!.uri), 0, 0);
      else {
        context.fillStyle = "#ffffff"; context.fillRect(0, 0, size, size);
        // The spec guarantees a circle of radius 40%. Leave an extra 1% for
        // antialiasing so masks never clip the mark's outermost pixels.
        const scale = size * 0.39 / radius;
        const width = original.width * scale; const height = original.height * scale;
        context.drawImage(logo, (size - width) / 2, (size - height) / 2, width, height);
      }
      const data = context.getImageData(0, 0, size, size).data;
      let nonOpaque = 0; let outsideSafeArea = 0;
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const at = (y * size + x) * 4;
        if (data[at + 3] !== 255) nonOpaque++;
        const background = data[at] === 255 && data[at + 1] === 255 && data[at + 2] === 255;
        if (!background && Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) > size * 0.4) outsideSafeArea++;
      }
      results.push({ size, uri: canvas.toDataURL("image/png"), nonOpaque, outsideSafeArea });
    }
    return results;
  }, { source, sizes, existing, check });
  for (const icon of icons) {
    if (icon.nonOpaque || icon.outsideSafeArea) {
      throw new Error(`icon-${icon.size}.png: ${icon.nonOpaque} non-opaque pixels, ${icon.outsideSafeArea} non-background pixels outside the safe circle`);
    }
    if (!check) await Bun.write(path.join(assets, `icon-${icon.size}.png`), Buffer.from(icon.uri.split(",")[1]!, "base64"));
    console.log(`${check ? "checked" : "generated"} icon-${icon.size}.png: opaque white background and maskable-safe artwork`);
  }
} finally { await browser.close(); }
