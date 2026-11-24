// The "connect GitHub" guidance, wherever GitHub isn't connected: the pull
// request preview (`card`), the Pull request pane and Browse pull requests
// (`compact`), and the pane's one short line (`line`) while the preview
// beside it shows the card, so the full message is said once. Inside a Hub its one action opens Settings → Credentials.
// `workspace` names the workspace the credential is assigned to. (No import
// of shell/state here: the picker, loaded early by hub-nav.ts, uses this.)

import { hubUrl, isHubPage } from "../shared/app-url";
import { escapeHtml } from "../shared/html";
import { externalLink } from "./present";

export function connectGithubHtml(variant: "card" | "compact" | "line", workspace: string): string {
  if (variant === "line") {
    const action = isHubPage()
      ? externalLink(hubUrl("/settings#credentials-pane"), "Connect in Settings", "gh-external")
      : `<code>gh auth login</code>`;
    return `<p class="gh-connect gh-connect-line"><strong>GitHub isn't connected.</strong> ${action}</p>`;
  }
  const settings = isHubPage()
    ? externalLink(hubUrl("/settings#credentials-pane"), "Open Hub Settings → Credentials", "gh-button gh-button-primary")
    : `<p class="pr-muted">Outside a Hub, sign in with <code>gh auth login</code> and restart this session.</p>`;
  if (variant === "compact") {
    return `<div class="gh-connect gh-connect-compact">
        <h3>GitHub isn't connected for this workspace</h3>
        <p>uatu reads and reviews pull requests through the GitHub CLI credential assigned to <strong>${escapeHtml(workspace)}</strong>. None is assigned yet.</p>
        ${settings}
      </div>`;
  }
  return `<div class="gh-connect">
      <h3>Connect GitHub to review pull requests here</h3>
      <p>Assign a credential with GitHub CLI access to this workspace. uatu runs <code>gh</code> with it to read the pull request and post comments and reviews. Nothing is stored in the worktree.</p>
      <div class="gh-breadcrumb" aria-label="Where to assign it">${["Hub", "Settings", "Credentials", "Add HTTPS or provider token", `Workspace assignments: ${workspace}`]
        .map(step => `<span class="gh-breadcrumb-step">${escapeHtml(step)}</span>`).join(`<span class="gh-breadcrumb-separator" aria-hidden="true">›</span>`)}</div>
      <div class="gh-connect-actions">${settings}<span class="pr-muted">Child worktrees inherit the assignment from <strong>${escapeHtml(workspace)}</strong>.</span></div>
    </div>`;
}
