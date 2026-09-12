import { lstat, realpath } from "node:fs/promises";
import { escapeHtml } from "../../src/shared/html";
import type { ReviewAssets, ApprovedAsset } from "./server";
import { galleryImages, galleryViewport } from "./compact-gallery";

/** Fixed publication set. Raw outputs and historical directories are never served. */
export const evidenceSelection: readonly string[] = Object.freeze([
  "README.md", "verification.md", ...galleryImages.map(image => image.path),
]);

export async function buildEvidenceAssets(): Promise<ReviewAssets> {
  const root = await realpath(new URL("../../openspec/changes/restore-refined-mobile-hub-experience/review-evidence/", import.meta.url));
  const assets = new Map<string, ApprovedAsset>();
  const files = [];
  for (const name of evidenceSelection) {
    const path = `${root}/${name}`;
    if (!(await lstat(path)).isFile() || await realpath(path) !== path) throw new Error(`Evidence must be a regular non-symlink file: ${name}`);
    const bytes = await Bun.file(path).arrayBuffer();
    const type = name.endsWith(".png") ? "image/png" : "text/plain; charset=utf-8";
    assets.set(`/review/evidence/${name}`, { body: new Blob([bytes], { type }), type });
    files.push({ path: name, bytes: bytes.byteLength, sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex") });
  }
  assets.set("/review/evidence/manifest.json", {
    body: JSON.stringify({ schema: 1, selection: "compact-current-review-v1", builtAt: new Date().toISOString(), viewport: galleryViewport, files }, null, 2),
    type: "application/json",
  });
  const gallery = galleryImages.map(image => `<figure><a href="/review/evidence/${image.path}"><img loading="lazy" src="/review/evidence/${image.path}" alt="${escapeHtml(`${image.engine}: ${image.label}`)}"></a><figcaption>${escapeHtml(`${image.engine}: ${image.label}`)}</figcaption></figure>`).join("");
  const body = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Current synthetic UI review</title>
<style>body{font:16px system-ui;margin:24px}main{display:flex;flex-wrap:wrap;gap:24px}figure{margin:0;max-width:100%}img{width:390px;max-width:100%;height:auto}figcaption{max-width:390px;padding:8px 0}</style>
<h1>Current synthetic UI review</h1><p>Simulation only — mock backend; do not enter real credentials. These 20 illustrations are not approved goldens. Browser emulation is not physical phone validation. Awaiting user visual and interaction review.</p>
<p><a href="/">Product viewport</a> · <a href="/review/controller">Separate controller</a> · <a href="/review/design-system">Interactive design system</a></p>
<p><a href="/review/evidence/README.md">Review guide</a> · <a href="/review/evidence/verification.md">Verification and known issues</a> · <a href="/review/evidence/manifest.json">Snapshot hashes</a></p>
<p>Routine screenshots and raw reports stay in ignored local output. Historical artifacts are available through Git; no arbitrary directory or report path is published.</p><main>${gallery}</main>`;
  for (const path of ["/review/evidence", "/review/evidence/"]) assets.set(path, { body, type: "text/html; charset=utf-8" });
  return assets;
}
