import type { PublicCredentialDto, PublicToolReadinessDto, CredentialRecord, SshCredentialRecord } from "../credential-types";
import type { PrivateKeySource, KeyTarget, CredentialFacts, KnownFact, NotApplicableFact } from "./backend";
import { escapeHtml as esc } from "../../shared/html";
import { action, advisory, check, clearSecrets, field, group, listRow, required, text, value, values, type FlowActions, type FlowEnvironment } from "./flow-ui";
import { diagnosticReport, readiness } from "./readiness";

const literalInput = 'autocorrect="off" autocapitalize="none" spellcheck="false" inputmode="text"';
const toolPurposes: Record<PublicToolReadinessDto["tool"], string> = {
  git: "Git repositories", ssh: "Remote SSH connections", "ssh-agent": "Holds unlocked SSH keys",
  "ssh-add": "Loads SSH keys into the agent", "ssh-keygen": "Creates, inspects and signs with SSH keys",
  gpg: "OpenPGP signing", gpgconf: "Manages OpenPGP background services", gh: "GitHub CLI", glab: "GitLab CLI",
};

/** Validate before the adapter is allowed to read File.text(). The paste surface
 * is secondary; both sources are secret and cleared after every submit attempt. */
export function privateKeySource(file: File | undefined, paste: string): PrivateKeySource {
  const hasFile = !!file && file.name !== "", hasPaste = paste.trim() !== "";
  if (hasFile === hasPaste) throw new Error("Choose exactly one private key source: upload a file or paste a key.");
  if (hasFile) {
    if (file!.size > 1024 * 1024) throw new Error("Private key exceeds the 1 MiB size limit.");
    return { kind: "file", file: file! };
  }
  if (new TextEncoder().encode(paste).byteLength > 1024 * 1024) throw new Error("Private key exceeds the 1 MiB size limit.");
  return { kind: "paste", text: paste };
}
export function supportsRole(c: CredentialRecord, role: "authentication" | "signing") {
  return role === "authentication" ? c.capabilities.some(cap => cap === "ssh-authentication" || cap === "https-git" || cap === "github-cli" || cap === "gitlab-cli") : c.capabilities.some(cap => cap === "ssh-signing" || cap === "openpgp-signing");
}
export function credentialFactValue(fact: KnownFact<string> | NotApplicableFact): string {
  const labels: Record<string, string> = { protected: "Set", unprotected: "Not set", locked: "Locked", unlocked: "Unlocked" };
  return fact.status === "known" ? labels[fact.value] ?? fact.value : fact.status === "unknown" ? "Unknown" : "Not applicable";
}
/** Available to the overview owner; never derives a lock fact from readiness prose. */
export function credentialFactSummary(facts: CredentialFacts): string {
  if (facts.type === "token") return "";
  return `Availability: ${credentialFactValue(facts.lock)} · Passphrase: ${credentialFactValue(facts.protection)}`;
}
export function credentialFactRows(facts: CredentialFacts): string {
  const row = (name: string, label: string, fact: KnownFact<string> | NotApplicableFact) => `<div class="mh-fact-row${name === "userId" ? " mh-fact-row-stacked" : ""}" data-credential-fact="${name}"><span>${label}</span><span class="mh-value">${esc(name === "userId" && fact.status === "known" ? fact.value : credentialFactValue(fact))}</span></div>`;
  return (facts.type === "token" ? "" : row("protection", "Passphrase", facts.protection) + row("lock", "Availability", facts.lock)) + (facts.type === "openpgp" ? row("userId", "OpenPGP user ID", facts.userId) : "");
}
export function credentialPurpose(c: Pick<PublicCredentialDto, "capabilities">): string {
  const labels = { "ssh-authentication": "SSH connections", "ssh-signing": "Signing commits with SSH", "openpgp-signing": "Signing commits with OpenPGP", "https-git": "HTTPS Git connections", "github-cli": "GitHub CLI", "gitlab-cli": "GitLab CLI" };
  return c.capabilities.map(cap => labels[cap]).join(" · ");
}
export function credentialPrimaryAction(c: Pick<PublicCredentialDto, "enabled" | "type">, facts: CredentialFacts): "toggle" | "unlock" | "test" {
  if (!c.enabled) return "toggle";
  return c.type !== "token" && facts.type === c.type && facts.lock.status === "known" && facts.lock.value === "locked" ? "unlock" : "test";
}
export function createCredentialFlows(env: FlowEnvironment) {
  const { backend } = env;
  let toolConfigurationRequest = 0;
  const reload = (id: string) => { env.changed(); detail(id); };
  function checkResults(rows: PublicCredentialDto["readiness"], purpose: string) {
    env.task("Check Results", text(purpose) + readiness(rows) + group("Report", listRow("diagnostics", "View diagnostic report", "Detailed output from this check", "settings")), undefined, {
      diagnostics: () => env.task("Diagnostic report", diagnosticReport(rows), undefined, {}, () => checkResults(rows, purpose), { cancelLabel: "Back" }),
    });
  }
  function chooser() {
    env.page("Add Credential", advisory(env.user()) + group("Credential type", listRow("ssh", "SSH key", "Generate or import · authentication and signing", "key") + listRow("openpgp", "OpenPGP key", "Generate or import · signing", "key") + listRow("token", "HTTPS / provider token", "HTTPS Git, GitHub CLI or GitLab CLI", "key")), {
      ssh: () => keyChooser("ssh"), openpgp: () => keyChooser("openpgp"), token: () => create("token", false),
    }, { icon: "key", subtitle: "Choose a credential type" });
  }
  function keyChooser(type: "ssh" | "openpgp") {
    const label = type === "ssh" ? "SSH" : "OpenPGP";
    env.page(`${label} key`, group("Add key", listRow(`${type === "ssh" ? "ssh" : "pgp"}-generate`, `Generate ${label} key`, "Create a new passphrase-protected key", "key") + listRow(`${type === "ssh" ? "ssh" : "pgp"}-import`, `Import ${label} key`, "Use an existing private key", "key")), {
      "flow-back": chooser,
      "ssh-generate": () => create("ssh", false), "ssh-import": () => create("ssh", true),
      "pgp-generate": () => create("openpgp", false), "pgp-import": () => create("openpgp", true), token: () => create("token", false),
    }, { icon: "key", subtitle: "Choose how to add this key" });
  }
  function create(type: CredentialRecord["type"], importing: boolean) {
    const title = `${type === "token" ? "Add" : importing ? "Import" : "Generate"} ${type === "ssh" ? "SSH key" : type === "openpgp" ? "OpenPGP key" : "HTTPS / provider token"}`;
    const source = text("Choose one source: upload a file or paste a private key below.") + field("file", "Private key file (preferred)", "", "file") + '<label class="mh-field mh-paste">Or paste a private key<textarea name="paste" data-secret autocomplete="off" autocorrect="off" autocapitalize="none" inputmode="text" spellcheck="false" aria-label="Private key, masked"></textarea></label>';
    const capabilities = type === "ssh" ? check("cap", "SSH authentication", true, "ssh-authentication") + check("cap", "SSH signing", false, "ssh-signing") : type === "token" ? check("cap", "HTTPS Git", true, "https-git") + check("cap", "GitHub CLI", false, "github-cli") + check("cap", "GitLab CLI", false, "gitlab-cli") : text("Purpose: OpenPGP signing.");
    const body = field("name", "Name") + (type === "openpgp" && !importing ? field("userId", "User ID (name and email)", "", "text", literalInput) : "") + (type === "token" ? field("host", "Provider host", "", "text", 'autocorrect="off" autocapitalize="none" spellcheck="false" inputmode="url"') + field("username", "Username (optional)", "", "text", literalInput) + field("token", "Token", "", "password", `${literalInput} autocomplete="new-password"`) : (importing ? source : "") + (type === "ssh" || !importing ? field("passphrase", importing ? "Existing passphrase, if any" : "Passphrase", "", "password", `${literalInput} autocomplete="new-password"`) : "")) + group("Purpose", capabilities) + (type === "ssh" && importing ? text("The key keeps its current passphrase. Unprotected keys remain available without unlocking.") : "");
    env.task(title, body, { label: importing ? "Import" : type === "token" ? "Add" : "Generate", run: async root => {
      try {
        const name = required(value(root, "name"), "Name");
        const passphrase = value(root, "passphrase");
        if (type !== "token" && !importing && !passphrase) throw new Error("A passphrase is required when generating a key.");
        const caps = values(root, "cap"); if (type !== "openpgp" && !caps.length) throw new Error("Select at least one purpose.");
        const source = importing ? privateKeySource(root.querySelector<HTMLInputElement>('[name="file"]')?.files?.[0], value(root, "paste")) : null;
        const completed = (credential: PublicCredentialDto) => { env.sheet.close(); env.changed(); env.navigate({ kind: "credential", id: credential.id }); };
        // Snapshot intent and clear secrets before the asynchronous adapter call.
        if (type === "ssh") {
          const intent = { name, passphrase, capabilities: caps as SshCredentialRecord["capabilities"] }; clearSecrets(root);
          if (source) await env.mutate(() => backend.importSsh({ ...intent, source }), completed, root);
          else await env.mutate(() => backend.generateSsh(intent), completed, root);
        } else if (type === "openpgp") {
          const userId = source ? "" : required(value(root, "userId"), "User ID"); clearSecrets(root);
          if (source) await env.mutate(() => backend.importOpenPgp({ name, source }), completed, root);
          else await env.mutate(() => backend.generateOpenPgp({ name, userId, passphrase }), completed, root);
        } else {
          const host = required(value(root, "host"), "Provider host"), token = value(root, "token"), username = value(root, "username").trim();
          if (!token || /[\r\n\0]/.test(token) || new TextEncoder().encode(token).byteLength > 64 * 1024) throw new Error("Enter a nonempty token of at most 64 KiB without line breaks.");
          const capabilities = caps as Array<"https-git" | "github-cli" | "gitlab-cli">; clearSecrets(root);
          await env.mutate(() => backend.createToken({ name, host, token, capabilities, ...(username ? { username } : {}) }), completed, root);
        }
      } finally { clearSecrets(root); }
    } });
  }
  function unlock(target: KeyTarget, next: () => void, cancel?: () => void, title = "Unlock credential", continuation?: "reviewed-clone") {
    const description = continuation === "reviewed-clone" ? "Unlock to continue the reviewed clone using the options you already authorized." : "Unlocking alone does not start a workspace or a clone job.";
    env.task(title, text(description) + field("passphrase", "Passphrase", "", "password", `${literalInput} autocomplete="off"`), { label: continuation === "reviewed-clone" ? "Unlock and continue" : "Unlock", run: async root => {
      const passphrase = value(root, "passphrase"); clearSecrets(root);
      if (target.type === "openpgp" && !passphrase) throw new Error("A passphrase is required for OpenPGP unlock.");
      await env.mutate(() => backend.unlockCredential({ target, passphrase }), () => { env.sheet.close(); env.changed(); next(); }, root);
    } }, {}, cancel);
  }
  function detail(id: string) {
    env.page("Credential", text("Loading credential…"));
    void env.read(() => backend.readCredentials(), catalog => {
      const c = catalog.find(c => c.id === id);
      if (!c) { env.page("Credential unavailable", text("This credential no longer exists. No replacement has been selected.")); return; }
      const target = { id: c.id, type: c.type };
       const unknown = { status: "unknown" } as const, na = { status: "not-applicable" } as const;
       const fallback: CredentialFacts = c.type === "token"
         ? { id, type: "token", protection: na, lock: na, userId: na }
         : c.type === "ssh" ? { id, type: "ssh", protection: unknown, lock: unknown, userId: na }
         : { id, type: "openpgp", protection: unknown, lock: unknown, userId: unknown };
       const readFacts = () => { void env.read(async () => {
         // Keep catalog-backed operations usable; preserve the shared auth boundary.
         try {
           const result = await backend.readCredentialFacts(target);
           if (result.status === "unavailable" && result.problem.kind === "unauthorized") return result;
           if (result.status === "available" && result.value.id === id && result.value.type === c.type)
             return { status: "available" as const, value: { facts: result.value, notice: "" } };
           return { status: "available" as const, value: { facts: fallback, notice: "Couldn't check this credential's availability. You can still view and manage it." } };
         } catch {
           return { status: "available" as const, value: { facts: fallback, notice: "Couldn't check this credential's availability. You can still view and manage it." } };
         }
       }, ({ facts, notice }) => {
       const factRows = (notice ? text(notice) + action("retry-facts", "Retry status check") : "") + credentialFactRows(facts);
      const provider = c.type === "token" && c.capabilities.some(cap => cap === "github-cli" || cap === "gitlab-cli");
      const publicInfo = c.type === "token" ? `${c.metadata.host}${c.metadata.username ? ` · ${c.metadata.username}` : ""}` : c.metadata.fingerprint;
       const primary = credentialPrimaryAction(c, facts);
        const commands: FlowActions = {
         "retry-facts": readFacts,
         test: () => env.mutate(() => backend.testCredential(target), results => { checkResults(results, credentialPurpose(c)); env.changed(); }),
         "copy-id": async () => {
           const status = env.root.querySelector<HTMLElement>("[data-identifier-status]");
           try { await navigator.clipboard.writeText(publicInfo); if (status?.isConnected) status.textContent = "Public identifier copied."; }
           catch { if (status?.isConnected) status.textContent = "Clipboard unavailable. Select and copy the public identifier."; }
         },
        public: () => { if (c.type !== "token") publicKey({ id, type: c.type }); },
         unlock: () => { if (c.type !== "token") unlock({ id, type: c.type }, () => detail(id), undefined, `Unlock ${c.name}`); },
        lock: () => { if (c.type === "ssh") void env.mutate(() => backend.lockSsh({ id, type: "ssh" }), () => reload(id)); },
        defaults: () => env.navigate({ kind: "assignments" }),
        toggle: () => {
          if (!c.enabled) return env.mutate(() => backend.enableCredential(target), () => reload(id));
           env.confirm("Disable credential?", text(`Disable ${c.name}.` + (provider ? " Running workspaces still using this provider token may need to stop, terminating their shells. Current assignment rows do not identify every projected token user." : " This makes the credential unavailable to normal tools.")), { label: "Disable", run: async () => { env.sheet.close(); await env.coordinated("Stop workspaces and disable?", stop => backend.disableCredential({ target, stop }), () => detail(id)); } });
        },
         delete: () => env.confirm("Delete credential?", text(`Permanently delete ${c.name}. Its private material cannot be recovered from this hub.`) + (c.assignments.length ? check("unassign", "Remove all assignments for this credential") : "") + (provider ? text("Running workspaces still using this provider token may stop, terminating their shells. Assignment rows alone do not identify these sessions.") : ""), { label: "Delete", run: async root => {
          const unassign = !!root.querySelector<HTMLInputElement>('[name="unassign"]')?.checked;
          if (c.assignments.length && !unassign) throw new Error("Confirm removal of this credential's assignments before deletion.");
          env.sheet.close(); await env.coordinated("Stop workspaces and delete?", stop => backend.deleteCredential({ target, confirm: true, unassign, stop }), () => { env.home(); });
        } }),
       };
       const keyActions = c.type === "token" ? "" : listRow("public", "Public key", "View, copy or download", "key")
         + (facts.lock.status === "known" && facts.lock.value === "unlocked" ? "" : listRow("unlock", "Unlock", "Make this key available on this Hub", "key"))
          + (c.type === "ssh" && !(facts.lock.status === "known" && facts.lock.value === "locked") ? action("lock", "Lock SSH key") : "");
       // Availability already communicates a known lock. Only surface another actual blocker once.
       const blocker = notice || !c.enabled || primary === "unlock" ? "" : c.readiness.find(r => r.status === "unavailable")?.message ?? "";
       env.page(c.name, group("Purpose", text(credentialPurpose(c)) + (blocker ? text(blocker) : ""))
          + group(c.type === "token" ? "Provider" : "Key protection and availability", factRows + `<div class="mh-fact-row mh-fact-row-stacked"><span>Public identifier</span><span class="mh-value">${esc(publicInfo)}</span></div>` + action("copy-id", "Copy public identifier") + '<p class="mh-note" role="status" data-identifier-status></p>')
         + group("Workspace assignments", (c.assignments.length ? c.assignments.map(a => text(`${a.workspaceId} · ${a.role}${a.role === "authentication" ? ` · ${a.host}` : ""}`)).join("") : text("No workspace assignments")) + listRow("defaults", "Manage assignments", "Workspace defaults and credential selection", "settings"))
         + group("Actions", keyActions + listRow("test", "Check setup", "Run local checks; not a repository access test", "settings") + action("toggle", c.enabled ? "Disable" : "Enable", c.enabled) + action("delete", "Delete credential", true)), commands,
         { icon: "key", subtitle: `${c.type === "ssh" ? "SSH key" : c.type === "openpgp" ? "OpenPGP key" : "HTTPS / provider token"} · ${c.enabled ? "Enabled" : "Disabled"}` });
       }, readFacts); };
       readFacts();
    }, () => detail(id));
  }
  function publicKey(target: KeyTarget) {
    void env.read(() => backend.readPublicKey(target), key => {
      env.task("Public key", text(key.fingerprint) + `<pre class="mh-public-key">${esc(key.publicKey)}</pre>` + action("copy", "Copy public key") + action("download", "Download public key"), undefined, {
        copy: async () => { try { await navigator.clipboard.writeText(key.publicKey); env.sheet.error("Public key copied."); } catch { env.sheet.error("Clipboard unavailable. Select and copy the public key above."); } },
        download: () => {
          const url = URL.createObjectURL(new Blob([key.publicKey], { type: "text/plain" }));
          const link = env.root.ownerDocument.createElement("a"); link.href = url; link.download = `${target.type}-public-key.pub`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 0);
        },
      });
    }, () => publicKey(target));
  }
  function tools() {
    ++toolConfigurationRequest;
    env.page("Credential Tools", text("Loading tool readiness…"));
    void env.read(() => backend.readTools(), tools => {
      env.page("Credential Tools", tools.length ? group("Tools", tools.map(t => listRow(`tool-${t.tool}`, t.tool, `${toolPurposes[t.tool]} · ${t.path ? "Installed" : "Not found"}`, "settings")).join("")) : text("No tool readiness information is available."), Object.fromEntries(tools.map(t => [`tool-${t.tool}`, () => toolDetail(t)])), { icon: "settings", subtitle: "Local software for connecting and signing" });
    }, tools);
  }
  function toolDetail(t: PublicToolReadinessDto) {
    ++toolConfigurationRequest;
    const commands: FlowActions = {
      "flow-back": tools,
      [`test-${t.tool}`]: () => env.mutate(() => backend.testTool(t.tool), result => { env.changed(); checkResults(result.results, toolPurposes[result.tool]); }),
      [`override-${t.tool}`]: () => {
          const request = ++toolConfigurationRequest;
          void env.read(() => backend.readToolConfiguration(t.tool), configuration => {
          if (request !== toolConfigurationRequest) return;
          if (configuration.tool !== t.tool) { env.page("Tool configuration unavailable", text("The returned configuration does not identify this tool.")); return; }
          const saved = configuration.savedOverride;
          const initial = saved.status === "known" ? saved.value ?? "" : "";
          const description = saved.status === "unknown" ? "Saved override: Unknown. No current value has been assumed." : saved.value === null ? "No saved override. Tool discovery is used." : `Saved override: ${saved.value}`;
           const save = (path: string | null, root: HTMLElement) => env.mutate(() => backend.setToolOverride({ tool: t.tool, path }), result => { env.sheet.close(); env.changed(); toolDetail(result); }, root);
           let automatic = saved.status === "known" && saved.value === null;
           let task: HTMLElement;
            task = env.task(`${t.tool} executable`, text("Use a different installation on this Hub. Changes take effect only when you save.") + text(description) + text(`Detected path: ${t.path ?? "not found"}. This is separate from the saved override.`) + field("path", "Absolute executable path", initial, "text", literalInput) + action("clear", "Use automatic discovery") + '<p class="mh-note" role="status" data-discovery-status></p>', { label: "Save", run: root => {
             const entered = value(root, "path").trim();
             if (automatic && !entered) return save(null, root);
             const path = required(entered, "Executable path"); if (!path.startsWith("/")) throw new Error("Executable override must be an absolute path."); return save(path, root);
           } }, { clear: () => {
             automatic = true;
             task.querySelector<HTMLInputElement>('[name="path"]')!.value = "";
             task.querySelector<HTMLElement>("[data-discovery-status]")!.textContent = "Automatic discovery will be used when you save.";
           } });
           task.querySelector<HTMLInputElement>('[name="path"]')!.addEventListener("input", () => {
             automatic = false;
             task.querySelector<HTMLElement>("[data-discovery-status]")!.textContent = "Enter an absolute path, or choose automatic discovery.";
           });
           }, () => toolDetail(t));
      },
    };
    env.page(t.tool, group("Purpose", text(toolPurposes[t.tool])) + group("Installation", listRow(`override-${t.tool}`, "Executable location", `${t.path ?? "Not found"} · View saved setting or use a different installation`, "settings") + text(`Version: ${t.version ?? "Unavailable"}`)) + group("Check installation", listRow(`test-${t.tool}`, `Recheck ${t.tool} setup`, "Reprobe installed tools and local services; no remote access tests", "settings")), commands, { icon: "settings", subtitle: toolPurposes[t.tool] });
  }
  return { chooser, detail, tools, toolDetail, unlock };
}
