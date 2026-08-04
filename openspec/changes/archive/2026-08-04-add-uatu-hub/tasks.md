# Tasks: add-uatu-hub

## 1. Base-path plumbing in `uatu serve`

- [x] 1.1 Add `--base-path` to `src/cli/parse.ts` (validation, normalization, usage text) with unit tests for valid/invalid/default values
- [x] 1.2 Thread the base path through `src/cli.ts` and `src/server/routes.ts`: match routes under the prefix, 404 outside it, inject the prefix as a boot value into the served HTML; unit tests for prefixed route matching
- [x] 1.3 Create the shared client URL helper (prefix-aware, identity at `/`) and migrate every root-relative URL construction site (`shell/*`, `sidebar/*`, `preview/*`, `terminal/client.ts`, `find/*` as needed) to it
- [x] 1.4 Add the structural unit test that scans `src/` for root-relative `/api`, `/assets`, and service-worker URL literals outside the helper (pattern of `state-ownership.test.ts`)
- [x] 1.5 Scope PWA to the prefix: service-worker registration scope, manifest start URL/scope, `sw.js` asset paths; unit-test the registration scope derivation
- [x] 1.6 Include the prefix in startup output (TTY banner + piped single URL line) per the serve-cli-startup delta, with unit tests
- [x] 1.7 Set the terminal auth cookie `Path` from the base path at promotion time and verify at read time (`src/terminal/auth.ts`), covering the sessions-sharing-an-origin scenario in unit tests
- [x] 1.8 Add an e2e spec that boots the harness under a non-`/` base path and exercises core flows (state load, document select, SSE reload, terminal auth + WebSocket)

## 2. Hub daemon skeleton

- [x] 2.1 Add the `hub` subcommand to `src/cli/parse.ts` / `src/cli.ts` with config-file loading (port, TLS paths, users, state dir, projects dir) and validation errors; unit tests
- [x] 2.2 Implement XDG state-dir resolution for the hub (registry file, HMAC key) with owner-only file creation; unit tests
- [x] 2.3 Implement the workspace registry: stable collision-suffixed slugs, folder path, `backend` field (only `local`), persistence and reload; unit tests including id stability across reloads
- [x] 2.4 Define the `SessionBackend` interface and implement the local-process backend (spawn with `--no-open --exit-on-stdin-close --base-path`, parse stdout URL + token, hold stdin, SIGTERM stop); integration test with a real child
- [x] 2.5 Wire hub startup/shutdown: start `Bun.serve`, stop all sessions on SIGTERM/SIGINT; integration test that shutdown terminates children

## 3. Proxy

- [x] 3.1 Implement HTTP proxying for `/s/<id>/*` to the session endpoint with streamed bodies and loopback-rewritten `Host`/`Origin`; integration tests through a real child (`/api/state`, document fetch)
- [x] 3.2 Implement SSE pass-through without buffering; integration test that a file event reaches a client through the hub
- [x] 3.3 Implement WebSocket proxying (upgrade forwarding, bidirectional messages, close-code preservation incl. 4001/4409/4410); integration test covering terminal echo and a preserved close code
- [x] 3.4 Serve the stopped/unknown-workspace error page (non-cached, links to dashboard); unit test

## 4. Auth

- [x] 4.1 Implement users config parsing with `Bun.password` hash verification and a `uatu hub hash-password` helper (or documented equivalent) for generating entries; unit tests
- [x] 4.2 Implement the signed session cookie (HMAC key from state dir, `HttpOnly; Secure; SameSite=Lax`, user identity payload, tamper rejection, restart survival); unit tests
- [x] 4.3 Implement the login page + credential POST with rate limiting and user-existence-blind failures; unit tests
- [x] 4.4 Gate dashboard, dashboard APIs, and all `/s/…` routes (401 for API/WS, login redirect for navigations) before any child contact; integration test that an unauthenticated `/s/…` request never reaches the child
- [x] 4.5 Broker child tokens server-side so no token reaches the browser (satisfy the child's token/auth expectations during proxying); integration test that terminal auth works with no token in any browser-visible URL
- [x] 4.6 Add CSRF protection to state-changing endpoints (POST-only + origin check); unit tests

## 5. Dashboard

- [x] 5.1 Build the dashboard page (hub-served HTML + minimal JS, uatu CSS variables and bundled mono font): running sessions with live shell summary from each child's `/api/terminal/sessions`, stopped workspaces, jump-in links
- [x] 5.2 Implement session stop (confirmation naming the workspace) and resume actions with their endpoints; integration tests
- [x] 5.3 Implement workspace creation from a folder path with the git preflight (`git rev-parse --show-toplevel` probe, init offer only on definitive not-a-repository, decline leaves no registration, no `--force`); integration tests with temp dirs
- [x] 5.4 Implement `git clone` into the configured projects directory with error surfacing and registration on success; integration test against a local fixture repo

## 5b. Review follow-ups: workspaces root + uatu design language

- [x] 5b.1 Replace `projectsDir` with `workspacesDir` (default: hub cwd) in config; fail startup when the workspaces root is inside a git worktree; unit + process-integration tests
- [x] 5b.2 Add the folder listing (`GET /api/hub/folders`: subfolders with git status + registration) and rework workspace creation to folder names resolved strictly against the root (separators/dot segments rejected); clone into the root; integration tests
- [x] 5b.3 Rebuild the hub pages on uatu's design system: light-dark token palette, sans body + mono paths, inline brand logo with dark retint, pane-style headers, indicator dots; folder-picker UI replacing the free-text path input
- [x] 5b.4 Update runbook/README/ARCHITECTURE for workspacesDir and the picker flow
- [x] 5b.5 Remove the tagline from the hub brand header (logo + wordmark only)
- [x] 5b.7 Confine the registry to the workspaces root (startup prune, folders untouched) and add the dashboard forget action (stopped-only, 409 while running); unit + integration tests
- [x] 5b.13 Synthesize control bytes for keyCode-0 hardware Ctrl chords (iPadOS Safari) in the terminal key handler; unit tests
- [x] 5b.14 Focus the active terminal pane on user-initiated panel shows (not on boot restore)
- [x] 5b.11 Touch keybar for the terminal (Esc/Tab/^C/^D/^Z/arrows on coarse-pointer devices, focus-preserving, via TerminalPanelHandle.sendInput) with unit tests
- [x] 5b.12 Logout: CSRF-guarded POST /logout clearing the hub cookie, dashboard sign-out control, switcher sign-out entry; integration tests
- [x] 5b.10 Remote performance: hub gzip for compressible non-streaming responses, immutable caching + 304 revalidation for content-hashed bundle assets, `--minify` build, credentialed manifest link (401 fix), Content-Length preservation through the proxy; unit + integration tests
- [x] 5b.9 Relocate root-absolute `url()` references in served CSS under the base path (bundled Nerd Font 404'd through the hub → tofu prompt glyphs); unit + integration tests
- [x] 5b.8 Center the hub brand header (larger logo, wordmark beneath) and give the in-session switcher row breathing room from the header
- [x] 5b.6 Add the in-session hub workspace switcher (`shell/hub-nav.ts` + sidebar-header chip): probe-gated to hub-served sessions, dashboard link + workspace list with running state; unit tests for the pure helpers; discipline-test allowlist for origin-rooted hub URLs

## 6. TLS and hardening

- [x] 6.1 Wire TLS cert/key config into `Bun.serve`; refuse non-loopback listen without TLS; unit test the config validation and an integration test over HTTPS with a test certificate
- [x] 6.2 Verify secure-context-dependent features through the hub (service-worker registration scope, clipboard bridge policy plumbing) in the prefixed e2e or an integration test

## 7. Docs

- [x] 7.1 Write the self-hosting runbook: config reference, restart semantics, trust-model statement (shared OS user, no inter-user isolation), and complete cert+startup walkthroughs — mkcert incl. iOS root-CA install, tailscale native (`tailscale cert` PEM files + systemd renewal timer), and tailscale fronted (`tailscale serve` → loopback plain-HTTP hub) — each ending in a working systemd unit / launchd plist
- [x] 7.2 Update README and ARCHITECTURE.md (hub section, layer diagram, `SessionBackend` seam and the deferred container backend, base-path notes) and CLAUDE.md's folder map for `src/hub/`
- [x] 7.3 Run full validation: `bun run typecheck`, `bun test`, `bun run test:e2e`, `bun run check:licenses`, `openspec validate --all --strict`
