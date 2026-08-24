// Server-rendered HTML for the hub: login, dashboard, and the
// stopped/unknown-session pages. Deliberately framework-free, but NOT a
// separate theme: these pages speak uatu's design system — the SPA's
// `light-dark()` token palette under `color-scheme: light dark`, the same
// sans body with monospace reserved for paths, the inline brand logo with
// its dark-scheme retint and blinking eye, pane-style section headers, and
// the indicator-dot idiom for running state.

import logoAssetPath from "../assets/uatu-logo.svg" with { type: "file" };

import { Buffer } from "node:buffer";

import { escapeHtml } from "../shared/html";
import { LOCAL_CREDENTIAL_ASSIGNMENT_WARNING, SCP_REMOTE_PATTERN } from "./credential-context";

// Inline the brand SVG (the file ships a fixed navy fill; the dark-scheme
// retint below only reaches presentation attributes when the markup is
// inline, exactly like the SPA's index.html). Read through the embedded
// asset path — the `type: "file"` import is the one mechanism that works
// identically from source and inside the compiled binary.
const logoSvgSource = await Bun.file(logoAssetPath).text();
const svgStart = logoSvgSource.indexOf("<svg");
if (svgStart < 0) {
  throw new Error("uatu-logo.svg: no <svg> root found — bundled asset is corrupt");
}
const BRAND_LOGO_SVG = logoSvgSource
  .slice(svgStart)
  .replace("<svg ", '<svg class="brand-logo" aria-hidden="true" focusable="false" ');

// Tokens and chrome copied from src/styles.css — the same names, the same
// light-dark() values — so the hub renders as a uatu surface on both
// schemes. Keep in sync with the SPA when the palette evolves.
const SHARED_STYLE = `
  :root {
    color-scheme: light dark;
    font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    background: light-dark(#ffffff, #0d1117);
    color: light-dark(#24292f, #e6edf3);
    --border-soft: light-dark(#e6eaef, #21262d);
    --border-medium: light-dark(#d0d7de, #30363d);
    --text-subtle: light-dark(#57606a, #8b949e);
    --text-strong: light-dark(#1f2328, #e6edf3);
    --accent: light-dark(#0969da, #4493f8);
    --accent-soft: light-dark(#ddf4ff, #121d2f);
    --surface: light-dark(#ffffff, #0d1117);
    --surface-raised: light-dark(#ffffff, #161b22);
    --surface-subtle: light-dark(#f6f8fa, #161b22);
    --surface-muted: light-dark(#f3f5f7, #161b22);
    --success: light-dark(#2da44e, #3fb950);
    --danger: light-dark(#cf222e, #f85149);
    --attention: light-dark(#bf8700, #d29922);
    --pane-header-bg: light-dark(#fbfcfd, #161b22);
    --mono-font-family: "Hack Nerd Font Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  @font-face {
    font-family: "Hack Nerd Font Mono";
    src: local("Hack Nerd Font Mono"), url("/hub-assets/mono.woff2") format("woff2");
    font-display: swap;
  }
  * { box-sizing: border-box; }
  body { margin: 0; font-size: 14px; line-height: 1.5; min-height: 100vh; }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }

  /* UatuCode Desktop serves these pages in a full-height WebView under a
     transparent titlebar/tab bar and announces the covered height as
     --titlebar-inset on <html>; pad below it so nothing renders under the
     native chrome. Plain browsers see the 0px default. */
  main { position: relative; max-width: 680px; margin: 0 auto; padding: calc(2.5rem + var(--titlebar-inset, 0px)) 1.25rem 4rem; }
  .hub-nav { display: flex; align-items: center; justify-content: center; gap: 0.35rem; margin: -1.25rem 0 1.5rem; }
  .hub-nav a { padding: 0.3rem 0.65rem; border-radius: 0.375rem; color: var(--text-subtle); font-size: 0.78rem; font-weight: 600; }
  .hub-nav a:hover { background: var(--surface-muted); color: var(--text-strong); text-decoration: none; }
  .hub-nav a[aria-current="page"] { background: var(--accent-soft); color: var(--accent); }
  .sign-out { margin: 0; }
  .sign-out button {
    background: transparent;
    border-color: transparent;
    color: var(--text-subtle);
    font-weight: 500;
  }
  .sign-out button:hover { color: var(--text-strong); background: var(--surface-muted); }

  /* Brand header — the watcher, centered, wordmark beneath. */
  .hub-header { display: flex; flex-direction: column; align-items: center; gap: 0.6rem; margin: 0.5rem 0 2rem; }
  .brand-logo { display: block; width: 76px; height: 76px; flex-shrink: 0; }
  .brand-logo path[fill="#0a1c38"] { fill: light-dark(#0a1c38, #dbe4f0); }
  .brand-logo #eye {
    transform-box: view-box;
    transform-origin: 404px 415px;
    animation: blink 10s infinite;
    animation-play-state: paused;
  }
  .hub-header:hover .brand-logo #eye { animation-play-state: running; }
  @keyframes blink {
    0%, 96%, 100% { transform: scaleY(1); }
    97%, 98%      { transform: scaleY(0.06); }
    99%           { transform: scaleY(1); }
  }
  @media (prefers-reduced-motion: reduce) { .brand-logo #eye { animation: none; } }
  .brand-wordmark { margin: 0; font-size: 1.35rem; font-weight: 700; letter-spacing: -0.01em; color: var(--text-strong); }

  /* Panes — mirrors .sidebar-pane/.pane-header. */
  .pane {
    border: 1px solid var(--border-soft);
    border-radius: 0.5rem;
    background: var(--surface);
    overflow: hidden;
    margin-bottom: 1.25rem;
  }
  .pane-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 0.5rem 1rem;
    border-bottom: 1px solid var(--border-soft);
    background: var(--pane-header-bg);
  }
  .pane-header h2 {
    margin: 0;
    color: var(--text-strong);
    font-size: 0.78rem;
    font-weight: 700;
    line-height: 1.2;
  }
  .pane-meta {
    color: var(--text-subtle);
    font-size: 0.72rem;
    font-family: var(--mono-font-family);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Rows inside a pane. */
  .row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.6rem 1rem;
    border-bottom: 1px solid var(--border-soft);
  }
  .row:last-child { border-bottom: 0; }
  .row:hover { background: var(--surface-subtle); }
  .row-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 0.1rem; }
  .row-title { display: flex; align-items: center; gap: 0.5rem; min-width: 0; }
  .row-title a, .row-title strong {
    font-size: 0.9rem;
    font-weight: 600;
    color: var(--text-strong);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .row-title a:hover { color: var(--accent); text-decoration: none; }
  .row-path {
    color: var(--text-subtle);
    font-size: 0.72rem;
    font-family: var(--mono-font-family);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .row-detail { color: var(--text-subtle); font-size: 0.72rem; }
  .row-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 0.4rem; }

  /* Indicator dot — mirrors .indicator-dot/.connection-state. */
  .indicator-dot {
    display: inline-block;
    width: 0.55rem;
    height: 0.55rem;
    border-radius: 999px;
    background: var(--border-medium);
    flex-shrink: 0;
  }
  .indicator-dot.is-live {
    background: var(--success);
    animation: uatu-pulse 1.8s ease-in-out infinite;
  }
  @keyframes uatu-pulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50%      { opacity: 0.45; transform: scale(1.25); }
  }
  @media (prefers-reduced-motion: reduce) { .indicator-dot.is-live { animation: none; } }

  /* Chips for git status. */
  .chip {
    flex-shrink: 0;
    font-size: 0.68rem;
    font-weight: 600;
    padding: 0.05rem 0.45rem;
    border-radius: 999px;
    border: 1px solid var(--border-medium);
    color: var(--text-subtle);
  }
  .chip.is-warn { border-color: var(--attention); color: var(--attention); }

  /* Buttons — quiet by default, like the SPA's chrome. */
  button {
    font: inherit;
    font-size: 0.78rem;
    font-weight: 600;
    color: var(--text-strong);
    background: var(--surface);
    border: 1px solid var(--border-medium);
    border-radius: 0.375rem;
    padding: 0.3rem 0.75rem;
    cursor: pointer;
    flex-shrink: 0;
    transition: background-color 0.15s ease, color 0.15s ease, border-color 0.15s ease;
  }
  button:hover { background: var(--surface-muted); }
  button:disabled { opacity: 0.5; cursor: default; }
  button:disabled:hover { background: var(--surface); filter: none; }
  button.primary { background: var(--accent); border-color: var(--accent); color: #ffffff; }
  button.primary:hover { filter: brightness(1.08); background: var(--accent); }
  button.danger { color: var(--danger); }
  button.danger:hover { border-color: var(--danger); background: var(--surface-muted); }

  input[type="text"], input[type="password"], textarea, select {
    font: inherit;
    font-size: 0.85rem;
    color: var(--text-strong);
    background: var(--surface);
    border: 1px solid var(--border-medium);
    border-radius: 0.375rem;
    padding: 0.35rem 0.6rem;
    width: 100%;
  }
  textarea { min-height: 6rem; resize: vertical; font-family: var(--mono-font-family); }
  select { width: 100%; }
  input:focus-visible, button:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }

  .form-row { display: flex; gap: 0.5rem; padding: 0.6rem 1rem; }
  .form-stack { display: grid; gap: 0.55rem; padding: 0.75rem 1rem; }
  .form-stack label, .field-label { color: var(--text-subtle); font-size: 0.72rem; font-weight: 600; }
  .form-stack label > input, .form-stack label > textarea, .form-stack label > select { display: block; margin-top: 0.2rem; }
  .choice-row { display: flex; flex-wrap: wrap; gap: 0.75rem; align-items: center; }
  .choice-row label { display: inline-flex; gap: 0.35rem; align-items: center; color: var(--text-strong); }
  .credential-create { border-top: 1px solid var(--border-soft); }
  .credential-create summary { cursor: pointer; padding: 0.6rem 1rem; font-size: 0.78rem; font-weight: 600; }
  .credential-card { border-bottom: 1px solid var(--border-soft); }
  .credential-card:last-child { border-bottom: 0; }
  .credential-card > summary { cursor: pointer; list-style-position: inside; padding: 0.75rem 1rem; }
  .credential-head { display: inline-flex; width: calc(100% - 1.25rem); gap: 0.5rem; align-items: center; vertical-align: middle; }
  .credential-head strong { flex: 1; min-width: 0; overflow-wrap: anywhere; }
  .credential-state { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 0.35rem; }
  .credential-body { padding: 0 1rem 0.85rem; }
  .credential-section { border-top: 1px solid var(--border-soft); padding-top: 0.65rem; margin-top: 0.65rem; }
  .credential-section h3 { margin: 0 0 0.45rem; color: var(--text-strong); font-size: 0.76rem; }
  .credential-summary { margin: 0.25rem 0 0; color: var(--text-subtle); font-size: 0.72rem; overflow-wrap: anywhere; }
  .readiness { display: flex; flex-wrap: wrap; gap: 0.35rem; margin-top: 0.5rem; }
  .chip.is-ready { border-color: var(--success); color: var(--success); }
  .credential-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 0.4rem; margin-top: 0.65rem; }
  .credential-actions .credential-unlock { flex: 1 0 100%; margin-top: 0.15rem; }
  .inline-form { display: flex; flex-wrap: wrap; gap: 0.4rem; margin-top: 0.55rem; align-items: end; }
  .inline-form label { flex: 1 1 9rem; color: var(--text-subtle); font-size: 0.72rem; font-weight: 600; }
  .inline-form input, .inline-form select { display: block; margin-top: 0.2rem; }
  .inline-form input:not([type="file"]), .inline-form select, .inline-form > button { box-sizing: border-box; height: 2.15rem; }
  .assignment-row { display: flex; align-items: center; gap: 0.75rem; padding: 0.45rem 0; border-bottom: 1px solid var(--border-soft); }
  .assignment-row:last-of-type { border-bottom: 0; }
  .assignment-row .row-main { flex: 1; }
  .assignment-add { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); align-items: end; padding: 0; margin-top: 0.75rem; }
  .assignment-add h4 { grid-column: 1 / -1; margin: 0; font-size: 0.72rem; color: var(--text-subtle); }
  .assignment-add .assignment-help { grid-column: 1 / -1; margin: 0; color: var(--text-subtle); font-size: 0.7rem; }
  .assignment-add > button { justify-self: start; }
  .workspace-credential-section { padding: 0.75rem 1rem; border-top: 1px solid var(--border-soft); background: var(--surface-subtle); }
  .workspace-credential-section > summary { cursor: pointer; color: var(--text-strong); font-size: 0.78rem; font-weight: 700; }
  .workspace-credential-section > .credential-summary { margin-left: 1.1rem; }
  .workspace-assignment-list { margin-top: 0.6rem; border: 1px solid var(--border-soft); border-radius: 0.375rem; background: var(--surface); }
  .workspace-assignment-list .assignment-row { padding: 0.55rem 0.65rem; }
  .assignment-pills { display: flex; flex-wrap: wrap; gap: 0.35rem; margin-top: 0.2rem; }
  .assignment-pill { display: inline-flex; align-items: center; gap: 0.25rem; padding: 0.1rem 0.4rem; border: 1px solid var(--border-medium); border-radius: 999px; color: var(--text-subtle); font-size: 0.68rem; }
  .assignment-pill button { border: 0; padding: 0 0.1rem; color: var(--danger); background: transparent; line-height: 1; }
  .workspace-assignment-form { grid-template-columns: repeat(4, minmax(0, 1fr)); }
  .workspace-assignment-form input:disabled { color: var(--text-subtle); background: var(--surface-muted); }
  .credential-dialog { width: min(30rem, calc(100vw - 2rem)); padding: 0; color: var(--text-strong); background: var(--surface-raised); border: 1px solid var(--border-medium); border-radius: 0.5rem; box-shadow: 0 1rem 3rem rgba(0, 0, 0, 0.3); }
  .credential-dialog::backdrop { background: rgba(0, 0, 0, 0.45); }
  .credential-dialog h2 { margin: 0; font-size: 0.9rem; }
  .credential-dialog .form-stack { padding: 1rem; }
  .credential-dialog-actions { display: flex; justify-content: flex-end; gap: 0.5rem; }
  .advisory { display: flex; align-items: flex-start; gap: 0.75rem; margin: 0; padding: 0.75rem 1rem; border-bottom: 1px solid var(--border-soft); background: light-dark(#fff8c5, #2d2405); color: var(--text-strong); font-size: 0.76rem; }
  .advisory span { flex: 1; }
  .advisory button { background: transparent; }
  .paste-option { border-top: 1px solid var(--border-soft); padding-top: 0.45rem; }
  .paste-option summary { cursor: pointer; color: var(--text-subtle); font-size: 0.72rem; font-weight: 600; }
  .paste-option textarea { margin-top: 0.35rem; }
  .secret-paste-heading { display: flex; justify-content: space-between; align-items: center; gap: 0.5rem; }
  textarea.secret-paste-masked { -webkit-text-security: disc; }
  .restart-required { color: var(--attention); font-weight: 600; }
  .tool-row { align-items: flex-start; }
  .tool-controls { flex: 1; min-width: 0; }
  .tool-controls .inline-form { margin-top: 0.35rem; }
  .tool-results { margin-top: 0.3rem; color: var(--text-subtle); font-size: 0.7rem; }
  .copy-status { color: var(--success); font-size: 0.72rem; align-self: center; }
  .clone-panel { border-top: 1px solid var(--border-soft); background: var(--surface-subtle); }
  .clone-status { display: flex; align-items: center; gap: 0.5rem; padding: 0.6rem 1rem 0; }
  .clone-status strong { font-size: 0.78rem; color: var(--text-strong); }
  .clone-status span:last-child { color: var(--text-subtle); font-size: 0.78rem; }
  .clone-output {
    margin: 0.6rem 1rem;
    padding: 0.65rem;
    min-height: 5rem;
    max-height: 12rem;
    overflow: auto;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    border: 1px solid var(--border-medium);
    border-radius: 0.375rem;
    color: var(--text-strong);
    background: var(--surface);
    font: 0.72rem/1.45 var(--mono-font-family);
  }
  .clone-response { padding-top: 0; align-items: end; }
  .clone-response label { flex: 1; min-width: 0; color: var(--text-subtle); font-size: 0.72rem; font-weight: 600; }
  .clone-response input { display: block; margin-top: 0.2rem; }
  .folder-create-form { border-bottom: 1px solid var(--border-soft); align-items: flex-start; }
  .folder-create-form input { min-width: 10rem; }
  .folder-create-form .local-error { flex: 1 0 100%; margin: 0; }
  .folder-dialog-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 0.5rem; }
  @media (max-width: 520px) {
    .form-row { flex-wrap: wrap; }
    .form-row input { flex-basis: 100%; }
    .clone-response label { flex-basis: 100%; }
    .clone-response button { flex: 1; }
    .credential-head { align-items: flex-start; flex-wrap: wrap; }
    .credential-head strong { flex-basis: calc(100% - 1.5rem); }
    .credential-actions button { flex: 1 1 auto; }
    .inline-form > button { flex: 1 1 auto; }
    .assignment-add { grid-template-columns: 1fr; }
    .workspace-assignment-form { grid-template-columns: 1fr; }
    .assignment-add > button { width: 100%; }
    .folder-browser .row { flex-wrap: wrap; }
    .folder-browser .row-main { flex-basis: calc(100% - 2rem); }
    .folder-browser .row-actions { flex: 1 0 100%; justify-content: flex-end; }
    .folder-create-form button { flex: 1 1 auto; }
  }
  .empty { padding: 0.75rem 1rem; color: var(--text-subtle); font-size: 0.8rem; }
  .error-text { color: var(--danger); font-size: 0.8rem; margin: 0.75rem 0; }
  .local-error { color: var(--danger); font-size: 0.76rem; margin: 0.35rem 0 0; }
  .hub-version {
    margin: -1.5rem 0 2rem;
    text-align: center;
    color: var(--text-subtle);
    font-size: 0.72rem;
    font-family: var(--mono-font-family);
  }

  /* Full-page indicator for the started-but-still-loading gap: shown the
     moment the dashboard navigates into a session, replaced by the session
     page itself. Without it, a restored button reads as "nothing
     happened" while the SPA is still booting. */
  .nav-overlay {
    position: fixed;
    inset: 0;
    z-index: 10;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.75rem;
    background: color-mix(in srgb, var(--surface) 94%, transparent);
    backdrop-filter: blur(3px);
  }
  .nav-overlay-spinner {
    width: 28px;
    height: 28px;
    border-radius: 999px;
    border: 3px solid var(--border-medium);
    border-top-color: var(--accent);
    animation: uatu-spin 0.8s linear infinite;
  }
  @keyframes uatu-spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .nav-overlay-spinner { animation-duration: 2.4s; } }
  .nav-overlay-label { font-size: 0.85rem; color: var(--text-subtle); }
  [hidden] { display: none !important; }
`;

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)" />
<meta name="theme-color" content="#0d1117" media="(prefers-color-scheme: dark)" />
<link rel="manifest" href="/manifest.webmanifest" />
<link rel="icon" type="image/png" sizes="192x192" href="/hub-assets/icon-192.png" />
<title>${escapeHtml(title)}</title>
<style>${SHARED_STYLE}</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>`;
}

function brandHeader(): string {
  return `<header class="hub-header">
  ${BRAND_LOGO_SVG}
  <h1 class="brand-wordmark">UatuCode Hub</h1>
</header>`;
}

type AuthenticatedPage = "dashboard" | "clone" | "settings";

function authenticatedChrome(current: AuthenticatedPage): string {
  const link = (pageName: AuthenticatedPage, href: string, label: string) =>
    `<a href="${href}"${current === pageName ? ' aria-current="page"' : ""}>${label}</a>`;
  return `${brandHeader()}
<nav class="hub-nav" aria-label="Hub">
  ${link("dashboard", "/", "Dashboard")}
  ${link("clone", "/clone", "Add workspace")}
  ${link("settings", "/settings", "Settings")}
  <form class="sign-out" method="post" action="/logout"><button type="submit">Sign out</button></form>
</nav>`;
}

export function loginPage(options: { error?: string; next?: string } = {}): string {
  const error = options.error ? `<p class="error-text">${escapeHtml(options.error)}</p>` : "";
  // Return-to target carried from the gate's redirect; server-validated
  // (safeReturnPath) before rendering AND again on submit, escaped here.
  const next = options.next ? `<input type="hidden" name="next" value="${escapeHtml(options.next)}" />` : "";
  // The action carries the target as well as the hidden field, because the
  // POST branches that answer BEFORE the body is read — a cross-origin
  // rejection, a rate limit — can only see the URL. Without this, a failure
  // there re-renders a form that has forgotten where the user was going, and
  // the rate-limit branch is exactly the repeated-wrong-password case.
  const action = options.next ? `/login?next=${encodeURIComponent(options.next)}` : "/login";
  return page(
    "UatuCode Hub — Sign in",
    `${brandHeader()}
<section class="pane" style="max-width: 380px; margin-left: auto; margin-right: auto;">
  <div class="pane-header"><h2>Sign in</h2></div>
  <form method="post" action="${escapeHtml(action)}" style="padding: 1rem; display: flex; flex-direction: column; gap: 0.75rem;">
    ${error}${next}
    <label style="display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.78rem; font-weight: 600; color: var(--text-strong);">
      User
      <input type="text" name="name" autocomplete="username" autofocus />
    </label>
    <label style="display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.78rem; font-weight: 600; color: var(--text-strong);">
      Password
      <input type="password" name="password" autocomplete="current-password" />
    </label>
    <div><button type="submit" class="primary">Sign in</button></div>
  </form>
</section>`,
  );
}

// Authenticated pages render their live data from the Hub APIs so session,
// credential, device, and folder state stays current without a reload.
function authenticatedPage(pageName: AuthenticatedPage, authenticatedUser: string): string {
  const sharedUidWarning = escapeHtml(LOCAL_CREDENTIAL_ASSIGNMENT_WARNING);
  const sharedUidDismissalKey = JSON.stringify(`uatu.hub.notice.shared-uid-v1:${Buffer.from(authenticatedUser).toString("base64url")}`);
  const sharedUidAdvisory = `<p class="advisory" data-shared-uid-warning><span>${sharedUidWarning}</span><button type="button" data-dismiss-shared-uid>Dismiss</button></p>`;
  const addFolder = `<section class="pane">
  <div class="pane-header"><h2>Add workspace</h2><span id="browse-path" class="pane-meta"></span></div>
  <p class="empty" style="padding-top: 0;">Create a new workspace, pick an existing folder below, or clone a repository. New workspaces are added stopped; start them when you are ready.</p>
  <form id="new-folder-form" class="form-row folder-create-form">
    <input id="new-folder-name" type="text" required aria-label="New folder name" placeholder="New folder name" />
    <button type="submit">Create folder</button>
    <button type="button" id="create-workspace-open">Create workspace</button>
    <p id="new-folder-error" class="local-error" role="alert" hidden></p>
  </form>
  <p id="defaults-fallback-notice" class="local-error" role="alert" hidden style="padding: 0 1rem;"></p>
  <p id="browser-error" class="local-error" role="alert" hidden style="padding: 0 1rem;"></p>
  <div id="browser" class="folder-browser"><p class="empty">Loading…</p></div>
  ${sharedUidAdvisory}
  <form class="form-stack" id="clone-form" style="border-top: 1px solid var(--border-soft);">
    <input type="text" id="clone-url" placeholder="Clone a repository into this folder — git URL" aria-label="Git clone URL" />
    <input type="text" id="clone-folder-name" placeholder="Checkout folder name (defaults from the URL)" aria-label="Checkout folder name" />
    <input type="text" id="clone-display-name" maxlength="64" placeholder="Workspace name (defaults from the checkout folder)" aria-label="Workspace display name" />
    <label>Clone credential
      <select id="clone-credential" aria-describedby="clone-credential-help"><option value="">None — answer prompts interactively</option></select>
    </label>
    <p id="clone-credential-help" class="row-detail" style="margin: 0;">Used only for this clone. Only credentials compatible with the URL are shown; interactive responses are used once and are not saved.</p>
    <label>Workspace authentication
      <select id="clone-retained-auth" aria-describedby="clone-retained-auth-help"><option value="">None</option></select>
    </label>
    <p id="clone-retained-auth-help" class="row-detail" style="margin: 0;">Kept as the workspace's authentication default after registration. The clone credential is never retained on its own — only a credential chosen here persists.</p>
    <label>Commit signing
      <select id="clone-signing"><option value="">None</option></select>
    </label>
    <label class="choice-row"><input type="checkbox" id="clone-start-after" /> Start after clone</label>
    <div id="clone-unlock" class="inline-form" hidden>
      <label>Unlock passphrase<input id="clone-unlock-passphrase" type="password" autocomplete="off" /></label>
      <span class="row-detail">Unlock the selected Hub credential before Git starts.</span>
    </div>
    <p class="local-error" id="clone-form-error" role="alert" hidden></p>
    <div><button type="submit">Clone</button></div>
  </form>
  <div id="clone-panel" class="clone-panel" hidden>
    <div class="clone-status">
      <span id="clone-indicator" class="indicator-dot is-live"></span>
      <strong>Clone</strong>
      <span id="clone-phase" role="status">Starting…</span>
    </div>
    <pre id="clone-output" class="clone-output" aria-live="polite" aria-label="Clone progress"></pre>
    <form id="clone-response-form" class="form-row clone-response">
      <label><span id="clone-response-label">Terminal response</span>
        <input id="clone-response" type="password" autocomplete="off" aria-describedby="clone-response-help" />
      </label>
      <button type="submit">Send</button>
      <button id="clone-cancel" type="button" class="danger">Cancel</button>
    </form>
    <p id="clone-response-help" class="empty" style="padding-top: 0;">Available for any Git or SSH prompt. Responses are not shown in this log.</p>
    <p class="local-error" id="clone-action-error" role="alert" hidden></p>
  </div>
  <dialog id="rename-folder-dialog" class="credential-dialog" aria-labelledby="rename-folder-title">
    <form id="rename-folder-form" class="form-stack">
      <h2 id="rename-folder-title">Rename folder</h2>
      <label>Folder name<input id="rename-folder-name" type="text" required /></label>
      <p id="rename-folder-error" class="local-error" role="alert" hidden></p>
      <div class="folder-dialog-actions">
        <button id="rename-folder-cancel" type="button">Cancel</button>
        <button id="rename-folder-submit" class="primary" type="submit">Rename folder</button>
      </div>
    </form>
  </dialog>
  <dialog id="add-workspace-dialog" class="credential-dialog" aria-labelledby="add-workspace-title">
    <form id="add-workspace-form" class="form-stack">
      <h2 id="add-workspace-title">Add workspace</h2>
      <p id="add-workspace-path" class="row-detail" style="margin: 0; word-break: break-all;"></p>
      <label>Workspace name<input id="add-workspace-name" type="text" maxlength="64" required /></label>
      <label>Authentication
        <select id="add-workspace-auth"><option value="">None</option></select>
      </label>
      <label id="add-workspace-host-label">Authentication host<input id="add-workspace-host" type="text" placeholder="github.com" /></label>
      <label>Commit signing
        <select id="add-workspace-signing"><option value="">None</option></select>
      </label>
      <p id="add-workspace-error" class="local-error" role="alert" hidden></p>
      <div class="folder-dialog-actions">
        <button id="add-workspace-cancel" type="button">Cancel</button>
        <button id="add-workspace-start" type="button">Add and start</button>
        <button id="add-workspace-submit" class="primary" type="submit">Add workspace</button>
      </div>
    </form>
  </dialog>
  <dialog id="create-workspace-dialog" class="credential-dialog" aria-labelledby="create-workspace-title">
    <form id="create-workspace-form" class="form-stack">
      <h2 id="create-workspace-title">Create workspace</h2>
      <p id="create-workspace-parent" class="row-detail" style="margin: 0; word-break: break-all;"></p>
      <label>Folder name<input id="create-workspace-folder" type="text" required /></label>
      <label>Workspace name<input id="create-workspace-name" type="text" maxlength="64" required /></label>
      <label>Authentication
        <select id="create-workspace-auth"><option value="">None</option></select>
      </label>
      <label id="create-workspace-host-label">Authentication host<input id="create-workspace-host" type="text" placeholder="github.com" /></label>
      <label>Commit signing
        <select id="create-workspace-signing"><option value="">None</option></select>
      </label>
      <p class="row-detail" style="margin: 0;">Creates the folder, runs git init, and adds the workspace stopped.</p>
      <p id="create-workspace-error" class="local-error" role="alert" hidden></p>
      <div class="folder-dialog-actions">
        <button id="create-workspace-cancel" type="button">Cancel</button>
        <button id="create-workspace-submit" class="primary" type="submit">Create workspace</button>
      </div>
    </form>
  </dialog>
</section>
`;
  const credentials = `<section class="pane" id="credentials-pane">
  <div class="pane-header"><h2>Credentials</h2><span id="credentials-meta" class="pane-meta">Loading…</span></div>
  ${sharedUidAdvisory}
  <div id="credentials"><p class="empty">Loading…</p></div>
  <details class="workspace-credential-section">
    <summary>Workspace assignments</summary>
    <p class="credential-summary">Assign authentication and signing credentials together.</p>
    <div id="workspace-credential-assignments"><p class="empty">Loading…</p></div>
  </details>
  <details class="credential-create">
    <summary>Generate SSH key</summary>
    <form id="ssh-generate-form" class="form-stack">
      <label>Name<input name="name" type="text" required /></label>
      <div class="choice-row field-label">Purpose
        <label><input name="capabilities" type="checkbox" value="ssh-authentication" checked /> Authentication</label>
        <label><input name="capabilities" type="checkbox" value="ssh-signing" /> Commit signing</label>
      </div>
      <label>Passphrase<input name="passphrase" type="password" autocomplete="new-password" required /></label>
      <p class="local-error" data-form-error role="alert" hidden></p>
      <div><button class="primary" type="submit">Generate SSH key</button></div>
    </form>
  </details>
  <details class="credential-create">
    <summary>Import SSH private key</summary>
    <form id="ssh-import-form" class="form-stack">
      <label>Name<input name="name" type="text" required /></label>
      <div class="choice-row field-label">Purpose
        <label><input name="capabilities" type="checkbox" value="ssh-authentication" checked /> Authentication</label>
        <label><input name="capabilities" type="checkbox" value="ssh-signing" /> Commit signing</label>
      </div>
      <label>Private key file<input name="privateKeyFile" type="file" /></label>
      <details class="paste-option">
        <summary>Paste a private key instead</summary>
        <label><span class="secret-paste-heading">Private key <button type="button" data-reveal-secret="ssh-private-key" aria-controls="ssh-private-key" aria-pressed="false">Reveal</button></span><textarea id="ssh-private-key" class="secret-paste-masked" name="privateKey" autocomplete="off"></textarea></label>
      </details>
      <label>Existing passphrase, if any<input name="passphrase" type="password" autocomplete="off" /></label>
      <p class="empty" style="padding-top: 0;">The key keeps its current passphrase. Keys without one stay available without unlocking.</p>
      <p class="local-error" data-form-error role="alert" hidden></p>
      <div><button class="primary" type="submit">Import SSH key</button></div>
    </form>
  </details>
  <details class="credential-create">
    <summary>Generate OpenPGP key</summary>
    <form id="openpgp-generate-form" class="form-stack">
      <label>Name<input name="name" type="text" required /></label>
      <label>User ID<input name="userId" type="text" placeholder="Name &lt;email@example.com&gt;" required /></label>
      <label>Passphrase<input name="passphrase" type="password" autocomplete="new-password" required /></label>
      <p class="local-error" data-form-error role="alert" hidden></p>
      <div><button class="primary" type="submit">Generate OpenPGP key</button></div>
    </form>
  </details>
  <details class="credential-create">
    <summary>Import OpenPGP private key</summary>
    <form id="openpgp-import-form" class="form-stack">
      <label>Name<input name="name" type="text" required /></label>
      <label><span class="secret-paste-heading">Private key <button type="button" data-reveal-secret="openpgp-private-key" aria-controls="openpgp-private-key" aria-pressed="false">Reveal</button></span><textarea id="openpgp-private-key" class="secret-paste-masked" name="privateKey" autocomplete="off" required></textarea></label>
      <p class="local-error" data-form-error role="alert" hidden></p>
      <div><button class="primary" type="submit">Import OpenPGP key</button></div>
    </form>
  </details>
  <details class="credential-create">
    <summary>Add HTTPS or provider token</summary>
    <form id="token-form" class="form-stack">
      <label>Name<input name="name" type="text" required /></label>
      <label>Provider host<input name="host" type="text" placeholder="github.com" required /></label>
      <label>Username<input name="username" type="text" /></label>
      <label>Token<input name="token" type="password" autocomplete="off" required /></label>
      <div class="choice-row field-label">Purpose
        <label><input name="capabilities" type="checkbox" value="https-git" checked /> HTTPS Git</label>
        <label><input name="capabilities" type="checkbox" value="github-cli" /> GitHub CLI</label>
        <label><input name="capabilities" type="checkbox" value="gitlab-cli" /> GitLab CLI</label>
      </div>
      <p class="local-error" data-form-error role="alert" hidden></p>
      <div><button class="primary" type="submit">Save token</button></div>
    </form>
  </details>
  <details class="credential-create" id="tools-details">
    <summary>Credential tools</summary>
    <div id="credential-tools"><p class="empty">Loading…</p></div>
  </details>
</section>
`;
  const dashboard = `<section class="pane">
  <div class="pane-header"><h2>Sessions</h2></div>
  <div id="sessions"><p class="empty">Loading…</p></div>
</section>
<section class="pane">
  <div class="pane-header"><h2>Workspaces</h2></div>
  <div id="workspaces"><p class="empty">Loading…</p></div>
</section>`;
  const settings = `${credentials}<section class="pane">
  <div class="pane-header"><h2>Workspace defaults</h2></div>
  <form id="workspace-defaults-form" class="form-stack">
    <p id="workspace-defaults-status" class="row-detail" style="margin: 0;">Loading…</p>
    <label>Default workspace parent
      <input id="workspace-defaults-parent" type="text" placeholder="/absolute/path/to/workspaces" aria-describedby="workspace-defaults-help" />
    </label>
    <p id="workspace-defaults-help" class="row-detail" style="margin: 0;">The initial location for Create workspace, Clone, and folder browsing. Workspaces can still be added from anywhere.</p>
    <p id="workspace-defaults-error" class="local-error" role="alert" hidden></p>
    <div class="form-row" style="padding: 0;">
      <button type="submit" class="primary">Save default parent</button>
      <button type="button" id="workspace-defaults-clear">Clear</button>
    </div>
  </form>
</section>
<section class="pane">
  <div class="pane-header"><h2>Devices</h2></div>
  <div id="devices"><p class="empty">Loading…</p></div>
</section>`;
  const content = pageName === "dashboard" ? dashboard : pageName === "clone" ? addFolder : settings;
  return page(
    pageName === "dashboard" ? "UatuCode Hub" : `UatuCode Hub — ${pageName === "clone" ? "Add workspace" : "Settings"}`,
    `${authenticatedChrome(pageName)}
<div data-hub-page="${pageName}">
<p id="hub-version" class="hub-version"></p>
<p id="action-error" class="error-text" hidden></p>
${content}
</div>
<script>
const pageMode = document.querySelector("[data-hub-page]").dataset.hubPage;
const errorEl = document.getElementById("action-error");
const sharedUidDismissalKey = ${sharedUidDismissalKey};
function initSharedUidAdvisory() {
  const advisories = [...document.querySelectorAll("[data-shared-uid-warning]")];
  let dismissed = false;
  try {
    dismissed = localStorage.getItem(sharedUidDismissalKey) === "dismissed";
  } catch {}
  for (const advisory of advisories) {
    advisory.hidden = dismissed;
    advisory.querySelector("[data-dismiss-shared-uid]").onclick = () => {
      for (const item of advisories) item.hidden = true;
      try { localStorage.setItem(sharedUidDismissalKey, "dismissed"); } catch {}
    };
  }
}
function showError(message) {
  errorEl.textContent = message;
  errorEl.hidden = !message;
}
async function api(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || ("request failed: " + response.status));
    error.payload = payload;
    throw error;
  }
  return payload;
}
function shellSummary(shells) {
  if (!shells || shells.length === 0) return "no shells";
  const labels = shells.map(s => s.label + (s.attached ? "" : " · detached"));
  return labels.join(", ");
}
function credentialAssignmentSummary(assignments) {
  const authentication = assignments?.authentication || [];
  const signing = assignments?.signing || [];
  const parts = [];
  if (authentication.length) parts.push("🔑 Auth: " + authentication.join(", "));
  if (signing.length) parts.push("✎ Signing: " + signing.join(", "));
  return parts.join(" · ") || "⊘ No credentials assigned";
}
function hasCredentialAssignments(assignments) {
  return (assignments?.authentication?.length || 0) + (assignments?.signing?.length || 0) > 0;
}
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function row({ title, href, titleClick, path, detail, live, chip, chipWarn, button, buttons }) {
  const div = el("div", "row");
  if (live !== undefined) {
    const dot = el("span", "indicator-dot" + (live ? " is-live" : ""));
    div.appendChild(dot);
  }
  const main = el("div", "row-main");
  const titleRow = el("div", "row-title");
  if (href || titleClick) {
    const link = document.createElement("a");
    link.href = href || "#";
    link.textContent = title;
    if (titleClick) {
      link.onclick = event => { event.preventDefault(); titleClick(); };
    }
    titleRow.appendChild(link);
  } else {
    titleRow.appendChild(el("strong", null, title));
  }
  if (chip) titleRow.appendChild(el("span", "chip" + (chipWarn ? " is-warn" : ""), chip));
  main.appendChild(titleRow);
  if (path) main.appendChild(el("div", "row-path", path));
  if (detail) main.appendChild(el("div", "row-detail", detail));
  div.appendChild(main);
  const specs = buttons ?? (button ? [button] : []);
  const actions = el("div", "row-actions");
  for (const spec of specs) {
    const action = el("button", spec.className || null, spec.label);
    if (spec.ariaLabel) action.setAttribute("aria-label", spec.ariaLabel);
    action.onclick = () => spec.onClick(action);
    actions.appendChild(action);
  }
  if (specs.length) div.appendChild(actions);
  return div;
}
// Session starts (a real server spawn) take seconds; a silent button reads
// as dead. Disable and relabel the control until the action settles.
//
// uiBusy pauses the interval-driven refresh while any action is in flight:
// refresh() rebuilds the rows wholesale, which would replace an in-flight
// "Starting…" button with a freshly rendered idle one mid-action.
let uiBusy = 0;
async function withBusy(button, busyLabel, action) {
  uiBusy += 1;
  const original = button.textContent;
  button.disabled = true;
  button.textContent = busyLabel;
  try {
    await action();
  } finally {
    uiBusy -= 1;
    button.disabled = false;
    button.textContent = original;
  }
}
function renderInto(container, rows, emptyText) {
  container.replaceChildren();
  if (rows.length === 0) {
    container.appendChild(el("p", "empty", emptyText));
    return;
  }
  for (const r of rows) container.appendChild(r);
}
let credentialCatalog = [];
let dashboardWorkspaces = [];
let credentialsLoaded = false;
const openCredentialIds = new Set();
const credentialPath = "/api/hub/credentials";
const toolPath = "/api/hub/credential-tools";
const capabilityLabels = {
  "ssh-authentication": "SSH authentication",
  "ssh-signing": "SSH signing",
  "openpgp-signing": "OpenPGP signing",
  "https-git": "HTTPS Git",
  "github-cli": "GitHub CLI",
  "gitlab-cli": "GitLab CLI",
};
function readinessSummary(results) {
  return (results || []).map(result => result.layer + ": " + result.message).join(" · ");
}
function isCredentialLocked(credential) {
  return credential.type !== "token" && (credential.readiness || []).some(result =>
    result.status === "unavailable" && /unlock|locked/i.test(result.message));
}
function assignedCredentials(workspaceId) {
  return credentialCatalog.filter(credential => (credential.assignments || []).some(assignment => assignment.workspaceId === workspaceId));
}
function lockedWorkspaceCredentials(workspaceId) {
  return assignedCredentials(workspaceId).filter(isCredentialLocked);
}
function aggregateReadiness(credential) {
  return (credential.readiness || []).some(result => result.status === "unavailable") ? "Unavailable" : "Ready";
}
function credentialLockState(credential) {
  if (credential.type === "token") return "Not applicable";
  if (isCredentialLocked(credential)) return "Locked";
  return aggregateReadiness(credential) === "Unavailable" ? "Unavailable" : "Unlocked";
}
function workspaceName(workspaceId) {
  const workspace = dashboardWorkspaces.find(item => item.id === workspaceId);
  return workspace ? (workspace.displayName || workspace.id) : workspaceId;
}
function assignmentSummary(assignments) {
  const names = [...new Set(assignments.map(item => workspaceName(item.workspaceId)))];
  if (!names.length) return "No assigned workspaces";
  return names.join(", ") + " · " + names.length + (names.length === 1 ? " workspace" : " workspaces");
}
function setLocalError(target, message) {
  target.textContent = message || "";
  target.hidden = !message;
}
function actionErrorFor(control) {
  const rowMain = control.closest(".row")?.querySelector(".row-main");
  const scope = rowMain || control.closest("form") || control.parentElement;
  let target = scope.querySelector("[data-action-error]");
  if (!target) {
    target = el("p", "local-error");
    target.dataset.actionError = "";
    target.setAttribute("role", "alert");
    target.hidden = true;
    scope.appendChild(target);
  }
  return target;
}
function credentialHost(credential) {
  return credential.type === "token" ? credential.metadata.host : "github.com";
}
function credentialSupportsRole(credential, role) {
  return role === "signing"
    ? credential.capabilities.some(value => value === "ssh-signing" || value === "openpgp-signing")
    : credential.capabilities.some(value =>
      value === "ssh-authentication" || value === "https-git" || value === "github-cli" || value === "gitlab-cli");
}
function providerCliCredential(credential) {
  return credential.type === "token" && credential.capabilities.some(value => value === "github-cli" || value === "gitlab-cli");
}
function makeReadiness(results) {
  const container = el("div", "readiness");
  for (const result of results || []) {
    const chip = el("span", "chip" + (result.status === "ready" ? " is-ready" : result.status === "unavailable" ? " is-warn" : ""), result.layer + ": " + result.status);
    chip.title = result.message;
    container.appendChild(chip);
  }
  return container;
}
async function copyPublicKey(credential, status) {
  const response = await fetch(credentialPath + "/" + encodeURIComponent(credential.id) + "/public-key");
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "public key could not be loaded");
  if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error("Clipboard access is unavailable; use a browser that permits clipboard writes.");
  await navigator.clipboard.writeText(payload.publicKey);
  status.textContent = "Copied";
  setTimeout(() => { status.textContent = ""; }, 2000);
}
function credentialCard(credential) {
  const card = el("details", "credential-card");
  card.dataset.credentialId = credential.id;
  card.open = openCredentialIds.has(credential.id);
  card.addEventListener("toggle", () => {
    if (card.open) openCredentialIds.add(credential.id);
    else openCredentialIds.delete(credential.id);
  });
  const summary = document.createElement("summary");
  const head = el("div", "credential-head");
  head.appendChild(el("span", "indicator-dot" + (credential.enabled ? " is-live" : "")));
  head.appendChild(el("strong", null, credential.name));
  const state = el("span", "credential-state");
  state.appendChild(el("span", "chip", credential.type));
  state.appendChild(el("span", "chip" + (credential.enabled ? "" : " is-warn"), credential.enabled ? "Enabled" : "Disabled"));
  const lockState = credentialLockState(credential);
  state.appendChild(el("span", "chip" + (lockState === "Locked" || lockState === "Unavailable" ? " is-warn" : ""), lockState));
  const readiness = aggregateReadiness(credential);
  state.appendChild(el("span", "chip" + (readiness === "Ready" ? " is-ready" : " is-warn"), readiness));
  head.appendChild(state);
  summary.appendChild(head);
  summary.appendChild(el("p", "credential-summary", assignmentSummary(credential.assignments || [])));
  card.appendChild(summary);
  const body = el("div", "credential-body");
  const identifier = credential.type === "token" ? credential.metadata.host : credential.metadata.fingerprint;
  const overview = el("section", "credential-section");
  overview.appendChild(el("h3", null, "Credential details"));
  overview.appendChild(el("p", "credential-summary", credential.capabilities.map(value => capabilityLabels[value] || value).join(" · ") + " · " + identifier));
  overview.appendChild(makeReadiness(credential.readiness));
  const readinessText = el("p", "credential-summary", readinessSummary(credential.readiness));
  readinessText.setAttribute("aria-live", "polite");
  overview.appendChild(readinessText);
  body.appendChild(overview);
  const assignments = credential.assignments || [];
  if (assignments.some(item => dashboardWorkspaces.some(workspace => workspace.id === item.workspaceId && workspace.credentialRestartRequired))) {
    overview.appendChild(el("p", "credential-summary restart-required", "Restart required: assignment changes apply fully when the running workspace session restarts."));
  }
  const actionSection = el("section", "credential-section");
  actionSection.appendChild(el("h3", null, "Actions"));
  const actions = el("div", "credential-actions");
  const actionError = el("p", "local-error");
  actionError.setAttribute("role", "alert");
  actionError.hidden = true;
  if (credential.type !== "token") {
    const copyStatus = el("span", "copy-status");
    const copyButton = el("button", null, "Copy public key");
    copyButton.onclick = async () => {
      setLocalError(actionError, "");
      try { await copyPublicKey(credential, copyStatus); } catch (error) { setLocalError(actionError, error.message); }
    };
    actions.append(copyButton, copyStatus);
    if (isCredentialLocked(credential)) {
      const unlock = el("form", "inline-form credential-unlock");
      const label = el("label", null, "Unlock passphrase");
      const passphrase = document.createElement("input");
      passphrase.type = "password";
      passphrase.autocomplete = "off";
      label.appendChild(passphrase);
      const button = el("button", null, "Unlock");
      unlock.append(label, button);
      unlock.onsubmit = async event => {
        event.preventDefault();
        const value = passphrase.value;
        passphrase.value = "";
        await credentialAction(credential.id, "unlock", { passphrase: value }, button, "Unlocking…", actionError);
      };
      actions.appendChild(unlock);
    } else if (credential.type === "ssh") {
      const lock = el("button", null, "Lock");
      lock.onclick = () => credentialAction(credential.id, "lock", {}, lock, "Locking…", actionError);
      actions.appendChild(lock);
    }
  }
  const testButton = el("button", null, "Test");
  testButton.onclick = async () => {
    setLocalError(actionError, "");
    await withBusy(testButton, "Testing…", async () => {
      try {
        const result = await api(credentialPath + "/" + encodeURIComponent(credential.id) + "/test");
        readinessText.textContent = readinessSummary(result.results);
        await loadCredentials();
      } catch (error) { setLocalError(actionError, error.message); }
    });
  };
  actions.appendChild(testButton);
  const enabledButton = el("button", null, credential.enabled ? "Disable" : "Enable");
  enabledButton.onclick = () => {
    if (credential.enabled && providerCliCredential(credential)
      && !confirm("Disabling this provider CLI token may stop running workspaces that still use it and terminate their shells. Continue?")) return;
    return credentialAction(credential.id, credential.enabled ? "disable" : "enable", {}, enabledButton, credential.enabled ? "Disabling…" : "Enabling…", actionError);
  };
  actions.appendChild(enabledButton);
  const deleteButton = el("button", "danger", "Delete");
  deleteButton.onclick = async () => {
    const assigned = (credential.assignments || []).length > 0;
    const detail = assigned ? " This will also remove all workspace assignments." : "";
    const stopDetail = providerCliCredential(credential) ? " This may stop running workspaces that still use the token and terminate their shells." : "";
    if (!confirm('Delete credential "' + credential.name + '"?' + detail + stopDetail + " Existing external connections may remain authenticated until they end.")) return;
    await credentialAction(credential.id, "delete", { confirm: true, unassign: assigned }, deleteButton, "Deleting…", actionError);
  };
  actions.appendChild(deleteButton);
  actionSection.append(actions, actionError);
  body.appendChild(actionSection);
  card.appendChild(body);
  return card;
}
function workspaceAssignmentEntries(workspaceId) {
  const entries = [];
  for (const credential of credentialCatalog) {
    for (const assignment of credential.assignments || []) {
      if (assignment.workspaceId === workspaceId) entries.push({ credential, assignment });
    }
  }
  return entries;
}
function workspaceAssignmentForm(actionError) {
  const form = el("form", "inline-form assignment-add workspace-assignment-form");
  form.appendChild(el("h4", null, "Assign workspace credentials"));
  const workspaceLabel = el("label", null, "Workspace");
  const workspace = document.createElement("select");
  for (const item of dashboardWorkspaces) workspace.appendChild(new Option((item.displayName || item.id) + " · " + item.path, item.id));
  workspaceLabel.appendChild(workspace);
  const authenticationLabel = el("label", null, "🔑 Authentication");
  const authentication = document.createElement("select");
  authentication.appendChild(new Option("Do not change", ""));
  for (const credential of credentialCatalog.filter(item => item.enabled && credentialSupportsRole(item, "authentication"))) {
    authentication.appendChild(new Option(credential.name, credential.id));
  }
  authenticationLabel.appendChild(authentication);
  const signingLabel = el("label", null, "✎ Signing");
  const signing = document.createElement("select");
  signing.appendChild(new Option("Do not change", ""));
  for (const credential of credentialCatalog.filter(item => item.enabled && credentialSupportsRole(item, "signing"))) {
    signing.appendChild(new Option(credential.name, credential.id));
  }
  signingLabel.appendChild(signing);
  const hostLabel = el("label", null, "Authentication host");
  const host = document.createElement("input");
  host.type = "text";
  host.value = "github.com";
  hostLabel.appendChild(host);
  const help = el("p", "assignment-help", "Selected credentials replace the current defaults. The host scopes an authentication assignment; token credentials use their configured host.");
  const button = el("button", null, "Assign selected");
  form.append(workspaceLabel, authenticationLabel, signingLabel, hostLabel, help, button);
  const updateHost = () => {
    const selected = credentialCatalog.find(item => item.id === authentication.value);
    host.disabled = !selected;
    host.readOnly = selected?.type === "token";
    if (selected?.type === "token") host.value = selected.metadata.host;
    else if (selected && !host.value.trim()) host.value = "github.com";
  };
  authentication.onchange = updateHost;
  updateHost();
  form.onsubmit = async event => {
    event.preventDefault();
    setLocalError(actionError, "");
    if (!authentication.value && !signing.value) {
      setLocalError(actionError, "Choose an authentication credential, a signing credential, or both.");
      return;
    }
    if (authentication.value && !host.value.trim()) {
      setLocalError(actionError, "Enter a provider host for authentication.");
      return;
    }
    await withBusy(button, "Assigning…", async () => {
      try {
        await api("/api/hub/workspaces/" + encodeURIComponent(workspace.value) + "/credential-assignments", {
          ...(authentication.value ? { authentication: { credentialId: authentication.value, host: host.value.trim() } } : {}),
          ...(signing.value ? { signing: { credentialId: signing.value } } : {}),
        });
        await Promise.all([loadSettingsState(), loadCredentials()]);
      } catch (error) {
        try { await Promise.all([loadSettingsState(), loadCredentials()]); } catch {}
        setLocalError(actionError, error.message);
      }
    });
  };
  return form;
}
async function removeWorkspaceAssignment(entry, workspace, button, actionError) {
  if (!workspace.running) {
    await credentialAction(entry.credential.id, "unassign", {
      workspaceId: workspace.id, role: entry.assignment.role,
      ...(entry.assignment.role === "authentication" ? { host: entry.assignment.host } : {}),
    }, button, "…", actionError);
    return;
  }
  const role = entry.assignment.role === "authentication" ? "authentication" : "signing";
  if (!confirm('"' + (workspace.name || workspace.id) + '" is running. Stop it and remove its ' + role + ' credential assignment? Its shells will be terminated.')) return;
  setLocalError(actionError, "");
  await withBusy(button, "…", async () => {
    try {
      await api(credentialPath + "/" + encodeURIComponent(entry.credential.id) + "/unassign", {
        workspaceId: workspace.id, role: entry.assignment.role, stop: true,
        ...(entry.assignment.role === "authentication" ? { host: entry.assignment.host } : {}),
      });
      await Promise.all([loadSettingsState(), loadCredentials()]);
    } catch (error) { setLocalError(actionError, error.message); }
  });
}
function renderWorkspaceAssignments() {
  const container = document.getElementById("workspace-credential-assignments");
  if (!container) return;
  container.replaceChildren();
  const actionError = el("p", "local-error");
  actionError.setAttribute("role", "alert");
  actionError.hidden = true;
  if (!dashboardWorkspaces.length) {
    container.appendChild(el("p", "empty", "No workspaces available."));
    return;
  }
  const assignedWorkspaces = dashboardWorkspaces.filter(workspace => workspaceAssignmentEntries(workspace.id).length > 0);
  let list;
  if (assignedWorkspaces.length) list = el("div", "workspace-assignment-list");
  else list = el("p", "empty", "No workspace credentials assigned.");
  for (const workspace of assignedWorkspaces) {
    const assignmentRow = el("div", "assignment-row");
    const assignmentMain = el("div", "row-main");
    assignmentMain.appendChild(el("strong", null, workspaceLabel(workspace)));
    assignmentMain.appendChild(el("span", "row-detail", workspace.path));
    const pills = el("div", "assignment-pills");
    for (const entry of workspaceAssignmentEntries(workspace.id)) {
      const authentication = entry.assignment.role === "authentication";
      const text = (authentication ? "🔑 Auth · " : "✎ Signing · ") + entry.credential.name + (entry.assignment.host ? " · " + entry.assignment.host : "");
      const pill = el("span", "assignment-pill", text);
      const remove = el("button", null, "×");
      remove.type = "button";
      remove.title = "Remove " + (authentication ? "authentication" : "signing") + " assignment";
      remove.setAttribute("aria-label", remove.title + " for " + workspaceLabel(workspace));
      remove.onclick = () => removeWorkspaceAssignment(entry, workspace, remove, actionError);
      pill.appendChild(remove);
      pills.appendChild(pill);
    }
    assignmentMain.appendChild(pills);
    assignmentRow.appendChild(assignmentMain);
    list.appendChild(assignmentRow);
  }
  container.append(list, workspaceAssignmentForm(actionError), actionError);
}
async function credentialAction(id, action, body, button, busyLabel, errorTarget) {
  setLocalError(errorTarget, "");
  await withBusy(button, busyLabel, async () => {
    try {
      await api(credentialPath + "/" + encodeURIComponent(id) + "/" + action, body);
      await Promise.all([loadSettingsState(), loadCredentials()]);
    } catch (error) { setLocalError(errorTarget, error.message); }
  });
}
async function loadSettingsState() {
  try {
    const response = await fetch("/api/hub/state");
    if (!response.ok) throw new Error("Hub state could not be loaded.");
    const state = await response.json();
    dashboardWorkspaces = state.workspaces || [];
    if (credentialsLoaded) renderCredentialCatalog();
  } catch (error) { showError(error.message); }
}
async function loadCredentials() {
  try {
    const response = await fetch(credentialPath);
    if (!response.ok) throw new Error("Credentials could not be loaded.");
    const payload = await response.json();
    credentialCatalog = payload.credentials || [];
    credentialsLoaded = true;
    renderCredentialCatalog();
  } catch (error) { showError(error.message); }
}
async function loadDashboardCredentials() {
  const response = await fetch(credentialPath);
  if (!response.ok) throw new Error("Credentials could not be loaded.");
  const payload = await response.json();
  credentialCatalog = payload.credentials || [];
  credentialsLoaded = true;
}
function renderCredentialCatalog() {
    document.getElementById("credentials-meta").textContent = credentialCatalog.length + (credentialCatalog.length === 1 ? " credential" : " credentials");
    const container = document.getElementById("credentials");
    for (const card of container.querySelectorAll("details[data-credential-id]")) {
      if (card.open) openCredentialIds.add(card.dataset.credentialId);
      else openCredentialIds.delete(card.dataset.credentialId);
    }
    container.replaceChildren();
    if (!credentialCatalog.length) container.appendChild(el("p", "empty", "No Hub credentials. Generate or import one below."));
    else for (const credential of credentialCatalog) container.appendChild(credentialCard(credential));
    renderWorkspaceAssignments();
}
async function loadTools() {
  try {
    const response = await fetch(toolPath);
    if (!response.ok) throw new Error("Credential tools could not be loaded.");
    const payload = await response.json();
    const container = document.getElementById("credential-tools");
    container.replaceChildren();
    for (const tool of payload.tools || []) {
      const item = el("div", "row tool-row");
      const controls = el("div", "tool-controls");
      controls.appendChild(el("strong", null, tool.tool));
      controls.appendChild(el("div", "tool-results", (tool.path || "Not found") + (tool.version ? " · " + tool.version : "") + " · " + readinessSummary(tool.results)));
      if (tool.guidance) controls.appendChild(el("div", "tool-results", tool.guidance));
      const form = el("form", "inline-form");
      const label = el("label", null, "Absolute path override");
      const input = document.createElement("input");
      input.type = "text";
      input.placeholder = tool.path || "/absolute/path/to/" + tool.tool;
      label.appendChild(input);
      const save = el("button", null, "Save override");
      const test = el("button", null, "Test");
      const clear = el("button", null, "Use detected path");
      const toolError = el("p", "local-error");
      toolError.setAttribute("role", "alert");
      toolError.hidden = true;
      form.append(label, save, clear, test);
      form.onsubmit = event => event.preventDefault();
      save.onclick = async () => {
        setLocalError(toolError, "");
        if (!input.value.trim()) { setLocalError(toolError, "Enter an absolute executable path."); return; }
        await withBusy(save, "Saving…", async () => {
          try { await api(toolPath + "/" + encodeURIComponent(tool.tool), { path: input.value.trim() }); input.value = ""; await loadTools(); }
          catch (error) { setLocalError(toolError, error.message); }
        });
      };
      clear.onclick = async () => {
        setLocalError(toolError, "");
        await withBusy(clear, "Clearing…", async () => {
          try { await api(toolPath + "/" + encodeURIComponent(tool.tool), { path: null }); await loadTools(); }
          catch (error) { setLocalError(toolError, error.message); }
        });
      };
      test.onclick = async () => {
        setLocalError(toolError, "");
        await withBusy(test, "Testing…", async () => {
          try { await api(toolPath + "/" + encodeURIComponent(tool.tool) + "/test"); await loadTools(); }
          catch (error) { setLocalError(toolError, error.message); }
        });
      };
      controls.append(form, toolError);
      item.appendChild(controls);
      container.appendChild(item);
    }
  } catch (error) { showError(error.message); }
}
function sessionUrl(id) { return "/s/" + encodeURIComponent(id) + "/"; }
// Navigate into a session behind a full-page opening indicator — the SPA
// takes a moment to boot even after the start API has answered.
function openSession(id) {
  const overlay = el("div", "nav-overlay");
  overlay.appendChild(el("div", "nav-overlay-spinner"));
  overlay.appendChild(el("div", "nav-overlay-label", "Opening " + id + "…"));
  document.body.appendChild(overlay);
  location.href = sessionUrl(id);
}
function unlockCredentialsDialog(title, summary, confirmLabel, credentials, refresh) {
  return new Promise(resolve => {
    const dialog = el("dialog", "credential-dialog");
    const header = el("div", "pane-header");
    header.appendChild(el("h2", null, title));
    const form = el("form", "form-stack");
    form.method = "dialog";
    form.appendChild(el("p", "credential-summary", summary));
    const fields = credentials.map(credential => {
      const label = el("label", null, credential.name + " passphrase");
      const input = document.createElement("input");
      input.type = "password";
      input.autocomplete = "off";
      input.required = credential.type !== "ssh";
      label.appendChild(input);
      form.appendChild(label);
      return { credential, input };
    });
    const errorTarget = el("p", "local-error");
    errorTarget.setAttribute("role", "alert");
    errorTarget.hidden = true;
    const actions = el("div", "credential-dialog-actions");
    const cancel = el("button", null, "Cancel");
    cancel.type = "button";
    const unlock = el("button", "primary", confirmLabel);
    actions.append(cancel, unlock);
    form.append(errorTarget, actions);
    dialog.append(header, form);
    document.body.appendChild(dialog);
    const finish = value => {
      dialog.close();
      dialog.remove();
      resolve(value);
    };
    cancel.onclick = () => finish(false);
    dialog.oncancel = event => { event.preventDefault(); finish(false); };
    form.onsubmit = async event => {
      event.preventDefault();
      setLocalError(errorTarget, "");
      await withBusy(unlock, "Unlocking…", async () => {
        try {
          for (const field of fields) {
            const passphrase = field.input.value;
            field.input.value = "";
            await api(credentialPath + "/" + encodeURIComponent(field.credential.id) + "/unlock", { passphrase });
          }
          await refresh();
          finish(true);
        } catch (error) { setLocalError(errorTarget, error.message); }
      });
    };
    dialog.showModal();
    fields[0].input.focus();
  });
}
function unlockForWorkspace(workspace, credentials) {
  return unlockCredentialsDialog(
    "Unlock credentials for " + (workspace.displayName || workspace.id),
    "Unlock the assigned credentials, then the workspace will resume.",
    "Unlock and resume",
    credentials,
    loadDashboardCredentials,
  );
}
async function prepareWorkspaceResume(workspace, errorTarget) {
  try {
    await loadDashboardCredentials();
  } catch (error) {
    setLocalError(errorTarget, error.message);
    return false;
  }
  const locked = lockedWorkspaceCredentials(workspace.id);
  return !locked.length || await unlockForWorkspace(workspace, locked);
}
function workspaceLabel(w) { return w.displayName || w.id; }
function workspaceById(id) {
  return dashboardWorkspaces.find(entry => entry.id === id)
    || { id, displayName: id, credentialAssignments: { authentication: [], signing: [] } };
}
// Starts a registered stopped workspace through the credential-aware flow:
// confirm missing assignments, unlock locked ones through the masked dialog,
// start, and navigate. Shared by the dashboard's Start action and the
// directory browser's Start rows. On success the button STAYS busy — the
// overlay owns the screen until the session page replaces us.
async function startRegisteredWorkspace(w, button, errorTarget) {
  if (!hasCredentialAssignments(w.credentialAssignments) && !confirm(
    'No credentials are assigned to "' + workspaceLabel(w) + '". Git authentication and commit signing may be unavailable, but the workspace can still start. Continue?'
  )) return;
  const target = errorTarget || actionErrorFor(button);
  setLocalError(target, "");
  if (!(await prepareWorkspaceResume(w, target))) return;
  uiBusy += 1;
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "Starting…";
  try {
    await api("/api/hub/sessions/" + encodeURIComponent(w.id) + "/start");
    // uiBusy stays held: the page is navigating away and any repaint now
    // would flash idle controls under the overlay.
    openSession(w.id);
  } catch (error) {
    setLocalError(target, error.message);
    uiBusy -= 1;
    button.disabled = false;
    button.textContent = original;
  }
}
// Rename workspace changes only the mutable display name — safe while the
// session is running or stopped; the id, URL, and folder are untouched.
async function renameWorkspace(w, button, refreshView) {
  const next = prompt('Rename workspace "' + workspaceLabel(w) + '"', workspaceLabel(w));
  if (next === null) return;
  const errorTarget = actionErrorFor(button);
  setLocalError(errorTarget, "");
  await withBusy(button, "Renaming…", async () => {
    try {
      await api("/api/hub/workspaces/" + encodeURIComponent(w.id) + "/display-name", { displayName: next });
      await refreshView();
    } catch (error) { setLocalError(errorTarget, error.message); }
  });
}
function authCapableCredentials() {
  return credentialCatalog.filter(credential => credential.enabled && (credential.type === "ssh"
    ? credential.capabilities.includes("ssh-authentication")
    : credential.capabilities.some(capability => capability === "https-git" || capability === "github-cli" || capability === "gitlab-cli")));
}
function signingCapableCredentials() {
  return credentialCatalog.filter(credential => credential.enabled
    && credential.capabilities.some(capability => capability === "ssh-signing" || capability === "openpgp-signing"));
}
function fillCredentialSelect(select, credentials, emptyLabel) {
  const selected = select.value;
  select.replaceChildren(new Option(emptyLabel, ""));
  for (const credential of credentials) {
    select.appendChild(new Option(credential.name + " · " + credentialHost(credential), credential.id));
  }
  if ([...select.options].some(option => option.value === selected)) select.value = selected;
}
// Keeps an authentication-host input coherent with the selected credential:
// tokens pin their provider host; SSH keys need the user's chosen host.
function syncAuthHost(select, hostInput) {
  const credential = credentialCatalog.find(item => item.id === select.value);
  if (!credential) {
    hostInput.disabled = true;
    hostInput.value = "";
    return;
  }
  if (credential.type === "token") {
    hostInput.value = credential.metadata.host;
    hostInput.disabled = true;
    return;
  }
  hostInput.disabled = false;
  if (!hostInput.value.trim()) hostInput.value = "github.com";
}
function authSelectionFrom(select, hostInput, errorTarget) {
  if (!select.value) return [];
  const host = hostInput.value.trim();
  if (!host) {
    setLocalError(errorTarget, "Enter the provider host the authentication default applies to.");
    return null;
  }
  return [{ credentialId: select.value, host }];
}

// The Add workspace browser: one directory level at a time, drill in by
// name, configure the current candidate with its button. The server starts
// pathless listings at the effective default workspace parent; the resolved
// path comes back with every listing.
let browsePath = null;
let browseParent = null;
// Assigned by initClonePage — loadBrowser rows open the dialog through it.
let openAddWorkspaceDialog = () => {};
function childFolderPath(parent, name) {
  const separator = parent.includes("\\\\") && !parent.includes("/") ? "\\\\" : "/";
  return parent + (parent.endsWith("/") || parent.endsWith("\\\\") ? "" : separator) + name;
}
async function refreshWorkspaceState() {
  const response = await fetch("/api/hub/state");
  if (!response.ok) return;
  const state = await response.json();
  dashboardWorkspaces = state.workspaces || [];
  updateDefaultsFallbackNotice(state.workspaceDefaults);
}
// A configured default parent that later became missing or unreadable
// silently falls back to the Hub user's home for pathless browsing; the
// page must say so, or the user creates and clones into home believing
// the configured location is still in effect.
function updateDefaultsFallbackNotice(defaults) {
  const notice = document.getElementById("defaults-fallback-notice");
  if (!notice) return;
  if (defaults && defaults.configured && !defaults.configuredAvailable) {
    notice.textContent = "Configured default workspace parent " + defaults.configured
      + " is currently unavailable — showing " + defaults.effective + " instead. Fix the folder or update it in Settings.";
    notice.hidden = false;
  } else {
    notice.hidden = true;
  }
}
async function requestFolderMutation(endpoint, request) {
  try {
    return await api(endpoint, request);
  } catch (error) {
    if (!error.payload?.needsStop) throw error;
    const workspaceIds = error.payload.workspaceIds || [];
    const names = workspaceIds.length ? workspaceIds.map(id => '"' + id + '"').join(", ") : "the affected workspaces";
    if (!confirm("Stop " + names + " and continue? Their running sessions and shells will be terminated.")) {
      return null;
    }
    return api(endpoint, { ...request, stop: true });
  }
}
async function refreshAfterFolderMutation() {
  await Promise.all([
    loadBrowser({ fallbackToParent: true }),
    refreshWorkspaceState().catch(() => {}),
  ]);
}
let pendingRename = null;
function openRenameFolder(folder, name, button) {
  pendingRename = { folder, name, button };
  const dialog = document.getElementById("rename-folder-dialog");
  const input = document.getElementById("rename-folder-name");
  input.value = name;
  setLocalError(document.getElementById("rename-folder-error"), "");
  dialog.showModal();
  input.focus();
  input.select();
}
async function removeFolder(folder, name, button) {
  if (!confirm('Remove empty folder "' + name + '"? Only empty folders can be removed. This cannot be undone.')) return;
  const errorTarget = actionErrorFor(button);
  setLocalError(errorTarget, "");
  await withBusy(button, "Removing…", async () => {
    try {
      const result = await requestFolderMutation("/api/hub/folders/remove", { path: folder });
      if (result) await refreshAfterFolderMutation();
    } catch (error) {
      setLocalError(errorTarget, 'Could not remove "' + name + '": ' + error.message);
    }
  });
}
async function loadBrowser({ fallbackToParent = false } = {}) {
  let listing;
  try {
    const query = browsePath === null ? "" : "?path=" + encodeURIComponent(browsePath);
    const response = await fetch("/api/hub/browse" + query);
    if (!response.ok) {
      if (fallbackToParent && response.status === 404 && browseParent) {
        browsePath = browseParent;
        if (await loadBrowser()) {
          setLocalError(document.getElementById("browser-error"), "The folder being viewed is no longer available. Showing its parent; another client may have renamed or removed it.");
          return true;
        }
      }
      const payload = await response.json().catch(() => ({}));
      setLocalError(document.getElementById("browser-error"), payload.error || "This folder could not be refreshed. Check that it still exists and is readable.");
      return false;
    }
    listing = await response.json();
  } catch (error) {
    setLocalError(document.getElementById("browser-error"), error.message || "This folder could not be refreshed. Check the Hub connection.");
    return false;
  }
  browsePath = listing.path;
  browseParent = listing.parent;
  setLocalError(document.getElementById("browser-error"), "");
  document.getElementById("browse-path").textContent = listing.path;
  const rows = [];
  if (listing.parent) {
    rows.push(row({
      title: "..",
      titleClick: () => { browsePath = listing.parent; loadBrowser(); },
      detail: "up",
    }));
  }
  for (const dir of listing.dirs) {
    const folder = childFolderPath(listing.path, dir.name);
    const registered = Boolean(dir.registeredId);
    // Lifecycle-aware rows: unregistered folders offer Add workspace,
    // registered stopped ones Start (through the credential-aware flow),
    // running ones Open. Filesystem actions keep explicit folder nouns.
    rows.push(row({
      title: dir.name,
      titleClick: () => { browsePath = folder; loadBrowser(); },
      detail: registered && dir.displayName && dir.displayName !== dir.name ? 'workspace "' + dir.displayName + '"' : undefined,
      chip: registered ? (dir.running ? "running" : "stopped") : (dir.git ? "git" : "no git"),
      chipWarn: !registered && !dir.git,
      buttons: [
        registered
          ? (dir.running
            ? { label: "Open", ariaLabel: "Open " + (dir.displayName || dir.name), onClick: () => openSession(dir.registeredId) }
            : {
              label: "Start",
              ariaLabel: "Start " + (dir.displayName || dir.name),
              onClick: button => startRegisteredWorkspace(workspaceById(dir.registeredId), button, document.getElementById("browser-error")),
            })
          : {
            label: "Add workspace",
            ariaLabel: "Add workspace for " + dir.name,
            onClick: () => openAddWorkspaceDialog(folder, dir.name, dir.git),
          },
        { label: "Rename folder", ariaLabel: "Rename folder " + dir.name, onClick: button => openRenameFolder(folder, dir.name, button) },
        {
          label: "Remove folder",
          ariaLabel: "Remove folder " + dir.name,
          className: "danger",
          onClick: button => removeFolder(folder, dir.name, button),
        },
      ],
    }));
  }
  renderInto(document.getElementById("browser"), rows, "No subfolders here.");
  return true;
}
async function refresh(force) {
  if (!force && uiBusy > 0) return;
  let state;
  try {
    const stateResponse = await fetch("/api/hub/state");
    if (!stateResponse.ok) return;
    state = await stateResponse.json();
  } catch { return; }

  document.getElementById("hub-version").textContent = state.version || "";
  dashboardWorkspaces = state.workspaces || [];

  const running = state.workspaces.filter(w => w.running);
  renderInto(
    document.getElementById("sessions"),
    running.map(w => row({
      title: workspaceLabel(w),
      href: sessionUrl(w.id),
      path: w.path,
      detail: credentialAssignmentSummary(w.credentialAssignments) + " · " + shellSummary(w.shells),
      live: true,
      buttons: [
        {
          label: "Rename workspace",
          ariaLabel: "Rename workspace " + workspaceLabel(w),
          onClick: button => renameWorkspace(w, button, () => refresh(true)),
        },
        {
          label: "Stop",
          className: "danger",
          onClick: async button => {
            if (!confirm('Stop session "' + workspaceLabel(w) + '"? Its shells will be terminated.')) return;
            const errorTarget = actionErrorFor(button);
            setLocalError(errorTarget, "");
            await withBusy(button, "Stopping…", async () => {
              try { await api("/api/hub/sessions/" + encodeURIComponent(w.id) + "/stop"); await refresh(true); }
              catch (error) { setLocalError(errorTarget, error.message); }
            });
          },
        },
      ],
    })),
    "No sessions running — start a workspace below.",
  );

  const stopped = state.workspaces.filter(w => !w.running);
  const rows = [
    ...stopped.map(w => row({
      title: workspaceLabel(w),
      path: w.path,
      detail: credentialAssignmentSummary(w.credentialAssignments),
      live: false,
      buttons: [
        {
          label: "Start",
          ariaLabel: "Start " + workspaceLabel(w),
          onClick: button => startRegisteredWorkspace(w, button),
        },
        {
          label: "Rename workspace",
          ariaLabel: "Rename workspace " + workspaceLabel(w),
          onClick: button => renameWorkspace(w, button, () => refresh(true)),
        },
        {
          // Remove from Hub unregisters only; the folder stays on disk.
          label: "Remove from Hub",
          ariaLabel: "Remove " + workspaceLabel(w) + " from Hub",
          className: "danger",
          onClick: async button => {
            const errorTarget = actionErrorFor(button);
            setLocalError(errorTarget, "");
            try {
              await api("/api/hub/workspaces/" + encodeURIComponent(w.id) + "/forget");
              await refresh();
            } catch (error) { setLocalError(errorTarget, error.message); }
          },
        },
      ],
    })),
  ];
  renderInto(
    document.getElementById("workspaces"),
    rows,
    "No stopped workspaces — use Add workspace to configure one.",
  );
}
// The device-session list: every active session of the signed-in user,
// with per-session revocation. Revoking the current session IS sign-out and
// goes through the real /logout form post — not the revoke API — so native
// wrappers that watch for the logout navigation (UatuCode Desktop discards
// its Keychain credentials on it) see this sign-out too; a background fetch
// followed by a location change would be invisible to them.
async function loadDevices() {
  let listing;
  try {
    const response = await fetch("/api/hub/sessions");
    if (!response.ok) return;
    listing = await response.json();
  } catch { return; }
  const rows = listing.sessions.map(s => row({
    title: s.deviceLabel,
    chip: s.current ? "this device" : undefined,
    detail: "signed in " + new Date(s.issuedAt * 1000).toLocaleString(),
    button: s.current
      ? {
          label: "Sign out",
          className: "danger",
          onClick: () => {
            const form = document.createElement("form");
            form.method = "post";
            form.action = "/logout";
            form.hidden = true;
            document.body.appendChild(form);
            form.submit();
          },
        }
      : {
          label: "Revoke",
          className: "danger",
          onClick: async button => {
            const errorTarget = actionErrorFor(button);
            setLocalError(errorTarget, "");
            await withBusy(button, "Revoking…", async () => {
              try {
                await api("/api/hub/sessions/" + encodeURIComponent(s.handle) + "/revoke");
                await loadDevices();
              } catch (error) { setLocalError(errorTarget, error.message); }
            });
          },
        },
  }));
  renderInto(document.getElementById("devices"), rows, "No active sessions.");
}
function initClonePage() {
initSharedUidAdvisory();
const newFolderForm = document.getElementById("new-folder-form");
const newFolderName = document.getElementById("new-folder-name");
const newFolderError = document.getElementById("new-folder-error");
const renameFolderDialog = document.getElementById("rename-folder-dialog");
const renameFolderForm = document.getElementById("rename-folder-form");
const renameFolderName = document.getElementById("rename-folder-name");
const renameFolderError = document.getElementById("rename-folder-error");
const renameFolderCancel = document.getElementById("rename-folder-cancel");
const renameFolderSubmit = document.getElementById("rename-folder-submit");
const cloneForm = document.getElementById("clone-form");
const clonePanel = document.getElementById("clone-panel");
const clonePhase = document.getElementById("clone-phase");
const cloneOutput = document.getElementById("clone-output");
const cloneIndicator = document.getElementById("clone-indicator");
const cloneResponseForm = document.getElementById("clone-response-form");
const cloneResponse = document.getElementById("clone-response");
const cloneResponseLabel = document.getElementById("clone-response-label");
const cloneCancel = document.getElementById("clone-cancel");
const cloneCredential = document.getElementById("clone-credential");
const cloneDisplayName = document.getElementById("clone-display-name");
const cloneRetainedAuth = document.getElementById("clone-retained-auth");
const cloneSigning = document.getElementById("clone-signing");
const cloneStartAfter = document.getElementById("clone-start-after");
const cloneUnlock = document.getElementById("clone-unlock");
const cloneUnlockPassphrase = document.getElementById("clone-unlock-passphrase");
const cloneFormError = document.getElementById("clone-form-error");
const cloneActionError = document.getElementById("clone-action-error");
const cloneSubmit = cloneForm.querySelector("button");
const cloneOutputLimit = 64 * 1024;
const cloneJobStorageKey = "uatu.activeCloneJob";
let cloneJobId = sessionStorage.getItem(cloneJobStorageKey);
let cloneEvents = null;
let cloneBusy = false;
let clonePromptText = "";

newFolderForm.onsubmit = async event => {
  event.preventDefault();
  // Same contract as the rename dialog: the server accepts visible padded
  // names, so only emptiness is judged trimmed and the typed name is
  // submitted as-is.
  const name = newFolderName.value;
  if (!name.trim()) return;
  setLocalError(newFolderError, "");
  const button = newFolderForm.querySelector('button[type="submit"]');
  await withBusy(button, "Creating…", async () => {
    try {
      await api("/api/hub/folders/create", { parent: browsePath, name });
      newFolderName.value = "";
      await refreshAfterFolderMutation();
    } catch (error) {
      setLocalError(newFolderError, 'Could not create "' + name + '": ' + error.message);
    }
  });
};
renameFolderCancel.onclick = () => {
  pendingRename = null;
  setLocalError(renameFolderError, "");
  renameFolderDialog.close();
};
renameFolderDialog.addEventListener("cancel", event => {
  if (renameFolderSubmit.disabled) {
    event.preventDefault();
    return;
  }
  pendingRename = null;
  setLocalError(renameFolderError, "");
});
renameFolderForm.onsubmit = async event => {
  event.preventDefault();
  if (!pendingRename) return;
  const rename = pendingRename;
  // Emptiness is judged on the trimmed value, but the submitted name keeps
  // its whitespace: the server accepts visible padded names, and the field
  // is pre-filled with the current basename — trimming here would silently
  // rename " project " on an untouched submit.
  const name = renameFolderName.value;
  if (!name.trim()) return;
  setLocalError(renameFolderError, "");
  renameFolderSubmit.disabled = true;
  renameFolderCancel.disabled = true;
  renameFolderName.disabled = true;
  await withBusy(rename.button, "Renaming…", async () => {
    try {
      const result = await requestFolderMutation("/api/hub/folders/rename", { path: rename.folder, name });
      if (!result) return;
      pendingRename = null;
      renameFolderDialog.close();
      await refreshAfterFolderMutation();
    } catch (error) {
      setLocalError(renameFolderError, 'Could not rename "' + rename.name + '": ' + error.message);
    }
  });
  renameFolderSubmit.disabled = false;
  renameFolderCancel.disabled = false;
  renameFolderName.disabled = false;
};

async function loadCloneCredentials() {
  try {
    const response = await fetch(credentialPath);
    if (!response.ok) return;
    const payload = await response.json();
    credentialCatalog = payload.credentials || [];
    updateCloneCredentials();
    updateOnboardingCredentialSelects();
  } catch (error) { showError(error.message); }
}

// --- Add workspace (existing folder) dialog -------------------------------
const addWorkspaceDialog = document.getElementById("add-workspace-dialog");
const addWorkspaceForm = document.getElementById("add-workspace-form");
const addWorkspacePath = document.getElementById("add-workspace-path");
const addWorkspaceName = document.getElementById("add-workspace-name");
const addWorkspaceAuth = document.getElementById("add-workspace-auth");
const addWorkspaceHost = document.getElementById("add-workspace-host");
const addWorkspaceSigning = document.getElementById("add-workspace-signing");
const addWorkspaceError = document.getElementById("add-workspace-error");
const addWorkspaceCancel = document.getElementById("add-workspace-cancel");
const addWorkspaceStart = document.getElementById("add-workspace-start");
const addWorkspaceSubmit = document.getElementById("add-workspace-submit");
const createWorkspaceDialog = document.getElementById("create-workspace-dialog");
const createWorkspaceForm = document.getElementById("create-workspace-form");
const createWorkspaceParent = document.getElementById("create-workspace-parent");
const createWorkspaceFolder = document.getElementById("create-workspace-folder");
const createWorkspaceName = document.getElementById("create-workspace-name");
const createWorkspaceAuth = document.getElementById("create-workspace-auth");
const createWorkspaceHost = document.getElementById("create-workspace-host");
const createWorkspaceSigning = document.getElementById("create-workspace-signing");
const createWorkspaceError = document.getElementById("create-workspace-error");
const createWorkspaceCancel = document.getElementById("create-workspace-cancel");
const createWorkspaceSubmit = document.getElementById("create-workspace-submit");
let pendingAddWorkspace = null;
let addWorkspaceBusy = false;
let createWorkspaceBusy = false;

function updateOnboardingCredentialSelects() {
  fillCredentialSelect(addWorkspaceAuth, authCapableCredentials(), "None");
  fillCredentialSelect(addWorkspaceSigning, signingCapableCredentials(), "None");
  fillCredentialSelect(createWorkspaceAuth, authCapableCredentials(), "None");
  fillCredentialSelect(createWorkspaceSigning, signingCapableCredentials(), "None");
  syncAuthHost(addWorkspaceAuth, addWorkspaceHost);
  syncAuthHost(createWorkspaceAuth, createWorkspaceHost);
}
addWorkspaceAuth.addEventListener("change", () => syncAuthHost(addWorkspaceAuth, addWorkspaceHost));
createWorkspaceAuth.addEventListener("change", () => syncAuthHost(createWorkspaceAuth, createWorkspaceHost));

function setAddWorkspaceBusy(busy) {
  addWorkspaceBusy = busy;
  for (const control of [addWorkspaceName, addWorkspaceAuth, addWorkspaceHost, addWorkspaceSigning, addWorkspaceCancel, addWorkspaceStart, addWorkspaceSubmit]) {
    control.disabled = busy;
  }
  if (!busy) syncAuthHost(addWorkspaceAuth, addWorkspaceHost);
}
openAddWorkspaceDialog = (folder, name, git) => {
  pendingAddWorkspace = { folder, git };
  addWorkspacePath.textContent = folder;
  addWorkspaceName.value = name;
  setLocalError(addWorkspaceError, "");
  updateOnboardingCredentialSelects();
  setAddWorkspaceBusy(false);
  addWorkspaceDialog.showModal();
  addWorkspaceName.focus();
  addWorkspaceName.select();
};
addWorkspaceCancel.onclick = () => {
  // Cancellation is mutation-free: nothing was sent.
  pendingAddWorkspace = null;
  addWorkspaceDialog.close();
};
addWorkspaceDialog.addEventListener("cancel", event => {
  if (addWorkspaceBusy) { event.preventDefault(); return; }
  pendingAddWorkspace = null;
});
// Commits the configuration (always stopped — start is a separate explicit
// step so locked credentials go through the masked unlock flow). Returns the
// onboarding result, or null when the user declined or an error was shown;
// the form is preserved for correction on failure.
async function submitAddWorkspace(start) {
  if (!pendingAddWorkspace) return null;
  const folder = pendingAddWorkspace.folder;
  const authentication = authSelectionFrom(addWorkspaceAuth, addWorkspaceHost, addWorkspaceError);
  if (authentication === null) return null;
  const request = {
    path: folder,
    displayName: addWorkspaceName.value.trim(),
    authentication,
    signing: addWorkspaceSigning.value || null,
  };
  if (start) request.start = true;
  if (!pendingAddWorkspace.git) {
    if (!confirm('"' + folder + '" is not a git repository. Initialize one with git init and add it?')) return null;
    request.init = true;
  }
  try {
    return await api("/api/hub/workspaces/configure", request);
  } catch (error) {
    if (error.payload && error.payload.needsInit) {
      if (!confirm('"' + folder + '" is not a git repository. Initialize one with git init and add it?')) return null;
      try { return await api("/api/hub/workspaces/configure", { ...request, init: true }); }
      catch (inner) { setLocalError(addWorkspaceError, inner.message); return null; }
    }
    setLocalError(addWorkspaceError, error.message);
    return null;
  }
}
addWorkspaceForm.onsubmit = async event => {
  event.preventDefault();
  if (addWorkspaceBusy) return;
  setLocalError(addWorkspaceError, "");
  setAddWorkspaceBusy(true);
  addWorkspaceSubmit.textContent = "Adding…";
  const result = await submitAddWorkspace();
  setAddWorkspaceBusy(false);
  addWorkspaceSubmit.textContent = "Add workspace";
  if (!result) return;
  pendingAddWorkspace = null;
  addWorkspaceDialog.close();
  await refreshAfterFolderMutation();
};
addWorkspaceStart.onclick = async () => {
  if (addWorkspaceBusy) return;
  setLocalError(addWorkspaceError, "");
  // The requested first start runs inside the commit's lifecycle section
  // on the server — a separate start after the commit could target an
  // entry another client already forgot. Locked selected credentials
  // would doom that in-commit start, so they go through the masked
  // unlock dialog first.
  const lockedSelected = [...new Set([addWorkspaceAuth.value, addWorkspaceSigning.value]
    .filter(Boolean)
    .map(id => credentialCatalog.find(item => item.id === id))
    .filter(item => item && isCredentialLocked(item)))];
  if (lockedSelected.length > 0 && !(await unlockCredentialsDialog(
    "Unlock credentials to start the workspace",
    "The selected workspace credentials must be unlocked before the started session can use them.",
    "Unlock and start",
    lockedSelected,
    loadCloneCredentials,
  ))) return;
  setAddWorkspaceBusy(true);
  addWorkspaceStart.textContent = "Adding…";
  const result = await submitAddWorkspace(true);
  setAddWorkspaceBusy(false);
  addWorkspaceStart.textContent = "Add and start";
  if (!result) return;
  pendingAddWorkspace = null;
  addWorkspaceDialog.close();
  await refreshAfterFolderMutation();
  if (result.started) {
    openSession(result.workspace.id);
    return;
  }
  // The configuration committed; a failed requested start (or a pending
  // recovery) leaves the stopped workspace in place.
  const label = result.workspace.displayName || result.workspace.id;
  setLocalError(
    document.getElementById("browser-error"),
    result.startError
      ? 'Could not start "' + label + '": ' + result.startError
      : result.recoveryRequired
        ? '"' + label + '" was added stopped: ' + result.recoveryRequired
        : '"' + label + '" was added stopped.',
  );
};

// --- Create workspace dialog ---------------------------------------------
// Folder and workspace names track each other until the workspace name is
// edited on its own.
let createNameLinked = true;
createWorkspaceFolder.addEventListener("input", () => {
  if (createNameLinked) createWorkspaceName.value = createWorkspaceFolder.value;
});
createWorkspaceName.addEventListener("input", () => {
  createNameLinked = createWorkspaceName.value === createWorkspaceFolder.value;
});
function setCreateWorkspaceBusy(busy) {
  createWorkspaceBusy = busy;
  for (const control of [createWorkspaceFolder, createWorkspaceName, createWorkspaceAuth, createWorkspaceHost, createWorkspaceSigning, createWorkspaceCancel, createWorkspaceSubmit]) {
    control.disabled = busy;
  }
  if (!busy) syncAuthHost(createWorkspaceAuth, createWorkspaceHost);
}
document.getElementById("create-workspace-open").onclick = () => {
  createWorkspaceParent.textContent = "In " + (browsePath || "the default workspace folder");
  createWorkspaceFolder.value = "";
  createWorkspaceName.value = "";
  createNameLinked = true;
  setLocalError(createWorkspaceError, "");
  updateOnboardingCredentialSelects();
  setCreateWorkspaceBusy(false);
  createWorkspaceDialog.showModal();
  createWorkspaceFolder.focus();
};
createWorkspaceCancel.onclick = () => createWorkspaceDialog.close();
createWorkspaceDialog.addEventListener("cancel", event => {
  if (createWorkspaceBusy) event.preventDefault();
});
createWorkspaceForm.onsubmit = async event => {
  event.preventDefault();
  if (createWorkspaceBusy) return;
  setLocalError(createWorkspaceError, "");
  const authentication = authSelectionFrom(createWorkspaceAuth, createWorkspaceHost, createWorkspaceError);
  if (authentication === null) return;
  setCreateWorkspaceBusy(true);
  createWorkspaceSubmit.textContent = "Creating…";
  try {
    await api("/api/hub/workspaces/create", {
      parent: browsePath,
      folderName: createWorkspaceFolder.value,
      displayName: createWorkspaceName.value.trim(),
      authentication,
      signing: createWorkspaceSigning.value || null,
    });
    createWorkspaceDialog.close();
    await refreshAfterFolderMutation();
  } catch (error) {
    // Actionable failures preserve the form. A retained initialized
    // repository is called out with its retry path.
    const retained = error.payload && error.payload.retainedPath;
    setLocalError(createWorkspaceError, retained
      ? error.message + ' Use "Add workspace" on the retained folder to finish adding it.'
      : error.message);
  }
  setCreateWorkspaceBusy(false);
  createWorkspaceSubmit.textContent = "Create workspace";
};

function remoteKind(url) {
  const value = url.trim().toLowerCase();
  if (value.startsWith("https://")) return "https";
  if (value.startsWith("ssh://") || value.startsWith("git+ssh://")) return "ssh";
  if (/^(?:[^@/:\\s]+@)?(?:\\[[^\\]]+\\]|[^/:\\s]+):[^/].*$/.test(value) && !/^[a-z]:[\\\\/]/.test(value)) return "ssh";
  return null;
}
function normalizedUrlHost(url) {
  const value = url.trim();
  try {
    const parsed = new URL(value);
    if (!parsed.hostname) return null;
    const hostname = parsed.hostname.endsWith(".") ? parsed.hostname.slice(0, -1) : parsed.hostname;
    // WHATWG URL parsing erases an explicit default HTTPS port. Preserve the
    // original authority spelling so an SSH assignment to :443 does not
    // broaden into an all-ports host match.
    const authority = value.slice(value.indexOf("://") + 3).split("/")[0].split("?")[0].split("#")[0] || parsed.host;
    const port = parsed.port || (parsed.protocol === "https:" && /:0*443$/.test(authority) ? "443" : "");
    return hostname.toLowerCase() + (port ? ":" + port : "");
  } catch { return null; }
}
function cloneCompatible(credential, kind, url) {
  if (!credential.enabled || !kind) return false;
  if (kind === "ssh") return credential.type === "ssh" && credential.capabilities.includes("ssh-authentication");
  if (credential.type !== "token" || !credential.capabilities.includes("https-git")) return false;
  // Mirror the server's provider-host normalization (trailing dot, case)
  // so every URL the backend accepts for a stored token is selectable here.
  const host = normalizedUrlHost(url);
  return host !== null && host === credential.metadata.host.toLowerCase();
}
// Host a retained authentication selection applies to: tokens pin their
// provider host; SSH keys use the clone URL's remote host.
function remoteHostFromUrl(url) {
  const value = url.trim();
  const urlHost = normalizedUrlHost(value);
  if (urlHost !== null) return urlHost;
  // The server's clone-remote pattern, inlined so a bracketed IPv6 literal
  // is captured whole instead of being cut at its first colon. Brackets
  // survive on an address (that is the stored host form) and are stripped
  // from a decorative bracketing of a plain host, exactly as the server
  // does before normalizing.
  const scp = /${SCP_REMOTE_PATTERN.source}/.exec(value);
  if (!scp) return null;
  const literal = scp[1].toLowerCase();
  return literal.startsWith("[") && !literal.includes(":") ? literal.replace(/^\\[|\\]$/g, "") : literal;
}
function retainedHostFor(credential) {
  if (!credential) return null;
  if (credential.type === "token") return credential.metadata.host;
  return remoteHostFromUrl(document.getElementById("clone-url").value) || "github.com";
}
function updateCloneCredentials() {
  const selected = cloneCredential.value;
  const url = document.getElementById("clone-url").value;
  const kind = remoteKind(url);
  cloneCredential.replaceChildren(new Option("None — answer prompts interactively", ""));
  for (const credential of credentialCatalog.filter(item => cloneCompatible(item, kind, url))) {
    const suffix = isCredentialLocked(credential) ? " (unlock required)" : "";
    cloneCredential.appendChild(new Option(credential.name + " · " + credentialHost(credential) + suffix, credential.id));
  }
  if ([...cloneCredential.options].some(option => option.value === selected)) cloneCredential.value = selected;
  fillCredentialSelect(cloneRetainedAuth, authCapableCredentials(), "None");
  fillCredentialSelect(cloneSigning, signingCapableCredentials(), "None");
  updateCloneCredentialState();
}
// The retained workspace authentication is an explicit choice: selecting a
// clone credential NEVER pre-fills this control — a submit with it untouched
// must retain nothing, so the only way an assignment persists is the user
// picking it here.
function updateCloneCredentialState() {
  const selected = credentialCatalog.find(item => item.id === cloneCredential.value);
  cloneUnlock.hidden = !selected || !isCredentialLocked(selected);
  if (cloneUnlock.hidden) cloneUnlockPassphrase.value = "";
}
document.getElementById("clone-url").addEventListener("input", updateCloneCredentials);
cloneCredential.addEventListener("change", updateCloneCredentialState);
// The workspace display name tracks the checkout folder name until edited.
let cloneNameTouched = false;
cloneDisplayName.addEventListener("input", () => {
  cloneNameTouched = cloneDisplayName.value !== document.getElementById("clone-folder-name").value;
});
document.getElementById("clone-folder-name").addEventListener("input", () => {
  if (!cloneNameTouched) cloneDisplayName.value = document.getElementById("clone-folder-name").value;
});

function setCloneActive(active) {
  cloneResponseForm.hidden = !active;
  cloneResponse.disabled = !active;
  cloneResponseForm.querySelector('button[type="submit"]').disabled = !active;
  cloneCancel.disabled = !active;
  cloneIndicator.classList.toggle("is-live", active);
  cloneSubmit.disabled = active;
  document.getElementById("clone-url").disabled = active;
  document.getElementById("clone-folder-name").disabled = active;
  cloneDisplayName.disabled = active;
  cloneCredential.disabled = active;
  cloneRetainedAuth.disabled = active;
  cloneSigning.disabled = active;
  cloneStartAfter.disabled = active;
  cloneUnlockPassphrase.disabled = active;
}
function setClonePhase(phase, label) {
  const labels = {
    cloning: "Cloning…",
    registering: "Registering workspace…",
    starting: "Starting session…",
  };
  clonePhase.textContent = label || labels[phase] || phase || "Working…";
}
function appendCloneOutput(text) {
  if (!text) return;
  cloneOutput.textContent += text;
  if (cloneOutput.textContent.length > cloneOutputLimit) {
    cloneOutput.textContent = cloneOutput.textContent.slice(-cloneOutputLimit);
  }
  cloneOutput.scrollTop = cloneOutput.scrollHeight;
  clonePromptText = (clonePromptText + text).slice(-2048).toLowerCase();
  classifyClonePrompt();
}
function classifyClonePrompt() {
  let label = "Terminal response";
  if (/passphrase[^\\n]*:?\\s*$/.test(clonePromptText)) label = "Passphrase";
  else if (/(password|token)[^\\n]*:?\\s*$/.test(clonePromptText)) label = "Password or token";
  else if (/username[^\\n]*:?\\s*$/.test(clonePromptText)) label = "Username";
  else if (/(authenticity of host|continue connecting|yes\\/no)[^\\n]*$/.test(clonePromptText)) label = "Host trust response";
  else if (/(verification|one[- ]time|otp|code)[^\\n]*:?\\s*$/.test(clonePromptText)) label = "Verification response";
  cloneResponseLabel.textContent = label;
  if (label !== "Terminal response" && !cloneResponse.disabled) cloneResponse.focus({ preventScroll: true });
}
function closeCloneEvents() {
  if (cloneEvents) cloneEvents.close();
  cloneEvents = null;
}
function clearCloneState() {
  closeCloneEvents();
  cloneJobId = null;
  sessionStorage.removeItem(cloneJobStorageKey);
  setCloneActive(false);
  if (cloneBusy) {
    cloneBusy = false;
    uiBusy -= 1;
  }
}
// The submitted form survives the whole job. An accepted job can still end in
// clone-failed or register-failed, and finishClone re-enables this same form
// for the retry, so only a successful terminal result clears it — exactly as
// a failure to create the job preserves it. A page reload mid-job renders a
// fresh empty form and the job's events carry no form values, so a failure
// after a reload starts blank.
function resetCloneForm() {
  document.getElementById("clone-url").value = "";
  document.getElementById("clone-folder-name").value = "";
  cloneDisplayName.value = "";
  cloneNameTouched = false;
  cloneCredential.value = "";
  cloneRetainedAuth.value = "";
  cloneSigning.value = "";
  cloneStartAfter.checked = false;
  updateCloneCredentialState();
}
function parseCloneEvent(event) {
  try { return JSON.parse(event.data); }
  catch { return {}; }
}
function handleCloneEvent(payload) {
  const data = payload.data || payload;
  if (payload.type === "output") appendCloneOutput(data.text || data.output || "");
  else if (payload.type === "phase") setClonePhase(data.phase, data.label);
  else if (payload.type === "result") finishClone(data);
}
async function finishClone(result) {
  clearCloneState();
  const status = result.status || result.result;
  const labels = {
    cancelled: "Clone cancelled.",
    "timed-out": "Clone timed out.",
    "clone-failed": "Clone failed.",
    "register-failed": "Workspace registration failed.",
    "start-failed": result.workspaceId
      ? "Workspace added stopped, but the requested session start failed. Start it from its folder row or the dashboard."
      : "Clone completed, but the session could not start.",
    "cleanup-failed": "Clone cleanup failed; review the output and workspace state.",
    succeeded: result.running === false
      ? "Workspace added. Start it from its folder row or the dashboard."
      : "Clone complete. Opening session…",
  };
  const error = result.error || result.message;
  setClonePhase(status, labels[status] || error || "Clone ended.");
  cloneResponse.value = "";
  cloneResponseLabel.textContent = "Terminal response";
  if (error && status !== "succeeded") appendCloneOutput((cloneOutput.textContent ? "\\n" : "") + error + "\\n");
  if (status === "succeeded") {
    resetCloneForm();
    const workspaceId = result.workspaceId || result.id;
    if (workspaceId && result.running !== false) {
      // Only an explicitly requested successful start navigates.
      await loadBrowser();
      openSession(workspaceId);
      return;
    }
  }
  await Promise.all([loadBrowser(), refreshWorkspaceState().catch(() => {})]);
}
function connectCloneEvents() {
  closeCloneEvents();
  if (!cloneJobId) return;
  const jobId = cloneJobId;
  const events = new EventSource("/api/hub/clone-jobs/" + encodeURIComponent(jobId) + "/events");
  cloneEvents = events;
  events.addEventListener("output", event => {
    const payload = parseCloneEvent(event);
    const data = payload.data || payload;
    appendCloneOutput(data.text || data.output || "");
  });
  events.addEventListener("phase", event => {
    const payload = parseCloneEvent(event);
    const data = payload.data || payload;
    setClonePhase(data.phase, data.label);
  });
  events.addEventListener("result", event => {
    const payload = parseCloneEvent(event);
    finishClone(payload.data || payload);
  });
  // Accept typed JSON on the default SSE message event as well as named SSE
  // events; the payload contract remains identical in both transports.
  events.onmessage = event => handleCloneEvent(parseCloneEvent(event));
  events.onopen = () => { if (cloneJobId === jobId) setClonePhase(null, clonePhase.textContent === "Reconnecting…" ? "Connected." : clonePhase.textContent); };
  events.onerror = async () => {
    if (cloneJobId !== jobId) return;
    setClonePhase(null, "Reconnecting…");
    try {
      const response = await fetch("/api/hub/clone-jobs/" + encodeURIComponent(jobId) + "/events", { method: "HEAD" });
      if (response.status === 404 && cloneJobId === jobId) {
        clearCloneState();
        setClonePhase(null, "Previous clone job is no longer available.");
      }
    } catch {}
  };
}
cloneForm.onsubmit = async event => {
  event.preventDefault();
  setLocalError(cloneFormError, "");
  const input = document.getElementById("clone-url");
  const folderNameInput = document.getElementById("clone-folder-name");
  const url = input.value.trim();
  const folderName = folderNameInput.value.trim();
  const selectedCredential = credentialCatalog.find(item => item.id === cloneCredential.value);
  if (!url) return;
  const button = event.target.querySelector("button");
  uiBusy += 1;
  cloneBusy = true;
  button.disabled = true;
  document.getElementById("clone-url").disabled = true;
  folderNameInput.disabled = true;
  button.textContent = "Starting…";
  clonePanel.hidden = false;
  cloneResponseForm.hidden = true;
  cloneOutput.textContent = "";
  clonePromptText = "";
  cloneResponseLabel.textContent = "Terminal response";
  setClonePhase("cloning", "Starting clone…");
  try {
    if (selectedCredential && isCredentialLocked(selectedCredential)) {
      // Empty is a valid unlock for an unencrypted SSH key; the server
      // rejects an empty passphrase whenever the key actually needs one.
      const passphrase = cloneUnlockPassphrase.value;
      cloneUnlockPassphrase.value = "";
      await api(credentialPath + "/" + encodeURIComponent(selectedCredential.id) + "/unlock", { passphrase });
      await loadCloneCredentials();
    }
    const retainedCredential = credentialCatalog.find(item => item.id === cloneRetainedAuth.value);
    const signingCredential = credentialCatalog.find(item => item.id === cloneSigning.value);
    if (cloneStartAfter.checked) {
      // A requested start resolves the retained and signing credentials at
      // session launch; a locked one would turn the finished clone into a
      // deterministic start failure, so they go through the masked unlock
      // dialog now (the clone credential was unlocked above).
      const lockedForStart = [...new Set([retainedCredential, signingCredential]
        .filter(item => item && (!selectedCredential || item.id !== selectedCredential.id))
        .filter(isCredentialLocked))];
      if (lockedForStart.length > 0 && !(await unlockCredentialsDialog(
        "Unlock credentials to start after clone",
        "The selected workspace credentials must be unlocked before the started session can use them.",
        "Unlock and clone",
        lockedForStart,
        loadCloneCredentials,
      ))) {
        throw new Error("start after clone needs the selected workspace credentials unlocked");
      }
    }
    const request = { url, dest: browsePath, folderName, start: cloneStartAfter.checked };
    const displayName = cloneDisplayName.value.trim();
    if (displayName) request.displayName = displayName;
    if (selectedCredential) request.credentialId = selectedCredential.id;
    if (retainedCredential) {
      request.retainedAuthentication = [{ credentialId: retainedCredential.id, host: retainedHostFor(retainedCredential) }];
    }
    if (cloneSigning.value) request.signing = cloneSigning.value;
    const result = await api("/api/hub/clone-jobs", request);
    cloneJobId = result.jobId;
    if (!cloneJobId) throw new Error("clone job did not return an id");
    sessionStorage.setItem(cloneJobStorageKey, cloneJobId);
    button.textContent = "Clone";
    setCloneActive(true);
    connectCloneEvents();
  } catch (error) {
    // The form is preserved on an actionable failure.
    setLocalError(cloneFormError, error.message);
    setClonePhase("clone-failed", "Could not start clone.");
    setCloneActive(false);
    cloneBusy = false;
    uiBusy -= 1;
    button.disabled = false;
    input.disabled = false;
    folderNameInput.disabled = false;
    cloneDisplayName.disabled = false;
    cloneCredential.disabled = false;
    cloneRetainedAuth.disabled = false;
    cloneSigning.disabled = false;
    cloneStartAfter.disabled = false;
    cloneUnlockPassphrase.disabled = false;
    button.textContent = "Clone";
  }
};
cloneResponseForm.onsubmit = async event => {
  event.preventDefault();
  if (!cloneJobId) return;
  const input = cloneResponse.value;
  cloneResponse.value = "";
  setLocalError(cloneActionError, "");
  try { await api("/api/hub/clone-jobs/" + encodeURIComponent(cloneJobId) + "/input", { input }); }
  catch (error) { setLocalError(cloneActionError, error.message); }
};
cloneCancel.onclick = async () => {
  if (!cloneJobId) return;
  cloneCancel.disabled = true;
  setLocalError(cloneActionError, "");
  setClonePhase(null, "Cancelling…");
  try { await api("/api/hub/clone-jobs/" + encodeURIComponent(cloneJobId) + "/cancel"); }
  catch (error) { setLocalError(cloneActionError, error.message); cloneCancel.disabled = false; }
};
window.addEventListener("pageshow", event => {
  if (!event.persisted) return;
  for (const overlay of document.querySelectorAll(".nav-overlay")) overlay.remove();
  closeCloneEvents();
  uiBusy = cloneJobId ? 1 : 0;
  cloneBusy = Boolean(cloneJobId);
  if (cloneJobId) connectCloneEvents();
  loadBrowser();
  loadCloneCredentials();
  refreshWorkspaceState().catch(() => {});
});
loadBrowser();
loadCloneCredentials();
refreshWorkspaceState().catch(() => {});
if (cloneJobId) {
  clonePanel.hidden = false;
  cloneBusy = true;
  uiBusy = 1;
  setCloneActive(true);
  setClonePhase(null, "Reconnecting…");
  connectCloneEvents();
}
}
function values(form, name) {
  return [...form.querySelectorAll('[name="' + name + '"]:checked')].map(input => input.value);
}
function bindCredentialForm(id, endpoint, buildBody) {
  const form = document.getElementById(id);
  const errorTarget = form.querySelector("[data-form-error]");
  form.onsubmit = async event => {
    event.preventDefault();
    setLocalError(errorTarget, "");
    const button = form.querySelector('button[type="submit"]');
    await withBusy(button, "Working…", async () => {
      try {
        const data = new FormData(form);
        const body = await buildBody(data, form);
        await api(endpoint, body);
        form.reset();
        await loadCredentials();
      } catch (error) {
        setLocalError(errorTarget, error.message);
      } finally {
        form.querySelectorAll('input[type="password"], input[type="file"], textarea').forEach(input => { input.value = ""; });
      }
    });
  };
}
function describeWorkspaceDefaults(state) {
  if (!state.configured) return "No default configured — onboarding starts at the Hub user's home directory (" + state.effective + ").";
  if (state.configuredAvailable) return "Configured default: " + state.configured;
  return "Configured default " + state.configured + " is currently unavailable; onboarding falls back to " + state.effective + ".";
}
async function loadWorkspaceDefaults() {
  const status = document.getElementById("workspace-defaults-status");
  try {
    const response = await fetch("/api/hub/settings/workspace-defaults");
    if (!response.ok) {
      status.textContent = "Workspace defaults are unavailable.";
      return;
    }
    const state = await response.json();
    status.textContent = describeWorkspaceDefaults(state);
    const input = document.getElementById("workspace-defaults-parent");
    if (!input.value.trim() || input.dataset.autofilled === "true") {
      input.value = state.configured || "";
      input.dataset.autofilled = "true";
    }
  } catch {
    status.textContent = "Workspace defaults could not be loaded.";
  }
}
function initWorkspaceDefaults() {
  const form = document.getElementById("workspace-defaults-form");
  const input = document.getElementById("workspace-defaults-parent");
  const errorTarget = document.getElementById("workspace-defaults-error");
  input.addEventListener("input", () => { input.dataset.autofilled = "false"; });
  form.onsubmit = async event => {
    event.preventDefault();
    setLocalError(errorTarget, "");
    const value = input.value.trim();
    if (!value) { setLocalError(errorTarget, "Enter an absolute directory path, or use Clear."); return; }
    const button = form.querySelector('button[type="submit"]');
    await withBusy(button, "Saving…", async () => {
      try {
        await api("/api/hub/settings/workspace-defaults", { defaultWorkspaceParent: value });
        input.dataset.autofilled = "true";
        await loadWorkspaceDefaults();
      } catch (error) { setLocalError(errorTarget, error.message); }
    });
  };
  document.getElementById("workspace-defaults-clear").onclick = async event => {
    setLocalError(errorTarget, "");
    await withBusy(event.target, "Clearing…", async () => {
      try {
        await api("/api/hub/settings/workspace-defaults", { defaultWorkspaceParent: null });
        input.value = "";
        input.dataset.autofilled = "true";
        await loadWorkspaceDefaults();
      } catch (error) { setLocalError(errorTarget, error.message); }
    });
  };
  loadWorkspaceDefaults();
}
function initSettingsPage() {
  initSharedUidAdvisory();
  initWorkspaceDefaults();
  for (const reveal of document.querySelectorAll("[data-reveal-secret]")) {
    const field = document.getElementById(reveal.dataset.revealSecret);
    reveal.onclick = () => {
      const masked = field.classList.toggle("secret-paste-masked");
      reveal.textContent = masked ? "Reveal" : "Hide";
      reveal.setAttribute("aria-pressed", String(!masked));
      field.focus();
    };
  }
  bindCredentialForm("ssh-generate-form", credentialPath + "/ssh/generate", (data, form) => ({
    name: data.get("name"), capabilities: values(form, "capabilities"), passphrase: data.get("passphrase"),
  }));
  bindCredentialForm("ssh-import-form", credentialPath + "/ssh/import", async (data, form) => {
    const file = data.get("privateKeyFile");
    const pastedKey = String(data.get("privateKey") || "");
    const hasFile = file instanceof File && file.name !== "";
    const hasPaste = pastedKey.trim() !== "";
    if (hasFile === hasPaste) throw new Error("Choose exactly one private key source: upload a file or paste a key.");
    if (hasFile && file.size > 1024 * 1024) throw new Error("SSH private key exceeds the 1 MiB size limit.");
    const privateKey = hasFile ? await file.text() : pastedKey;
    return { name: data.get("name"), capabilities: values(form, "capabilities"), privateKey, passphrase: data.get("passphrase") };
  });
  bindCredentialForm("openpgp-generate-form", credentialPath + "/openpgp/generate", data => ({
    name: data.get("name"), userId: data.get("userId"), passphrase: data.get("passphrase"),
  }));
  bindCredentialForm("openpgp-import-form", credentialPath + "/openpgp/import", data => ({
    name: data.get("name"), privateKey: data.get("privateKey"),
  }));
  bindCredentialForm("token-form", credentialPath + "/token", (data, form) => {
    const username = String(data.get("username") || "").trim();
    const body = { name: data.get("name"), host: data.get("host"), token: data.get("token"), capabilities: values(form, "capabilities") };
    if (username) body.username = username;
    return body;
  });
  window.addEventListener("pageshow", event => {
    if (!event.persisted) return;
    loadSettingsState();
    loadDevices();
    loadCredentials();
    loadTools();
    loadWorkspaceDefaults();
  });
  loadSettingsState();
  loadDevices();
  loadCredentials();
  loadTools();
}
if (pageMode === "dashboard") {
  window.addEventListener("pageshow", event => {
    if (!event.persisted) return;
    for (const overlay of document.querySelectorAll(".nav-overlay")) overlay.remove();
    uiBusy = 0;
    refresh(true);
  });
  loadDashboardCredentials().catch(() => {});
  refresh();
  setInterval(refresh, 5000);
} else if (pageMode === "settings") {
  initSettingsPage();
} else if (pageMode === "clone") {
  initClonePage();
}
</script>`,
  );
}

export function dashboardPage(authenticatedUser: string): string {
  return authenticatedPage("dashboard", authenticatedUser);
}

export function clonePage(authenticatedUser: string): string {
  return authenticatedPage("clone", authenticatedUser);
}

export function settingsPage(authenticatedUser: string): string {
  return authenticatedPage("settings", authenticatedUser);
}

export function stoppedSessionPage(workspaceId: string, registered: boolean, displayName?: string): string {
  const label = escapeHtml(displayName || workspaceId);
  const detail = registered
    ? `The session for <strong>${label}</strong> is not running.`
    : `No workspace <strong>${escapeHtml(workspaceId)}</strong> is registered on this hub.`;
  // A registered stopped workspace offers Start and Configure directly
  // instead of dead-ending on a link back to the dashboard.
  const actions = registered
    ? `<div class="form-row" style="padding: 0 1rem 1rem;">
    <button id="stopped-start" class="primary" type="button">Start</button>
    <a href="/settings" style="align-self: center;">Configure</a>
    <a href="/" style="align-self: center;">Dashboard</a>
  </div>
  <p id="stopped-error" class="local-error" role="alert" hidden style="margin: 0 1rem 1rem;"></p>
  <script>
    document.getElementById("stopped-start").onclick = async () => {
      const button = document.getElementById("stopped-start");
      const errorTarget = document.getElementById("stopped-error");
      errorTarget.hidden = true;
      button.disabled = true;
      button.textContent = "Starting…";
      try {
        const response = await fetch("/api/hub/sessions/${encodeURIComponent(workspaceId)}/start", { method: "POST" });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error || ("start failed (" + response.status + ")"));
        location.reload();
      } catch (error) {
        if (/locked|unlock/i.test(error.message)) {
          // This page has no passphrase surface; the dashboard's
          // credential-aware start flow collects it.
          button.textContent = "Unlock in Hub…";
          location.href = "/";
          return;
        }
        errorTarget.textContent = error.message;
        errorTarget.hidden = false;
        button.disabled = false;
        button.textContent = "Start";
      }
    };
  </script>`
    : `<p class="empty"><a href="/">Back to the dashboard</a></p>`;
  return page(
    "UatuCode Hub — session unavailable",
    `${brandHeader()}
<section class="pane">
  <div class="pane-header"><h2>Session unavailable</h2></div>
  <p class="empty" style="font-size: 0.85rem;">${detail}</p>
  ${actions}
</section>`,
  );
}
