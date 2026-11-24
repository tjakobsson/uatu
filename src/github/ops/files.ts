// A pull request's changed files and patches, from REST
// `pulls/{n}/files` (design D5; GraphQL has no patches). GitHub lists at most
// 3,000 files, 100 per page, and omits `patch` for binary or very large
// diffs. uatu reads at most FILES_PAGE_LIMIT pages, keeps patches up to
// PATCH_BYTES_LIMIT in total, and says when either cap cut the list
// (`truncated`). The answer is cached per head commit by the service, so it
// is read once per push, not per view.
//
// Statuses beyond added/removed/modified (renamed, copied, changed,
// unchanged) read as modified, with `previousPath` for a rename or copy.

import type { PullRequestFile } from "../../shared/github-contract";
import { arr, enumValue, int, obj, ParseNotes, str } from "./parse";

export const FILES_PER_PAGE = 100;
export const FILES_PAGE_LIMIT = 30;
export const PATCH_BYTES_LIMIT = 4 * 1024 * 1024;

export const PULL_REQUEST_FILES = "UatuPullRequestFiles";

export function filesPath(owner: string, name: string, number: number, page: number): string {
  return `repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${number}/files?per_page=${FILES_PER_PAGE}&page=${page}`;
}

const FILE_STATUSES = ["added", "removed", "modified", "renamed", "copied", "changed", "unchanged"] as const;

// GitHub's patch is hunks only; the diff renderer wants file headers.
export function unifiedPatch(file: { path: string; previousPath?: string; status: PullRequestFile["status"] }, hunks: string): string {
  const oldPath = file.previousPath ?? file.path;
  const from = file.status === "added" ? "/dev/null" : `a/${oldPath}`;
  const to = file.status === "removed" ? "/dev/null" : `b/${file.path}`;
  return `diff --git a/${oldPath} b/${file.path}\n--- ${from}\n+++ ${to}\n${hunks.endsWith("\n") ? hunks : `${hunks}\n`}`;
}

export type FilesPage = { files: PullRequestFile[]; patchBytes: number; patchesDropped: boolean; full: boolean };

export function parseFilesPage(json: unknown, patchBudget: number, notes = new ParseNotes()): FilesPage {
  const items = arr(json);
  let patchBytes = 0;
  let patchesDropped = false;
  const files = items.flatMap(item => {
    const entry = obj(item);
    const path = str(entry?.filename);
    if (!entry || !path) return [];
    const raw = enumValue(entry.status, FILE_STATUSES, notes, "file status");
    const status: PullRequestFile["status"] = raw === "added" || raw === "removed" ? raw : "modified";
    const previousPath = str(entry.previous_filename) || undefined;
    const file: PullRequestFile = {
      path,
      status,
      additions: int(entry.additions),
      deletions: int(entry.deletions),
      ...(previousPath ? { previousPath } : {}),
    };
    const hunks = str(entry.patch);
    if (hunks) {
      const patch = unifiedPatch(file, hunks);
      if (patchBytes + patch.length <= patchBudget) {
        patchBytes += patch.length;
        file.patch = patch;
      } else {
        patchesDropped = true;
      }
    }
    return [file];
  });
  return { files, patchBytes, patchesDropped, full: items.length >= FILES_PER_PAGE };
}
