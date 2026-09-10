import { chromium } from "@playwright/test";

const root = import.meta.dir;
type Metric = { x: number; y: number; width: number; height: number; size: string; weight: string; background: string; blur: string };
type Capture = { metrics?: Record<string, Metric[]>; extension?: boolean; comparison?: { reference: string; meanAbsoluteChannelError: number; pixelsOver16Percent: number } };
let html = '<!doctype html><meta charset="utf-8"><title>Mobile Hub review-ready comparisons — awaiting approval</title><style>body{font:16px system-ui;margin:24px;background:#f2f1f7;color:#17171c}img{max-width:100%;height:auto}section{margin:40px 0}a{margin-right:14px}.versions{display:flex;flex-wrap:wrap;gap:12px}.versions img{width:390px}summary{cursor:pointer}</style><h1>Review-ready capture — manual approval awaiting</h1><p>50 reference comparisons, six unpictured accessibility captures. Original normalized image on the left; current synthetic frontend on the right. No masks or approved-golden update. See <a href="README.md">findings and exceptions</a><a href="../index.html">initial discovery</a><a href="../corrected/index.html">corrected iteration</a>.</p>';
let diff = '| Engine | State | Reference | Mean absolute RGB error /255 | Pixels over16 |\n|---|---|---|---:|---:|\n';
const summary: Record<string, unknown> = {};
for (const engine of ["chromium", "webkit"]) {
  const records = await Bun.file(`${root}/${engine}-measurements.json`).json() as Record<string, Capture>;
  const selected: Record<string, unknown> = {};
  let comparisons = 0, extensions = 0;
  for (const [state, entry] of Object.entries(records)) {
    if (entry.extension) { extensions++; html += `<section><h2>${engine}: ${state} — unpictured extension</h2><img src="${engine}-${state}-actual.png" alt="${state}"></section>`; continue; }
    if (!entry.comparison || !entry.metrics) continue;
    comparisons++;
    const c = entry.comparison;
    diff += `| ${engine} | ${state} | ${c.reference} | ${c.meanAbsoluteChannelError.toFixed(2)} | ${c.pixelsOver16Percent.toFixed(2)}% |\n`;
    html += `<section><h2>${engine}: ${state}</h2><p>Reference ${c.reference}. <a href="${engine}-${state}-actual.png">Actual</a><a href="${engine}-${state}-overlay.png">50% overlay</a><a href="${engine}-${state}-diff.png">Full RGB difference</a></p><img src="${engine}-${state}-side.png" alt="Reference left, actual right">`;
    if (await Bun.file(`${root}/../corrected/${engine}-${state}-actual.png`).exists()) html += `<details><summary>Previous corrected / review-ready actual</summary><div class="versions"><img src="../corrected/${engine}-${state}-actual.png" alt="Previous corrected"><img src="${engine}-${state}-actual.png" alt="Review-ready actual"></div></details>`;
    html += '</section>';
    const keys = state === "hub" ? [".mh-group", ".mh-root h1", ".mh-dock"] : state === "settings" ? [".mh-group", ".mh-identity", ".mh-value"] : state === "preview-side-sheet" ? [".mh-sheet", ".mh-field", ".mh-side-field > select"] : state === "terminal-collapsed" ? ["#navigation-handle", "#navigation-handle span"] : state === "preview-expanded" || state === "terminal-expanded" ? ["#touch-tab-bar", ".touch-tab", ".preview-nav-pill"] : [];
    if (keys.length) selected[state] = Object.fromEntries(keys.map(key => [key, entry.metrics![key]]));
  }
  summary[engine] = { comparisons, extensions, measured: selected, errors: records.errors, checks: records.regressionChecks, accessibility: records.accessibilityChecks, provenance: records.provenance };
}
html += '<section><h2>Exploratory failure evidence (not the final successful capture)</h2><p>An intermittent post-Return Terminal pointer interception was observed while adapting the runner. The final capture reports no interaction deviation in either engine, but this earlier observation remains disclosed for focused interaction review.</p><img src="chromium-return-terminal-pointer-blocked-actual.png" alt="Exploratory post-Return frame"></section>';
await Bun.write(`${root}/index.html`, html);
await Bun.write(`${root}/diff-summary.md`, diff);
await Bun.write(`${root}/summary.json`, JSON.stringify(summary, null, 2) + "\n");

// Independent current-interior comparison; full reference comparisons above
// remain unmasked. Never replace the current interior with historical artwork.
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const interior: Record<string, unknown> = {};
  for (const engine of ["chromium", "webkit"]) for (const state of ["preview-expanded", "terminal-expanded"]) {
    const sources = await Promise.all([`${root}/../${engine}-${state}-actual.png`, `${root}/${engine}-${state}-actual.png`].map(async path => Buffer.from(await Bun.file(path).arrayBuffer()).toString("base64")));
    interior[`${engine}-${state}`] = await page.evaluate(async sources => {
      const images = await Promise.all(sources.map(data => new Promise<HTMLImageElement>(resolve => { const image = new Image(); image.onload = () => resolve(image); image.src = `data:image/png;base64,${data}`; })));
      const pixels = images.map(image => { const canvas = document.createElement("canvas"); canvas.width = 390; canvas.height = 650; const ctx = canvas.getContext("2d")!; ctx.drawImage(image, 0, 0); return ctx.getImageData(0, 0, 390, 650).data; });
      let changed = 0, sum = 0;
      for (let i = 0; i < pixels[0]!.length; i += 4) { let max = 0; for (let c = 0; c < 3; c++) { const delta = Math.abs(pixels[0]![i+c]! - pixels[1]![i+c]!); max = Math.max(max, delta); sum += delta; } if (max > 16) changed++; }
      return { region: { x: 0, y: 0, width: 390, height: 650 }, pixelsOver16: changed, meanAbsoluteRgbError: sum / (390 * 650 * 3) };
    }, sources);
  }
  await Bun.write(`${root}/current-interior-comparison.json`, JSON.stringify(interior, null, 2) + "\n");
  console.info(JSON.stringify({ summary, interior }, null, 2));
} finally { await browser.close(); }
console.info(diff);
