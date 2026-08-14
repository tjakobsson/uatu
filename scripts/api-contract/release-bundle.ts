import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const RAW_FILES = [
  "openapi.yaml",
  "streaming.yaml",
  "contract.json",
  "contract.schema.json",
  "CHANGELOG.md",
  "agent.md",
  "operations.yaml",
  "exclusions.yaml",
] as const;

export async function sha256(file: string): Promise<string> {
  return new Bun.CryptoHasher("sha256").update(await Bun.file(file).arrayBuffer()).digest("hex");
}

export async function createReleaseBundle(source: string, output: string, commit: string, publishedAt: string, productVersion: string): Promise<void> {
  if (!/^[0-9a-f]{40}$/i.test(commit)) throw new Error("source commit must be a full 40-character Git commit SHA");
  await mkdir(output, { recursive: true });
  for (const file of RAW_FILES) {
    await cp(path.join(source, file), path.join(output, file));
  }
  const metadataPath = path.join(output, "contract.json");
  const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as Record<string, unknown>;
  metadata.sourceCommit = commit.toLowerCase();
  metadata.publishedAt = publishedAt;
  metadata.productVersion = productVersion;
  metadata.stability = "stable";
  metadata.artifacts = {
    openapi: "openapi.yaml",
    streaming: "streaming.yaml",
    inventory: "operations.yaml",
    exclusions: "exclusions.yaml",
    changelog: "CHANGELOG.md",
  };
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
  const hashes: Record<string, string> = {};
  for (const file of RAW_FILES) hashes[file] = await sha256(path.join(output, file));
  await writeFile(path.join(output, "SHA256SUMS.json"), `${JSON.stringify({ sourceCommit: commit.toLowerCase(), files: hashes }, null, 2)}\n`);
}

if (import.meta.main) {
  const [source, output, commit, publishedAt, productVersion] = process.argv.slice(2);
  if (!source || !output || !commit || !publishedAt || !productVersion) throw new Error("usage: release-bundle.ts SOURCE OUTPUT COMMIT PUBLISHED_AT PRODUCT_VERSION");
  await createReleaseBundle(source, output, commit, publishedAt, productVersion);
}
