// Hub workspace switcher — the way back out of a session. When the SPA is
// served through a uatu hub (base path /s/<id>/, hub APIs answering at the
// origin root), the sidebar header grows a chip naming the current
// workspace whose dropdown links to the hub dashboard and to every other
// workspace. Everywhere else — local `uatu serve`, the desktop wrapper, the
// e2e harness — the probe fails or the base path is "/", and the control
// stays hidden with zero cost beyond one fetch in hub-shaped sessions.
//
// The hub API URLs here are deliberately origin-rooted, NOT appUrl()-based:
// they belong to the hub (outside the session's base path), which is why
// this file is allowlisted in shared/app-url-discipline.test.ts.

import { appBasePath } from "../shared/app-url";

export type HubWorkspaceSummary = {
  id: string;
  running: boolean;
};

// Extracts the workspace id from a hub-shaped base path ("/s/uatu/" →
// "uatu"). Null for the default "/" and for prefixes that are not
// hub-session-shaped.
export function workspaceIdFromBasePath(basePath: string): string | null {
  const match = /^\/s\/([^/]+)\/$/.exec(basePath);
  if (!match) {
    return null;
  }
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    return null;
  }
}

// The chip's indicator class for the current workspace. Live only when the
// hub reports the session running: a stopped session's page can outlive its
// server (back/forward-cache restores, a stop from the dashboard), and a
// hard-coded live dot there contradicts both reality and the menu. Unknown
// (absent from the list, e.g. forgotten) reads as not running.
export function chipDotClass(workspaces: HubWorkspaceSummary[], currentId: string | null): string {
  const current = workspaces.find(workspace => workspace.id === currentId);
  return current?.running ? "indicator-dot is-live" : "indicator-dot";
}

// Menu order: the current workspace first, then other running sessions,
// then stopped workspaces, alphabetical within each group.
export function sortHubWorkspaces(
  workspaces: HubWorkspaceSummary[],
  currentId: string | null,
): HubWorkspaceSummary[] {
  const rank = (workspace: HubWorkspaceSummary): number => {
    if (workspace.id === currentId) return 0;
    return workspace.running ? 1 : 2;
  };
  return [...workspaces].sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
}

// Whether the switcher offers a sign-out entry. A `--local` hub has no login
// — its /login and /logout routes don't even exist — so the entry could only
// lead to a 404.
export function showsSignOut(hub: { local: boolean }): boolean {
  return !hub.local;
}

// Signs out by submitting a real form POST, exactly as the hub dashboard's
// Sign out does, rather than by firing a background request and replacing the
// page. Two reasons: a native wrapper that owns hub credentials (UatuCode
// Desktop keeps them in the Keychain) can observe a navigation but not a
// background fetch, so this is what lets it revoke its own copies; and the
// page is never replaced before the request that clears the cookie has
// actually gone out. Same-origin form posts send Origin, satisfying the hub's
// CSRF check the same way the dashboard's does.
export function submitHubSignOut(doc: Document): void {
  const form = doc.createElement("form");
  form.method = "post";
  form.action = "/logout";
  form.hidden = true;
  doc.body.appendChild(form);
  form.submit();
}

export type HubStateSummary = {
  workspaces: HubWorkspaceSummary[];
  // Trusted loopback mode (`uatu hub --local`): no login exists, so no
  // sign-out entry belongs in the menu.
  local: boolean;
};

export function parseHubState(payload: unknown): HubStateSummary | null {
  const record = payload as { workspaces?: unknown; local?: unknown } | null;
  const workspaces = record?.workspaces;
  if (!Array.isArray(workspaces)) {
    return null;
  }
  return {
    local: record?.local === true,
    workspaces: workspaces
      .filter(
        (entry): entry is { id: string; running: boolean } =>
          typeof entry === "object" &&
          entry !== null &&
          typeof (entry as { id?: unknown }).id === "string" &&
          typeof (entry as { running?: unknown }).running === "boolean",
      )
      .map(({ id, running }) => ({ id, running })),
  };
}

async function fetchHubState(): Promise<HubStateSummary | null> {
  try {
    const response = await fetch("/api/hub/state");
    if (!response.ok) {
      return null;
    }
    return parseHubState(await response.json());
  } catch {
    return null;
  }
}

export function initHubNav(): void {
  const control = document.querySelector<HTMLDivElement>("#hub-control");
  const toggle = document.querySelector<HTMLButtonElement>("#hub-toggle");
  const menu = document.querySelector<HTMLDivElement>("#hub-menu");
  const label = document.querySelector<HTMLSpanElement>("#hub-current");
  if (!control || !toggle || !menu || !label) {
    return;
  }

  const currentId = workspaceIdFromBasePath(appBasePath());
  if (currentId === null) {
    return;
  }

  let latest: HubWorkspaceSummary[] = [];
  let hubIsLocal = false;

  const chipDot = toggle.querySelector<HTMLSpanElement>(".indicator-dot");
  const updateChipDot = () => {
    if (chipDot) {
      chipDot.className = chipDotClass(latest, currentId);
    }
  };

  const renderMenu = () => {
    menu.replaceChildren();

    const dashboard = document.createElement("a");
    dashboard.className = "hub-menu-item";
    dashboard.href = "/";
    const dashboardLabel = document.createElement("span");
    dashboardLabel.className = "hub-menu-label";
    dashboardLabel.textContent = "Hub dashboard";
    dashboard.appendChild(dashboardLabel);
    menu.appendChild(dashboard);

    if (latest.length > 0) {
      menu.appendChild(Object.assign(document.createElement("hr"), { className: "hub-menu-divider" }));
    }

    for (const workspace of sortHubWorkspaces(latest, currentId)) {
      const item = document.createElement("a");
      item.className = "hub-menu-item";
      item.href = `/s/${encodeURIComponent(workspace.id)}/`;
      if (workspace.id === currentId) {
        item.setAttribute("aria-current", "true");
      }
      const dot = document.createElement("span");
      dot.className = `indicator-dot${workspace.running ? " is-live" : ""}`;
      dot.setAttribute("aria-hidden", "true");
      item.appendChild(dot);
      const itemLabel = document.createElement("span");
      itemLabel.className = "hub-menu-label";
      itemLabel.textContent = workspace.id;
      item.appendChild(itemLabel);
      if (!workspace.running) {
        const state = document.createElement("span");
        state.className = "hub-menu-state";
        state.textContent = "stopped";
        item.appendChild(state);
      }
      menu.appendChild(item);
    }

    if (showsSignOut({ local: hubIsLocal })) {
      menu.appendChild(Object.assign(document.createElement("hr"), { className: "hub-menu-divider" }));
      const signOut = document.createElement("a");
      signOut.className = "hub-menu-item";
      signOut.href = "/login";
      const signOutLabel = document.createElement("span");
      signOutLabel.className = "hub-menu-label";
      signOutLabel.textContent = "Sign out";
      signOut.appendChild(signOutLabel);
      signOut.addEventListener("click", event => {
        event.preventDefault();
        submitHubSignOut(document);
      });
      menu.appendChild(signOut);
    }
  };

  const close = () => {
    toggle.setAttribute("aria-expanded", "false");
    menu.hidden = true;
  };

  // One probe decides hub-ness; only a hub origin answers this at the root.
  void fetchHubState().then(state => {
    if (state === null) {
      return;
    }
    latest = state.workspaces;
    hubIsLocal = state.local;
    label.textContent = currentId;
    updateChipDot();
    control.hidden = false;

    // A back/forward-cache restore revives this page exactly as it was —
    // possibly for a session that was stopped in the meantime. Re-fetch so
    // the chip tells the truth before the user opens the menu.
    window.addEventListener("pageshow", event => {
      if (!event.persisted) {
        return;
      }
      void fetchHubState().then(fresh => {
        if (fresh !== null) {
          latest = fresh.workspaces;
          hubIsLocal = fresh.local;
          updateChipDot();
        }
      });
    });

    toggle.addEventListener("click", () => {
      const expanded = toggle.getAttribute("aria-expanded") === "true";
      if (expanded) {
        close();
        return;
      }
      renderMenu();
      toggle.setAttribute("aria-expanded", "true");
      menu.hidden = false;
      // Refresh in the background so the open menu reflects sessions
      // started or stopped elsewhere; re-render only while still open.
      void fetchHubState().then(fresh => {
        if (fresh !== null) {
          latest = fresh.workspaces;
          hubIsLocal = fresh.local;
          updateChipDot();
          if (!menu.hidden) {
            renderMenu();
          }
        }
      });
    });

    document.addEventListener("click", event => {
      if (menu.hidden) {
        return;
      }
      if (event.target instanceof Node && !control.contains(event.target)) {
        close();
      }
    });

    document.addEventListener("keydown", event => {
      if (event.key === "Escape" && !menu.hidden) {
        close();
        toggle.focus();
      }
    });
  });
}
