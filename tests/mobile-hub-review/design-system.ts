import { action, check, choiceGroup, destinationRow, emptyState, field, group, infoRows, listRow, select, text } from "../../src/hub/mobile/design-system";
import { advisory, dismissAdvisory, sharedUidKey, showContextualError } from "../../src/hub/mobile/flow-ui";
import { createTaskView } from "../../src/hub/mobile/task-view";
import { createFolderPicker, type FolderPickerEnvironment } from "../../src/hub/mobile/folder-picker";

const root = document.querySelector<HTMLElement>("#reference")!;
const catalog = document.querySelector<HTMLElement>("#catalog")!;
const host = document.querySelector<HTMLElement>("#tasks")!;
// Never share the reviewer's dismissal identity or retain example storage.
const noticeUser = `design-system-example:${crypto.randomUUID()}`;
const example = (id: string, content: string, note: string) => `<div class="reference-example" id="${id}">${content}${text(note)}</div>`;
catalog.innerHTML = `<header class="reference-intro"><h1>Uatu Web design system</h1>${text("Live UI examples, not product Settings. Nothing here saves to a Hub. Use dummy values, never real credentials.")}<nav class="reference-links" aria-label="Reference navigation"><a href="/review/controller">Mock controller</a><a href="/review/design-system/guide">Usage guide</a><a href="#facts">Facts</a><a href="#fields">Fields</a><a href="#tasks-example">Tasks</a></nav>${text("Apple-inspired Web patterns, not native UIKit. Facts, fields and actions are distinct. Appearance follows your device settings.")}</header><div class="reference-grid">
${example("facts", group("Read-only facts", infoRows([
  { label: "Workspace folder", value: "/synthetic/workspaces/a-long-project-name/documentation/reference/architecture-and-operational-notes", mono: true, detail: "Long paths wrap; text remains selectable." },
  { label: "Status", value: "Running", tone: "positive", detail: "Status uses words as well as color." },
  { label: "Protection", value: "Unknown", tone: "warning", detail: "Unavailable facts are not guessed." },
])), "Use label/value facts for observed state. Do not make read-only data look editable.")}
${example("navigation", group("Navigation and actions", destinationRow("local-destination", "Credential details", "shield", "Opens a read-only page", "SSH", "green") + listRow("local-list", "Example workspace", "Object navigation, not a start command", "folder") + action("local-action", "Run local action", "primary") + action("disabled-action", "Unavailable action") + action("confirmation", "Remove example…", true)), "One prominent filled action, secondary tinted commands, and outlined destructive commands. Press and hold to inspect feedback; Tab to inspect focus. Disabled actions cannot run. Chevrons navigate, and selection is not an action.")}
${example("empty-states", group("Empty collection", emptyState("folder", "No subfolders", "Files aren’t shown here. Tap Choose to use this folder.")) + group("Loading, not empty", '<p class="mh-note" role="status">Loading folders…</p>') + group("Error, not empty", '<p class="mh-sheet-error" role="alert">This folder could not be loaded.</p>'), "Only a verified empty collection uses icon, heading and explanation. The real chooser below keeps Choose in its header and offers no filesystem mutations.")}
${example("fields", group("Labeled fields", field("example-name", "Display name", "Reference workspace") + field("example-password", "Dummy password", "", "password", 'autocomplete="off"') + field("example-disabled", "Unavailable field", "Not editable", "text", "disabled") + field("example-invalid", "Invalid folder", "relative/path", "text", 'aria-invalid="true" aria-describedby="invalid-help"') + '<p class="mh-sheet-error" id="invalid-help">Example validation: use an absolute path.</p>' + select("example-select", "Default tool", [{ value: "git", label: "Git" }, { value: "none", label: "None" }], "git")), "Fields collect drafts with persistent labels. Explain invalid input in text; disabled controls cannot be edited. Never enter real secrets in examples.")}
${example("switches", group("Independent switches", check("switch-on", "Follow changes", true) + check("switch-off", "Show hidden files") + check("switch-disabled", "Unavailable switch", true)), "Use a green switch for an independent on/off setting, never for choosing one item from a list. These switches change only their local DOM state.")}
${example("choices", choiceGroup("example-placement", "One of many", "bottom", [["bottom", "Bottom"], ["top", "Top"], ["side", "Side"]]), "Radio choices are mutually exclusive drafts. Choosing one does not save preferences. Use selection state, not a primary-action fill.")}
${example("notice", advisory(noticeUser), "Real credential security notice recipe. Dismiss affects only a unique ephemeral example identity, never the signed-in reviewer. Security warnings explain boundaries rather than promising isolation.")}
${example("review", group("Review changes", infoRows([{ label: "Current", value: "Reference workspace" }, { label: "After", value: "Renamed example" }, { label: "Effect", value: "Display name only; no runtime changes" }]) + action("review", "Review local draft")), "Review separates Current from After and names the effect before confirmation. This is an example model, not live backend state.")}
${example("tasks-example", group("Task presentations", action("editor", "Try editor") + action("pending", "Try local pending / error")), "Editors and reviews replace the full page; only destructive confirmation uses a centered alert dialog. Keyboard entry orients to the heading or safe Cancel, not a field. Escape cancels; focus returns to the trigger. Pending/error here is a timed local simulation, not a real Save.")}
${example("folder-chooser", group("Folder selection", destinationRow("folder-picker", "Choose Hub folder", "folder", "Browse a synthetic, read-only tree")), "The product chooser: rows traverse; header Choose selects the current folder. Cancel discards this local selection. Unavailable demonstrates a static read failure. No real filesystem is read.")}
</div><p class="mh-note" id="local-result" role="status">Examples ready. No backend operations.</p>`;
catalog.querySelector<HTMLInputElement>('[name="switch-disabled"]')!.disabled = true;
catalog.querySelector<HTMLButtonElement>('[data-flow="disabled-action"]')!.disabled = true;
let trigger: HTMLElement | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
let currentTaskCancel: (() => void) | undefined;
let taskGeneration = 0;
const close = () => {
  if (host.querySelector('[aria-busy="true"]')) { task.explainPending(); return; }
  clearTimeout(timer); ++taskGeneration; currentTaskCancel = undefined; task.close(); catalog.inert = false; catalog.hidden = false;
  root.classList.remove("mh-task-active"); trigger?.focus({ preventScroll: true });
};
const cancelTask = () => { if (currentTaskCancel) currentTaskCancel(); else close(); };
const task = createTaskView(host, () => true, cancelTask);
// A narrow test-only adapter: the catalog has no authenticated model or mutation
// backend. Preserve the picker's cancellation callback and presentation ownership.
const pickerEnvironment: FolderPickerEnvironment = {
  sheet: {
    close() { ++taskGeneration; currentTaskCancel = undefined; task.close(); },
  },
  task(title, body, primary, _actions, cancel, options) {
    currentTaskCancel = cancel;
    ++taskGeneration;
    let opened: HTMLElement;
    opened = task.open(title, body, primary ? { label: primary.label, run: () => primary.run(opened) } : undefined, { kind: "editor", ...options });
    return opened;
  },
  current() { const captured = taskGeneration; return () => captured === taskGeneration && !!host.querySelector(".mh-task"); },
  authContext: () => ({ user: noticeUser, current: () => true }),
  authLost: close,
  backend: {
    async browseFolders(path = "/example") {
      const tree: Record<string, { parent: string | null; children: string[] }> = {
        "/example": { parent: null, children: ["projects", "empty", "Unavailable"] },
        "/example/projects": { parent: "/example", children: ["docs"] },
        "/example/projects/docs": { parent: "/example/projects", children: [] },
        "/example/empty": { parent: "/example", children: [] },
      };
      const folder = tree[path];
      if (!folder) return { status: "unavailable", problem: { kind: "unavailable", message: "Static example: this folder is unavailable. Nothing was read from the Hub." } };
      return { status: "available", value: { path, parent: folder.parent, directories: folder.children.map(name => ({ name, git: false, registration: { status: "unregistered" } })) } };
    },
  },
};
const openFolderPicker = createFolderPicker(pickerEnvironment);
function open(kind: string) {
  trigger = document.activeElement as HTMLElement;
  catalog.inert = true; root.classList.add("mh-task-active");
  const confirmation = kind === "confirmation";
  const detail = kind === "local-destination" || kind === "local-list";
  catalog.hidden = !confirmation;
  if (kind === "folder-picker") {
    openFolderPicker("/example", path => {
      document.querySelector("#local-result")!.textContent = `Chosen folder: ${path}. Local only; no backend changes.`;
      close();
    }, () => {
      document.querySelector("#local-result")!.textContent = "Folder selection canceled. No backend changes.";
      close();
    });
    return;
  }
  const body = detail
    ? text("Read-only local example. Navigation does not change anything.") + infoRows(kind === "local-destination" ? [{ label: "Kind", value: "SSH credential" }, { label: "Protection", value: "Unknown", tone: "warning" }] : [{ label: "Name", value: "Reference workspace" }, { label: "Folder", value: "/synthetic/workspaces/reference", mono: true }])
    : confirmation || kind === "review"
    ? text("Local example only. No workspace, credential or backend record will change.") + infoRows([{ label: "Current", value: "Reference workspace" }, { label: "After", value: kind === "review" ? "Renamed example" : "Example removed locally" }, { label: "Effect", value: kind === "review" ? "Display name only; no runtime changes" : "Demonstration only; nothing is deleted" }])
    : text("Local draft only — never sent to a server.") + field("task-name", "Example display name", "Reference workspace") + field("task-secret", "Dummy secret", "", "password", 'autocomplete="off"');
  const title = detail ? (kind === "local-destination" ? "Example credential details" : "Example workspace details") : confirmation ? "Remove local example" : kind === "review" ? "Review local draft" : "Edit local example";
  const opened = task.open(title, body, detail ? undefined : {
    label: kind === "pending" ? "Simulate pending" : confirmation ? "Remove locally" : "Apply locally",
    run() {
      if (kind === "pending") {
        task.busy(true); task.explainPending();
        timer = setTimeout(() => { task.busy(false); showContextualError(opened, "Local simulated failure. Nothing was sent or saved.", { reveal: true }); }, 700);
      } else { document.querySelector("#local-result")!.textContent = "Local example completed. No backend changes."; close(); }
    },
  }, { kind: confirmation ? "confirmation" : "editor", destructive: confirmation, ...(detail ? { cancelLabel: "Back" } : {}) });
}
catalog.addEventListener("click", event => {
  const button = (event.target as HTMLElement).closest<HTMLElement>("[data-flow], [data-action]");
  if (!button || button instanceof HTMLButtonElement && button.disabled) return;
  const key = button.dataset.flow ?? button.dataset.action;
  if (key === "dismiss-advisory") {
    dismissAdvisory(noticeUser, catalog);
    try { localStorage.removeItem(sharedUidKey(noticeUser)); } catch { /* private storage */ }
  } else if (key === "local-action") {
    const result = document.querySelector<HTMLElement>("#local-result")!;
    result.textContent = "Local action ran. No backend changes.";
    result.scrollIntoView({ block: "nearest" });
  } else open(key!);
});
host.addEventListener("click", event => { if ((event.target as HTMLElement).closest('[data-action="cancel-sheet"]') || (event.target as HTMLElement).classList.contains("mh-confirmation-backdrop")) cancelTask(); });
document.addEventListener("keydown", event => task.key(event), true);
