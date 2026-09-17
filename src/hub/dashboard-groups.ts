/** Capability-scoped presentation; rows retain their existing action handlers. */
export function createDashboardGroups() {
  type Workspace = { id: string; displayName?: string; branch?: string; parentId?: string; repositoryId?: string; running: boolean };
  const expanded = new Map<string, boolean>();
  const make = (tag: string, text = "", className = "") => {
    const node = document.createElement(tag); node.textContent = text; node.className = className; return node;
  };
  return (workspaces: Workspace[], nodes: Map<string, HTMLElement>) => {
    const sessions = document.getElementById("sessions")!;
    const stopped = document.getElementById("workspaces")!;
    sessions.parentElement!.querySelector("h2")!.textContent = "Active";
    stopped.parentElement!.querySelector("h2")!.textContent = "Inactive";
    sessions.replaceChildren(); stopped.replaceChildren();
    const details = (key: string, label: string) => {
      const node = document.createElement("details"); node.dataset.disclosure = key;
      node.open = expanded.get(key) ?? false;
      node.append(make("summary", label));
      node.addEventListener("toggle", () => { if (node.isConnected) expanded.set(key, node.open); });
      return node;
    };
    for (const parent of workspaces.filter(w => !w.parentId)) {
      const main = nodes.get(parent.id); if (!main) continue;
      const children = workspaces.filter(w => w.parentId === parent.id && w.repositoryId === parent.repositoryId);
      const active = [parent, ...children].some(w => w.running);
      const group = make("section", "", "dashboard-repository"); group.dataset.repository = parent.id;
      const heading = make("div", "", "row dashboard-group-heading");
      heading.append(make("h3", parent.displayName || parent.id, "row-title"));
      const actions = make("div", "", "row-actions");
      for (const button of main.querySelectorAll<HTMLButtonElement>(".row-actions button")) {
        if (button.textContent === "Configure" || button.getAttribute("aria-label")?.startsWith("Rename workspace") || button.getAttribute("aria-label")?.startsWith("Add worktree")) actions.append(button);
      }
      heading.append(actions); group.append(heading);
      main.querySelector<HTMLElement>(".row-title")!.replaceChildren(document.createTextNode(parent.branch || parent.displayName || parent.id), make("span", "Main checkout", "chip"));
      group.append(main);
      const count = children.filter(w => !w.running).length;
      const hidden = count ? details(`${parent.id}-stopped`, `${count} stopped worktree${count === 1 ? "" : "s"}`) : null;
      for (const child of children) {
        const row = nodes.get(child.id); if (row) (hidden && !child.running ? hidden : group).append(row);
      }
      if (hidden) group.append(hidden);
      if (!active) {
        const folded = details(`${parent.id}-inactive`, `${parent.displayName || parent.id} · all stopped · expand to Start or fork`);
        folded.append(group); stopped.append(folded);
      } else sessions.append(group);
    }
    if (!sessions.childElementCount) sessions.append(make("p", "No checkouts running. Expand an inactive repository to Start or fork.", "empty"));
    if (!stopped.childElementCount) stopped.append(make("p", "No inactive repositories.", "empty"));
  };
}

export const dashboardGroupsStyle = `.dashboard-repository{border:1px solid var(--border-soft);border-radius:8px;margin:12px 0;overflow:hidden}.dashboard-group-heading{background:var(--surface-hover)}.dashboard-group-heading h3{margin:0}.dashboard-repository summary,#workspaces>details>summary{padding:12px;cursor:pointer;min-height:44px;box-sizing:border-box}.dashboard-repository summary:focus-visible,#workspaces>details>summary:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}`;
