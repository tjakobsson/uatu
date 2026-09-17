// Scenario controls stay test-only; the selected layout belongs to the dashboard.
export function installDashboardScenarios() {
  window.addEventListener("DOMContentLoaded", () => {
    // Old comparison bookmarks are harmless and canonicalize to the dashboard.
    const url = new URL(location.href); url.searchParams.delete("layout");
    history.replaceState(history.state, "", url);
    sessionStorage.removeItem("worktree-review-layout");
    const panel = document.createElement("aside"); panel.className = "demo-layout-controls";
    panel.innerHTML = '<strong>SIMULATION · Active groups</strong><details><summary>Scenario controls · independent checkout lifecycles</summary><p>Main Stop affects only main. Parent owns configuration, not child runtime.</p><select aria-label="Dashboard scenario"><option value="mixed-lifecycle">Mixed · main stopped, child running</option><option value="all-stopped">All stopped</option><option value="populated">Original populated inventory</option></select><button>Reset dashboard scenario</button></details>';
    panel.querySelector("button")!.onclick = async () => {
      const form = new FormData(); form.set("scenario", panel.querySelector("select")!.value);
      const result = await fetch("/__demo/reset", { method: "POST", body: form }); if (result.ok) location.reload();
    };
    document.getElementById("sessions")!.parentElement!.before(panel);
    const style = document.createElement("style");
    style.textContent = '.demo-layout-controls{padding:12px;margin-bottom:16px;border:1px solid var(--border-medium);border-radius:8px;font-size:12px}.demo-layout-controls p{color:var(--text-subtle)}.demo-layout-controls select,.demo-layout-controls button{min-height:40px;max-width:100%;margin:4px}.demo-layout-controls summary{cursor:pointer}';
    document.head.append(style);
  });
}

export const dashboardScenarioScript = `<script>(${installDashboardScenarios.toString()})()</script>`;
