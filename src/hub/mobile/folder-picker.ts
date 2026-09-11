import { escapeHtml as esc } from "../../shared/html";
import type { FolderListing, MobileHubBackend } from "./backend";
import { action, listRow, text, type FlowEnvironment } from "./flow-ui";
import { mobileHubIcon } from "./icons";
import { emptyState } from "./design-system";

const folderLabel = (path: string) => path.split("/").filter(Boolean).at(-1) ?? "Hub folders";
const location = (path?: string) => `<div class="mh-folder-location" aria-label="Current folder path"><span>On this Hub</span>${path ? `<code>${esc(path)}</code>` : ""}</div>`;
const parentAction = (key: string, path: string, recovery = false) => `<button type="button" class="mh-folder-parent-link" data-flow="${key}" aria-label="${esc(`${recovery ? "Return to folder" : "Parent folder"}: ${path}`)}">${mobileHubIcon("back")}<span>${esc(folderLabel(path))}</span></button>`;

/** A remote-Hub read-only selection task. No filesystem mutation capability. */
export type FolderPickerEnvironment = Pick<FlowEnvironment, "task" | "current" | "authContext" | "authLost"> & { sheet: Pick<FlowEnvironment["sheet"], "close">; backend: Pick<MobileHubBackend, "browseFolders"> };
export function createFolderPicker(env: FolderPickerEnvironment) {
  let generation = 0;
  return function open(path: string | undefined, choose: (path: string, listing: FolderListing) => void, cancel: () => void) {
    const owner = env.authContext();
    let finished = false;
    let lastValid: FolderListing | undefined;
    const close = () => { if (finished) return; finished = true; ++generation; env.sheet.close(); cancel(); };
    function navigate(path?: string) {
      const request = ++generation;
      let ready: FolderListing | undefined;
      const root = env.task("Choose Folder", text("Loading folders…"), { label: "Choose", run: () => {
        if (!ready || !current() || finished || request !== generation || !owner.current()) return;
        finished = true; ++generation; env.sheet.close(); choose(ready.path, ready);
      } }, { "flow-back": close }, close);
      root.classList.add("mh-folder-picker"); root.setAttribute("aria-label", "Choose Folder");
      const primary = root.querySelector<HTMLButtonElement>('[data-action="commit-sheet"]');
      if (primary) { primary.disabled = true; primary.dataset.flow = "choose"; }
      const body = root.querySelector<HTMLElement>(".mh-sheet-body")!;
      const current = env.current();
      const active = () => !finished && request === generation && owner.current() && current();
      const recovery = () => {
        if (!lastValid) return "";
        return `<div class="mh-folder-parent">${parentAction("last-valid", lastValid.path, true)}</div>`;
      };
      const bindBody = () => {
        body.onclick = event => {
          const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-flow]");
          if (!button || !body.contains(button) || !active()) return;
          event.stopPropagation();
          if (button.dataset.flow === "retry") navigate(path);
          else if (button.dataset.flow === "last-valid" && lastValid) navigate(lastValid.path);
          else if (button.dataset.flow === "up" && ready?.parent) navigate(ready.parent);
          else if (button.dataset.flow?.startsWith("folder-") && ready) {
            const child = ready.directories[Number(button.dataset.flow.slice(7))];
            if (child) navigate(`${ready.path.replace(/\/$/, "")}/${child.name}`);
          }
        };
      };
      body.innerHTML = `${location(path)}<p role="status">Loading folders…</p>${recovery()}`; bindBody();
      const error = (message: string) => {
        ready = undefined;
        body.innerHTML = `${location(path)}<div class="mh-folder-error" role="alert">${text(message)}${action("retry", "Retry")}</div>${recovery()}`;
      };
      void (async () => {
        try {
          const result = await env.backend.browseFolders(path);
          if (!active()) return;
          if (result.status !== "available") {
            if (result.problem.kind === "unauthorized") { finished = true; ++generation; env.authLost(); return; }
            error(result.problem.kind === "rate-limited" ? `${result.problem.message} Retry after ${result.problem.retryAfterSeconds} seconds.` : result.problem.message); return;
          }
          ready = lastValid = result.value;
          const heading = root.querySelector("h1"); if (heading) { heading.textContent = folderLabel(ready.path); heading.setAttribute("title", ready.path); }
          body.innerHTML = `${location(ready.path)}<nav class="mh-folder-parent" aria-label="Parent folder">${ready.parent ? parentAction("up", ready.parent) : ""}</nav><div class="mh-folder-list">${ready.directories.map((directory, i) => listRow(`folder-${i}`, directory.name, "", "folder")).join("")}</div>${ready.directories.length ? "" : `<div class="mh-folder-empty">${emptyState("folder", "No subfolders", "Files aren’t shown here. Tap Choose to use this folder.")}</div>`}`;
          if (primary) primary.disabled = false;
        } catch { if (active()) error("This folder could not be loaded."); }
      })();
    }
    navigate(path);
  };
}
