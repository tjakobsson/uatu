import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const execFileAsync = promisify(execFile);
const sourceArtifacts = [
  "api/openapi.yaml",
  "api/streaming.yaml",
  "api/agent.md",
  "api/CHANGELOG.md",
  "api/contract.schema.json",
  "api/operations.yaml",
  "api/exclusions.yaml",
] as const;

async function sourceCommit(): Promise<string> {
  const configured = process.env.GITHUB_SHA?.trim();
  if (configured) return configured;
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root });
  return stdout.trim();
}

export async function assembleEdgeArtifacts(outputPath: string): Promise<void> {
  const edge = join(outputPath, "api", "edge");
  await mkdir(edge, { recursive: true });
  const hashes: Record<string, string> = {};
  const commit = await sourceCommit();

  for (const sourcePath of sourceArtifacts) {
    const content = await readFile(join(root, sourcePath));
    const name = basename(sourcePath);
    await writeFile(join(edge, name), content);
    hashes[name] = createHash("sha256").update(content).digest("hex");
  }

  const sourceMetadata = JSON.parse(await readFile(join(root, "api", "contract.json"), "utf8")) as Record<string, unknown>;
  const metadata = {
    ...sourceMetadata,
    sourceCommit: commit,
    publishedAt: new Date().toISOString(),
    artifacts: {
      openapi: "openapi.yaml",
      streaming: "streaming.yaml",
      inventory: "operations.yaml",
      exclusions: "exclusions.yaml",
      changelog: "CHANGELOG.md",
    },
  };
  const metadataContent = `${JSON.stringify(metadata, null, 2)}\n`;
  await writeFile(join(edge, "contract.json"), metadataContent);
  hashes["contract.json"] = createHash("sha256").update(metadataContent).digest("hex");
  await writeFile(join(edge, "SHA256SUMS.json"), `${JSON.stringify({ sourceCommit: commit, files: hashes }, null, 2)}\n`);

  await writeFile(join(outputPath, "llms.txt"), await readFile(join(root, "llms.txt")));
  const font = await readFile(join(root, "src", "assets", "fonts", "HackNerdFontMono-Regular.woff2"));
  await mkdir(join(outputPath, "fonts"), { recursive: true });
  await writeFile(join(outputPath, "fonts", "HackNerdFontMono-Regular.woff2"), font);
}

if (import.meta.main) {
  const output = process.argv[2];
  if (!output) throw new Error("Usage: bun scripts/assemble-api-site.ts <output-directory>");
  await assembleEdgeArtifacts(resolve(output));
}
