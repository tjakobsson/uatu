// Reading a commit's files straight from Git's object store, for the pull
// request file view (add-github-pr-review D17): exact bytes at a commit,
// with no checkout, no index, and none of the filters, textconv drivers or
// attributes a working-tree read would apply.
//
// - `commitPresent`: `git cat-file -e <oid>^{commit}`, which decides whether
//   a pull request's head is local or still needs the explicit fetch.
// - `readBlob`: `git cat-file --batch-check` for the type and size first,
//   then `git cat-file --batch` for the bytes, so a file over the caller's
//   cap is never read into memory. Binary-safe: the bytes are a Buffer.
// - `listTree`: `git ls-tree -r -z -l --full-tree`, NUL-separated (any path
//   survives), streamed and stopped at the caller's limit.
// - `parseLfsPointer`: a Git LFS pointer file, which the view shows as its
//   text with a note; uatu never runs an LFS fetch.
//
// Everything here only reads. The one Git write the session child makes,
// the narrow fetch, is in pull-request-refs.ts.

import { spawn } from "node:child_process";

import { recordGitMetric } from "./git-base-ref";

const READ_TIMEOUT_MS = 15_000;

export type GitBytesResult = { code: number | null; stdout: Buffer; stderr: string; overflow: boolean; timedOut: boolean };

// One Git process, its stdout collected as bytes up to `maxBytes` (then it
// is killed and `overflow` set). `onChunk` may stop it early by answering
// false (ls-tree at its limit).
export function runGitBytes(
  cwd: string,
  args: string[],
  options: { input?: string; maxBytes?: number; timeoutMs?: number; env?: Record<string, string | undefined>; onChunk?: (chunk: Buffer) => boolean } = {},
): Promise<GitBytesResult> {
  recordGitMetric("git.execs_total");
  return new Promise(resolve => {
    const child = spawn("git", args, {
      cwd,
      env: { ...(options.env ?? process.env), GIT_OPTIONAL_LOCKS: "0" },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let overflow = false;
    let stopped = false;
    let timedOut = false;
    let stderr = "";
    const maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, options.timeoutMs ?? READ_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      if (stopped) return;
      if (options.onChunk && !options.onChunk(chunk)) {
        stopped = true;
        child.kill("SIGKILL");
        return;
      }
      if (options.onChunk) return;
      size += chunk.length;
      if (size > maxBytes) {
        overflow = true;
        stopped = true;
        child.kill("SIGKILL");
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 16_384) stderr += chunk.toString("utf8");
    });
    child.on("error", () => { /* reported through close */ });
    child.on("close", code => {
      clearTimeout(timer);
      resolve({ code: stopped || timedOut ? null : code, stdout: Buffer.concat(chunks), stderr, overflow, timedOut });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(options.input ?? "");
  });
}

const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

export function isObjectId(value: string): boolean {
  return OID.test(value);
}

// Whether the commit is in the local object store.
export async function commitPresent(repoRoot: string, oid: string): Promise<boolean> {
  if (!isObjectId(oid)) return false;
  const result = await runGitBytes(repoRoot, ["cat-file", "-e", `${oid}^{commit}`], { maxBytes: 1024 });
  return result.code === 0;
}

export type BlobRead =
  | { kind: "blob"; oid: string; size: number; bytes: Buffer }
  | { kind: "too-large"; oid: string; size: number }
  // The commit doesn't hold the path (or it is a directory or submodule).
  | { kind: "missing" };

// A path usable on `cat-file`'s line-based input: repository-relative, no
// newline (the batch protocol is one object name per line).
function batchablePath(filePath: string): boolean {
  return filePath !== "" && !filePath.includes("\n") && !filePath.includes("\0") && !filePath.startsWith("/");
}

// The bytes of `<commit>:<path>`, or why there are none. `maxBytes` bounds
// what is read: a larger blob answers `too-large` with its size, unread.
export async function readBlob(repoRoot: string, commit: string, filePath: string, options: { maxBytes: number }): Promise<BlobRead> {
  if (!isObjectId(commit) || !batchablePath(filePath)) return { kind: "missing" };
  const check = await runGitBytes(repoRoot, ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"], {
    input: `${commit}:${filePath}\n`,
    maxBytes: 4096,
  });
  const header = check.stdout.toString("utf8").trim();
  const match = /^([0-9a-f]{40}(?:[0-9a-f]{24})?) (\w+) (\d+)$/.exec(header);
  if (check.code !== 0 || !match) return { kind: "missing" };
  const [, oid = "", type = "", sizeText = "0"] = match;
  const size = Number(sizeText);
  if (type !== "blob") return { kind: "missing" };
  if (size > options.maxBytes) return { kind: "too-large", oid, size };
  const read = await runGitBytes(repoRoot, ["cat-file", "--batch"], { input: `${oid}\n`, maxBytes: size + 256 });
  const bytes = parseBatchObject(read.stdout, oid);
  if (read.code !== 0 || !bytes || bytes.length !== size) return { kind: "missing" };
  return { kind: "blob", oid, size, bytes };
}

// `cat-file --batch` answers `<oid> <type> <size>\n<contents>\n`.
export function parseBatchObject(output: Buffer, oid: string): Buffer | null {
  const newline = output.indexOf(0x0a);
  if (newline < 0) return null;
  const header = output.subarray(0, newline).toString("utf8");
  const match = /^(\S+) blob (\d+)$/.exec(header);
  if (!match || match[1] !== oid) return null;
  const size = Number(match[2]);
  const start = newline + 1;
  if (output.length < start + size + 1 || output[start + size] !== 0x0a) return null;
  return output.subarray(start, start + size);
}

export type TreeEntry = { path: string; oid: string; size: number };

// Every file (blob) at the commit, in Git's order, at most `limit`;
// `truncated` says there were more. Submodules and symlinks' targets are
// not followed; a symlink is listed as the blob it is.
export async function listTree(repoRoot: string, commit: string, options: { limit: number }): Promise<{ entries: TreeEntry[]; truncated: boolean } | null> {
  if (!isObjectId(commit)) return null;
  const entries: TreeEntry[] = [];
  let truncated = false;
  let pending: Buffer = Buffer.alloc(0);
  const take = (record: Buffer) => {
    // <mode> SP <type> SP <oid> SP+ <size> TAB <path>
    const tab = record.indexOf(0x09);
    if (tab < 0) return;
    const meta = record.subarray(0, tab).toString("utf8").split(/\s+/);
    const [, type, oid = "", sizeText = ""] = meta;
    if (type !== "blob") return;
    entries.push({ path: record.subarray(tab + 1).toString("utf8"), oid, size: Number(sizeText) || 0 });
  };
  const result = await runGitBytes(repoRoot, ["ls-tree", "-r", "-z", "-l", "--full-tree", commit], {
    timeoutMs: 30_000,
    onChunk: chunk => {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      let at = pending.indexOf(0);
      while (at >= 0) {
        take(pending.subarray(0, at));
        pending = pending.subarray(at + 1);
        if (entries.length > options.limit) {
          truncated = true;
          return false;
        }
        at = pending.indexOf(0);
      }
      return true;
    },
  });
  if (!truncated && result.code !== 0) return null;
  if (truncated) entries.length = options.limit;
  return { entries, truncated };
}

// A Git LFS pointer file (https://github.com/git-lfs/git-lfs/blob/main/docs/spec.md):
// UTF-8 text under 1024 bytes, starting with the spec's version line, with
// an `oid sha256:` and a `size` line.
export type LfsPointer = { oid: string; size: number };

const LFS_VERSION_LINE = "version https://git-lfs.github.com/spec/v1\n";

export function parseLfsPointer(bytes: Uint8Array): LfsPointer | null {
  if (bytes.length >= 1024) return null;
  const text = new TextDecoder().decode(bytes);
  if (!text.startsWith(LFS_VERSION_LINE)) return null;
  const oid = /^oid sha256:([0-9a-f]{64})$/m.exec(text)?.[1];
  const size = /^size (\d+)$/m.exec(text)?.[1];
  return oid && size ? { oid, size: Number(size) } : null;
}
