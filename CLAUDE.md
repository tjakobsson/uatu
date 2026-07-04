# CLAUDE.md — agent guidance for uatu

uatu is a local Bun-served PWA that watches a docs tree and previews
Markdown / AsciiDoc with a review-load score and an embedded terminal.
See `ARCHITECTURE.md` for the deeper picture (runtime, request lifecycle,
state lifecycle, terminal subsystem, follow-mode rules, how-to-extend
recipes).

## src/ folder map

`src/` is organized by feature. Three entrypoint files live at the root
(`app.ts`, `cli.ts`, `styles.d.ts`); everything else is in a folder named
after the running app's region or a coherent domain.

```
src/
├── app.ts          SPA entry — DOM queries, init calls, event wiring
├── cli.ts          CLI entry — `uatu serve ...` + Bun.serve assembly
├── styles.d.ts     CSS module type declarations
├── index.html, styles.css, assets/, assets/fonts/
│                   (the bundled Hack Nerd Font Mono lives here — it's
│                   the default for *every* monospace surface in the
│                   app, served at /assets/fonts/, with siblings for
│                   the upstream license texts)
│
├── mono/           bundled-font config and runtime application — the
│                   `.uatu.json mono.fontFamily` loader plus the helper
│                   that writes `--mono-font-family` on `<html>` at boot
├── shell/          boot, events, history, url, connection, pwa, follow,
│                   follow-rules, state, storage, stale-hint — the
│                   app-wide chrome and the appState singleton
├── preview/        the right pane — mounting rendered HTML, view-mode
│                   chooser, layout (split/stacked), diff view,
│                   mermaid trigger, anchors, image/binary fallbacks,
│                   metadata card, code-block decorations
├── sidebar/        the left pane — tree-view + tree-config, panes
│                   shell/render, change-overview, git-log, files-filter,
│                   selection-inspector
├── terminal/       the embedded xterm panel — client + server +
│                   auth + pty + pane-state + panel UI
├── server/         routes (single source of truth for the HTTP route
│                   table), session (watch + render building blocks),
│                   port-probe
├── document/       per-document concerns — metadata, diff, classify,
│                   git-base-ref, language detection
├── render/         source → HTML (markdown, asciidoc, mermaid sanitization)
├── review/         load — the review-burden score data layer
├── ignore/         engine (.uatu.json + --no-gitignore)
├── watchdog/       main + capture — heartbeat-driven hang recovery
├── debug/          cache + metrics + the heartbeat integration test
├── pwa/            PWA install affordance (asset references only)
└── shared/         html, types, license-check, version
```

## Conventions

- **`src/` is product code only.** Test harnesses live in `tests/`. The
  E2E Playwright server is at `tests/e2e/server.ts`, NOT in `src/`.
- **Tests are colocated.** `foo.ts` and `foo.test.ts` are siblings; no
  parallel test tree under `src/`.
- **The HTTP route table is declared once** in `src/server/routes.ts`
  via `buildRoutes(deps)`. `cli.ts` (prod) and `tests/e2e/server.ts`
  (e2e) both call it with mode-specific deps.
- **appState lives in `src/shell/state.ts`.** It's a module-level
  mutable singleton. Other modules import it directly; do not duplicate.
- **Cross-cutting helpers** like `escapeHtml` live in `src/shared/`.
  Don't reach into `app.ts` for them — that path has caused
  circular-import TDZ bugs.
- E2E tests live in `tests/e2e/` under feature-named files
  (`mermaid.e2e.ts`, `sidebar.e2e.ts`, `document-tree.e2e.ts`, etc.) —
  there is no monolithic `uatu.e2e.ts`.
- **The follow-mode capability** owns the Follow toggle, its four rules
  (Rule A user click, Rule B chip click, Rule C/D file event), and the
  `TreeView.withProgrammaticUpdate(fn)` guard that distinguishes real
  user clicks from library-fired callbacks. Spec at
  `openspec/specs/follow-mode/spec.md`.

## Commands

- `bun run dev` — local watch on `testdata/watch-docs`
- `bun test` — unit suite (~18s)
- `bun test:e2e` — Playwright suite (~5min, `workers: 1` serial)
- `bun run build` — compile the single-file `dist/uatu` binary
- `bun run check:licenses` — license audit
