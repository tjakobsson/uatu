## 1. Parser

- [ ] 1.1 Accept `serve` as the canonical command in `parseCommand` (`src/server/session.ts`), producing the existing options shape
- [ ] 1.2 Route bare invocations (first arg not a recognized command; zero args; or first arg is a path/flag) to `serve` semantics
- [ ] 1.3 Keep `watch` accepted as an alias: identical parse, plus emit `warning: 'uatu watch' is deprecated; use 'uatu serve'` to stderr once
- [ ] 1.4 Update `usageText`: synopsis becomes `uatu [serve] [PATH...] [flags]`, note the deprecated alias

## 2. Wording

- [ ] 2.1 Update startup error messages in `src/server/session.ts` from watch vocabulary to root/serve vocabulary ("root does not exist", "path is not inside a git repository", …)
- [ ] 2.2 Verify the stderr warning ordering: alias warning prints before indexing status and never on stdout

## 3. Tests

- [ ] 3.1 Unit tests for `parseCommand`: `serve` explicit, bare zero-arg, bare with path, bare with leading flag, `watch` alias warning, `--help` still short-circuits
- [ ] 3.2 Update existing `parseCommand`/usage tests that assert the `watch` verb
- [ ] 3.3 Add a piped-stdout test asserting the alias warning is stderr-only

## 4. Docs and scripts

- [ ] 4.1 `package.json`: `"dev": "bun run src/cli.ts serve"`
- [ ] 4.2 README: install, usage, watchdog sections use `uatu serve`; add a one-line note about the deprecated `watch` alias
- [ ] 4.3 ARCHITECTURE.md: 30-second map node label and run/test section
- [ ] 4.4 CLAUDE.md: commands section
- [ ] 4.5 Note the alias-removal follow-up (one release out) in the change's proposal or a tracking issue with a full link

## 5. Verify

- [ ] 5.1 `bun test` passes
- [ ] 5.2 `bun run build && ./dist/uatu serve testdata/watch-docs --no-open` prints a URL; `./dist/uatu watch . --no-open` warns on stderr and still serves; bare `./dist/uatu --help` prints usage
- [ ] 5.3 `bun run test:e2e` passes
- [ ] 5.4 `bunx openspec validate rename-watch-to-serve` passes
