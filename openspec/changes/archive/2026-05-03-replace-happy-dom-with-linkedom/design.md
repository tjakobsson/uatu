## Context

`src/preview.test.ts` is the only consumer of a DOM-simulation library in this repo. It uses `happy-dom` solely to obtain a `Document` so it can construct `<div>` and `<svg>` nodes, set `innerHTML`, and call `querySelector` / `querySelectorAll` against the helpers in `src/preview.ts`. None of the production code depends on `happy-dom`.

The blocking constraint is runtime: the project's tests run under Bun (currently pinned to `bun@1.3.13`). happy-dom v17+ installs standard error constructors (`SyntaxError`, `DOMException`, …) on its `Window` by running a script inside a Node `vm` context. Bun's `vm` module does not propagate the script's `this.X = ...` assignments back to the contextified Window object, so `window.SyntaxError` ends up `undefined`. From happy-dom 20.6.3 onwards, `SelectorParser.getSelectorGroups` constructs the SyntaxError eagerly via `new this.window.SyntaxError(...)` on every `querySelector` call, so the missing constructor crashes every selector lookup. This is upstream issue capricorn86/happy-dom#1762, open for ~14 months with no fix.

## Goals / Non-Goals

**Goals:**
- Replace `happy-dom` with a DOM library that does not rely on `vm.createContext` and runs cleanly under Bun.
- Keep the test surface area equivalent: same assertions, same test names, same fidelity for SVG `innerHTML` parsing, inline `style.maxWidth` reads, and tag/class selectors.
- Eliminate the `happy-dom` devDependency entirely so future renovate bumps cannot reintroduce the same failure.
- Capture the runtime-compatibility lesson as a spec requirement under `repository-workflows`.

**Non-Goals:**
- Changing the production DOM behavior of `src/preview.ts` or any browser-facing code.
- Migrating away from Bun, splitting the test runner, or running tests under Node.
- Building a hand-rolled DOM stub.
- Adopting `linkedom` outside of the test environment.
- Suppressing or working around the upstream happy-dom bug (e.g. monkey-patching `window.SyntaxError`); the bug is upstream's to fix and we want zero exposure to it.

## Decisions

### Decision: Use `linkedom` as the replacement DOM

Pick `linkedom` over `jsdom` and over a happy-dom workaround.

**Rationale:**
- `linkedom` is implemented as plain JS object trees and does not call `vm.createContext` anywhere, so the Bun↔VM-context failure mode is structurally absent.
- Smallest install footprint of the three options (~250 KB vs ~800 KB happy-dom vs ~3.5 MB jsdom).
- API for our use case is a one-liner: `const { document } = parseHTML("<html>...</html>")`.

**Alternatives considered:**
- *jsdom* — also uses `vm.createContext`; mixed Bun support; ~14× larger install. Same architectural risk we just hit.
- *Shim `window.SyntaxError` etc. in `beforeEach`* — three-line patch, but leaves us coupled to a bug-prone upstream and a fragile list of constructors we'd have to extend on each happy-dom bump.
- *Hand-rolled DOM stub* — significant code to maintain to get `innerHTML` SVG parsing right; high effort for low payoff.
- *Pin happy-dom@20.6.2* — avoids the regression but locks us out of the security advisory the renovate PR is trying to apply, and just defers the problem.

### Decision: Verify linkedom against our specific DOM use cases before committing

Before swapping the dependency, confirm with a short spike that linkedom:
1. Parses inline `<svg style="max-width: 412px;" width="100%" ...>` from `innerHTML` and exposes `svg.style.maxWidth === "412px"`.
2. Resolves `div.querySelector("svg")` and `node.querySelectorAll("button.mermaid-trigger")` against an element built from `innerHTML`.
3. Supports `Element.replaceChildren(...)`, `Element.append(...)`, `Element.classList`, and `Element.ownerDocument.createElement(...)`.

These are the only DOM affordances `src/preview.test.ts` and `src/preview.ts` rely on. If any are missing or wrong, fall back to the shim approach (and revisit non-goals).

**Rationale:** `linkedom`'s docs are sparse on SVG specifically. The downside of a surprise here is small (we just fall back), but discovering it during the rewrite is wasteful — a five-minute spike up front avoids that.

### Decision: Capture the constraint in `repository-workflows` spec

Add a new requirement to the existing `repository-workflows` capability stating that test-only DOM-simulation tooling MUST run under the project's pinned Bun runtime.

**Rationale:** This change is itself the proof that "any DOM library will do" is wrong. Encoding the constraint as a spec means the next dependency review (human or AI) has something concrete to check against, and the next renovate-driven swap cannot silently reintroduce the failure mode.

**Alternatives considered:** Leave it implicit / put it in CLAUDE.md / README. Spec is durable, version-controlled, and surfaces in OpenSpec workflows; the others rot.

## Risks / Trade-offs

- **Risk: linkedom's SVG/style support turns out to be incomplete for our specific assertions** → Mitigation: gated by the verification spike above; if it fails, fall back to the shim approach and document the trade-off.
- **Risk: linkedom maintenance slows down or also develops Bun friction** → Mitigation: usage is one file and a tiny API surface; switching to a different library or a hand-roll later is bounded work. The spec requirement makes the constraint explicit either way.
- **Trade-off: linkedom is less browser-faithful than happy-dom or jsdom** (no layout, no CSSOM beyond inline styles, no script execution). This is acceptable — the tests don't need any of that, and we have Playwright covering full-browser behavior in `tests/`.
- **Trade-off: the renovate PR (#23) gets superseded rather than merged**, which means renovate may keep re-opening it until happy-dom is removed from the lockfile. Removing the devDependency closes that loop.

## Migration Plan

1. Spike linkedom against the three verification points above (5 minutes, throwaway script).
2. Swap `happy-dom` → `linkedom` in `package.json` devDependencies; regenerate `bun.lock`.
3. Rewrite `beforeEach` in `src/preview.test.ts` to use `linkedom`'s `parseHTML`.
4. Run `bun test` locally; expect the previously-failing six tests in `preview.test.ts` to pass alongside the rest of the suite.
5. Add the new requirement under `openspec/specs/repository-workflows/spec.md` (via the change's spec delta at archive time).
6. Open a PR; close renovate PR #23 once merged (the CVE no longer applies because happy-dom is gone).

**Rollback:** revert the PR. Production is unaffected; only test tooling changes.

## Open Questions

- None blocking. Spike verification answers any remaining linkedom-specific unknowns before code is touched.
