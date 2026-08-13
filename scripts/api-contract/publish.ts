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
  for await (const relative of new Bun.Glob("**/*").scan({ cwd: root, onlyFiles: true })) {
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
