import type { ApprovedAsset, ReviewAssets } from "./server";
import { frontendFingerprint } from "./hosting-identity";

export const designSystemPrefix = "/review/design-system/";
/** Separate build, explicit output map, no request-derived filesystem reads. */
export async function buildDesignSystemAssets(): Promise<ReviewAssets> {
  const result = await Bun.build({ entrypoints: [new URL("./design-system.html", import.meta.url).pathname], target: "browser", publicPath: designSystemPrefix, minify: false, sourcemap: "none" });
  if (!result.success) throw new AggregateError(result.logs, "Design system reference build failed");
  const assets = new Map<string, ApprovedAsset>();
  for (const output of result.outputs) {
    const name = output.path.split("/").at(-1)!;
    if (!/^[a-zA-Z0-9._-]+\.(html|js|css|woff2)$/.test(name)) throw new Error("Unexpected reference build output");
    const route = designSystemPrefix + name;
    if (assets.has(route)) throw new Error("Colliding reference output");
    assets.set(route, { body: output, type: output.type });
  }
  if (!assets.has(designSystemPrefix + "design-system.html")) throw new Error("Missing reference document");
  assets.set(designSystemPrefix + "guide", { body: await Bun.file(new URL("../../design/hub-mobile/design-system.md", import.meta.url)).text(), type: "text/plain; charset=utf-8" });
  // Hash only the completed reference build, before adding its own manifest.
  assets.set(designSystemPrefix + "manifest.json", { body: JSON.stringify({ kind: "reference-content-sha256", fingerprint: await frontendFingerprint(assets) }), type: "application/json" });
  return assets;
}
