// Progressive-web-app glue: manifest / icon `<link>` injection and the
// pass-through service-worker registration. Both are tiny, runtime-side
// concerns that don't really belong in `app.ts` — moved here so the shell
// keeps the PWA surface together and the caller controls when each runs.

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

// Register the pass-through service worker so Edge/Chrome/Brave surface the
// PWA install affordance. Failures are logged once and otherwise ignored —
// uatu does not depend on the worker for any feature, only its presence.
export function registerServiceWorker() {
  if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      // Scope equals the base path so a prefixed session never claims (or
      // clobbers) its origin's root scope or a sibling session's.
      navigator.serviceWorker
        .register(appUrl("/sw.js"), { scope: appBasePath() })
        .catch(error => {
          console.warn("uatu: service worker registration failed", error);
        });
    });
  }
}
