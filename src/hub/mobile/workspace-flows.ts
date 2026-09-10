import type { AssignWorkspaceIntent, AssignmentSelection, WorkspaceView } from "./backend";
import type { AuthenticationCredentialAssignment, PublicCredentialDto } from "../credential-types";
import { action, advisory, displayName, field, group, listRow, required, select, text, value, type FlowEnvironment } from "./flow-ui";
import { supportsRole } from "./credential-flows";
import { branchLabel, workspaceAssignmentLabels } from "./workspace-presentation";

export type AssignmentDraft = { authentication: string; host: string; signing: string };
export function assignmentIntent(workspace: WorkspaceView, mode: AssignWorkspaceIntent["mode"], draft: AssignmentDraft): AssignWorkspaceIntent | null {
  const auth = draft.authentication ? { credentialId: draft.authentication, host: required(draft.host, "Authentication host") } : null;
  const changeAuth = auth && !workspace.assignments.some(a => a.role === "authentication" && a.host === auth.host && a.credentialId === auth.credentialId);
  const changeSigning = draft.signing && !workspace.assignments.some(a => a.role === "signing" && a.credentialId === draft.signing);
  if (!changeAuth && !changeSigning) return null;
  const selection: AssignmentSelection = changeAuth ? { authentication: auth!, ...(changeSigning ? { signing: { credentialId: draft.signing } } : {}) } : { signing: { credentialId: draft.signing } };
  return { workspaceId: workspace.id, mode, selection };
}
export function credentialChoices(catalog: PublicCredentialDto[], role: "authentication" | "signing", selected = "", emptyLabel = "Do not change") {
  const choices = [{ value: "", label: emptyLabel }, ...catalog.filter(c => supportsRole(c, role)).map(c => ({ value: c.id, label: `${c.name}${c.enabled ? "" : " (disabled)"}`, disabled: !c.enabled }))];
  if (selected && !choices.some(c => c.value === selected)) choices.push({ value: selected, label: "Unavailable credential (choose a replacement)", disabled: true });
  return choices;
}
export function validateSelected(catalog: PublicCredentialDto[], id: string, role: "authentication" | "signing") {
  if (!id) return;
  const credential = catalog.find(c => c.id === id);
  if (!credential || !credential.enabled || !supportsRole(credential, role)) throw new Error(`The selected ${role} credential is missing, disabled, or incompatible. Choose a replacement explicitly.`);
}
export function createWorkspaceFlows(env: FlowEnvironment, start: (workspace: WorkspaceView) => void) {
  const { backend } = env;
  function workspace(id: string) {
    env.page("Workspace", text("Loading workspace…"));
    void env.read(() => backend.readWorkspace(id), w => {
      const shellText = w.runtime.status === "running" ? group("Shells", w.runtime.shells.status === "ready" ? text(`${w.runtime.shells.value.length} shells`) + w.runtime.shells.value.map(s => text(`${s.label || "Shell"} · ${s.attached ? "Attached" : "Detached"}`)).join("") : text(w.runtime.shells.status === "loading" ? "Loading…" : w.runtime.shells.problem.message)) : "";
      const actions: Record<string, () => unknown> = {
        open: () => start(w),
        rename: () => env.task("Rename workspace", text("Changes the display name, not its folder or stable URL.") + field("name", "Display name", w.displayName), { label: "Save", run: root => {
          const name = displayName(value(root, "name"));
          if (name === w.displayName) { env.sheet.error("No changes to the display name."); return; }
          return env.mutate(() => backend.renameWorkspace({ workspaceId: id, displayName: name }), () => { env.sheet.close(); env.changed(); workspace(id); }, root);
        } }),
        assign: () => assignments(id),
        stop: () => env.confirm("Stop workspace?", text(`Stop ${w.displayName}? Its shells will be terminated. Registration and files remain.`), { label: "Stop", run: root => env.mutate(() => backend.stopWorkspace(id), result => { env.sheet.close(); env.changed(); env.task("Workspace stopped", text(result.status === "already-stopped" ? "This workspace was already stopped." : "Its session has stopped. Registration and files remain."), undefined, {}, () => workspace(id)); }, root) }),
        forget: () => env.confirm("Forget registration?", text(`Forget ${w.displayName}? This removes its registration and personal workspace state, not files on disk. Its folder remains at ${w.path}. A running workspace must be stopped separately.`), { label: "Forget", run: root => env.mutate(() => backend.forgetWorkspace(id), result => { env.sheet.close(); env.changed(); env.home(); env.task("Registration forgotten", text(result.status === "not-found" ? "This registration was already absent." : "The registration was removed. Workspace files were not deleted.")); }, root) }),
      };
      const assignmentText = (catalog: PublicCredentialDto[] | "loading" | "unavailable") => w.assignments.length ? workspaceAssignmentLabels(w.assignments, catalog).map(text).join("") : text("No credentials assigned");
      env.page(w.displayName, text(w.path) + text(`Stable ID: ${w.id} · ${w.runtime.status}`) + text(branchLabel(w.branch)) + (w.credentialRestartRequired ? text("Credential changes require a workspace restart.") : "") + shellText + group("Assignments", `<div data-workspace-assignments>${assignmentText("loading")}</div>` + text("Assignment presence is not credential readiness.") + action("assign", "Edit workspace credentials")) + action("rename", "Rename display name") + action("open", w.runtime.status === "running" ? "Open" : "Start") + (w.runtime.status === "running" ? action("stop", "Stop workspace", true) : action("forget", "Forget registration", true)), actions, { primaryAction: "open" });
      // Name enrichment must not replace usable workspace facts with a catalog
      // error page, or rerender the page and disrupt a focused command/form.
      const region = env.root.querySelector<HTMLElement>("[data-workspace-assignments]")!;
      // Metadata belongs to this retained region and authenticated owner, not
      // the command/task generation: an editor can temporarily cover this page.
      const owner = env.authContext();
      const active = () => owner.current() && region.isConnected && env.root.contains(region);
      if (w.assignments.length) void (async () => {
        try {
          const result = await backend.readCredentials();
          if (!active()) return;
          if (result.status === "unavailable" && result.problem.kind === "unauthorized") { env.authLost(); return; }
          region.innerHTML = assignmentText(result.status === "available" ? result.value : "unavailable");
        } catch { if (active()) region.innerHTML = assignmentText("unavailable"); }
      })();
    }, () => workspace(id));
  }
  function assignments(selectedId?: string) {
    env.page("Workspace Assignments", text("Loading assignments…"));
    void env.read(() => backend.readWorkspaces(), workspaces => {
      void env.read(() => backend.readCredentials(), catalog => {
        const selected = selectedId ? workspaces.find(w => w.id === selectedId) : null;
        const rows = selected ? [selected] : workspaces;
        const actions: Record<string, () => unknown> = {};
        if (selected) actions["flow-back"] = () => assignments();
        const html = rows.map(w => {
          if (!selected) {
            actions[`workspace-${w.id}`] = () => assignments(w.id);
            return listRow(`workspace-${w.id}`, w.displayName, `${w.runtime.status} · ${w.assignments.length} assignments · ${w.path}`);
          }
          actions[`new-${w.id}`] = () => editAssignments(w, catalog, "assign-new");
          actions[`edit-${w.id}`] = () => editAssignments(w, catalog, "edit-current");
          const current = w.assignments.map((a, index) => {
            const c = catalog.find(c => c.id === a.credentialId);
            actions[`remove-${w.id}-${index}`] = () => env.confirm("Remove assignment?", text(`Remove ${a.role}${a.role === "authentication" ? ` on ${a.host}` : ""} from ${w.displayName}?${w.runtime.status === "running" ? " Stopping this workspace terminates its shells before the assignment changes." : ""}`), { label: "Remove", run: async () => {
              env.sheet.close(); await env.coordinated("Stop and remove assignment?", stop => backend.removeAssignment({ assignment: a, stop }), () => assignments(selectedId));
            } });
            if (a.role === "authentication") actions[`edit-auth-${w.id}-${index}`] = () => editAssignments(w, catalog, "edit-current", a);
            return text(`${c?.name ?? "Missing credential"} · ${a.role}${a.role === "authentication" ? ` · ${a.host}` : ""}`) + (a.role === "authentication" ? action(`edit-auth-${w.id}-${index}`, `Edit authentication on ${a.host}`) : "") + action(`remove-${w.id}-${index}`, `Remove ${a.role} assignment`, true);
          }).join("");
          return group(w.displayName, text(w.path) + text(w.runtime.status) + (current || text("No credentials assigned")) + action(`edit-${w.id}`, "Edit workspace credentials") + action(`new-${w.id}`, "Add authentication host"));
        }).join("");
        env.page(selected ? selected.displayName : "Workspace Assignments", advisory(env.user()) + (html ? selected ? html : group("Workspaces", html) : text("No registered workspaces.")), actions, selected ? { primaryAction: `edit-${selected.id}`, secondaryAction: `new-${selected.id}` } : undefined);
      }, () => assignments(selectedId));
    }, () => assignments(selectedId));
  }
  function editAssignments(w: WorkspaceView, catalog: PublicCredentialDto[], mode: AssignWorkspaceIntent["mode"], authentication?: AuthenticationCredentialAssignment) {
    const auths = w.assignments.filter((a): a is AuthenticationCredentialAssignment => a.role === "authentication");
    const auth = authentication ?? auths[0];
    const draft: AssignmentDraft = mode === "edit-current" ? { authentication: auth?.credentialId ?? "", host: auth?.host ?? "", signing: w.assignments.find(a => a.role === "signing")?.credentialId ?? "" } : { authentication: "", host: "", signing: "" };
    const editor = () => {
      const body = text(`${w.displayName} · ${w.runtime.status}`) + text(mode === "assign-new" ? "Add Git authentication for a host. Commit signing is unchanged. Choosing an existing host requires replacement at review." : "Authentication and signing are independent. Unselected roles are unchanged; removal is a separate action.") + (auths.length > 1 ? text("This workspace has authentication defaults on multiple hosts. Edit each host from its named row; changing this host does not remove another host's assignment.") : "") + group("Credentials", select("authentication", "Git authentication", credentialChoices(catalog, "authentication", draft.authentication), draft.authentication) + field("host", "Authentication host", draft.host) + (mode === "edit-current" ? select("signing", "Commit signing", credentialChoices(catalog, "signing", draft.signing), draft.signing) : ""));
      const task = env.task(mode === "edit-current" ? "Edit workspace credentials" : "Add authentication host", body, { label: "Review", run: root => {
        draft.authentication = value(root, "authentication"); draft.host = value(root, "host"); draft.signing = mode === "edit-current" ? value(root, "signing") : "";
        validateSelected(catalog, draft.authentication, "authentication"); validateSelected(catalog, draft.signing, "signing");
        const intent = assignmentIntent(w, mode, draft);
        if (!intent) { env.sheet.error("No changes to the workspace credentials."); return; }
        const replacesHost = intent.selection.authentication && auths.some(a => a.host === intent.selection.authentication!.host);
        env.task("Review workspace credentials", text(w.displayName) + (intent.selection.authentication ? text(`Authentication on ${intent.selection.authentication.host} becomes ${catalog.find(c => c.id === draft.authentication)?.name ?? "Unavailable credential"}. ${replacesHost ? "This replaces the default for that host. Apply and replace authorizes this replacement." : "This adds authentication for that host."}`) : "") + (intent.selection.signing ? text(`Signing becomes ${catalog.find(c => c.id === draft.signing)?.name ?? "Unavailable credential"}. This replaces the signing default.`) : "") + text("Assignment presence is not credential readiness or an isolation boundary. Running workspaces may require a restart to use changes."), { label: replacesHost ? "Apply and replace" : "Apply", run: review => env.mutate(() => backend.assignWorkspace(intent), () => { env.sheet.close(); env.changed(); assignments(w.id); }, review) }, {}, editor, { cancelLabel: "Back to edit" });
      } });
      const authSelect = task.querySelector<HTMLSelectElement>('[name="authentication"]')!;
      const host = task.querySelector<HTMLInputElement>('[name="host"]')!;
      const update = () => { host.disabled = !authSelect.value; };
      authSelect.addEventListener("change", update); update();
    };
    editor();
  }
  function devices() {
    env.page("Devices", text("Loading devices…"));
    void env.read(() => backend.readDevices(), devices => {
      const actions: Record<string, () => unknown> = {};
      const rows = devices.map((d, i) => {
        const name = d.deviceLabel || "Unnamed device";
        actions[`revoke-${i}`] = () => env.confirm("Revoke session?", text(`${name} · Issued ${new Date(d.issuedAt).toLocaleString()}. ${d.current ? "This signs you out on this device." : "This device will need to sign in again."} It does not stop workspaces.`), { label: "Revoke", run: root => env.mutate(() => backend.revokeDevice(d.handle), result => { env.sheet.close(); if (result.current) env.authLost(); else { env.changed(); env.navigate({ kind: "devices" }); } }, root) });
        actions[`device-${i}`] = actions[`revoke-${i}`]!;
        return listRow(`device-${i}`, name, `${d.current ? "Current session" : "Other session"} · Issued ${new Date(d.issuedAt).toLocaleDateString()} · Review revocation`);
      }).join("");
      env.page("Devices", rows ? group("Sessions", rows) : text("No device sessions are available."), actions);
    }, devices);
  }
  function security() {
    env.page("Session Security", group("Session access", text("Hub sessions authorize access to this hub. Revoke a device session to require that device to sign in again. Sign-out and revocation do not stop workspace sessions.") + action("devices", "Manage devices")) + group("Local workspace credentials", text("Credential assignments configure normal tools; they do not isolate credentials from other processes running as the same Hub OS user.") + advisory(env.user())) + group("Account", action("signout", "Sign out", true)), {
      devices: () => env.navigate({ kind: "devices" }),
      signout: () => env.confirm("Sign out?", text("You will need to sign in again. Workspaces are not stopped."), { label: "Sign out", run: root => env.mutate(() => backend.signOut(), () => env.authLost(), root) }),
    }, { primaryAction: "signout" });
  }
  return { workspace, assignments, devices, security };
}
