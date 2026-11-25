// Remembers where this Hub session page is, for the Hub's "← Back to …"
// control on its dashboard and Settings (hub/hub-return.ts reads it). Written
// while the page is shown: when the switcher learns it runs under a Hub, on
// Back/Forward, when the page comes back, and as it is hidden or left. The
// last one wins, so a tab hidden behind another never overwrites the one in
// front. Nothing is written outside a Hub, or when the Hub named no user.

import { pullRequestStore } from "../github/pull-request-store";
import { appBasePath } from "../shared/app-url";
import { stripBasePath } from "../shared/base-path";
import { HUB_USER_SCOPE_META, hubReturnStorageKey, type HubReturnLocation } from "../shared/hub-return";

// What is open, from the URL: a pull request (`#642 Title`), a commit, or a
// document's path. Null for the workspace's root.
export function hubLocationDetail(url: URL, basePath: string, pullRequestTitle: (number: number) => string | null): string | null {
  const pr = url.searchParams.get("pr");
  if (pr && /^[1-9]\d*$/.test(pr)) {
    const title = pullRequestTitle(Number(pr));
    return title ? `#${pr} ${title}` : `#${pr}`;
  }
  const commit = url.searchParams.get("commit");
  if (commit) return `commit ${commit.slice(0, 7)}`;
  const rest = stripBasePath(url.pathname, basePath);
  if (!rest || rest === "/") return null;
  try {
    return decodeURIComponent(rest.slice(1));
  } catch {
    return rest.slice(1);
  }
}

export function hubLocationLabel(name: string, detail: string | null): string {
  return detail ? `${name} · ${detail}` : name;
}

export function hubReturnLocation(workspace: string, name: string, url: URL, basePath: string, pullRequestTitle: (number: number) => string | null): HubReturnLocation {
  return {
    workspace,
    name,
    label: hubLocationLabel(name, hubLocationDetail(url, basePath, pullRequestTitle)),
    href: `${url.pathname}${url.search}${url.hash}`,
  };
}

export function rememberHubLocation(workspace: string, workspaceName: () => string): void {
  const scope = document.querySelector(`meta[name="${HUB_USER_SCOPE_META}"]`)?.getAttribute("content");
  if (!scope) return;
  const remember = () => {
    const location = hubReturnLocation(workspace, workspaceName(), new URL(window.location.href), appBasePath(),
      number => pullRequestStore.detail(number)?.summary.title ?? null);
    try {
      window.localStorage.setItem(hubReturnStorageKey(scope), JSON.stringify(location));
    } catch {
      // Best effort: storage may be disabled or full.
    }
  };
  const rememberIfShown = () => {
    if (document.visibilityState === "visible") remember();
  };
  rememberIfShown();
  window.addEventListener("pageshow", rememberIfShown);
  window.addEventListener("popstate", rememberIfShown);
  window.addEventListener("pagehide", rememberIfShown);
  // Hidden: it was shown until now. Visible again: it is shown.
  document.addEventListener("visibilitychange", remember);
}
