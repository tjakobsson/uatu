import type { CloneIntent, CloneStreamEvent, KeyTarget } from "./backend";
import type { CloneJobResult } from "../clone-jobs";
import { normalizeProviderHost, type PublicCredentialDto } from "../credential-types";
import { absolute, action, advisory, clearSecrets, displayName, field, folderName, group, hubForeground, infoRows, required, select, sharedUidKey, showContextualError, text, value, type FlowEnvironment } from "./flow-ui";
import { bindAuthenticationHost, configurationFacts, configurationFields, readConfiguration, technicalField, type ConfigurationDraft } from "./onboarding-flows";

export type CloneDraft = CloneIntent;
export function emptyCloneDraft(): CloneDraft { return { url: "", dest: "", folderName: "", displayName: "", credentialId: null, retainedAuthentication: [], signing: null, start: false }; }
/** Reject secret-bearing spellings before assigning any input to the retained
 * non-secret draft. Query/fragment components are not part of this clone form. */
export function cloneUrlProblem(raw: string): string | null {
  if (/[\u0000-\u001f\u007f]/.test(raw)) return "Remote URL contains invalid characters; it was discarded.";
  if (/[?#]/.test(raw)) return "Remote URL query/fragment text may contain secrets and was discarded. Use a credential-free remote URL.";
  // Inspect URI authority spelling even when URL parsing fails (bad port,
  // missing host, incomplete typing). Colons in a host/IPv6 address are not
  // password separators; only a colon before the authority's final @ is.
  const spelling = raw.trim(), authority = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(spelling)?.[1];
  const at = authority?.lastIndexOf("@") ?? -1;
  if (at >= 0 && (authority!.slice(0, at).includes(":") || /^https?:/i.test(spelling))) return "Do not embed credentials in a remote URL. The URL was discarded; select a Hub credential instead.";
  try { const url = new URL(raw); if (url.password || ((url.protocol === "http:" || url.protocol === "https:") && url.username)) return "Do not embed credentials in a remote URL. The URL was discarded; select a Hub credential instead."; } catch { /* Authority was inspected independently; other syntax validation belongs to the adapter. */ }
  return null;
}
export function validateCloneDraft(draft: CloneDraft): CloneIntent {
  const url = required(draft.url, "Remote URL");
  const problem = cloneUrlProblem(url); if (problem) throw new Error(problem);
  return { ...draft, url, dest: absolute(draft.dest), folderName: folderName(draft.folderName), displayName: displayName(draft.displayName) };
}
type AuthOwner = ReturnType<FlowEnvironment["authContext"]>;
export type CloneRecoveryHint = { version: 2; attemptId: string; jobId?: string; inputUncertain?: true };
export function cloneAttemptStorageKey(user: string): string { return `uatu.hub.clone-attempt-v2:${sharedUidKey(user).split(":").at(-1)}`; }
export function parseCloneRecoveryHint(raw: string | null): CloneRecoveryHint | null {
  try {
    const hint = JSON.parse(raw ?? "null");
    if (!hint || hint.version !== 2 || typeof hint.attemptId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(hint.attemptId)) return null;
    if (Object.keys(hint).some(key => !["version", "attemptId", "jobId", "inputUncertain"].includes(key))) return null;
    if (hint.jobId !== undefined && (typeof hint.jobId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(hint.jobId))) return null;
    if (hint.inputUncertain !== undefined && hint.inputUncertain !== true) return null;
    return hint;
  } catch { return null; }
}
type Attempt = { id: string; owner: AuthOwner; key: string; state: "submitting" | "unknown" | "pending" | "unavailable" | "expired" | "accepted"; hint: CloneRecoveryHint };
export function cloneCredentialCompatible(c: PublicCredentialDto, remote: string): boolean {
  // Browser equivalent of credential-context's transport discrimination. Other
  // Git-supported remotes remain usable without a Hub credential; validation
  // and execution stay with the adapter, not a frontend protocol allowlist.
  const scp = /^(?:[^@/:\s]+@)?(\[[^\]]+\]|[^/:\s]+):(.+)$/.exec(remote);
  const scpStyle = scp && !/^[A-Za-z]:(?:[\\/]|.*[\\/])/.test(remote) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(remote);
  if (scpStyle) return c.type === "ssh" && c.capabilities.includes("ssh-authentication");
  try {
    const parsed = new URL(remote);
    if (parsed.protocol === "ssh:" || parsed.protocol === "git+ssh:") return c.type === "ssh" && c.capabilities.includes("ssh-authentication");
    if (parsed.protocol !== "https:" || c.type !== "token" || !c.capabilities.includes("https-git")) return false;
    const authority = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(remote)?.[1] ?? parsed.host;
    return !parsed.username && !parsed.password && c.metadata.host === normalizeProviderHost(authority);
  } catch { return false; }
}
/** One accepted job, independent of view visibility. Navigation is not cancel;
 * reconnect replays by event id and never submits a replacement job. */
export function createCloneFlow(env: FlowEnvironment, unlock: (target: KeyTarget, next: () => void, cancel?: () => void, title?: string, continuation?: "reviewed-clone") => void, inspectFolder: (path: string) => void) {
  const backend = env.backend;
  let draft = emptyCloneDraft();
  let catalog: PublicCredentialDto[] = [];
  let loaded = false, dirty = false, visible = false;
  let generation = 0, streamGeneration = 0, reconciliationGeneration = 0;
  let attempt: Attempt | null = null, reconciling = false;
  let jobId: string | null = null, afterEventId = 0;
  let phase = "Waiting", output = "", streamProblem = "", actionProblem = "", cancelPending = false, inputPending = false, inputUncertain = false;
  let result: CloneJobResult | null = null;
  let unavailableJob = false;
  let unsubscribe: (() => void) | null = null;
  const isVisible = () => visible && hubForeground(env.root);
  const owns = (value: Attempt) => attempt === value && value.owner.current();
  const retireReconciliation = () => { reconciliationGeneration++; reconciling = false; };
  function persist(value: Attempt): boolean {
    if (!owns(value) || result) return false;
    try { const json = JSON.stringify(value.hint); window.sessionStorage.setItem(value.key, json); return window.sessionStorage.getItem(value.key) === json; } catch { return false; }
  }
  function clearHint(value: Attempt) {
    try { if (parseCloneRecoveryHint(window.sessionStorage.getItem(value.key))?.attemptId === value.id) window.sessionStorage.removeItem(value.key); } catch { /* Retaining an old fenced/terminal hint is safer than losing unresolved admission. */ }
  }
  function restoreAttempt(): boolean {
    const owner = env.authContext(); if (!owner.user || !owner.current()) return false;
    try {
      const key = cloneAttemptStorageKey(owner.user), hint = parseCloneRecoveryHint(window.sessionStorage.getItem(key));
      if (!hint) return false;
      attempt = { id: hint.attemptId, owner, key, hint, state: "unknown" }; inputUncertain = hint.inputUncertain === true;
      return true;
    } catch { return false; }
  }
  const configuration = (): ConfigurationDraft => ({ displayName: draft.displayName, folderName: draft.folderName, authentication: draft.retainedAuthentication, signing: draft.signing ?? "", start: draft.start, init: false });
  function snapshot(root: HTMLElement, validate = false) {
    const rawUrl = value(root, "url"), secretProblem = cloneUrlProblem(rawUrl);
    if (secretProblem) { const input = root.querySelector<HTMLInputElement>('[name="url"]'); if (input) input.value = ""; draft.url = ""; actionProblem = secretProblem; }
    const base = { ...draft, url: secretProblem ? "" : rawUrl, dest: value(root, "dest"), folderName: value(root, "folderName"), displayName: value(root, "displayName"), credentialId: value(root, "cloneCredential") || null };
    if (secretProblem && validate) throw new Error(secretProblem);
    if (validate) {
      const config = readConfiguration(root, catalog, configuration());
      draft = { ...base, retainedAuthentication: config.authentication, signing: config.signing || null, start: config.start };
      draft = validateCloneDraft(draft);
      const credential = draft.credentialId ? catalog.find(c => c.id === draft.credentialId) : null;
      if (draft.credentialId && (!credential || !credential.enabled || !cloneCredentialCompatible(credential, draft.url))) throw new Error("Selected clone identity is missing, disabled, or incompatible. Choose a compatible credential explicitly.");
    } else {
      // Preserve non-secret edits without validation during ordinary detours.
      const retainedAuthentication = [...root.querySelectorAll<HTMLElement>("[data-auth-row]")].flatMap(row => {
        const credentialId = value(row, "authentication"); return credentialId ? [{ credentialId, host: value(row, "host") }] : [];
      });
      draft = { ...base, retainedAuthentication, signing: value(root, "signing") || null, start: root.querySelector<HTMLInputElement>('[name="start"]')?.checked ?? false };
    }
    if (secretProblem) localError(new Error(secretProblem));
  }
  function renderForm() {
    if (!isVisible()) return;
    if (attempt) { renderRecovery(); return; }
    const choices = [{ value: "", label: "No clone identity" }, ...catalog.filter(c => (c.type === "ssh" && c.capabilities.includes("ssh-authentication")) || (c.type === "token" && c.capabilities.includes("https-git"))).map(c => ({ value: c.id, label: `${c.name} · ${c.type}${c.enabled ? "" : " · Disabled"}`, disabled: !c.enabled }))];
    if (draft.credentialId && !choices.some(c => c.value === draft.credentialId)) choices.push({ value: draft.credentialId, label: "Missing clone identity; choose a replacement", disabled: true });
    const root = env.page("Clone Repository", advisory(env.user()) + technicalField("url", "Remote URL", draft.url, 'autocomplete="off"') + technicalField("dest", "Destination parent", draft.dest) + technicalField("folderName", "Checkout folder name", draft.folderName) + field("displayName", "Workspace display name", draft.displayName) + group("Clone identity", select("cloneCredential", "One-time clone credential", choices, draft.credentialId ?? "") + text("The clone identity is separate from credentials used after setup.") + action("unlock", "Unlock selected clone identity")) + group("Credentials used after setup (optional)", configurationFields(catalog, configuration())) + action("review", "Review clone") + (actionProblem ? text(actionProblem) : ""), {
      "flow-back": back,
      review: () => { try { snapshot(root, true); review(); } catch (e) { localError(e, true); } },
      unlock: () => { snapshot(root); const c = catalog.find(c => c.id === draft.credentialId); if (!c || c.type !== "ssh" || !c.enabled) { localError(new Error("Select an enabled SSH clone identity to unlock. Tokens do not support passphrase unlock."), true); return; } unlock({ id: c.id, type: "ssh" }, () => renderForm(), () => renderForm(), "Unlock Clone Identity"); },
      inspect: env.home,
    }, { primaryAction: "review" });
    bindAuthenticationHost(root, catalog);
    root.oninput = () => { dirty = true; snapshot(root); };
    root.onchange = () => { dirty = true; snapshot(root); };
  }
  function localError(error: unknown, reveal = false) { showContextualError(env.root, error instanceof Error ? error.message : "The clone form is invalid.", { reveal }); }
  function review() {
    const intent = structuredClone(draft);
    env.task("Review Clone", group("Workspace", infoRows([{ label: "Display name", value: intent.displayName }, { label: "Parent folder", value: intent.dest, mono: true }, { label: "Folder name", value: intent.folderName, mono: true }, { label: "Checkout path", value: `${intent.dest.replace(/\/$/, "")}/${intent.folderName}`, mono: true }])) + group("Clone operation", infoRows([{ label: "Remote URL", value: intent.url, mono: true }, { label: "One-time clone identity", value: catalog.find(c => c.id === intent.credentialId)?.name ?? "None", detail: "Used only for this clone; not automatically assigned after setup." }, { label: "Git initialization", value: "Clone the remote repository; no separate Git initialization" }, { label: "Start", value: intent.start ? "Start after clone explicitly requested" : "Register the completed checkout stopped" }])) + configurationFacts(catalog, intent.retainedAuthentication, intent.signing) + (intent.start && !intent.retainedAuthentication.length && !intent.signing ? text("No credentials assigned after setup. Git authentication and signing may be unavailable in the started workspace.") : ""), { label: "Clone", run: () => { env.sheet.close(); return submit(intent); } }, {}, () => renderForm(), { cancelLabel: "Back to edit" });
  }
  async function submit(intent: CloneIntent) {
    if (attempt || jobId) return;
    const owner = env.authContext(); if (!owner.user || !owner.current()) return;
    const operation: Attempt = { id: crypto.randomUUID(), owner, key: cloneAttemptStorageKey(owner.user), state: "submitting", hint: { version: 2, attemptId: "" } };
    operation.hint.attemptId = operation.id; attempt = operation;
    // Persist the opaque attempt BEFORE dispatch. Without recovery storage this
    // UI must not create work that a reload could unknowingly duplicate.
    if (!persist(operation)) { attempt = null; actionProblem = "Recovery storage is unavailable. No clone was submitted. Enable session storage before trying again."; renderForm(); return; }
    if (!owner.current()) { clearHint(operation); attempt = null; return; }
    actionProblem = ""; renderRecovery();
    try {
      const response = await backend.submitClone({ ...intent, attemptId: operation.id }); if (!owns(operation)) return;
      if (response.status === "rejected" && response.problem.kind === "unauthorized") { env.authLost(); return; }
      // A reconciliation may have already established admission while this
      // original response was in flight. Its later arrival cannot demote that
      // fact, reconnect again, or recreate a hint cleared by a terminal event.
      if (operation.hint.jobId || result) return;
      if (response.status === "rejected") { retireReconciliation(); clearHint(operation); attempt = null; actionProblem = response.problem.message; renderForm(); return; }
      if (response.status === "indeterminate") { operation.state = "unknown"; actionProblem = response.message; renderRecovery(); void reconcile(); return; }
      if (response.value.status === "requires-unlock") {
        // This attempt definitively admitted no work. The already-authorized
        // continuation must mint a NEW id after unlock, not reuse this fence.
        retireReconciliation(); clearHint(operation); attempt = null;
        if (!isVisible()) { actionProblem = "Clone identity needs unlocking. Review the clone again to continue."; return; }
        unlock(response.value.credential, () => { if (owner.current() && isVisible()) void submit(intent); }, () => renderForm(), "Unlock Clone Identity", "reviewed-clone");
        return;
      }
      accept(operation, response.value.jobId);
    } catch { if (owns(operation) && !operation.hint.jobId && !result) { operation.state = "unknown"; actionProblem = "Clone acceptance could not be confirmed."; renderRecovery(); void reconcile(); } }
  }
  function accept(operation: Attempt, id: string) {
    if (!owns(operation) || result || jobId === id) return;
    retireReconciliation();
    operation.state = "accepted"; operation.hint.jobId = id; persist(operation); dirty = false;
    jobId = id; phase = "Accepted; waiting for job phase"; actionProblem = ""; renderProgress(); connect();
  }
  function renderRecovery() {
    if (!isVisible() || !attempt || !attempt.owner.current()) return;
    if (jobId && attempt.state === "accepted") { renderProgress(); return; }
    const descriptions = {
      submitting: "Clone submission is in progress. Its acceptance is not yet confirmed.",
      unknown: "Clone acceptance is unknown. Reconcile this original attempt before any new submission.",
      pending: "The original admission is still pending. Wait and reconcile again; no replacement clone has been submitted.",
      expired: "The attempt has expired. Its outcome is no longer authoritative enough for safe retry. Do not infer no work from missing registrations or jobs.",
      unavailable: "Attempt reconciliation is unavailable. This does not mean the clone was not accepted.",
      accepted: "The original clone was accepted.",
    };
    env.page("Clone Recovery", text(`Attempt ${attempt.id}`) + text(descriptions[attempt.state]) + (actionProblem ? text(actionProblem) : "") + action("reconcile", reconciling ? "Reconciling…" : "Reconcile original attempt") + text("Leaving this view keeps the recovery hint. Discarding form edits cannot cancel or erase an unresolved submission."), { reconcile }, { primaryAction: "reconcile" });
    const button = env.root.querySelector<HTMLButtonElement>('[data-flow="reconcile"]'); if (button) button.disabled = reconciling;
  }
  async function reconcile() {
    const operation = attempt; if (!operation || !operation.owner.current() || reconciling || result) return;
    const request = ++reconciliationGeneration; reconciling = true; renderRecovery();
    try {
      const response = await backend.reconcileCloneAttempt({ attemptId: operation.id });
      if (!owns(operation) || request !== reconciliationGeneration) return;
      if (response.status === "unavailable") {
        if (response.problem.kind === "unauthorized") { env.authLost(); return; }
        operation.state = "unavailable"; actionProblem = response.problem.message;
      } else if (response.value.status === "accepted") accept(operation, response.value.jobId);
      else if (response.value.status === "not-accepted") {
        clearHint(operation); attempt = null; jobId = null;
        actionProblem = "The original attempt was not accepted and has been fenced. Review your options to authorize a new attempt with a new identity.";
      } else { operation.state = response.value.status; actionProblem = ""; }
    } catch { if (owns(operation) && request === reconciliationGeneration) { operation.state = "unavailable"; actionProblem = "Could not reconcile this attempt. No replacement was submitted."; } }
    finally {
      if (request === reconciliationGeneration) { reconciling = false; if (operation.owner.current() && isVisible()) { if (attempt) renderRecovery(); else if (loaded) renderForm(); else show(); } }
    }
  }
  function receive(event: CloneStreamEvent) {
    if (result || !attempt?.owner.current()) return;
    if (event.type === "disconnected") streamProblem = `${event.message} Reconnect to this job; do not submit a new clone.`;
    else if (event.type === "unavailable") {
      unavailableJob = true;
      streamProblem = `${event.reason}: ${event.message}. The job's final result is unknown; this is not proof the checkout failed.`;
      if (event.reason === "unauthorized") { env.authLost(); return; }
    } else {
      const e = event.event; if (e.id <= afterEventId) return; afterEventId = e.id;
      streamProblem = ""; unavailableJob = false;
      if (e.type === "output") output = (output + e.data.output).slice(-64 * 1024);
      else if (e.type === "phase") phase = e.data.phase;
      else { result = e.data; retireReconciliation(); clearHint(attempt); cancelPending = false; env.changed(); }
    }
    updateProgress();
  }
  function connect() {
    const operation = attempt; if (!jobId || !operation || !operation.owner.current()) return;
    unsubscribe?.(); const captured = generation, stream = ++streamGeneration;
    streamProblem = "Reconnecting…"; updateProgress();
    try { unsubscribe = backend.subscribeClone({ jobId, afterEventId }, event => { if (captured === generation && stream === streamGeneration && owns(operation)) receive(event); }); }
    catch { streamProblem = "Could not connect to this job. Retry reconnect; no new clone has been submitted."; updateProgress(); }
  }
  function resultText(r: CloneJobResult): string {
    switch (r.status) {
      case "succeeded": return `${r.target}: registered ${r.running ? "and running" : "stopped"}.`;
      case "clone-failed": return `Clone failed at ${r.target}: ${r.error}. Inspect retained state before retrying.`;
      case "register-failed": return `Checkout at ${r.target} could not be registered: ${r.error}. Inspect the retained folder; do not blindly clone over it.`;
      case "start-failed": return `Start failed: ${r.error}. ${r.workspaceId ? "The configured workspace remains stopped." : "Inspect the checkout for retained state."}`;
      case "cleanup-failed": return `Cleanup failed at ${r.target}: ${r.error}. Files or registration may remain; inspect before retrying.`;
      case "cancelled": return `Clone cancelled at ${r.target}.`;
      case "timed-out": return `Clone timed out (${r.reason ?? "timeout"}) at ${r.target}.`;
    }
  }
  function recoveryPrimary() {
    return result ? result.status === "succeeded" && result.running ? "open" : "workspaceId" in result && result.workspaceId ? "inspect" : "folder" : unavailableJob ? "reconcile" : undefined;
  }
  function promptFields() {
    return '<div class="mh-clone-prompt">' + field("response", "Response to any remote prompt (always masked)", "", "password", 'autocomplete="off"') + action("send", "Send response") + '</div>';
  }
  function renderProgress() {
    if (!isVisible() || !jobId || !attempt?.owner.current()) return;
    env.root.oninput = null; env.root.onchange = null;
    const actions: Record<string, () => unknown> = {
      send: async () => {
        const operation = attempt;
        if (!jobId || !operation || !owns(operation) || result || unavailableJob || phase !== "cloning" || cancelPending || inputPending || inputUncertain) return;
        const input = value(env.root, "response"); clearSecrets(env.root);
        // Persist unresolved response acceptance before dispatch as well. There
        // is no input-reconciliation operation: unknown input cannot be resent.
        operation.hint.inputUncertain = true;
        if (!persist(operation)) { delete operation.hint.inputUncertain; actionProblem = "Recovery storage unavailable. No response was sent."; updateProgress(); return; }
        inputPending = true; inputUncertain = true; actionProblem = ""; updateProgress();
        try {
          const response = await backend.sendCloneInput({ jobId, input }); if (!owns(operation)) return;
          if (response.status === "rejected" && response.problem.kind === "unauthorized") { env.authLost(); return; }
          if (response.status !== "indeterminate") { inputUncertain = false; delete operation.hint.inputUncertain; if (!result) persist(operation); }
          if (response.status !== "completed") actionProblem = response.status === "rejected" ? response.problem.message : `${response.message} Input acceptance unknown; sending further input is blocked.`;
        } catch { if (owns(operation)) actionProblem = "Input acceptance is unknown. Sending further input is blocked; observe progress or cancel the job."; }
        finally { if (owns(operation)) { inputPending = false; updateProgress(); } }
      },
      reconnect: connect,
       cancel: () => { if (jobId && !result && !unavailableJob && !cancelPending) env.confirm("Cancel clone?", text("Request cancellation and cleanup of this job. A job may finish before cancellation wins; wait for its terminal result."), { label: "Cancel clone", run: async () => {
        const operation = attempt; if (!operation || !owns(operation)) return;
        env.sheet.close(); cancelPending = true; updateProgress();
        try { const response = await backend.cancelClone(jobId!); if (!owns(operation)) return;
          if (response.status === "rejected" && response.problem.kind === "unauthorized") { env.authLost(); return; }
          if (response.status !== "completed") { actionProblem = response.status === "rejected" ? response.problem.message : response.message; cancelPending = false; }
          else if (response.value.status === "cleanup-failed") { actionProblem = response.value.message; cancelPending = false; }
          // An acknowledgement, including "terminal", is not the terminal event.
        } catch { if (owns(operation)) { actionProblem = "Cancellation outcome unknown. Reconnect to this job."; cancelPending = false; } }
        if (owns(operation)) updateProgress();
      } }, {}, undefined, { cancelLabel: "Keep cloning" }); },
      inspect: () => { const id = result && "workspaceId" in result ? result.workspaceId : undefined; if (id) env.navigate({ kind: "workspace", id }); },
      open: () => { if (result?.status === "succeeded" && result.running) env.openWorkspace(result.workspaceId); },
      folder: () => { if (result) inspectFolder(result.target); },
      "inspect-hub": env.home,
      reconcile: () => { if (attempt && unavailableJob) { unsubscribe?.(); unsubscribe = null; jobId = null; afterEventId = 0; attempt.state = "unknown"; renderRecovery(); void reconcile(); } },
      edit: () => { if (result) newOptions(); },
    };
    env.page("Clone Progress", text(`Job ${jobId}`) + '<p class="mh-note" data-clone-status></p><pre class="mh-clone-output" aria-label="Clone output"></pre><p class="mh-note" data-clone-problem role="status"></p>' + '<div data-clone-result></div><div data-clone-actions></div>', actions);
    updateProgress();
  }
  function updateProgress() {
    if (!isVisible() || !jobId || !attempt?.owner.current()) return;
    const status = env.root.querySelector("[data-clone-status]"); if (!status) { renderProgress(); return; }
    const results = env.root.querySelector<HTMLElement>("[data-clone-result]")!;
    const state = result ? "terminal" : unavailableJob ? "unavailable" : "active";
    if (results.dataset.state !== state) {
      results.dataset.state = state;
      // Keep the live status/output region and page callback owner intact when
      // completion wins a held command. Only the state-specific controls change.
      const prompt = env.root.querySelector<HTMLElement>(".mh-clone-prompt");
      if (state !== "active") { if (prompt) { clearSecrets(prompt); prompt.remove(); } }
      else if (!prompt) results.insertAdjacentHTML("beforebegin", promptFields());
       results.innerHTML = result ? group("Outcome", infoRows([{ label: "Checkout location", value: result.target, mono: true }, { label: "Result", value: resultText(result), tone: result.status === "succeeded" ? "positive" : "warning" }])) + text("Review the outcome and any retained path before another clone. A new attempt is a distinct operation.") : "";
      const primary = recoveryPrimary();
      env.root.querySelector("[data-clone-actions]")!.innerHTML = result
        ? (result.status === "succeeded" && result.running ? action("inspect", "Workspace information") : "") + (primary !== "folder" ? action("folder", "Inspect checkout location") : "") + action("edit", "Return to clone options")
        : action("reconnect", "Reconnect to this job") + action("cancel", "Cancel clone", true);
      let button = env.root.querySelector<HTMLButtonElement>("[data-clone-primary]");
      if (!primary) button?.remove();
      else {
        if (!button) {
          const toolbar = env.root.querySelector<HTMLElement>(".mh-flow-toolbar") ?? env.root.querySelector<HTMLElement>(".mh-flow-content")!;
          toolbar.insertAdjacentHTML("beforeend", action(primary, ""));
          button = toolbar.lastElementChild as HTMLButtonElement;
           button.dataset.clonePrimary = "";
        }
        button.dataset.flow = primary;
        button.textContent = primary === "open" ? "Open workspace" : primary === "inspect" ? "Workspace information" : primary === "folder" ? "Inspect checkout location" : "Reconcile original attempt";
      }
    }
    status.textContent = result ? resultText(result) : cancelPending ? "Cancellation requested. Waiting for the terminal result…" : `Phase: ${phase}`;
    const outputElement = env.root.querySelector(".mh-clone-output")!; outputElement.textContent = output;
    env.root.querySelector("[data-clone-problem]")!.textContent = [streamProblem, actionProblem, inputUncertain && !inputPending ? "Input acceptance is unknown. Further input is blocked, including after reconnect." : ""].filter(Boolean).join(" ");
    if (phase !== "cloning" || result || unavailableJob) clearSecrets(env.root);
    env.root.querySelectorAll<HTMLInputElement | HTMLButtonElement>('[name="response"], [data-flow="send"], [data-flow="cancel"]').forEach(el => { el.disabled = !!result || unavailableJob || (el.dataset.flow === "cancel" ? cancelPending : phase !== "cloning" || cancelPending || inputPending || inputUncertain); });
  }
  function newOptions() {
    if (!result || !attempt?.owner.current()) return;
    generation++; streamGeneration++; reconciliationGeneration++; clearHint(attempt); attempt = null; reconciling = false; unsubscribe?.(); unsubscribe = null; jobId = null; afterEventId = 0; result = null; unavailableJob = false; output = ""; streamProblem = ""; actionProblem = ""; cancelPending = false; inputPending = false; inputUncertain = false; phase = "Waiting"; loaded = false; show();
  }
  function show() {
    if (attempt && !attempt.owner.current()) reset();
    visible = true;
    if (!attempt && restoreAttempt()) { renderRecovery(); void reconcile(); return; }
    if (jobId) { renderProgress(); return; }
    if (attempt) { renderRecovery(); return; }
    if (loaded) { renderForm(); return; }
    env.page("Clone Repository", text("Loading clone options…"));
    void env.read(() => backend.readCredentials(), credentials => {
      catalog = credentials;
      void env.read(() => backend.readDefaultFolder(), defaults => { if (!draft.dest) draft.dest = defaults.effective; loaded = true; renderForm(); }, show);
    }, show);
  }
  function hide() { visible = false; loaded = false; clearSecrets(env.root); }
  function reset() { generation++; streamGeneration++; reconciliationGeneration++; unsubscribe?.(); unsubscribe = null; attempt = null; reconciling = false; jobId = null; afterEventId = 0; draft = emptyCloneDraft(); catalog = []; result = null; unavailableJob = false; loaded = false; dirty = false; cancelPending = false; inputPending = false; inputUncertain = false; phase = "Waiting"; output = ""; streamProblem = ""; actionProblem = ""; hide(); }
  function back() {
    if (!dirty || jobId || attempt) { env.home(); return; }
    env.confirm("Discard clone draft?", text("The clone options have unsaved edits. No clone has been submitted."), { label: "Discard", run: () => { draft = emptyCloneDraft(); loaded = false; dirty = false; env.sheet.close(); env.home(); } }, {}, () => renderForm(), { cancelLabel: "Keep editing" });
  }
  return { show, hide, reset, back };
}
