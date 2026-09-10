import { chromium } from "@playwright/test";

// Complement the unmasked reference comparisons with a current-interior
// before/after check. These are retained current captures, not prototype crops.
// The upper 650px contains no expanded navigation chrome; the full screenshots
// remain available and are never masked/replaced in the gallery.
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const records: Record<string, unknown> = {};
  for (const engine of ["chromium", "webkit"]) for (const state of ["preview-expanded", "terminal-expanded"]) {
    const initial = Buffer.from(await Bun.file(`${import.meta.dir}/${engine}-${state}-actual.png`).arrayBuffer()).toString("base64");
    const corrected = Buffer.from(await Bun.file(`${import.meta.dir}/corrected/${engine}-${state}-actual.png`).arrayBuffer()).toString("base64");
    records[`${engine}-${state}`] = await page.evaluate(async ({ initial, corrected }) => {
      const decode = (data: string) => new Promise<HTMLImageElement>(resolve => { const image = new Image(); image.onload = () => resolve(image); image.src = `data:image/png;base64,${data}`; });
      const images = await Promise.all([decode(initial), decode(corrected)]);
      const pixels = images.map(image => { const canvas = document.createElement("canvas"); canvas.width = 390; canvas.height = 650; const ctx = canvas.getContext("2d")!; ctx.drawImage(image, 0, 0); return ctx.getImageData(0, 0, 390, 650).data; });
      let sum = 0, changed = 0;
      for (let i = 0; i < pixels[0]!.length; i += 4) { let max = 0; for (let c = 0; c < 3; c++) { const delta = Math.abs(pixels[0]![i+c]! - pixels[1]![i+c]!); sum += delta; max = Math.max(max, delta); } if (max > 16) changed++; }
      return { region: { x: 0, y: 0, width: 390, height: 650 }, pixelsOver16: changed, pixelsOver16Percent: changed / (390 * 650) * 100, meanAbsoluteRgbError: sum / (390 * 650 * 3) };
    }, { initial, corrected });
  }
  await Bun.write(`${import.meta.dir}/corrected/current-interior-comparison.json`, JSON.stringify(records, null, 2) + "\n");
  console.info(JSON.stringify(records, null, 2));
} finally { await browser.close(); }
