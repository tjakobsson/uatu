import { captureTerminalToken } from "./terminal/client";
import { injectPwaLinks, registerServiceWorker } from "./shell/pwa";
import { attachPopstateHandler } from "./shell/history";
import { loadInitialState } from "./shell/boot";
import { installAnchorHandlers } from "./preview/anchors";
import { installMermaidTriggerHandler } from "./preview/mermaid";
import { initViewModeControls } from "./preview/view-mode";
import { attachAutoStackObserver } from "./preview/layout";
import { initSidebarCollapse, initSidebarWidth } from "./sidebar/shell";
import { initSidebarPanes } from "./sidebar/panes";
import { initGitLogClickHandler, initGitLogControls } from "./sidebar/git-log";
import { initChangeOverviewClickHandler } from "./sidebar/change-overview";
import { initFilesPaneFilterControls } from "./sidebar/files-filter";
import { initSelectionInspectorControl } from "./sidebar/selection-inspector-mount";
import { initModeControls } from "./shell/mode";
import { initFollowToggle } from "./shell/follow";
import { initStaleHintActionHandler } from "./shell/stale-hint-mount";
import { selectionInspector } from "./shell/inspector-instance";

const appShellElement = document.querySelector<HTMLDivElement>(".app-shell");
const previewBaseElement = document.querySelector<HTMLBaseElement>("#preview-base");
const treeElement = document.querySelector<HTMLDivElement>("#tree");
const treeEmptyMessageElement = document.querySelector<HTMLElement>("#tree-empty-message");
const changeOverviewElement = document.querySelector<HTMLDivElement>("#change-overview");
const gitLogElement = document.querySelector<HTMLDivElement>("#git-log");
const gitLogLimitElement = document.querySelector<HTMLSelectElement>("#git-log-limit");
const panelsToggleElement = document.querySelector<HTMLButtonElement>("#panels-toggle");
const panelsMenuElement = document.querySelector<HTMLDivElement>("#panels-menu");
const sidebarResizerElement = document.querySelector<HTMLDivElement>("#sidebar-resizer");
const previewElement = document.querySelector<HTMLElement>("#preview");
const previewTitleElement = document.querySelector<HTMLElement>("#preview-title");
const previewPathElement = document.querySelector<HTMLElement>("#preview-path");
const previewTypeElement = document.querySelector<HTMLElement>("#preview-type");
const followToggleElement = document.querySelector<HTMLButtonElement>("#follow-toggle");
const modeControlElement = document.querySelector<HTMLDivElement>("#mode-control");
const modeAuthorButton = document.querySelector<HTMLButtonElement>("#mode-author");
const modeReviewButton = document.querySelector<HTMLButtonElement>("#mode-review");
const viewControlElement = document.querySelector<HTMLDivElement>("#view-control");
const viewRenderedButton = document.querySelector<HTMLButtonElement>("#view-rendered");
const viewSourceButton = document.querySelector<HTMLButtonElement>("#view-source");
const viewDiffButton = document.querySelector<HTMLButtonElement>("#view-diff");
const previewShellElement = document.querySelector<HTMLElement>(".preview-shell");
const staleHintElement = document.querySelector<HTMLDivElement>("#stale-hint");
const staleHintMessageElement = document.querySelector<HTMLElement>("#stale-hint-message");
const staleHintActionElement = document.querySelector<HTMLButtonElement>("#stale-hint-action");
const documentCountElement = document.querySelector<HTMLElement>("#document-count");
const filesPaneFilterElement = document.querySelector<HTMLDivElement>("#files-pane-filter");
const filesPaneFilterAllButton = document.querySelector<HTMLButtonElement>("#files-pane-filter-all");
const filesPaneFilterChangedButton = document.querySelector<HTMLButtonElement>("#files-pane-filter-changed");
const connectionStateElement = document.querySelector<HTMLElement>("#connection-state");
const connectionLabelElement = connectionStateElement?.querySelector<HTMLElement>(".connection-label") ?? null;
const buildBadgeElement = document.querySelector<HTMLElement>("#build-badge");
const sidebarCollapseElement = document.querySelector<HTMLButtonElement>("#sidebar-collapse");
const sidebarExpandElement = document.querySelector<HTMLButtonElement>("#sidebar-expand");
const selectionInspectorEmptyElement = document.querySelector<HTMLElement>(
  "[data-selection-inspector-empty]",
);
const selectionInspectorControlElement = document.querySelector<HTMLButtonElement>(
  "[data-selection-inspector-control]",
);
const selectionInspectorStatusElement = document.querySelector<HTMLElement>(
  "[data-selection-inspector-status]",
);

if (
  !appShellElement ||
  !previewBaseElement ||
  !treeElement ||
  !treeEmptyMessageElement ||
  !changeOverviewElement ||
  !gitLogElement ||
  !gitLogLimitElement ||
  !panelsToggleElement ||
  !panelsMenuElement ||
  !sidebarResizerElement ||
  !previewElement ||
  !previewTitleElement ||
  !previewPathElement ||
  !previewTypeElement ||
  !followToggleElement ||
  !modeControlElement ||
  !modeAuthorButton ||
  !modeReviewButton ||
  !viewControlElement ||
  !viewRenderedButton ||
  !viewSourceButton ||
  !viewDiffButton ||
  !previewShellElement ||
  !staleHintElement ||
  !staleHintMessageElement ||
  !staleHintActionElement ||
  !documentCountElement ||
  !filesPaneFilterElement ||
  !filesPaneFilterAllButton ||
  !filesPaneFilterChangedButton ||
  !connectionStateElement ||
  !connectionLabelElement ||
  !buildBadgeElement ||
  !sidebarCollapseElement ||
  !sidebarExpandElement ||
  !selectionInspectorEmptyElement ||
  !selectionInspectorControlElement ||
  !selectionInspectorStatusElement
) {
  throw new Error("uatu UI failed to initialize");
}

initSidebarCollapse();
initSidebarPanes();
initSidebarWidth();
initGitLogControls();
initGitLogClickHandler();
initChangeOverviewClickHandler();
initFilesPaneFilterControls();
initModeControls();
initFollowToggle();
initStaleHintActionHandler();
installAnchorHandlers();
installMermaidTriggerHandler();
initViewModeControls();
attachAutoStackObserver();

initSelectionInspectorControl(selectionInspector);

// Pull the URL token into sessionStorage and strip it from `location.search`
// before anything else reads the URL. Pathname/hash are preserved.
captureTerminalToken();

injectPwaLinks();
registerServiceWorker();
attachPopstateHandler();

void loadInitialState();
