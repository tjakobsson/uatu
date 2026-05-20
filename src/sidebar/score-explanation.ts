// Build the HTML for the review-burden score-explanation preview. Pure
// function: takes a `reviewLoad` snapshot and returns a string. The
// companion test asserts the output contains no Author/Review mode label —
// a regression guard against accidentally re-introducing the per-Mode
// headline labels removed in the simplify-modes-and-follow change.

import type { RepositoryReviewSnapshot } from "../shared/types";

export function buildScoreExplanationHTML(load: RepositoryReviewSnapshot["reviewLoad"]): string {
  if (load.status !== "available") {
    return "";
  }
  const mechanicalDrivers = load.drivers.filter(driver => driver.kind === "mechanical");
  // Presentation-only sub-driver: surface how many of the change's files are
  // untracked, without altering the numeric score. Score is 0; the row is
  // there as a categorical breakdown of files the mechanical "Changed files"
  // count already includes.
  const untrackedFiles = load.changedFiles
    .filter(file => file.status.startsWith("?"))
    .map(file => file.path);
  if (untrackedFiles.length > 0) {
    mechanicalDrivers.push({
      kind: "mechanical",
      label: "Untracked files",
      score: 0,
      detail: `${untrackedFiles.length} file${untrackedFiles.length === 1 ? "" : "s"} not yet in git`,
      files: untrackedFiles,
    });
  }
  const warningDrivers = load.drivers.filter(driver => driver.kind === "warning");
  const highDelta = load.score - load.thresholds.high;
  const mediumDelta = load.score - load.thresholds.medium;
  const comparison =
    load.score >= load.thresholds.high
      ? `${highDelta} point${Math.abs(highDelta) === 1 ? "" : "s"} above the high threshold`
      : load.score >= load.thresholds.medium
        ? `${mediumDelta} point${Math.abs(mediumDelta) === 1 ? "" : "s"} above the medium threshold`
        : `${load.thresholds.medium - load.score} point${Math.abs(load.thresholds.medium - load.score) === 1 ? "" : "s"} below the medium threshold`;
  return `
    <section class="score-preview is-${escapeHtmlAttribute(load.level)}">
      <header>
        <div class="score-preview-total">
          <p class="score-preview-kicker">${escapeHtml(capitalize(load.level))} review burden</p>
          <h1>${escapeHtml(String(load.score))}</h1>
        </div>
        <dl>
          <div class="is-low"><dt>Low</dt><dd>&lt; ${escapeHtml(String(load.thresholds.medium))}</dd></div>
          <div class="is-medium"><dt>Medium</dt><dd>${escapeHtml(String(load.thresholds.medium))}-${escapeHtml(String(load.thresholds.high - 1))}</dd></div>
          <div class="is-high"><dt>High</dt><dd>&ge; ${escapeHtml(String(load.thresholds.high))}</dd></div>
        </dl>
      </header>
      <p>
        This is an additive review-burden index, not a percentage and not a code-quality score.
        It compares the current change against this repository's thresholds; this score is
        ${escapeHtml(comparison)}.
      </p>
      <h2>Mechanical Statistics</h2>
      ${renderScoreDriverList(mechanicalDrivers, "No mechanical review cost was detected.")}
      <h2>Configuration and Warnings</h2>
      ${renderReviewConfigurationList(warningDrivers, load.configuredAreas)}
    </section>
  `;
}

function renderReviewConfigurationList(
  drivers: RepositoryReviewSnapshot["reviewLoad"]["drivers"],
  areas: RepositoryReviewSnapshot["reviewLoad"]["configuredAreas"],
): string {
  const items = [
    ...drivers.map(renderScoreDriverItem),
    ...areas.map(renderConfiguredAreaItem),
  ];
  if (items.length === 0) {
    return `<p class="pane-empty">No project-specific review scoring configuration or warnings are active for this change.</p>`;
  }

  return `
    <ul class="score-preview-list">
      ${items.join("")}
    </ul>
  `;
}

function renderScoreDriverList(
  drivers: RepositoryReviewSnapshot["reviewLoad"]["drivers"],
  emptyMessage: string,
): string {
  if (drivers.length === 0) {
    return `<p class="pane-empty">${escapeHtml(emptyMessage)}</p>`;
  }
  return `
    <ul class="score-preview-list">
      ${drivers.map(renderScoreDriverItem).join("")}
    </ul>
  `;
}

function renderScoreDriverItem(driver: RepositoryReviewSnapshot["reviewLoad"]["drivers"][number]): string {
  const score = driver.score > 0 ? `+${driver.score}` : String(driver.score);
  const files = driver.files.length > 0
    ? `<small>${escapeHtml(driver.files.slice(0, 8).join(", "))}${driver.files.length > 8 ? "..." : ""}</small>`
    : "";
  const help = mechanicalDriverHelp(driver.label);
  const helpMarkup = help
    ? `
      <span class="score-term-help" tabindex="0" aria-label="${escapeHtmlAttribute(`${driver.label}: ${help}`)}">
        ?
        <span class="score-term-tooltip" role="tooltip">${escapeHtml(help)}</span>
      </span>
    `
    : "";
  return `
    <li class="is-${escapeHtmlAttribute(driver.kind)}">
      <span>
        <span class="score-driver-label"><strong>${escapeHtml(driver.label)}</strong>${helpMarkup}</span>
        ${escapeHtml(driver.detail)}
        ${files}
      </span>
      <code>${escapeHtml(score)}</code>
    </li>
  `;
}

function renderConfiguredAreaItem(area: RepositoryReviewSnapshot["reviewLoad"]["configuredAreas"][number]): string {
  const score = area.score > 0 ? `+${area.score}` : String(area.score);
  const matchedCount = area.matchedFiles.length;
  const detail = matchedCount > 0
    ? `${capitalize(area.kind)} area matched ${matchedCount} file${matchedCount === 1 ? "" : "s"}`
    : `${capitalize(area.kind)} area configured; no files matched this change`;
  const extra = matchedCount > 0
    ? area.matchedFiles.slice(0, 8).join(", ") + (area.matchedFiles.length > 8 ? "..." : "")
    : `Patterns: ${area.paths.join(", ")}`;

  return `
    <li class="is-${escapeHtmlAttribute(area.kind)}">
      <span>
        <span class="score-driver-label"><strong>${escapeHtml(area.label)}</strong></span>
        ${escapeHtml(detail)}
        <small>${escapeHtml(extra)}</small>
      </span>
      <code>${escapeHtml(score)}</code>
    </li>
  `;
}

function mechanicalDriverHelp(label: string): string | null {
  switch (label) {
    case "Changed files":
      return "How many files changed and may need review.";
    case "Touched lines":
      return "How many lines were added or removed across those files.";
    case "Diff hunks":
      return "How many separate changed spots there are. One file can have several spots if edits are spread out.";
    case "Directory spread":
      return "How many top-level parts of the project are touched, such as src, tests, or docs.";
    case "Renames":
      return "Files that moved or changed name, which can take extra attention to follow.";
    case "Dependency/config files":
      return "Changes to setup, build, dependency, or CI files that can affect the project broadly.";
    case "Untracked files":
      return "Files in the workspace that are not yet tracked by git. They contribute to the change-shape inputs but are not in any commit or staged for one.";
    default:
      return null;
  }
}

// Tiny HTML utilities. Duplicated locally rather than reaching into app.ts
// so this module stays self-contained and the test can import it without
// pulling in the DOM-coupled app shell. A future "shared/html.ts" move
// will deduplicate these across the few places they appear.

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeHtmlAttribute(value: string): string {
  return escapeHtml(value);
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
