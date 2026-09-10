import type { ReviewAssets } from "./server";

/** Content identity, not a claim about Git revision or cleanliness. */
export async function frontendFingerprint(assets: ReviewAssets): Promise<string> {
  const hash = new Bun.CryptoHasher("sha256");
  for (const [path, asset] of [...assets].sort(([a], [b]) => a.localeCompare(b))) {
    const bytes = typeof asset.body === "string" ? new TextEncoder().encode(asset.body) : new Uint8Array(await asset.body.arrayBuffer());
    hash.update(JSON.stringify([path, asset.type, bytes.byteLength]));
    hash.update(bytes);
  }
  return `sha256:${hash.digest("hex")}`;
}
