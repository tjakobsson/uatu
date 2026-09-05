import { captureTerminalToken, waitForWorkspaceCredential } from "./terminal/client";
import { initHubNav } from "./shell/hub-nav";
import { injectPwaLinks, unregisterLegacyServiceWorkers } from "./shell/pwa";
import { attachPopstateHandler } from "./shell/history";
import { loadInitialState } from "./shell/boot";
import { installAnchorHandlers } from "./preview/anchors";
import { installMermaidTriggerHandler } from "./preview/mermaid";
import { initViewModeControls, scheduleDiffPrewarmWhenIdle } from "./preview/view-mode";
import { initOutline } from "./preview/outline";
import { attachAutoStackObserver } from "./preview/layout";
import { initSidebarCollapse, initSidebarWidth } from "./sidebar/shell";
import { initSidebarPanes } from "./sidebar/panes";
import { initPreviewTextSize } from "./preview/text-size";
import { initGitLogClickHandler, initGitLogControls } from "./sidebar/git-log";
import { initChangeOverviewClickHandler } from "./sidebar/change-overview";
import { initFilesPaneFilterControls } from "./sidebar/files-filter";
import { initFollowToggle } from "./shell/follow";
import { initActiveSurfaceTracking } from "./find/active-surface";
import { initFindBar } from "./find/find-bar";
import { initFindShortcuts, registerProjectSearch } from "./find/shortcut";
import { initSearchPane, openSearchPane } from "./sidebar/search-pane";
import { initUiMode } from "./shell/ui-mode";
import { initTabBar } from "./shell/tab-bar";
import { initChatPanel } from "./chat/surface";
import { initChat } from "./chat/ui";

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
const viewControlElement = document.querySelector<HTMLDivElement>("#view-control");
const viewRenderedButton = document.querySelector<HTMLButtonElement>("#view-rendered");
const viewSourceButton = document.querySelector<HTMLButtonElement>("#view-source");
const viewDiffButton = document.querySelector<HTMLButtonElement>("#view-diff");
const previewShellElement = document.querySelector<HTMLElement>(".preview-shell");
const documentCountElement = document.querySelector<HTMLElement>("#document-count");
const filesPaneFilterElement = document.querySelector<HTMLDivElement>("#files-pane-filter");
const filesPaneFilterAllButton = document.querySelector<HTMLButtonElement>("#files-pane-filter-all");
const filesPaneFilterChangedButton = document.querySelector<HTMLButtonElement>("#files-pane-filter-changed");
const connectionStateElement = document.querySelector<HTMLElement>("#connection-state");
const connectionLabelElement = connectionStateElement?.querySelector<HTMLElement>(".connection-label") ?? null;
const buildBadgeElement = document.querySelector<HTMLElement>("#build-badge");
const sidebarCollapseElement = document.querySelector<HTMLButtonElement>("#sidebar-collapse");
const sidebarExpandElement = document.querySelector<HTMLButtonElement>("#sidebar-expand");

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
  !viewControlElement ||
  !viewRenderedButton ||
  !viewSourceButton ||
  !viewDiffButton ||
  !previewShellElement ||
  !documentCountElement ||
  !filesPaneFilterElement ||
  !filesPaneFilterAllButton ||
  !filesPaneFilterChangedButton ||
  !connectionStateElement ||
  !connectionLabelElement ||
  !buildBadgeElement ||
  !sidebarCollapseElement ||
  !sidebarExpandElement
) {
  throw new Error("uatu UI failed to initialize");
}

// Mode + tab chrome first: everything layout-related keys on the
// data-ui-mode / data-active-tab attributes these two stamp on <html>.
initUiMode();
initTabBar();
initChatPanel();

initActiveSurfaceTracking();
initFindBar();
initSearchPane();
registerProjectSearch(openSearchPane);
initFindShortcuts();
initSidebarCollapse();
initSidebarPanes();
initPreviewTextSize();
initHubNav();
initSidebarWidth();
initGitLogControls();
initGitLogClickHandler();
initChangeOverviewClickHandler();
initFilesPaneFilterControls();
initFollowToggle();
installAnchorHandlers();
installMermaidTriggerHandler();
initViewModeControls();
initOutline();
attachAutoStackObserver();

// Pull the URL token into sessionStorage and strip it from `location.search`
// before anything else reads the URL. Pathname/hash are preserved.
captureTerminalToken();

injectPwaLinks();
// Nothing waits on this: it is housekeeping for profiles that predate 0.5.0,
// and it is removed once 0.7.0 ships.
unregisterLegacyServiceWorkers();
attachPopstateHandler();

void loadInitialState(() => {
  void waitForWorkspaceCredential().then(() => initChat());
}).then(() => {
  // Prewarm the diff renderer at idle once we know whether this is a
  // git-backed session — off the critical path, so the first Diff open
  // skips the library + highlighter stall.
  scheduleDiffPrewarmWhenIdle();
});
