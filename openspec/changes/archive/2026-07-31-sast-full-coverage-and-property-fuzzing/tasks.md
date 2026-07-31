# Tasks — sast-full-coverage-and-property-fuzzing

## 1. Full CodeQL coverage

- [x] 1.1 Remove the `paths-ignore` blocks from both triggers in `.github/workflows/codeql.yml` and update the workflow's header comment (the weekly schedule stays as a backstop)

## 2. Property-based tests

- [x] 2.1 Add `fast-check` as a devDependency; confirm `bun run check:licenses` stays green
- [x] 2.2 HTML escaping properties in `src/shared/html.test.ts`: arbitrary strings escape to output with no unescaped `<`, `>`, or quotes
- [x] 2.3 Markdown render properties in `src/render/markdown.property.test.ts`: arbitrary source renders without throwing and emits no script elements, inline event handlers, or `javascript:` URLs (checked on the parsed tree, not with regexes)
- [x] 2.4 Mermaid sanitization properties in `src/render/preview.property.test.ts`: arbitrary mermaid source cannot smuggle element nodes into the `div.mermaid` hydration container
- [x] 2.5 Ignore engine properties in `src/ignore/engine.property.test.ts`: decisions are deterministic, built-in defaults hold at any depth, and the chokidar adapter agrees with `shouldIgnore`

## 3. Validate

- [x] 3.1 `bun test` passes with the new properties (10 property tests add ~0.4s to the suite)
- [x] 3.2 `bun run check:licenses` and `bun run build` pass
- [x] 3.3 `openspec validate --all --strict` passes

## 4. Commit

- [x] 4.1 Commit the work as `chore(security): analyze every commit with CodeQL and add property-based fuzzing` (workflow + tests + OpenSpec artifacts)

Per repo conventions the work lands via a PR from
`chore/scorecard-sast-fuzzing`; after merge, trigger the Scorecard
workflow (or wait for the push-trigger) to publish the improved SAST and
Fuzzing scores.
