# Tasks — add-project-identity

## 1. Identity module

- [x] 1.1 Create `src/shell/identity.ts` with pure helpers: `projectLabel(roots)` (first label / `+N` / null), `identityHue(roots)` (FNV-1a over sorted root paths, mod 360), `pageTitle(label)`, and `faviconSvg(label, hue)` (rounded square, hue fill, white initial)
- [x] 1.2 Add `applyProjectIdentity(roots)` in the same module: sets `document.title`, creates-or-updates the `link[rel="icon"]` SVG data URL, and keeps title/favicon in sync (the in-app marker renders in change-overview, task 2.1)
- [x] 1.3 Unit tests in `src/shell/identity.test.ts` for the pure helpers: single/multi/empty roots label, hue stability + order-independence + path-not-label derivation, title string, SVG contains hue and initial

## 2. Wiring and chrome

- [x] 2.1 Render each repository name in `src/sidebar/change-overview.ts` as an identity badge (hue from the repo's watched roots' paths, root-paths tooltip) and style it in `src/styles.css`
- [x] 2.2 Call `applyProjectIdentity(payload.roots)` from the state-payload apply path (`src/shell/boot.ts` initial payload and `src/shell/events.ts` refreshes) so identity is re-derived idempotently on every payload

## 3. Verification

- [x] 3.1 E2E coverage in `tests/e2e/` asserting `document.title` is `<label> — uatu`, the dynamic favicon link exists exactly once with the expected initial, and the Change Overview badge shows the repository name with the root-path tooltip
- [x] 3.2 Run `bun test` and the new e2e spec; manually boot `bun run dev` (with `--no-open`) and confirm two instances on different projects show distinct titles, favicon colors, and markers
