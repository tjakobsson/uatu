// File-facts collection — the repo-derived facts (line count, byte size,
// mtime, last-commit author/date/sha/subject, dirty flag) that frame Source
// and Diff views in the preview. Computed fresh on every document render so
// the live-reload path keeps them current.
//
// Failure posture: the render must never fail because facts collection did.
// Any git error (non-git root, timeout, missing binary) degrades to the
// filesystem-only shape; a stat failure degrades to no facts at all.

import { promises as fs } from "node:fs";

import { escapeHtml } from "../shared/html";
import type { FileFacts, FileFactsGit } from "../shared/types";
import { safeGit } from "./git-base-ref";

export type CollectFileFactsOptions = {
  // Absolute path of the document on disk (DocumentMeta.id).
  absolutePath: string;
  // Watched root the document belongs to — the cwd for git invocations. git
  // resolves the enclosing repository itself, so this works for roots that
  // are subdirectories of a repo.
  rootPath: string;
  // The already-read file source; line count comes from here so facts add no
  // extra read on the render path. Callers without the source in hand (the
  // diff endpoint) omit it and pay one extra read.
  source?: string;
};

export async function collectFileFacts(
  options: CollectFileFactsOptions,
): Promise<FileFacts | undefined> {
  const [stat, source, git] = await Promise.all([
    fs.stat(options.absolutePath).catch(() => null),
    options.source !== undefined
      ? Promise.resolve(options.source)
      : fs.readFile(options.absolutePath, "utf8").catch(() => null),
    collectGitFacts(options.rootPath, options.absolutePath),
  ]);

  if (!stat || source === null) {
    return undefined;
  }

  return {
    lines: countLines(source),
    bytes: stat.size,
    mtime: stat.mtime.toISOString(),
    ...(git ? { git } : {}),
  };
}

export function countLines(source: string): number {
  if (source === "") {
    return 0;
  }
  let lines = 0;
  for (let index = 0; index < source.length; index += 1) {
    if (source.charCodeAt(index) === 10) {
      lines += 1;
    }
  }
  // A final line without a trailing newline still counts.
  if (source.charCodeAt(source.length - 1) !== 10) {
    lines += 1;
  }
  return lines;
}

async function collectGitFacts(
  rootPath: string,
  absolutePath: string,
): Promise<FileFactsGit | undefined> {
  const [logResult, statusResult] = await Promise.all([
    safeGit(rootPath, [
      "log",
      "-1",
      "--format=%an%x09%aI%x09%h%x09%s",
      "--",
      absolutePath,
    ]),
    safeGit(rootPath, ["status", "--porcelain", "--", absolutePath]),
  ]);

  // A failing `log` means "not a git repo" (or git itself is unavailable) —
  // degrade to the filesystem-only shape. A succeeding `log` with empty
  // output means "repo, but no commit touches this path": never committed.
  if (!logResult.ok || !statusResult.ok) {
    return undefined;
  }

  const dirty = statusResult.stdout.trim().length > 0;
  const logLine = logResult.stdout.trim();
  if (!logLine) {
    return { author: null, authoredAt: null, shortSha: null, subject: null, dirty: true };
  }

  const [author = "", authoredAt = "", shortSha = "", ...subjectParts] = logLine.split("\t");
  const subject = subjectParts.join("\t");
  return {
    author: author ? escapeHtml(author) : null,
    authoredAt: authoredAt || null,
    shortSha: shortSha ? escapeHtml(shortSha) : null,
    subject: subject ? escapeHtml(subject) : null,
    dirty,
  };
}
