# Design — add-typecheck-and-test-policy

## Context

`tsconfig.json` is already strict (`"strict": true`, `"noEmit": true`,
`include: ["src/**/*.ts"]` — which covers the colocated `*.test.ts` files),
but no script, CI step, or build path ever invokes `tsc`. `bunx tsc --noEmit`
currently reports 54 errors in 13 files:

| file | errors | flavor |
|---|---|---|
| `src/render/asciidoc.ts` | 23 | untyped Asciidoctor interop |
| `src/cli.ts` | 10 | mixed |
| `src/render/preview.test.ts`, `src/cli/stdin-close.test.ts` | 8 | test-only narrowing (`possibly undefined`, Bun `Subprocess` unions) |
| `src/preview/layout.ts`, `src/preview/mount.ts` | 4 | `ViewMode` used to index `DocumentViewCacheEntry` |
| `src/sidebar/tree-view.ts` | 3 | `expand`/`isExpanded` called on `FileTreeItemHandle` union |
| `src/shell/boot.ts`, `src/shell/events.ts` | 2 | `.repositoryId` read off a `PreviewMode` member that lacks it |
| rest | 4 | scattered one-offs |

## Goals / Non-Goals

**Goals:**

- `bun run typecheck` (`tsc --noEmit`) passes and is enforced in CI.
- Errors that reveal actual behavior bugs are fixed as bugs (with tests),
  not annotated away.
- CONTRIBUTING documents the test policy and the typecheck command.

**Non-Goals:**

- No eslint / style linting — `tsc` strict mode alone satisfies the badge's
  `warnings` criterion and is the tool the repo already configured.
- No tsconfig loosening. Fixes conform the code to strict mode, not the
  reverse; `skipLibCheck` stays as-is (third-party `.d.ts` is out of scope).
- No typing overhaul of the Asciidoctor API surface beyond what uatu calls.

## Decisions

- **Pin `typescript` as a devDependency** rather than relying on whatever
  `bunx tsc` resolves at runtime — the version lands in `bun.lock` and is
  tracked by Renovate, matching the spec's reproducible-tooling requirement.
- **Fix order: real-bug candidates first, mechanical narrowing second,
  third-party interop last.** The `boot.ts`/`events.ts`/`tree-view.ts`
  errors get investigated with the debugger/tests before any type-level fix;
  if behavior is wrong, the fix is a code fix with a regression test.
- **Third-party interop (`asciidoc.ts`) gets minimal local types**: a small
  interface describing the Asciidoctor objects uatu actually touches,
  applied at the module boundary. `@ts-expect-error` with a reason comment
  is the fallback for individual lines where even that is disproportionate —
  never blanket `any`.
- **CI step placement**: after `bun install`, before the test steps — it is
  the cheapest check and should fail fast. Invoked as `bun run typecheck` so
  CI and contributors run the identical command.
- **CONTRIBUTING wording**: one normative sentence in the Validation section
  ("Changes that add or change functionality must include tests — unit tests
  in the colocated `*.test.ts`, and an e2e when the behavior is only
  observable through the UI"), plus `bun run typecheck` added to the
  validation command list.

## Risks / Trade-offs

- [A "type-level" fix silently changes runtime behavior] → the unit and e2e
  suites run over the branch; fixes prefer narrowing (guards, exhaustiveness)
  over casting, and any conditional added to product code needs a test.
- [Asciidoctor typing becomes a rabbit hole] → time-boxed by the fallback
  decision above; the boundary interface only needs the members uatu calls.
- [New contributors blocked by strict errors in unrelated files] → not a
  regression risk here since the whole tree is green at merge; CI failure
  points at the exact file/line.

## Open Questions

None.
