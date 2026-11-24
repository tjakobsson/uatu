// Pure rules of the pull request file view (src/preview/pull-request-file.ts):
// what kind of file a path is, which view modes it offers, which commit is
// shown, and how a relative link under the blob route maps back to a file.

import type { PullRequestFile, PullRequestRevision } from "../shared/github-contract";
import type { ViewMode } from "../shared/types";
import { isViewableImageName } from "../shared/viewable-image";

export type FileKind = "markdown" | "asciidoc" | "text" | "image";

export function kindOfPath(path: string): FileKind {
  const lower = path.toLowerCase();
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "markdown";
  if (lower.endsWith(".adoc") || lower.endsWith(".asciidoc")) return "asciidoc";
  if (isViewableImageName(path.split("/").at(-1) ?? path)) return "image";
  return "text";
}

// Rendered for documents, Source for every text file, Diff when the pull
// request changes the file. Images show as images, with no chooser.
export function fileViewModes(kind: FileKind, changed: boolean): ViewMode[] {
  if (kind === "image") return [];
  const modes: ViewMode[] = kind === "markdown" || kind === "asciidoc" ? ["rendered", "source"] : ["source"];
  if (changed) modes.push("diff");
  return modes;
}

// The shared preference when the file offers it, else its first mode (the
// preference itself is kept for the next file that offers it).
export function effectiveViewMode(modes: readonly ViewMode[], preferred: ViewMode): ViewMode | null {
  if (modes.length === 0) return null;
  return modes.includes(preferred) ? preferred : modes[0]!;
}

// A deleted file has no head (its base is shown); an added one has no base.
export function effectiveRevision(status: PullRequestFile["status"] | null, requested: PullRequestRevision): PullRequestRevision {
  if (status === "removed") return "base";
  if (status === "added") return "head";
  return requested;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// `api/github/pr-blob/<repoKey>/<n>/<oid>/<path…>` (still percent-encoded),
// the target of a rendered file's relative link. Null for anything else.
export function parseBlobLink(sessionPath: string): { number: number; oid: string; path: string } | null {
  const parts = sessionPath.replace(/^\/+/, "").split("/");
  const [api, github, blob, key, number, oid, ...rest] = parts;
  if (api !== "api" || github !== "github" || blob !== "pr-blob" || !key || !number || !/^\d{1,9}$/.test(number) || !oid || rest.length === 0) return null;
  let path: string;
  try {
    path = rest.map(segment => decodeURIComponent(segment)).join("/");
  } catch {
    return null;
  }
  if (path.split("/").some(segment => segment === "" || segment === "." || segment === "..")) return null;
  return { number: Number(number), oid, path };
}
