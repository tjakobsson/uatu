import { test, expect } from "./worktree-demo-fixtures";
import { captureScreenshot, recordEvidence, saveEvidence } from "./evidence";

// One intentional desktop review sequence; its index and images share one output
// directory, so opening or copying that directory needs no server or external assets.
test("desktop worktree review gallery", async ({ page, browser, demoOrigin }, info) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ colorScheme: "light" });
  const pageErrors: string[] = []; page.on("pageerror", error => pageErrors.push(error.message));
  const shots: { file: string; title: string; caption: string }[] = [];
  const shot = async (name: string, title: string, caption = "Ephemeral simulation, actual browser UI. No real Git or workspace process is used.", target = page, fullPage = false) => {
    const file = `${String(shots.length + 1).padStart(2, "0")}-${name}`;
    if (fullPage) { await target.evaluate(() => document.fonts.ready); await target.screenshot({ path: info.outputPath(`${file}.png`), fullPage: true, animations: "disabled" }); await recordEvidence(info, info.outputPath(`${file}.png`)); }
    else await captureScreenshot(target, info, file);
    shots.push({ file: `${file}.png`, title, caption });
  };
  const reset = async (scenario = "populated", latency = "0") => {
    await page.goto("/");
    await page.request.post("/__demo/reset", { form: { scenario, latency } });
    await page.goto("/s/atlas/");
    await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");
    await expect(page.locator("html")).toHaveAttribute("data-ui-mode", "desktop");
    await expect(page.locator("#preview")).toContainText("Atlas workspace");
  };
  const inventory = async () => {
    await page.getByText("SIMULATION · scenarios and reset", { exact: true }).click();
    await page.getByRole("button", { name: "Review simulated inventory / recovery / folder safety" }).click();
    await expect(page.getByRole("heading", { name: "Repository worktrees", exact: true })).toBeVisible();
  };
  const fork = async (entry = "selector", mode = "Existing branch") => {
    if (entry === "dashboard") await page.goto("/");
    else await page.locator("#hub-toggle").click();
    await page.getByRole("button", { name: "Add worktree to Atlas", exact: true }).click();
    await page.getByRole("menuitem", { name: mode, exact: true }).click();
  };
  const create = async () => {
    await page.getByRole("link", { name: "Create worktree", exact: true }).click();
    await page.getByLabel("Name", { exact: true }).fill("feature/checkout");
    await page.getByRole("button", { name: "Create", exact: true }).click();
  };
  const child = () => page.locator('[data-workspace="atlas-sidebar"]');
  const created = async () => {
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.locator('[data-worktree-confirmation]')).toContainText(/Created |Registered /);
    await expect(page.getByRole("heading", { name: /Worktree ready|Details/ })).toHaveCount(0);
  };

  // Selected Active groups, collapsed by default. Touch is browser emulation only.
  for (const touch of [false, true]) {
    const context = await browser.newContext({ baseURL: demoOrigin, viewport: touch ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, hasTouch: touch, isMobile: touch, colorScheme: "light" });
    const comparison = await context.newPage();
    for (const scenario of ["mixed-lifecycle", "all-stopped"]) {
      await comparison.request.post("/__demo/reset", { form: { scenario } });
      const state = await comparison.request.get("/__demo/ledger").then(r => r.json());
      {
        await comparison.goto("/");
        await expect(comparison.getByRole("heading", { name: "Active", exact: true })).toBeVisible();
        expect((await comparison.request.get("/__demo/ledger").then(r => r.json())).rows).toEqual(state.rows);
        await shot(`active-groups-${touch ? "touch" : "desktop"}-${scenario}`, `Active groups · ${scenario} · ${touch ? "touch" : "desktop"}`, "Selected layout. Main is a separate checkout; configuration ownership does not require main to run. Full-page capture; touch uses Chromium emulation, not native verification. Final UX gate remains open.", comparison, true);
      }
    }
    await context.close();
  }
  await reset();
  // Include explicit remote provenance and unknown provenance, not invented origins.
  await page.request.post("/worktrees/create", { form: { mode: "existing", selection: "remote:origin/feature/search" } });
  await page.goto("/");
  await page.locator('[data-disclosure="atlas-stopped"] > summary').click();
  await expect(child()).toBeVisible();
  await shot("dashboard", "01 · Original Hub dashboard", "Grouped parents and child branches, truthful main / remote / unknown provenance, paths, status and original row actions. Only parents offer Configure and fork.");
  await page.emulateMedia({ colorScheme: "dark" });
  await shot("dashboard-dark", "Original dashboard · dark");
  await page.emulateMedia({ colorScheme: "light" });
  for (const entry of ["dashboard", "selector"]) {
    if (entry === "selector") {
      await page.goto("/s/atlas/");
      await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");
      await page.locator("#hub-toggle").click();
      await shot("workspace-selector", "02 · Actual workspace selector", "Grouped switching and parent forks, secondary branch provenance; no Details or global worktree action.");
    }
    await page.getByRole("button", { name: "Add worktree to Atlas", exact: true }).click();
    await shot(`${entry}-fork-menu`, `${entry} · exactly two fork options`);
    await page.emulateMedia({ colorScheme: "dark" });
    await shot(`${entry}-fork-menu-dark`, `${entry} fork menu · dark`);
    await page.emulateMedia({ colorScheme: "light" });
    await page.getByRole("menuitem", { name: "New branch / worktree", exact: true }).click();
    await page.getByLabel("Name", { exact: true }).fill("feature/login");
    await shot(`${entry}-new-name`, `${entry} · one-field new worktree form`, "Name only, Create and Cancel. No destination/base/configuration readouts in the compact form.");
     await page.getByRole("button", { name: "Create", exact: true }).click();
     await created();
     await shot(`${entry}-created-closed`, `${entry} · creation closes the popup`, "Small Created feature/login confirmation with explicit Open. Source stays selected; the new workspace remains stopped and lists refresh without a Details screen.");
     if (entry === "dashboard") {
       await expect(page.locator('[data-workspace="atlas-created-2"]')).toBeVisible();
       await page.request.post("/__demo/reset", { form: { scenario: "populated" } });
     }
  }
  await reset(); await fork();
  const search = page.getByRole("combobox", { name: "Branch", exact: true });
  const fetchButton = page.getByRole("button", { name: "Fetch remote branches", exact: true });
  await expect(page.getByRole("dialog").getByRole("option")).toHaveCount(8);
  await shot("cached-refs", "03 · Existing local and remote branches", "Cached list appears without fetching. Local/Remote badges and full refs distinguish same-name branches.");
  await search.fill("rls");
  await expect(page.getByRole("dialog").getByRole("option")).toHaveCount(3);
  await shot("fuzzy-filter", "Fuzzy filtering · rls → three release refs");
  await page.getByRole("option", { name: "origin/release Remote", exact: true }).click();
  await expect(search).toHaveValue("origin/release");
  await shot("picked-ref", "Picked ref becomes the editable input", "Exact origin/release committed; Create enabled. Enter selects, not submits.");
  await search.click();
  await page.emulateMedia({ colorScheme: "dark" });
  await shot("picked-ref-dark", "Selected ref and full list · dark");
  await page.emulateMedia({ colorScheme: "light" });
  await search.fill("no-such-branch");
  await expect(page.getByRole("button", { name: "Create", exact: true })).toBeDisabled();
  await shot("edited-empty", "Editing invalidates selection · no matches", "No stale ref can be submitted; Create is disabled until a valid option is picked.");
  for (const scenario of ["fetch-auth", "fetch-network", "fetch-disappearance"]) {
    await reset(scenario, "900"); await fork();
    if (scenario === "fetch-disappearance") await page.getByRole("option", { name: "origin/feature/search Remote", exact: true }).click();
    await fetchButton.click();
    if (scenario === "fetch-auth") {
      await expect(page.locator("#operation-status")).toContainText("Fetching");
      await shot("fetch-loading", "04 · Explicit fetch in progress");
    }
    await expect(page.getByRole("alert")).toBeVisible();
    await shot(scenario, scenario === "fetch-disappearance" ? "Selected remote disappeared · no substitute" : `Explicit fetch · ${scenario === "fetch-auth" ? "authentication" : "network"} error`);
    if (scenario === "fetch-disappearance") {
      await expect(page.getByRole("button", { name: "Create", exact: true })).toBeDisabled();
    } else {
      await fetchButton.click();
      await expect(page.getByRole("option", { name: "origin/fetched Remote" })).toBeVisible();
      if (scenario === "fetch-auth") await shot("fetch-success", "Fetch retry succeeds · origin/fetched added");
    }
  }

  await reset();
  await page.locator('[data-item-path="NOTES.md"]').click();
  await expect(page.locator("#preview")).toContainText("Atlas notes");
  if (await page.locator("#chat-expand").isVisible()) await page.locator("#chat-expand").click();
  await page.locator("#chat-conversation-select").selectOption("demo-atlas:conversation-1");
  if (!await page.locator(".terminal-pane").first().isVisible()) await page.locator("#terminal-toggle").click();
  await expect(page.locator('[data-terminal-ready="true"]').first()).toBeVisible();
  await shot("source-context", "05 · Source workspace · notes, terminal and Planning chat");
  await fork("selector", "New branch / worktree");
  await page.getByLabel("Name", { exact: true }).fill("feature/checkout");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await created();
  await shot("created-source", "Creation closes · source context remains selected", "Small Created feature/checkout confirmation; explicit Open starts the stopped child then navigates. No Details or inventory popup.");
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await expect(page).toHaveURL(/\/s\/atlas-created-1\//);
  await expect(page.locator("#preview")).toContainText("feature/checkout workspace");
  if (await page.locator("#chat-expand").isVisible()) await page.locator("#chat-expand").click();
  await page.locator("#chat-conversation-select").selectOption("demo-atlas-created-1:conversation-2");
  if (!await page.locator(".terminal-pane").first().isVisible()) await page.locator("#terminal-toggle").click();
  await expect(page.locator('[data-terminal-ready="true"]').first()).toBeVisible();
  await expect(page.locator("#chat-items")).toContainText("belongs to atlas-created-1 only");
  await shot("child-context", "Started child · independent preview, terminal and chat");
  await page.goBack();
  await expect(page.locator("#preview")).toContainText("Atlas notes");
  await expect(page.locator("#chat-conversation-select")).toHaveValue("demo-atlas:conversation-1");
  await shot("return-context", "Return to Atlas · source context restored");
  await page.goto("/");
  await page.locator('[data-repository="atlas"] .dashboard-group-heading').getByRole("button", { name: "Configure", exact: true }).click();
  await page.getByLabel("Parent authentication").selectOption("none");
  await page.getByLabel("Parent signing").selectOption("demo-signing");
  await page.getByRole("combobox", { name: "Shared workspace configuration", exact: true }).selectOption("review");
  await shot("parent-configure", "06 · Parent-only shared policy configuration");
  await page.getByRole("button", { name: "Save parent settings" }).click();
  await page.goto("/");
  await expect(page.locator('[data-workspace="atlas-created-1"]')).toContainText("demo-signing");
  await shot("inherited-policy", "Child rows inherit live parent policy", "No child Configure or independent name. Synthetic policy does not copy runtime state.");

  for (const scenario of ["branch-conflict", "path-conflict", "checked-out", "registration-failure", "start-failure"]) {
    await reset(scenario); await inventory(); await create();
    if (scenario === "start-failure") { await created(); await page.getByRole("button", { name: "Open", exact: true }).click(); }
    await expect(page.getByRole("alert")).toBeVisible();
    await shot(scenario, `07 · Creation safety / recovery · ${scenario}`);
    if (scenario === "registration-failure") {
      await page.getByRole("button", { name: "Retry registration" }).click();
      await created();
      await shot("registration-recovered", "Retry registration closes · same retained checkout", "No duplicate checkout; small Created confirmation offers explicit Open without a details popup.");
    }
    if (scenario === "checked-out") {
      await page.getByRole("link", { name: "Open", exact: true }).click();
      await expect(page.locator("#preview")).toContainText("Atlas workspace");
      await shot("checked-out-open", "Existing checkout · Open instead of duplicate creation");
    }
  }
  await reset("discovery"); await inventory();
  await page.getByRole("button", { name: "Refresh inventory" }).click();
  await expect(page.locator('[data-workspace="atlas-agent"]')).toBeVisible();
  await shot("external-discovery", "08 · External checkout discovered · not auto-registered");
  await page.locator('[data-workspace="atlas-agent"]').getByRole("link", { name: "Register workspace" }).click();
  await shot("external-register", "External checkout · explicit registration");
    await page.getByRole("button", { name: "Register workspace", exact: true }).click();
    await created();
  await shot("external-registered", "External registration succeeds · ownership retained");
  for (const scenario of ["missing", "replaced", "loading", "inventory-error", "empty"]) {
    await reset(scenario); await inventory();
    await shot(`inventory-${scenario}`, `Inventory · ${scenario}`, "Test-review inventory surface. Missing/replaced paths never trigger silent recreation or adoption; refresh and errors are explicit.");
  }
  for (const scenario of ["populated", "running", "dirty", "untracked", "ignored", "locked", "in-use", "nested", "stop-failure"]) {
    await reset(scenario === "running" ? "populated" : scenario);
    if (scenario === "running") await page.request.post("/api/hub/sessions/atlas-sidebar/start");
    await inventory();
    await child().getByRole("link", { name: "Delete worktree", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Delete worktree?", exact: true });
    await expect(dialog).toContainText("Atlas / feature/sidebar");
    await expect(dialog.locator("dd, input[type=checkbox]")).toHaveCount(0);
    if (["populated", "running"].includes(scenario)) await shot(`delete-confirm-${scenario}`, `09 · ${scenario === "running" ? "Running" : "Stopped"} worktree · compact deletion`, "Parent / branch, exact consequences, Cancel and Delete or Stop and delete. No metadata, extra checkbox or simulation banner in the dialog. Git branch stays.");
    if (["populated", "running", "stop-failure"].includes(scenario)) await dialog.getByRole("button", { name: scenario === "populated" ? "Delete" : "Stop and delete", exact: true }).click();
    if (["populated", "running"].includes(scenario)) { await expect(page.getByRole("dialog")).toHaveCount(0); await expect(page.locator('[data-worktree-confirmation]')).toContainText("Branch kept"); }
    else await expect(page.getByRole("alert")).toContainText(/retain/i);
    await shot(`delete-${scenario}`, ["populated", "running"].includes(scenario) ? "Deletion closes · branch preserved" : `Compact deletion blocker · ${scenario}`);
  }
  await reset(); await inventory();
  await page.locator('[data-workspace="atlas-review"]').getByRole("link", { name: "Rename folder", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Stopping does not make this move safe");
  await shot("folder-safety", "10 · Folder rename dependency guard");
  await page.getByRole("link", { name: "Back to worktrees" }).click();
  await page.locator('[data-workspace="atlas-review"]').getByRole("link", { name: "Remove from Uatu", exact: true }).click();
  await shot("forget-confirm", "Remove from Uatu · unregister only", "Stops Uatu activity and removes registration; checkout, branch and provenance remain.");
  await page.getByLabel("Stop Uatu activity and remove").check();
  await page.getByRole("button", { name: "Remove from Uatu", exact: true }).click();
  await shot("forget-success", "Unregistered · checkout remains discoverable");
  await reset();
  await page.getByText("SIMULATION · scenarios and reset", { exact: true }).click();
  await shot("demo-controls", "Appendix · visible scenario and reset controls", "Reviewer controls are simulation-only. Reset discards ephemeral contexts and fences old events/history.");
  await page.goto("/clone");
  await shot("secondary-entry", "Appendix · secondary onboarding entry");

  // Opt-in verification of already-running reviewer endpoints. Never change
  // proxy routes or launch another service. Origins are explicitly supplied by
  // the operator; each endpoint is the same ephemeral mock, reset after review.
  const servedOrigins = (process.env.UATU_WORKTREE_REVIEW_ORIGINS ?? "").split(",").filter(Boolean);
  for (const [index, origin] of servedOrigins.entries()) {
    if (new URL(origin).origin !== origin) throw new Error("Review endpoints must be exact origins");
    const resetServed = async (scenario = "populated") => {
      await page.goto(`${origin}/`);
      const response = await page.request.post(`${origin}/__demo/reset`, { form: { scenario, latency: "0" }, headers: { Origin: origin } });
      expect(response.ok()).toBe(true);
    };
    await page.setViewportSize({ width: 1440, height: 1000 });
    await resetServed("mixed-lifecycle");
    const comparisonState = await page.request.get(`${origin}/__demo/ledger`).then(r => r.json());
    {
      await page.goto(`${origin}/`);
      await expect(page.getByRole("heading", { name: "Active", exact: true })).toBeVisible();
      expect((await page.request.get(`${origin}/__demo/ledger`).then(r => r.json())).rows).toEqual(comparisonState.rows);
      await shot(`served-${index}-active-groups`, `Served ${index + 1} · Active groups`, `Actual updated dashboard at ${origin}; main stopped and child running. Selected layout, final UX gate open.`, page, true);
    }
    await resetServed();
    await page.goto(`${origin}/s/atlas/`);
    await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");
    const source = page.url();
    await page.locator("#hub-toggle").click();
    await page.getByRole("button", { name: "Add worktree to Atlas", exact: true }).click();
    await page.getByRole("menuitem", { name: "New branch / worktree", exact: true }).click();
    await page.getByLabel("Name", { exact: true }).fill("feature/served-review");
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await created(); expect(page.url()).toBe(source);
    const state = await page.request.get(`${origin}/__demo/ledger`).then(response => response.json());
    expect(state.rows.at(-1).running).toBe(false);
    await shot(`served-${index}-spa-created`, `Served ${index + 1} · SPA creation closes`, `Actual updated bundle at ${origin}. Source remains selected; Created feature/served-review offers explicit Open. Simulation only.`);
    await page.getByRole("button", { name: "Open", exact: true }).click();
    await expect(page).toHaveURL(/\/s\/atlas-created-1\//);
    await expect(page.locator("#preview")).toContainText("feature/served-review workspace");
    await shot(`served-${index}-explicit-open`, `Served ${index + 1} · explicit Open changes context`, `Actual updated bundle at ${origin}; no switch happened until Open was activated.`);
    await resetServed(); await page.reload();
    await page.getByRole("button", { name: "Add worktree to Atlas", exact: true }).click();
    await page.getByRole("menuitem", { name: "Existing branch", exact: true }).click();
    await page.getByRole("option", { name: "fix/navigation Local", exact: true }).click();
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await created();
    await page.locator('[data-disclosure="atlas-stopped"] > summary').click();
    await expect(page.locator('[data-workspace="atlas-created-1"]')).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/");
    await shot(`served-${index}-dashboard-created`, `Served ${index + 1} · dashboard refreshed`, `Actual updated dashboard at ${origin}. Creation closed; stopped row appeared without navigation or Details.`);
    await page.setViewportSize({ width: 390, height: 844 });
    for (const scenario of ["populated", "running", "stop-failure", "dirty"]) {
      await resetServed(scenario === "running" ? "populated" : scenario);
      if (scenario === "running") await page.request.post(`${origin}/api/hub/sessions/atlas-sidebar/start`, { headers: { Origin: origin } });
      await page.reload();
      if (scenario === "populated" || scenario === "dirty") await page.locator('[data-disclosure="atlas-stopped"] > summary').click();
      await child().getByRole("button", { name: "Delete worktree", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Delete worktree?", exact: true });
      await expect(dialog).toContainText("Atlas / feature/sidebar");
      await expect(dialog).not.toContainText("/demo/"); await expect(dialog).not.toContainText("SIMULATION");
      await expect(dialog.locator("dd, input[type=checkbox]")).toHaveCount(0);
      if (scenario === "stop-failure") await dialog.getByRole("button", { name: "Stop and delete", exact: true }).click();
      if (scenario === "dirty" || scenario === "stop-failure") { await expect(dialog.getByRole("alert")).toContainText(/retained/i); await expect(dialog.getByRole("button", { name: /^(Delete|Stop and delete)$/ })).toHaveCount(0); }
      else await expect(dialog.getByRole("button", { name: scenario === "running" ? "Stop and delete" : "Delete", exact: true })).toBeVisible();
      expect(await dialog.evaluate(node => node.scrollHeight <= node.clientHeight && node.scrollWidth <= node.clientWidth)).toBe(true);
      const bounds = await dialog.boundingBox(); expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(844);
      await shot(`served-${index}-phone-delete-${scenario}`, `Served ${index + 1} · phone deletion · ${scenario}`, `Actual bundle at ${origin}, 390 × 844 Chromium viewport (not native touch verification). Compact identity and consequences/blocker; no dialog scrolling or metadata dump.`);
      if (scenario === "populated" || scenario === "running") { await dialog.getByRole("button", { name: scenario === "running" ? "Stop and delete" : "Delete", exact: true }).click(); await expect(page.getByRole("dialog")).toHaveCount(0); await expect(child()).toHaveCount(0); }
    }
    await resetServed("registration-failure"); await page.reload();
    await page.getByRole("button", { name: "Add worktree to Atlas", exact: true }).click();
    await page.getByRole("menuitem", { name: "New branch / worktree", exact: true }).click();
    await page.getByLabel("Name", { exact: true }).fill("feature/retained-review");
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("checkout and branch are retained");
    await expect(page.getByRole("dialog").locator("dd")).toHaveCount(0);
    await shot(`served-${index}-phone-registration-retry`, `Served ${index + 1} · compact retained-checkout retry`, `Actual bundle at ${origin}. Same-checkout Retry registration, no paths, internal IDs or metadata dump.`);
    await page.getByRole("button", { name: "Retry registration", exact: true }).click(); await created();
    await resetServed();
  }

  const escape = (value: string) => value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
  expect(pageErrors).toEqual([]);
  await saveEvidence(info, "gallery.json", JSON.stringify({ desktop: true, viewport: "1440 × 1000; optional served phone appendix 390 × 844", simulation: true, servedOrigins, shots }, null, 2));
   const comparisonLinks = `<h2>Selected: Active groups</h2><p>The user selected Active groups. First four images show mixed/main-stopped-child-running and all-stopped scenarios on desktop and touch. This layout decision does not approve real integration or complete UX gate 2.2.</p><p>${(servedOrigins.length ? servedOrigins : ["http://127.0.0.1:4788"]).map(origin => `<a href="${escape(origin)}/">Live dashboard · ${escape(origin)}</a>`).join("<br>")}</p>`;
  await saveEvidence(info, "index.html", `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Worktree Active groups review gallery</title><style>body{font:16px/1.6 system-ui;margin:0;background:#eef1f5;color:#18202a}header,nav,main{max-width:1440px;margin:auto;padding:24px}header{padding-bottom:0}nav{columns:3}a{color:#155eac}figure{margin:0 0 40px;background:white;border:1px solid #ccd3dd;border-radius:10px;overflow:hidden}figcaption{padding:20px}h2{margin:0;font-size:21px}p{margin:8px 0}img{display:block;width:100%;height:auto;border-top:1px solid #ccd3dd}@media(max-width:850px){nav{columns:1}}</style><header><h1>Worktree · Active groups review gallery</h1>${comparisonLinks}<p><strong>${shots.length} intentional screenshots · Chromium · 1440 × 1000 desktop and 390 × 844 touch emulation · light primary, dark core interactions.</strong></p><p>Actual frontend against ephemeral mock services. UX approval remains open. No real Git, filesystems, credentials, PTYs, provider sessions, persistence or native macOS verification. Safety messages demonstrate the proposed UI, not production safety guarantees.</p><p>Click any screenshot to view full resolution. This self-contained directory can be copied; no network resources or server required. Later Playwright runs may replace test-results.</p></header><nav>${shots.map((shot, i) => `<a href="#shot-${i}">${escape(shot.title)}</a><br>`).join("")}</nav><main>${shots.map((shot, i) => `<figure id="shot-${i}"><figcaption><h2>${escape(shot.title)}</h2><p>${escape(shot.caption)}</p><a href="#">Back to contents</a> · <a href="${shot.file}">Full resolution</a></figcaption><a href="${shot.file}"><img loading="lazy" src="${shot.file}" alt="${escape(shot.title)}"></a></figure>`).join("")}</main></html>`);
  await saveEvidence(info, "README.md", `# Worktree desktop review gallery\n\nOpen [index.html](index.html) for the captioned visual review. ${shots.length} screenshots; desktop Chromium, 1440 × 1000, light primary with dark core interactions.${servedOrigins.length ? " Includes an actual-served-bundle appendix with 390 × 844 phone viewport screenshots (not native touch verification)." : ""}\n\nMock only: not proof of real Git/filesystem/process/provider safety or native macOS behavior. No product integration approval implied.\n\n${shots.map(shot => `- [${shot.title}](${shot.file}) — ${shot.caption}`).join("\n")}\n`);
});
