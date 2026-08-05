import {
  DEFAULT_COMPARE_TARGET,
  isReviewCompareTarget,
  type ReviewCompareTarget,
  type Scope,
} from "./types";

export type WatchContext = {
  scope: Scope;
  compareTarget: ReviewCompareTarget;
};

export const DEFAULT_WATCH_CONTEXT: WatchContext = {
  scope: { kind: "folder" },
  compareTarget: DEFAULT_COMPARE_TARGET,
};

export type WatchContextParseResult =
  | { context: WatchContext }
  | { error: string };

export function parseWatchContext(params: URLSearchParams): WatchContextParseResult {
  const rawTarget = params.get("compareTarget");
  if (rawTarget !== null && !isReviewCompareTarget(rawTarget)) {
    return { error: "invalid compare target" };
  }
  const compareTarget = rawTarget ?? DEFAULT_COMPARE_TARGET;
  const rawScope = params.get("scope");
  if (rawScope === null || rawScope === "folder") {
    return { context: { scope: { kind: "folder" }, compareTarget } };
  }
  if (rawScope !== "file") return { error: "invalid scope" };
  const documentId = params.get("documentId");
  if (!documentId) return { error: "missing documentId" };
  return { context: { scope: { kind: "file", documentId }, compareTarget } };
}

export function applyWatchContext(url: URL, context: WatchContext): URL {
  url.searchParams.set("compareTarget", context.compareTarget);
  url.searchParams.set("scope", context.scope.kind);
  if (context.scope.kind === "file") {
    url.searchParams.set("documentId", context.scope.documentId);
  } else {
    url.searchParams.delete("documentId");
  }
  return url;
}
