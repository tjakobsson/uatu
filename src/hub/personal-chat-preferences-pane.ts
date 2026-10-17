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
  let epoch = 0;
  let saving = false;
  const showPersonalError = (message: string) => { error.textContent = message; error.hidden = !message; };
  const apply = (state: unknown) => {
    const value = state as { version?: unknown; revision?: unknown; autoBackgroundOnSteer?: unknown };
    if (!value || value.version !== 1 || !Number.isSafeInteger(value.revision) || (value.revision as number) < 0 || typeof value.autoBackgroundOnSteer !== "boolean") throw new Error("Personal chat preferences are unavailable.");
    revision = value.revision as number;
    input.checked = value.autoBackgroundOnSteer;
    status.textContent = "Saved";
  };
  const reload = async () => {
    if (saving) return;
    const generation = ++epoch;
    try {
      const response = await fetcher(endpoint, { cache: "no-store" });
      if (!response.ok) throw new Error("Personal chat preferences are unavailable.");
      const state: unknown = await response.json();
      if (generation !== epoch) return;
      apply(state);
      showPersonalError("");
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
    ++epoch;
    input.disabled = button.disabled = true;
    showPersonalError("");
    const selected = input.checked;
    try {
      const response = await fetcher(endpoint, {
        method: "PUT", cache: "no-store", headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: 1, expectedRevision: revision, autoBackgroundOnSteer: selected }),
      });
      const payload = await response.json();
      if (response.status === 409) {
        apply(payload.current);
        showPersonalError("Changed on another device. The current saved value is shown; review it before saving again.");
      } else if (!response.ok) {
        throw new Error("Personal chat preferences could not be saved. Refresh to confirm the current value.");
      } else { apply(payload); }
    } catch (failure) {
      revision = null;
      status.textContent = "Save not confirmed.";
      showPersonalError(failure instanceof Error ? failure.message : "Save not confirmed. Refresh to confirm the current value.");
    } finally {
      saving = false;
      input.disabled = button.disabled = revision === null;
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
