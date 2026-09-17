// Optional server-rendered lifecycle presentation inside the workspace picker.
// These DOM-only functions are also embedded in the server-rendered dashboard;
// both entry points deliberately use the same menu and popup controller.
export function openWorktreeFork(target: string, anchor: HTMLElement, returnFocus: HTMLElement = anchor): void {
  const menu = document.createElement("div");
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", "Create worktree");
  menu.style.cssText = "position:fixed;z-index:2000;width:232px;padding:6px;border:1px solid var(--border-medium,#888);border-radius:10px;background:var(--surface,#fff);color:var(--text-strong,inherit);box-shadow:0 8px 32px #0003;font:14px system-ui";
  anchor.setAttribute("aria-expanded", "true");
  const controller = new AbortController();
  const close = (restore = false) => { controller.abort(); menu.remove(); anchor.setAttribute("aria-expanded", "false"); if (restore) anchor.focus(); };
  for (const [mode, label] of [["new", "New branch / worktree"], ["existing", "Existing branch"]]) {
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("role", "menuitem");
    button.textContent = label!;
    button.style.cssText = "display:block;text-align:left;width:100%;min-height:44px;padding:10px;border:0;border-radius:6px;background:transparent;color:inherit;font:inherit;cursor:pointer";
    button.addEventListener("focus", () => button.style.background = "var(--surface-hover,#8882)");
    button.addEventListener("blur", () => button.style.background = "transparent");
    button.onclick = () => { const url = new URL(target, location.href); url.searchParams.set("view", "create"); url.searchParams.set("mode", mode!); close(); openWorktreePicker(url.href, returnFocus); };
    menu.append(button);
  }
  document.body.append(menu);
  const rect = anchor.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(rect.right - 232, innerWidth - 240))}px`;
  menu.style.top = `${Math.max(8, Math.min(rect.bottom + 4, innerHeight - menu.offsetHeight - 8))}px`;
  menu.querySelector("button")!.focus();
  menu.addEventListener("keydown", event => {
    const buttons = [...menu.querySelectorAll("button")];
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); }
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault(); const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      buttons[event.key === "Home" ? 0 : event.key === "End" ? 1 : (index + 1) % 2]!.focus();
    }
    if (event.key === "Tab") close();
  });
  document.addEventListener("pointerdown", event => { if (!menu.contains(event.target as Node)) close(); }, { signal: controller.signal });
  window.addEventListener("pagehide", () => close(), { signal: controller.signal });
}

export function bindWorktreeBranches(root: ParentNode): void {
  const input = root.querySelector<HTMLInputElement>("[data-branch-search]");
  if (!input) return;
  const options = [...root.querySelectorAll<HTMLElement>('[role="option"]')];
  options.forEach(option => option.setAttribute("aria-label", `${option.querySelector("span")!.textContent} ${option.querySelector("small")!.textContent}`));
  const selected = root.querySelector<HTMLInputElement>('[name="selection"]')!;
  const submit = root.querySelector<HTMLButtonElement>('[data-create]')!;
  const empty = root.querySelector<HTMLElement>('[data-branch-empty]')!;
  const listbox = root.querySelector<HTMLElement>('[role="listbox"]')!;
  const expand = (open: boolean) => {
    listbox.hidden = !open;
    input.setAttribute("aria-expanded", String(open));
    if (!open) input.removeAttribute("aria-activedescendant");
  };
  let active = -1;
  const visible = () => options.filter(option => !option.hidden);
  const activate = (index: number) => {
    const list = visible(); active = list.length ? (index + list.length) % list.length : -1;
    options.forEach(option => option.removeAttribute("data-active"));
    const option = list[active];
    if (option) { option.setAttribute("data-active", "true"); input.setAttribute("aria-activedescendant", option.id); option.scrollIntoView({ block: "nearest" }); }
    else input.removeAttribute("aria-activedescendant");
  };
  const choose = (option: HTMLElement) => {
    selected.value = option.dataset.value!;
    input.value = option.dataset.search!;
    options.forEach(item => item.setAttribute("aria-selected", String(item === option)));
    submit.disabled = false;
    // A committed value is not a filter. Reopening allows reviewing all refs.
    options.forEach(item => item.hidden = false);
    empty.hidden = true;
    expand(false);
  };
  const filter = () => {
    const query = input.value.toLocaleLowerCase().replace(/\s/g, "");
    for (const option of options) {
      let cursor = 0;
      for (const char of option.dataset.search!.toLocaleLowerCase()) if (char === query[cursor]) cursor++;
      option.hidden = cursor < query.length;
    }
    empty.hidden = visible().length > 0;
    expand(true);
    activate(0);
  };
  input.addEventListener("input", () => {
    selected.value = "";
    options.forEach(option => option.setAttribute("aria-selected", "false"));
    submit.disabled = true;
    filter();
  });
  const reopen = () => {
    if (selected.value) { options.forEach(option => option.hidden = false); empty.hidden = true; expand(true); activate(options.findIndex(option => option.dataset.value === selected.value)); }
    else filter();
  };
  input.addEventListener("focus", reopen);
  input.addEventListener("click", reopen);
  input.addEventListener("keydown", event => {
    if (event.key === "Escape" && !listbox.hidden) { event.preventDefault(); event.stopPropagation(); expand(false); }
    if (["ArrowDown", "ArrowUp"].includes(event.key)) { event.preventDefault(); if (listbox.hidden) reopen(); else activate(active + (event.key === "ArrowDown" ? 1 : -1)); }
    if (event.key === "Enter") { event.preventDefault(); if (!listbox.hidden) { const option = visible()[active]; if (option) choose(option); } }
  });
  options.forEach(option => {
    option.addEventListener("pointerdown", event => event.preventDefault());
    option.addEventListener("click", () => { input.focus(); choose(option); });
  });
  input.addEventListener("blur", () => expand(false));
  const initial = options.find(option => option.dataset.value === selected.value);
  if (initial) choose(initial);
  else { selected.value = ""; filter(); }
  submit.disabled = !selected.value;
}
// The caller supplies a same-origin presentation URL; this module owns only
// navigation, focus and submission, never Git or workspace startup policy.
export function openWorktreePicker(target: string, returnFocus: HTMLElement): void {
  let endpoint: URL;
  try { endpoint = new URL(target, location.href); } catch { return; }
  if (endpoint.origin !== location.origin) return;
  const dialog = document.createElement("dialog");
  dialog.setAttribute("aria-label", "Repository worktrees");
  dialog.style.cssText = "width:min(860px,calc(100vw - 24px));max-height:calc(100dvh - 48px - var(--titlebar-inset,0px));margin:calc(24px + var(--titlebar-inset,0px)) auto 24px;padding:0;border:1px solid var(--border-medium);border-radius:12px;background:var(--surface);color:var(--text-strong);box-shadow:0 16px 64px #0004";
  const host = document.createElement("div");
  dialog.append(host);
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `<style>:host{font:14px system-ui}header{position:sticky;top:0;display:flex;justify-content:space-between;padding:12px;background:var(--surface,#fff);z-index:1}main{padding:16px}button,input,select{font:inherit;padding:8px;max-width:100%;box-sizing:border-box}a{color:inherit}button,a{cursor:pointer}[hidden]{display:none!important}</style><header><strong>Repository worktrees</strong><button type="button" aria-label="Close worktrees">Close</button></header><main aria-live="polite"></main>`;
  const main = root.querySelector("main")!;
  const close = () => dialog.close();
  root.querySelector("header button")!.addEventListener("click", close);
  let revision = 0;
  let busy = false;
  dialog.addEventListener("cancel", event => { if (busy) event.preventDefault(); });
  let currentView = endpoint;
  const controller = new AbortController();
  window.addEventListener("pagehide", close, { signal: controller.signal });
  dialog.addEventListener("close", () => {
    controller.abort();
    revision++;
    dialog.remove();
    returnFocus.focus();
  }, { once: true });
  function syncMode() {
    const mode = main.querySelector<HTMLSelectElement>("[name=mode]");
    if (!mode) return;
    main.querySelectorAll<HTMLElement>("[data-modes]").forEach(group => {
      group.hidden = !group.dataset.modes!.split(" ").includes(mode.value);
      group.querySelectorAll<HTMLInputElement>("input,select").forEach(input => input.disabled = Boolean(group.hidden));
    });
  }
  async function load(url: URL) {
    if (url.origin !== endpoint.origin || url.pathname !== endpoint.pathname) return;
    const request = ++revision;
    currentView = url;
    url.searchParams.set("fragment", "1");
    main.setAttribute("aria-busy", "true");
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) throw new Error("Worktree inventory unavailable. Close and retry.");
      const content = await response.text();
      if (request !== revision) return;
       main.innerHTML = content;
      // Presentation responses cannot execute scripts through this surface.
      main.querySelectorAll("script").forEach(script => script.remove());
      syncMode();
       const compact = Boolean(main.querySelector("[data-creation], [data-compact]"));
      dialog.style.width = compact ? "min(420px,calc(100vw - 24px))" : "min(860px,calc(100vw - 24px))";
      root.querySelector<HTMLElement>("header")!.hidden = compact;
      dialog.setAttribute("aria-label", compact ? main.querySelector("h2")!.textContent! : "Repository worktrees");
      bindWorktreeBranches(main);
       (main.querySelector<HTMLElement>("[role=alert]") ?? (compact ? main.querySelector<HTMLElement>('input:not([type=hidden]), [data-cancel]') : null) ?? main.querySelector<HTMLElement>("h2"))?.focus();
    } catch (error) {
      if (!controller.signal.aborted && request === revision) {
        main.replaceChildren(Object.assign(document.createElement("p"), { textContent: String(error) }));
        main.firstElementChild?.setAttribute("role", "alert");
      }
    } finally {
      if (request === revision) main.removeAttribute("aria-busy");
    }
  }
  window.addEventListener("uatu:worktrees-invalidated", () => {
    if (!busy && (!currentView.searchParams.get("view") || currentView.searchParams.get("view") === "inventory")) void load(currentView);
  }, { signal: controller.signal });
  main.addEventListener("change", syncMode);
  main.addEventListener("click", event => {
    if ((event.target as Element).closest("[data-cancel]")) { if (!busy) close(); return; }
    const link = (event.target as Element).closest<HTMLAnchorElement>("a");
    if (!link) return;
    const url = new URL(link.href);
    if (url.origin === endpoint.origin && url.pathname === endpoint.pathname) {
      event.preventDefault();
      if (!busy) void load(url);
    } else if (link.hasAttribute("data-opening")) {
      if (busy) { event.preventDefault(); return; }
      busy = true;
      const status = main.querySelector<HTMLElement>("#operation-status")!;
      status.hidden = false;
      status.textContent = "Opening workspace…";
      status.focus();
    }
  });
  main.addEventListener("submit", async event => {
    const form = event.target as HTMLFormElement;
    event.preventDefault();
    if (busy) return;
    const url = new URL(form.action);
    if (url.origin !== endpoint.origin || !url.pathname.startsWith(`${endpoint.pathname}/`)) return;
    const data = new FormData(form);
    if (url.pathname.endsWith("/fetch")) {
      const creation = main.querySelector<HTMLFormElement>('form[action$="/create"]');
      if (creation) for (const [key, value] of new FormData(creation)) data.set(key, value);
    }
    busy = true;
    main.querySelectorAll<HTMLButtonElement>("button").forEach(button => button.disabled = true);
    const status = main.querySelector<HTMLElement>("#operation-status")!;
    status.hidden = false;
    status.textContent = form.dataset.pending ?? "Working…";
    status.focus();
    try {
      const response = await fetch(url, { method: "POST", body: data, signal: controller.signal });
      if (!response.ok) throw new Error("Request failed. Nothing was retried automatically.");
       const result = await response.json() as { redirect: string; completion?: { message: string; id?: string; source: string; deleted?: string } };
       const destination = new URL(result.redirect, location.href);
       if (destination.origin !== endpoint.origin) throw new Error("Invalid navigation destination");
       if (result.completion) {
         close();
         window.dispatchEvent(new Event("uatu:worktrees-changed"));
         const completion = result.completion;
         if (completion.deleted && location.pathname.startsWith(`/s/${encodeURIComponent(completion.deleted)}/`)) {
           location.assign(`/s/${encodeURIComponent(completion.source)}/`);
           return;
         }
         showWorktreeConfirmation(completion.message, completion.id ? async button => {
           button.disabled = true;
           button.textContent = "Opening…";
           try {
             const body = new FormData(); body.set("id", completion.id!); body.set("source", completion.source);
             const response = await fetch(`${endpoint.pathname}/start`, { method: "POST", body });
             if (!response.ok) throw new Error("Could not open workspace. Retry Open.");
             const next = new URL((await response.json() as { redirect: string }).redirect, location.href);
             if (next.origin !== endpoint.origin) throw new Error("Invalid navigation destination");
             if (next.pathname === endpoint.pathname) { button.closest("[data-worktree-confirmation]")?.remove(); openWorktreePicker(next.href, returnFocus); }
             else if (/^\/s\/[^/]+\/$/.test(next.pathname)) location.assign(next.href);
           } catch (error) {
             button.parentElement!.querySelector("span")!.textContent = String(error);
             button.disabled = false; button.textContent = "Open";
           }
         } : undefined);
       }
       else if (destination.pathname === endpoint.pathname) await load(destination);
      else if (/^\/s\/[^/]+\/$/.test(destination.pathname)) location.assign(destination.href);
    } catch (error) {
      if (!controller.signal.aborted) {
        status.setAttribute("role", "alert");
        status.textContent = String(error);
      }
    } finally {
      busy = false;
      main.querySelectorAll<HTMLButtonElement>("button").forEach(button => button.disabled = button.hasAttribute("data-create") && Boolean(main.querySelector('[name="selection"]')) && !main.querySelector<HTMLInputElement>('[name="selection"]')!.value);
    }
  });
  document.body.append(dialog);
  dialog.showModal();
  void load(endpoint);
}

export function showWorktreeConfirmation(message: string, open?: (button: HTMLButtonElement) => void): void {
  document.querySelector("[data-worktree-confirmation]")?.remove();
  const notice = document.createElement("div");
  notice.dataset.worktreeConfirmation = "";
  notice.setAttribute("role", "status");
  notice.style.cssText = "position:fixed;z-index:2100;bottom:calc(64px + var(--tab-bar-total,env(safe-area-inset-bottom)));left:50%;transform:translateX(-50%);max-width:calc(100vw - 32px);display:flex;align-items:center;gap:12px;padding:10px 14px;border:1px solid var(--border-medium,#888);border-radius:8px;background:var(--surface,#fff);color:var(--text-strong,inherit);box-shadow:0 4px 24px #0003;font:14px system-ui";
  const label = document.createElement("span"); label.textContent = message; label.style.overflowWrap = "anywhere"; notice.append(label);
  if (open) { const button = document.createElement("button"); button.type = "button"; button.textContent = "Open"; button.style.cssText = "min-height:44px;padding:8px;border:0;background:transparent;color:inherit;cursor:pointer;font:inherit"; button.onclick = () => open(button); notice.append(button); }
  const dismiss = document.createElement("button"); dismiss.type = "button"; dismiss.textContent = "×"; dismiss.setAttribute("aria-label", "Dismiss confirmation"); dismiss.style.cssText = "min-height:44px;border:0;background:transparent;color:inherit;font:inherit;cursor:pointer"; dismiss.onclick = () => notice.remove(); notice.append(dismiss);
  document.body.append(notice);
}

export const worktreePickerScript = [bindWorktreeBranches, showWorktreeConfirmation, openWorktreePicker, openWorktreeFork].map(fn => fn.toString()).join(";\n");
