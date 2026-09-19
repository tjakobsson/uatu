/** Capability-scoped presentation; rows retain their existing action handlers. */
export function createDashboardGroups() {
  type Workspace = { id: string; displayName?: string; branch?: string; detached?: boolean; parentId?: string; repositoryId?: string; running: boolean; createWorktree?: boolean };
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
        if (button.getAttribute("aria-label")?.startsWith("Rename workspace") || button.getAttribute("aria-label")?.startsWith("Add worktree")) actions.append(button);
      }
      heading.append(actions); group.append(heading);
      // W10: "Main checkout" is a truthful claim about repository ownership
      // — the Hub only sets createWorktree when this row's .git is a real
      // repository directory, i.e. when a fork control exists at all. A
      // linked worktree registered on its own through Add workspace (a .git
      // FILE) has no fork control and is not this repository's main
      // checkout; label it for what it is instead of promising a fork it
      // does not have.
      const isMain = parent.createWorktree === true;
      // Bug 2: this used to `replaceChildren(textNode, chip)` directly on
      // `.row-title` (the wrapping div), which discarded the `<a>` the row
      // itself renders for a RUNNING checkout (row(), pages.ts) — silently
      // turning a running main checkout's only navigation affordance into
      // plain unlinked text. Re-label the existing title element in place
      // (an `<a>` keeps its href; a `<strong>` stays a `<strong>`) instead
      // of replacing it, so a running repository's title is still the link
      // it is everywhere else in the dashboard.
      const titleRow = main.querySelector<HTMLElement>(".row-title")!;
      const titleEl = titleRow.querySelector<HTMLElement>("a, strong") ?? titleRow;
      titleEl.textContent = parent.detached ? "Detached HEAD" : parent.branch || "Branch unknown";
      titleRow.replaceChildren(titleEl, make("span", isMain ? "Main checkout" : "Linked checkout", "chip"));
      group.append(main);
      const count = children.filter(w => !w.running).length;
      const hidden = count ? details(`${parent.id}-stopped`, `${count} stopped worktree${count === 1 ? "" : "s"}`) : null;
      for (const child of children) {
        const row = nodes.get(child.id); if (row) (hidden && !child.running ? hidden : group).append(row);
      }
      if (hidden) group.append(hidden);
      if (!active) {
        const summary = isMain
          ? `${parent.displayName || parent.id} · all stopped · expand to Start or fork`
          : `${parent.displayName || parent.id} · all stopped · expand to Start`;
        const folded = details(`${parent.id}-inactive`, summary);
        folded.append(group); stopped.append(folded);
      } else sessions.append(group);
    }
    if (!sessions.childElementCount) sessions.append(make("p", "No checkouts running. Expand an inactive repository to Start or fork.", "empty"));
    if (!stopped.childElementCount) stopped.append(make("p", "No inactive repositories.", "empty"));
  };
}

// W8: --surface-hover was never defined for the Hub's own pages (only the
// client SPA's stylesheet has it), so the heading band had no background at
// all, in either color scheme. --surface-muted is defined in pages.ts's
// SHARED_STYLE for both schemes and reads distinctly from .row:hover's
// --surface-subtle.
export const dashboardGroupsStyle = `.dashboard-repository{border:1px solid var(--border-soft);border-radius:8px;margin:12px 0;overflow:hidden}.dashboard-group-heading{background:var(--surface-muted)}.dashboard-group-heading h3{margin:0}.dashboard-group-heading .row-title{flex:1 1 auto;min-width:0}.dashboard-group-heading .row-actions{margin-inline-start:auto}.dashboard-repository summary,#workspaces>details>summary{padding:12px;cursor:pointer;min-height:44px;box-sizing:border-box}.dashboard-repository summary:focus-visible,#workspaces>details>summary:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}@media(max-width:600px){.dashboard-group-heading{flex-wrap:wrap}.dashboard-group-heading .row-actions{flex:1 0 100%}}`;
