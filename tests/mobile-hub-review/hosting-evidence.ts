import { lstat, realpath } from "node:fs/promises";
import type { ReviewAssets, ApprovedAsset } from "./server";

// Explicit selection, never directory enumeration or request-derived file reads.
export const evidenceSelection: readonly string[] = Object.freeze([
  "visual/corrected/index.html", "visual/corrected/README.md", "visual/corrected/diff-summary.md",
  "visual/corrected/chromium-measurements.json", "visual/corrected/webkit-measurements.json",
  ...["chromium", "webkit"].flatMap(engine => ["hub", "settings", "preview-expanded", "preview-collapsed", "files-collapsed", "chat-expanded", "chat-collapsed", "terminal-expanded", "terminal-collapsed"].map(scene => `visual/corrected/${engine}-${scene}-actual.png`)),
  "responsive/README.md", "responsive/results.json", "responsive/scenarios.md",
  "motion/README.md", "motion/default-placement.md", "motion/chromium-geometry.json", "motion/webkit-geometry.json",
  "isolation/README.md", "isolation/bundle-audit.json", "isolation/interior-results.json", "isolation/desktop-results.json",
]);

/** May be absent during preparation; only these future names can be published. */
export const optionalEvidenceSelection = Object.freeze([
  "handoff.md", "scenario-guide.md", "acceptance.md",
  "ios-hig-research.md", "ios-ux-correction.md", "ios-ux/captures.json",
  "ios-ux/folder-before.png", "ios-ux/folder-after.png", "ios-ux/readiness-before.png",
  "settings-refinement.md", "settings-refinement/captures.json",
  "settings-refinement/credential-current.png", "settings-refinement/tools-current.png",
  "page-based-settings.md", "direct-settings/README.md", "direct-settings/current/report.json",
  "direct-settings/current/chromium-credential-actions.png", "direct-settings/current/chromium-delete-confirmation.png",
  "direct-settings/current/chromium-unlock-fullpage.png", "direct-settings/current/chromium-preferences-fullpage.png",
  "readability-guidance.md", "readability-update.md", "readability/final/REVIEW.md", "readability/final/capture-report.json",
  "design-system.md",
  "folder-picker/verification.md", "folder-picker/browser-results.json",
  ...["chromium", "webkit"].flatMap(engine => ["normal", "empty", "error", ...[320, 390, 844].flatMap(width => [`${width}-normal`, `${width}-scrolled`])].map(scene => `folder-picker/${engine}-${scene}.png`)),
  "preview-refinement/verification.md", "preview-refinement/browser-results.json", "preview-refinement/boundary-results.json",
  ...["chromium", "webkit"].flatMap(engine => [
    ...[320, 390, 844].map(width => `preview-refinement/${engine}-configure-${width}.png`),
    `preview-refinement/${engine}-no-subfolders.png`,
    ...["normal", "empty", "error", ...[320, 390, 844].flatMap(width => [`${width}-normal`, `${width}-scrolled`])].map(scene => `preview-refinement/folder-picker/${engine}-${scene}.png`),
    ...["guide-image", "asciidoc-image", "asciidoc-source", "nested-files-tree", "mermaid-viewer", "asciidoc-mermaid", "notes-direct-reload", "notes-linked-runbook"].map(scene => `preview-refinement/previews/${engine}-preview-examples-${scene}.png`),
  ]),
  ...["01-settings-fresh", "02-credential-purpose", "03-workspace-assignment-summary", "04-edit-first-entry", "05-review-changes", "06-clone-start-and-empty-host"].map(scene => `readability/final/${scene}.png`),
  "visual/review-ready/index.html", "visual/review-ready/README.md",
  "visual/review-ready/chromium-measurements.json", "visual/review-ready/webkit-measurements.json",
  ...["chromium", "webkit"].flatMap(engine => ["hub", "settings", "preview-expanded", "preview-collapsed", "files-collapsed", "chat-expanded", "chat-collapsed", "terminal-expanded", "terminal-collapsed"].map(scene => `visual/review-ready/${engine}-${scene}-actual.png`)),
]);

export async function buildEvidenceAssets(): Promise<ReviewAssets> {
  const root = await realpath(new URL("../../openspec/changes/restore-refined-mobile-hub-experience/review-evidence/", import.meta.url));
  const assets = new Map<string, ApprovedAsset>();
  const manifest = [];
  const selected: string[] = [...evidenceSelection];
  for (const name of optionalEvidenceSelection) {
    try { await lstat(`${root}/${name}`); selected.push(name); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  for (const name of selected) {
    const path = `${root}/${name}`;
    if (!(await lstat(path)).isFile() || await realpath(path) !== path) throw new Error(`Evidence must be a regular non-symlink file: ${name}`);
    const bytes = await Bun.file(path).arrayBuffer();
    const type = name.endsWith(".png") ? "image/png" : "text/plain; charset=utf-8";
    assets.set(`/review/evidence/${name}`, { body: new Blob([bytes], { type }), type });
    manifest.push({ path: name, bytes: bytes.byteLength, sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex") });
  }
  assets.set("/review/evidence/manifest.json", { body: JSON.stringify({ schema: 1, selection: "task8.1-static-selection-v2", builtAt: new Date().toISOString(), files: manifest }, null, 2), type: "application/json" });
  const body = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Synthetic review evidence</title><h1>Synthetic review evidence</h1><p>Simulation only — mock backend; do not enter real credentials. Browser emulation is not physical phone validation. Awaiting user review; not approved goldens. Reports are inert text. Only selected actual screenshots are published, not retained baselines.</p><p><a href="/">Product viewport (no review controls)</a> · <a href="/review/controller">Separate controller</a> · <a href="/review/evidence/manifest.json">Snapshot hashes</a></p><ul>${evidenceSelection.map(name => `<li><a href="/review/evidence/${name}">${name}</a></li>`).join("")}</ul>`;
  const gallery = `<h2>Versioned screenshots and review records</h2><p>Read <a href="/review/evidence/preview-refinement/verification.md">preview-refinement/verification.md</a> for the latest preview examples, buttons and empty states, and design-system.md for the shared-system context. <a href="/review/design-system">Open the interactive reference</a>. Earlier capture sets are historical; no image set is approved.</p>${selected.filter(name => !evidenceSelection.includes(name)).map(name => `<p><a href="/review/evidence/${name}">${name}</a></p>`).join("")}<div>${selected.filter(name => name.endsWith(".png")).map(name => `<figure><a href="/review/evidence/${name}"><img loading="lazy" style="max-width:100%;width:390px;height:auto" src="/review/evidence/${name}" alt="${name}"></a><figcaption>${name}</figcaption></figure>`).join("")}</div>`;
  for (const path of ["/review/evidence", "/review/evidence/"]) assets.set(path, { body: body + gallery, type: "text/html; charset=utf-8" });
  return assets;
}
