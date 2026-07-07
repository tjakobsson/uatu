import { promises as fs } from "node:fs";
import path from "node:path";

import { applyCompareTarget, compareRefForTarget, recordGitMetric, resolveReviewBase, safeGit } from "./git-base-ref";
import { loadReviewSettings } from "../review/load";
import { DEFAULT_COMPARE_TARGET, findDocument } from "../shared/types";
import type { ReviewBase, ReviewCompareTarget, ReviewSettings, RootGroup } from "../shared/types";

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

// Phase-timing helper: records cumulative milliseconds per pipeline phase
// (plus a request counter) through the shared git metrics sink, so the
// debug snapshot can attribute diff-endpoint latency to base resolution,
// the file-scoped diff, the repo-wide rename scan, or blob fetching.
function timePhase<T>(metric: string, work: () => Promise<T>): Promise<T> {
  const startedAt = performance.now();
  return work().finally(() => {
    recordGitMetric(metric, performance.now() - startedAt);
  });
}

// Per-repo review-context cache. Base resolution (toplevel discovery,
// settings load, remote-default lookup, ref probes, merge-base) only
// changes when HEAD moves or config is edited, so warm requests validate
// with a single `git rev-parse HEAD` probe instead of re-running the
// chain. The TTL bounds staleness for changes the probe can't see
// (origin fetches moving the base tip, `.uatu.json` edits).
const BASE_CACHE_TTL_MS = 30_000;
let baseCacheTtlMs = BASE_CACHE_TTL_MS;

type RepoReviewContext = {
  repoRoot: string;
  settings: ReviewSettings;
  // Resolved with the default `base` target; per-request compare targets
  // are applied on top via the pure `applyCompareTarget`.
  resolvedBase: ReviewBase;
};

const repoRootByProbeDir = new Map<string, { repoRoot: string | null; expiresAtMs: number }>();
const contextByRepoRoot = new Map<string, { context: RepoReviewContext; headSha: string; expiresAtMs: number }>();

async function resolveRepoContext(probeDir: string): Promise<RepoReviewContext | null> {
  const now = Date.now();

  let repoRoot: string | null;
  const dirCached = repoRootByProbeDir.get(probeDir);
  if (dirCached && now < dirCached.expiresAtMs) {
    repoRoot = dirCached.repoRoot;
  } else {
    const topLevel = await safeGit(probeDir, ["rev-parse", "--show-toplevel"]);
    repoRoot = topLevel.ok && topLevel.stdout.trim() ? topLevel.stdout.trim() : null;
    repoRootByProbeDir.set(probeDir, { repoRoot, expiresAtMs: now + baseCacheTtlMs });
  }
  if (!repoRoot) {
    return null;
  }

  // Single validation probe: an unchanged HEAD within the TTL means the
  // cached settings + resolved base are still good. An unborn HEAD (fresh
  // repo with no commits) yields an empty sha and always re-resolves.
  const head = await safeGit(repoRoot, ["rev-parse", "HEAD"]);
  const headSha = head.ok ? head.stdout.trim() : "";
  const cached = contextByRepoRoot.get(repoRoot);
  if (cached && headSha && cached.headSha === headSha && now < cached.expiresAtMs) {
    recordGitMetric("diff.base_cache_hits_total");
    return cached.context;
  }

  recordGitMetric("diff.base_cache_misses_total");
  const { settings } = await loadReviewSettings(repoRoot);
  const resolvedBase = await resolveReviewBase(repoRoot, settings.baseRef);
  const context: RepoReviewContext = { repoRoot, settings, resolvedBase };
  contextByRepoRoot.set(repoRoot, { context, headSha, expiresAtMs: now + baseCacheTtlMs });
  return context;
}

// A file-scoped `git diff <ref> -- <newPath>` cannot see the old side of a
// rename, so a renamed file presents as a pure addition. That shape is the
// only trigger for the repo-wide rename scan.
function isPureAdditionPatch(patch: string): boolean {
  return /^new file mode /m.test(patch) || /^--- \/dev\/null$/m.test(patch);
}

export async function getDocumentDiff(
  roots: RootGroup[],
  documentId: string,
  compareTarget: ReviewCompareTarget = DEFAULT_COMPARE_TARGET,
): Promise<DocumentDiffResponse> {
  const document = findDocument(roots, documentId);
  if (!document) {
    throw new Error("document not found");
  }
  recordGitMetric("diff.requests_total");

  const probeDir = path.dirname(document.id);
  const context = await timePhase("diff.phase.base_resolve_ms", () => resolveRepoContext(probeDir));
  if (!context) {
    return { kind: "unsupported-no-git" };
  }
  const { repoRoot } = context;
  const base = applyCompareTarget(context.resolvedBase, compareTarget);

  // Canonicalize both ends through realpath so a symlinked watched root
  // (or macOS's /var → /private/var) still yields a relative path that
  // lives under repoRoot. Falls back to the original on ENOENT (e.g. the
  // file was deleted between findDocument and now).
  const realDocPath = await fs.realpath(document.id).catch(() => document.id);
  const relativePath = path.relative(repoRoot, realDocPath);

  // For the `base` target we compare against the merge-base tree so the diff
  // includes everything between the base and the current worktree (committed
  // + staged + unstaged). For `last-commit` (and the dirty-worktree fallback)
  // we compare against HEAD — staged + unstaged only.
  const compareRef = compareRefForTarget(base, compareTarget);

  const fileScopedDiff = (pathArgs: string[]) => safeGit(
    repoRoot,
    ["diff", "-M", "--no-ext-diff", compareRef, "--", ...pathArgs],
    { maxBuffer: MAX_DIFF_BUFFER },
  );

  const result = await timePhase("diff.phase.file_diff_ms", () => fileScopedDiff([relativePath]));
  if (!result.ok) {
    return { kind: "unsupported-no-git" };
  }

  // Report the precise, portable anchor (resolved base ref for `base`, `HEAD`
  // for `last-commit`) so the Diff view labels what it compared against.
  const baseRef = base.comparedAgainstRef;
  let patch = result.stdout;
  let fromNoIndexFallback = false;

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
        fromNoIndexFallback = true;
      }
    }
    if (!patch.trim()) {
      return { kind: "unchanged", baseRef };
    }
  }

  if (isBinaryPatch(patch)) {
    return { kind: "binary", baseRef };
  }

  // `-M` can only detect a rename when the diff sees both old and new
  // paths, and filtering by `-- <newPath>` strips the old path — so a
  // renamed file presents as a pure addition above. Only that shape
  // warrants the repo-wide `--name-status` scan; ordinary modified files
  // (the overwhelmingly common case) never pay for it. Untracked files
  // surfaced by the `--no-index` fallback can't be git renames (they are
  // invisible to `git diff <ref>`), so they skip the scan too.
  let renameOldPath: string | null = null;
  if (!fromNoIndexFallback && isPureAdditionPatch(patch)) {
    renameOldPath = await timePhase("diff.phase.rename_scan_ms", () => {
      recordGitMetric("diff.rename_scans_total");
      return detectRenameOldPath(repoRoot, compareRef, relativePath);
    });
    if (renameOldPath) {
      const withOldPath = renameOldPath;
      const rerun = await timePhase("diff.phase.file_diff_ms", () => fileScopedDiff([withOldPath, relativePath]));
      if (rerun.ok && rerun.stdout.trim()) {
        patch = rerun.stdout;
      }
    }
  }

  const { addedLines, deletedLines } = countDiffLines(patch);
  const blobs = await timePhase("diff.phase.blob_fetch_ms", () => fetchBlobs({
    repoRoot,
    compareRef,
    relativePath,
    realDocPath,
    oldRelativePath: renameOldPath ?? relativePath,
  }));

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
  // The worktree read and the base-ref `git show` are independent — run
  // them concurrently. The worktree read is the cheaper gate: when it
  // bails (unreadable or over the cap) the concurrent git call's work is
  // wasted, but that only happens for oversized files where the git call
  // aborts fast at its own buffer cap anyway.
  const [newContents, old] = await Promise.all([
    (async (): Promise<string | null> => {
      try {
        const stat = await fs.stat(args.realDocPath);
        if (stat.size > MAX_BLOB_BYTES) {
          return null;
        }
        return await fs.readFile(args.realDocPath, "utf8");
      } catch {
        return null;
      }
    })(),
    // `git show <ref>:<path>` fails (non-zero exit) when the path didn't
    // exist at that ref — i.e., the file was added on this branch. Treat
    // that as `oldContents === ""` so Pierre renders the diff as a pure
    // addition with expand support against an empty original. Apply the
    // size cutoff to the old blob too so a huge committed version can't
    // bloat the response.
    safeGit(
      args.repoRoot,
      ["show", `${args.compareRef}:${args.oldRelativePath}`],
      { maxBuffer: MAX_BLOB_BYTES + 1 },
    ),
  ]);
  if (newContents === null) {
    return {};
  }

  // Distinguish "path absent at ref" (a legitimate empty old side) from
  // an old blob that blew the buffer cap — shipping "" for the latter
  // would misrender the diff as a whole-file addition.
  if (!old.ok && old.message.includes("maxBuffer")) {
    return {};
  }
  const oldContents = old.ok ? old.stdout : "";
  if (Buffer.byteLength(oldContents, "utf8") > MAX_BLOB_BYTES) {
    return {};
  }

  return { oldContents, newContents };
}

// Test-only escape hatches: clear the per-repo caches and tighten the TTL
// so unit tests can exercise cold/warm/expired paths deterministically.
// Production code MUST NOT call these.
export function __resetDocumentDiffCachesForTests(): void {
  repoRootByProbeDir.clear();
  contextByRepoRoot.clear();
  baseCacheTtlMs = BASE_CACHE_TTL_MS;
}

export function __setBaseCacheTtlForTests(ttlMs: number): void {
  baseCacheTtlMs = ttlMs;
}

async function detectRenameOldPath(
  repoRoot: string,
  compareRef: string,
  newRelativePath: string,
): Promise<string | null> {
  // Match the outer `git diff` call's buffer cap — `--name-status` over a
  // branch with many changed files can easily exceed safeGit's 256 KB
  // default, and a silent truncation that drops the rename entry for the
  // viewed file would surface as a spurious delete+add in the rendered
  // diff. 4 MB matches MAX_DIFF_BUFFER used by the patch fetch.
  const res = await safeGit(repoRoot, ["diff", "-M", "--name-status", compareRef], {
    maxBuffer: MAX_DIFF_BUFFER,
  });
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
