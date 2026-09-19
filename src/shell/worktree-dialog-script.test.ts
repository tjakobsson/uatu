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
import type { worktreeParsers, WorktreeCheckout, WorktreeInventory } from "../shared/worktree-contract";
import type { openWorktreeDialog } from "./worktree-dialog";

describe("worktreeDialogScript is minification-safe", () => {
  test("minified shared parser factories execute every response parser without ambient bindings", async () => {
    const result = await Bun.build({
      entrypoints: [path.resolve(import.meta.dir, "../shared/worktree-contract.ts")],
      minify: true, target: "browser", format: "esm",
    });
    expect(result.success).toBe(true);
    const dir = await mkdtemp(path.join(tmpdir(), "uatu-worktree-contract-script-"));
    try {
      const bundlePath = path.join(dir, "contract.mjs");
      await Bun.write(bundlePath, await result.outputs[0]!.text());
      const bundled = await import(bundlePath) as { worktreeParsersScript: string };
      const parsers = new Function(`return ${bundled.worktreeParsersScript}`)() as typeof worktreeParsers;
      const checkout: WorktreeCheckout = {
        checkoutId: "child", repositoryId: "repo", path: "/test/child", branch: "feature/a",
        detached: false, main: false, ownership: "uatu", availability: "present",
        registered: false, running: false, locked: false,
      };
      const refs = { local: ["main"], remote: ["origin/main"], fetchedAt: null };
      const inventory: WorktreeInventory = { repositoryId: "repo", sourceWorkspaceId: "main", status: "ready", checkouts: [checkout], refs };
      expect(parsers.parseWorktreeInventoryResponse({ inventory })).toEqual({ inventory });
      expect(parsers.parseWorktreeRefsResponse({ ok: true, refs })).toEqual({ ok: true, refs });
      expect(parsers.parseWorktreeDeletionPreflight({ ok: true, checkout, requiresStop: false }).ok).toBe(true);
      expect(parsers.parseWorktreeOperationResult({
        ok: true, operationId: "op", kind: "create", phase: "complete", checkout, registered: false, started: false,
      }).ok).toBe(true);
      // Exercise vocabulary, phase checks, nested parsing and sanitization,
      // not merely the factories' installation paths.
      const error = { code: "internal", message: "Failed at /private/checkouts/repo", retry: "none", phase: "creating" };
      const refused = parsers.parseWorktreeOperationResult({ ok: false, operationId: "op", kind: "create", error });
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.error.message).toBe("Failed at [path]");
      expect(() => parsers.parseWorktreeInventoryResponse({ inventory: {} })).toThrow();
      expect(() => parsers.parseWorktreeInventoryResponse({ inventory, unknown: true })).toThrow();
      expect(() => parsers.parseWorktreeOperationResult({ ok: true })).toThrow();
      expect(() => parsers.parseWorktreeRefsResponse({ ok: true, refs: { local: [], remote: [] } })).toThrow();
      expect(() => parsers.parseWorktreeDeletionPreflight({ ok: true, requiresStop: false })).toThrow();
      expect(() => parsers.parseWorktreeCreateRequest({ sourceWorkspaceId: "main", mode: "new-branch", branch: "-bad", base: { kind: "local", ref: "main" } })).toThrow();
      const removed = { ok: true, operationId: "op", kind: "delete", phase: "complete", registered: false, started: false };
      // Valid generic union members must still be rejected by a different
      // endpoint; serialization must retain this second semantic boundary.
      expect(parsers.parseWorktreeOperationResult(removed).ok).toBe(true);
      for (const kind of ["create", "register", "start", "forget"] as const) {
        expect(() => parsers.parseWorktreeEndpointResult(removed, kind)).toThrow();
      }
      for (const kind of ["create", "register", "start"] as const) {
        expect(() => parsers.parseWorktreeEndpointResult({ ...removed, kind, registered: true }, kind)).toThrow();
        const success = { ...removed, kind, registered: true, checkout: { ...checkout, registered: true, workspaceId: "workspace" } };
        expect(parsers.parseWorktreeEndpointResult(success, kind).ok).toBe(true);
        expect(() => parsers.parseWorktreeEndpointResult({ ...success, started: true }, kind)).toThrow();
      }
      expect(parsers.parseWorktreeEndpointResult(removed, "delete").ok).toBe(true);
      expect(() => parsers.parseWorktreeEndpointResult({ ...removed, kind: "forget" }, "delete")).toThrow();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
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
      const createElement = window.document.createElement.bind(window.document);
      window.document.createElement = ((tag: string) => {
        const node = createElement(tag);
        if (tag === "dialog") Object.assign(node, { showModal() { node.setAttribute("open", ""); } });
        return node;
      }) as typeof window.document.createElement;
      const requests: string[] = [];
      let responseBody: (url: string) => unknown = () => ({ inventory: {} });
      const fetchResponse = async (url: string) => {
        requests.push(url);
        return Response.json(responseBody(url));
      };
      // eslint-disable-next-line no-new-func -- exercising the inlined script exactly as a <script> tag would run it
      new Function("window", "document", "fetch", script)(window, window.document, fetchResponse);
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
      // Execute the dialog's injected parser, not only factory installation.
      (globals.openWorktreeDialog as typeof openWorktreeDialog)({
        api: "/api/hub/worktrees", source: { id: "main", name: "Repository" }, view: "discover",
      }, window.document.body);
      for (let turn = 0; turn < 20; turn++) await Bun.sleep(0);
      const host = window.document.querySelector("dialog")!.firstElementChild!;
      const text = host.shadowRoot!.querySelector("main")!.textContent!;
      expect(text).toContain("Invalid worktree response.");
      expect(text).not.toContain("Every worktree Git lists is registered.");
      expect(requests).toEqual(["/api/hub/worktrees?source=main"]);
      for (const kind of ["delete", "create"]) {
        window.document.querySelector("dialog")!.remove();
        responseBody = url => url.endsWith("/create")
          ? { ok: true, operationId: "op", kind, phase: "complete", registered: false, started: false }
          : { inventory: { repositoryId: "repo", sourceWorkspaceId: "main", status: "ready", checkouts: [], refs: { local: ["main"], remote: [], fetchedAt: null } } };
        (globals.openWorktreeDialog as typeof openWorktreeDialog)({
          api: "/api/hub/worktrees", source: { id: "main", name: "Repository" }, view: "create", mode: "new",
        }, window.document.body);
        for (let turn = 0; turn < 20; turn++) await Bun.sleep(0);
        const root = window.document.querySelector("dialog")!.firstElementChild!.shadowRoot!;
        const input = root.querySelector<HTMLInputElement>('[name="branch"]')!;
        input.value = "kept-draft";
        root.querySelector("form")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
        for (let turn = 0; turn < 20; turn++) await Bun.sleep(0);
        expect(root.querySelector("main")!.textContent).toContain("Invalid worktree response.");
        expect(input.value).toBe("kept-draft");
        expect(window.document.querySelector("[data-worktree-confirmation]")).toBeNull();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
