// Reading a watched file without following a link out of its watch root.
//
// The index, the preview, search, and diff address a file by the path its
// observer reported under a watch root. A directory on that path, or the file
// itself, can be replaced by a symbolic link after the file was indexed, and
// the polling observer (`fs.watchFile`) reports the link target's metadata.
// Every read of a watched file's content or metadata goes through here.
//
// The rule: the watch root is trusted as given (a root may itself be a
// symlink; `resolveWatchRoots` accepts it through `fs.stat`), and nothing
// between the root and the file may be a link. The file must be a regular
// file. A file that fails the rule is refused with `UNCONTAINED`, which every
// caller treats like a missing file: the index drops the path, render answers
// 404, search skips it.
//
// Static fallback serving (`server/static-files.ts`) applies a looser rule on
// purpose — an in-root directory link that resolves inside the root may serve
// an image — and checks real-path containment itself.

import { constants, promises as fs, type Stats } from "node:fs";
import path from "node:path";

export const UNCONTAINED = "EUNCONTAINED";

export class UncontainedFileError extends Error {
  readonly code = UNCONTAINED;
  constructor(target: string) {
    super(`not a regular file inside its watch root: ${target}`);
  }
}

export function isUncontained(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === UNCONTAINED;
}

function segmentsBelow(rootPath: string, target: string): string[] {
  const relative = path.relative(rootPath, target);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new UncontainedFileError(target);
  }
  return relative.split(path.sep);
}

// The lstat of `target`, proven to be a regular file reached from `rootPath`
// without crossing a link. Missing paths reject with their own fs error
// (ENOENT, ENOTDIR); a link anywhere below the root, or a target that is not
// a regular file, rejects with `UNCONTAINED`.
export async function statContainedFile(rootPath: string, target: string): Promise<Stats> {
  let current = rootPath;
  let stats: Stats | undefined;
  for (const segment of segmentsBelow(rootPath, target)) {
    current = path.join(current, segment);
    stats = await fs.lstat(current);
    if (stats.isSymbolicLink()) throw new UncontainedFileError(target);
  }
  if (!stats?.isFile()) throw new UncontainedFileError(target);
  return stats;
}

// Not following a final link, and not blocking on a FIFO that was swapped in.
// Neither flag exists on Windows, which uatu does not serve from.
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

// An open handle on `target` that is proven to be the file the link-free path
// names. The file is opened first and checked second: after the open, the
// path is walked (no link below the root, a regular file at the end) and the
// walked file's identity must equal the handle's. Reading from the handle
// therefore reads the contained file even if the path changes afterwards.
//
// The remaining window is inside the walk: segments are checked one lstat at
// a time, so a directory that is a real directory for its own lstat and a
// link for the next one could pass. That takes two renames landing between
// two consecutive syscalls, and still requires the opened file to be the one
// the swapped path then names. Node has no `openat`/`O_BENEATH` to close it.
export async function openContainedFile(rootPath: string, target: string): Promise<{ handle: fs.FileHandle; stats: Stats }> {
  // Reject an escaping or root-equal target before touching the filesystem.
  segmentsBelow(rootPath, target);
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(target, OPEN_FLAGS);
  } catch (error) {
    // O_NOFOLLOW on a final link fails with ELOOP (EMLINK on FreeBSD).
    if (["ELOOP", "EMLINK"].includes((error as NodeJS.ErrnoException).code ?? "")) throw new UncontainedFileError(target);
    throw error;
  }
  try {
    const opened = await handle.stat();
    const walked = await statContainedFile(rootPath, target);
    if (!opened.isFile() || opened.dev !== walked.dev || opened.ino !== walked.ino) throw new UncontainedFileError(target);
    return { handle, stats: opened };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

// The contained file's text and metadata, read through the handle that was
// checked. With `maxBytes`, a larger file is not read: `text` is null.
export async function readContainedFile(
  rootPath: string,
  target: string,
  options: { maxBytes?: number } = {},
): Promise<{ text: string | null; stats: Stats }> {
  const { handle, stats } = await openContainedFile(rootPath, target);
  try {
    if (options.maxBytes !== undefined && stats.size > options.maxBytes) return { text: null, stats };
    return { text: await handle.readFile({ encoding: "utf8" }), stats };
  } finally {
    await handle.close().catch(() => undefined);
  }
}
