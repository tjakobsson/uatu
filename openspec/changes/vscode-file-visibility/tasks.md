## 1. Exposure rules and configuration

- [x] 1.1 Reduce `src/ignore/exposure.ts` to VS Code's `files.exclude` defaults (`.git`, `.svn`, `.hg`, `.jj`, `.DS_Store`, `Thumbs.db`), checked against VS Code's current source with the version noted in a comment, and remove every other name, suffix, and secret rule; verify `engine.test.ts` and `engine.property.test.ts` show `node_modules/x.js`, `.venv/…`, `.env`, `id_rsa`, `a.swp`, and `coverage/…` permitted and the six defaults denied at any depth.
- [x] 1.2 Remove the `build`/`dist` soft-exclusion branch from `src/ignore/engine.ts` and replace `ignore.include` parsing in `config.ts` with one no-effect warning; verify `config.test.ts` covers the warning for valid and malformed values and that exposure is identical with and without the key.
- [x] 1.3 Replace `ignore.include` fixtures and secret-denial assertions in `ignored-visibility.test.ts`, `static-files.test.ts`, `media-delivery.test.ts`, `src/hub/media-delivery.integration.test.ts`, and `tests/e2e/media-workflow.e2e.ts` with unconfigured ignored-folder fixtures and explicit-exclusion cases; verify those files pass.

## 2. Ignored-folder discovery and listing (server)

- [x] 2.1 Collect ignored folders per Git root with `git ls-files --others --ignored --exclude-standard --directory -z`, confirm each directory with `git check-ignore`, index confirmed folders as folder entries without descending, and index individually ignored files with known `ignored` status; verify watch-session tests with a real Git fixture: `node_modules/` with many files yields one folder entry and zero file stats inside it, `/references/*` with a negated README is discovered normally, and non-Git roots are discovered completely.
- [x] 2.2 Classify directories created at runtime before descending, and recompute folder entries and listed levels through `recover()` when Git ignore sources change; verify tests for a runtime-created ignored `build/` and for a `.gitignore` edit that makes a discovered folder ignored and another not ignored.
- [x] 2.3 Add folder entries (path with trailing `/`, `listed` flag) to snapshots and patches, the shared reducer in `src/shared/document-updates.ts`, and the Hub broker's document index and replay; bump the live-payload schema, API revision declarations, and changelog as for closed-object additions; verify reducer tests, broker replay tests, and the CI compatibility check run locally.
- [x] 2.4 Add the internal one-level listing route, which publishes the level as an ordinary patch and answers with its revision, applies exclusions and realpath containment, and removes the entry for a vanished folder, with an explicit non-public route classification; verify route tests for listing, exclusion, symlink escape, a missing folder, and the route-coverage check.

## 3. Live-write window and batched lane (server)

- [x] 3.1 Index native-watch writes inside unlisted ignored folders as windowed entries, with a per-root bound of 2,000, oldest-unpinned eviction as removals, pinning on document/static/media requests, and conversion to listed entries when their level is listed; verify file-index tests for the bound with 80,000 writes, eviction order, a pinned file surviving, and an evicted file returning on listing.
- [x] 3.2 Route paths inside ignored folders into a path-keyed lane with a 1 s debounce, 5 s maximum wait, and patches of at most 1,024 entries, carrying `ignored` status without classification and without Follow candidates, and leave the ordinary lane's 150 ms / 2 s / 256 behavior unchanged; verify fake-timer scheduler tests and file-index tests asserting ≤5 patches for 5,000 writes, a single entry for repeated writes, no entry for short-lived files, and an ordinary edit published within 2 s while the lane is busy.
- [x] 3.3 Keep the Chokidar fallback from traversing unlisted ignored folders while watching listed levels; verify file-observer tests in polling mode.

## 4. Follow

- [ ] 4.1 Exclude Git-ignored files from server Follow nomination (`latestChanges`, per-subscriber `changedId`, reconnect `latestChange`, `newest()`/`NewestDocument`), collapse the per-visibility `latestChanges` maps, and treat failed classification as not ignored; verify watch-session tests for an ignored build batch with Show ignored on and off, a mixed batch following the document, a tracked `dist/index.html` being followed, and an initial default that skips newer ignored files.
- [ ] 4.2 Exclude Git-ignored files from the client's chip catch-up in `src/shell/follow.ts`, and keep refresh in place for opened ignored files; verify a unit test for catch-up and a browser test that rewrites an opened ignored `build/report.md` without changing selection.

## 5. Tree, Recent, and count (client)

- [ ] 5.1 Render folder entries as explicit muted directories in `src/sidebar/tree-view.ts`, request a listing on genuine user expansion with a loading state on the row, merge results under `withProgrammaticUpdate`, offer retry on failure, never re-request listed levels, and request ancestor levels when revealing an explicitly selected file; verify browser tests with pointer, touch, and keyboard expansion, a failed listing, focus staying on the row, and no listing requests during mount or filter reconciliation.
- [ ] 5.2 Extend `isDocumentVisible` to folder entries so Show ignored files and `ignore.exclude` negations apply to them, and make Recent and the count reflect known files only; verify `file-visibility` and `recent-model` tests plus a browser test in which listing a level raises the count.

## 6. End-to-end and cost

- [ ] 6.1 Add an e2e test with an unconfigured Git workspace ignoring `/build*/` and `node_modules/`: both appear muted, expanding `build/renders/` lists and plays a render, a render written during the session appears in Recent and under Audio without expansion and does not take Follow, and `.env` is listed and previewable; verify on desktop and touch Chromium and WebKit through the Hub, and save screenshots of the muted folders, an expanding folder, and Recent.
- [ ] 6.2 Add an `@perf` e2e test with a 40,000-file ignored `node_modules/` and an 80,000-write install burst, asserting deterministic counters (one folder entry at discovery, no stats inside it, at most 2,000 windowed entries, lane patch counts, zero Follow navigations, an ordinary edit visible within its bound), and recording discovery time and tree-mount time as evidence; verify it passes under `bun run test:e2e:perf`.

## 7. Documentation

- [ ] 7.1 Update README.md and docs/FILES.md to describe the VS Code-aligned defaults, on-demand ignored folders, the live-write window, the Follow rule, the security stance on secret-like files with `ignore.exclude` opt-out patterns, non-Git and polling-mode limits, and the removal of `ignore.include`; verify `rg "ignore\.include" --glob '!openspec/changes/archive/**'` finds only the warning code and its test.
