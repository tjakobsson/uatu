## 1. Verify linkedom against our DOM use cases

- [x] 1.1 Write a throwaway script that uses `linkedom`'s `parseHTML` to build a `<div>`, set `innerHTML` to `'<svg style="max-width: 412px;" width="100%" viewBox="0 0 412 240"></svg>'`, then assert `div.querySelector("svg").style.maxWidth === "412px"` and that `getAttribute`/`setAttribute`/`removeAttribute` round-trip
- [x] 1.2 Confirm `Element.replaceChildren(...)`, `Element.append(...)`, `Element.classList`, and `Element.ownerDocument.createElement(...)` all behave as the tests expect
- [x] 1.3 Confirm `container.querySelectorAll<HTMLElement>(".mermaid")` and `node.querySelectorAll("button.mermaid-trigger")` return matches against `innerHTML`-built subtrees
- [x] 1.4 If any verification fails, stop and decide between (a) shim fallback or (b) different library — do not proceed with the swap until the spike passes

## 2. Swap the dependency

- [x] 2.1 Remove `"happy-dom": "15"` from `package.json` devDependencies
- [x] 2.2 Add `"linkedom"` (latest, currently 0.18.x) to `package.json` devDependencies
- [x] 2.3 Run `bun install` to regenerate `bun.lock`
- [x] 2.4 Confirm `happy-dom` no longer appears in `bun.lock`

## 3. Rewrite the test setup

- [x] 3.1 Replace `import { Window } from "happy-dom"` in `src/preview.test.ts` with `import { parseHTML } from "linkedom"`
- [x] 3.2 Replace `win = new Window(); doc = win.document as unknown as Document` in each `beforeEach` with the linkedom equivalent (e.g., `doc = parseHTML("<!doctype html><html><body></body></html>").document as unknown as Document`)
- [x] 3.3 Drop the now-unused `win` local from both `describe` blocks
- [x] 3.4 Keep the `__resetMermaidStateForTests()` and global `mermaid` cleanup unchanged

## 4. Validate

- [x] 4.1 Run `bun test src/preview.test.ts` and confirm all tests in that file pass
- [x] 4.2 Run `bun test` and confirm the whole unit-test suite still passes
- [x] 4.3 Run `bun run check:licenses` to confirm `linkedom`'s license is on the permissive allow-list
- [x] 4.4 Run `bun run build` to confirm the shipped artifact build is unchanged
