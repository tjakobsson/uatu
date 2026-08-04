# Tasks — add-typecheck-and-test-policy

Work happens on this branch (`chore/best-practices-passing-gaps`) and lands
via a pull request per repository convention. Suggested PR title:
`chore(ci): enforce tsc --noEmit and document the test policy`. After merge,
the OpenSSF Best Practices form entries for `warnings`, `warnings_fixed`,
`warnings_strict`, `test_policy`, and `tests_documented_added` can be
answered "Met" citing `ci.yml` and `CONTRIBUTING.md` — that form update is a
manual post-merge step, not a task below.

## 1. Tooling

- [x] 1.1 Add `typescript` as a pinned devDependency and a `typecheck`
      script (`tsc --noEmit`) to `package.json`
- [x] 1.2 Confirm `bun run typecheck` reproduces the 54 baseline errors
      (sanity check that the script exercises the strict config)

## 2. Investigate real-bug candidates before annotating

- [x] 2.1 `src/shell/boot.ts:155` / `src/shell/events.ts:92` — `.repositoryId`
      is read off `PreviewMode` union members that lack it; determine the
      intended behavior, fix the code or the type union accordingly, and add
      a regression test if behavior was wrong
- [x] 2.2 `src/sidebar/tree-view.ts:374-446` — `expand`/`isExpanded` called
      on `FileTreeItemHandle` which may be a file handle; verify whether a
      file node can reach these paths, then guard or narrow with the real
      invariant
- [x] 2.3 `src/preview/layout.ts` / `src/preview/mount.ts` — `ViewMode` keys
      used to index `DocumentViewCacheEntry`; align the entry type or the
      mode set so the mapping is checked, not implicit

## 3. Mechanical type fixes

- [x] 3.1 `src/render/asciidoc.ts` (23 errors) — introduce a minimal local
      interface for the Asciidoctor objects uatu touches at the module
      boundary; `@ts-expect-error` with a reason comment only where even
      that is disproportionate
- [x] 3.2 `src/cli.ts` (10 errors) — narrow and annotate to strict
      compliance
- [x] 3.3 Remaining product files (`src/terminal/panel.ts`,
      `src/preview/file-facts-strip.ts`, and stragglers) — strict-mode
      narrowing fixes
- [x] 3.4 Test files (`src/render/preview.test.ts`,
      `src/cli/stdin-close.test.ts`, sidebar test fixtures) — fix
      assertions/fixtures to satisfy strict mode, including the outdated
      `ReviewBase` fixture shapes

## 4. Enforcement and documentation

- [x] 4.1 Add a "Type check" step (`bun run typecheck`) to
      `.github/workflows/ci.yml` after dependency install, before the test
      steps
- [x] 4.2 `CONTRIBUTING.md` — add the test-policy sentence to the Validation
      section and `bun run typecheck` to the validation command list

## 5. Verification

- [x] 5.1 `bun run typecheck` exits 0
- [x] 5.2 `bun test` passes; run the e2e suite if any product-code fix went
      beyond pure type narrowing (required for task 2.x fixes that changed
      behavior)
- [x] 5.3 `actionlint` (or YAML parse) passes on `ci.yml`, and
      `openspec validate --all --strict` passes
