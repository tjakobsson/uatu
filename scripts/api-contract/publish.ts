import { cp, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { revisions, type ApiDomain } from "./compatibility";
import { sha256 } from "./release-bundle";

async function exists(target: string): Promise<boolean> {
  return stat(target).then(() => true, () => false);
}

async function treeHashes(root: string): Promise<Record<string, string>> {
  if (!await exists(root)) return {};
  const result: Record<string, string> = {};
  // dot: true — without it Glob skips dotfiles, leaving the immutability
  // guards blind to dotfile payloads smuggled into latest/revisions.
  for await (const relative of new Bun.Glob("**/*").scan({ cwd: root, onlyFiles: true, dot: true })) {
    result[relative] = await sha256(path.join(root, relative));
  }
  return result;
}

function equalHashes(a: Record<string, string>, b: Record<string, string>): boolean {
  return JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
}

async function copyIfPresent(source: string, destination: string): Promise<void> {
  if (await exists(source)) await cp(source, destination, { recursive: true });
}

type Semver = { core: [number, number, number]; prerelease: (string | number)[] | null };

function parseSemver(version: unknown): Semver | undefined {
  if (typeof version !== "string") return undefined;
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version);
  if (!match) return undefined;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] === undefined
      ? null
      : match[4].split(".").map(identifier => (/^\d+$/.test(identifier) ? Number(identifier) : identifier)),
  };
}

// Full SemVer precedence: numeric identifiers compare numerically and sort
// below alphanumeric ones, a stable version sorts after its prereleases, and
// a longer prerelease list wins over its own prefix. Dropping the prerelease
// suffix would make 1.0.0-beta.1 equal to 1.0.0 and let a rerun of the
// prerelease publication roll latest backward.
function compareSemver(a: Semver, b: Semver): number {
  for (let index = 0; index < 3; index++) {
    if (a.core[index] !== b.core[index]) return a.core[index]! < b.core[index]! ? -1 : 1;
  }
  if (a.prerelease === null && b.prerelease === null) return 0;
  if (a.prerelease === null) return 1;
  if (b.prerelease === null) return -1;
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index++) {
    const left = a.prerelease[index];
    const right = b.prerelease[index];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    if (left === right) continue;
    if (typeof left === "number" && typeof right === "number") return left < right ? -1 : 1;
    if (typeof left === "number") return -1;
    if (typeof right === "number") return 1;
    return left < right ? -1 : 1;
  }
  return 0;
}

async function verifyBundleChecksums(bundle: string): Promise<void> {
  const sumsPath = path.join(bundle, "SHA256SUMS.json");
  if (!await exists(sumsPath)) throw new Error("release bundle is missing SHA256SUMS.json");
  const sums = JSON.parse(await readFile(sumsPath, "utf8")) as { files?: Record<string, string> };
  const files = Object.entries(sums.files ?? {});
  if (files.length === 0) throw new Error("release bundle SHA256SUMS.json lists no files");
  for (const [file, expected] of files) {
    const target = path.join(bundle, file);
    if (!await exists(target)) throw new Error(`release bundle file ${file} listed in SHA256SUMS.json is missing`);
    const actual = await sha256(target);
    if (actual !== expected) {
      throw new Error(`release bundle file ${file} does not match SHA256SUMS.json (expected ${expected}, computed ${actual})`);
    }
  }
}

function revisionId(values: Record<ApiDomain, number>, productVersion: unknown): string {
  if (typeof productVersion !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(productVersion)) {
    throw new Error("release metadata must contain a valid productVersion");
  }
  return `hub-${values.hub}_workspace-${values.workspace}_v${productVersion}`;
}

export type PublishOptions = {
  mode: "edge" | "release";
  site: string;
  history: string;
  output: string;
  bundle?: string;
  commit: string;
};

export async function publish(options: PublishOptions): Promise<void> {
  if (!/^[0-9a-f]{40}$/i.test(options.commit)) throw new Error("validated commit must be a full 40-character Git commit SHA");
  if (options.mode === "release") {
    if (!options.bundle) throw new Error("release publication requires a validated bundle");
    // The downloaded bundle is not trusted at face value: recompute every
    // hash SHA256SUMS.json claims before any of its bytes are copied.
    await verifyBundleChecksums(options.bundle);
  }
  const priorLatest = await treeHashes(path.join(options.history, "api", "latest"));
  const priorRevisions = await treeHashes(path.join(options.history, "api", "revisions"));
  await rm(options.output, { recursive: true, force: true });
  await cp(options.site, options.output, { recursive: true });
  await mkdir(path.join(options.output, "api"), { recursive: true });
  await copyIfPresent(path.join(options.history, "api", "latest"), path.join(options.output, "api", "latest"));
  await copyIfPresent(path.join(options.history, "api", "revisions"), path.join(options.output, "api", "revisions"));

  if (options.mode === "edge") {
    const metadata = JSON.parse(await readFile(path.join(options.output, "api", "edge", "contract.json"), "utf8")) as { sourceCommit?: string };
    if (metadata.sourceCommit?.toLowerCase() !== options.commit.toLowerCase()) {
      throw new Error(`edge metadata sourceCommit ${metadata.sourceCommit ?? "<missing>"} does not match validated commit ${options.commit}`);
    }
    if (!equalHashes(priorLatest, await treeHashes(path.join(options.output, "api", "latest")))) {
      throw new Error("edge publication attempted to modify api/latest");
    }
    if (!equalHashes(priorRevisions, await treeHashes(path.join(options.output, "api", "revisions")))) {
      throw new Error("edge publication attempted to modify api/revisions history");
    }
    return;
  }

  if (!options.bundle) throw new Error("release publication requires a validated bundle");
  const metadata = JSON.parse(await readFile(path.join(options.bundle, "contract.json"), "utf8")) as Record<string, unknown>;
  if (String(metadata.sourceCommit).toLowerCase() !== options.commit.toLowerCase()) {
    throw new Error(`release bundle sourceCommit ${String(metadata.sourceCommit)} does not match validated commit ${options.commit}`);
  }
  const id = revisionId(revisions(metadata), metadata.productVersion);
  const revisionsRoot = path.join(options.output, "api", "revisions");
  const destination = path.join(revisionsRoot, id);
  await mkdir(revisionsRoot, { recursive: true });
  if (await exists(destination)) {
    const existing = await treeHashes(destination);
    const incoming = await treeHashes(options.bundle);
    if (!equalHashes(existing, incoming)) throw new Error(`immutable revision ${id} already exists with different bytes`);
  } else {
    const temporary = path.join(revisionsRoot, `.${id}.${crypto.randomUUID()}`);
    await cp(options.bundle, temporary, { recursive: true });
    await rename(temporary, destination);
  }
  const latest = path.join(options.output, "api", "latest");
  // Rerunning an old release's publication must never point latest backward
  // past a newer release that already published.
  const latestMetadataPath = path.join(latest, "contract.json");
  if (await exists(latestMetadataPath)) {
    let existingVersion: unknown;
    try {
      existingVersion = (JSON.parse(await readFile(latestMetadataPath, "utf8")) as Record<string, unknown>).productVersion;
    } catch {
      existingVersion = undefined;
    }
    const existing = parseSemver(existingVersion);
    const incoming = parseSemver(metadata.productVersion);
    if (existing === undefined) {
      console.warn("warning: existing api/latest metadata has no parseable productVersion; replacing it");
    } else if (incoming !== undefined && compareSemver(incoming, existing) < 0) {
      throw new Error(`refusing to roll api/latest back from ${String(existingVersion)} to ${String(metadata.productVersion)}`);
    }
  }
  const temporaryLatest = path.join(options.output, "api", `.latest.${crypto.randomUUID()}`);
  await cp(options.bundle, temporaryLatest, { recursive: true });
  await rm(latest, { recursive: true, force: true });
  await rename(temporaryLatest, latest);
  const oldRevisionHashes = Object.fromEntries(Object.entries(priorRevisions).filter(([name]) => !name.startsWith(`${id}/`)));
  const newRevisionHashes = Object.fromEntries(Object.entries(await treeHashes(revisionsRoot)).filter(([name]) => !name.startsWith(`${id}/`)));
  if (!equalHashes(oldRevisionHashes, newRevisionHashes)) throw new Error("release publication modified prior revision history");
}

if (import.meta.main) {
  const args = Object.fromEntries(process.argv.slice(2).map(argument => {
    const [key, ...value] = argument.replace(/^--/, "").split("=");
    return [key, value.join("=")];
  }));
  if (!args.mode || !args.site || !args.history || !args.output || !args.commit) {
    throw new Error("usage: publish.ts --mode=edge|release --site=DIR --history=DIR --output=DIR --commit=SHA [--bundle=DIR]");
  }
  await publish({
    mode: args.mode as "edge" | "release",
    site: args.site,
    history: args.history,
    output: args.output,
    commit: args.commit,
    bundle: args.bundle || undefined,
  });
}
