// Progressive-web-app glue: manifest / icon `<link>` injection. A tiny,
// runtime-side concern that doesn't really belong in `app.ts` — moved here
// so the shell keeps the PWA surface together and the caller controls when
// it runs. There is deliberately no service worker: uatu has nothing useful
// to do offline (the server must be running), and modern Chromium surfaces
// its install affordance from a valid manifest alone — which is why the other
// half of this file exists, to clear the workers older versions installed.

import { appBasePath, appUrl } from "../shared/app-url";

// Inject PWA links at runtime rather than declaring them in index.html. Bun's
// HTML bundler tries to resolve every <link href="..."> as a build-time
// asset, but `/manifest.webmanifest` and `/assets/icon-*.png` are routes
// served by the uatu server — there's no source file to bundle. Adding them
// from JS bypasses the bundler entirely.
export function injectPwaLinks() {
  if (typeof document === "undefined") return;
  const head = document.head;
  if (!head) return;
  if (head.querySelector('link[rel="manifest"]')) return;
  const manifest = document.createElement("link");
  manifest.rel = "manifest";
  manifest.href = appUrl("/manifest.webmanifest");
  // Manifest requests omit cookies unless the link opts into credentials —
  // behind the hub's cookie gate an anonymous manifest fetch is a
  // guaranteed 401. Same-origin locally, so this changes nothing there.
  manifest.crossOrigin = "use-credentials";
  head.appendChild(manifest);
  for (const size of ["192", "512"] as const) {
    const icon = document.createElement("link");
    icon.rel = "icon";
    icon.type = "image/png";
    icon.setAttribute("sizes", `${size}x${size}`);
    icon.href = appUrl(`/assets/icon-${size}.png`);
    head.appendChild(icon);
  }
}

// --- Legacy service worker cleanup ------------------------------------------
//
// TEMPORARY, and deliberately so. Deleting the registration call (and the
// route it registered) stops NEW installs; it does nothing about the ones
// already out there. A browser profile that loaded uatu before 0.5.0 still
// has the pass-through worker installed and controlling its scope, which both
// fails the pwa-install contract ("getRegistrations() resolves to an empty
// list") and leaves a stale interceptor sitting in front of every request.
// Only an explicit unregister() removes it.
//
// Remove this section once 0.7.0 ships — by then no reachable profile can
// predate the removal, and what is left is a call that never matches anything.

// The path every uatu worker was registered from. Matched as a suffix so the
// two registrations that could exist are both recognized: an origin-root one
// ("/sw.js", from a direct load) and a base-path-mounted one
// ("/s/<slug>/sw.js", from a hub session).
const LEGACY_WORKER_SCRIPT_PATH = "/sw.js";

// The facts about a registration the match is made on. A plain object rather
// than a ServiceWorkerRegistration so the rule can be tested without a service
// worker environment — which is the only way the negative cases get tested at
// all.
export type LegacyWorkerFacts = {
  scope: string;
  scriptURL: string | null;
};

// Whether a registration is one uatu left behind.
//
// Both conditions are required, and the second is what makes this safe. The
// hub serves several apps' worth of paths from one origin, so "unregister
// everything at the origin root" would collect a neighbour's worker. Scope
// alone is not identification; scope plus the script path uatu actually
// registered is.
//
// The origin root counts even for a session under a base path: a worker scoped
// to "/" controls the session's pages too, so leaving it installed would leave
// the contract broken at exactly the URL being loaded.
export function isLegacyUatuWorker(facts: LegacyWorkerFacts, basePath: string): boolean {
  if (!facts.scriptURL) {
    return false;
  }
  const scope = pathnameOf(facts.scope);
  const script = pathnameOf(facts.scriptURL);
  if (scope === null || script === null) {
    return false;
  }
  if (scope !== "/" && scope !== withTrailingSlash(basePath)) {
    return false;
  }
  return script.endsWith(LEGACY_WORKER_SCRIPT_PATH);
}

// Unregister service workers left behind by a uatu older than 0.5.0.
//
// Fire-and-forget on purpose: nothing waits on it, and a rejected unregister()
// is not something the reader can act on. `navigator.serviceWorker` is absent
// outside a secure context — uatu is routinely served over plain HTTP to a LAN
// address, which is not one — so an unguarded access here would be a new way
// for boot to fail, on behalf of a cleanup most profiles do not need.
export function unregisterLegacyServiceWorkers(): void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  const container = navigator.serviceWorker;
  if (typeof container?.getRegistrations !== "function") return;
  const basePath = appBasePath();
  void container
    .getRegistrations()
    .then(registrations => {
      for (const registration of registrations) {
        // `active` is the usual case; the other two cover a worker caught
        // mid-install, which would otherwise activate right after this ran.
        const worker = registration.active ?? registration.waiting ?? registration.installing;
        const facts = { scope: registration.scope, scriptURL: worker?.scriptURL ?? null };
        if (!isLegacyUatuWorker(facts, basePath)) continue;
        void registration.unregister().catch(() => {});
      }
    })
    .catch(() => {});
}

function pathnameOf(value: string): string | null {
  try {
    return new URL(value).pathname;
  } catch {
    return null;
  }
}

// Scopes are directory URLs and normalized base paths already trail with "/",
// but the comparison should not depend on a caller having normalized.
function withTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

