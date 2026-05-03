## Why

The renovate PR upgrading `happy-dom` from v15 to v20.8.9 (security fix for CVE-2025-61927, VM-context escape RCE) fails CI: every `querySelector` call in `src/preview.test.ts` crashes with `"undefined is not a constructor"` against `this.window.SyntaxError`. Root cause is a known, year-old upstream Bun↔happy-dom incompatibility (capricorn86/happy-dom#1762) that became fatal in happy-dom 20.6.3 when `SelectorParser` began constructing errors eagerly via `this.window.SyntaxError` on every selector call. happy-dom installs standard constructors on `Window` by running a script in a Node `vm` context; Bun's `vm` does not propagate those `this.X = ...` assignments back to the contextified Window. There is no upstream fix in sight, and we still need the security upgrade.

happy-dom is overkill for what we actually use it for: a single test file (`src/preview.test.ts`) that needs a DOM tree to exercise SVG normalization and Mermaid wrapping helpers. Swapping to `linkedom` — a lightweight DOM that does not touch `vm.createContext` and works cleanly under Bun — removes the recurring upgrade risk and shrinks the dev dependency footprint (~250 KB vs ~800 KB).

## What Changes

- Remove the `happy-dom` devDependency; add `linkedom` in its place.
- Rewrite the `beforeEach` setup in `src/preview.test.ts` to obtain `document` via `linkedom`'s `parseHTML(...)` instead of `new Window()` from happy-dom.
- No production code changes — `src/preview.ts` and the helpers under test already operate against standard DOM interfaces (`HTMLElement`, `SVGElement`, `ParentNode`).

## Capabilities

### New Capabilities

(none — internal test-tooling swap, no behavior surfaced to users)

### Modified Capabilities

- `repository-workflows`: add a requirement that test-only DOM-simulation tooling MUST run under the project's pinned Bun runtime, so a future dependency choice cannot silently reintroduce the same Bun↔VM-context failure mode this change is fixing.

## Impact

- **Code**: `src/preview.test.ts` (rewrite of test setup, ~5–10 lines), `package.json` (devDependencies swap), `bun.lock` (regenerated).
- **CI**: unblocks the security upgrade path; future renovate bumps for the DOM library no longer carry Bun-VM-context risk.
- **Runtime / shipped artifact**: none — the change is contained to the test environment.
- **Renovate PR #23**: superseded. Once `happy-dom` is removed from the tree, the CVE no longer applies and the PR can be closed.
