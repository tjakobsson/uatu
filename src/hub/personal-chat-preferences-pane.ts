// Self-contained for the server-rendered Settings script, like the agent
// accounts pane. Browser storage never supplies authoritative policy.
export function createPersonalChatPreferencesPane(document: Document, window: Window, fetcher: typeof fetch = fetch) {
  const form = document.querySelector<HTMLFormElement>("#personal-chat-preferences-form")!;
  const input = document.querySelector<HTMLInputElement>("#personal-chat-auto-background")!;
  const button = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  const status = document.querySelector<HTMLElement>("#personal-chat-preferences-status")!;
  const error = document.querySelector<HTMLElement>("#personal-chat-preferences-error")!;
  const endpoint = "/api/hub/settings/chat-preferences";
  let revision: number | null = null;
  let baseline: { revision: number; checked: boolean } | null = null;
  let conflictSaved: boolean | null = null;
  let epoch = 0;
  let saving = false;
  const showPersonalError = (message: string) => { conflictSaved = null; error.textContent = message; error.hidden = !message; };
  const isDirty = () => baseline !== null && input.checked !== baseline.checked;
  const showConflictGuidance = () => {
    if (conflictSaved === null) return;
    error.textContent = `Changed on another device. The saved setting is ${conflictSaved ? "ON" : "OFF"}. ${input.checked !== conflictSaved ? "Your unsaved choice is kept; review it and Save to apply." : "Your choice already matches the saved setting."}`;
    error.hidden = false;
  };
  const showSelectionStatus = () => {
    status.textContent = isDirty() ? "Unsaved changes — Save to apply." : "Saved";
    showConflictGuidance();
  };
  input.onchange = () => { if (!saving && revision !== null) showSelectionStatus(); };
  const apply = (state: unknown, preserveDraft = false, refreshing = false) => {
    const value = state as { version?: unknown; revision?: unknown; autoBackgroundOnSteer?: unknown };
    if (!value || value.version !== 1 || !Number.isSafeInteger(value.revision) || (value.revision as number) < 0 || typeof value.autoBackgroundOnSteer !== "boolean") throw new Error("Personal chat preferences are unavailable.");
    // A background refresh must not silently rebase a draft onto a competing
    // revision. Keep its original revision so Save still requires conflict review.
    if (refreshing && preserveDraft && baseline && value.revision !== baseline.revision && input.checked !== value.autoBackgroundOnSteer) {
      revision = baseline.revision;
      conflictSaved = value.autoBackgroundOnSteer;
      showSelectionStatus();
      return true;
    }
    revision = value.revision as number;
    conflictSaved = null;
    baseline = { revision, checked: value.autoBackgroundOnSteer };
    if (!preserveDraft) input.checked = value.autoBackgroundOnSteer;
    showSelectionStatus();
    return false;
  };
  const reload = async () => {
    if (saving) return;
    const generation = ++epoch;
    try {
      const response = await fetcher(endpoint, { cache: "no-store" });
      if (!response.ok) throw new Error("Personal chat preferences are unavailable.");
      const state: unknown = await response.json();
      if (generation !== epoch) return;
      const changed = apply(state, isDirty(), true);
      if (!changed) showPersonalError("");
      input.disabled = button.disabled = false;
    } catch {
      if (generation !== epoch) return;
      revision = null;
      input.disabled = button.disabled = true;
      status.textContent = "Personal chat preferences are unavailable.";
      showPersonalError("Personal chat preferences are unavailable on this page; it cannot confirm the saved setting. Existing saved preferences may still apply to steering in other tabs or devices. Refresh to confirm before changing the setting.");
    }
  };
  form.onsubmit = async event => {
    event.preventDefault();
    if (saving || revision === null) return;
    saving = true;
    const generation = ++epoch;
    input.disabled = button.disabled = true;
    status.textContent = "Saving…";
    showPersonalError("");
    const selected = input.checked;
    try {
      const response = await fetcher(endpoint, {
        method: "PUT", cache: "no-store", headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: 1, expectedRevision: revision, autoBackgroundOnSteer: selected }),
      });
      const payload = await response.json();
      if (generation !== epoch) return;
      if (response.status === 409) {
        apply(payload.current, true);
        conflictSaved = baseline!.checked;
        showConflictGuidance();
      } else if (!response.ok) {
        throw new Error("Personal chat preferences could not be saved. Refresh to confirm the current value.");
      } else { apply(payload, input.checked !== selected); }
    } catch (failure) {
      if (generation !== epoch) return;
      revision = null;
      status.textContent = "Save not confirmed.";
      showPersonalError(failure instanceof Error ? failure.message : "Save not confirmed. Refresh to confirm the current value.");
    } finally {
      saving = false;
      if (generation === epoch) input.disabled = button.disabled = revision === null;
    }
  };
  const resume = () => { void reload(); };
  const visible = () => { if (document.visibilityState === "visible") resume(); };
  return {
    reload,
    start() {
      window.addEventListener("focus", resume);
      window.addEventListener("online", resume);
      window.addEventListener("pageshow", resume);
      document.addEventListener("visibilitychange", visible);
      return reload();
    },
    stop() {
      ++epoch;
      window.removeEventListener("focus", resume);
      window.removeEventListener("online", resume);
      window.removeEventListener("pageshow", resume);
      document.removeEventListener("visibilitychange", visible);
    },
  };
}
