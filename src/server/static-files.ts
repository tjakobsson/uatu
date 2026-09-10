// Static-file fallback for direct requests to files under the watched roots
// (images referenced from rendered Markdown, raw files fetched by curl, …).
// Every resolution runs the full security gauntlet: percent-decoding checks,
// deny-policy names, per-root ignore rules, and a realpath containment check
// so symlinks can't escape the root.

import { promises as fs } from "node:fs";
import path from "node:path";

import { loadIgnoreMatcher, type IgnoreMatcher } from "../ignore/engine";
import { DEFAULT_RESPECT_GITIGNORE, shouldDenyPath, type WatchEntry } from "./roots";
import type { RootGroup, Scope } from "../shared/types";

export async function documentResourceResponse(roots: readonly RootGroup[], scope: Scope, rootId: string, documentId: string, respectGitignore: boolean): Promise<Response> {
  const missing = () => Response.json({ error: "document resource not found" }, { status: 404 });
  if (scope.kind === "file" && scope.documentId !== documentId) return missing();
  const matches = roots.filter(root => root.id === rootId);
  if (matches.length !== 1) return missing();
  const root = matches[0]!;
  const documents = root.docs.filter(doc => doc.id === documentId && doc.rootId === rootId);
  if (documents.length !== 1) return missing();
  const doc = documents[0]!;
  if (!/\.(png|jpe?g|gif|webp|svg|ico|avif|bmp)$/i.test(doc.name)) {
    return Response.json({ error: "document resource is not an image" }, { status: 415 });
  }
  // Resolve only inside the indexed root, rechecking ignore and realpath containment.
  const resolved = await resolveStaticFileRequest(`/${doc.relativePath.split("/").map(encodeURIComponent).join("/")}`, [{ kind: "dir", absolutePath: root.path }], { respectGitignore });
  if (resolved.status !== "found" || path.resolve(root.path, doc.relativePath) !== path.resolve(doc.id)) return missing();
  return new Response(Bun.file(resolved.filePath), { headers: {
    "cache-control": "no-cache", "x-content-type-options": "nosniff",
    "content-security-policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'",
  } });
}

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
