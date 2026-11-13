import {
  DEFAULT_COMPARE_TARGET,
  isCompareTarget,
  type CompareTarget,
  type Scope,
} from "./types";

export type WatchContext = {
  showIgnored?: boolean;
  scope: Scope;
  compareTarget: CompareTarget;
};

export const DEFAULT_WATCH_CONTEXT: WatchContext = {
  scope: { kind: "folder" },
  compareTarget: DEFAULT_COMPARE_TARGET,
};

export type WatchContextParseResult =
  | { context: WatchContext }
  | { error: string };

export function parseWatchContext(params: URLSearchParams): WatchContextParseResult {
  const rawIgnored = params.get("showIgnored");
  if (rawIgnored !== null && rawIgnored !== "0" && rawIgnored !== "1") return { error: "invalid showIgnored" };
  const visibility = rawIgnored === null ? {} : { showIgnored: rawIgnored === "1" };
  const rawTarget = params.get("compareTarget");
  if (rawTarget !== null && !isCompareTarget(rawTarget)) {
    return { error: "invalid compare target" };
  }
  const compareTarget = rawTarget ?? DEFAULT_COMPARE_TARGET;
  const rawScope = params.get("scope");
  if (rawScope === null || rawScope === "folder") {
    return { context: { scope: { kind: "folder" }, compareTarget, ...visibility } };
  }
  if (rawScope !== "file") return { error: "invalid scope" };
  const documentId = params.get("documentId");
  if (!documentId) return { error: "missing documentId" };
  return { context: { scope: { kind: "file", documentId }, compareTarget, ...visibility } };
}

export function applyWatchContext(url: URL, context: WatchContext): URL {
  url.searchParams.set("showIgnored", context.showIgnored === false ? "0" : "1");
  url.searchParams.set("compareTarget", context.compareTarget);
  url.searchParams.set("scope", context.scope.kind);
  if (context.scope.kind === "file") {
    url.searchParams.set("documentId", context.scope.documentId);
  } else {
    url.searchParams.delete("documentId");
  }
  return url;
}
