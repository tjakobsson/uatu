// Server-rendered HTML for the hub: login, dashboard, and the
// stopped/unknown-session pages. Deliberately framework-free, but NOT a
// separate theme: these pages speak uatu's design system — the SPA's
// `light-dark()` token palette under `color-scheme: light dark`, the same
// sans body with monospace reserved for paths, the inline brand logo with
// its dark-scheme retint and blinking eye, pane-style section headers, and
// the indicator-dot idiom for running state.

import logoAssetPath from "../assets/uatu-logo.svg" with { type: "file" };

import { escapeHtml } from "../shared/html";

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
  .sign-out { position: absolute; top: calc(1.25rem + var(--titlebar-inset, 0px)); right: 1.25rem; }
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
  button.primary { background: var(--accent); border-color: var(--accent); color: #ffffff; }
  button.primary:hover { filter: brightness(1.08); background: var(--accent); }
  button.danger { color: var(--danger); }
  button.danger:hover { border-color: var(--danger); background: var(--surface-muted); }

  input[type="text"], input[type="password"] {
    font: inherit;
    font-size: 0.85rem;
    color: var(--text-strong);
    background: var(--surface);
    border: 1px solid var(--border-medium);
    border-radius: 0.375rem;
    padding: 0.35rem 0.6rem;
    width: 100%;
  }
  input:focus-visible, button:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }

  .form-row { display: flex; gap: 0.5rem; padding: 0.6rem 1rem; }
  .empty { padding: 0.75rem 1rem; color: var(--text-subtle); font-size: 0.8rem; }
  .error-text { color: var(--danger); font-size: 0.8rem; margin: 0.75rem 0; }
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

export function loginPage(options: { error?: string; next?: string } = {}): string {
  const error = options.error ? `<p class="error-text">${escapeHtml(options.error)}</p>` : "";
  // Return-to target carried from the gate's redirect; server-validated
  // (safeReturnPath) before rendering AND again on submit, escaped here.
  const next = options.next ? `<input type="hidden" name="next" value="${escapeHtml(options.next)}" />` : "";
  return page(
    "UatuCode Hub — Sign in",
    `${brandHeader()}
<section class="pane" style="max-width: 380px; margin-left: auto; margin-right: auto;">
  <div class="pane-header"><h2>Sign in</h2></div>
  <form method="post" action="/login" style="padding: 1rem; display: flex; flex-direction: column; gap: 0.75rem;">
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

// The dashboard renders client-side from /api/hub/state + /api/hub/browse
// so live status (shell counts, foreground labels, the hub version, new
// folders) stays current without a reload.
export function dashboardPage(): string {
  const signOut = `<form class="sign-out" method="post" action="/logout"><button type="submit">Sign out</button></form>\n`;
  const addFolder = `<section class="pane">
  <div class="pane-header"><h2>Add folder</h2><span id="browse-path" class="pane-meta"></span></div>
  <div id="browser"><p class="empty">Loading…</p></div>
  <form class="form-row" id="clone-form" style="border-top: 1px solid var(--border-soft);">
    <input type="text" id="clone-url" placeholder="Clone a repository into this folder — git URL" aria-label="Git clone URL" />
    <button type="submit">Clone</button>
  </form>
</section>
`;
  return page(
    "UatuCode Hub",
    `${signOut}${brandHeader()}
<p id="hub-version" class="hub-version"></p>
<p id="action-error" class="error-text" hidden></p>
<section class="pane">
  <div class="pane-header"><h2>Sessions</h2></div>
  <div id="sessions"><p class="empty">Loading…</p></div>
</section>
<section class="pane">
  <div class="pane-header"><h2>Workspaces</h2></div>
  <div id="workspaces"><p class="empty">Loading…</p></div>
</section>
${addFolder}<section class="pane">
  <div class="pane-header"><h2>Devices</h2></div>
  <div id="devices"><p class="empty">Loading…</p></div>
</section>
<script>
const errorEl = document.getElementById("action-error");
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
  for (const spec of buttons ?? (button ? [button] : [])) {
    const action = el("button", spec.className || null, spec.label);
    action.onclick = () => spec.onClick(action);
    div.appendChild(action);
  }
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
// Returns true when it navigated into a session (the caller's button then
// stays in its busy state — the overlay owns the screen until the session
// page replaces us), false when the user declined or an error was shown.
async function addFolder(folder) {
  showError("");
  try {
    const result = await api("/api/hub/workspaces", { path: folder });
    openSession(result.id);
    return true;
  } catch (error) {
    if (error.payload && error.payload.needsInit) {
      if (!confirm('"' + folder + '" is not a git repository. Initialize one with git init and serve it?')) return false;
      try {
        const result = await api("/api/hub/workspaces", { path: folder, init: true });
        openSession(result.id);
        return true;
      } catch (inner) { showError(inner.message); }
      return false;
    }
    showError(error.message);
    return false;
  }
}

// The Add Folder browser: one directory level at a time, drill in by name,
// add the current candidate with its button. Server defaults to the home
// directory; the resolved path comes back with every listing.
let browsePath = null;
async function loadBrowser() {
  let listing;
  try {
    const query = browsePath === null ? "" : "?path=" + encodeURIComponent(browsePath);
    const response = await fetch("/api/hub/browse" + query);
    if (!response.ok) return;
    listing = await response.json();
  } catch { return; }
  browsePath = listing.path;
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
    rows.push(row({
      title: dir.name,
      titleClick: () => { browsePath = listing.path + (listing.path.endsWith("/") ? "" : "/") + dir.name; loadBrowser(); },
      chip: dir.registeredId ? "added" : (dir.git ? "git" : "no git"),
      chipWarn: !dir.registeredId && !dir.git,
      button: dir.registeredId
        ? { label: "Open", onClick: () => openSession(dir.registeredId) }
        : {
            label: "Add",
            onClick: async button => {
              uiBusy += 1;
              const original = button.textContent;
              button.disabled = true;
              button.textContent = "Starting…";
              if (!(await addFolder(listing.path + (listing.path.endsWith("/") ? "" : "/") + dir.name))) {
                uiBusy -= 1;
                button.disabled = false;
                button.textContent = original;
              }
            },
          },
    }));
  }
  renderInto(document.getElementById("browser"), rows, "No subfolders here.");
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

  const running = state.workspaces.filter(w => w.running);
  renderInto(
    document.getElementById("sessions"),
    running.map(w => row({
      title: w.id,
      href: sessionUrl(w.id),
      path: w.path,
      detail: shellSummary(w.shells),
      live: true,
      button: {
        label: "Stop",
        className: "danger",
        onClick: async button => {
          if (!confirm('Stop session "' + w.id + '"? Its shells will be terminated.')) return;
          showError("");
          await withBusy(button, "Stopping…", async () => {
            try { await api("/api/hub/sessions/" + encodeURIComponent(w.id) + "/stop"); await refresh(true); }
            catch (error) { showError(error.message); }
          });
        },
      },
    })),
    "No sessions running — resume or serve a workspace below.",
  );

  const stopped = state.workspaces.filter(w => !w.running);
  const rows = [
    ...stopped.map(w => row({
      title: w.id,
      path: w.path,
      live: false,
      buttons: [
        {
          label: "Resume",
          // On success the button STAYS "Starting…" — restoring it while
          // the overlay covers the load read as a return to idle. Only an
          // error brings it back.
          onClick: async button => {
            showError("");
            uiBusy += 1;
            const original = button.textContent;
            button.disabled = true;
            button.textContent = "Starting…";
            try {
              await api("/api/hub/sessions/" + encodeURIComponent(w.id) + "/start");
              // uiBusy stays held: the page is navigating away and any
              // repaint now would flash idle controls under the overlay.
              openSession(w.id);
            } catch (error) {
              showError(error.message);
              uiBusy -= 1;
              button.disabled = false;
              button.textContent = original;
            }
          },
        },
        {
          label: "Forget",
          className: "danger",
          onClick: async () => {
            showError("");
            try {
              await api("/api/hub/workspaces/" + encodeURIComponent(w.id) + "/forget");
              await refresh();
            } catch (error) { showError(error.message); }
          },
        },
      ],
    })),
  ];
  renderInto(
    document.getElementById("workspaces"),
    rows,
    "No stopped workspaces — add a folder below to serve one.",
  );
}
// The device-session list: every active session of the signed-in user,
// with per-session revocation. Revoking the current session is sign-out —
// the server clears the cookie and this page bounces to /login.
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
    button: {
      label: s.current ? "Sign out" : "Revoke",
      className: "danger",
      onClick: async button => {
        showError("");
        await withBusy(button, "Revoking…", async () => {
          try {
            const result = await api("/api/hub/sessions/" + encodeURIComponent(s.handle) + "/revoke");
            if (result.current) {
              location.href = "/login";
              return;
            }
            await loadDevices();
          } catch (error) { showError(error.message); }
        });
      },
    },
  }));
  renderInto(document.getElementById("devices"), rows, "No active sessions.");
}
const cloneForm = document.getElementById("clone-form");
if (cloneForm) cloneForm.onsubmit = async event => {
  event.preventDefault();
  showError("");
  const input = document.getElementById("clone-url");
  const url = input.value.trim();
  if (!url) return;
  const button = event.target.querySelector("button");
  uiBusy += 1;
  button.disabled = true;
  button.textContent = "Cloning…";
  try {
    const result = await api("/api/hub/clone", { url, dest: browsePath });
    input.value = "";
    openSession(result.id);
  } catch (error) {
    showError(error.message);
  } finally {
    uiBusy -= 1;
    button.disabled = false;
    button.textContent = "Clone";
    await refresh(true);
    await loadBrowser();
  }
};
// Back/forward restores this page from WebKit's page cache exactly as we
// left it — including a stale opening overlay and busy buttons. Clear the
// overlay and re-render from fresh state.
window.addEventListener("pageshow", event => {
  if (!event.persisted) return;
  for (const overlay of document.querySelectorAll(".nav-overlay")) overlay.remove();
  // The page cache preserves the JS heap too — a busy hold from the
  // navigation that left this page would otherwise pin refresh forever.
  uiBusy = 0;
  refresh(true);
  loadBrowser();
  loadDevices();
});
refresh();
loadBrowser();
loadDevices();
setInterval(refresh, 5000);
</script>`,
  );
}

export function stoppedSessionPage(workspaceId: string, registered: boolean): string {
  const detail = registered
    ? `The session for <strong>${escapeHtml(workspaceId)}</strong> is not running. You can resume it from the dashboard.`
    : `No workspace <strong>${escapeHtml(workspaceId)}</strong> is registered on this hub.`;
  return page(
    "UatuCode Hub — session unavailable",
    `${brandHeader()}
<section class="pane">
  <div class="pane-header"><h2>Session unavailable</h2></div>
  <p class="empty" style="font-size: 0.85rem;">${detail}</p>
  <p class="empty"><a href="/">Back to the dashboard</a></p>
</section>`,
  );
}
