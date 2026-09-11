import { chromium } from "@playwright/test";
import assert from "node:assert/strict";

// One fresh installed Chromium page, no server, credentials, persistent profile, or
// network. Intentionally RED until editor entry stops focusing form controls.
const build = await Bun.build({ entrypoints: ["src/hub/mobile/task-view.ts"], target: "browser" });
if (!build.success) throw new Error(String(build.logs));
const source = await build.outputs[0]!.text();
const browser = await chromium.launch({ headless: true, timeout: 15000 });
try {
  const page = await browser.newPage();
  await page.route("**/*", route => route.abort());
  await page.setContent('<main id="host"></main>');
  const result = await page.evaluate(async (source) => {
    const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    try {
      const { createTaskView } = await import(url);
      let changes = 0, commits = 0;
      document.addEventListener("change", () => changes++);
      const view = createTaskView(document.querySelector("#host"), () => true, () => {});
      view.open("Edit workspace credentials", '<label>Git authentication<select name="authentication"><option value="">Do not change</option><option value="synthetic">Audit key</option></select></label><label>Authentication host<input name="host"></label>', { label: "Review", run() { commits++; } });
      return { activeTag: document.activeElement?.tagName, activeName: document.activeElement?.getAttribute("name"), changes, commits };
    } finally { URL.revokeObjectURL(url); }
  }, source);
  console.log(JSON.stringify(result));
  assert.equal(result.changes, 0);
  assert.equal(result.commits, 0);
  assert.ok(!["INPUT", "SELECT", "TEXTAREA"].includes(result.activeTag ?? ""), "Editor entry must not focus an input/select/textarea");
} finally { await browser.close(); }
