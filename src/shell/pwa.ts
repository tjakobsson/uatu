// Progressive-web-app glue: manifest / icon `<link>` injection. A tiny,
// runtime-side concern that doesn't really belong in `app.ts` — moved here
// so the shell keeps the PWA surface together and the caller controls when
// it runs. There is deliberately no service worker: uatu has nothing useful
// to do offline (the server must be running), and modern Chromium surfaces
// its install affordance from a valid manifest alone.

import { appUrl } from "../shared/app-url";

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

