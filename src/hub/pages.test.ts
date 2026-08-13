import { describe, expect, test } from "bun:test";

import { dashboardPage } from "./pages";

describe("dashboard clone panel", () => {
  test("renders syntactically valid client JavaScript", () => {
    const html = dashboardPage();
    const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];

    expect(script).toBeDefined();
    expect(() => new Function(script!)).not.toThrow();
  });

  test("renders compact prompt-capable clone controls", () => {
    const html = dashboardPage();

    expect(html).toContain('id="clone-panel"');
    expect(html).toContain('id="clone-output"');
    expect(html).toContain('id="clone-response" type="password"');
    expect(html).toContain('id="clone-cancel"');
    expect(html).toContain('id="clone-folder-name"');
    expect(html).toContain("folderNameInput.value.trim()");
    expect(html).toContain("{ url, dest: browsePath, folderName }");
    expect(html).toContain("Available for any Git or SSH prompt");
  });

  test("uses clone jobs, SSE, ephemeral input, and textContent output", () => {
    const html = dashboardPage();

    expect(html).toContain('api("/api/hub/clone-jobs"');
    expect(html).toContain('new EventSource("/api/hub/clone-jobs/"');
    expect(html).toContain('events.addEventListener("output"');
    expect(html).toContain('events.addEventListener("phase"');
    expect(html).toContain('events.addEventListener("result"');
    expect(html).toContain("events.onmessage = event => handleCloneEvent");
    expect(html).toContain('cloneOutput.textContent += text');
    expect(html).toContain('cloneResponse.value = "";');
    expect(html).not.toContain('api("/api/hub/clone"');
  });

  test("recognizes prompts without gating input and distinguishes results", () => {
    const html = dashboardPage();

    expect(html).toContain("Passphrase");
    expect(html).toContain("Username");
    expect(html).toContain("Host trust response");
    expect(html).toContain("Verification response");
    for (const status of ["cancelled", "timed-out", "clone-failed", "register-failed", "start-failed", "succeeded"]) {
      expect(html).toContain(status);
    }
    expect(html).toContain("openSession(workspaceId)");
    expect(html).toContain("cloneResponseForm.hidden = !active;");
    expect(html).toContain('cloneResponse.value = "";');
    expect(html).toContain("button:disabled { opacity: 0.5; cursor: default; }");
  });

  test("reconnects and restores the correct busy state after bfcache navigation", () => {
    const html = dashboardPage();

    expect(html).toContain('window.addEventListener("pageshow"');
    expect(html).toContain("closeCloneEvents();");
    expect(html).toContain("uiBusy = cloneJobId ? 1 : 0;");
    expect(html).toContain("if (cloneJobId) connectCloneEvents();");
  });
});
