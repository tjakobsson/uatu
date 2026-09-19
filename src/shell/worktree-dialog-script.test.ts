// Bug 1 regression (compiled-binary dashboard: `ReferenceError:
// openWorktreeFork is not defined`).
//
// worktreeDialogScript is `installWorktreeDialog.toString()` wrapped in an
// IIFE and inlined verbatim into src/hub/pages.ts's dashboard <script>. That
// only works in production if the string this module COMPUTES AT RUNTIME —
// after this module itself has been through `bun build --compile --minify`
// — still evaluates to a script whose public surface (openWorktreeFork,
// openWorktreeDialog, validWorktreeBranch, …) is reachable by the plain
// name pages.ts's own literal template text calls it by.
//
// dev/e2e never catches this: tests/e2e/hub-server.ts and cli.ts's `serve`
// both run from unminified source, so `worktreeDialogScript` is built from
// unmangled `.toString()` output there regardless of whether the technique
// is minification-safe. Proving it requires actually minifying this module
// and running what it produces — which is what this test does, the same
// way scripts/build.ts does for the real binary.
import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

describe("worktreeDialogScript is minification-safe", () => {
  test("a bun build --minify of this module still produces a script whose public functions and rules are reachable by name", async () => {
    const result = await Bun.build({
      entrypoints: [path.resolve(import.meta.dir, "worktree-dialog.ts")],
      minify: true,
      target: "browser",
      format: "esm",
    });
    expect(result.success).toBe(true);
    expect(result.outputs.length).toBeGreaterThan(0);

    // Bun.build's in-memory artifacts aren't directly importable; round-trip
    // through a temp file so `import()` runs the SAME minified code the
    // compiled binary would run, and worktreeDialogScript is computed by
    // real (minified) `.toString()` calls, not by inspecting source text.
    const dir = await mkdtemp(path.join(tmpdir(), "uatu-worktree-dialog-script-"));
    try {
      const bundlePath = path.join(dir, "worktree-dialog.bundle.mjs");
      await Bun.write(bundlePath, await result.outputs[0]!.text());
      const minifiedModule = (await import(bundlePath)) as { worktreeDialogScript: string };
      const script = minifiedModule.worktreeDialogScript;
      expect(typeof script).toBe("string");
      // The production failure mode: evaluating the inlined script and then
      // calling the names pages.ts's dashboard template literally types out
      // (`openWorktreeFork(target, fork)`, `openWorktreeDialog({...}, w)`)
      // threw ReferenceError because those top-level function declarations'
      // OWN names had been minified away while cross-references between
      // them drifted out of sync. Running the script against a stub
      // `window`/`document` and reading the names back off `window`
      // reproduces exactly that failure mode if it regresses.
      const { window } = parseHTML("<!doctype html><html><body></body></html>");
      // eslint-disable-next-line no-new-func -- exercising the inlined script exactly as a <script> tag would run it
      new Function("window", "document", script)(window, window.document);
      const globals = window as unknown as Record<string, unknown>;
      expect(typeof globals.openWorktreeFork).toBe("function");
      expect(typeof globals.openWorktreeDialog).toBe("function");
      expect(typeof globals.validWorktreeBranch).toBe("function");
      // W2's branch-name ceiling, exercised through the same minified,
      // window-exposed rule pages.ts's inline script would call.
      expect((globals.validWorktreeBranch as (branch: string) => boolean)("x".repeat(65))).toBe(false);
      expect((globals.validWorktreeBranch as (branch: string) => boolean)("x".repeat(64))).toBe(true);
      // F11: the one fork glyph both surfaces draw. The dashboard's inline
      // script reads it by this plain name too, so it has to survive
      // minification exactly as the functions around it do.
      expect(typeof globals.worktreeForkIcon).toBe("string");
      expect(globals.worktreeForkIcon as string).toContain('viewBox="0 0 32 20"');
      expect(globals.worktreeForkIcon as string).toContain("M6.4 6h19.2M6.4 6.8c7 1.5 8 8.2 15 8.2h4.2");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
