## Context

UatuCode today is a stateless, render-on-demand watcher: chokidar feeds a single SSE stream (`/api/events`), the browser pulls rendered documents on demand from `/api/document`, and the server holds no per-client state. The UI is a Bun-served SPA with a sidebar of panes (Change Overview, Files, Git Log, Selection Inspector) and a preview area. There is no WebSocket transport, no native dependency in the runtime stack, and no installable manifest. The CLI picks an ephemeral port at startup.

This change introduces the first *interactive* surface (a real shell over a bidirectional socket) and the first *desktop-style* surface (PWA install). Both are net-new, both touch the server route table and the HTML shell, and both have identity/security implications that are cheaper to address up front than retrofit. They are bundled into one change because they share the same architectural ripple — port pinning, asset pipeline, route additions — and shipping them together keeps that ripple contained to one diff.

Stakeholders: the maintainer (sole user of the standalone binary), early adopters running uatu against agent sessions, future contributors who will inherit the WebSocket + PTY pattern.

## Goals / Non-Goals

**Goals:**
- A single embedded terminal that runs a real PTY in the watch root, hidden by default, toggled with `Ctrl+``, themed dark out of the box.
- A `/api/terminal` WebSocket on the existing Bun server with token + origin gating.
- An installable PWA on Edge/Chrome/Brave with a stable origin (port 4711 by default).
- Stable layout primitives for a horizontally-resizable bottom panel that coexists with the sidebar.
- Establish patterns (WS upgrade, native dep handling, manifest/SW serving) that future features can lean on.

**Non-Goals:**
- Multiple terminals or terminal tabs. One PTY per browser is plenty for v1; tabs are a future change.
- Persistent terminals across server restarts or full page reloads beyond the 5-second reconnect window. VS Code's "persistent terminal" model requires a session store and is out of scope.
- Search, find-in-scrollback, or copy-on-select. xterm.js supports these via addons; decide later.
- A light-mode terminal theme. Ship dark only; the rest of uatu is dark-only today.
- Running predefined commands or palette-driven runners (the "Option C" from exploration). That's a separate capability if we want it.
- Offline operation. The service worker is a no-op pass-through whose only job is to satisfy install criteria — uatu without a running backend has nothing useful to do.
- Sandboxing the shell. The PTY runs as the uatu process, with full user permissions. This is the same trust posture as opening a terminal locally, surfaced through a localhost-bound HTTP server with token + origin checks.

## Decisions

### Decision 1: Bun's built-in PTY API (`Bun.spawn(..., { terminal: ... })`)

Bun 1.3.5+ ships first-class PTY support via the `terminal` option on `Bun.spawn`. The API gives us `data(t, bytes)` callbacks, `terminal.write()`, `terminal.resize(cols, rows)`, `terminal.close()`, and `proc.exited` for lifecycle, all without a native module dependency. Available on macOS and Linux today; Windows tracking issue is open upstream.

We use it directly via `src/terminal-pty.ts` — a small adapter that maps the Bun API to the listener-style surface our `terminal-server.ts` consumes. `src/terminal-backend.ts` probes Bun's PTY at startup (running `/bin/echo` and confirming the data callback fires within a 750ms watchdog) so older Bun versions degrade to `terminal: "disabled"` rather than silently spawning a non-TTY pipe.

**Why not `node-pty`:**
- The change originally used `node-pty` and shipped:
  - a userland `tty.ReadStream` shim mirroring [bun#29114](https://github.com/oven-sh/bun/pull/29114), because Bun's `tty.ReadStream` destroyed the externally-owned fd on the first `EAGAIN`;
  - a build-time staging step (`scripts/stage-pty.ts`) that copied node-pty's `pty.node` + `spawn-helper` into `src/assets/pty/` with renamed `.bin` extensions;
  - a runtime bootstrap (`src/terminal-pty-bootstrap.ts`) that extracted the embedded binaries to `~/.cache/uatu-pty/`, `process.dlopen`'d the native module, and patched `Module._resolveFilename` + the native `fork()` to land helperPath on real fs.
- All of that — three modules, a postinstall hook, a gitignore entry, a native dependency, and a per-platform asset bundle — collapses to a thin adapter once we use `Bun.spawn`'s built-in PTY. Native module is gone; the EAGAIN bug doesn't apply (different code path); the standalone binary works without staging because there's no native module to embed; cross-platform support is whatever Bun supports.

**Trade-off:** `Bun.spawn { terminal }` is Bun-only. If uatu ever runs on plain Node, this code path is dead. Since uatu's whole runtime is Bun-first, that's an acceptable bound.

**Removed deps and files:** `node-pty` and `node-addon-api`; `src/terminal-shim.ts`, `src/terminal-pty-bootstrap.ts`, `scripts/stage-pty.ts`, `src/assets/pty/`; the `postinstall` hook and `trustedDependencies` in `package.json`; the `*.node` / `*.bin` ambient declarations in `src/styles.d.ts`.

### Decision 2: WebSocket via Bun's `server.upgrade()`, binary frames + JSON control

Bun has first-class WebSocket support; `server.upgrade()` is the right primitive. The wire format:
- **Binary frames in both directions** carry raw shell I/O. Browser → server: keystrokes, paste payloads. Server → browser: stdout/stderr bytes. xterm.js writes raw bytes; the PTY produces raw bytes; binary avoids any text-encoding surprises.
- **Text frames containing JSON** carry control messages. Today: `{"type":"resize","cols":N,"rows":N}`. Future: ping, title, exit-code. A `type` discriminator keeps the protocol extensible without a v2.

**Alternative considered:** SSE + a separate POST endpoint for input. Rejected — SSE has no upstream channel, the latency from POST-per-keystroke is unacceptable, and we'd reinvent a worse WebSocket.

### Decision 3: Spawn-on-attach, kill-on-disconnect, with a 5-second reaper grace

The PTY's lifetime is bound to its WebSocket. On `upgrade`, spawn. On `close`, start a 5s timer; if it fires, `SIGHUP` the PTY and reap it. The grace itself just keeps the reap off the close-event critical path — it doesn't enable reconnect. v1 always spawns a fresh PTY on each upgrade.

**Why no reattach in v1.** A real reattach path would mean keying open sessions by something the browser sends (a session id in the URL or a cookie), correlating across upgrades, and replaying the buffered output. That's a real feature surface — auth model, race conditions across reload windows, lifecycle of orphan sessions. v1 keeps the simpler invariant "terminal visible ⇒ shell exists, terminal hidden or page reloaded ⇒ no shell." The buffer and grace timer remain as scaffolding for a future change that adds reconnect proper.

**Trade-off:** background tasks running in the terminal die when you hide the panel or reload the page. That is a deliberate v1 limitation; the workaround is `&` + `disown` or `nohup`, which power users already know.

### Decision 4: Per-server-session token + Origin allowlist for the WS upgrade

The terminal endpoint accepts shell input. Localhost binding alone is not enough — any other process on the machine can reach `127.0.0.1:<port>`, and a malicious page can attempt DNS rebinding or cross-origin WebSocket. Two cheap controls:
1. **Token**: server generates 32 random bytes (base64url) at startup, prints them into the URL it opens (`http://127.0.0.1:4711/?t=<token>`), and stores the token in `sessionStorage` on first load. The browser appends `?t=<token>` to `/api/terminal` upgrades. The server compares with constant-time equality and rejects mismatches with 401.
2. **Origin allowlist**: the upgrade handler reads the `Origin` header and rejects any value that is not `http://127.0.0.1:<port>`, `http://localhost:<port>`, or the registered PWA origin. Reject with 403 (not 401 — this is a different failure class).

Both checks run before `server.upgrade()` returns, so an unauthenticated client never reaches the PTY codepath.

**Why apply both to the terminal but not (yet) to other routes:** the read-only routes leak document contents at worst; the terminal route grants shell. The asymmetric protection matches the asymmetric blast radius. We can extend the token check to other routes later if it becomes useful.

**Alternative considered:** HTTP basic auth. Rejected — clunkier UX, no real security advantage over a token in the URL on a localhost-bound server.

### Decision 5: Stable default port 4711, roll on conflict

PWA install identity is keyed on origin. A dynamic port turns "uatu" into a different installable app every time it starts, accumulating ghost installs and breaking pinned launchers. A stable default (4711, picked because it's memorable, unprivileged, and unlikely to clash with common dev tools) keeps install identity coherent.

If 4711 is occupied, scan upward to the first free port and warn on stderr. Users who explicitly want ephemeral ports can pass `--port 0`. This is **BREAKING** for anyone who was relying on uatu to dodge port conflicts silently — call it out in the changelog.

**Alternative considered:** auto-pick a port and persist it under `~/.config/uatu/`. Rejected — adds a config-file surface for a problem that 99% of users don't have.

### Decision 6: Pass-through service worker, registered at site root

Edge and Chrome list a `fetch` handler in the service worker as a *de facto* requirement for the install pill. We register one whose handler is literally `event.respondWith(fetch(event.request))`. No caching, no offline page, no API rewriting. This satisfies install criteria without inheriting the operational complexity of a real cache strategy (stale UI bundles, terminal traffic getting cached, version-skew bugs).

**Alternative considered:** real caching for the static shell + xterm bundle. Tempting for offline reload speed but would need cache versioning and a story for clearing the cache when uatu upgrades. Defer until we have evidence it matters.

### Decision 7: CSS-variable-driven xterm theme

xterm.js takes an `ITheme` object at construction and a `setOption('theme', ...)` at runtime. We define the 16 ANSI colors + foreground/background/cursor/selection in `:root` CSS variables under `src/styles.css`, then build the `ITheme` object in `terminal.ts` by reading `getComputedStyle(document.documentElement)`. This means the terminal's palette is a single source of truth alongside the rest of the uatu palette, and a future light theme is one variable swap.

The default ANSI palette is a hand-tuned dark variant that targets WCAG-AA contrast against the uatu dark surface. Source colors live in `--terminal-ansi-{black,red,green,yellow,blue,magenta,cyan,white,bright-*}` plus `--terminal-bg`, `--terminal-fg`, `--terminal-cursor`, `--terminal-selection-bg`.

### Decision 7a: Local Nerd Fonts first, no bundled font

The terminal renders user shell prompts (starship, p10k, powerline, etc.) which routinely contain Nerd Font glyphs in the Private Use Area. Without a font that supplies those glyphs, prompts show TOFU squares and the terminal "looks broken" even when it's working.

We do **not** bundle a Nerd Font. Instead, `--terminal-font-family` lists the most common Nerd Font names ("FiraCode Nerd Font Mono", "JetBrainsMono Nerd Font Mono", "Hack Nerd Font Mono", "MesloLGS Nerd Font Mono", "CaskaydiaCove Nerd Font Mono") *before* the default monospace fallbacks. xterm.js renders into the DOM, so the browser picks up any locally-installed font transparently — no `@font-face` needed.

Users who want a specific font (one not in the default chain, or a custom stack) override via `.uatu.json`:

```json
{ "terminal": { "fontFamily": "Berkeley Mono, monospace", "fontSize": 14 } }
```

`src/terminal-config.ts` validates `fontFamily` (non-empty string) and `fontSize` (number in 8–32). Validated values reach the browser via `/api/state.terminalConfig` and override the CSS variable for that xterm instance. Invalid values warn on stderr and are dropped.

**Why not bundle.** A bundled FiraCode Nerd Font Mono WOFF2 is ~1 MB. Most uatu users are devs and already have a Nerd Font installed. The 1 MB is a real cost — initial page load, dist size, license file management — for a fallback that the target audience rarely needs. If we're wrong about that, adding a bundled fallback later is a small additional decision (one `@font-face` declaration plus the WOFF2 + OFL.txt) without changing this surface.

**Why config in `.uatu.json` rather than localStorage.** Font choice is a per-project preference (a teammate cloning the repo gets the same default). localStorage would be per-browser-tab. The same logic that puts review thresholds in `.uatu.json` puts font here.

**Known Safari caveat.** Safari 17+ blocks pages from seeing user-installed fonts as anti-fingerprinting protection — `document.fonts.check('14px "FiraCode Nerd Font Mono"')` returns `false` even when the font is installed. The chain still applies; it just falls all the way through to a system fallback (Menlo). Verified: same uatu, same `.uatu.json`, Chrome renders Nerd Font glyphs correctly, Safari falls back. The recommendation is to use Chrome / Edge / Brave for uatu — the eventual PWA install path is Chrome-based on macOS anyway, so this aligns. If a future change wants to support Safari first-class, the path is bundling a Nerd Font WOFF2 with `@font-face` (the deferred "Option B" from earlier exploration), which routes around the protection.

### Decision 8: Bottom panel as a peer of the preview shell, not a child

The DOM structure becomes:
```
.app-shell
  .sidebar
  .sidebar-resizer
  .main-stack          ← new wrapper
    .preview-shell
    .panel-resizer     ← new horizontal resizer
    .terminal-panel    ← hidden by default
```
This avoids fighting the existing flex layout. The `.main-stack` is `flex-direction: column`, the resizer drags the `.terminal-panel` height (kept in `--terminal-panel-height` CSS var, persisted to `localStorage`).

**Alternative considered:** putting the terminal inside `.preview-shell`. Rejected — the preview header would need to stretch above the terminal, which complicates the existing markdown-body layout.

### Decision 9: Service worker file is generated at build, not authored as a route

Service workers must be served from the same origin and ideally from a path the worker controls (not nested). We ship a static `sw.js` from `src/assets/sw.js` and add a route in `cli.ts` that serves it with `Service-Worker-Allowed: /` and `Cache-Control: no-cache`. The `no-cache` matters: when uatu's SW logic changes between versions, the new SW must reach the user on next reload.

## Risks / Trade-offs

- **Risk: user runs an old Bun (< 1.3.5) without the `terminal` option on `Bun.spawn`** → Mitigation: `terminalBackendAvailable()` probes Bun.Terminal at startup with a 750ms watchdog. On older Bun, the data callback never fires, the probe returns `available: false`, and `/api/state` reports `terminal: "disabled"`. The UI hides the toggle and Ctrl+`` becomes inert. The rest of uatu still runs. Document the Bun ≥ 1.3.5 requirement in the README.
- **Risk: standalone binary loses the terminal feature** → No longer applies after switching to Bun's built-in PTY. The terminal works inside `bun build --compile` because there's no native module to embed; Bun's runtime ships the PTY support natively. Earlier risk language about a `node-pty` import failing is preserved here for archaeology — see Decision 1's "Why not node-pty" for the migration story.
- **Risk: token leaks via shell history if the user copy-pastes the URL** → Mitigation: server logs the URL once on startup; subsequent clients pull the token from `sessionStorage`. The token rotates on every restart.
- **Risk: `localStorage` panel-state bug locks a user out of the UI** → Mitigation: surface the toggle in the existing Panels menu in addition to the keyboard shortcut, so it's recoverable without devtools. Add a `?reset-layout` URL flag that wipes layout keys.
- **Risk: PWA install identity breaks if the user upgrades uatu and we change the port default** → Mitigation: write the port choice into the changelog as a stability commitment. Don't change 4711 lightly.
- **Risk: WebSocket origin check is bypassed by a bug in an extension or a frame** → Mitigation: defense in depth — origin AND token. A failing origin check still requires a stolen token; a stolen token still requires the right origin.
- **Trade-off: bundling Decision 5 (port pinning) in this change makes it BREAKING** → Acceptable. Splitting it out would let us ship a non-breaking terminal on dynamic ports, but PWA install would then ship with a guaranteed-bad install experience. Pay the breaking-change cost once.
- **Trade-off: hiding the panel kills running shells** → Acceptable for v1; document in the README's terminal section. A "minimize keeps the shell, close kills it" model is a future refinement.

## Migration Plan

1. Land this change behind no flag — it's additive in the UI (panel hidden by default) and the port pin is the only user-visible default-change.
2. Update README:
   - "Install" section: note that the terminal requires `bun install` (not the standalone binary).
   - "Usage" section: document the `Ctrl+`` shortcut, the `--port` semantics, and the PWA install path on Edge/Chrome.
3. Update CHANGELOG with the breaking-change note about port 4711 and the upgrade-time guidance ("first launch installs as a new PWA — uninstall any old uatu PWAs first").
4. Rollback: reverting the change is a single git revert; the only persistent state introduced is `localStorage` keys, which become inert without the code that reads them.

## Open Questions

1. **Shell choice on Windows.** This change targets macOS and Linux. Windows support is gated on Bun's PTY API gaining a Windows backend (Bun upstream tracking is open) and a different default shell strategy. Out of scope for v1 — file as a separate change once Bun ships Windows PTY.
2. **Should the token also gate `/api/state` and other routes?** Probably yes, eventually — same browser, same user, no UX cost. Punted to a follow-up so this change stays focused.
3. **Should we ship a maskable icon variant?** Maskable icons are nicer in Android launchers but uatu is desktop-first. Skip for v1; add when someone asks.
4. **Where does the panel resizer sit visually?** A 4px hairline with hover affordance is consistent with the sidebar resizer. Confirm during implementation that it has enough click target without taking visible vertical space.
