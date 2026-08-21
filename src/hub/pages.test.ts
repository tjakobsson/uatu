import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";

import { LOCAL_CREDENTIAL_ASSIGNMENT_WARNING } from "./credential-context";
import { clonePage, dashboardPage, loginPage, settingsPage } from "./pages";

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
    expect(html.indexOf("if (!hasCredentialAssignments(w.credentialAssignments)")).toBeLessThan(html.indexOf("uiBusy += 1", html.indexOf('label: "Resume"')));
    expect(html).toContain("prepareWorkspaceResume(w, errorTarget)");
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
    expect(html).toContain("{ url, dest: browsePath, folderName }");
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
    expect(document.getElementById("clone-retain-assignment")?.hasAttribute("disabled")).toBe(true);
    expect(document.querySelector("[data-shared-uid-warning] span")?.textContent).toBe(LOCAL_CREDENTIAL_ASSIGNMENT_WARNING);
    expect(document.querySelector("[data-dismiss-shared-uid]")).not.toBeNull();
    expect(html).toContain("uatu.hub.notice.shared-uid-v1:YWxpY2U");
    expect(html).toContain("cloneCompatible");
    expect(html).toContain("isCredentialLocked(selectedCredential)");
    expect(html).toContain("request.credentialId = selectedCredential.id");
    expect(html).toContain("request.retainAssignment = cloneRetainAssignment.checked");
    expect(html).toContain('(?:[^@/:\\s]+@)?');
    expect(html).toContain('value.startsWith("git+ssh://")');
    expect(html).not.toContain("at > 0");
  });
});

describe("settings page", () => {
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
    expect(html).toContain('toolPath + "/" + encodeURIComponent(tool.tool) + "/test"');
    expect(html).toContain('const card = el("details", "credential-card")');
    expect(html).toContain("openCredentialIds.has(credential.id)");
    expect(html).toContain("Assign selected");
    expect(html).toContain("Selected credentials replace the current defaults");
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
    expect(html).toContain('input[type="file"]');
    expect(html).toContain('toolError.setAttribute("role", "alert")');
    expect(html).not.toContain('showError("")');
    expect(html).toContain("@media (max-width: 520px)");
    expect(html).not.toMatch(/least[- ]privilege|credential isolation|isolated credential/i);
  });
});
