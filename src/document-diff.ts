import { promises as fs } from "node:fs";
import path from "node:path";

import { resolveReviewBase, safeGit } from "./git-base-ref";
import { loadReviewSettings } from "./review-load";
import { findDocument } from "./shared";
import type { RootGroup } from "./shared";

const MAX_DIFF_BUFFER = 4 * 1024 * 1024;

// Per-blob cap. When either the old or new file exceeds this, we skip
// sending blobs and the client falls back to patch-only rendering (Pierre
// still draws the diff, but the "expand unchanged" chevrons become no-ops
// since there's no source to expand to). The cap balances better review
// UX for normal files against the doubled wire size that blob payloads
// imply for small changes to medium-sized files.
const MAX_BLOB_BYTES = 200 * 1024;

export type DocumentDiffResponse =
  | {
      kind: "text";
      baseRef: string;
      patch: string;
      bytes: number;
      addedLines: number;
      deletedLines: number;
      // When both blobs fit under MAX_BLOB_BYTES, ship them so the client
      // can use Pierre's `parseDiffFromFile` path and enable expand-context.
      // `oldPath` populates for renames so the client renders the proper
      // "renamed from / to" header.
      oldContents?: string;
      newContents?: string;
      oldPath?: string;
    }
  | { kind: "unchanged"; baseRef: string }
  | { kind: "binary"; baseRef: string }
  | { kind: "unsupported-no-git" };

export async function getDocumentDiff(
  roots: RootGroup[],
  documentId: string,
): Promise<DocumentDiffResponse> {
  const document = findDocument(roots, documentId);
  if (!document) {
    throw new Error("document not found");
  }

  const probeDir = path.dirname(document.id);
  const topLevel = await safeGit(probeDir, ["rev-parse", "--show-toplevel"]);
  if (!topLevel.ok || !topLevel.stdout.trim()) {
    return { kind: "unsupported-no-git" };
  }

  // Canonicalize both ends through realpath so a symlinked watched root
  // (or macOS's /var → /private/var) still yields a relative path that
  // lives under repoRoot. Falls back to the original on ENOENT (e.g. the
  // file was deleted between findDocument and now).
  const repoRoot = topLevel.stdout.trim();
  const realDocPath = await fs.realpath(document.id).catch(() => document.id);
  const relativePath = path.relative(repoRoot, realDocPath);

  const { settings } = await loadReviewSettings(repoRoot);
  const base = await resolveReviewBase(repoRoot, settings.baseRef);

  // For a resolved base we compare against the merge-base tree so the diff
  // includes everything between the base and the current worktree (committed
  // + staged + unstaged). For dirty-worktree-only we compare against HEAD.
  const compareRef = base.mergeBase ?? "HEAD";

  // `-M` can only detect a rename when the diff sees both old and new
  // paths. Filtering by `-- <newPath>` strips the old path, so we look up
  // the rename target via `--name-status` first and pass both paths when
  // applicable. This keeps renames as a single diff rather than collapsing
  // them into a misleading "new file" add.
  const renameOldPath = await detectRenameOldPath(repoRoot, compareRef, relativePath);
  const pathArgs = renameOldPath ? [renameOldPath, relativePath] : [relativePath];

  const result = await safeGit(
    repoRoot,
    ["diff", "-M", "--no-ext-diff", compareRef, "--", ...pathArgs],
    { maxBuffer: MAX_DIFF_BUFFER },
  );

  if (!result.ok) {
    return { kind: "unsupported-no-git" };
  }

  const baseRef = base.ref ?? "HEAD";
  let patch = result.stdout;

  // `git diff <ref>` ignores untracked files. When the patch is empty but
  // the file exists on disk and isn't tracked, fall back to `--no-index`
  // against /dev/null so the user sees the file as a pure addition rather
  // than a misleading "no changes" card.
  if (!patch.trim()) {
    const tracked = await safeGit(repoRoot, ["ls-files", "--error-unmatch", "--", relativePath]);
    if (!tracked.ok) {
      const untrackedDiff = await safeGit(
        repoRoot,
        ["diff", "--no-index", "--no-ext-diff", "--", "/dev/null", relativePath],
        { maxBuffer: MAX_DIFF_BUFFER },
      );
      // `--no-index` exits with status 1 when files differ (which is the
      // expected case for a new file vs /dev/null), so non-empty stdout
      // is the success signal here, not `result.ok`.
      if (untrackedDiff.stdout.trim()) {
        patch = untrackedDiff.stdout;
      }
    }
    if (!patch.trim()) {
      return { kind: "unchanged", baseRef };
    }
  }

  if (isBinaryPatch(patch)) {
    return { kind: "binary", baseRef };
  }

  const { addedLines, deletedLines } = countDiffLines(patch);
  const blobs = await fetchBlobs({
    repoRoot,
    compareRef,
    relativePath,
    realDocPath,
    oldRelativePath: renameOldPath ?? relativePath,
  });

  return {
    kind: "text",
    baseRef,
    patch,
    bytes: Buffer.byteLength(patch, "utf8"),
    addedLines,
    deletedLines,
    ...(blobs.oldContents !== undefined ? { oldContents: blobs.oldContents } : {}),
    ...(blobs.newContents !== undefined ? { newContents: blobs.newContents } : {}),
    ...(renameOldPath ? { oldPath: renameOldPath } : {}),
  };
}

// Fetch the old (base-ref) and new (worktree) blob contents so the client
// can drive Pierre's two-blob input path and enable expand-context. When
// either blob exceeds MAX_BLOB_BYTES, or the worktree read fails, we
// return `{}` and the client falls back to patch-only rendering (Pierre
// still draws the diff, the chevrons just become no-ops).
async function fetchBlobs(args: {
  repoRoot: string;
  compareRef: string;
  relativePath: string;
  realDocPath: string;
  oldRelativePath: string;
}): Promise<{ oldContents?: string; newContents?: string }> {
  // Read the worktree first — if the file isn't readable we can't render
  // a useful diff anyway, and we want to bail before paying the git cost.
  let newContents: string;
  try {
    const stat = await fs.stat(args.realDocPath);
    if (stat.size > MAX_BLOB_BYTES) {
      return {};
    }
    newContents = await fs.readFile(args.realDocPath, "utf8");
  } catch {
    return {};
  }

  // `git show <ref>:<path>` fails (non-zero exit) when the path didn't
  // exist at that ref — i.e., the file was added on this branch. Treat
  // that as `oldContents === ""` so Pierre renders the diff as a pure
  // addition with expand support against an empty original. Apply the
  // size cutoff to the old blob too so a huge committed version can't
  // bloat the response.
  const old = await safeGit(
    args.repoRoot,
    ["show", `${args.compareRef}:${args.oldRelativePath}`],
    { maxBuffer: MAX_BLOB_BYTES + 1 },
  );
  const oldContents = old.ok ? old.stdout : "";
  if (Buffer.byteLength(oldContents, "utf8") > MAX_BLOB_BYTES) {
    return {};
  }

  return { oldContents, newContents };
}

async function detectRenameOldPath(
  repoRoot: string,
  compareRef: string,
  newRelativePath: string,
): Promise<string | null> {
  const res = await safeGit(repoRoot, ["diff", "-M", "--name-status", compareRef]);
  if (!res.ok) {
    return null;
  }
  for (const line of res.stdout.split("\n")) {
    const match = line.match(/^R\d+\t(.+)\t(.+)$/);
    if (!match) continue;
    const [, oldPath = "", newPath = ""] = match;
    if (newPath === newRelativePath) {
      return oldPath || null;
    }
  }
  return null;
}

function isBinaryPatch(patch: string): boolean {
  // A binary diff has the marker "Binary files ... differ" and no hunk headers.
  if (!/^Binary files .* differ$/m.test(patch)) {
    return false;
  }
  return !patch.includes("\n@@");
}

function countDiffLines(patch: string): { addedLines: number; deletedLines: number } {
  let addedLines = 0;
  let deletedLines = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) addedLines++;
    else if (line.startsWith("-")) deletedLines++;
  }
  return { addedLines, deletedLines };
}
