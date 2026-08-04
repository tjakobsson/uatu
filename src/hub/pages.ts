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

  main { position: relative; max-width: 680px; margin: 0 auto; padding: 2.5rem 1.25rem 4rem; }
  .sign-out { position: absolute; top: 1.25rem; right: 1.25rem; }
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

export function loginPage(options: { error?: string } = {}): string {
  const error = options.error ? `<p class="error-text">${escapeHtml(options.error)}</p>` : "";
  return page(
    "UatuCode Hub — Sign in",
    `${brandHeader()}
<section class="pane" style="max-width: 380px; margin-left: auto; margin-right: auto;">
  <div class="pane-header"><h2>Sign in</h2></div>
  <form method="post" action="/login" style="padding: 1rem; display: flex; flex-direction: column; gap: 0.75rem;">
    ${error}
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

// The dashboard renders client-side from /api/hub/state + /api/hub/folders
// so live status (shell counts, foreground labels, new folders) stays
// current without a reload.
export function dashboardPage(): string {
  return page(
    "UatuCode Hub",
    `<form class="sign-out" method="post" action="/logout"><button type="submit">Sign out</button></form>
${brandHeader()}
<p id="action-error" class="error-text" hidden></p>
<section class="pane">
  <div class="pane-header"><h2>Sessions</h2></div>
  <div id="sessions"><p class="empty">Loading…</p></div>
</section>
<section class="pane">
  <div class="pane-header"><h2>Workspaces</h2><span id="workspaces-dir" class="pane-meta"></span></div>
  <div id="workspaces"><p class="empty">Loading…</p></div>
  <form class="form-row" id="clone-form" style="border-top: 1px solid var(--border-soft);">
    <input type="text" id="clone-url" placeholder="Clone a repository — git URL" aria-label="Git clone URL" />
    <button type="submit">Clone</button>
  </form>
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
function row({ title, href, path, detail, live, chip, chipWarn, button, buttons }) {
  const div = el("div", "row");
  if (live !== undefined) {
    const dot = el("span", "indicator-dot" + (live ? " is-live" : ""));
    div.appendChild(dot);
  }
  const main = el("div", "row-main");
  const titleRow = el("div", "row-title");
  if (href) {
    const link = document.createElement("a");
    link.href = href;
    link.textContent = title;
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
    action.onclick = spec.onClick;
    div.appendChild(action);
  }
  return div;
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
async function serveFolder(name) {
  showError("");
  try {
    const result = await api("/api/hub/workspaces", { name });
    location.href = sessionUrl(result.id);
  } catch (error) {
    if (error.payload && error.payload.needsInit) {
      if (!confirm('"' + name + '" is not a git repository. Initialize one with git init and serve it?')) return;
      try {
        const result = await api("/api/hub/workspaces", { name, init: true });
        location.href = sessionUrl(result.id);
      } catch (inner) { showError(inner.message); }
      return;
    }
    showError(error.message);
  }
}
async function refresh() {
  let state, folders;
  try {
    const [stateResponse, foldersResponse] = await Promise.all([
      fetch("/api/hub/state"),
      fetch("/api/hub/folders"),
    ]);
    if (!stateResponse.ok || !foldersResponse.ok) return;
    state = await stateResponse.json();
    folders = await foldersResponse.json();
  } catch { return; }

  document.getElementById("workspaces-dir").textContent = folders.workspacesDir;

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
        onClick: async () => {
          if (!confirm('Stop session "' + w.id + '"? Its shells will be terminated.')) return;
          showError("");
          try { await api("/api/hub/sessions/" + encodeURIComponent(w.id) + "/stop"); await refresh(); }
          catch (error) { showError(error.message); }
        },
      },
    })),
    "No sessions running — resume or serve a workspace below.",
  );

  const stopped = state.workspaces.filter(w => !w.running);
  const registeredPaths = new Set(state.workspaces.map(w => w.path));
  const available = folders.folders.filter(f => !f.registeredId);
  const rows = [
    ...stopped.map(w => row({
      title: w.id,
      path: w.path,
      live: false,
      buttons: [
        {
          label: "Resume",
          onClick: async () => {
            showError("");
            try {
              await api("/api/hub/sessions/" + encodeURIComponent(w.id) + "/start");
              location.href = sessionUrl(w.id);
            } catch (error) { showError(error.message); }
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
    ...available.map(f => row({
      title: f.name,
      chip: f.git ? "git" : "no git",
      chipWarn: !f.git,
      button: { label: "Serve", onClick: () => serveFolder(f.name) },
    })),
  ];
  renderInto(
    document.getElementById("workspaces"),
    rows,
    "No folders in the workspaces root yet — clone a repository below.",
  );
}
document.getElementById("clone-form").onsubmit = async event => {
  event.preventDefault();
  showError("");
  const input = document.getElementById("clone-url");
  const url = input.value.trim();
  if (!url) return;
  const button = event.target.querySelector("button");
  button.disabled = true;
  button.textContent = "Cloning…";
  try {
    const result = await api("/api/hub/clone", { url });
    input.value = "";
    location.href = sessionUrl(result.id);
  } catch (error) {
    showError(error.message);
  } finally {
    button.disabled = false;
    button.textContent = "Clone";
    await refresh();
  }
};
refresh();
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
