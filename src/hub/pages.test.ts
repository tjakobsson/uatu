import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";

import { LOCAL_CREDENTIAL_ASSIGNMENT_WARNING } from "./credential-context";
import { clonePage, dashboardPage, loginPage, settingsPage, stoppedSessionPage } from "./pages";

const htmlFor = {
  dashboard: () => dashboardPage("alice"),
  clone: () => clonePage("alice"),
  settings: () => settingsPage("alice"),
};

function documentFor(page: keyof typeof htmlFor) {
  return parseHTML(htmlFor[page]()).document;
}

function clientScript(html: string): string {
  const start = html.indexOf("<script>");
  const end = html.lastIndexOf("</script>");
  return start >= 0 && end > start ? html.slice(start + "<script>".length, end) : "";
}

function folderMutationFunction(html: string) {
  const script = clientScript(html);
  const start = script.indexOf("async function requestFolderMutation");
  const end = script.indexOf("async function refreshAfterFolderMutation", start);
  const source = script.slice(start, end);
  return (api: (path: string, body: Record<string, unknown>) => Promise<unknown>, confirm: (message: string) => boolean) =>
    new Function("api", "confirm", `${source}\nreturn requestFolderMutation;`)(api, confirm) as (
      path: string,
      body: Record<string, unknown>,
    ) => Promise<unknown>;
}

describe("authenticated Hub pages", () => {
  test("share navigation and have syntactically valid page-scoped initialization", () => {
    for (const pageName of ["dashboard", "clone", "settings"] as const) {
      const html = htmlFor[pageName]();
      expect(html).toContain(`data-hub-page="${pageName}"`);
      expect(html).toContain('href="/"');
      expect(html).toContain("Dashboard</a>");
      expect(html).toContain('href="/clone"');
      expect(html).toContain('href="/settings"');
      expect(html).toContain('action="/logout"');
      expect(() => new Function(clientScript(html))).not.toThrow();
    }
    expect(htmlFor.dashboard()).toContain('href="/" aria-current="page"');
    expect(htmlFor.clone()).toContain('href="/clone" aria-current="page"');
    expect(htmlFor.settings()).toContain('href="/settings" aria-current="page"');
  });

  test("keeps moved sections out of the dashboard DOM", () => {
    const document = documentFor("dashboard");
    expect(document.getElementById("sessions")).not.toBeNull();
    expect(document.getElementById("workspaces")).not.toBeNull();
    for (const id of ["browser", "clone-form", "credentials-pane", "credential-tools", "devices"]) {
      expect(document.getElementById(id)).toBeNull();
    }
  });

  test("shows neutral credential summaries and confirms only an unassigned resume", () => {
    const html = htmlFor.dashboard();
    const refreshBody = html.slice(html.indexOf("async function refresh(force)"), html.indexOf("async function loadDevices()"));
    expect(html).toContain('return parts.join(" · ") || "⊘ No credentials assigned"');
    expect(html).toContain('parts.push("🔑 Auth: " + authentication.join(", "))');
    expect(html).toContain('parts.push("✎ Signing: " + signing.join(", "))');
    expect(html).toContain("if (!hasCredentialAssignments(w.credentialAssignments) && !confirm(");
    expect(html).toContain("Git authentication and commit signing may be unavailable, but the workspace can still start. Continue?");
    const startFlow = html.indexOf("async function startRegisteredWorkspace");
    expect(startFlow).toBeGreaterThan(0);
    expect(html.indexOf("if (!hasCredentialAssignments(w.credentialAssignments)", startFlow)).toBeLessThan(html.indexOf("uiBusy += 1", startFlow));
    expect(html).toContain("prepareWorkspaceResume(w, target)");
    expect(html).toContain('label: "Start"');
    expect(html).toContain('label: "Rename workspace"');
    expect(html).toContain('label: "Remove from Hub"');
    expect(html).not.toContain('label: "Resume"');
    expect(html).not.toContain('label: "Forget"');
    // Rows title by mutable display name with the path as secondary detail.
    expect(html).toContain("title: workspaceLabel(w)");
    expect(html).toContain('"/display-name", { displayName: next }');
    expect(html).toContain("Unlock credentials for ");
    expect(html).toContain("Unlock and resume");
    expect(html).toContain('field.credential.id) + "/unlock"');
    expect(refreshBody).not.toContain("renderCredentialCatalog()");
  });
});

describe("clone page", () => {
  test("renders folder registration and prompt-capable clone controls", () => {
    const html = htmlFor.clone();
    const document = documentFor("clone");
    for (const id of ["browser", "clone-form", "clone-panel", "clone-output", "clone-response", "clone-cancel", "clone-folder-name"]) {
      expect(document.getElementById(id)).not.toBeNull();
    }
    expect(document.querySelector('#clone-response[type="password"]')).not.toBeNull();
    expect(html).toContain("folderNameInput.value.trim()");
    expect(html).toContain("{ url, dest: browsePath, folderName, start: cloneStartAfter.checked }");
    // Start after clone is explicit and defaults off; stopped completion is the norm.
    expect(document.querySelector("#clone-start-after[type=checkbox]")?.hasAttribute("checked")).toBe(false);
    expect(html).toContain("Workspace added. Start it from its folder row or the dashboard.");
    expect(html).toContain("if (workspaceId && result.running !== false) {");
    expect(html).toContain("Available for any Git or SSH prompt");
  });

  test("fetches credentials independently and preserves clone reconnect behavior", () => {
    const html = htmlFor.clone();
    expect(html).toContain("async function loadCloneCredentials()");
    expect(html).toContain("const response = await fetch(credentialPath)");
    expect(html).not.toContain("updateCloneCredentials();\n}");
    expect(html).toContain('api("/api/hub/clone-jobs"');
    expect(html).toContain('new EventSource("/api/hub/clone-jobs/"');
    expect(html).toContain("sessionStorage.getItem(cloneJobStorageKey)");
    expect(html).toContain('{ method: "HEAD" }');
    expect(html).toContain('events.addEventListener("output"');
    expect(html).toContain('events.addEventListener("phase"');
    expect(html).toContain('events.addEventListener("result"');
    expect(html).toContain("cloneOutput.textContent += text");
    expect(html).toContain('window.addEventListener("pageshow"');
    expect(html).toContain("uiBusy = cloneJobId ? 1 : 0;");
    expect(html).toContain("if (cloneJobId) connectCloneEvents();");
  });

  test("preserves credential selection, masked unlock, retention, and shared-UID warning", () => {
    const html = htmlFor.clone();
    const document = documentFor("clone");
    const select = document.getElementById("clone-credential") as HTMLSelectElement;
    expect(select.options[0]?.value).toBe("");
    expect(select.options[0]?.textContent).toContain("answer prompts interactively");
    expect(document.querySelector('#clone-unlock-passphrase[type="password"]')).not.toBeNull();
    expect((document.getElementById("clone-retained-auth") as HTMLSelectElement).options[0]?.textContent).toBe("None");
    expect(document.querySelector("[data-shared-uid-warning] span")?.textContent).toBe(LOCAL_CREDENTIAL_ASSIGNMENT_WARNING);
    expect(document.querySelector("[data-dismiss-shared-uid]")).not.toBeNull();
    expect(html).toContain("uatu.hub.notice.shared-uid-v1:YWxpY2U");
    expect(html).toContain("cloneCompatible");
    expect(html).toContain("isCredentialLocked(selectedCredential)");
    expect(html).toContain("request.credentialId = selectedCredential.id");
    // A requested start must not be doomed by locked retained or signing
    // credentials: they go through the masked dialog before the job is
    // created, with the already-unlocked clone credential excluded.
    expect(html).toContain("Unlock credentials to start after clone");
    expect(html).toContain('"Unlock and clone"');
    expect(html).toContain("item.id !== selectedCredential.id");
    // The clone identity is never an implicit workspace grant: nothing
    // pre-fills the retained control, so an untouched form retains nothing.
    expect(html).toContain("The clone credential is never retained on its own");
    expect(html).toContain("NEVER pre-fills this control");
    expect(html).not.toContain("cloneRetainedAuth.value = selected");
    expect(html).toContain("request.retainedAuthentication = [{ credentialId: retainedCredential.id, host: retainedHostFor(retainedCredential) }]");
    expect(html).not.toContain("retainAssignment");
    expect(html).toContain('(?:[^@/:\\s]+@)?');
    expect(html).toContain('value.startsWith("git+ssh://")');
    // HTTPS hosts are normalized like the backend before token matching.
    expect(html).toContain('parsed.hostname.endsWith(".")');
    expect(html).not.toContain("at > 0");
  });

  test("renders accessible folder management controls and a prefilled rename dialog", () => {
    const html = htmlFor.clone();
    const document = documentFor("clone");
    for (const id of [
      "new-folder-form",
      "new-folder-name",
      "new-folder-error",
      "browser-error",
      "rename-folder-dialog",
      "rename-folder-form",
      "rename-folder-name",
      "rename-folder-error",
      "rename-folder-cancel",
      "rename-folder-submit",
    ]) {
      expect(document.getElementById(id)).not.toBeNull();
    }
    expect(document.querySelector('#new-folder-name[aria-label="New folder name"]')).not.toBeNull();
    expect(document.querySelector('#rename-folder-dialog[aria-labelledby="rename-folder-title"]')).not.toBeNull();
    expect(document.querySelectorAll('[role="alert"]').length).toBeGreaterThanOrEqual(4);
    expect(html).toContain('input.value = name;');
    expect(html).toContain('input.select();');
    expect(html).toContain('ariaLabel: "Rename folder " + dir.name');
    expect(html).toContain('ariaLabel: "Remove folder " + dir.name');
    expect(html).toContain('Only empty folders can be removed. This cannot be undone.');
  });

  test("posts closed folder payloads and refreshes browser and workspace state", () => {
    const html = htmlFor.clone();
    expect(html).toContain('api("/api/hub/folders/create", { parent: browsePath, name })');
    expect(html).toContain('requestFolderMutation("/api/hub/folders/rename", { path: rename.folder, name })');
    expect(html).toContain('requestFolderMutation("/api/hub/folders/remove", { path: folder })');
    expect(html).toContain('loadBrowser({ fallbackToParent: true })');
    expect(html).toContain('refreshWorkspaceState().catch(() => {})');
    expect(html).toContain('response.status === 404 && browseParent');
    expect(html).toContain("another client may have renamed or removed it");
    // A configured-but-unavailable default parent silently falls back to
    // home; the page must say so before the user onboards into home.
    expect(html).toContain('id="defaults-fallback-notice"');
    expect(html).toContain("updateDefaultsFallbackNotice(state.workspaceDefaults)");
    expect(html).toContain("is currently unavailable — showing ");
    // Folder names may legitimately carry whitespace (the rename field is
    // even pre-filled with the current basename); only emptiness is judged
    // trimmed and the submitted name keeps its whitespace.
    expect(html).toContain("const name = renameFolderName.value;");
    expect(html).toContain("const name = newFolderName.value;");
    expect(html).toContain("if (!name.trim()) return;");
    expect(html).not.toContain("renameFolderName.value.trim()");
    expect(html).not.toContain("newFolderName.value.trim()");
  });

  test("retries needsStop with named workspace confirmation and stop authorization", async () => {
    const calls: { path: string; body: Record<string, unknown> }[] = [];
    const confirmations: string[] = [];
    const conflict = Object.assign(new Error("workspaces are running"), {
      payload: { needsStop: true, workspaceIds: ["alpha", "nested-beta"] },
    });
    const api = async (path: string, body: Record<string, unknown>) => {
      calls.push({ path, body });
      if (calls.length === 1) throw conflict;
      return { path: "/work/team" };
    };
    const mutate = folderMutationFunction(htmlFor.clone())(api, message => {
      confirmations.push(message);
      return true;
    });

    await expect(mutate("/api/hub/folders/rename", { path: "/work/group", name: "team" })).resolves.toEqual({ path: "/work/team" });
    expect(calls).toEqual([
      { path: "/api/hub/folders/rename", body: { path: "/work/group", name: "team" } },
      { path: "/api/hub/folders/rename", body: { path: "/work/group", name: "team", stop: true } },
    ]);
    expect(confirmations[0]).toContain('"alpha", "nested-beta"');
    expect(confirmations[0]).toContain("running sessions and shells will be terminated");
  });

  test("cancelling a needsStop prompt sends no mutation retry", async () => {
    const calls: Record<string, unknown>[] = [];
    const api = async (_path: string, body: Record<string, unknown>) => {
      calls.push(body);
      throw Object.assign(new Error("workspace is running"), {
        payload: { needsStop: true, workspaceIds: ["alpha"] },
      });
    };
    const mutate = folderMutationFunction(htmlFor.clone())(api, () => false);

    await expect(mutate("/api/hub/folders/remove", { path: "/work/alpha" })).resolves.toBeNull();
    expect(calls).toEqual([{ path: "/work/alpha" }]);
  });

  test("keeps folder controls busy through retry and exposes local actionable errors", () => {
    const html = htmlFor.clone();
    expect(html).toContain('await withBusy(button, "Creating…"');
    expect(html).toContain('await withBusy(rename.button, "Renaming…"');
    expect(html).toContain('await withBusy(button, "Removing…"');
    expect(html).toContain('Could not create "');
    expect(html).toContain('Could not rename "');
    expect(html).toContain('Could not remove "');
    expect(html).toContain('if (!result) return;');
    expect(html).toContain('renameFolderSubmit.disabled = true;');
    expect(html).toContain('if (renameFolderSubmit.disabled)');
    expect(html).toContain('event.preventDefault();');
    expect(html).toContain('.folder-browser .row { flex-wrap: wrap; }');
    expect(html).toContain('.folder-browser .row-actions { flex: 1 0 100%; justify-content: flex-end; }');
  });
});

describe("add workspace page", () => {
  test("labels the page Add workspace and organizes three entry modes", () => {
    const html = htmlFor.clone();
    expect(html).toContain("Add workspace</a>");
    expect(html).toContain("UatuCode Hub — Add workspace");
    expect(html).toContain("<h2>Add workspace</h2>");
    expect(html).toContain("Create a new workspace, pick an existing folder below, or clone a repository.");
    const document = documentFor("clone");
    expect(document.getElementById("create-workspace-open")).not.toBeNull();
    expect(document.getElementById("add-workspace-dialog")).not.toBeNull();
    expect(document.getElementById("clone-form")).not.toBeNull();
  });

  test("the existing-folder dialog carries name, path, credentials, and both add actions", () => {
    const html = htmlFor.clone();
    const document = documentFor("clone");
    for (const id of [
      "add-workspace-path", "add-workspace-name", "add-workspace-auth", "add-workspace-host",
      "add-workspace-signing", "add-workspace-error", "add-workspace-cancel", "add-workspace-start", "add-workspace-submit",
    ]) {
      expect(document.getElementById(id)).not.toBeNull();
    }
    expect(document.querySelector('#add-workspace-dialog[aria-labelledby="add-workspace-title"]')).not.toBeNull();
    expect(document.getElementById("add-workspace-submit")?.textContent).toBe("Add workspace");
    expect(document.getElementById("add-workspace-start")?.textContent).toBe("Add and start");
    // The display name prefills from the folder basename and stays editable.
    expect(html).toContain("addWorkspaceName.value = name;");
    expect(html).toContain("addWorkspaceName.select();");
    // The commit is stopped-by-default; start is a separate explicit flow
    // that reuses the masked unlock path after the configuration commits.
    expect(html).toContain('api("/api/hub/workspaces/configure", request)');
    expect(html).not.toContain('"/api/hub/workspaces/configure", { ...request, start: true }');
    expect(html).toContain("startRegisteredWorkspace(");
    // Cancellation is mutation-free and errors preserve the form.
    expect(html).toContain("Cancellation is mutation-free: nothing was sent.");
    expect(html).toContain("setLocalError(addWorkspaceError, error.message)");
  });

  test("the create-workspace dialog links names until edited and reports retained folders", () => {
    const html = htmlFor.clone();
    const document = documentFor("clone");
    for (const id of [
      "create-workspace-parent", "create-workspace-folder", "create-workspace-name",
      "create-workspace-auth", "create-workspace-signing", "create-workspace-error", "create-workspace-submit",
    ]) {
      expect(document.getElementById(id)).not.toBeNull();
    }
    expect(html).toContain("if (createNameLinked) createWorkspaceName.value = createWorkspaceFolder.value;");
    expect(html).toContain('api("/api/hub/workspaces/create"');
    expect(html).toContain("Creates the folder, runs git init, and adds the workspace stopped.");
    expect(html).toContain('Use "Add workspace" on the retained folder to finish adding it.');
    expect(html).toContain("setCreateWorkspaceBusy(true)");
  });

  test("browser rows are lifecycle-aware with display-name detail", () => {
    const html = htmlFor.clone();
    expect(html).toContain('label: "Open"');
    expect(html).toContain('label: "Start"');
    expect(html).toContain('label: "Add workspace"');
    expect(html).toContain('dir.running ? "running" : "stopped"');
    expect(html).toContain("'workspace \"' + dir.displayName + '\"'");
  });
});

describe("settings page", () => {
  test("manages the default workspace parent with fallback explanation", () => {
    const html = htmlFor.settings();
    const document = documentFor("settings");
    for (const id of ["workspace-defaults-form", "workspace-defaults-parent", "workspace-defaults-clear", "workspace-defaults-status", "workspace-defaults-error"]) {
      expect(document.getElementById(id)).not.toBeNull();
    }
    expect(html).toContain('api("/api/hub/settings/workspace-defaults", { defaultWorkspaceParent: value })');
    expect(html).toContain('api("/api/hub/settings/workspace-defaults", { defaultWorkspaceParent: null })');
    expect(html).toContain("is currently unavailable; onboarding falls back to");
    expect(html).toContain("Workspaces can still be added from anywhere.");
  });

  test("shares the dismissible shared-UID advisory with clone", () => {
    const alice = htmlFor.settings();
    const bob = settingsPage("bob");
    expect(alice).toContain("uatu.hub.notice.shared-uid-v1:YWxpY2U");
    expect(htmlFor.clone()).toContain("uatu.hub.notice.shared-uid-v1:YWxpY2U");
    expect(bob).toContain("uatu.hub.notice.shared-uid-v1:Ym9i");
    expect(settingsPage('</script><script id="injected">')).not.toContain('<script id="injected">');
    expect(loginPage()).not.toContain("shared-uid-v1");
  });

  test("renders masked credential forms, tools, assignments, and devices", () => {
    const html = htmlFor.settings();
    const document = documentFor("settings");
    for (const id of ["ssh-generate-form", "ssh-import-form", "openpgp-generate-form", "openpgp-import-form", "token-form", "credentials-pane", "credential-tools", "devices"]) {
      expect(document.getElementById(id)).not.toBeNull();
    }
    const secrets = [...document.querySelectorAll<HTMLInputElement>('input[type="password"]')];
    expect(secrets.length).toBeGreaterThanOrEqual(4);
    expect(secrets.every(input => input.value === "" && !input.hasAttribute("value"))).toBe(true);
    expect([...document.querySelectorAll("textarea")].every(input => input.textContent === "")).toBe(true);
    expect(document.querySelector('#ssh-import-form input[type="file"][name="privateKeyFile"]')).not.toBeNull();
    expect(document.querySelector("#ssh-import-form .paste-option textarea[name=privateKey]")).not.toBeNull();
    for (const id of ["ssh-private-key", "openpgp-private-key"]) {
      expect(document.querySelector(`#${id}.secret-paste-masked`)).not.toBeNull();
      const reveal = document.querySelector(`[data-reveal-secret="${id}"]`);
      expect(reveal?.textContent).toBe("Reveal");
      expect(reveal?.getAttribute("aria-controls")).toBe(id);
      expect(reveal?.getAttribute("aria-pressed")).toBe("false");
    }
    expect(document.getElementById("workspace-credential-assignments")).not.toBeNull();
    expect(document.querySelector("details.workspace-credential-section")?.hasAttribute("open")).toBe(false);
    expect(document.querySelectorAll("[data-form-error][role=alert]").length).toBe(5);
    expect(html).toContain("Copy public key");
    expect(html).toContain('else if (credential.type === "ssh")');
    expect(html).toContain("credentialRestartRequired");
    expect(html).toContain("Restart required: assignment changes apply fully");
    expect(document.querySelector("[data-shared-uid-warning] span")?.textContent).toBe(LOCAL_CREDENTIAL_ASSIGNMENT_WARNING);
  });

  test("preserves lifecycle actions, tool probes, and responsive controls", () => {
    const html = htmlFor.settings();
    for (const action of ["unlock", "lock", "enable", "disable", "assign", "unassign", "test", "delete"]) {
      expect(html).toContain(action);
    }
    expect(html).toContain('confirm(\'Delete credential "\'');
    expect(html).toContain("{ confirm: true, unassign: assigned }");
    expect(html).toContain("Disabling this provider CLI token may stop running workspaces that still use it and terminate their shells.");
    expect(html).toContain("This may stop running workspaces that still use the token and terminate their shells.");
    expect(html).toContain('toolPath + "/" + encodeURIComponent(tool.tool) + "/test"');
    expect(html).toContain('const card = el("details", "credential-card")');
    expect(html).toContain("openCredentialIds.has(credential.id)");
    expect(html).toContain("Assign selected");
    expect(html).toContain("Selected credentials replace the current defaults");
    expect(html).toContain('"/credential-assignments"');
    expect(html).toContain("authentication: { credentialId: authentication.value");
    expect(html).not.toContain("authenticationAssigned");
    expect(html).not.toContain("previousAuthentication");
    expect(html).toContain('host.disabled = !selected');
    expect(html).toContain('value === "github-cli" || value === "gitlab-cli"');
    expect(html).toContain("Authentication host");
    expect(html).toContain("No workspace credentials assigned.");
    expect(html).toContain("workspaceAssignmentEntries");
    expect(html).toContain("removeWorkspaceAssignment(entry, workspace, remove, actionError)");
    expect(html).toContain('{ host: entry.assignment.host }');
    expect(html).toContain("Stop it and remove its");
    expect(html).toContain("Its shells will be terminated.");
    // Stop-and-remove is one request: the server runs the unassignment
    // inside the stop lifecycle instead of the page issuing two racy POSTs.
    expect(html).toContain('role: entry.assignment.role, stop: true');
    expect(html).not.toContain('/sessions/" + encodeURIComponent(workspace.id) + "/stop');
    expect(html).not.toContain("Continue with this assignment?");
    expect(html).toContain("Choose exactly one private key source");
    expect(html).toContain("file.size > 1024 * 1024");
    expect(html).toContain("const body = await buildBody(data, form)");
    expect(html).toContain('classList.toggle("secret-paste-masked")');
    expect(html).toContain('input[type="file"]');
    expect(html).toContain('toolError.setAttribute("role", "alert")');
    expect(html).not.toContain('showError("")');
    expect(html).toContain("@media (max-width: 520px)");
    expect(html).not.toMatch(/least[- ]privilege|credential isolation|isolated credential/i);
  });
});

describe("stopped session page", () => {
  test("titles by display name and offers Start and Configure for registered workspaces", () => {
    const html = stoppedSessionPage("payments-service", true, "Payments API");
    expect(html).toContain("<strong>Payments API</strong>");
    expect(html).toContain('id="stopped-start"');
    expect(html).toContain(">Configure</a>");
    expect(html).toContain('"/api/hub/sessions/payments-service/start"');
    expect(html).not.toContain("<strong>payments-service</strong>");
    // A locked-credential rejection routes to the dashboard's masked
    // unlock flow instead of dead-ending on this page.
    expect(html).toContain("/locked|unlock/i.test(error.message)");
    expect(html).toContain('location.href = "/"');
  });

  test("an unregistered id only links back to the dashboard", () => {
    const html = stoppedSessionPage("gone", false);
    expect(html).toContain("<strong>gone</strong>");
    expect(html).not.toContain('id="stopped-start"');
    expect(html).toContain('href="/"');
  });

  test("escapes display names and ids", () => {
    const html = stoppedSessionPage("x", true, "<script>alert(1)</script>");
    expect(html).not.toContain("<script>alert(1)</script>");
  });
});
