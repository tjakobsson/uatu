import { createHash } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

export const names = ["code-review", "pr"] as const;
export const sourceFile = "skills-source.json";
export const receiptFile = ".agents/skills/upstream.json";
export const licenseFile = ".agents/skills/LICENSE.mattpocock";
const sha = /^[a-f0-9]{40}$/;
export function parseSource(value: unknown) {
  const data = value as Record<string, unknown>;
  if (!data || Object.keys(data).sort().join() !== "ref,repository,revision" ||
      data.repository !== "mattpocock/skills" || data.ref !== "main" ||
      typeof data.revision !== "string" || !sha.test(data.revision)) throw new Error("Expected allowlisted mattpocock/skills main source with immutable SHA");
  return data as { repository: string; ref: string; revision: string };
}
export const json = async (path: string) => JSON.parse(await readFile(path, "utf8"));
export const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
export function pinnedToolVersion(manifest: any): string {
  const version = manifest?.devDependencies?.skills;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error("The skills CLI must have an exact developer-tool version");
  return version;
}
const toolVersion = async () => pinnedToolVersion(await json(resolve(import.meta.dir, "../package.json")));

// Every ancestor is checked before reading/replacing paths. Only explicitly
// validated client discovery links may be symlinks.
export async function plainPath(root: string, path: string, missing = false) {
  if (path.startsWith("/") || path.split("/").some(p => !p || p === "." || p === "..")) throw new Error(`Unsafe path: ${path}`);
  let current = root;
  for (const part of path.split("/")) {
    current = join(current, part);
    const st = await lstat(current).catch(error => {
      if (missing && error.code === "ENOENT") return undefined;
      throw error;
    });
    if (st?.isSymbolicLink()) throw new Error(`Symlink in managed path: ${path}`);
  }
}
export async function files(root: string, path: string): Promise<string[]> {
  await plainPath(root, path);
  const result: string[] = [];
  for (const entry of await readdir(join(root, path), { withFileTypes: true })) {
    const child = `${path}/${entry.name}`;
    if (entry.isDirectory()) result.push(...await files(root, child));
    else if (entry.isFile()) result.push(child);
    else throw new Error(`Non-regular managed file: ${child}`);
  }
  return result.sort();
}
export async function folderHash(root: string, path: string) {
  const paths = (await files(root, path)).sort((a, b) => a.slice(path.length + 1).localeCompare(b.slice(path.length + 1)));
  const hash = createHash("sha256");
  for (const file of paths) { hash.update(file.slice(path.length + 1)); hash.update(await readFile(join(root, file))); }
  return hash.digest("hex");
}
export function managedOutput(path: string) {
  return path === "skills-lock.json" || path === receiptFile || path === licenseFile ||
    names.some(name => path.startsWith(`.agents/skills/${name}/`) ||
      [`.claude/skills/${name}`, `.opencode/skills/${name}`].includes(path));
}
export async function checkInstallerOutputs(root: string, path = "") {
  for (const entry of await readdir(join(root, path), { withFileTypes: true })) {
    const child = path ? `${path}/${entry.name}` : entry.name;
    if (child === "home") continue; // disposable, credential-free CLI home
    if (entry.isDirectory()) {
      const allowedDirectory = [".agents", ".agents/skills", ".claude", ".claude/skills", ".opencode", ".opencode/skills"].includes(child) ||
        names.some(n => child === `.agents/skills/${n}` || child.startsWith(`.agents/skills/${n}/`));
      if (!allowedDirectory) throw new Error(`Unexpected installer output directory: ${child}`);
      await checkInstallerOutputs(root, child);
    } else if (!managedOutput(child)) throw new Error(`Unexpected installer output: ${child}`);
  }
}
export async function check(root: string) {
  for (const path of [sourceFile, "skills-lock.json", receiptFile, licenseFile]) await plainPath(root, path);
  const source = parseSource(await json(join(root, sourceFile)));
  const receipt = await json(join(root, receiptFile));
  const lock = await json(join(root, "skills-lock.json"));
  if (receipt.revision !== source.revision || receipt.cli !== await toolVersion()) throw new Error("Stale generated skill revision/tool receipt; run skills:update");
  if (lock.version !== 1 || Object.keys(lock.skills).sort().join() !== names.join()) throw new Error("Unexpected project skill lock");
  const inventory: Record<string, string> = {};
  for (const name of names) {
    const path = `.agents/skills/${name}`;
    const entries = await files(root, path);
    for (const required of ["SKILL.md", "agents/openai.yaml", ...(name === "pr" ? ["CREDITS.md"] : [])]) {
      if (!entries.includes(`${path}/${required}`)) throw new Error(`Missing companion: ${path}/${required}`);
    }
    const expected = { source: source.repository, ref: source.revision, sourceType: "github", skillPath: `skills/engineering/${name}/SKILL.md`, computedHash: await folderHash(root, path) };
    if (JSON.stringify(lock.skills[name]) !== JSON.stringify(expected)) throw new Error(`Stale/content-mismatched lock: ${name}`);
    for (const file of entries) inventory[file] = digest(await readFile(join(root, file)));
    for (const client of [".claude", ".opencode"]) {
      await plainPath(root, `${client}/skills`);
      const link = `${client}/skills/${name}`;
      if (!(await lstat(join(root, link))).isSymbolicLink() || await readlink(join(root, link)) !== `../../.agents/skills/${name}`) throw new Error(`Invalid client link: ${link}`);
    }
  }
  inventory[licenseFile] = digest(await readFile(join(root, licenseFile)));
  if (JSON.stringify(inventory) !== JSON.stringify(receipt.files)) throw new Error("Managed file inventory differs from generated receipt");
  return source;
}

export async function update(root: string, revisionSource = join(root, sourceFile)) {
  const source = parseSource(await json(revisionSource));
  const cli = resolve(import.meta.dir, "../node_modules/skills/bin/cli.mjs");
  const version = await toolVersion();
  if ((await json(resolve(import.meta.dir, "../node_modules/skills/package.json"))).version !== version) throw new Error(`Requires pinned skills CLI ${version}`);
  const scratchRoot = process.env.SKILLS_SCRATCH || join(process.env.HOME!, ".cache/opencode/scratch/uatu-workflow-skills");
  await mkdir(scratchRoot, { recursive: true });
  const scratch = await mkdtemp(join(scratchRoot, "install-"));
  try {
    const home = join(scratch, "home");
    await mkdir(home);
    const env = { PATH: process.env.PATH!, HOME: home, TMPDIR: scratch, CI: "1", NODE_DISABLE_COMPILE_CACHE: "1", DISABLE_TELEMETRY: "1", DO_NOT_TRACK: "1", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" };
    const run = spawnSync(process.execPath, [cli, "add", `https://github.com/${source.repository}/tree/${source.revision}`, "--skill", ...names, "--agent", "claude-code", "opencode", "-y"], { cwd: scratch, env, stdio: "inherit" });
    if (run.status !== 0) throw new Error(`Pinned installer failed: ${run.status}`);
    await checkInstallerOutputs(scratch);
    const response = await fetch(`https://raw.githubusercontent.com/${source.repository}/${source.revision}/LICENSE`, { redirect: "error" });
    if (!response.ok) throw new Error(`License fetch failed: ${response.status}`);
    await writeFile(join(scratch, licenseFile), await response.text());
    const inventory: Record<string, string> = {};
    for (const name of names) {
      for (const path of await files(scratch, `.agents/skills/${name}`)) inventory[path] = digest(await readFile(join(scratch, path)));
      await mkdir(join(scratch, ".opencode/skills"), { recursive: true });
      await symlink(`../../.agents/skills/${name}`, join(scratch, `.opencode/skills/${name}`));
    }
    inventory[licenseFile] = digest(await readFile(join(scratch, licenseFile)));
    await writeFile(join(scratch, sourceFile), JSON.stringify(source));
    await writeFile(join(scratch, receiptFile), JSON.stringify({ revision: source.revision, cli: version, files: inventory }, null, 2) + "\n");
    await check(scratch);
    await materialize(root, scratch);
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
export async function materialize(root: string, scratch: string) {
  await check(scratch);
  const outputs = ["skills-lock.json", receiptFile, licenseFile, ...names.map(n => `.agents/skills/${n}`), ...names.flatMap(n => [`.claude/skills/${n}`, `.opencode/skills/${n}`])];
  // Complete preflight before writes. OpenSpec paths are never enumerated or
  // replaced; existing client skill directories remain intact.
  for (const path of outputs) {
    if (dirname(path) !== ".") await plainPath(root, dirname(path), true);
    if (!path.startsWith(".claude/") && !path.startsWith(".opencode/")) await plainPath(root, path, true);
    else {
      const st = await lstat(join(root, path)).catch(e => { if (e.code !== "ENOENT") throw e; });
      if (st && (!st.isSymbolicLink() || await readlink(join(root, path)) !== `../../.agents/skills/${path.split("/").at(-1)}`)) throw new Error(`Unexpected existing client path: ${path}`);
    }
  }
  for (const path of outputs) {
    await mkdir(join(root, dirname(path)), { recursive: true });
    await rm(join(root, path), { recursive: true, force: true });
    if (path.startsWith(".claude/") || path.startsWith(".opencode/")) await symlink(await readlink(join(scratch, path)), join(root, path));
    else await cp(join(scratch, path), join(root, path), { recursive: true });
  }
}
if (import.meta.main) {
  const [command, root = process.cwd(), source] = process.argv.slice(2);
  if (command === "check") { await check(resolve(root)); console.log("Skills, companions, links, revision and project lock are consistent."); }
  else if (command === "update") await update(resolve(root), source);
  else throw new Error("Usage: bun scripts/skills.ts check|update [root] [source-json]");
}
