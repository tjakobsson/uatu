// Static-file fallback for direct requests to files under the watched roots
// (images referenced from rendered Markdown, raw files fetched by curl, …).
// Every resolution runs the full security gauntlet: percent-decoding checks,
// deny-policy names, per-root ignore rules, and a realpath containment check
// so symlinks can't escape the root.

import { promises as fs } from "node:fs";
import path from "node:path";

import { loadIgnoreMatcher, type IgnoreMatcher } from "../ignore/engine";
import { DEFAULT_RESPECT_GITIGNORE, shouldDenyPath, type WatchEntry } from "./roots";

export type StaticFileResolution = { status: "found"; filePath: string } | { status: "not-found" };

export async function resolveStaticFileRequest(
  pathname: string,
  entries: WatchEntry[],
  options: { respectGitignore?: boolean } = {},
): Promise<StaticFileResolution> {
  let decodedPathname: string;
  try {
    decodedPathname = decodeURIComponent(pathname);
  } catch {
    return { status: "not-found" };
  }

  if (decodedPathname.includes("\0")) {
    return { status: "not-found" };
  }

  const relativeUrlPath = decodedPathname.replace(/^\/+/, "");
  if (!relativeUrlPath) {
    return { status: "not-found" };
  }

  const respectGitignore = options.respectGitignore ?? DEFAULT_RESPECT_GITIGNORE;
  const matcherCache = new Map<string, IgnoreMatcher>();

  for (const entry of entries) {
    const rootPath = entry.kind === "dir" ? entry.absolutePath : entry.parentDir;
    const candidate = path.resolve(rootPath, relativeUrlPath);
    const relativeToRoot = path.relative(rootPath, candidate);

    if (
      relativeToRoot === "" ||
      relativeToRoot.startsWith("..") ||
      path.isAbsolute(relativeToRoot)
    ) {
      continue;
    }

    const relativeUnix = relativeToRoot.split(path.sep).join("/");
    if (shouldDenyPath(relativeUnix)) {
      continue;
    }

    let matcher = matcherCache.get(rootPath);
    if (!matcher) {
      matcher = await loadIgnoreMatcher({ rootPath, respectGitignore });
      matcherCache.set(rootPath, matcher);
    }

    if (matcher.shouldIgnore(relativeUnix)) {
      continue;
    }

    const stat = await fs.lstat(candidate).catch(() => null);
    if (!stat || !stat.isFile()) {
      continue;
    }

    const rootRealPath = await fs.realpath(rootPath).catch(() => null);
    const candidateRealPath = await fs.realpath(candidate).catch(() => null);
    if (!rootRealPath || !candidateRealPath || !isPathInsideRoot(candidateRealPath, rootRealPath)) {
      continue;
    }

    return { status: "found", filePath: candidateRealPath };
  }

  return { status: "not-found" };
}

export async function staticFileResponse(
  pathname: string,
  entries: WatchEntry[],
  options: { respectGitignore?: boolean } = {},
): Promise<Response | null> {
  const resolved = await resolveStaticFileRequest(pathname, entries, options);
  if (resolved.status !== "found") {
    return null;
  }

  return new Response(Bun.file(resolved.filePath), { headers: { "cache-control": "no-cache" } });
}

function isPathInsideRoot(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}
