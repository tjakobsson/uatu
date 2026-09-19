// Served directly to hub pages and bundled into the workspace SPA. URLs are
// injected by each host's shared URL helper; this module owns no mount paths.
export function mountNotifications(options) {
  if (document.getElementById("uatu-notifications")) return;
  const dialog = document.createElement("dialog");
  dialog.id = "uatu-notifications";
  dialog.setAttribute("aria-labelledby", "uatu-notifications-title");
  dialog.innerHTML = `<h2 id="uatu-notifications-title">Notifications</h2>
    <p role="status" aria-live="polite"></p><fieldset class="notification-workspaces"><legend>Workspaces on this device</legend>
    <label class="notification-all"><input type="checkbox" name="allWorkspaces"> All workspaces, including ones added later</label></fieldset>
    <label><input type="checkbox" name="needsAnswer" checked> Questions and permission requests</label>
    <label><input type="checkbox" name="completed" checked> Successful turn completion</label>
    <p class="notification-help">Notifications use this browser or installed app's permission. Signing out or expiration of this login stops future notifications.</p>
    <div class="notification-actions"><button type="button" data-enable disabled>Enable notifications</button><button type="button" data-disable hidden>Disable on this device</button><button type="button" data-close>Close</button></div>`;
  const style = document.createElement("style");
  style.textContent = `#uatu-notifications{box-sizing:border-box;width:min(32rem,calc(100vw - 2rem));max-height:calc(100dvh - 2rem);overflow:auto;padding:1.25rem;border:1px solid var(--border-soft,#888);border-radius:12px;background:var(--surface,Canvas);color:var(--text-strong,CanvasText);font:inherit}#uatu-notifications::backdrop{background:#0006}#uatu-notifications label{display:flex;gap:.5rem;align-items:center;margin:.65rem 0}#uatu-notifications input{width:auto;min-height:0}#uatu-notifications .notification-actions{display:flex;flex-wrap:wrap;gap:.5rem}#uatu-notifications button{min-height:40px;padding:.4rem .65rem}#uatu-notifications .notification-help{font-size:.85em;opacity:.8}#uatu-notifications .notification-all{padding-bottom:.4rem;border-bottom:1px solid var(--border-soft,#888)}#uatu-notifications .notification-workspaces label:not(.notification-all):has(input:disabled){opacity:.5}.hub-nav .uatu-notifications-trigger{font:inherit;cursor:pointer}`;
  document.head.append(style);
  document.body.append(dialog);
  const status = dialog.querySelector('[role="status"]');
  const enable = dialog.querySelector("[data-enable]");
  const disable = dialog.querySelector("[data-disable]");
  const workspaces = dialog.querySelector("fieldset");
  const all = dialog.querySelector('[name="allWorkspaces"]');
  // The rule stands in for the list; the ticks stay so turning it off restores them.
  const applyMode = () => { for (const input of workspaces.querySelectorAll('input:not([name="allWorkspaces"])')) input.disabled = all.checked; };
  all.addEventListener("change", applyMode);
  const enabledText = () => all.checked ? "Notifications are enabled for all workspaces on this device." : "Notifications are enabled for this device.";
  let registration;
  let remote;
  let deviceId;
  let busy = false;
  try { deviceId = localStorage.getItem("uatu:push-device") || undefined; } catch {}
  const apiUrl = () => options.apiUrl + (deviceId ? `?device=${encodeURIComponent(deviceId)}` : "");
  const request = async (url, init) => {
    const response = await fetch(url, { ...init, credentials: "same-origin" });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || `Notification request failed (${response.status})`);
    return value;
  };
  const unsupported = () => {
    if (!window.isSecureContext) return "Notifications require HTTPS on this device.";
    if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
      return "Web Push is unavailable here. On iPhone or iPad, add Uatu to the Home Screen and open the installed app.";
    }
    if (Notification.permission === "denied") return "Notifications are blocked. Allow them in your browser or system notification settings.";
    return null;
  };
  const prepare = async () => {
    await options.beforeRegister?.();
    const intended = new URL(options.workerUrl, location.href);
    const root = new URL(".", intended).href;
    const existing = (await navigator.serviceWorker.getRegistrations()).find(item => item.scope === root);
    if (existing) {
      const scripts = [existing.active, existing.waiting, existing.installing].filter(Boolean).map(worker => worker.scriptURL);
      if (!scripts.includes(intended.href)) {
        if (scripts.length && scripts.every(script => script === new URL("sw.js", root).href)) await existing.unregister();
        else throw new Error("Another application's service worker owns this scope. Notification enrollment cannot replace it.");
      }
    }
    const result = await navigator.serviceWorker.register(intended.href, { scope: root, updateViaCache: "none" });
    if (!result.active) await new Promise((resolve, reject) => {
      const worker = result.installing || result.waiting;
      if (!worker) { reject(new Error("Push worker did not start")); return; }
      const timer = setTimeout(() => { worker.removeEventListener("statechange", changed); reject(new Error("Push worker activation timed out")); }, 10_000);
      const changed = () => {
        if (worker.state !== "activated" && worker.state !== "redundant") return;
        clearTimeout(timer); worker.removeEventListener("statechange", changed);
        worker.state === "activated" ? resolve() : reject(new Error("Push worker installation failed"));
      };
      worker.addEventListener("statechange", changed); changed();
    });
    return result;
  };
  const open = async () => {
    if (busy) return;
    dialog.showModal();
    status.textContent = "Loading notification settings...";
    enable.disabled = true;
    try {
      const [state, hub] = await Promise.all([request(apiUrl()), request(options.stateUrl)]);
      remote = state.device;
      disable.hidden = !remote;
      workspaces.querySelectorAll("label:not(.notification-all)").forEach(label => label.remove());
      all.checked = remote?.allWorkspaces ?? false;
      for (const workspace of hub.workspaces) {
        const label = document.createElement("label");
        const input = document.createElement("input");
        input.type = "checkbox"; input.value = workspace.id;
        input.checked = remote ? remote.workspaceIds.includes(workspace.id) : workspace.id === options.workspaceId;
        label.append(input, document.createTextNode(workspace.displayName || workspace.id));
        workspaces.append(label);
      }
      applyMode();
      dialog.querySelector('[name="needsAnswer"]').checked = remote?.needsAnswer ?? true;
      dialog.querySelector('[name="completed"]').checked = remote?.completed ?? true;
      const reason = unsupported();
      if (reason || !state.configured) {
        status.textContent = reason || "The hub needs notifications.contact configured before it can send notifications.";
        if (remote && "Notification" in window && Notification.permission === "denied") {
          await request(apiUrl(), { method: "DELETE" }); remote = null; disable.hidden = true;
        }
        return;
      }
      registration = await prepare();
      const subscribed = await registration.pushManager.getSubscription();
      const publicKey = Uint8Array.from(atob(state.publicKey.replace(/-/g, "+").replace(/_/g, "/")), char => char.charCodeAt(0));
      enable._applicationServerKey = publicKey;
      enable.textContent = remote && subscribed && remote.active ? "Save preferences" : "Enable notifications";
      status.textContent = remote && subscribed && remote.active ? enabledText() : "Choose workspaces and enable notifications for this device.";
      enable.disabled = false;
    } catch (error) { status.textContent = error.message; }
  };
  enable.addEventListener("click", () => {
    if (!registration || busy) return;
    busy = true; enable.disabled = true;
    // Invoke permission synchronously from the click, after worker setup.
    const permission = Notification.permission === "default" ? Notification.requestPermission() : Promise.resolve(Notification.permission);
    void permission.then(async verdict => {
      if (verdict !== "granted") throw new Error(verdict === "denied" ? "Notifications are blocked in browser settings." : "Notification permission was not granted.");
      let subscription = await registration.pushManager.getSubscription();
      if (subscription && !remote && deviceId) {
        await subscription.unsubscribe(); subscription = null; deviceId = undefined;
      }
      subscription ||= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: enable._applicationServerKey });
      const state = await request(options.apiUrl, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({
        ...(deviceId ? { id: deviceId } : {}), subscription: subscription.toJSON(),
        allWorkspaces: all.checked,
        workspaceIds: [...workspaces.querySelectorAll('input:checked:not([name="allWorkspaces"])')].map(input => input.value),
        needsAnswer: dialog.querySelector('[name="needsAnswer"]').checked,
        completed: dialog.querySelector('[name="completed"]').checked,
      }) });
      remote = state.device; deviceId = remote.id;
      try { localStorage.setItem("uatu:push-device", deviceId); } catch {}
      status.textContent = all.checked ? "Notification preferences saved: all workspaces on this device." : "Notification preferences saved for this device.";
      disable.hidden = false; enable.textContent = "Save preferences";
    }).catch(error => { status.textContent = error.message; }).finally(() => { busy = false; enable.disabled = Boolean(unsupported()); });
  });
  disable.addEventListener("click", async () => {
    if (busy || !deviceId) return;
    busy = true; disable.disabled = true;
    try {
      await request(apiUrl(), { method: "DELETE" });
      const current = registration || ("serviceWorker" in navigator ? await navigator.serviceWorker.getRegistration(options.workerUrl) : null);
      await (await current?.pushManager.getSubscription())?.unsubscribe();
      deviceId = undefined; remote = null;
      try { localStorage.removeItem("uatu:push-device"); } catch {}
      status.textContent = "Notifications are disabled on this device.";
      disable.hidden = true; enable.textContent = "Enable notifications";
    } catch (error) { status.textContent = error.message; }
    finally { busy = false; disable.disabled = false; }
  });
  dialog.querySelector("[data-close]").addEventListener("click", () => dialog.close());
  for (const host of document.querySelectorAll(options.hosts)) {
    const button = document.createElement("button");
    const rail = host.classList.contains("sidebar-rail");
    const sidebar = host.classList.contains("sidebar-notifications-row");
    button.type = "button"; button.className = "uatu-notifications-trigger";
    if (rail || sidebar) {
      button.classList.add(rail ? "rail-button" : "sidebar-notifications-button");
      button.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3.5 6a4.5 4.5 0 0 1 9 0v3l1.25 2H2.25L3.5 9V6ZM6 13a2 2 0 0 0 4 0" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      if (sidebar) button.append(document.createTextNode("Notifications"));
    } else button.textContent = "Notifications";
    button.setAttribute("aria-label", "Notifications"); button.title = "Notifications";
    button.setAttribute("aria-haspopup", "dialog"); button.setAttribute("aria-controls", dialog.id);
    button.addEventListener("click", open); host.append(button);
    host.hidden = false;
  }
  // Reconcile an existing registration on return, without prompting or
  // silently authorizing a different login. Explicit re-enable binds a login.
  if (deviceId && "serviceWorker" in navigator && "Notification" in window) {
    void request(apiUrl()).then(async state => {
      if (Notification.permission === "denied" && state.device) await request(apiUrl(), { method: "DELETE" });
      else if (Notification.permission === "granted" && state.device?.active) await prepare();
    }).catch(() => {});
  }
}
