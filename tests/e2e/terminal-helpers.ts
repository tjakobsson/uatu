// Shared terminal synchronization for e2e specs, standalone and hub-served.
//
// Two facts decide when a test may type into a pane:
//
// - The client forwards keystrokes only once the pane is attached: until the
//   server's reconstruction has been written, `term.onData` drops input
//   (src/terminal/client.ts). The pane host says so with
//   `data-terminal-ready="true"`; a visible `.xterm`, or a non-empty row,
//   says nothing (a restored pane paints its old screen long before the
//   reattached socket is live).
// - An attached pane does not yet prove the shell is reading its input. The
//   echo-sentinel round trip does: a command whose OUTPUT differs from its
//   own echoed command line, with a nonce no earlier screen can contain.

import fs from "node:fs/promises";
import path from "node:path";

import { expect, type Locator, type Page } from "@playwright/test";

export function paneHost(page: Page, paneIndex = 0): Locator {
  return page.locator(".terminal-pane-host").nth(paneIndex);
}

// Resolves once the pane's socket is live and its reconstruction painted —
// the moment typed keys start reaching the PTY.
export async function waitForTerminalReady(page: Page, paneIndex = 0): Promise<Locator> {
  const host = paneHost(page, paneIndex);
  await expect(host.locator(".xterm")).toBeVisible();
  await expect(host).toHaveAttribute("data-terminal-ready", "true");
  return host;
}

// Focuses the CURRENT pane's input at the time of the call: recovery can
// swap the pane's xterm, and focus taken earlier would point at a disposed
// one whose keystrokes go nowhere.
export async function focusTerminal(page: Page, paneIndex = 0): Promise<void> {
  await page.evaluate(index => {
    const host = document.querySelectorAll<HTMLElement>(".terminal-pane-host")[index];
    host?.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea")?.focus();
  }, paneIndex);
}

export async function typeInTerminal(page: Page, line: string, paneIndex = 0): Promise<void> {
  await focusTerminal(page, paneIndex);
  await page.keyboard.type(line);
  await page.keyboard.press("Enter");
}

let sentinelSerial = 0;

// Readiness plus one round trip through the shell: after this, a typed line
// is read by the shell rather than dropped or eaten by its startup.
export async function waitForShell(page: Page, paneIndex = 0): Promise<Locator> {
  const host = await waitForTerminalReady(page, paneIndex);
  const nonce = `${process.pid}-${++sentinelSerial}-${Date.now().toString(36)}`;
  // printf assembles the marker, so the echoed command line cannot match.
  await typeInTerminal(page, `printf 'uatu-ready-%s\\n' ${nonce}`, paneIndex);
  await expect(host).toContainText(`uatu-ready-${nonce}`);
  return host;
}

// Opens the panel when it is hidden and waits for the first pane's shell.
// `shell: false` stops at attach readiness, for tests that must not type.
export async function openTerminal(page: Page, options: { shell?: boolean } = {}): Promise<Locator> {
  if (await page.locator("#terminal-panel").isHidden()) {
    await page.locator("#terminal-toggle").click();
  }
  return options.shell === false ? waitForTerminalReady(page) : waitForShell(page);
}

// A file the shell polls for, so a test decides when delayed PTY output is
// printed instead of racing a `sleep` against the page. It lives in a fresh
// directory under /tmp (the PTY backend is POSIX-only): outside the watched
// workspace, and a short path, since the command carrying it is typed key by
// key (macOS's per-user os.tmpdir() alone is ~50 characters). Call
// `removeTerminalGates()` from an afterEach.
const gateDirectories: string[] = [];
export async function terminalGate(): Promise<{ shellWait: string; open: () => Promise<void> }> {
  const directory = await fs.mkdtemp("/tmp/uatu-gate-");
  gateDirectories.push(directory);
  const gatePath = path.join(directory, "open");
  return {
    shellWait: `while [ ! -e '${gatePath}' ]; do sleep 0.1; done`,
    open: () => fs.writeFile(gatePath, "", "utf8"),
  };
}

export async function removeTerminalGates(): Promise<void> {
  for (const directory of gateDirectories.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true });
  }
}
