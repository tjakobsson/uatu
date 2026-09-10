/** Derive inspectable evidence summaries; no approval thresholds/golden updates. */
const root = `${import.meta.dir}/corrected`;
let html = '<!doctype html><meta charset="utf-8"><title>Corrected mobile Hub chrome review</title><style>body{font:16px system-ui;margin:24px;background:#eee}img{max-width:100%;height:auto}section{margin:40px 0}a{margin-right:16px}h2{margin-bottom:8px}.versions{display:flex;gap:12px;flex-wrap:wrap}.versions img{width:390px}</style><h1>Corrected chrome — awaiting user review, not approved goldens</h1><p>Left: retained reference normalized to 390×844. Right: actual synthetic frontend. No masks. Differences in branding, fixture text and current workspace interiors are not failures. Right-side adaptations compare to the retained state rather than silently mirroring originals. Read README.md for findings. <a href="../index.html">Initial discovery gallery (retained)</a></p>';
let md = '| Browser | State | Mean absolute RGB error /255 | Pixels with any channel delta >16 |\n|---|---|---:|---:|\n';
const selected: Record<string, unknown> = {};
for (const browser of ['chromium', 'webkit']) {
  const data = await Bun.file(`${root}/${browser}-measurements.json`).json();
  selected[browser] = {};
  for (const [state, value] of Object.entries(data) as Array<[string, any]>) {
    if (value.extension) {
      html += `<section><h2>${browser}: ${state} — unpictured extension</h2><img src="${browser}-${state}-actual.png"></section>`;
      continue;
    }
    if (!value.comparison) continue;
    md += `| ${browser} | ${state} | ${value.comparison.meanAbsoluteChannelError.toFixed(2)} | ${value.comparison.pixelsOver16Percent.toFixed(2)}% |\n`;
    html += `<section><h2>${browser}: ${state}</h2><p><a href="${browser}-${state}-actual.png">Actual</a><a href="${browser}-${state}-overlay.png">50% overlay</a><a href="${browser}-${state}-diff.png">Absolute RGB diff</a></p><img src="${browser}-${state}-side.png"></section>`;
    if (await Bun.file(`${root}/../${browser}-${state}-actual.png`).exists()) html += `<details><summary>Retained initial actual / corrected actual</summary><div class="versions"><img src="../${browser}-${state}-actual.png" alt="Before"><img src="${browser}-${state}-actual.png" alt="After"></div></details>`;
    (selected[browser] as any)[state] = Object.fromEntries(Object.entries(value.metrics).filter(([selector, rows]) => (rows as any[]).length && ['.mh-root h1','.mh-group','.mh-workspace','.mh-dock','.mh-return','.mh-identity','.mh-sheet','.mh-sheet header','.mh-field','.mh-sheet footer','#touch-tab-bar','#navigation-handle','#preview-file-navigation'].includes(selector)));
  }
}
await Bun.write(`${root}/index.html`, html);
await Bun.write(`${root}/diff-summary.md`, md);
await Bun.write(`${root}/geometry-summary.json`, JSON.stringify(selected, null, 2));
console.info(md);
