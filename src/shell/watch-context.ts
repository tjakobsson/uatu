import { applyWatchContext, type WatchContext } from "../shared/watch-context";
import type { Scope } from "../shared/types";
import { appState } from "./state";

export function currentWatchContext(): WatchContext {
  return { scope: appState.scope, compareTarget: appState.compareTarget };
}

export function contextualAppUrl(appPath: string, context: WatchContext = currentWatchContext()): string {
  const url = new URL(appPath, window.location.origin);
  applyWatchContext(url, context);
  return `${url.pathname}${url.search}`;
}

export function setClientScope(scope: Scope): void {
  appState.scope = scope;
}
