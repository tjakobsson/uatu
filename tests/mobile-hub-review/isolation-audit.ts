import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export const evidence = new URL("../../openspec/changes/restore-refined-mobile-hub-experience/review-evidence/isolation/", import.meta.url);
export const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export const buildIdentity = { version: "review", branch: "synthetic", commitSha: "0000000", commitShort: "0000000", buildTime: "2026-07-02T00:00:00Z", release: false };

/** Observe only Bun's runtime graph: type-only imports are deliberately absent. */
export async function auditBundle(entry: string) {
  const modules = new Set<string>();
  const result = await Bun.build({ entrypoints: [resolve(entry)], target: "browser", minify: false, sourcemap: "external",
    define: { __UATU_BUILD__: JSON.stringify(buildIdentity) },
  });
  assert(result.success, result.logs.map(String).join("\n"));
  for (const output of result.outputs) if (output.path.endsWith(".map")) {
    const map = JSON.parse(await output.text());
    for (const source of map.sources) modules.add(source.replace(/^(?:\.\.\/|\.\/)+/, ""));
  }
  if (entry.endsWith(".css")) modules.add(entry);
  assert(modules.size > 0, `${entry}: Source-map runtime inventory unexpectedly empty: ${result.outputs.map(o => o.path).join(", ")}`);
  const forbiddenModule = /((^|\/)tests\/|\/fixtures?\/|hub\/(server|main|backend|credential-(manager|tools|ssh-supervisor)|clone-process)\.ts$|src\/(cli\.ts|server\/|terminal\/(server|pty)\.ts|chat\/(claude|opencode)\/.*(runtime|server)))/;
  const forbidden = [...modules].filter(path => forbiddenModule.test(path));
  assert.deepEqual(forbidden, [], "Privileged/test runtime entered frontend graph");
  const artifacts = [];
  for (const output of result.outputs) {
    const text = /javascript|html|css/.test(output.type) ? await output.text() : "";
    for (const marker of ["createSyntheticBackend", "Synthetic review document", "Synthetic terminal — no shell is running", "__mobileHubReview", "/review/backend/", "controllerScript", "LocalProcessBackend", "startHubServer", "Bun.spawn(", "Bun.serve("]) {
      assert(!text.includes(marker), `${entry}: forbidden output marker ${marker}`);
    }
    artifacts.push({ path: output.path, bytes: output.size, sha256: sha(new Uint8Array(await output.arrayBuffer())) });
  }
  return { entry, modules: [...modules].sort(), artifacts, forbidden };
}

if (import.meta.main) {
  const inventory = Bun.spawnSync(["bun", "openspec/changes/restore-refined-mobile-hub-experience/review-evidence/baseline.ts", "capture"], { stdout: "pipe", stderr: "pipe" });
  assert.equal(inventory.exitCode, 0, inventory.stderr.toString());
  const current = JSON.parse(inventory.stdout.toString());
  const baseline = JSON.parse(await readFile(new URL("../baseline.json", evidence), "utf8"));
  assert.deepEqual(current.groups.references, baseline.groups.references, "Retained reference signatures changed");
  assert.deepEqual(current.groups.retainedArchive, baseline.groups.retainedArchive, "Retained archive signatures changed");
  const bundles = [];
  for (const entry of ["src/index.html", "src/hub/mobile/coordinator.ts", "src/hub/mobile/styles.css", "src/hub/mobile/coordinator.css"]) bundles.push(await auditBundle(entry));
  const signatures = [];
  for (const path of ["src/hub/pages.ts", "src/hub/mobile-presentation.ts", "src/hub/navigation-preferences-client.ts", "src/hub/return-navigation.ts", "src/styles.css", "src/index.html", "src/assets/fonts/HackNerdFontMono-Regular.woff2", ...[...new Bun.Glob("tests/e2e/hub-mobile-baselines/desktop-*.png").scanSync(".")], "design/hub-mobile/screenshots-refined/main-original-interior.png", "design/hub-mobile/screenshots-refined/main-refined-interior.png"]) {
    const bytes = await readFile(path); signatures.push({ path, bytes: bytes.length, sha256: sha(bytes) });
  }
  await writeFile(new URL("bundle-audit.json", evidence), JSON.stringify({ bun: Bun.version, bundles, signatures, retainedGroups: { references: current.groups.references, retainedArchive: current.groups.retainedArchive }, repositoryAggregateUnchanged: current.groups.approvedRepositoryEvidence.sha256 === baseline.groups.approvedRepositoryEvidence.sha256, baselineLimitation: "baseline.json stores an aggregate repository digest, not individual file hashes or captured source bytes; current signatures cannot prove equality to its dirty-tree pages.ts. HEAD predates that dirty baseline." }, null, 2) + "\n");
  console.info("PASS: original production entry and reusable frontend runtime graphs are isolated; signatures recorded (not blessed).");
}
