import type { FolderListing, OnboardingOutcome } from "./backend";
import { normalizeProviderHost, type PublicCredentialDto } from "../credential-types";
import type { AuthenticationSelection } from "../onboarding";
import { absolute, action, check, checked, displayName, field, folderName, group, infoRows, listRow, select, text, value, type FlowEnvironment } from "./flow-ui";
import { credentialChoices, validateSelected } from "./workspace-flows";
import { createFolderPicker } from "./folder-picker";

export type ConfigurationDraft = { displayName: string; folderName: string; authentication: AuthenticationSelection[]; signing: string; start: boolean; init: boolean };
export const technicalField = (name: string, label: string, value = "", attrs = "") => field(name, label, value, "text", `autocapitalize="none" autocorrect="off" spellcheck="false" inputmode="${name === "host" || name === "url" ? "url" : "text"}" ${attrs}`);
export function configurationFacts(catalog: PublicCredentialDto[], authentication: AuthenticationSelection[], signing: string | null): string {
  const name = (id: string) => catalog.find(c => c.id === id)?.name ?? "Unavailable credential";
  return group("Git authentication after setup", authentication.length ? authentication.map(a => infoRows([{ label: "Host", value: a.host, mono: true }, { label: "Credential", value: name(a.credentialId) }])).join("") : infoRows([{ label: "Credential", value: "None" }])) + group("Commit signing after setup", infoRows([{ label: "Credential", value: signing ? name(signing) : "None" }]));
}
function authenticationRow(catalog: PublicCredentialDto[], auth?: AuthenticationSelection) {
  return `<div data-auth-row>${select("authentication", "Git authentication", credentialChoices(catalog, "authentication", auth?.credentialId, "None"), auth?.credentialId)}${technicalField("host", "Authentication host", auth?.host ?? "")}</div>`;
}
export function configurationFields(catalog: PublicCredentialDto[], draft: ConfigurationDraft): string {
  return `<div data-auth-list>${(draft.authentication.length ? draft.authentication : [undefined]).map(auth => authenticationRow(catalog, auth)).join("")}</div>${action("add-auth-host", "Add another authentication host")}` + select("signing", "Commit signing", credentialChoices(catalog, "signing", draft.signing, "None"), draft.signing) + check("start", "Start after configuration", draft.start);
}
export function readConfiguration(root: HTMLElement, catalog: PublicCredentialDto[], draft: ConfigurationDraft): ConfigurationDraft {
  const signing = value(root, "signing"); validateSelected(catalog, signing, "signing");
  const authentication = [...root.querySelectorAll<HTMLElement>("[data-auth-row]")].flatMap(row => {
    const credentialId = value(row, "authentication"), host = value(row, "host").trim();
    validateSelected(catalog, credentialId, "authentication");
    if (credentialId && !host) throw new Error("Enter an authentication host.");
    return credentialId ? [{ credentialId, host: normalizeProviderHost(host) }] : [];
  });
  if (new Set(authentication.map(a => a.host)).size !== authentication.length) throw new Error("Choose only one authentication credential per host.");
  return { ...draft, authentication, signing, start: checked(root, "start") };
}
export function bindAuthenticationHost(root: HTMLElement, catalog: PublicCredentialDto[] = []) {
  const update = () => root.querySelectorAll<HTMLElement>("[data-auth-row]").forEach(row => {
    const authentication = row.querySelector<HTMLSelectElement>('[name="authentication"]');
    const host = row.querySelector<HTMLInputElement>('[name="host"]');
    if (host && authentication) {
      const context = () => { host.disabled = !authentication.value; host.placeholder = authentication.value ? "github.com" : "Select a credential first"; host.setAttribute("aria-description", authentication.value ? "Host for the selected Git authentication credential" : "Choose a Git authentication credential first to edit its host"); };
      context(); authentication.onchange = context;
    }
  });
  root.querySelector('[data-flow="add-auth-host"]')?.addEventListener("click", () => {
    root.querySelector("[data-auth-list]")?.insertAdjacentHTML("beforeend", authenticationRow(catalog)); update();
  }); update();
}
export function createOnboardingFlows(env: FlowEnvironment) {
  const { backend } = env;
  const pickFolder = createFolderPicker(env);
  let browseGeneration = 0;
  function add() {
    env.page("Add Workspace", group("Choose a starting point", listRow("existing", "Existing folder", "Register a folder already on this Hub") + listRow("create", "Create workspace", "Create a folder and initialize Git") + listRow("clone", "Clone repository", "Check out a remote repository")) + group("Folders on this Hub", listRow("folders", "Manage folders", "Browse, create, rename, or remove folders")), {
      existing: () => pickFolder(undefined, (_path, listing) => loadConfiguration(listing), add), create: () => newWorkspace(), clone: () => env.navigate({ kind: "clone" }),
      folders: () => env.navigate({ kind: "folders" }),
    });
  }
  function outcome(result: OnboardingOutcome) {
    env.sheet.close(); env.changed();
    if (result.status === "failed") {
      env.page("Configuration needs attention", group("Outcome", infoRows([{ label: "Problem", value: result.message, detail: result.code, tone: "warning" }, ...(result.retainedPath ? [{ label: "Folder retained", value: result.retainedPath, mono: true, detail: "Use Existing folder to recover; creating another workspace is not an automatic retry." }] : []), ...(result.committedEntry ? [{ label: "Registration committed", value: result.committedEntry.displayName, detail: "Do not create a duplicate registration." }] : [])])) + (result.retainedPath ? action("recover", "Inspect retained folder") : "") + (result.committedEntry ? action("workspace", "Inspect registered workspace") : ""), {
        recover: () => browse(result.retainedPath, undefined, () => outcome(result)), workspace: () => { if (result.committedEntry) env.navigate({ kind: "workspace", id: result.committedEntry.id }); },
      }, { primaryAction: result.committedEntry ? "workspace" : result.retainedPath ? "recover" : undefined, secondaryAction: result.committedEntry && result.retainedPath ? "recover" : undefined }); return;
    }
    const r = result.result;
    env.page(r.alreadyRegistered ? "Already registered" : r.started ? "Workspace ready" : "Workspace configured", group("Workspace", infoRows([{ label: "Display name", value: r.entry.displayName }, { label: "Folder", value: r.entry.path, mono: true }, { label: "Outcome", value: r.alreadyRegistered ? "The existing registration was retained. No new start was requested by this result." : r.started ? "The requested workspace session started." : "Registration and assignments are saved. The workspace is stopped." }])) + (r.startError ? text(`Start failed: ${r.startError}. The configured workspace remains available for an explicit Start.`) : "") + action("inspect", "Workspace information") + (r.started ? action("open", "Open workspace") : ""), {
      inspect: () => env.navigate({ kind: "workspace", id: r.entry.id }), open: () => { if (r.started) env.openWorkspace(r.entry.id); },
    }, { primaryAction: r.started ? "open" : "inspect", secondaryAction: r.started ? "inspect" : undefined });
  }
  function configure(path: string, git: boolean | null, catalog: PublicCredentialDto[]) {
    let draft: ConfigurationDraft = { displayName: path.split("/").filter(Boolean).at(-1) ?? "", folderName: "", authentication: [], signing: "", start: false, init: false };
    const editor = () => {
      const task = env.task("Add Existing Folder", text(path) + field("displayName", "Workspace display name", draft.displayName) + configurationFields(catalog, draft) + (git !== true ? check("init", "Initialize Git in this folder", draft.init) + text(git === false ? "This folder is not a Git repository. Initializing Git changes this folder and requires your consent." : "Git status is not supplied for this location. The backend will validate it. Authorize Git initialization only if you intend to initialize this folder.") : ""), { label: "Review", run: root => {
        draft = { ...readConfiguration(root, catalog, draft), displayName: displayName(value(root, "displayName")), init: git !== true && checked(root, "init") };
        if (git === false && !draft.init) throw new Error("Confirm Git initialization before adding a non-Git folder.");
        reviewConfiguration("Add Existing Folder", path, draft, catalog, () => backend.configureExisting({ path, displayName: draft.displayName, authentication: draft.authentication, signing: draft.signing || null, init: draft.init, start: draft.start }), editor);
      } }); bindAuthenticationHost(task, catalog);
    }; editor();
  }
  function reviewConfiguration(title: string, path: string, draft: ConfigurationDraft, catalog: PublicCredentialDto[], call: () => ReturnType<typeof backend.configureExisting>, back: () => void) {
    env.task(`Review ${title}`, group("Workspace", infoRows([{ label: "Display name", value: draft.displayName }, { label: "Parent folder", value: path.slice(0, path.lastIndexOf("/")) || "/", mono: true }, { label: "Folder name", value: path.split("/").at(-1) || "/", mono: true }, { label: "Folder path", value: path, mono: true }])) + group("Setup", infoRows([{ label: "Git initialization", value: draft.init ? "Authorized" : "Not requested; existing repository required" }, { label: "Start", value: draft.start ? "Start after configuration" : "Register stopped; do not start" }])) + configurationFacts(catalog, draft.authentication, draft.signing) + (draft.start && !draft.authentication.length && !draft.signing ? text("No credentials are assigned. Git authentication and signing may be unavailable, but the workspace can still start.") : ""), { label: draft.start ? "Add and start" : "Add stopped", run: root => env.mutate(call, outcome, root) }, {}, back, { cancelLabel: "Back to edit" });
  }
  function newWorkspace(parent?: string) {
    env.page("Create Workspace", text("Loading default folder and credentials…"));
    void env.read(() => backend.readDefaultFolder(), defaults => {
      void env.read(() => backend.readCredentials(), catalog => {
        let draft: ConfigurationDraft = { displayName: "", folderName: "", authentication: [], signing: "", start: false, init: false };
        let destination = parent ?? defaults.effective;
        const editor = () => {
          env.page("Create Workspace", text(defaults.configured && !defaults.configuredAvailable ? `Saved default unavailable; using ${defaults.effective}. You can browse elsewhere.` : `Parent: ${destination}`) + action("edit", "Configure new workspace"), { edit: editor }, { primaryAction: "edit" });
          const task = env.task("Create Workspace", text("Creates a new folder and initializes Git. This is different from creating an empty folder.") + technicalField("parent", "Parent folder", destination) + action("browse", "Browse elsewhere") + technicalField("folderName", "New folder name", draft.folderName) + field("displayName", "Workspace display name", draft.displayName) + configurationFields(catalog, draft) + check("init", "Create the folder and initialize Git", draft.init), { label: "Review", run: root => {
            destination = absolute(value(root, "parent"));
            draft = { ...readConfiguration(root, catalog, draft), folderName: folderName(value(root, "folderName")), displayName: displayName(value(root, "displayName")), init: checked(root, "init") };
            if (!draft.init) throw new Error("Confirm folder creation and Git initialization.");
            reviewConfiguration("Create Workspace", `${destination.replace(/\/$/, "")}/${draft.folderName}`, draft, catalog, () => backend.createWorkspace({ parent: destination, folderName: draft.folderName, displayName: draft.displayName, authentication: draft.authentication, signing: draft.signing || null, start: draft.start, gitInitConsent: "confirmed" }), editor);
          } }, { browse: () => {
            destination = value(task, "parent");
            draft = { ...draft, folderName: value(task, "folderName"), displayName: value(task, "displayName"), signing: value(task, "signing"), start: checked(task, "start"), init: checked(task, "init"), authentication: [...task.querySelectorAll<HTMLElement>("[data-auth-row]")].map(row => ({ credentialId: value(row, "authentication"), host: value(row, "host") })) };
            env.sheet.close();
            browse(destination.startsWith("/") ? destination : defaults.effective, selected => { destination = selected; editor(); }, editor);
          } }); bindAuthenticationHost(task, catalog);
        };
        editor();
      }, () => newWorkspace(parent));
    }, () => newWorkspace(parent));
  }
  function browse(path?: string, choose?: (path: string) => void, cancel: () => void = add) {
    if (choose) { pickFolder(path, choose, cancel); return; }
    const request = ++browseGeneration;
    const back = () => { ++browseGeneration; cancel(); };
    env.page("Manage Folders", text("Loading folders…"), { "flow-back": back });
    void env.read<FolderListing | null>(async () => {
      // Task Back can restore an editor without changing the route generation.
      // Suppress stale failures too: env.read otherwise presents their error page.
      try {
        const result = await backend.browseFolders(path);
        return request === browseGeneration ? result : { status: "available" as const, value: null };
      } catch (error) {
        if (request !== browseGeneration) return { status: "available" as const, value: null };
        throw error;
      }
    }, listing => {
      if (request !== browseGeneration || !listing) return;
      const actions: Record<string, () => unknown> = {
      "flow-back": back,
        up: () => { if (listing.parent) browse(listing.parent, choose, cancel); },
        elsewhere: () => env.task("Browse elsewhere", technicalField("path", "Absolute folder path", listing.path), { label: "Browse", run: root => { const path = absolute(value(root, "path")); env.sheet.close(); browse(path, choose, cancel); } }, {}, () => browse(listing.path, choose, cancel)),
        choose: () => { ++browseGeneration; return loadConfiguration(listing); },
        create: () => emptyFolder(listing.path, choose, cancel),
        workspace: () => newWorkspace(listing.path),
        rename: () => folderActions(listing.path, "rename", choose, cancel),
        remove: () => folderActions(listing.path, "remove", choose, cancel),
      };
      const folders = listing.directories.map((d, i) => {
        const child = `${listing.path.replace(/\/$/, "")}/${d.name}`;
        actions[`folder-${i}`] = () => browse(child, choose, cancel);
        return listRow(`folder-${i}`, d.name, `${d.git ? "Git repository" : "Folder"}${d.registration.status === "registered" ? ` · Registered · ${d.registration.runtime.status}` : " · Not registered"}`, "folder");
      }).join("");
      env.page("Manage Folders", `<nav aria-label="Folder location">${text(listing.path)}${listing.parent ? action("up", `Up to ${listing.parent}`) : ""}</nav>` + (folders ? group("Folders", folders) : text("This folder has no subfolders.")) + group("Current folder", action("choose", "Configure this folder") + action("elsewhere", "Browse elsewhere") + action("create", "Create empty folder") + action("workspace", "Create workspace here") + action("rename", "Rename folder") + action("remove", "Remove empty folder", true)), actions, { primaryAction: "choose", backLabel: "Back" });
    }, () => browse(path, choose, cancel));
  }
  function loadConfiguration(listing: FolderListing) {
    // The listing has facts for children, not the selected folder. Ask the
    // adapter's configure-existing validation to decide repository status; the
    // explicit optional init consent below never silently initializes Git.
    void env.read(() => backend.readCredentials(), catalog => {
      void env.read(() => backend.readWorkspaces(), workspaces => {
        const registered = workspaces.find(w => w.path === listing.path);
        if (registered) { env.navigate({ kind: "workspace", id: registered.id }); return; }
        // Inspect the parent's supplied child metadata without a host Git probe.
        if (listing.parent) void env.read(() => backend.browseFolders(listing.parent!), parent => {
          const name = listing.path.split("/").filter(Boolean).at(-1);
          const facts = parent.directories.find(d => d.name === name);
          if (!facts) { env.task("Folder unavailable", text("The selected folder changed. Browse again before configuring it.")); return; }
          configure(listing.path, facts.git, catalog);
        }, () => loadConfiguration(listing));
        else configure(listing.path, null, catalog);
      }, () => loadConfiguration(listing));
    }, () => loadConfiguration(listing));
  }
  function emptyFolder(parent: string, choose?: (path: string) => void, cancel: () => void = add) {
    env.task("Create Empty Folder", text(`Parent: ${parent}. This creates a folder only, without Git or workspace registration.`) + technicalField("name", "Folder name"), { label: "Create folder", run: root => {
      const name = folderName(value(root, "name")); return env.mutate(() => backend.createFolder({ parent, name }), result => { env.sheet.close(); browse(result.path, choose, cancel); }, root);
    } }, {}, () => browse(parent, choose, cancel));
  }
  function folderActions(path: string, operation: "rename" | "remove", choose?: (path: string) => void, cancel: () => void = add) {
    void env.read(() => backend.readWorkspaces(), workspaces => {
      const nested = workspaces.filter(w => w.path === path || w.path.startsWith(`${path.replace(/\/$/, "")}/`));
      const affected = nested.length ? group("Affected registrations", nested.map(w => text(`${w.displayName} · ${w.path} · ${w.runtime.status}`)).join("")) : text("No known registrations at or below this folder.");
      const actions = {
        rename: () => env.task("Rename Folder", text(path) + affected + text("Renaming updates affected registration paths. Required workspace stops terminate shells before the filesystem change.") + technicalField("name", "New folder name", path.split("/").filter(Boolean).at(-1) ?? ""), { label: "Review", run: root => {
          const name = folderName(value(root, "name"));
          env.task("Rename this folder?", text(`${path} → ${name}`) + affected + text("Folder names and workspace display names are separate. Affected registered paths will be updated."), { label: "Rename folder", run: async () => { env.sheet.close(); await env.coordinated("Stop and rename folder?", stop => backend.renameFolder({ path, name, stop }), result => browse(result.path, choose, cancel)); } });
        } }),
        remove: () => env.confirm("Remove Empty Folder?", text(`Remove ${path}? Only an empty folder can be removed. A registration for the removed folder may also be removed; this is not the same as forgetting a workspace. Required workspace stops terminate shells before the filesystem change.`) + affected, { label: "Remove empty folder", run: async () => { env.sheet.close(); await env.coordinated("Stop and remove folder?", stop => backend.removeEmptyFolder({ path, stop }), () => browse(path.slice(0, path.lastIndexOf("/")) || "/", choose, cancel)); } }),
      };
      actions[operation]();
    }, () => folderActions(path, operation, choose, cancel));
  }
  function defaultFolder() {
    env.page("Default Folder", text("Loading default folder…"));
    void env.read(() => backend.readDefaultFolder(), state => {
      const description = "Starting folder for new workspaces, clones, and folder browsing on this Hub. Shared by everyone using this Hub. Existing workspaces aren’t moved.";
      const save = (path: string | null, root?: HTMLElement) => env.mutate(() => backend.setDefaultFolder(path), () => { env.sheet.close(); env.changed(); defaultFolder(); }, root);
      let draft: string | null = state.configured ?? state.effective;
      const editor = () => {
        if (env.root.querySelector("h1")?.textContent !== "Default Folder") landing();
         const task = env.task("Default Folder", technicalField("path", "Folder path", draft ?? "", draft === null ? 'placeholder="Hub home folder"' : "") + (draft === null ? text("Hub home folder will be used after saving.") : "") + action("browse", "Choose folder") + (state.configured ? action("use-home", "Use Hub home folder") : "") + text(description), { label: "Save", run: root => save(draft === null && !value(root, "path") ? null : absolute(value(root, "path")), root) }, { browse: () => {
          const path = value(task, "path"); draft = draft === null && !path ? null : path; env.sheet.close();
          browse(path.startsWith("/") ? path : state.effective, selected => { draft = selected; editor(); }, editor);
        }, "use-home": () => { draft = null; editor(); } });
      };
      const actions = { edit: () => { draft = state.configured ?? state.effective; editor(); } };
      const differs = state.configured !== null && state.configured !== state.effective;
      const landing = () => env.page("Default Folder", group(differs ? "Saved Folder" : "Current Folder", listRow("edit", state.configured ?? "Hub home folder", state.configured ? "Edit or choose a folder" : state.effective)) + (differs ? group("Currently Using", text(state.effective)) + (!state.configuredAvailable ? text("Saved folder unavailable.") : "") : "") + text(description), actions);
      landing();
    }, defaultFolder);
  }
  return { add, browse, newWorkspace, defaultFolder, outcome };
}
