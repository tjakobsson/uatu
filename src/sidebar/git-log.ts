// Git Log pane — renders the per-repository commit list with limit
// selector, and persists the user's choice across reloads. Extracted from
// `app.ts` so the sidebar feature folder owns the git-log presentation
// alongside the change-overview pane it shares structure with.

import { escapeHtml, escapeHtmlAttribute } from "../shared/html";
import type { RepositoryReviewSnapshot } from "../shared/types";
import { applyStaleHint } from "../shell/stale-hint-mount";
import { buildCommitPreviewPath } from "../shell/history";
import { nextStaleHint } from "../shell/stale-hint";
import { GIT_LOG_LIMIT_KEY, appState, isGitLogLimit } from "../shell/state";
import { activateCommitPreview } from "../shell/url";

const gitLogElementMaybe = document.querySelector<HTMLDivElement>("#git-log");
const gitLogLimitElementMaybe = document.querySelector<HTMLSelectElement>("#git-log-limit");

if (!gitLogElementMaybe || !gitLogLimitElementMaybe) {
  throw new Error("uatu UI failed to initialize (sidebar/git-log)");
}

const gitLogElement: HTMLDivElement = gitLogElementMaybe;
const gitLogLimitElement: HTMLSelectElement = gitLogLimitElementMaybe;

export function initGitLogControls() {
  gitLogLimitElement.value = String(appState.gitLogLimit);
  gitLogLimitElement.addEventListener("change", () => {
    const nextLimit = Number.parseInt(gitLogLimitElement.value, 10);
    appState.gitLogLimit = isGitLogLimit(nextLimit) ? nextLimit : 25;
    persistGitLogLimit();
    renderGitLog();
  });
}

export function renderGitLog() {
  gitLogLimitElement.value = String(appState.gitLogLimit);

  if (appState.repositories.length === 0) {
    gitLogElement.innerHTML = `<div class="pane-empty">No commit log available.</div>`;
    return;
  }

  gitLogElement.innerHTML = appState.repositories.map(repository => {
    if (repository.metadata.status !== "git") {
      return `
        <section class="git-log-group">
          <h3>${escapeHtml(repository.label)}</h3>
          <p class="pane-empty">No git log for this watched root.</p>
        </section>
      `;
    }
    const commits = repository.commitLog.slice(0, appState.gitLogLimit);
    if (commits.length === 0) {
      return `
        <section class="git-log-group">
          <h3>${escapeHtml(repository.label)}</h3>
          <p class="pane-empty">No commits found.</p>
        </section>
      `;
    }
    return `
      <section class="git-log-group">
        <h3>${escapeHtml(repository.label)}</h3>
        <p class="git-log-count">${commits.length} of ${repository.commitLog.length} commits</p>
        <ol class="commit-log">
          ${commits.map(commit => `
            <li>
              <a
                href="${escapeHtmlAttribute(buildCommitPreviewPath(repository.id, commit.sha))}"
                data-repository-id="${escapeHtmlAttribute(repository.id)}"
                data-commit-sha="${escapeHtmlAttribute(commit.sha)}"
                title="Show full commit message"
              >
                <code>${escapeHtml(commit.sha)}</code>
                <span>${escapeHtml(commit.subject)}</span>
                <small>${escapeHtml([commit.author, commit.relativeTime].filter(Boolean).join(" · "))}</small>
              </a>
            </li>
          `).join("")}
        </ol>
      </section>
    `;
  }).join("");
}

export function baseModeLabel(mode: RepositoryReviewSnapshot["reviewLoad"]["base"]["mode"]): string {
  switch (mode) {
    case "configured":
      return "configured base";
    case "remote-default":
      return "remote default";
    case "fallback":
      return "fallback base";
    case "dirty-worktree-only":
      return "dirty worktree only";
    case "unavailable":
      return "base unavailable";
  }
}

export function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function persistGitLogLimit() {
  try {
    window.localStorage.setItem(GIT_LOG_LIMIT_KEY, String(appState.gitLogLimit));
  } catch {
    // Ignore storage failures (private mode, quota, etc.).
  }
}

export function initGitLogClickHandler(): void {
  gitLogElement.addEventListener("click", event => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    const anchor = target.closest<HTMLAnchorElement>("a[data-repository-id][data-commit-sha]");
    if (!anchor) {
      return;
    }

    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      anchor.hasAttribute("download")
    ) {
      return;
    }

    const explicitTarget = anchor.getAttribute("target");
    if (explicitTarget && explicitTarget !== "_self") {
      return;
    }

    let resolved: URL;
    try {
      resolved = new URL(anchor.href);
    } catch {
      return;
    }
    if (resolved.origin !== window.location.origin) {
      return;
    }

    const repositoryId = anchor.dataset.repositoryId;
    const sha = anchor.dataset.commitSha;
    if (!repositoryId || !sha) {
      return;
    }

    event.preventDefault();
    applyStaleHint(nextStaleHint(appState.staleHint, { kind: "manual-navigation" }));
    activateCommitPreview({ repositoryId, sha }, { pushHistory: true });
  });
}
