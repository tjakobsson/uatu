/** Fixed synthetic browser captures only; never reads user attachments. */
const root = new URL("./results/artifacts/settings-refinement", import.meta.url).pathname;
const files = [
  ["credential-current.png", "evidence/purpose-led-settings-results/purpose-led-settings.e2e.t-cd086-tics-behind-Troubleshooting/credential-current.png"],
  ["tools-current.png", "evidence/purpose-led-settings-results/purpose-led-settings.e2e.t-a04dd-overy-cancel-save-ownership/tools-current.png"],
] as const;
const records = [];
for (const [name, source] of files) {
  const bytes = await Bun.file(new URL(source, import.meta.url)).arrayBuffer();
  await Bun.write(`${root}/${name}`, bytes);
  records.push({ name, source: `tests/mobile-hub-review/${source}`, sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex") });
}
await Bun.write(`${root}/captures.json`, JSON.stringify({ version: "5f6115996f54", backend: "synthetic", viewport: { width: 390, height: 664 }, screenshotScale: "device, 3 output pixels per CSS pixel", browser: "installed Playwright Chromium", approval: "awaiting user review; not approved goldens", records }, null, 2));
console.info(JSON.stringify(records, null, 2));
