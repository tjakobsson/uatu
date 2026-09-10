/** Preserve explicitly selected, synthetic test captures before another test run
 * clears its output directory. No user attachment or arbitrary file traversal. */
const destination = "openspec/changes/restore-refined-mobile-hub-experience/review-evidence/ios-ux";
const selections = [
  ["folder-before.png", "evidence/ios-ux-red-final-1/ios-ux.e2e.ts-RED-folder-b-a2ce5-not-per-folder-action-cards/A02-folder-cards.png"],
  ["folder-after.png", "evidence/ios-ux-smoke-current/ios-ux.e2e.ts-RED-folder-b-a2ce5-not-per-folder-action-cards/A02-folder-cards.png"],
  ["readiness-before.png", "evidence/ios-ux-red-final-1/ios-ux.e2e.ts-RED-credenti-38df2-and-progressive-diagnostics/S04-flat-readiness.png"],
] as const;
const records = [];
for (const [name, source] of selections) {
  const bytes = await Bun.file(new URL(source, import.meta.url)).arrayBuffer();
  await Bun.write(`${destination}/${name}`, bytes);
  records.push({ name, source: `tests/mobile-hub-review/${source}`, sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex") });
}
await Bun.write(`${destination}/captures.json`, JSON.stringify({ capturedBy: "Playwright Chromium, synthetic backend", viewport: { width: 390, height: 664 }, screenshotScale: "device (3 output pixels per CSS pixel)", approval: "not approved; user authorized review publication with verification incomplete", note: "Only folder has a fresh before/after pair. The latest readiness browser case failed during page creation; no fresh after image is claimed.", records }, null, 2));
console.info(JSON.stringify(records, null, 2));
