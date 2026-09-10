// Offline, read-only evidence inventory. Run from the repository root with Bun.
// All output goes to stdout; capture/verify never writes or repairs a file.
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";

const evidence = "openspec/changes/restore-refined-mobile-hub-experience/review-evidence/";
const reference = "design/hub-mobile/";
const archive = "openspec/changes/archive/2026-09-09-refine-mobile-hub-navigation/";
function git(...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
  if (result.exitCode) throw new Error(`git ${args[0]} failed`);
  return result.stdout.toString();
}
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
// Only repository source/document/test evidence, never arbitrary untracked trees,
// secrets, .local contents, symlinks, dependencies, or host configuration.
export function approved(path: string): boolean {
  if (path.split("/").some(p => p === ".." || p === ".local" || p === "node_modules")) return false;
  if (/(^|\/)(\.env[^/]*|[^/]*\.(pem|key|p12|pfx)|id_rsa|id_ed25519|credentials[^/]*)$/i.test(path)) return false;
  return /^(src\/|tests\/e2e\/|openspec\/|design\/hub-mobile\/|api\/|docs\/|\.claude\/(commands|skills)\/|\.opencode\/(commands|skills)\/)/.test(path)
    || /^(ARCHITECTURE\.md|CLAUDE\.md|package\.json|playwright\.(hub-mobile|mobile)\.config\.ts)$/.test(path);
}
function fileRecord(path: string) {
  if (!approved(path)) throw new Error(`Unapproved evidence path: ${path}`);
  try {
    const stat = lstatSync(path);
    if (!stat.isFile()) throw new Error(`Not a regular file: ${path}`);
    const bytes = readFileSync(path);
    return { path, mode: stat.mode & 0o777, bytes: bytes.length, sha256: sha(bytes) };
  } catch (error: any) {
    if (error.code === "ENOENT") return { path, absent: true };
    throw error;
  }
}
function digest(paths: string[]) {
  // Canonical sorted JSON-lines binds paths, absence, modes, sizes and content.
  return sha([...new Set(paths)].sort().map(path => JSON.stringify(fileRecord(path))).join("\n") + "\n");
}
function snapshot(additions: string[] = []) {
  // Normal status intentionally collapses excluded untracked directories, so
  // .local and unrelated user work are named but never enumerated or opened.
  const status = git("status", "--porcelain=v1", "--untracked-files=normal").trimEnd().split("\n")
    .filter(line => line && !line.slice(3).startsWith(evidence) && !additions.some(p => line.slice(3).startsWith(p)));
  const candidates = git("ls-files", "--cached", "--others", "--exclude-standard", "-z", "--",
    "src", "tests/e2e", "openspec", "design/hub-mobile", "api", "docs", ".claude/commands", ".claude/skills",
    ".opencode/commands", ".opencode/skills", "ARCHITECTURE.md", "CLAUDE.md", "package.json",
    "playwright.hub-mobile.config.ts", "playwright.mobile.config.ts").split("\0").filter(Boolean);
  const paths = [...new Set(candidates)].filter(p => approved(p) && !p.startsWith(evidence) && !additions.some(a => p.startsWith(a))).sort();
  const groups = Object.fromEntries([
    ["references", paths.filter(p => p.startsWith(reference))],
    ["retainedArchive", paths.filter(p => p.startsWith(archive))],
    ["approvedRepositoryEvidence", paths],
  ].map(([name, list]) => [name, { files: (list as string[]).length, sha256: digest(list as string[]) }]));
  const images = paths.filter(p => p.startsWith(reference) && p.endsWith(".png")).map(path => {
    const b = readFileSync(path);
    if (b.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" || b.toString("ascii", 12, 16) !== "IHDR") throw new Error(`Invalid PNG: ${path}`);
    const chunks: string[] = [];
    for (let i = 8; i + 12 <= b.length;) {
      const type = b.toString("ascii", i + 4, i + 8);
      chunks.push(type);
      if (process.argv[2] === "metadata" && type === "eXIf") console.log(path, b.subarray(i + 8, i + 8 + b.readUInt32BE(i)).toString("hex"));
      i += b.readUInt32BE(i) + 12;
    }
    return [path.slice(reference.length), b.readUInt32BE(16), b.readUInt32BE(20)];
  });
  return { head: git("rev-parse", "HEAD").trim(), indexSha256: sha(git("ls-files", "--stage", "-z")), status, groups, images };
}
if (import.meta.main) {
  const additions = process.argv[2] === "verify-with-additions" ? process.argv.slice(3) : [];
  if (additions.length) {
    const baseline = JSON.parse(readFileSync(`${evidence}baseline.json`, "utf8"));
    for (const path of additions) {
      if (!approved(path) || !path.endsWith("/") || git("ls-files", "--cached", "--", path)
        || baseline.status.some((line: string) => path.startsWith(line.slice(3)) || line.slice(3).startsWith(path)))
        throw new Error(`Not an independently new untracked directory: ${path}`);
    }
  }
  const current = snapshot(additions);
  if (process.argv[2] === "verify" || process.argv[2] === "verify-with-additions") {
    const baseline = JSON.parse(readFileSync(`${evidence}baseline.json`, "utf8"));
    const fields = ["head", "indexSha256", "status", "groups", "images"] as const;
    const changed = fields.filter(key => JSON.stringify(baseline[key]) !== JSON.stringify(current[key]));
    console.log(JSON.stringify({ ok: !changed.length, changed, excludedConcurrentAdditions: additions, groups: current.groups }, null, 2));
    if (changed.length) process.exitCode = 1;
  } else if (!process.argv[2] || process.argv[2] === "capture") {
    console.log(JSON.stringify(current, null, 2));
  } else if (process.argv[2] !== "metadata") throw new Error("Usage: bun <baseline.ts> [capture|verify|metadata]");
}
